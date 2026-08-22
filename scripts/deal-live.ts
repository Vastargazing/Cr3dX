/**
 * S5: the complete Cr3dX path on live testnets, with no mocks or worker.
 *
 *   env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode fresh --runs 2
 *   env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode continue --runs 1
 *
 * `fresh` deploys a new registry/credit pair over the unchanged verifier and
 * gateway, then proves that the borrower starts at score 500 with no history,
 * reserve or exposure. `continue` uses the recorded pair and its accumulated
 * state. The modes are explicit because 500 -> 525 is only deterministic on a
 * fresh credit layer.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {
  Contract,
  formatEther,
  formatUnits,
  Interface,
  keccak256,
  parseEther,
  type Result,
  type TransactionReceipt,
  type TransactionRequest,
  type Wallet,
} from 'ethers';
import {config, warnIfProxyIgnored} from './lib/config.js';
import {readDeployment} from './lib/artifacts.js';
import {
  FACE_VALUE,
  FUNDING,
  MIN_CREDITCOIN_CTC_A,
  MIN_SEPOLIA_ETH_A,
  MIN_SEPOLIA_ETH_B,
} from './lib/live-plan.js';
import {
  BORROWER_USDC_PER_RUN,
  parseLiveOptions,
  requiredBorrowerUsdc,
  runCapacity,
  type LiveMode,
} from './lib/s5-plan.js';
import {continuityTuple, merkleTuple, ProofBuilderClient} from './lib/proofs.js';
import {evmProvider, errMessage, sleep, withRetry} from './lib/rpc.js';
import {liveWallets} from './lib/wallet.js';

const OUT_DIR = 'data/live';
const output: string[] = [];
const log = (msg: string): void => {
  const line = msg ? `[deal] ${msg}` : '[deal]';
  console.log(line);
  output.push(line);
};

const DUE_BLOCK_MARGIN = 400n;
const IMPOSTOR_AMOUNT = 1n;
const MIN_BORROWER_CTC = parseEther('0.005');
const BORROWER_TOP_UP = parseEther('0.01');
const DEFAULT_BASE_LIMIT = 5_000_000_000n;

const GATEWAY_ABI = [
  'function token() view returns (address)',
  'function fund(bytes32 dealId, address borrower, uint256 amount)',
  'function repay(bytes32 dealId, address investor, uint256 amount)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const DEAL_TUPLE =
  'tuple(address borrower, uint64 dueBlock, uint8 status, address designatedInvestor, uint96 dealSeq, ' +
  'address investor, uint256 requiredFunding, uint256 fundedAmount, uint256 faceValue, uint256 repaidAmount, ' +
  'uint256 onTimeRepaid)';
const DEALS_ABI = [
  'function credit() view returns (address)',
  'function verifier() view returns (address)',
  'function chainKey() view returns (uint64)',
  'function attestedSourceHeight() view returns (uint64)',
  `function getDeal(bytes32) view returns (${DEAL_TUPLE})`,
  'function outstandingOf(bytes32) view returns (uint256)',
  'function evidenceStateOf(bytes32) view returns (uint8 state, uint8 reason)',
  'function createDeal(address designatedInvestor, uint256 requiredFunding, uint256 faceValue, uint64 dueBlock) returns (bytes32)',
  'function submitAndApply(uint64 height, bytes encodedTx, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) returns (bytes32[])',
  'event DealCreated(bytes32 indexed dealId, address indexed borrower, address indexed designatedInvestor, uint256 requiredFunding, uint256 faceValue, uint64 dueBlock, uint96 dealSeq)',
  'event FundingApplied(bytes32 indexed dealId, bytes32 indexed evidenceId, uint256 amount, uint256 fundedAmount)',
  'event DealFinanced(bytes32 indexed dealId, address indexed investor, uint256 fundedAmount)',
  'event RepaymentApplied(bytes32 indexed dealId, bytes32 indexed evidenceId, uint256 amount, uint256 repaidAmount, uint256 onTimeRepaid)',
  'event DealSettled(bytes32 indexed dealId, uint8 status)',
  'event EvidenceRejected(bytes32 indexed evidenceId, bytes32 indexed dealId, uint8 reason)',
];
const CREDIT_ABI = [
  'function scoreOf(address) view returns (uint16)',
  'function scoreFromOutcomes(address) view returns (uint16)',
  'function limitOf(address) view returns (uint256)',
  'function availableLimitOf(address) view returns (uint256)',
  'function exposureOf(address) view returns (uint256)',
  'function reservedOf(address) view returns (uint256)',
  'function dealCountOf(address) view returns (uint256)',
  'function outcomeOf(bytes32) view returns (uint8)',
  'function recordOf(bytes32) view returns (tuple(address borrower, uint8 outcome, bool financed, uint64 closedAtBlock, uint256 faceValue))',
];

const STATUS = ['NONE', 'CREATED', 'FINANCED', 'DEFAULTED', 'PAID_LATE', 'PAID_ON_TIME'];
const EVIDENCE_STATE = ['UNSEEN', 'VERIFIED_PENDING', 'APPLIED', 'REJECTED_PERMANENT'];
const REASON = ['NONE', 'WRONG_INVESTOR', 'WRONG_RECIPIENT'];
const OUTCOME = ['NONE', 'PAID_ON_TIME', 'PAID_LATE', 'DEFAULTED'];

interface CostEntry {
  run: number | null;
  step: string;
  chain: 'sepolia' | 'creditcoin';
  tx: string;
  gasUsed: string;
  feeNative: string;
  continuityRoots?: number;
}

interface WaitMetric {
  label: string;
  targetHeight: number;
  finalAttestedHeight: number;
  durationMs: number;
}

interface StateSnapshot {
  label: string;
  dealId: string;
  status: string;
  fundedAmount: string;
  repaidAmount: string;
  onTimeRepaid: string;
  outstanding: string;
  reserved: string;
  exposure: string;
  score: number;
  limit: string;
  available: string;
}

interface RunResult {
  run: number;
  primaryDealId: string;
  reservedDealId: string;
  scoreBefore: number;
  scoreAfter: number;
  limitBefore: string;
  limitAfter: string;
  finalStatus: string;
  outcome: string;
  fundTx: string;
  impostorTx: string;
  repayTx: string;
  waits: WaitMetric[];
  snapshots: StateSnapshot[];
  durationMs: number;
}

interface Context {
  mode: LiveMode;
  sepolia: ReturnType<typeof evmProvider>;
  creditcoin: ReturnType<typeof evmProvider>;
  investor: Wallet;
  borrower: Wallet;
  creditcoinInvestor: Wallet;
  creditcoinBorrower: Wallet;
  gatewayAddress: string;
  gateway: Contract;
  gatewayAsBorrower: Contract;
  token: Contract;
  tokenAsBorrower: Contract;
  decimals: number;
  usdc: (value: bigint) => string;
  dealsAddress: string;
  creditAddress: string;
  deals: Contract;
  dealsAsBorrower: Contract;
  credit: Contract;
  dealsIface: Interface;
  prover: ProofBuilderClient;
  chainKey: number;
}

const costs: CostEntry[] = [];
const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) return;
  problems.push(message);
  log(`  MISMATCH: ${message}`);
}

function parsePositiveEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be positive, got ${raw}`);
  return value;
}

function recordCost(
  run: number | null,
  step: string,
  chain: 'sepolia' | 'creditcoin',
  tx: string,
  receipt: TransactionReceipt,
  roots?: number,
): void {
  costs.push({
    run,
    step,
    chain,
    tx,
    gasUsed: receipt.gasUsed.toString(),
    // ethers v6 derives `fee` as gasUsed * gasPrice from the receipt itself.
    feeNative: receipt.fee.toString(),
    ...(roots === undefined ? {} : {continuityRoots: roots}),
  });
}

async function main(): Promise<void> {
  const commandStarted = Date.now();
  warnIfProxyIgnored(log);
  const options = parseLiveOptions(process.argv.slice(2));
  log(`S5 mode ${options.mode}, ${options.runs} consecutive run(s)${options.preflightOnly ? ', preflight only' : ''}`);
  log('proofs are rebuilt immediately before every submitAndApply; no stored proof is replayed');

  const sepolia = evmProvider(config.sepoliaRpcUrl, config.sourceEvmChainId);
  const creditcoin = evmProvider(config.creditcoinRpcUrl, config.creditcoinChainId);
  const sepoliaWallets = liveWallets(sepolia);
  const creditcoinWallets = liveWallets(creditcoin);
  const source = readDeployment('sepolia');
  const initialTarget = readDeployment('creditcoin');
  if (!source?.gateway) throw new Error('No gateway in deployments/sepolia.json. Run `npm run deploy:sepolia`.');
  if (!initialTarget?.verifier) throw new Error('No verifier in deployments/creditcoin.json. Run `npm run deploy:creditcoin`.');
  if (options.mode === 'continue' && !initialTarget.deals) {
    throw new Error('Continue mode needs a registry in deployments/creditcoin.json. Use --mode fresh to deploy one.');
  }

  const gatewayAddress = source.gateway as string;
  const gateway = new Contract(gatewayAddress, GATEWAY_ABI, sepoliaWallets.deployer);
  const tokenAddress = (await withRetry('read gateway token', 5, () => gateway.getFunction('token')())) as string;
  const token = new Contract(tokenAddress, ERC20_ABI, sepoliaWallets.deployer);
  const decimals = Number(await withRetry('read token decimals', 5, () => token.getFunction('decimals')()));
  const usdc = (value: bigint): string => `${formatUnits(value, decimals)} USDC`;

  log(`gateway ${gatewayAddress}, token ${tokenAddress}`);
  log(`A deployer/investor ${sepoliaWallets.deployer.address}`);
  log(`B borrower/payer    ${sepoliaWallets.borrower.address}`);
  log('private keys came only from ignored .env and are never printed or written');

  const preflight = await preflightAll(
    options.mode,
    options.runs,
    sepolia,
    creditcoin,
    sepoliaWallets,
    creditcoinWallets,
    token,
    initialTarget,
    usdc,
  );
  if (options.preflightOnly) {
    log('PREFLIGHT ONLY: no transaction was sent');
    return;
  }

  let target = initialTarget;
  if (options.mode === 'fresh') {
    log('');
    log('=== fresh deployment: new Deals/Credit over the unchanged gateway and verifier');
    await deployFreshRegistry();
    const freshTarget = readDeployment('creditcoin');
    if (!freshTarget?.deals || freshTarget.deals === initialTarget?.deals) {
      throw new Error('Fresh deployment did not record a new registry address');
    }
    target = freshTarget;
    const txHash = target.dealsDeploymentTx as string;
    const receipt = await withRetry('confirm fresh deployment', 5, () => creditcoin.getTransactionReceipt(txHash));
    if (!receipt || receipt.status !== 1) throw new Error(`Cannot confirm fresh deployment ${txHash}`);
    recordCost(null, 'deploy Deals + Credit', 'creditcoin', txHash, receipt);
  }

  const dealsAddress = target!.deals as string;
  const deals = new Contract(dealsAddress, DEALS_ABI, creditcoinWallets.deployer);
  const dealsAsBorrower = new Contract(dealsAddress, DEALS_ABI, creditcoinWallets.borrower);
  const creditAddress = (await withRetry('read registry credit', 5, () => deals.getFunction('credit')())) as string;
  const credit = new Contract(creditAddress, CREDIT_ABI, creditcoin);
  const chainKey = Number(await withRetry('read registry chain key', 5, () => deals.getFunction('chainKey')()));
  const context: Context = {
    mode: options.mode,
    sepolia,
    creditcoin,
    investor: sepoliaWallets.deployer,
    borrower: sepoliaWallets.borrower,
    creditcoinInvestor: creditcoinWallets.deployer,
    creditcoinBorrower: creditcoinWallets.borrower,
    gatewayAddress,
    gateway,
    gatewayAsBorrower: gateway.connect(sepoliaWallets.borrower) as Contract,
    token,
    tokenAsBorrower: token.connect(sepoliaWallets.borrower) as Contract,
    decimals,
    usdc,
    dealsAddress,
    creditAddress,
    deals,
    dealsAsBorrower,
    credit,
    dealsIface: new Interface(DEALS_ABI),
    prover: new ProofBuilderClient(config.proofBuilderUrl, chainKey),
    chainKey,
  };

  log(`registry ${dealsAddress}, credit ${creditAddress}, chainKey ${chainKey}`);
  if (options.mode === 'fresh') await assertFreshState(context);
  await ensureBorrowerGas(context, preflight.ctcNeededTopUp);

  const runResults: RunResult[] = [];
  if (options.resumeDeal) {
    runResults.push(await resumeFinancedScenario(context, options.resumeDeal));
  } else {
    for (let run = 1; run <= options.runs; run += 1) runResults.push(await runScenario(context, run));
  }

  const commandDurationMs = Date.now() - commandStarted;
  printCostSummary(commandDurationMs, runResults);
  if (problems.length) throw new Error(`${problems.length} mismatch(es) on the live path; see above`);

  mkdirSync(OUT_DIR, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${OUT_DIR}/s5-${options.mode}-${stamp}`;
  const finalScore = Number(await withRetry('read final score', 5, () => credit.getFunction('scoreOf')(context.borrower.address)));
  const finalLimit = (await withRetry('read final limit', 5, () =>
    credit.getFunction('limitOf')(context.borrower.address),
  )) as bigint;
  const report = {
    capturedAt: new Date().toISOString(),
    mode: options.mode,
    requestedRuns: options.runs,
    resumedDeal: options.resumeDeal,
    commandDurationMs,
    chainKey,
    gateway: gatewayAddress,
    token: tokenAddress,
    deals: dealsAddress,
    credit: creditAddress,
    investor: context.investor.address,
    borrower: context.borrower.address,
    capacitiesAtStart: preflight.capacities,
    scoreBefore: preflight.score,
    scoreAfter: finalScore,
    limitBefore: preflight.limit.toString(),
    limitAfter: finalLimit.toString(),
    runs: runResults,
    costs,
    totals: costTotals(),
    problems,
  };
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  log(`machine-readable run: ${base}.json`);
  log(
    options.resumeDeal
      ? runResults[0]?.repayTx === 'already applied before recovery'
        ? 'the already closed primary deal was left untouched and its missing reserved second deal was created'
        : 'the interrupted financed deal was repaid, closed and followed by its reserved second deal'
      : 'the full path held on live testnets: created, financed, repaid, closed, scored, and reserve exhaustion remained visible',
  );
  log(`full console reference: ${base}.log`);
  writeFileSync(`${base}.log`, `${output.join('\n')}\n`);
}

async function preflightAll(
  mode: LiveMode,
  runs: number,
  sepolia: ReturnType<typeof evmProvider>,
  creditcoin: ReturnType<typeof evmProvider>,
  sepoliaWallets: ReturnType<typeof liveWallets>,
  creditcoinWallets: ReturnType<typeof liveWallets>,
  token: Contract,
  target: ReturnType<typeof readDeployment>,
  usdc: (value: bigint) => string,
): Promise<{score: number; limit: bigint; capacities: {balanceRuns: string; reserveRuns: string}; ctcNeededTopUp: bigint}> {
  log('');
  log('=== preflight: every blocker is checked before the first transaction');
  const [sepoliaNetwork, creditcoinNetwork, usdcA, usdcB, ethA, ethB, ctcA, ctcB] = await Promise.all([
    withRetry('read Sepolia network', 5, () => sepolia.getNetwork()),
    withRetry('read Creditcoin network', 5, () => creditcoin.getNetwork()),
    withRetry('read A USDC balance', 5, () => token.getFunction('balanceOf')(sepoliaWallets.deployer.address)) as Promise<bigint>,
    withRetry('read B USDC balance', 5, () => token.getFunction('balanceOf')(sepoliaWallets.borrower.address)) as Promise<bigint>,
    withRetry('read A Sepolia balance', 5, () => sepolia.getBalance(sepoliaWallets.deployer.address)),
    withRetry('read B Sepolia balance', 5, () => sepolia.getBalance(sepoliaWallets.borrower.address)),
    withRetry('read A Creditcoin balance', 5, () => creditcoin.getBalance(creditcoinWallets.deployer.address)),
    withRetry('read B Creditcoin balance', 5, () => creditcoin.getBalance(creditcoinWallets.borrower.address)),
  ]);
  if (Number(sepoliaNetwork.chainId) !== config.sourceEvmChainId) throw new Error(`Sepolia RPC is chain ${sepoliaNetwork.chainId}`);
  if (Number(creditcoinNetwork.chainId) !== config.creditcoinChainId) throw new Error(`Creditcoin RPC is chain ${creditcoinNetwork.chainId}`);

  const requiredB = requiredBorrowerUsdc(runs);
  const balanceRuns = runCapacity(usdcB, BORROWER_USDC_PER_RUN);
  const ctcNeededTopUp = ctcB >= MIN_BORROWER_CTC ? 0n : BORROWER_TOP_UP;
  log(`balance capacity: floor(B ${usdc(usdcB)} / ${usdc(BORROWER_USDC_PER_RUN)}) = ${balanceRuns} run(s)`);
  log(`requested ${runs}: B must hold at least ${usdc(requiredB)} before the first transaction`);

  let score = 500;
  let limit = parsePositiveEnv('CR3DX_BASE_LIMIT', DEFAULT_BASE_LIMIT);
  let reserved = 0n;
  let exposure = 0n;
  let available = limit;
  if (mode === 'continue') {
    const dealsAddress = target!.deals as string;
    if ((await withRetry('read registry code', 5, () => creditcoin.getCode(dealsAddress))) === '0x') {
      throw new Error(`Recorded registry ${dealsAddress} has no code`);
    }
    const registry = new Contract(dealsAddress, DEALS_ABI, creditcoin);
    const creditAddress = (await withRetry('read preflight credit', 5, () => registry.getFunction('credit')())) as string;
    const credit = new Contract(creditAddress, CREDIT_ABI, creditcoin);
    [score, limit, reserved, exposure, available] = await Promise.all([
      withRetry('read borrower score', 5, () => credit.getFunction('scoreOf')(creditcoinWallets.borrower.address)).then(Number),
      withRetry('read borrower limit', 5, () => credit.getFunction('limitOf')(creditcoinWallets.borrower.address)) as Promise<bigint>,
      withRetry('read borrower reserve', 5, () => credit.getFunction('reservedOf')(creditcoinWallets.borrower.address)) as Promise<bigint>,
      withRetry('read borrower exposure', 5, () => credit.getFunction('exposureOf')(creditcoinWallets.borrower.address)) as Promise<bigint>,
      withRetry('read borrower available limit', 5, () => credit.getFunction('availableLimitOf')(creditcoinWallets.borrower.address)) as Promise<bigint>,
    ]);
  }
  const reserveRuns = runCapacity(available, FACE_VALUE);
  log(`initial credit: score ${score}, limit ${usdc(limit)}, reserved ${usdc(reserved)}, exposure ${usdc(exposure)}, available ${usdc(available)}`);
  log(`reserve capacity: floor(available ${usdc(available)} / second-deal nominal ${usdc(FACE_VALUE)}) = ${reserveRuns} run(s)`);
  if (balanceRuns <= BigInt(runs + 1)) log(`WARNING: B balance is near exhaustion (${balanceRuns} total run(s) remain)`);
  if (reserveRuns <= BigInt(runs + 1)) log(`WARNING: credit reserve is near exhaustion (${reserveRuns} total run(s) remain)`);

  const blockers: string[] = [];
  if (usdcA < FUNDING) blockers.push(`A needs ${usdc(FUNDING)} to fund the first deal, holds ${usdc(usdcA)}`);
  if (usdcB < requiredB) blockers.push(`B needs ${usdc(requiredB)} for ${runs} run(s), holds ${usdc(usdcB)}`);
  if (balanceRuns < BigInt(runs)) blockers.push(`USDC balance capacity is ${balanceRuns}, requested ${runs}`);
  if (reserveRuns < BigInt(runs)) blockers.push(`reserve capacity is ${reserveRuns}, requested ${runs}`);
  if (ethA < MIN_SEPOLIA_ETH_A) blockers.push(`A needs at least ${formatEther(MIN_SEPOLIA_ETH_A)} Sepolia ETH, holds ${formatEther(ethA)}`);
  if (ethB < MIN_SEPOLIA_ETH_B) blockers.push(`B needs at least ${formatEther(MIN_SEPOLIA_ETH_B)} Sepolia ETH, holds ${formatEther(ethB)}`);
  const requiredCtcA = MIN_CREDITCOIN_CTC_A + ctcNeededTopUp;
  if (ctcA < requiredCtcA) blockers.push(`A needs at least ${formatEther(requiredCtcA)} CTC, holds ${formatEther(ctcA)}`);
  if (blockers.length) throw new Error(`preflight blocked before any transaction:\n- ${blockers.join('\n- ')}`);
  log('PREFLIGHT PASSED: balances, both run-capacity limits, networks and deployment inputs are ready');
  return {score, limit, capacities: {balanceRuns: balanceRuns.toString(), reserveRuns: reserveRuns.toString()}, ctcNeededTopUp};
}

async function deployFreshRegistry(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-deals.ts'], {
      cwd: process.cwd(),
      env: {...process.env, REDEPLOY_REASON: 'S5 fresh mode: prove the complete scenario from score 500 and empty history'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const relay = (prefix: string, chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        console.log(line);
        output.push(`${prefix}${line}`);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => relay('', chunk));
    child.stderr.on('data', (chunk: Buffer) => relay('[stderr] ', chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fresh deployment subprocess exited ${code}`))));
  });
}

async function assertFreshState(ctx: Context): Promise<void> {
  const [score, reserved, exposure, count] = await Promise.all([
    ctx.credit.getFunction('scoreOf')(ctx.borrower.address) as Promise<bigint>,
    ctx.credit.getFunction('reservedOf')(ctx.borrower.address) as Promise<bigint>,
    ctx.credit.getFunction('exposureOf')(ctx.borrower.address) as Promise<bigint>,
    ctx.credit.getFunction('dealCountOf')(ctx.borrower.address) as Promise<bigint>,
  ]);
  log(`fresh-state assertion: score ${score}, reserved ${ctx.usdc(reserved)}, exposure ${ctx.usdc(exposure)}, history ${count} deal(s)`);
  if (score !== 500n || reserved !== 0n || exposure !== 0n || count !== 0n) {
    throw new Error('Fresh registry did not start at score 500 with empty reserve, exposure and history');
  }
}

async function ensureBorrowerGas(ctx: Context, topUp: bigint): Promise<void> {
  if (topUp === 0n) {
    log(`B holds ${formatEther(await ctx.creditcoin.getBalance(ctx.creditcoinBorrower.address))} CTC, no top-up needed`);
    return;
  }
  log(`topping B up with ${formatEther(topUp)} CTC from A (covered by preflight)`);
  const sent = await sendKnownTransaction(
    ctx.creditcoin,
    ctx.creditcoinInvestor,
    async () => ({to: ctx.creditcoinBorrower.address, value: topUp}),
    'borrower CTC top-up',
  );
  recordCost(null, 'borrower CTC top-up', 'creditcoin', sent.hash, sent.receipt);
}

/**
 * Finishes a run that stopped after financing but before its source repayment.
 * The deal id is explicit because guessing which open exposure to mutate would
 * be more dangerous than leaving it untouched. No funding is replayed.
 */
