import assert from 'node:assert/strict';
import test from 'node:test';
import {Interface} from 'ethers';
import {
  REFRESHABLE_CONTINUITY_ERROR,
  aggregateTask,
  assertResourcePolicy,
  classifySimulation,
  newEpoch,
  reconcileSeen,
  retryDelayMs,
} from './policy.js';
import {WORKER_SCHEMA_VERSION, type EvidenceAutomationState, type WorkerTask} from './types.js';

const ERRORS = new Interface([
  'error EvidenceAlreadyRecorded(bytes32)',
  'error SourceTransactionFailed(uint64,uint64)',
  'error NoRelevantEvidence()',
  'error MalformedGatewayLog(uint64,uint64)',
  'error UnknownEvidence(bytes32)',
  'error Error(string)',
  'error SomethingFuture(uint256)',
]);

test('coverage 16: pre-sign simulation uses a closed exact allowlist', () => {
  const id = `0x${'11'.repeat(32)}`;
  const cases: Array<[string | undefined, ReturnType<typeof classifySimulation>]> = [
    [undefined, 'SUCCESS'],
    [ERRORS.encodeErrorResult('EvidenceAlreadyRecorded', [id]), 'ALREADY_RECORDED'],
    [ERRORS.encodeErrorResult('SourceTransactionFailed', [1, 2]), 'SOURCE_INCONSISTENCY'],
    [ERRORS.encodeErrorResult('NoRelevantEvidence', []), 'DECODER_INCONSISTENCY'],
    [ERRORS.encodeErrorResult('MalformedGatewayLog', [1, 2]), 'DECODER_INCONSISTENCY'],
    [ERRORS.encodeErrorResult('UnknownEvidence', [id]), 'UNKNOWN_EVIDENCE'],
    [ERRORS.encodeErrorResult('Error', [REFRESHABLE_CONTINUITY_ERROR]), 'REFRESH_PROOF'],
    [ERRORS.encodeErrorResult('Error', [`prefix ${REFRESHABLE_CONTINUITY_ERROR}`]), 'FAIL_CLOSED'],
    [ERRORS.encodeErrorResult('SomethingFuture', [1]), 'FAIL_CLOSED'],
    ['0x1234', 'FAIL_CLOSED'],
  ];
  for (const [data, expected] of cases) assert.equal(classifySimulation(data), expected);
});

test('coverage 32: expected evidence visibility is atomic', () => {
  assert.equal(reconcileSeen([false, false]), 'ALL_FALSE');
  assert.equal(reconcileSeen([true, true]), 'ALL_TRUE');
  assert.equal(reconcileSeen([true, false]), 'MIXED');
  assert.equal(reconcileSeen([]), 'MIXED');
});

test('coverage 22 and 34: retry epochs are independent, bounded and deterministically jittered', () => {
  const submission = newEpoch(0);
  const application = newEpoch(10 * 24 * 60 * 60 * 1_000);
  assert.equal(Date.parse(submission.deadlineAt) - Date.parse(submission.startedAt), 6 * 60 * 60 * 1_000);
  assert.equal(Date.parse(application.deadlineAt) - Date.parse(application.startedAt), 6 * 60 * 60 * 1_000);
  const delays = [0, 1, 2, 3, 4, 5, 6].map((retryIndex) => retryDelayMs({...submission, retryIndex}, 0, () => 0.5));
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  assert.equal(retryDelayMs({...submission, retryIndex: 99}, Date.parse(submission.deadlineAt) - 123, () => 1), 123);
  assert.equal(retryDelayMs(submission, Date.parse(submission.deadlineAt), () => 0.5), 0);
});

