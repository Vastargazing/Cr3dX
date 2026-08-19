/** Read-only readiness gate for the complete two-wallet live testnet run. */
import { Contract, formatEther, formatUnits, getAddress } from 'ethers';
import { existsSync } from 'node:fs';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { readDeployment } from './lib/artifacts.js';
import {
  DEAL_RUN_USDC_B,
  diagnose,
  MIN_CREDITCOIN_CTC_A,
  MIN_CREDITCOIN_CTC_B,
  MIN_SEPOLIA_ETH_A,
  MIN_SEPOLIA_ETH_B,
  renderProjection,
  validateLiveUsdcPlan,
  type UsdcState,
} from './lib/live-plan.js';
import { ChainInfoReader } from './lib/precompiles.js';
import { ProofBuilderClient } from './lib/proofs.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { liveWallets } from './lib/wallet.js';

const log = (message: string): void => console.log(`[preflight] ${message}`);
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];
const GATEWAY_ABI = ['function token() view returns (address)'];
const VERIFIER_ABI = ['function chainKey() view returns (uint64)', 'function gateway() view returns (address)'];
const DEALS_ABI = [
  'function verifier() view returns (address)',
  'function credit() view returns (address)',
  'function chainKey() view returns (uint64)',
  'function attestationGracePeriod() view returns (uint64)',
];
const CREDIT_ABI = ['function deals() view returns (address)', 'function baseLimit() view returns (uint256)'];

interface CheckState {
  failures: string[];
  funding: string[];
}