async function resumeFinancedScenario(ctx: Context, dealId: string): Promise<RunResult> {
  const started = Date.now();
  const snapshots: StateSnapshot[] = [];
  const waits: WaitMetric[] = [];
  const dealBefore = await withRetry('read financed deal for recovery', 5, () => ctx.deals.getFunction('getDeal')(dealId));
  if (dealBefore.borrower.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
    throw new Error(`Recovery deal belongs to ${dealBefore.borrower}, not configured borrower ${ctx.borrower.address}`);
  }
  if (dealBefore.designatedInvestor.toLowerCase() !== ctx.investor.address.toLowerCase()) {
    throw new Error('Recovery deal has a different designated investor');
  }

  const scoreBefore = Number(await ctx.credit.getFunction('scoreOf')(ctx.borrower.address));
  const limitBefore = (await ctx.credit.getFunction('limitOf')(ctx.borrower.address)) as bigint;
  const exposureBefore = (await ctx.credit.getFunction('exposureOf')(ctx.borrower.address)) as bigint;
  const outstandingBefore = (await ctx.deals.getFunction('outstandingOf')(dealId)) as bigint;

  if (Number(dealBefore.status) === 5) {
    const outcome = Number(await ctx.credit.getFunction('outcomeOf')(dealId));
    if (outcome !== 1 || outstandingBefore !== 0n) {
      throw new Error('Closed-deal recovery requires PAID_ON_TIME with zero outstanding');
    }
    log('');
    log(`################ S5 RESERVE RECOVERY ${dealId} ################`);
    log('the primary deal is already PAID_ON_TIME; funding and repayment are not replayed');
    log('=== recovery.8 create only the reserved second deal that the interrupted run had not reached');
    const head = BigInt(await ctx.sepolia.getBlockNumber());
    const reservedDealId = await createDeal(ctx, 1, head + DUE_BLOCK_MARGIN, 'create reserved second deal (recovery)');
    snapshots.push(await printSnapshot(ctx, reservedDealId, 'recovery.8 after second unfunded deal'));
    return {
      run: 1,
      primaryDealId: dealId,
      reservedDealId,
      scoreBefore,
      scoreAfter: scoreBefore,
      limitBefore: limitBefore.toString(),
      limitAfter: limitBefore.toString(),
      finalStatus: 'PAID_ON_TIME',
      outcome: 'PAID_ON_TIME',
      fundTx: 'already applied before recovery',
      impostorTx: 'already rejected before recovery',
      repayTx: 'already applied before recovery',
      waits,
      snapshots,
      durationMs: Date.now() - started,
    };
  }

  if (Number(dealBefore.status) !== 2) {
    throw new Error(`Recovery requires FINANCED or PAID_ON_TIME, got ${STATUS[Number(dealBefore.status)] ?? dealBefore.status}`);
  }
  if (outstandingBefore === 0n) throw new Error('Recovery deal has no outstanding amount');

  log('');
  log(`################ S5 RECOVERY ${dealId} ################`);
  log(`reusing the proven funding; sending no funding transaction and applying no funding proof again`);
  log(`=== recovery.6 B repays A on Sepolia`);
  await ensureAllowance(ctx, 1, ctx.tokenAsBorrower, ctx.borrower.address, outstandingBefore);
  const repayRc = await send(
    ctx,
    1,
    ctx.borrower,
    () => ctx.gatewayAsBorrower.getFunction('repay').populateTransaction(dealId, ctx.investor.address, outstandingBefore),
    'repay (recovery)',
    'sepolia',
  );
  log(`    ${ctx.usdc(outstandingBefore)}, block ${repayRc.blockNumber}, https://sepolia.etherscan.io/tx/${repayRc.hash}`);
  snapshots.push(await printSnapshot(ctx, dealId, 'recovery.6 after source repayment'));

  log('=== recovery.7 wait, rebuild proof, submitAndApply repayment');
  waits.push(await waitForAttestation(ctx.prover, repayRc.blockNumber, 'recovery repayment'));
  const repayIds = await proveAndApply(ctx, 1, repayRc.hash, 'submitAndApply (recovery repayment)');
  check(repayIds.length === 1, `recovery repayment produced ${repayIds.length} facts`);
  const finalSnapshot = await printSnapshot(ctx, dealId, 'recovery.7 after repayment proof');
  snapshots.push(finalSnapshot);

  const dealAfter = await ctx.deals.getFunction('getDeal')(dealId);
  const outcome = Number(await ctx.credit.getFunction('outcomeOf')(dealId));
  const scoreAfter = Number(await ctx.credit.getFunction('scoreOf')(ctx.borrower.address));
  const limitAfter = (await ctx.credit.getFunction('limitOf')(ctx.borrower.address)) as bigint;
  const exposureAfter = BigInt(finalSnapshot.exposure);
  check(Number(dealAfter.status) === 5, `recovery final status is ${STATUS[Number(dealAfter.status)]}, expected PAID_ON_TIME`);
  check(outcome === 1, `recovery outcome is ${OUTCOME[outcome]}, expected PAID_ON_TIME`);
  check(exposureAfter === exposureBefore - outstandingBefore, 'recovery did not release exactly this deal exposure');

  log('=== recovery.8 create the reserved second deal that the interrupted run had not reached');
  const head = BigInt(await ctx.sepolia.getBlockNumber());
  const reservedDealId = await createDeal(ctx, 1, head + DUE_BLOCK_MARGIN, 'create reserved second deal (recovery)');
  snapshots.push(await printSnapshot(ctx, reservedDealId, 'recovery.8 after second unfunded deal'));

  return {
    run: 1,
    primaryDealId: dealId,
    reservedDealId,
    scoreBefore,
    scoreAfter,
    limitBefore: limitBefore.toString(),
    limitAfter: limitAfter.toString(),
    finalStatus: STATUS[Number(dealAfter.status)]!,
    outcome: OUTCOME[outcome]!,
    fundTx: 'already applied before recovery',
    impostorTx: 'already rejected before recovery',
    repayTx: repayRc.hash,
    waits,
    snapshots,
    durationMs: Date.now() - started,
  };
}

