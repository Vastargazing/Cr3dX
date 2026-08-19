/**
 * Deploys Cr3dXVerifier to Creditcoin3 Testnet.
 *
 *   npm run deploy:verifier
 *
 * Takes the source chain key from the live ChainInfo registry rather than a
 * constant, and the gateway address from deployments/sepolia.json. Both are
 * baked in permanently, so both are checked before the transaction is sent.
 */
import { ContractFactory, formatEther } from 'ethers';
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
  if (existing?.verifier) {
    log(`deployments/creditcoin.json already records a verifier at ${existing.verifier}.`);
    log('Delete that entry to deploy a fresh one. A new verifier starts with no recorded facts.');
    return;
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

  writeDeployment('creditcoin', {
    network: 'creditcoin3-testnet',
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
