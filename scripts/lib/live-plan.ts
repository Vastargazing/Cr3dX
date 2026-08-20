/**
 * The token arithmetic of the live gate capture, in Circle test USDC base units.
 *
 * The run is a chain, not a set of independent transfers: A pays B, B pays A
 * back, and A then reuses what it received to drive the double-funding fixture.
 * Only the 0.1 USDC margin between funding and face value is ever new money.
 * That is why the whole run can be faucet-funded with 1.1 USDC total, and also
 * why a run that stops halfway leaves the tokens sitting on the wrong account.
 */
import { formatUnits } from 'ethers';

export const FUNDING = 1_000_000n;
export const FACE_VALUE = 1_100_000n;
export const PARTIAL_A = 400_000n;
export const PARTIAL_B = 600_000n;

/** Balances the ordered run needs before it starts. */
export const INITIAL_USDC_A = FUNDING;
export const INITIAL_USDC_B = FACE_VALUE - FUNDING;

/** Total token supply the run moves around. It never changes during the run. */
export const MINIMUM_TOTAL = INITIAL_USDC_A + INITIAL_USDC_B;

/** Where the three USDC-holding accounts stand at some point in the run. */
export interface UsdcState {
  a: bigint;
  b: bigint;
  helper: bigint;
}

export const MINIMUM_START: UsdcState = {a: INITIAL_USDC_A, b: INITIAL_USDC_B, helper: 0n};

type Holder = keyof UsdcState;

/** Human names for the three holders, used in every remedy message. */
const NAMES: Record<Holder, string> = {
  a: 'wallet A',
  b: 'wallet B',
  helper: 'the fixture helper',
};

interface Movement {
  label: string;
  from: Holder;
  to: Holder;
  amount: bigint;
}

/**
 * Every token movement the run makes, in order, including the hop through the
 * fixture helper.
 *
 * The helper is listed separately rather than folded into a single A to B
 * transfer because it holds the tokens for part of one transaction, and a run
 * that fails there leaves them somewhere a two-column model cannot show.
 */
export const LIVE_MOVEMENTS: Movement[] = [
  {label: 'fund: A pays B', from: 'a', to: 'b', amount: FUNDING},
  {label: 'repay: B pays A', from: 'b', to: 'a', amount: FACE_VALUE},
  {label: 'double funding: A supplies the helper', from: 'a', to: 'helper', amount: PARTIAL_A + PARTIAL_B},
  {label: 'double funding: helper pays B twice', from: 'helper', to: 'b', amount: PARTIAL_A + PARTIAL_B},
];

export interface ProjectionRow {
  label: string;
  state: UsdcState;
  /** False when the holder could not cover this movement from the previous row. */
  affordable: boolean;
  /** How much was missing, when it was not affordable. */
  missing: bigint;
  holder: Holder | null;
}

export interface Projection {
  rows: ProjectionRow[];
  ok: boolean;
  /** First movement that could not be covered, if any. */
  firstShortfall: ProjectionRow | null;
}

/**
 * Walks the run forward from a given starting point and reports where, if
 * anywhere, it would run out.
 *
 * Deliberately takes the starting balances as an argument instead of assuming
 * the minimum: run against on-chain balances it says what will actually happen,
 * run against the minimum it checks that the constants above are coherent.
 */
export function projectUsdc(start: UsdcState): Projection {
  const rows: ProjectionRow[] = [
    {label: 'start', state: {...start}, affordable: true, missing: 0n, holder: null},
  ];
  const current: UsdcState = {...start};
  let ok = true;
  let firstShortfall: ProjectionRow | null = null;

  for (const movement of LIVE_MOVEMENTS) {
    const held = current[movement.from];
    const affordable = held >= movement.amount;
    const missing = affordable ? 0n : movement.amount - held;

    if (affordable) {
      current[movement.from] = held - movement.amount;
      current[movement.to] += movement.amount;
    }

    const row: ProjectionRow = {
      label: movement.label,
      state: {...current},
      affordable,
      missing,
      holder: movement.from,
    };
    rows.push(row);

    if (!affordable) {
      ok = false;
      if (!firstShortfall) firstShortfall = row;
      // Stop projecting: every later row would be fiction built on a movement
      // that did not happen.
      break;
    }
  }

  return {rows, ok, firstShortfall};
}

export type Verdict = 'ready' | 'underfunded' | 'skewed';

