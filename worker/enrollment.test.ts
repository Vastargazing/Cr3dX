import assert from 'node:assert/strict';
import test from 'node:test';
import {enrollDeal} from './enrollment.js';
import {WORKER_SCHEMA_VERSION, type WorkerState} from './types.js';

const dealId = `0x${'11'.repeat(32)}`;

test('coverage 38: ordinary enrollment begins at canonical head plus one and retroactivity is explicit and audited', () => {
  const state = fixture();
  assert.equal(enrollDeal({state, dealId, observedSourceHead: 100, now: new Date(0)}).effectiveFromSourceBlock, 101);
  const retro = enrollDeal({state, dealId, observedSourceHead: 120, effectiveFromSourceBlock: 80, reason: 'operator audited backfill', now: new Date(1)});
  assert.equal(retro.effectiveFromSourceBlock, 80);
  assert.deepEqual(state.enrollmentHistory.map((entry) => [entry.retroactive, entry.observedSourceHead, entry.reason]), [
    [false, 100, 'ordinary enrollment effective after observed canonical head'],
    [true, 120, 'operator audited backfill'],
  ]);
  assert.throws(() => enrollDeal({state, dealId, observedSourceHead: 120, effectiveFromSourceBlock: 79, now: new Date(2)}), /operator reason/);
});

function fixture(): WorkerState {
  return {
    schemaVersion: WORKER_SCHEMA_VERSION,
    initializedAt: new Date(0).toISOString(),
    signerAddress: `0x${'22'.repeat(20)}`,
    bootstrapLatestNonce: 0,
    enrollments: {},
    enrollmentHistory: [],
    globalAttentionReasons: [],
  };
}