async function runScenario(ctx: Context, run: number): Promise<RunResult> {
  const started = Date.now();
  const snapshots: StateSnapshot[] = [];
  const waits: WaitMetric[] = [];
  log('');
  log(`################ S5 RUN ${run} ################`);
  const scoreBefore = Number(await withRetry('read score before run', 5, () => ctx.credit.getFunction('scoreOf')(ctx.borrower.address)));
  const limitBefore = (await withRetry('read limit before run', 5, () =>
    ctx.credit.getFunction('limitOf')(ctx.borrower.address),
  )) as bigint;
  const exposureBefore = (await withRetry('read exposure before run', 5, () =>
    ctx.credit.getFunction('exposureOf')(ctx.borrower.address),
  )) as bigint;

  const head = BigInt(await withRetry('read Sepolia head for primary deal', 5, () => ctx.sepolia.getBlockNumber()));
  const dueBlock = head + DUE_BLOCK_MARGIN;
  log(`=== ${run}.1 B creates primary deal; Sepolia head ${head}, due block ${dueBlock}`);
  const primaryDealId = await createDeal(ctx, run, dueBlock, 'create primary deal');
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.1 after primary create`));

  log(`=== ${run}.2 A funds B on Sepolia`);
  await ensureAllowance(ctx, run, ctx.token, ctx.investor.address, FUNDING);
  const fundRc = await send(
    ctx,
    run,
    ctx.investor,
    () => ctx.gateway.getFunction('fund').populateTransaction(primaryDealId, ctx.borrower.address, FUNDING),
    'fund',
    'sepolia',
  );
  log(`    ${ctx.usdc(FUNDING)}, block ${fundRc.blockNumber}, https://sepolia.etherscan.io/tx/${fundRc.hash}`);
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.2 after source funding`));

  log(`=== ${run}.3 B emits an unauthorized funding fact (self-transfer)`);
  await ensureAllowance(ctx, run, ctx.tokenAsBorrower, ctx.borrower.address, IMPOSTOR_AMOUNT);
  const impostorRc = await send(
    ctx,
    run,
    ctx.borrower,
    () => ctx.gatewayAsBorrower.getFunction('fund').populateTransaction(primaryDealId, ctx.borrower.address, IMPOSTOR_AMOUNT),
    'fund (impostor)',
    'sepolia',
  );
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.3 after source impostor funding`));

  log(`=== ${run}.4 wait for funding attestation with visible progress`);
  waits.push(await waitForAttestation(ctx.prover, Math.max(fundRc.blockNumber, impostorRc.blockNumber), `run ${run} funding`));

  log(`=== ${run}.5 build fresh proofs and submitAndApply`);
  const fundIds = await proveAndApply(ctx, run, fundRc.hash, 'submitAndApply (funding)');
  check(fundIds.length === 1, `run ${run}: funding produced ${fundIds.length} facts`);
  let deal = await withRetry('read financed deal', 5, () => ctx.deals.getFunction('getDeal')(primaryDealId));
  check(Number(deal.status) === 2, `run ${run}: expected FINANCED, got ${STATUS[Number(deal.status)]}`);
  check(deal.fundedAmount === FUNDING, `run ${run}: funded amount is not ${FUNDING}`);
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.5 after financing proof`));

  const impostorIds = await proveAndApply(ctx, run, impostorRc.hash, 'submitAndApply (impostor funding)');
  check(impostorIds.length === 1, `run ${run}: impostor funding produced ${impostorIds.length} facts`);
  const [evidenceState, reason] = (await withRetry('read impostor evidence state', 5, () =>
    ctx.deals.getFunction('evidenceStateOf')(impostorIds[0]),
  )) as [bigint, bigint];
  log(`    impostor evidence ${EVIDENCE_STATE[Number(evidenceState)]} / ${REASON[Number(reason)]}`);
  check(evidenceState === 3n && reason === 1n, `run ${run}: impostor was not WRONG_INVESTOR`);
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.5 after impostor proof`));

  log(`=== ${run}.6 B repays A on Sepolia`);
  await ensureAllowance(ctx, run, ctx.tokenAsBorrower, ctx.borrower.address, FACE_VALUE);
  const repayRc = await send(
    ctx,
    run,
    ctx.borrower,
    () => ctx.gatewayAsBorrower.getFunction('repay').populateTransaction(primaryDealId, ctx.investor.address, FACE_VALUE),
    'repay',
    'sepolia',
  );
  log(`    ${ctx.usdc(FACE_VALUE)}, block ${repayRc.blockNumber}, https://sepolia.etherscan.io/tx/${repayRc.hash}`);
  snapshots.push(await printSnapshot(ctx, primaryDealId, `${run}.6 after source repayment`));

  log(`=== ${run}.7 wait, rebuild proof, submitAndApply repayment`);
  waits.push(await waitForAttestation(ctx.prover, repayRc.blockNumber, `run ${run} repayment`));
  const repayIds = await proveAndApply(ctx, run, repayRc.hash, 'submitAndApply (repayment)');
  check(repayIds.length === 1, `run ${run}: repayment produced ${repayIds.length} facts`);
  const finalSnapshot = await printSnapshot(ctx, primaryDealId, `${run}.7 after repayment proof`);
  snapshots.push(finalSnapshot);

  deal = await withRetry('read closed deal', 5, () => ctx.deals.getFunction('getDeal')(primaryDealId));
  const outcome = Number(await withRetry('read deal outcome', 5, () => ctx.credit.getFunction('outcomeOf')(primaryDealId)));
  const scoreAfter = Number(await withRetry('read score after run', 5, () => ctx.credit.getFunction('scoreOf')(ctx.borrower.address)));
  const recomputed = Number(
    await withRetry('recompute score after run', 5, () => ctx.credit.getFunction('scoreFromOutcomes')(ctx.borrower.address)),
  );
  const limitAfter = (await withRetry('read limit after run', 5, () =>
    ctx.credit.getFunction('limitOf')(ctx.borrower.address),
  )) as bigint;
  const expectedScore = Math.min(850, scoreBefore + 25);
  check(Number(deal.status) === 5, `run ${run}: final status is ${STATUS[Number(deal.status)]}, expected PAID_ON_TIME`);
  check(outcome === 1, `run ${run}: outcome is ${OUTCOME[outcome]}, expected PAID_ON_TIME`);
  check(finalSnapshot.outstanding === '0', `run ${run}: outstanding is not zero`);
  check(
    BigInt(finalSnapshot.exposure) === exposureBefore,
    `run ${run}: this deal did not release its exposure (account ${exposureBefore} -> ${finalSnapshot.exposure})`,
  );
  if (ctx.mode === 'fresh') check(finalSnapshot.exposure === '0', `fresh run ${run}: exposure is not zero`);
  check(scoreAfter === recomputed, `run ${run}: cached score differs from canonical recomputation`);
  check(scoreAfter === expectedScore, `run ${run}: score ${scoreBefore} -> ${scoreAfter}, expected ${expectedScore}`);
  check(limitAfter >= limitBefore, `run ${run}: limit fell after an on-time outcome`);
  if (ctx.mode === 'fresh' && run === 1) {
    check(scoreBefore === 500 && scoreAfter === 525, 'fresh first run is not deterministic 500 -> 525');
  }

  log(`=== ${run}.8 create second deal and leave it unfunded to demonstrate reserve drift`);
  const secondHead = BigInt(await withRetry('read Sepolia head for reserved deal', 5, () => ctx.sepolia.getBlockNumber()));
  const reservedDealId = await createDeal(ctx, run, secondHead + DUE_BLOCK_MARGIN, 'create reserved second deal');
  const reservedSnapshot = await printSnapshot(ctx, reservedDealId, `${run}.8 after second unfunded deal`);
  snapshots.push(reservedSnapshot);
  check(reservedSnapshot.status === 'CREATED', `run ${run}: second deal did not remain CREATED`);

  log(`run ${run} complete: score ${scoreBefore} -> ${scoreAfter}, limit ${ctx.usdc(limitBefore)} -> ${ctx.usdc(limitAfter)}`);
  return {
    run,
    primaryDealId,
    reservedDealId,
    scoreBefore,
    scoreAfter,
    limitBefore: limitBefore.toString(),
    limitAfter: limitAfter.toString(),
    finalStatus: STATUS[Number(deal.status)]!,
    outcome: OUTCOME[outcome]!,
    fundTx: fundRc.hash,
    impostorTx: impostorRc.hash,
    repayTx: repayRc.hash,
    waits,
    snapshots,
    durationMs: Date.now() - started,
  };
}

