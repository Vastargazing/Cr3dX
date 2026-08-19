/**
 * The full Cr3dX path on live testnets, with nothing simulated.
 *
 *   npm run deal:live
 *
 * One run, in order:
 *
 *   1. B creates a deal on Creditcoin. Face value is reserved against B's limit.
 *   2. A sends the funding to B through the Sepolia gateway.
 *   3. B sends a funding for the same deal, which is a lie: A is the designated
 *      investor. It is a self-transfer, so it moves no money, and it exists to
 *      show a permanent refusal on live data.
 *   4. Attestation catches up with both blocks.
 *   5. Each is proven and applied in one Creditcoin transaction. The genuine one
 *      finances the deal and turns the reserve into exposure; the lie lands in
 *      REJECTED_PERMANENT with WRONG_INVESTOR.
 *   6. B repays the face value through the gateway, to A.
 *   7. Attestation catches up again, the repayment is proven and applied, the
 *      deal closes as PAID_ON_TIME, exposure is released and the score rises.
 *
 * Every proof is built fresh. A continuity proof anchors to an attestation the
 * chain prunes within roughly half an hour, so a stored proof is not a fixture,
 * it is a proof with a short life. See docs/ATTESTCOIN_INTEGRATION.md.
 *
 * Gas is measured, not estimated, and written to data/live/ with the run.
 */
import { Contract, formatEther, formatUnits, Interface, parseEther } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { readDeployment } from './lib/artifacts.js';
import { FACE_VALUE, FUNDING } from './lib/live-plan.js';
import { continuityTuple, merkleTuple, ProofBuilderClient } from './lib/proofs.js';
import { evmProvider, errMessage, sleep } from './lib/rpc.js';
import { liveWallets } from './lib/wallet.js';

const OUT_DIR = 'data/live';
const log = (msg: string): void => console.log(`[deal] ${msg}`);

/**
 * How far ahead of the Sepolia head the deadline is set. The repayment has to
 * be included below it to count as on time, and it happens one attestation wait
 * later, which is seven to ten minutes, so roughly fifty blocks. Four hundred
 * leaves the demo room to be interrupted and resumed without turning an on-time
 * repayment into a late one by accident.
 */
const DUE_BLOCK_MARGIN = 400n;

/** One native unit. The impostor funding is a self-transfer of the smallest amount that exists. */
const IMPOSTOR_AMOUNT = 1n;

/** Enough Creditcoin gas for the borrower to create a deal, with room to spare. */
const MIN_BORROWER_CTC = parseEther('0.005');
const BORROWER_TOP_UP = parseEther('0.01');

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
  'function attestationGracePeriod() view returns (uint64)',
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
  'function outcomeOf(bytes32) view returns (uint8)',
  'function recordOf(bytes32) view returns (tuple(address borrower, uint8 outcome, bool financed, uint64 closedAtBlock, uint256 faceValue))',
];

const STATUS = ['NONE', 'CREATED', 'FINANCED', 'DEFAULTED', 'PAID_LATE', 'PAID_ON_TIME'];
const EVIDENCE_STATE = ['UNSEEN', 'VERIFIED_PENDING', 'APPLIED', 'REJECTED_PERMANENT'];
const REASON = ['NONE', 'WRONG_INVESTOR', 'ALREADY_FUNDED', 'WRONG_RECIPIENT'];
const OUTCOME = ['NONE', 'PAID_ON_TIME', 'PAID_LATE', 'DEFAULTED'];

interface GasEntry {
  step: string;
  chain: 'sepolia' | 'creditcoin';
  tx: string;
  gasUsed: string;
  continuityRoots?: number;
}