export interface Diagnosis {
  projection: Projection;
  verdict: Verdict;
  totalHeld: bigint;
  /** Name of the canonical stage these balances match exactly, if any. */
  stage: string | null;
  /** One line saying what is wrong and what to do about it. */
  summary: string;
  /** Concrete actions, ready to print. */
  actions: string[];
}

/**
 * States the run passes through when it is funded with exactly the minimum.
 * Matching one of them exactly is strong evidence about where a previous run
 * stopped, which is worth far more to whoever is staring at the output than a
 * generic "not enough funds".
 */
const CANONICAL_STAGES: {label: string; state: UsdcState}[] = [
  {label: 'a clean start', state: MINIMUM_START},
  {label: 'the fund transaction, before repay', state: {a: 0n, b: FACE_VALUE, helper: 0n}},
  {label: 'the repay transaction, before the double funding', state: {a: FACE_VALUE, b: 0n, helper: 0n}},
  {
    label: 'a completed run',
    state: {a: FACE_VALUE - (PARTIAL_A + PARTIAL_B), b: INITIAL_USDC_A, helper: 0n},
  },
];

/**
 * Decides whether the run can start from the balances actually on chain, and if
 * not, whether the problem is missing tokens or misplaced ones.
 *
 * The distinction matters. Both look like "A is short" to a check that only
 * asks whether each account holds enough, and the advice differs completely: one
 * calls for the faucet, the other calls for moving tokens back from B. Sending
 * someone to the faucet when the tokens are already in their other wallet wastes
 * a faucet cooldown and leaves the run just as stuck.
 */
export function diagnose(actual: UsdcState): Diagnosis {
  const projection = projectUsdc(actual);
  const totalHeld = actual.a + actual.b + actual.helper;
  const matched = CANONICAL_STAGES.find(
    (candidate) =>
      candidate.state.a === actual.a && candidate.state.b === actual.b && candidate.state.helper === actual.helper,
  );
  const stage = matched ? matched.label : null;

  if (projection.ok) {
    return {
      projection,
      verdict: 'ready',
      totalHeld,
      stage,
      summary: 'balances cover every step of the ordered run',
      actions: [],
    };
  }

  const usdc = (value: bigint): string => `${formatUnits(value, 6)} USDC`;
  const shortfall = projection.firstShortfall!;
  const holder = shortfall.holder!;
  // The state recorded on a failing row is the state *before* the movement,
  // because the movement did not happen. That is what the remedies are computed
  // against.
  const at = shortfall.state;

  const actions: string[] = [];

  // A partially executed run is worth naming as such, because the remedy is to
  // move tokens back rather than to spend a faucet cooldown. It is recognisable
  // when the balances land exactly on a state the run itself produces, or when
  // the helper is holding anything at all. Having fauceted only one of the two
  // wallets is not that, and gets ordinary funding advice.
  const partial = (stage !== null && matched !== CANONICAL_STAGES[0]) || actual.helper > 0n;

  if (partial) {
    const donor = (['a', 'b'] as Holder[]).find((who) => who !== holder && at[who] >= shortfall.missing);
    if (donor) actions.push(`move ${usdc(shortfall.missing)} from ${NAMES[donor]} to ${NAMES[holder]}`);
    if (holder !== 'helper') {
      actions.push(`${donor ? 'or faucet' : 'faucet'} ${usdc(shortfall.missing)} to ${NAMES[holder]}`);
    }
  } else {
    // Report every gap against the documented minimum, not just the first one
    // the projection tripped over. Naming one gap at a time turns a single
    // faucet visit into as many round trips as there are empty wallets.
    const minimums: Record<'a' | 'b', bigint> = {a: INITIAL_USDC_A, b: INITIAL_USDC_B};
    for (const who of ['a', 'b'] as const) {
      const missing = actual[who] >= minimums[who] ? 0n : minimums[who] - actual[who];
      if (missing === 0n) continue;
      const other = who === 'a' ? 'b' : 'a';
      const surplus = actual[other] > minimums[other] ? actual[other] - minimums[other] : 0n;
      if (surplus >= missing) actions.push(`move ${usdc(missing)} from ${NAMES[other]} to ${NAMES[who]}`);
      actions.push(`${surplus >= missing ? 'or faucet' : 'faucet'} ${usdc(missing)} to ${NAMES[who]}`);
    }
  }

  if (actual.helper > 0n) {
    actions.push(
      `the fixture helper is holding ${usdc(actual.helper)}, which it never should between runs: it forwards ` +
        'everything within one transaction, so a balance there means a run died mid-transaction',
    );
  }

  return {
    projection,
    verdict: partial ? 'skewed' : 'underfunded',
    totalHeld,
    stage,
    summary: partial
      ? `the wallets hold ${usdc(totalHeld)} between them, enough for the run, but not on the account the next ` +
        'step spends from. This is what a partially executed run leaves behind'
      : `${NAMES[holder]} cannot cover "${shortfall.label}"`,
    actions,
  };
}