function requireAtLeast(
  state: CheckState,
  role: string,
  asset: string,
  held: bigint,
  required: bigint,
  format: (value: bigint) => string,
): void {
  const status = held >= required ? 'OK' : 'NEEDS FUNDS';
  log(`${status} ${role} ${asset}: ${format(held)} held, ${format(required)} required`);
  if (held < required) state.funding.push(`${role}: send at least ${format(required - held)} more ${asset}`);
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const state: CheckState = { failures: [], funding: [] };
  const sepolia = evmProvider(config.sepoliaRpcUrl);
  const creditcoin = evmProvider(config.creditcoinRpcUrl);
  const sepoliaWallets = liveWallets(sepolia);
  const creditcoinWallets = liveWallets(creditcoin);

  log(`A (deployer/investor): ${sepoliaWallets.deployer.address}`);
  log(`B (borrower/payer):    ${sepoliaWallets.borrower.address}`);
  log('private keys: loaded from ignored .env; never printed');

  const [sepoliaNetwork, creditcoinNetwork] = await Promise.all([sepolia.getNetwork(), creditcoin.getNetwork()]);
  if (Number(sepoliaNetwork.chainId) !== config.sourceEvmChainId) {
    state.failures.push(`Sepolia RPC reports chain ${sepoliaNetwork.chainId}, expected ${config.sourceEvmChainId}`);
  } else log(`OK Sepolia RPC: chain ${sepoliaNetwork.chainId}`);
  if (Number(creditcoinNetwork.chainId) !== config.creditcoinChainId) {
    state.failures.push(`Creditcoin RPC reports chain ${creditcoinNetwork.chainId}, expected ${config.creditcoinChainId}`);
  } else log(`OK Creditcoin RPC: chain ${creditcoinNetwork.chainId}`);

  const tokenAddress = getAddress(config.sepoliaUsdc);
  if ((await sepolia.getCode(tokenAddress)) === '0x') {
    throw new Error(`No token contract at configured SEPOLIA_USDC ${tokenAddress}`);
  }
  const token = new Contract(tokenAddress, ERC20_ABI, sepolia);
  const [symbol, decimalsRaw] = (await Promise.all([
    token.getFunction('symbol')(),
    token.getFunction('decimals')(),
  ])) as [string, bigint];
  const decimals = Number(decimalsRaw);
  if (symbol !== config.expectedTokenSymbol || decimals !== config.expectedTokenDecimals) {
    state.failures.push(
      `Configured token reports ${symbol}/${decimals} decimals; expected ${config.expectedTokenSymbol}/${config.expectedTokenDecimals}`,
    );
  } else log(`OK Circle test USDC: ${tokenAddress}, ${decimals} decimals`);

  // Self-check of the amounts themselves, independent of any chain state: the
  // documented minimum funding must carry the whole ordered run.
  validateLiveUsdcPlan();
  log('OK live USDC plan is internally consistent at the documented minimum funding');

  const chains = await new ChainInfoReader(creditcoin).getSupportedChains();
  const source = chains.find((chain) => chain.chainId === config.sourceEvmChainId);
  if (!source) {
    state.failures.push(`Sepolia chain ${config.sourceEvmChainId} is absent from Creditcoin's registry`);
  } else {
    log(`OK Creditcoin source registry: Sepolia is chainKey ${source.chainKey}`);
    const proverHeight = await new ProofBuilderClient(config.proofBuilderUrl, source.chainKey).attestedHeight();
    log(`OK proof builder: attested Sepolia height ${proverHeight}`);
  }

  // The helper is only deployed during a capture run. Before that it holds
  // nothing by definition; after a successful run it holds nothing either,
  // because it forwards everything within one transaction. A non-zero balance
  // here means a run stopped somewhere it should not have.
  const helperAddress = readDeployment('sepolia')?.doubleFundingFixture as string | undefined;

  const [ethA, ethB, ctcA, ctcB, usdcA, usdcB, usdcHelper] = (await Promise.all([
    sepolia.getBalance(sepoliaWallets.deployer.address),
    sepolia.getBalance(sepoliaWallets.borrower.address),
    creditcoin.getBalance(creditcoinWallets.deployer.address),
    creditcoin.getBalance(creditcoinWallets.borrower.address),
    token.getFunction('balanceOf')(sepoliaWallets.deployer.address),
    token.getFunction('balanceOf')(sepoliaWallets.borrower.address),
    helperAddress ? token.getFunction('balanceOf')(getAddress(helperAddress)) : Promise.resolve(0n),
  ])) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  const actual: UsdcState = {a: usdcA, b: usdcB, helper: usdcHelper};
  reportUsdcChain(state, actual, decimals, helperAddress);

  log('gas funding targets (full ordered run, including safety budget):');
  requireAtLeast(state, 'A', 'Sepolia ETH', ethA, MIN_SEPOLIA_ETH_A, formatEther);
  requireAtLeast(state, 'A', 'test CTC', ctcA, MIN_CREDITCOIN_CTC_A, formatEther);
  requireAtLeast(state, 'B', 'Sepolia ETH', ethB, MIN_SEPOLIA_ETH_B, formatEther);
  reportBorrowerCtc(state, ctcA, ctcB);
  log(
    `note: \`deal:live\` spends ${formatUnits(DEAL_RUN_USDC_B, decimals)} USDC of B's own on top of the capture run: ` +
      'B pays the face value and receives the funding, so only the margin between them is new money',
  );

  for (const artifact of [
    'out/Cr3dXGateway.sol/Cr3dXGateway.json',
    'out/Cr3dXVerifier.sol/Cr3dXVerifier.json',
    'out/Cr3dXDeals.sol/Cr3dXDeals.json',
    'out/Cr3dXCredit.sol/Cr3dXCredit.json',
    'out/DoubleFundingFixture.sol/DoubleFundingFixture.json',
  ]) {
    if (existsSync(artifact)) log(`OK build artifact: ${artifact}`);
    else state.failures.push(`Missing ${artifact}; run \`npm run build\``);
  }

  await checkDeployments(state, sepolia, creditcoin, tokenAddress, source?.chainKey);

  if (state.failures.length > 0) {
    log('configuration blockers:');
    for (const failure of state.failures) log(`  - ${failure}`);
  }
  if (state.funding.length > 0) {
    log('faucet actions:');
    for (const action of state.funding) log(`  - ${action}`);
  }
  if (state.failures.length || state.funding.length) {
    throw new Error(`${state.failures.length} configuration blocker(s), ${state.funding.length} funding action(s)`);
  }
  log(
    'READY: npm run deploy:sepolia && npm run capture:gate && npm run deploy:creditcoin && ' +
      'npm run verify:live && npm run deploy:deals && npm run deal:live',
  );
}

