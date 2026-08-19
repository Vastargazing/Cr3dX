/**
 * Tests for the live-run token arithmetic.
 *
 *   npm run test:scripts
 *
 * This is the code that decides whether a live capture is allowed to send real
 * transactions, and its interesting cases are exactly the ones that are awkward
 * to reach on a testnet: a run that stopped halfway, a run that already
 * completed, a helper left holding tokens. Reproducing those on chain costs
 * faucet cooldowns and an hour; reproducing them here costs nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diagnose,
  FACE_VALUE,
  FUNDING,
  INITIAL_USDC_B,
  MINIMUM_START,
  PARTIAL_A,
  PARTIAL_B,
  projectUsdc,
  validateLiveUsdcPlan,
  type UsdcState,
} from './live-plan.js';

const DOUBLE = PARTIAL_A + PARTIAL_B;

describe('projectUsdc', () => {
  it('carries the whole run from the documented minimum funding', () => {
    const projection = validateLiveUsdcPlan();
    assert.equal(projection.ok, true);
    assert.equal(projection.firstShortfall, null);
    // start, fund, repay, supply helper, helper pays B
    assert.equal(projection.rows.length, 5);
  });

  it('conserves the total across every step', () => {
    const projection = projectUsdc(MINIMUM_START);
    const total = (s: UsdcState): bigint => s.a + s.b + s.helper;
    const expected = total(MINIMUM_START);
    for (const row of projection.rows) {
      assert.equal(total(row.state), expected, `total changed at "${row.label}"`);
    }
  });

  it('ends with A holding the margin and B holding the double funding', () => {
    const projection = projectUsdc(MINIMUM_START);
    const final = projection.rows[projection.rows.length - 1]!.state;
    assert.equal(final.a, FACE_VALUE - DOUBLE);
    assert.equal(final.b, FUNDING);
    assert.equal(final.helper, 0n, 'the helper must never keep anything');
  });

  it('routes the double funding through the helper rather than straight to B', () => {
    const projection = projectUsdc(MINIMUM_START);
    const supplyHelper = projection.rows.find((r) => r.label.includes('supplies the helper'))!;
    assert.equal(supplyHelper.state.helper, DOUBLE, 'the helper holds the tokens between the two movements');
  });

  it('stops at the first movement it cannot cover, and projects no further', () => {
    const projection = projectUsdc({ a: FUNDING, b: 0n, helper: 0n });
    assert.equal(projection.ok, false);
    assert.equal(projection.firstShortfall?.label, 'repay: B pays A');
    // start, fund, the failing repay. Nothing beyond it: later rows would be
    // fiction built on a movement that did not happen.
    assert.equal(projection.rows.length, 3);
    assert.equal(projection.firstShortfall?.missing, FACE_VALUE - FUNDING);
  });
});

describe('diagnose', () => {
  it('accepts the documented minimum funding', () => {
    const d = diagnose(MINIMUM_START);
    assert.equal(d.verdict, 'ready');
    assert.equal(d.stage, 'a clean start');
    assert.deepEqual(d.actions, []);
  });

  it('accepts an over-funded start', () => {
    const d = diagnose({ a: 10_000_000n, b: 10_000_000n, helper: 0n });
    assert.equal(d.verdict, 'ready');
  });

  it('sends empty wallets to the faucet', () => {
    const d = diagnose({ a: 0n, b: 0n, helper: 0n });
    assert.equal(d.verdict, 'underfunded');
    assert.match(d.actions.join(' '), /faucet .* to wallet A/);
  });

  it('asks to top up B when only A was funded, without calling it a partial run', () => {
    const d = diagnose({ a: 10_000_000n, b: 0n, helper: 0n });
    assert.equal(d.verdict, 'underfunded', 'a one-sided faucet is not a partial run');
    assert.equal(d.projection.firstShortfall?.label, 'repay: B pays A');
    // A has plenty, so moving is offered ahead of spending a faucet cooldown.
    assert.match(d.actions[0]!, /move .* from wallet A to wallet B/);
  });

  it('recognises the state a run leaves when it stopped after fund', () => {
    const d = diagnose({ a: 0n, b: FACE_VALUE, helper: 0n });
    assert.equal(d.verdict, 'skewed');
    assert.equal(d.stage, 'the fund transaction, before repay');
    assert.match(d.summary, /partially executed run/);
    assert.match(d.actions[0]!, /move 1\.0 USDC from wallet B to wallet A/);
  });

  it('recognises the state a run leaves when it stopped after repay', () => {
    const d = diagnose({ a: FACE_VALUE, b: 0n, helper: 0n });
    assert.equal(d.verdict, 'skewed');
    assert.equal(d.stage, 'the repay transaction, before the double funding');
    assert.equal(d.projection.firstShortfall?.label, 'repay: B pays A');
  });

  it('recognises a completed run and refuses to start another on top of it', () => {
    const d = diagnose({ a: FACE_VALUE - DOUBLE, b: FUNDING, helper: 0n });
    assert.equal(d.verdict, 'skewed');
    assert.equal(d.stage, 'a completed run');
    assert.match(d.actions[0]!, /move .* from wallet B to wallet A/);
  });

  it('flags a helper left holding tokens whatever else is true', () => {
    const d = diagnose({ a: 0n, b: 0n, helper: DOUBLE });
    assert.equal(d.verdict, 'skewed', 'a helper balance is only ever the debris of a failed run');
    assert.match(d.actions.join(' '), /fixture helper is holding/);
  });

  it('never advises fauceting the helper', () => {
    for (const state of [
      { a: 0n, b: 0n, helper: 0n },
      { a: 0n, b: FACE_VALUE, helper: 0n },
      { a: FUNDING, b: 0n, helper: 0n },
    ] satisfies UsdcState[]) {
      const d = diagnose(state);
      assert.doesNotMatch(d.actions.join(' '), /faucet .* to the fixture helper/);
    }
  });

  it('reports a total that matches the balances it was given', () => {
    const d = diagnose({ a: FUNDING, b: INITIAL_USDC_B, helper: 0n });
    assert.equal(d.totalHeld, FUNDING + INITIAL_USDC_B);
  });
});

describe('funding advice completeness', () => {
  it('names every empty wallet in one pass, so one faucet visit is enough', () => {
    const d = diagnose({ a: 0n, b: 0n, helper: 0n });
    const joined = d.actions.join(' ');
    assert.match(joined, /faucet 1\.0 USDC to wallet A/);
    assert.match(joined, /faucet 0\.1 USDC to wallet B/, 'B must be named even though the run stops at A');
  });

  it('does not ask for a faucet top-up that is already sitting in the other wallet', () => {
    const d = diagnose({ a: 0n, b: 5_000_000n, helper: 0n });
    assert.equal(d.verdict, 'underfunded');
    assert.match(d.actions[0]!, /move 1\.0 USDC from wallet B to wallet A/);
  });
});