const gasTable: GasEntry[] = [];
const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) return;
  problems.push(message);
  log(`  MISMATCH: ${message}`);
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);

  const sepolia = evmProvider(config.sepoliaRpcUrl);
  const creditcoin = evmProvider(config.creditcoinRpcUrl);
  const sepoliaWallets = liveWallets(sepolia);
  const creditcoinWallets = liveWallets(creditcoin);
  const investor = sepoliaWallets.deployer;
  const borrower = sepoliaWallets.borrower;

  const source = readDeployment('sepolia');
  const target = readDeployment('creditcoin');
  if (!source?.gateway) throw new Error('No gateway in deployments/sepolia.json. Run `npm run deploy:sepolia`.');
  if (!target?.deals) throw new Error('No registry in deployments/creditcoin.json. Run `npm run deploy:deals`.');

  const gatewayAddress = source.gateway as string;
  const dealsAddress = target.deals as string;

  const deals = new Contract(dealsAddress, DEALS_ABI, creditcoinWallets.deployer);
  const dealsAsBorrower = new Contract(dealsAddress, DEALS_ABI, creditcoinWallets.borrower);
  const creditAddress = (await deals.getFunction('credit')()) as string;
  const credit = new Contract(creditAddress, CREDIT_ABI, creditcoin);
  const dealsIface = new Interface(DEALS_ABI);

  const gateway = new Contract(gatewayAddress, GATEWAY_ABI, investor);
  const gatewayAsBorrower = gateway.connect(borrower) as Contract;
  const tokenAddress = (await gateway.getFunction('token')()) as string;
  const token = new Contract(tokenAddress, ERC20_ABI, investor);
  const tokenAsBorrower = token.connect(borrower) as Contract;
  const decimals = Number(await token.getFunction('decimals')());
  const usdc = (value: bigint): string => `${formatUnits(value, decimals)} USDC`;

  const chainKey = Number(await deals.getFunction('chainKey')());
  log(`registry ${dealsAddress}, credit layer ${creditAddress}, chainKey ${chainKey}`);
  log(`gateway ${gatewayAddress}, token ${tokenAddress}`);
  log(`A investor  ${investor.address}`);
  log(`B borrower  ${borrower.address}`);

  await requireBalances(token, investor.address, borrower.address, decimals);
  await ensureBorrowerGas(creditcoin, creditcoinWallets);

  // -- 1. the deal ---------------------------------------------------------
  const head = BigInt(await sepolia.getBlockNumber());
  const dueBlock = head + DUE_BLOCK_MARGIN;
  const attestedBefore = BigInt(await deals.getFunction('attestedSourceHeight')());
  log('');
  log(`=== 1. B creates a deal on Creditcoin`);
  log(`    Sepolia head ${head}, attested ${attestedBefore}, deadline set to ${dueBlock}`);

  const scoreBefore = Number(await credit.getFunction('scoreOf')(borrower.address));
  const limitBefore = (await credit.getFunction('limitOf')(borrower.address)) as bigint;
  const availableBefore = (await credit.getFunction('availableLimitOf')(borrower.address)) as bigint;
  log(`    B before: score ${scoreBefore}, limit ${usdc(limitBefore)}, available ${usdc(availableBefore)}`);
  if (availableBefore < FACE_VALUE) {
    throw new Error(
      `B has ${usdc(availableBefore)} of credit available, and this deal needs ${usdc(FACE_VALUE)}. ` +
        'Earlier runs of this script reserve the limit permanently: there is no release by design.',
    );
  }

  const createTx = await dealsAsBorrower.getFunction('createDeal')(
    investor.address,
    FUNDING,
    FACE_VALUE,
    dueBlock,
  );
  const createRc = await createTx.wait();
  if (createRc.status !== 1) throw new Error(`createDeal reverted: ${createTx.hash}`);
  gasTable.push({step: 'createDeal', chain: 'creditcoin', tx: createTx.hash, gasUsed: createRc.gasUsed.toString()});

  const created = parseEvents(dealsIface, createRc, dealsAddress).find((e) => e.name === 'DealCreated');
  if (!created) throw new Error('createDeal emitted no DealCreated event');
  const dealId = created.args.dealId as string;
  log(`    deal ${dealId}, gas ${createRc.gasUsed}`);
  log(`    reserved ${usdc((await credit.getFunction('reservedOf')(borrower.address)) as bigint)}, available now ${usdc((await credit.getFunction('availableLimitOf')(borrower.address)) as bigint)}`);
  check(
    ((await credit.getFunction('reservedOf')(borrower.address)) as bigint) >= FACE_VALUE,
    'creating the deal did not reserve the face value',
  );

  // -- 2 and 3. the two payments -------------------------------------------
  log('');
  log('=== 2. A funds the deal on Sepolia');
  await ensureAllowance(token, investor.address, gatewayAddress, FUNDING, usdc);
  const fundRc = await send(gateway.getFunction('fund')(dealId, borrower.address, FUNDING), 'fund', 'sepolia');
  log(`    ${usdc(FUNDING)} from A to B in block ${fundRc.blockNumber}`);
  log(`    https://sepolia.etherscan.io/tx/${fundRc.hash}`);

  log('');
  log('=== 3. B funds the same deal, which nothing entitles B to do');
  await ensureAllowance(tokenAsBorrower, borrower.address, gatewayAddress, IMPOSTOR_AMOUNT, usdc);
  const impostorRc = await send(
    gatewayAsBorrower.getFunction('fund')(dealId, borrower.address, IMPOSTOR_AMOUNT),
    'fund (impostor)',
    'sepolia',
  );
  log(`    ${usdc(IMPOSTOR_AMOUNT)} from B to B, a self-transfer that moves no money`);
  log(`    https://sepolia.etherscan.io/tx/${impostorRc.hash}`);

  // -- 4 and 5. prove both --------------------------------------------------
  const prover = new ProofBuilderClient(config.proofBuilderUrl, chainKey);
  log('');
  log('=== 4. waiting for attestation to reach both blocks');
  await waitForAttestation(prover, Math.max(fundRc.blockNumber, impostorRc.blockNumber));

  log('');
  log('=== 5. proving and applying, one Creditcoin transaction each');
  const fundIds = await proveAndApply(deals, dealsIface, prover, fundRc.hash, 'submitAndApply (funding)');
  check(fundIds.length === 1, `the funding transaction produced ${fundIds.length} facts, expected 1`);

  let deal = await deals.getFunction('getDeal')(dealId);
  log(`    deal is ${STATUS[Number(deal.status)]}, investor ${deal.investor}, funded ${usdc(deal.fundedAmount)}`);
  check(Number(deal.status) === 2, `deal is ${STATUS[Number(deal.status)]}, expected FINANCED`);
  check(deal.investor.toLowerCase() === investor.address.toLowerCase(), 'the investor was not fixed to A');

  const reservedAfterFunding = (await credit.getFunction('reservedOf')(borrower.address)) as bigint;
  const exposureAfterFunding = (await credit.getFunction('exposureOf')(borrower.address)) as bigint;
  log(`    reserve ${usdc(reservedAfterFunding)}, exposure ${usdc(exposureAfterFunding)}`);
  check(exposureAfterFunding >= FACE_VALUE, 'the reserve did not become exposure');

  const impostorIds = await proveAndApply(
    deals,
    dealsIface,
    prover,
    impostorRc.hash,
    'submitAndApply (impostor funding)',
  );
  check(impostorIds.length === 1, `the impostor transaction produced ${impostorIds.length} facts, expected 1`);
  const [impostorState, impostorReason] = (await deals.getFunction('evidenceStateOf')(impostorIds[0])) as [
    bigint,
    bigint,
  ];
  log(`    impostor evidence: ${EVIDENCE_STATE[Number(impostorState)]} / ${REASON[Number(impostorReason)]}`);
  check(Number(impostorState) === 3, 'the impostor funding was not refused permanently');
  check(Number(impostorReason) === 1, 'the impostor funding was refused for the wrong reason');

  deal = await deals.getFunction('getDeal')(dealId);
  check(deal.fundedAmount === FUNDING, 'the refused funding changed the funded amount');

  // -- 6 and 7. repayment ---------------------------------------------------
  log('');
  log('=== 6. B repays the face value on Sepolia');
  await ensureAllowance(tokenAsBorrower, borrower.address, gatewayAddress, FACE_VALUE, usdc);
  const repayRc = await send(
    gatewayAsBorrower.getFunction('repay')(dealId, investor.address, FACE_VALUE),
    'repay',
    'sepolia',
  );
  log(`    ${usdc(FACE_VALUE)} from B to A in block ${repayRc.blockNumber}`);
  log(`    https://sepolia.etherscan.io/tx/${repayRc.hash}`);
  if (BigInt(repayRc.blockNumber) > dueBlock) {
    log(`    NOTE: the repayment landed at ${repayRc.blockNumber}, past the deadline ${dueBlock}. It counts as late.`);
  }

  log('');
  log('=== 7. proving and applying the repayment');
  await waitForAttestation(prover, repayRc.blockNumber);
  const repayIds = await proveAndApply(deals, dealsIface, prover, repayRc.hash, 'submitAndApply (repayment)');
  check(repayIds.length === 1, `the repayment transaction produced ${repayIds.length} facts, expected 1`);

  deal = await deals.getFunction('getDeal')(dealId);
  const outcome = Number(await credit.getFunction('outcomeOf')(dealId));
  const scoreAfter = Number(await credit.getFunction('scoreOf')(borrower.address));
  const recomputed = Number(await credit.getFunction('scoreFromOutcomes')(borrower.address));
  const limitAfter = (await credit.getFunction('limitOf')(borrower.address)) as bigint;
  const exposureAfter = (await credit.getFunction('exposureOf')(borrower.address)) as bigint;
  const outstanding = (await deals.getFunction('outstandingOf')(dealId)) as bigint;
  const record = await credit.getFunction('recordOf')(dealId);

  const expectOnTime = BigInt(repayRc.blockNumber) <= dueBlock;
  log('');
  log(`    status   ${STATUS[Number(deal.status)]}`);
  log(`    outcome  ${OUTCOME[outcome]}, closed at attested source height ${record.closedAtBlock}`);
  log(`    repaid   ${usdc(deal.repaidAmount)}, of it on time ${usdc(deal.onTimeRepaid)}`);
  log(`    outstanding ${usdc(outstanding)}, exposure ${usdc(exposureAfter)}`);
  log(`    score    ${scoreBefore} -> ${scoreAfter}`);
  log(`    limit    ${usdc(limitBefore)} -> ${usdc(limitAfter)}`);

  check(Number(deal.status) === (expectOnTime ? 5 : 4), `deal closed as ${STATUS[Number(deal.status)]}`);
  check(outcome === (expectOnTime ? 1 : 2), `credit outcome is ${OUTCOME[outcome]}`);
  check(outstanding === 0n, 'the deal still shows outstanding debt after full repayment');
  check(exposureAfter === 0n, 'exposure was not released by the closing repayment');
  check(scoreAfter === recomputed, 'the cached score disagrees with a recomputation from the canonical outcomes');
  check(scoreAfter === scoreBefore + (expectOnTime ? 25 : -50), 'the score did not move by the outcome weight');
  check(limitAfter > limitBefore || !expectOnTime, 'the limit did not grow with the score');

  // -- report ---------------------------------------------------------------
  log('');
  log('gas measured on the live path:');
  for (const entry of gasTable) {
    const roots = entry.continuityRoots === undefined ? '' : `, ${entry.continuityRoots} continuity roots`;
    log(`  ${entry.step.padEnd(34)} ${entry.gasUsed.padStart(9)} on ${entry.chain}${roots}`);
  }

  mkdirSync(OUT_DIR, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${OUT_DIR}/deal-${stamp}.json`;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        chainKey,
        gateway: gatewayAddress,
        deals: dealsAddress,
        credit: creditAddress,
        borrower: borrower.address,
        investor: investor.address,
        dealId,
        dueBlock: dueBlock.toString(),
        requiredFunding: FUNDING.toString(),
        faceValue: FACE_VALUE.toString(),
        fundTx: fundRc.hash,
        impostorTx: impostorRc.hash,
        repayTx: repayRc.hash,
        finalStatus: STATUS[Number(deal.status)],
        outcome: OUTCOME[outcome],
        closedAtSourceHeight: Number(record.closedAtBlock),
        scoreBefore,
        scoreAfter,
        limitBefore: limitBefore.toString(),
        limitAfter: limitAfter.toString(),
        gas: gasTable,
        problems,
      },
      null,
      2,
    )}\n`,
  );
  log(`run recorded in ${path}`);

  log('');
  if (problems.length > 0) {
    throw new Error(`${problems.length} mismatch(es) on the live path; see above`);
  }
  log('the full path held on live testnets: created, financed, repaid, closed, scored');
}