async function createDeal(ctx: Context, run: number, dueBlock: bigint, step: string): Promise<string> {
  const sent = await sendKnownTransaction(
    ctx.creditcoin,
    ctx.creditcoinBorrower,
    () => ctx.dealsAsBorrower.getFunction('createDeal').populateTransaction(ctx.investor.address, FUNDING, FACE_VALUE, dueBlock),
    step,
  );
  const {hash, receipt} = sent;
  recordCost(run, step, 'creditcoin', hash, receipt);
  const event = parseEvents(ctx.dealsIface, receipt, ctx.dealsAddress).find((entry) => entry.name === 'DealCreated');
  if (!event) throw new Error(`${step} emitted no DealCreated`);
  const dealId = event.args.dealId as string;
  log(`    ${dealId}, tx ${hash}, gas ${receipt.gasUsed}`);
  return dealId;
}

async function printSnapshot(ctx: Context, dealId: string, label: string): Promise<StateSnapshot> {
  const [deal, outstanding, reserved, exposure, score, limit, available] = await Promise.all([
    withRetry(`${label}: read deal`, 5, () => ctx.deals.getFunction('getDeal')(dealId)),
    withRetry(`${label}: read outstanding`, 5, () => ctx.deals.getFunction('outstandingOf')(dealId)) as Promise<bigint>,
    withRetry(`${label}: read reserve`, 5, () => ctx.credit.getFunction('reservedOf')(ctx.borrower.address)) as Promise<bigint>,
    withRetry(`${label}: read exposure`, 5, () => ctx.credit.getFunction('exposureOf')(ctx.borrower.address)) as Promise<bigint>,
    withRetry(`${label}: read score`, 5, () => ctx.credit.getFunction('scoreOf')(ctx.borrower.address)).then(Number),
    withRetry(`${label}: read limit`, 5, () => ctx.credit.getFunction('limitOf')(ctx.borrower.address)) as Promise<bigint>,
    withRetry(`${label}: read available`, 5, () => ctx.credit.getFunction('availableLimitOf')(ctx.borrower.address)) as Promise<bigint>,
  ]);
  const snapshot: StateSnapshot = {
    label,
    dealId,
    status: STATUS[Number(deal.status)] ?? `UNKNOWN(${deal.status})`,
    fundedAmount: deal.fundedAmount.toString(),
    repaidAmount: deal.repaidAmount.toString(),
    onTimeRepaid: deal.onTimeRepaid.toString(),
    outstanding: outstanding.toString(),
    reserved: reserved.toString(),
    exposure: exposure.toString(),
    score,
    limit: limit.toString(),
    available: available.toString(),
  };
  log(`    STATE ${label}`);
  log(`      status ${snapshot.status}; funded ${ctx.usdc(deal.fundedAmount)}; repaid ${ctx.usdc(deal.repaidAmount)}; on-time ${ctx.usdc(deal.onTimeRepaid)}; outstanding ${ctx.usdc(outstanding)}`);
  log(`      reserve ${ctx.usdc(reserved)}; exposure ${ctx.usdc(exposure)}; score ${score}; limit ${ctx.usdc(limit)}; available ${ctx.usdc(available)}`);
  return snapshot;
}

