/**
 * Deploys Cr3dXDeals, and with it Cr3dXCredit, to Creditcoin3 Testnet.
 *
 *   npm run deploy:deals
 *
 * One transaction deploys both. The registry constructs the credit layer from
 * its own constructor, so the credit layer's `deals` address is fixed at
 * construction and there is no initialiser for anyone to call. That is what
 * makes "no role, including the deployer, can change a status, a proof, an
 * outcome or a reserve" true rather than merely intended.
 *
 * Two parameters are baked in permanently and both are checked here:
 *
 *   CR3DX_BASE_LIMIT                 credit line at the base score, in native
 *                                    token units (default 5,000 USDC)
 *   CR3DX_ATTESTATION_GRACE_PERIOD   source blocks of slack before a default
 *                                    (default 600, derived from MaxCatchup)
 */
import { Contract, ContractFactory, formatEther, formatUnits, getCreateAddress } from 'ethers';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { loadArtifact, readDeployment, writeDeployment } from './lib/artifacts.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { signerFromEnv } from './lib/wallet.js';

const log = (msg: string): void => console.log(`[deploy] ${msg}`);

/**
 * 5,000 USDC at six decimals. Native token units, because the contracts never
 * read `decimals` from the asset and never convert: `decimals` is not a required
 * part of ERC-20, and a credit limit whose arithmetic depends on an external
 * call has made reading somebody else's contract part of the credit logic.
 */
const DEFAULT_BASE_LIMIT = 5_000_000_000n;

/**
 * 600 source blocks. Sized against `MaxCatchup` (500) rather than against the
 * lag observed on a quiet day, because the attested height can advance by that
 * much in one Creditcoin block when the attestor set catches up: 500 + 41 + 10 +
 * 25, rounded up. Measurements in docs/ATTESTCOIN_INTEGRATION.md.
 */
const DEFAULT_GRACE_PERIOD = 600n;

const VERIFIER_ABI = ['function chainKey() view returns (uint64)', 'function gateway() view returns (address)'];
const DEALS_ABI = [
  'function credit() view returns (address)',
  'function verifier() view returns (address)',
  'function chainKey() view returns (uint64)',
  'function attestationGracePeriod() view returns (uint64)',
];
const CREDIT_ABI = [
  'function deals() view returns (address)',
  'function baseLimit() view returns (uint256)',
  'function chainKey() view returns (uint64)',
];

function bigintFromEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = BigInt(raw.trim());
  if (value <= 0n) throw new Error(`${name} must be positive, got ${raw}`);
  return value;
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const cc = evmProvider(config.creditcoinRpcUrl);
  const net = await cc.getNetwork();
  if (Number(net.chainId) !== config.creditcoinChainId) {
    throw new Error(`CREDITCOIN_RPC_URL points at chain ${net.chainId}, expected ${config.creditcoinChainId}`);
  }

  const existing = readDeployment('creditcoin');
  if (!existing?.verifier) {
    throw new Error('No verifier in deployments/creditcoin.json. Run `npm run deploy:creditcoin` first.');
  }
  const verifierAddress = existing.verifier as string;
  if ((await cc.getCode(verifierAddress)) === '0x') {
    throw new Error(`The recorded verifier ${verifierAddress} has no code on chain ${net.chainId}`);
  }

  // Read from the deployed verifier rather than from the record, so a stale
  // deployments file cannot pair the registry with the wrong source chain.
  const verifier = new Contract(verifierAddress, VERIFIER_ABI, cc);
  const chainKey = Number(await verifier.getFunction('chainKey')());
  const gateway = (await verifier.getFunction('gateway')()) as string;
  log(`verifier ${verifierAddress}, chainKey ${chainKey}, trusts gateway ${gateway}`);
  if (existing.chainKey !== undefined && Number(existing.chainKey) !== chainKey) {
    throw new Error(`Verifier reports chainKey ${chainKey}, the deployment record says ${existing.chainKey}`);
  }

  const baseLimit = bigintFromEnv('CR3DX_BASE_LIMIT', DEFAULT_BASE_LIMIT);
  const gracePeriod = bigintFromEnv('CR3DX_ATTESTATION_GRACE_PERIOD', DEFAULT_GRACE_PERIOD);
  log(`base limit ${baseLimit} native units (${formatUnits(baseLimit, config.expectedTokenDecimals)} at ${config.expectedTokenDecimals} decimals)`);
  log(`attestation grace period ${gracePeriod} source blocks`);

  const signer = signerFromEnv(cc);
  const balance = await cc.getBalance(signer.address);
  log(`deployer ${signer.address}, balance ${formatEther(balance)} CTC`);
  if (balance === 0n) throw new Error('The deployer has no Creditcoin testnet CTC. Fund it before deploying.');

  const reason = process.env.REDEPLOY_REASON?.trim();
  if (existing.deals && !reason) {
    log(`deployments/creditcoin.json already records a registry at ${existing.deals}.`);
    log('A new registry starts with no deals, no reserves and no credit history, so redeploying is never a no-op.');
    log('To redeploy anyway, set REDEPLOY_REASON to why. The old record is kept, not overwritten.');
    return;
  }

  // The same guard the verifier deployment carries. A contract address is a
  // function of the deployer and its nonce, so the same account deploying its
  // first contract on two chains lands on the same address twice. Identical
  // addresses make a misconfigured deployment look exactly like a correct one.
  const nonce = await cc.getTransactionCount(signer.address);
  const predicted = getCreateAddress({from: signer.address, nonce});
  log(`deployer nonce ${nonce}, this deployment will land at ${predicted}`);
  const collisions: Record<string, string> = {
    'the Sepolia gateway': gateway,
    'the verifier': verifierAddress,
  };
  for (const [what, address] of Object.entries(collisions)) {
    if (predicted.toLowerCase() === address.toLowerCase()) {
      throw new Error(
        `This deployment would land at ${predicted}, the same address as ${what}. ` +
          'Send any transaction from the deployer to advance its nonce, then run again.',
      );
    }
  }

  const artifact = loadArtifact('Cr3dXDeals.sol', 'Cr3dXDeals');
  const factory = new ContractFactory(artifact.abi as any, artifact.bytecode, signer);
  const deployed = await factory.deploy(verifierAddress, gracePeriod, baseLimit);
  const tx = deployed.deploymentTransaction();
  log(`sent ${tx?.hash}, waiting for inclusion`);
  await deployed.waitForDeployment();
  const dealsAddress = await deployed.getAddress();
  const receipt = await tx!.wait();

  // Everything the constructor baked in, read back off the chain. A registry
  // pointed at the wrong verifier or the wrong source chain is wrong forever.
  const deals = new Contract(dealsAddress, DEALS_ABI, cc);
  const creditAddress = (await deals.getFunction('credit')()) as string;
  const onChainVerifier = (await deals.getFunction('verifier')()) as string;
  const onChainKey = Number(await deals.getFunction('chainKey')());
  const onChainGrace = BigInt(await deals.getFunction('attestationGracePeriod')());

  const credit = new Contract(creditAddress, CREDIT_ABI, cc);
  const creditOwner = (await credit.getFunction('deals')()) as string;
  const creditBaseLimit = BigInt(await credit.getFunction('baseLimit')());
  const creditChainKey = Number(await credit.getFunction('chainKey')());

  const problems: string[] = [];
  if (onChainVerifier.toLowerCase() !== verifierAddress.toLowerCase()) {
    problems.push(`registry trusts verifier ${onChainVerifier}, expected ${verifierAddress}`);
  }
  if (onChainKey !== chainKey) problems.push(`registry uses chainKey ${onChainKey}, expected ${chainKey}`);
  if (onChainGrace !== gracePeriod) problems.push(`registry grace period ${onChainGrace}, expected ${gracePeriod}`);
  if (creditOwner.toLowerCase() !== dealsAddress.toLowerCase()) {
    problems.push(`credit layer answers to ${creditOwner}, not to the registry ${dealsAddress}`);
  }
  if (creditBaseLimit !== baseLimit) problems.push(`credit base limit ${creditBaseLimit}, expected ${baseLimit}`);
  if (creditChainKey !== chainKey) problems.push(`credit layer uses chainKey ${creditChainKey}, expected ${chainKey}`);
  if ((await cc.getCode(creditAddress)) === '0x') problems.push(`no code at the credit layer ${creditAddress}`);
  if (problems.length) throw new Error(`Deployed contracts do not match what was asked for: ${problems.join('; ')}`);

  const superseded = existing.deals
    ? [
        ...((existing.previousDeals as unknown[]) ?? []),
        {
          deals: existing.deals,
          credit: existing.credit,
          dealsDeploymentTx: existing.dealsDeploymentTx,
          dealsDeploymentBlock: existing.dealsDeploymentBlock,
          supersededAt: new Date().toISOString(),
          reason,
        },
      ]
    : ((existing.previousDeals as unknown[]) ?? []);

  writeDeployment('creditcoin', {
    previousDeals: superseded,
    deals: dealsAddress,
    credit: creditAddress,
    dealsDeploymentTx: tx?.hash,
    dealsDeploymentBlock: receipt?.blockNumber,
    baseLimit: baseLimit.toString(),
    attestationGracePeriod: Number(gracePeriod),
  });

  log(`registry deployed at ${dealsAddress} in block ${receipt?.blockNumber}, gas used ${receipt?.gasUsed}`);
  log(`credit layer deployed at ${creditAddress} by the registry itself`);
  log('recorded in deployments/creditcoin.json');
}

main().catch((error) => {
  console.error(`[deploy] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