/**
 * Self-check of the constants above: the minimum funding must carry the whole
 * ordered run. Fails loudly if someone edits an amount without re-deriving the
 * starting balances.
 */
export function validateLiveUsdcPlan(): Projection {
  const projection = projectUsdc(MINIMUM_START);
  if (!projection.ok) {
    const row = projection.firstShortfall!;
    throw new Error(
      `Live USDC plan is internally inconsistent: "${row.label}" is short by ${formatUnits(row.missing, 6)} USDC ` +
        'when starting from the documented minimum balances',
    );
  }
  return projection;
}

/**
 * Renders a projection as a fixed-width table.
 *
 * A movement that could not be covered gets a message instead of numbers: its
 * balances are simply the previous row's, and printing them again reads as if
 * the step happened and changed nothing.
 */
export function renderProjection(projection: Projection, decimals: number): string[] {
  const amount = (value: bigint): string => formatUnits(value, decimals).padStart(10);
  const label = (text: string): string => text.padEnd(42);
  const lines = [`${label('step')}${'A'.padStart(10)}${'B'.padStart(10)}${'helper'.padStart(10)}`];
  for (const row of projection.rows) {
    if (!row.affordable) {
      lines.push(
        `${label(row.label)}stops here: ${NAMES[row.holder!]} is short ` +
          `${formatUnits(row.missing, decimals)}`,
      );
      continue;
    }
    lines.push(`${label(row.label)}${amount(row.state.a)}${amount(row.state.b)}${amount(row.state.helper)}`);
  }
  return lines;
}

/** Conservative faucet targets covering the complete run at ordinary testnet fees. */
export const MIN_SEPOLIA_ETH_A = 20_000_000_000_000_000n; // 0.02 ETH
export const MIN_SEPOLIA_ETH_B = 5_000_000_000_000_000n; // 0.005 ETH

/**
 * Creditcoin side of the run, measured rather than guessed.
 *
 * `eth_estimateGas` puts the verifier deployment at 1,269,505 gas, and the live
 * gas price is 0.5 gwei, so deploying and submitting every fixture costs under
 * 0.001 CTC. The previous threshold here was 0.1 CTC, an unmeasured guess a
 * hundred times larger than the real cost, which would have blocked a run whose
 * faucet handed out less than that while the balance was in fact ample.
 *
 * 0.01 CTC keeps roughly ten times the measured cost in reserve, which covers a
 * base fee that moves, and is small enough that every faucet in circulation
 * dispenses at least that much in one request.
 */
export const MIN_CREDITCOIN_CTC_A = 10_000_000_000_000_000n; // 0.01 CTC

/**
 * Creditcoin gas for wallet B, which is the borrower and therefore the account
 * that calls `createDeal`.
 *
 * `createDeal` writes four cold slots in the registry and two in the credit
 * layer, which is roughly 250,000 gas, about 0.000125 CTC at the observed 0.5
 * gwei. 0.005 CTC is forty times that.
 *
 * B does not need to be fauceted for it: `npm run s5:continue` tops B up from A
 * when it is short, because A holds the CTC and a transfer between the
 * operator's own two wallets is cheaper than a faucet round trip in the middle
 * of a demo. The threshold is here so that `preflight` can say whether the
 * top-up will be needed and whether A can afford it.
 */
export const MIN_CREDITCOIN_CTC_B = 5_000_000_000_000_000n; // 0.005 CTC

/**
 * USDC that wallet B has to hold beyond the capture run, for `s5:continue`.
 *
 * The deal run pays out the face value and receives the funding, so the only
 * new money is the margin between them, plus the single native unit of the
 * impostor funding, which is a self-transfer and comes straight back.
 */
export const DEAL_RUN_USDC_B = FACE_VALUE - FUNDING + 1n;