async function ensureAllowance(ctx: Context, run: number, token: Contract, owner: string, amount: bigint): Promise<void> {
  const current = (await withRetry('read gateway allowance', 5, () =>
    token.getFunction('allowance')(owner, ctx.gatewayAddress),
  )) as bigint;
  if (current >= amount) {
    log(`    allowance already covers ${ctx.usdc(amount)}`);
    return;
  }
  log(`    approve gateway for ${ctx.usdc(amount)}`);
  const signer = owner.toLowerCase() === ctx.investor.address.toLowerCase() ? ctx.investor : ctx.borrower;
  const sent = await sendKnownTransaction(
    ctx.sepolia,
    signer,
    () => token.getFunction('approve').populateTransaction(ctx.gatewayAddress, amount),
    'approve',
  );
  recordCost(run, `approve ${owner === ctx.investor.address ? 'A' : 'B'}`, 'sepolia', sent.hash, sent.receipt);
  const confirmed = (await withRetry('confirm gateway allowance', 5, () =>
    token.getFunction('allowance')(owner, ctx.gatewayAddress),
  )) as bigint;
  if (confirmed < amount) throw new Error(`allowance ${confirmed} after approve, expected ${amount}`);
}

async function send(
  ctx: Context,
  run: number,
  signer: Wallet,
  request: () => Promise<TransactionRequest>,
  step: string,
  chain: 'sepolia' | 'creditcoin',
): Promise<{hash: string; blockNumber: number}> {
  const provider = chain === 'sepolia' ? ctx.sepolia : ctx.creditcoin;
  const sent = await sendKnownTransaction(provider, signer, request, step);
  recordCost(run, step, chain, sent.hash, sent.receipt);
  return {hash: sent.hash, blockNumber: sent.receipt.blockNumber};
}

