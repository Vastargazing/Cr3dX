/**
 * Deploys Cr3dXVerifier to Creditcoin3 Testnet.
 *
 *   npm run deploy:creditcoin
 *
 * Takes the source chain key from the live ChainInfo registry rather than a
 * constant, and the gateway address from deployments/sepolia.json. Both are
 * baked in permanently, so both are checked before the transaction is sent.
 */
import { ContractFactory, formatEther, getCreateAddress } from 'ethers';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { ChainInfoReader } from './lib/precompiles.js';
import { loadArtifact, readDeployment, writeDeployment } from './lib/artifacts.js';
import { signerFromEnv } from './lib/wallet.js';

const log = (msg: string): void => console.log(`[deploy] ${msg}`);

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const cc = evmProvider(config.creditcoinRpcUrl);
  const net = await cc.getNetwork();
  if (Number(net.chainId) !== config.creditcoinChainId) {
    throw new Error(`CREDITCOIN_RPC_URL points at chain ${net.chainId}, expected ${config.creditcoinChainId}`);
  }

  const sepolia = readDeployment('sepolia');
  if (!sepolia?.gateway) {
    throw new Error('No gateway in deployments/sepolia.json. Deploy the Sepolia side first.');
  }
  const gateway = sepolia.gateway as string;

  // The chain key is registry state, not a constant, and the verifier is wrong
  // forever if it is baked in wrong.
  const chains = await new ChainInfoReader(cc).getSupportedChains();
  const source = chains.find((c) => c.chainId === config.sourceEvmChainId);
  if (!source) {
    throw new Error(`Source chain ${config.sourceEvmChainId} is not registered on Creditcoin. Refusing to deploy.`);
  }
  log(`source chain ${config.sourceEvmChainId} is chainKey ${source.chainKey} ("${source.chainName}")`);
  log(`gateway to trust: ${gateway}`);

  const signer = signerFromEnv(cc);
  const balance = await cc.getBalance(signer.address);
  log(`deployer ${signer.address}, balance ${formatEther(balance)} CTC`);
  if (balance === 0n) throw new Error('The deployer has no Creditcoin testnet CTC. Fund it before deploying.');

  const existing = readDeployment('creditcoin');
  const reason = process.env.REDEPLOY_REASON?.trim();
  if (existing?.verifier && !reason) {
    log(`deployments/creditcoin.json already records a verifier at ${existing.verifier}.`);
    log('A new verifier starts with no recorded facts, so redeploying is never a no-op.');
    log('To redeploy anyway, set REDEPLOY_REASON to why. The old record is kept, not overwritten.');
    return;
  }

  // A contract address is derived from the deployer and its nonce, so the same
  // account deploying its first contract on two chains produces the same address
  // on both. That is legal and confusing: a verifier misconfigured with the
  // gateway's address, or a script reading the wrong deployment file, would look
  // exactly like a correct setup. Refuse the collision instead of documenting it.
  const nonce = await cc.getTransactionCount(signer.address);
  const predicted = getCreateAddress({from: signer.address, nonce});
  log(`deployer nonce ${nonce}, this deployment will land at ${predicted}`);
  if (predicted.toLowerCase() === gateway.toLowerCase()) {
    throw new Error(
      `This deployment would land at ${predicted}, the same address as the Sepolia gateway. ` +
        'Send any transaction from the deployer to advance its nonce, then run again.',
    );
  }

  const artifact = loadArtifact('Cr3dXVerifier.sol', 'Cr3dXVerifier');
  const factory = new ContractFactory(artifact.abi as any, artifact.bytecode, signer);
  const verifier = await factory.deploy(source.chainKey, gateway);
  const tx = verifier.deploymentTransaction();
  log(`sent ${tx?.hash}, waiting for inclusion`);
  await verifier.waitForDeployment();
  const address = await verifier.getAddress();
  const receipt = await tx!.wait();

  const onChainGateway = (await (verifier as any).gateway()) as string;
  const onChainKey = Number(await (verifier as any).chainKey());
  if (onChainGateway.toLowerCase() !== gateway.toLowerCase() || onChainKey !== source.chainKey) {
    throw new Error(`Deployed verifier reports gateway ${onChainGateway} and chainKey ${onChainKey}; expected ${gateway} and ${source.chainKey}`);
  }

  if (address.toLowerCase() === gateway.toLowerCase()) {
    throw new Error(`Verifier landed at ${address}, the same address as the Sepolia gateway. Refusing to record it.`);
  }

  // The superseded deployment stays in the record. Its facts are still on chain,
  // and hiding why it was replaced would make the history of this repository
  // less honest than the history of the chain it talks to.
  const superseded = existing?.verifier
    ? [
        ...((existing.previousVerifiers as unknown[]) ?? []),
        {
          verifier: existing.verifier,
          verifierDeploymentTx: existing.verifierDeploymentTx,
          verifierDeploymentBlock: existing.verifierDeploymentBlock,
          supersededAt: new Date().toISOString(),
          reason,
        },
      ]
    : ((existing?.previousVerifiers as unknown[]) ?? []);

  writeDeployment('creditcoin', {
    network: 'creditcoin3-testnet',
    previousVerifiers: superseded,
    chainId: config.creditcoinChainId,
    chainKey: source.chainKey,
    sourceChainId: config.sourceEvmChainId,
    sourceGateway: gateway,
    verifier: address,
    verifierDeploymentTx: tx?.hash,
    verifierDeploymentBlock: receipt?.blockNumber,
    deployedBy: signer.address,
  });

  log(`verifier deployed at ${address} in block ${receipt?.blockNumber}`);
  log('recorded in deployments/creditcoin.json');
}

main().catch((error) => {
  console.error(`[deploy] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