/**
 * Wallet B needs Creditcoin gas now that it is the account that creates deals.
 *
 * This is not a faucet action when A can cover it, because `deal:live` tops B up
 * itself. Reporting it as one would send the operator looking for a faucet that
 * dispenses to an address they could have funded from their other wallet in one
 * transaction. It becomes a blocker only when neither wallet has the gas.
 */
function reportBorrowerCtc(state: CheckState, ctcA: bigint, ctcB: bigint): void {
  if (ctcB >= MIN_CREDITCOIN_CTC_B) {
    log(`OK B test CTC: ${formatEther(ctcB)} held, ${formatEther(MIN_CREDITCOIN_CTC_B)} required to create a deal`);
    return;
  }
  const topUpCovered = ctcA >= MIN_CREDITCOIN_CTC_A + MIN_CREDITCOIN_CTC_B;
  if (topUpCovered) {
    log(
      `OK B test CTC: ${formatEther(ctcB)} held; \`deal:live\` will top B up from A, which holds ` +
        `${formatEther(ctcA)}`,
    );
    return;
  }
  state.funding.push(
    `B: send at least ${formatEther(MIN_CREDITCOIN_CTC_B - ctcB)} more test CTC, or top A up so it can cover the transfer`,
  );
  log(`NEEDS FUNDS B test CTC: ${formatEther(ctcB)} held and A cannot cover the top-up either`);
}

/**
 * Prints the whole USDC chain as it would run from the balances actually on
 * chain, and decides whether it can run at all.
 *
 * The projection starts from real balances rather than from the documented
 * minimum, because the two differ in exactly the case that matters. A check
 * that only asks "does each account hold enough" reports a half-finished run as
 * "A needs more USDC", which sends the operator to a faucet while the tokens sit
 * in wallet B. The table shows where they actually are, and the verdict says
 * whether to faucet or to move them back.
 */
function reportUsdcChain(
  state: CheckState,
  actual: UsdcState,
  decimals: number,
  helperAddress: string | undefined,
): void {
  const diagnosis = diagnose(actual);

  log('USDC through the ordered run, projected from the balances on chain now:');
  for (const line of renderProjection(diagnosis.projection, decimals)) log(`  ${line}`);
  log(
    helperAddress
      ? `  helper column is ${helperAddress}`
      : '  helper column is zero: the fixture helper has not been deployed yet',
  );
  if (diagnosis.stage) log(`  these balances match exactly what ${diagnosis.stage} leaves behind`);

  if (diagnosis.verdict === 'ready') {
    log(`OK USDC: ${diagnosis.summary}`);
    return;
  }

  const shortfall = diagnosis.projection.firstShortfall;
  log(`NOT READY USDC: ${diagnosis.summary}`);
  if (shortfall) {
    log(`  the run would stop at "${shortfall.label}", ${formatUnits(shortfall.missing, decimals)} USDC short`);
  }

  if (diagnosis.verdict === 'skewed') {
    // A configuration blocker rather than a funding action: sending this to the
    // faucet list would be advice that does not fix it.
    state.failures.push(
      'USDC balances differ from a clean start and look like a partially executed run. ' +
        diagnosis.actions.join('; '),
    );
    return;
  }

  for (const action of diagnosis.actions) state.funding.push(action);
}