async function proveAndApply(ctx: Context, run: number, txHash: string, step: string): Promise<string[]> {
  const proof = await ctx.prover.getProof(txHash, 5);
  log(`    fresh proof for ${txHash.slice(0, 12)}...: height ${proof.headerNumber}, ${proof.continuityProof.roots.length} roots`);
  const args = [proof.headerNumber, proof.txBytes, merkleTuple(proof.merkleProof), continuityTuple(proof.continuityProof)];
  const ids = (await ctx.deals.getFunction('submitAndApply').staticCall(...args)) as string[];
  const sent = await sendKnownTransaction(
    ctx.creditcoin,
    ctx.creditcoinInvestor,
    () => ctx.deals.getFunction('submitAndApply').populateTransaction(...args),
    step,
  );
  const {hash, receipt} = sent;
  recordCost(run, step, 'creditcoin', hash, receipt, proof.continuityProof.roots.length);
  log(`    ${step}: ${hash}, gas ${receipt.gasUsed}`);
  for (const event of parseEvents(ctx.dealsIface, receipt, ctx.dealsAddress)) log(`      ${event.name}`);
  return ids;
}

/**
 * Signs before the first RPC write, so even a request timeout leaves us with a
 * deterministic hash. A retry broadcasts the exact same raw bytes and cannot
 * create a second logical transaction with a new nonce.
 */
