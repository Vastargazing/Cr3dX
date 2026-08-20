import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BORROWER_USDC_PER_RUN, parseLiveOptions, requiredBorrowerUsdc, runCapacity } from './s5-plan.js';

describe('S5 live plan', () => {
  it('requires an explicit state mode', () => {
    assert.throws(() => parseLiveOptions([]), /explicit mode/);
    assert.deepEqual(parseLiveOptions(['--mode', 'fresh']), {
      mode: 'fresh',
      runs: 1,
      preflightOnly: false,
      resumeDeal: null,
    });
    assert.deepEqual(parseLiveOptions(['--mode', 'continue', '--runs', '2', '--preflight-only']), {
      mode: 'continue',
      runs: 2,
      preflightOnly: true,
      resumeDeal: null,
    });
  });

  it('rejects ambiguous or invalid arguments', () => {
    assert.throws(() => parseLiveOptions(['--mode', 'other']), /fresh or continue/);
    assert.throws(() => parseLiveOptions(['--mode', 'fresh', '--runs', '0']), /positive integer/);
    assert.throws(() => parseLiveOptions(['--mode', 'fresh', '--wat']), /Unknown argument/);
    assert.throws(() => parseLiveOptions(['--mode', 'fresh', '--resume-deal', `0x${'1'.repeat(64)}`]), /only valid/);
    assert.throws(() => parseLiveOptions(['--mode', 'continue', '--resume-deal', '0x12']), /bytes32/);
  });

  it('derives consecutive-run requirements and capacity in native units', () => {
    assert.equal(BORROWER_USDC_PER_RUN, 100_000n);
    assert.equal(requiredBorrowerUsdc(2), 200_000n);
    assert.equal(runCapacity(299_999n, BORROWER_USDC_PER_RUN), 2n);
    assert.equal(runCapacity(5_250_000_000n, 1_100_000n), 4_772n);
  });
});