async function checkDeployments(
  state: CheckState,
  sepolia: ReturnType<typeof evmProvider>,
  creditcoin: ReturnType<typeof evmProvider>,
  tokenAddress: string,
  chainKey?: number,
): Promise<void> {
  const sourceDeployment = readDeployment('sepolia');
  if (!sourceDeployment?.gateway) {
    log('PENDING Sepolia gateway: deploy:sepolia will create it');
  } else {
    const gateway = getAddress(sourceDeployment.gateway as string);
    if ((await sepolia.getCode(gateway)) === '0x') {
      state.failures.push(`Sepolia deployment record points to ${gateway}, which has no code`);
    } else {
      const configuredToken = (await new Contract(gateway, GATEWAY_ABI, sepolia).getFunction('token')()) as string;
      if (configuredToken.toLowerCase() !== tokenAddress.toLowerCase()) {
        state.failures.push(`Gateway ${gateway} trusts token ${configuredToken}, expected ${tokenAddress}`);
      } else log(`OK existing Sepolia gateway: ${gateway}`);
    }
  }

  const targetDeployment = readDeployment('creditcoin');
  if (!targetDeployment?.verifier) {
    log('PENDING Creditcoin verifier: deploy:creditcoin will create it after the gateway');
  } else {
    const verifier = getAddress(targetDeployment.verifier as string);
    if ((await creditcoin.getCode(verifier)) === '0x') {
      state.failures.push(`Creditcoin deployment record points to ${verifier}, which has no code`);
    } else {
      const contract = new Contract(verifier, VERIFIER_ABI, creditcoin);
      const [onChainKey, onChainGateway] = (await Promise.all([
        contract.getFunction('chainKey')(),
        contract.getFunction('gateway')(),
      ])) as [bigint, string];
      if (chainKey !== undefined && Number(onChainKey) !== chainKey) {
        state.failures.push(`Verifier ${verifier} uses chainKey ${onChainKey}, expected ${chainKey}`);
      } else if (
        sourceDeployment?.gateway &&
        onChainGateway.toLowerCase() !== (sourceDeployment.gateway as string).toLowerCase()
      ) {
        state.failures.push(`Verifier ${verifier} trusts gateway ${onChainGateway}, not ${sourceDeployment.gateway}`);
      } else log(`OK existing Creditcoin verifier: ${verifier}`);
    }
  }

  if (!targetDeployment?.deals) {
    log('PENDING Creditcoin registry: deploy:deals will create it, and the credit layer with it');
    return;
  }
  const dealsAddress = getAddress(targetDeployment.deals as string);
  if ((await creditcoin.getCode(dealsAddress)) === '0x') {
    state.failures.push(`Creditcoin deployment record points to a registry at ${dealsAddress}, which has no code`);
    return;
  }
  const registry = new Contract(dealsAddress, DEALS_ABI, creditcoin);
  const [trustedVerifier, creditAddress, registryChainKey, grace] = (await Promise.all([
    registry.getFunction('verifier')(),
    registry.getFunction('credit')(),
    registry.getFunction('chainKey')(),
    registry.getFunction('attestationGracePeriod')(),
  ])) as [string, string, bigint, bigint];

  if (targetDeployment.verifier && trustedVerifier.toLowerCase() !== (targetDeployment.verifier as string).toLowerCase()) {
    state.failures.push(`Registry ${dealsAddress} trusts verifier ${trustedVerifier}, not ${targetDeployment.verifier}`);
  } else if (chainKey !== undefined && Number(registryChainKey) !== chainKey) {
    state.failures.push(`Registry ${dealsAddress} uses chainKey ${registryChainKey}, expected ${chainKey}`);
  } else {
    // The credit layer answering to anything but this registry would mean the
    // pairing was made after deployment, which is the one thing the design does
    // not allow.
    const owner = (await new Contract(creditAddress, CREDIT_ABI, creditcoin).getFunction('deals')()) as string;
    if (owner.toLowerCase() !== dealsAddress.toLowerCase()) {
      state.failures.push(`Credit layer ${creditAddress} answers to ${owner}, not to the registry ${dealsAddress}`);
    } else {
      log(`OK existing Creditcoin registry: ${dealsAddress}, grace ${grace} source blocks`);
      log(`OK existing Creditcoin credit layer: ${creditAddress}, paired with the registry that deployed it`);
    }
  }
}

main().catch((error) => {
  console.error(`[preflight] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