async function sendKnownTransaction(
  provider: ReturnType<typeof evmProvider>,
  signer: Wallet,
  request: () => Promise<TransactionRequest>,
  label: string,
): Promise<{hash: string; receipt: TransactionReceipt}> {
  const skeleton = await withRetry(`${label} populate`, 5, request);
  const populated = await withRetry(`${label} transaction fields`, 5, () => signer.populateTransaction(skeleton));
  const raw = await signer.signTransaction(populated);
  const hash = keccak256(raw);
  log(`    ${label}: locally signed ${hash}`);

  const deadline = Date.now() + 10 * 60_000;
  let observed = false;
  let broadcastAttempts = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await provider.getTransactionReceipt(hash);
    } catch (error) {
      lastError = error;
    }
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`${label} reverted: ${hash}`);
      return {hash, receipt};
    }

    if (!observed) {
      try {
        const known = await provider.getTransaction(hash);
        observed = known !== null;
        if (observed) log(`    ${label}: ${hash} is visible; waiting for its receipt`);
      } catch (error) {
        lastError = error;
      }
    }

    if (!observed && broadcastAttempts < 6) {
      broadcastAttempts += 1;
      try {
        const response = await provider.broadcastTransaction(raw);
        if (response.hash.toLowerCase() !== hash.toLowerCase()) {
          throw new Error(`${label}: RPC returned ${response.hash}, expected locally computed ${hash}`);
        }
        observed = true;
        log(`    ${label}: broadcast accepted on attempt ${broadcastAttempts}`);
      } catch (error) {
        lastError = error;
        log(`    ${label}: broadcast attempt ${broadcastAttempts} was inconclusive (${errMessage(error)}); checking ${hash}`);
      }
    }

    await sleep(observed ? 5_000 : 2_000 * Math.min(broadcastAttempts + 1, 5));
  }
  throw new Error(`${label}: no successful receipt for known transaction ${hash} within 10 minutes (${errMessage(lastError)})`);
}