/** Builds a fresh proof and drives the one-transaction path. */
async function proveAndApply(
  deals: Contract,
  iface: Interface,
  prover: ProofBuilderClient,
  txHash: string,
  step: string,
): Promise<string[]> {
  const proof = await prover.getProof(txHash, 5);
  log(`    proving ${txHash.slice(0, 12)}...: height ${proof.headerNumber}, ${proof.continuityProof.roots.length} continuity roots`);
  const args = [
    proof.headerNumber,
    proof.txBytes,
    merkleTuple(proof.merkleProof),
    continuityTuple(proof.continuityProof),
  ];

  // Dry run first, so a failure reports a revert reason instead of a burnt
  // transaction and a receipt with status zero.
  const ids = (await deals.getFunction('submitAndApply').staticCall(...args)) as string[];

  const tx = await deals.getFunction('submitAndApply')(...args);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${step} reverted: ${tx.hash}`);
  gasTable.push({
    step,
    chain: 'creditcoin',
    tx: tx.hash,
    gasUsed: receipt.gasUsed.toString(),
    continuityRoots: proof.continuityProof.roots.length,
  });
  log(`    ${step}: ${tx.hash}, gas ${receipt.gasUsed}`);

  for (const event of parseEvents(iface, receipt, await deals.getAddress())) {
    log(`      ${event.name}`);
  }
  return ids;
}

function parseEvents(iface: Interface, receipt: any, address: string): {name: string; args: any}[] {
  const out: {name: string; args: any}[] = [];
  for (const entry of receipt.logs ?? []) {
    if (entry.address.toLowerCase() !== address.toLowerCase()) continue;
    const parsed = iface.parseLog({topics: entry.topics, data: entry.data});
    if (parsed) out.push({name: parsed.name, args: parsed.args});
  }
  return out;
}

async function requireBalances(
  token: Contract,
  investor: string,
  borrower: string,
  decimals: number,
): Promise<void> {
  const [held, borrowerHeld] = (await Promise.all([
    token.getFunction('balanceOf')(investor),
    token.getFunction('balanceOf')(borrower),
  ])) as [bigint, bigint];
  const need = FACE_VALUE - FUNDING + IMPOSTOR_AMOUNT;
  log(`A holds ${formatUnits(held, decimals)} USDC, needs ${formatUnits(FUNDING, decimals)}`);
  log(`B holds ${formatUnits(borrowerHeld, decimals)} USDC, needs ${formatUnits(need, decimals)} of its own`);
  if (held < FUNDING) throw new Error(`A holds ${formatUnits(held, decimals)} USDC, needs ${formatUnits(FUNDING, decimals)}`);
  if (borrowerHeld < need) {
    throw new Error(
      `B holds ${formatUnits(borrowerHeld, decimals)} USDC and needs ${formatUnits(need, decimals)}: ` +
        'the margin between funding and face value is the only new money this run consumes.',
    );
  }
}

/**
 * The borrower creates the deal, so the borrower pays Creditcoin gas for it.
 * A holds the CTC, and a top-up between the operator's own two testnet wallets
 * is cheaper than a faucet round trip in the middle of a demo.
 */
async function ensureBorrowerGas(
  provider: ReturnType<typeof evmProvider>,
  wallets: {deployer: any; borrower: any},
): Promise<void> {
  const held = await provider.getBalance(wallets.borrower.address);
  if (held >= MIN_BORROWER_CTC) {
    log(`B holds ${formatEther(held)} CTC, enough to create a deal`);
    return;
  }
  log(`B holds ${formatEther(held)} CTC, topping up with ${formatEther(BORROWER_TOP_UP)} from A`);
  const tx = await wallets.deployer.sendTransaction({to: wallets.borrower.address, value: BORROWER_TOP_UP});
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`top-up transfer failed: ${tx.hash}`);
  log(`  sent in ${tx.hash}`);
}

async function ensureAllowance(
  token: Contract,
  owner: string,
  spender: string,
  amount: bigint,
  usdc: (v: bigint) => string,
): Promise<void> {
  const current = (await token.getFunction('allowance')(owner, spender)) as bigint;
  if (current >= amount) return;
  log(`    approving the gateway for ${usdc(amount)}`);
  const tx = await token.getFunction('approve')(spender, amount);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`approve failed: ${tx.hash}`);
  const confirmed = (await token.getFunction('allowance')(owner, spender)) as bigint;
  if (confirmed < amount) throw new Error(`allowance is ${confirmed} after a confirmed approve, expected ${amount}`);
}

async function send(
  pending: Promise<any>,
  step: string,
  chain: 'sepolia' | 'creditcoin',
): Promise<{hash: string; blockNumber: number}> {
  const tx = await pending;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${step} failed: ${tx.hash}`);
  gasTable.push({step, chain, tx: tx.hash, gasUsed: receipt.gasUsed.toString()});
  return {hash: tx.hash, blockNumber: receipt.blockNumber};
}

/**
 * Polls the proof builder rather than the chain: the builder's cache trails the
 * on-chain attestation by up to ten blocks, and it is the builder that has to be
 * able to answer.
 */
async function waitForAttestation(prover: ProofBuilderClient, height: number): Promise<void> {
  const started = Date.now();
  const timeoutMs = 45 * 60_000;
  for (;;) {
    const attested = await prover.attestedHeight().catch(() => -1);
    if (attested >= height) {
      log(`    attested height ${attested} covers block ${height}`);
      return;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    log(`    waiting: attested ${attested} of ${height}, ${height - attested} blocks to go, ${waited}s elapsed`);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Attestation did not reach block ${height} within 45 minutes. The payments are on chain; rerun to prove them.`);
    }
    await sleep(30_000);
  }
}

main().catch((error) => {
  console.error(`[deal] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