test('coverage 38 and 43: final gas, maximum liability, rolling budget and reserve are all enforced', () => {
  const limits = {
    maxNonTerminalTasks: 1_000,
    maxEventsPerTransaction: 32,
    transactionGasCap: 100n,
    maxFeePerGasCap: 10n,
    rolling24HourFeeBudget: 1_000n,
    minimumSignerBalanceReserve: 50n,
  };
  assert.equal(assertResourcePolicy({limits, estimatedGas: 80n, finalGasLimit: 90n, finalPrice: 10n, signerBalance: 950n, rollingActualFees: 0n, unresolvedReservations: 0n}), 900n);
  assert.throws(() => assertResourcePolicy({limits, estimatedGas: 101n, finalGasLimit: 90n, finalPrice: 1n, signerBalance: 1_000n, rollingActualFees: 0n, unresolvedReservations: 0n}), /GAS_CAP/);
  assert.throws(() => assertResourcePolicy({limits, estimatedGas: 80n, finalGasLimit: 101n, finalPrice: 1n, signerBalance: 1_000n, rollingActualFees: 0n, unresolvedReservations: 0n}), /GAS_CAP/);
  assert.throws(() => assertResourcePolicy({limits, estimatedGas: 80n, finalGasLimit: 90n, finalPrice: 11n, signerBalance: 2_000n, rollingActualFees: 0n, unresolvedReservations: 0n}), /FEE_CAP/);
  assert.throws(() => assertResourcePolicy({limits, estimatedGas: 80n, finalGasLimit: 90n, finalPrice: 10n, signerBalance: 2_000n, rollingActualFees: 101n, unresolvedReservations: 0n}), /ROLLING_BUDGET/);
  assert.throws(() => assertResourcePolicy({limits, estimatedGas: 80n, finalGasLimit: 90n, finalPrice: 10n, signerBalance: 949n, rollingActualFees: 0n, unresolvedReservations: 0n}), /BALANCE_RESERVE/);
});

test('coverage 31 and 44: aggregate precedence preserves mixed outcomes and lane is an overlay', () => {
  const task = aggregateFixture(['APPLIED', 'VERIFIED_PENDING', 'REJECTED_PERMANENT']);
  assert.equal(aggregateTask(task).state, 'VERIFIED_PENDING');
  assert.deepEqual(aggregateTask(task).counts, {
    UNSEEN: 0,
    VERIFIED_PENDING: 1,
    READY_TO_APPLY: 0,
    APPLICATION_IN_FLIGHT: 0,
    APPLIED: 1,
    REJECTED_PERMANENT: 1,
    ATTENTION_REQUIRED: 0,
  });
  task.inFlight = {
    purpose: {kind: 'SUBMISSION', evidenceIds: [], sourceBlockHash: `0x${'10'.repeat(32)}`}, transactionHash: `0x${'aa'.repeat(32)}`, rawTransaction: '0x01', nonce: 7,
    chainId: 1, destination: `0x${'12'.repeat(20)}`, maximumLiability: '1', createdAt: new Date(0).toISOString(), broadcastCount: 0,
  };
  assert.equal(aggregateTask(task).state, 'WAITING_RECEIPT');
  assert.deepEqual(task.logical.currentInclusion!.events.map((event) => event.automationState), ['APPLIED', 'VERIFIED_PENDING', 'REJECTED_PERMANENT']);
});

function aggregateFixture(states: EvidenceAutomationState[]): WorkerTask {
  const hash = `0x${'10'.repeat(32)}` as const;
  return {
    schemaVersion: WORKER_SCHEMA_VERSION,
    taskId: '1'.repeat(64),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    logical: {
      sourceChainId: 1,
      transactionHash: hash,
      sourceSubmissionState: 'SUBMITTED',
      currentInclusion: {
        sourceBlockNumber: 1, sourceBlockHash: hash, transactionIndex: 0, receiptStatus: 1, observedAt: new Date(0).toISOString(),
        events: states.map((state, index) => ({
          sourceChainId: 1, transactionHash: hash, sourceBlockNumber: 1, sourceBlockHash: hash, transactionIndex: 0,
          transactionLogOrdinal: index, rpcLogIndex: index, emitter: `0x${'12'.repeat(20)}`, kind: 'FUNDING', dealId: hash,
          counterparty: `0x${'13'.repeat(20)}`, recipient: `0x${'14'.repeat(20)}`, amount: '1', eventNonce: String(index),
          identity: String(index), expectedEvidenceId: `0x${String(index + 1).padStart(64, '0')}`, inclusionState: 'CURRENT',
          contractState: state === 'READY_TO_APPLY' || state === 'APPLICATION_IN_FLIGHT' || state === 'VERIFIED_PENDING' ? 'VERIFIED_PENDING' : state as never,
          automationState: state, rejectionReason: 'NONE', applicationAttemptCount: 0, firstObservedAt: new Date(0).toISOString(), transitions: [],
        })),
      },
      inclusionHistory: [], submissionAttemptCount: 0, transitions: [], operationHistory: [],
    },
  };
}