function parseEvents(iface: Interface, receipt: TransactionReceipt, address: string): {name: string; args: Result}[] {
  const parsed: {name: string; args: Result}[] = [];
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== address.toLowerCase()) continue;
    const event = iface.parseLog({topics: entry.topics, data: entry.data});
    if (event) parsed.push({name: event.name, args: event.args});
  }
  return parsed;
}

async function waitForAttestation(prover: ProofBuilderClient, height: number, label: string): Promise<WaitMetric> {
  const started = Date.now();
  const timeoutMs = 45 * 60_000;
  for (;;) {
    const attested = await prover.attestedHeight().catch(() => -1);
    const durationMs = Date.now() - started;
    if (attested >= height) {
      log(`    ${label}: attested ${attested} covers ${height}; waited ${formatDuration(durationMs)}`);
      return {label, targetHeight: height, finalAttestedHeight: attested, durationMs};
    }
    log(`    ${label}: attested ${attested}/${height}, ${height - attested} blocks left, ${formatDuration(durationMs)} elapsed`);
    if (durationMs > timeoutMs) {
      throw new Error(`Attestation did not reach ${height} within 45 minutes. Source transactions are final; rerun only after inspecting their state.`);
    }
    await sleep(30_000);
  }
}

function costTotals(): {
  sepolia: {gasUsed: string; feeNative: string};
  creditcoin: {gasUsed: string; feeNative: string};
} {
  const result = {
    sepolia: {gasUsed: 0n, feeNative: 0n},
    creditcoin: {gasUsed: 0n, feeNative: 0n},
  };
  for (const entry of costs) {
    result[entry.chain].gasUsed += BigInt(entry.gasUsed);
    result[entry.chain].feeNative += BigInt(entry.feeNative);
  }
  return {
    sepolia: {gasUsed: result.sepolia.gasUsed.toString(), feeNative: result.sepolia.feeNative.toString()},
    creditcoin: {gasUsed: result.creditcoin.gasUsed.toString(), feeNative: result.creditcoin.feeNative.toString()},
  };
}

function printCostSummary(commandDurationMs: number, runs: RunResult[]): void {
  log('');
  log('=== measured live metrics');
  for (const entry of costs) {
    const symbol = entry.chain === 'sepolia' ? 'ETH' : 'CTC';
    const roots = entry.continuityRoots === undefined ? '' : `, ${entry.continuityRoots} roots`;
    log(`  ${entry.step.padEnd(34)} run ${String(entry.run ?? '-').padStart(2)}: ${entry.gasUsed.padStart(9)} gas, ${formatEther(entry.feeNative)} ${symbol}${roots}`);
  }
  const totals = costTotals();
  log(`  Sepolia total:    ${totals.sepolia.gasUsed} gas, ${formatEther(totals.sepolia.feeNative)} test ETH spent`);
  log(`  Creditcoin total: ${totals.creditcoin.gasUsed} gas, ${formatEther(totals.creditcoin.feeNative)} test CTC spent`);
  for (const run of runs) {
    for (const wait of run.waits) log(`  ${wait.label} wait: ${formatDuration(wait.durationMs)}`);
    log(`  run ${run.run} wall time: ${formatDuration(run.durationMs)}`);
  }
  log(`  total scenario wall time: ${formatDuration(commandDurationMs)}`);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function writeFailureLog(error: unknown): void {
  try {
    mkdirSync(OUT_DIR, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const line = `[deal] fatal: ${errMessage(error)}`;
    console.error(line);
    output.push(line);
    writeFileSync(`${OUT_DIR}/s5-failed-${stamp}.log`, `${output.join('\n')}\n`);
  } catch {
    console.error(`[deal] fatal: ${errMessage(error)}`);
  }
}

main().catch((error) => {
  writeFailureLog(error);
  process.exitCode = 1;
});
