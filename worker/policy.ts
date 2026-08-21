import { Interface } from 'ethers';
import {
  SIX_HOURS_MS,
  type AggregateTaskView,
  type AttemptEpoch,
  type ContractEvidenceState,
  type EvidenceAutomationState,
  type InFlightEnvelope,
  type WorkerLimits,
  type WorkerTask,
} from './types.js';

const VERIFIER_ERRORS = new Interface([
  'error EvidenceAlreadyRecorded(bytes32 evidenceId)',
  'error SourceTransactionFailed(uint64 height,uint64 txIndex)',
  'error NoRelevantEvidence()',
  'error MalformedGatewayLog(uint64 height,uint64 txIndex)',
]);
const DEAL_ERRORS = new Interface(['error UnknownEvidence(bytes32 evidenceId)']);
const ERROR_STRING = new Interface(['error Error(string reason)']);
export const REFRESHABLE_CONTINUITY_ERROR = 'Continuity proof does not match attestation or checkpoint';

export type SimulationClass =
  | 'SUCCESS'
  | 'ALREADY_RECORDED'
  | 'REFRESH_PROOF'
  | 'SOURCE_INCONSISTENCY'
  | 'DECODER_INCONSISTENCY'
  | 'UNKNOWN_EVIDENCE'
  | 'FAIL_CLOSED';

export function classifySimulation(revertData?: string): SimulationClass {
  if (!revertData) return 'SUCCESS';
  for (const iface of [VERIFIER_ERRORS, DEAL_ERRORS, ERROR_STRING]) {
    try {
      const parsed = iface.parseError(revertData);
      if (!parsed) continue;
      if (parsed.name === 'EvidenceAlreadyRecorded') return 'ALREADY_RECORDED';
      if (parsed.name === 'SourceTransactionFailed') return 'SOURCE_INCONSISTENCY';
      if (parsed.name === 'NoRelevantEvidence' || parsed.name === 'MalformedGatewayLog') {
        return 'DECODER_INCONSISTENCY';
      }
      if (parsed.name === 'UnknownEvidence') return 'UNKNOWN_EVIDENCE';
      if (parsed.name === 'Error' && parsed.args[0] === REFRESHABLE_CONTINUITY_ERROR) return 'REFRESH_PROOF';
      return 'FAIL_CLOSED';
    } catch {
      // Try the next closed ABI. Malformed/unknown data fails closed below.
    }
  }
  return 'FAIL_CLOSED';
}

export function reconcileSeen(values: readonly boolean[]): 'ALL_FALSE' | 'ALL_TRUE' | 'MIXED' {
  if (values.length === 0) return 'MIXED';
  if (values.every(Boolean)) return 'ALL_TRUE';
  if (values.every((value) => !value)) return 'ALL_FALSE';
  return 'MIXED';
}

export function automationFromContract(state: ContractEvidenceState): EvidenceAutomationState {
  return state;
}

const AUTOMATION_STATES: EvidenceAutomationState[] = [
  'UNSEEN',
  'VERIFIED_PENDING',
  'READY_TO_APPLY',
  'APPLICATION_IN_FLIGHT',
  'APPLIED',
  'REJECTED_PERMANENT',
  'ATTENTION_REQUIRED',
];

export function aggregateTask(task: WorkerTask): AggregateTaskView {
  const current = task.logical.currentInclusion?.events.filter((event) => event.inclusionState === 'CURRENT') ?? [];
  const counts = Object.fromEntries(AUTOMATION_STATES.map((state) => [state, 0])) as Record<
    EvidenceAutomationState,
    number
  >;
  for (const event of current) counts[event.automationState] += 1;

  let state: AggregateTaskView['state'];
  if (task.logical.sourceSubmissionState === 'FAILED' || task.logical.failedReason) state = 'FAILED';
  else if (
    task.logical.sourceSubmissionState === 'ATTENTION_REQUIRED' ||
    current.some((event) => event.automationState === 'ATTENTION_REQUIRED')
  ) {
    state = 'ATTENTION_REQUIRED';
  } else if (task.inFlight) state = 'WAITING_RECEIPT';
  else if (!task.logical.currentInclusion || task.logical.sourceSubmissionState === 'ORPHANED') state = 'ORPHANED';
  else if (current.some((event) => event.contractState === 'UNSEEN')) state = task.logical.sourceSubmissionState;
  else if (current.some((event) => event.automationState === 'READY_TO_APPLY')) state = 'READY_TO_APPLY';
  else if (current.some((event) => event.automationState === 'VERIFIED_PENDING')) state = 'VERIFIED_PENDING';
  else if (current.length > 0 && current.every((event) => isTerminal(event.automationState))) {
    state = current.some((event) => event.automationState === 'REJECTED_PERMANENT')
      ? 'COMPLETED_WITH_REJECTIONS'
      : 'COMPLETED';
  } else state = task.logical.sourceSubmissionState;
  return {state, counts};
}

export function isTerminal(state: EvidenceAutomationState): boolean {
  return state === 'APPLIED' || state === 'REJECTED_PERMANENT';
}

export function newEpoch(nowMs: number, resumedByOperator = false): AttemptEpoch {
  return {
    startedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + SIX_HOURS_MS).toISOString(),
    retryIndex: 0,
    resumedByOperator,
  };
}

export function retryDelayMs(epoch: AttemptEpoch, nowMs: number, random: () => number): number {
  const remaining = Date.parse(epoch.deadlineAt) - nowMs;
  if (remaining <= 0) return 0;
  const base = Math.min(5_000 * 2 ** epoch.retryIndex, 300_000);
  const jitter = 0.9 + Math.min(1, Math.max(0, random())) * 0.2;
  return Math.min(Math.floor(base * jitter), remaining);
}

export function maximumLiability(gasLimit: bigint, price: bigint): bigint {
  return gasLimit * price;
}

export function actualFee(gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  return gasUsed * effectiveGasPrice;
}

export function assertResourcePolicy(input: {
  limits: WorkerLimits;
  estimatedGas: bigint;
  finalGasLimit: bigint;
  finalPrice: bigint;
  signerBalance: bigint;
  rollingActualFees: bigint;
  unresolvedReservations: bigint;
}): bigint {
  const {limits, estimatedGas, finalGasLimit, finalPrice, signerBalance, rollingActualFees, unresolvedReservations} = input;
  if (estimatedGas > limits.transactionGasCap || finalGasLimit > limits.transactionGasCap) {
    throw new Error('GAS_CAP_EXCEEDED');
  }
  if (finalPrice > limits.maxFeePerGasCap) throw new Error('FEE_CAP_EXCEEDED');
  const liability = maximumLiability(finalGasLimit, finalPrice);
  if (rollingActualFees + unresolvedReservations + liability > limits.rolling24HourFeeBudget) {
    throw new Error('ROLLING_BUDGET_EXCEEDED');
  }
  if (signerBalance < liability + limits.minimumSignerBalanceReserve) throw new Error('BALANCE_RESERVE_EXCEEDED');
  return liability;
}

export function unresolvedReservation(envelopes: readonly InFlightEnvelope[]): bigint {
  return envelopes.reduce((sum, envelope) => sum + BigInt(envelope.maximumLiability), 0n);
}

export function isNonTerminalTask(task: WorkerTask): boolean {
  const state = aggregateTask(task).state;
  return !['COMPLETED', 'COMPLETED_WITH_REJECTIONS', 'ORPHANED'].includes(state);
}
