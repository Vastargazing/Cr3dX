export const WORKER_SCHEMA_VERSION = 1 as const;
export const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

export type Hex = `0x${string}`;
export type InclusionState = 'CURRENT' | 'SUPERSEDED' | 'ORPHANED';
export type ContractEvidenceState = 'UNSEEN' | 'VERIFIED_PENDING' | 'APPLIED' | 'REJECTED_PERMANENT';
export type EvidenceAutomationState =
  | 'UNSEEN'
  | 'VERIFIED_PENDING'
  | 'READY_TO_APPLY'
  | 'APPLICATION_IN_FLIGHT'
  | 'APPLIED'
  | 'REJECTED_PERMANENT'
  | 'ATTENTION_REQUIRED';
export type SubmissionState =
  | 'OBSERVED'
  | 'WAITING_ATTESTATION'
  | 'READY_FOR_PROOF'
  | 'SUBMITTING'
  | 'SUBMISSION_IN_FLIGHT'
  | 'SUBMITTED'
  | 'ORPHANED'
  | 'ATTENTION_REQUIRED'
  | 'FAILED';
export type EvidenceKind = 'FUNDING' | 'REPAYMENT';

export interface Transition {
  at: string;
  from: string | null;
  to: string;
  reason: string;
}

export interface AttemptEpoch {
  startedAt: string;
  deadlineAt: string;
  retryIndex: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  resumedByOperator?: boolean;
}

export interface DecodedGatewayEvent {
  sourceChainId: number;
  transactionHash: Hex;
  sourceBlockNumber: number;
  sourceBlockHash: Hex;
  transactionIndex: number;
  transactionLogOrdinal: number;
  rpcLogIndex: number;
  emitter: Hex;
  kind: EvidenceKind;
  dealId: Hex;
  counterparty: Hex;
  recipient: Hex;
  amount: string;
  eventNonce: string;
}

export interface EvidenceRecord extends DecodedGatewayEvent {
  identity: string;
  expectedEvidenceId: Hex;
  inclusionState: InclusionState;
  contractState: ContractEvidenceState;
  automationState: EvidenceAutomationState;
  rejectionReason: string;
  applicationEpoch?: AttemptEpoch;
  applicationAttemptCount: number;
  prerequisiteSnapshot?: {dealStatus: number; designatedInvestor: Hex};
  firstObservedAt: string;
  transitions: Transition[];
}

export interface InclusionSnapshot {
  sourceBlockNumber: number;
  sourceBlockHash: Hex;
  transactionIndex: number;
  receiptStatus: number;
  events: EvidenceRecord[];
  observedAt: string;
  supersededAt?: string;
  supersededReason?: string;
}

export interface ConfirmedOperation {
  purpose: InFlightPurpose;
  transactionHash: Hex;
  nonce: number;
  receiptStatus: number;
  receiptBlockNumber: number;
  receiptBlockHash: Hex;
  confirmedAt: string;
  gasUsed: string;
  effectiveGasPrice: string;
  actualFee: string;
}

export type InFlightPurpose =
  | {kind: 'SUBMISSION'; evidenceIds: Hex[]; sourceBlockHash: Hex}
  | {kind: 'APPLICATION'; evidenceId: Hex};

export interface InFlightEnvelope {
  purpose: InFlightPurpose;
  transactionHash: Hex;
  rawTransaction: Hex;
  nonce: number;
  chainId: number;
  destination: Hex;
  maximumLiability: string;
  createdAt: string;
  firstBroadcastAt?: string;
  lastBroadcastAt?: string;
  resolutionDeadlineAt?: string;
  broadcastCount: number;
  receiptBlockNumber?: number;
  receiptBlockHash?: Hex;
  receiptStatus?: number;
}

export interface LogicalTask {
  sourceChainId: number;
  transactionHash: Hex;
  sourceSubmissionState: SubmissionState;
  currentInclusion?: InclusionSnapshot;
  inclusionHistory: InclusionSnapshot[];
  submissionEpoch?: AttemptEpoch;
  submissionAttemptCount: number;
  sourceAttentionReason?: string;
  failedReason?: string;
  transitions: Transition[];
  operationHistory: ConfirmedOperation[];
}

export interface WorkerTask {
  schemaVersion: typeof WORKER_SCHEMA_VERSION;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  logical: LogicalTask;
  inFlight?: InFlightEnvelope;
}

export interface EnrollmentAuditEntry {
  at: string;
  dealId: Hex;
  effectiveFromSourceBlock: number;
  observedSourceHead: number;
  retroactive: boolean;
  reason: string;
}

export interface Enrollment {
  dealId: Hex;
  effectiveFromSourceBlock: number;
  enrolledAt: string;
}

export interface SourceCursor {
  blockNumber: number;
  blockHash?: Hex;
  updatedAt: string;
}

export interface WorkerState {
  schemaVersion: typeof WORKER_SCHEMA_VERSION;
  initializedAt: string;
  signerAddress: Hex;
  bootstrapLatestNonce: number;
  sourceCursor?: SourceCursor;
  enrollments: Record<string, Enrollment>;
  enrollmentHistory: EnrollmentAuditEntry[];
  globalAttentionReasons: string[];
  runtimeObservation?: {
    observedAt: string;
    attestationInterval: number;
    checkpointInterval: number;
    warning?: string;
  };
}

export interface WorkerLimits {
  maxNonTerminalTasks: number;
  maxEventsPerTransaction: number;
  transactionGasCap: bigint;
  maxFeePerGasCap: bigint;
  rolling24HourFeeBudget: bigint;
  minimumSignerBalanceReserve: bigint;
}

export interface WorkerConfig {
  stateDir: string;
  sourceRpcUrl: string;
  destinationRpcUrl: string;
  destinationSubstrateRpcUrl: string;
  proofBuilderUrl: string;
  sourceChainId: number;
  sourceChainKey: number;
  destinationChainId: number;
  sourceStartBlock: number;
  gatewayAddress: Hex;
  verifierAddress: Hex;
  dealsAddress: Hex;
  fundingTopic: Hex;
  repaymentTopic: Hex;
  pollIntervalMs: number;
  limits: WorkerLimits;
}

export type AggregateTaskState =
  | 'FAILED'
  | 'ATTENTION_REQUIRED'
  | 'WAITING_RECEIPT'
  | 'ORPHANED'
  | SubmissionState
  | 'READY_TO_APPLY'
  | 'VERIFIED_PENDING'
  | 'COMPLETED_WITH_REJECTIONS'
  | 'COMPLETED';

export interface AggregateTaskView {
  state: AggregateTaskState;
  counts: Record<EvidenceAutomationState, number>;
}
