import type {SingleProof} from '../scripts/lib/proofs.js';
import type {TransactionRequest} from 'ethers';
import type {
  CandidateLogRef,
  DealView,
  DestinationReceipt,
  PreparedTransaction,
  RawSourceReceipt,
} from './chain.js';
import {
  actualFee,
  aggregateTask,
  assertResourcePolicy,
  automationFromContract,
  classifySimulation,
  isNonTerminalTask,
  isTerminal,
  newEpoch,
  reconcileSeen,
  retryDelayMs,
} from './policy.js';
import {taskIdOf, StateStore} from './state.js';
import {
  SIX_HOURS_MS,
  WORKER_SCHEMA_VERSION,
  type AttemptEpoch,
  type DecodedGatewayEvent,
  type EvidenceRecord,
  type Hex,
  type InFlightPurpose,
  type Transition,
  type WorkerConfig,
  type WorkerState,
  type WorkerTask,
} from './types.js';

export interface WorkerPort {
  signerAddress(): Hex;
  sourceHead(): Promise<number>;
  candidateLogs(fromBlock: number, toBlock: number): Promise<CandidateLogRef[]>;
  sourceReceipt(transactionHash: Hex): Promise<RawSourceReceipt | null>;
  decodeGatewayEvents(receipt: RawSourceReceipt): DecodedGatewayEvent[];
  evidenceId(event: DecodedGatewayEvent): Promise<Hex>;
  seen(evidenceId: Hex): Promise<boolean>;
  evidenceState(evidenceId: Hex): Promise<{state: EvidenceRecord['contractState']; reason: string}>;
  dealView(dealId: Hex): Promise<DealView>;
  attestedHeight(): Promise<number>;
  freshProof(transactionHash: Hex): Promise<SingleProof>;
  submissionRequest(proof: SingleProof): TransactionRequest;
  applicationRequest(evidenceId: Hex): TransactionRequest;
  simulate(request: TransactionRequest): Promise<{ok: true} | {ok: false; revertData?: string}>;
  prepare(request: TransactionRequest, nonce: number): Promise<PreparedTransaction>;
  sign(request: TransactionRequest): Promise<{raw: Hex; hash: Hex}>;
  broadcast(raw: Hex): Promise<Hex>;
  destinationReceipt(hash: Hex): Promise<DestinationReceipt | null>;
  destinationHead(): Promise<number>;
  canonicalDestinationBlockHash(blockNumber: number): Promise<Hex | null>;
  destinationBlockTimestamp(blockNumber: number): Promise<number>;
  nonces(): Promise<{latest: number; pending: number}>;
  signerBalance(): Promise<bigint>;
  runtimeIntervals(): Promise<{attestationInterval: number; checkpointInterval: number}>;
  assertDeploymentConfiguration(): Promise<void>;
}

export interface EngineOptions {
  now?: () => number;
  random?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

function transition(atMs: number, from: string | null, to: string, reason: string): Transition {
  return {at: new Date(atMs).toISOString(), from, to, reason};
}

export class WorkerEngine {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(
    readonly config: WorkerConfig,
    readonly store: StateStore,
    readonly chain: WorkerPort,
    options: EngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  }

  async startupChecks(): Promise<void> {
    this.store.assertEstablished();
    this.store.unresolvedLane();
    await this.chain.assertDeploymentConfiguration();
    const state = this.store.readState();
    if (state.signerAddress.toLowerCase() !== this.chain.signerAddress().toLowerCase()) {
      throw new Error('Configured signer differs from the signer that established this state directory');
    }
    const runtime = await this.chain.runtimeIntervals();
    const warning = runtime.attestationInterval === 10 && runtime.checkpointInterval === 10
      ? undefined
      : `runtime drift: expected 10/10, observed ${runtime.attestationInterval}/${runtime.checkpointInterval}`;
    state.runtimeObservation = {observedAt: new Date(this.now()).toISOString(), ...runtime, ...(warning ? {warning} : {})};
    this.store.writeState(state);
    this.log({event: 'runtime_configuration', ...runtime, warning});
  }

  async scanOnce(): Promise<void> {
    await this.reconcileSourceCanonicality();
    const state = this.store.readState();
    if (state.globalAttentionReasons.length > 0) return;
    const head = await this.chain.sourceHead();
    let from = state.sourceCursor
      ? Math.max(this.config.sourceStartBlock, state.sourceCursor.blockNumber - 100)
      : this.config.sourceStartBlock;
    while (from <= head) {
      const to = Math.min(from + 999, head);
      const candidates = await this.chain.candidateLogs(from, to);
      const byTransaction = new Map<string, CandidateLogRef[]>();
      for (const candidate of candidates) {
        const key = candidate.transactionHash.toLowerCase();
        byTransaction.set(key, [...(byTransaction.get(key) ?? []), candidate]);
      }
      for (const refs of byTransaction.values()) {
        const receipt = await this.chain.sourceReceipt(refs[0]!.transactionHash);
        if (!receipt || !this.candidateRefsMatchReceipt(refs, receipt)) {
          this.globalAttention(`SOURCE_RECEIPT_CONTRADICTION:${refs[0]!.transactionHash}`);
          return;
        }
        try {
          const accepted = await this.ingestReceipt(receipt);
          if (!accepted) return;
        } catch (error) {
          this.globalAttention(`SOURCE_ADMISSION_FAILURE:${safeError(error)}`);
          return;
        }
      }
      const current = this.store.readState();
      current.sourceCursor = {blockNumber: to, updatedAt: new Date(this.now()).toISOString()};
      this.store.writeState(current);
      from = to + 1;
    }
  }

  async tick(): Promise<void> {
    const lane = this.store.unresolvedLane();
    if (lane) {
      await this.reconcileEnvelope(lane.task);
      return;
    }
    const state = this.store.readState();
    if (state.globalAttentionReasons.length > 0) return;
    for (const task of this.store.listTasks()) {
      if (await this.processTask(task)) return;
    }
  }

  async advanceTask(taskId: string): Promise<void> {
    const lane = this.store.unresolvedLane();
    if (lane && lane.task.taskId !== taskId) {
      throw new Error(`BLOCKED_BY_GLOBAL_LANE(${lane.task.taskId}, ${lane.task.inFlight!.nonce})`);
    }
    if (lane) await this.reconcileEnvelope(lane.task);
    else await this.processTask(this.store.readTask(taskId));
  }

  async resume(taskId: string): Promise<void> {
    const task = this.store.readTask(taskId);
    if (task.inFlight) throw new Error('resume refuses a task with an unresolved envelope; use resume-broadcast');
    const now = this.now();
    let resumed = false;
    if (task.logical.currentInclusion?.events.some((event) => event.contractState === 'UNSEEN')) {
      task.logical.submissionEpoch = newEpoch(now, true);
      this.setSubmissionState(task, 'READY_FOR_PROOF', 'manual operator resume');
      resumed = true;
    }
    for (const evidence of task.logical.currentInclusion?.events ?? []) {
      if (evidence.contractState === 'VERIFIED_PENDING' || evidence.automationState === 'ATTENTION_REQUIRED') {
        evidence.applicationEpoch = newEpoch(now, true);
        this.setEvidenceState(evidence, 'READY_TO_APPLY', 'manual operator resume');
        resumed = true;
      }
    }
    if (!resumed) throw new Error('Task has no eligible retryable operation');
    this.store.writeTask(task);
  }

  async resumeBroadcast(taskId: string): Promise<void> {
    const task = this.store.readTask(taskId);
    if (!task.inFlight) throw new Error('Task has no unresolved exact envelope');
    task.logical.transitions.push(
      transition(this.now(), task.logical.sourceSubmissionState, task.logical.sourceSubmissionState, 'manual operator resume-broadcast'),
    );
    this.store.writeTask(task);
    await this.reconcileEnvelope(task, true);
  }

  private async processTask(task: WorkerTask): Promise<boolean> {
    if (!task.logical.currentInclusion || task.logical.sourceSubmissionState === 'ORPHANED') return false;
    await this.reconcileSemantic(task);
    if (task.inFlight) return true;
    if (task.logical.sourceSubmissionState === 'ATTENTION_REQUIRED') return false;
    const current = task.logical.currentInclusion.events;
    if (current.some((event) => event.contractState === 'UNSEEN')) {
      const attested = await this.chain.attestedHeight();
      if (attested < task.logical.currentInclusion.sourceBlockNumber) {
        this.setSubmissionState(task, 'WAITING_ATTESTATION', 'proof builder has not reached source height');
        this.store.writeTask(task);
        return false;
      }
      if (!task.logical.submissionEpoch) task.logical.submissionEpoch = newEpoch(this.now());
      this.setSubmissionState(task, 'READY_FOR_PROOF', 'source inclusion is attestable');
      this.store.writeTask(task);
      await this.attemptSubmission(task);
      return Boolean(task.inFlight);
    }
    const ready = current.find((event) => event.automationState === 'READY_TO_APPLY');
    if (ready) {
      await this.attemptApplication(task, ready);
      return Boolean(task.inFlight);
    }
    return false;
  }

  private candidateRefsMatchReceipt(refs: CandidateLogRef[], receipt: RawSourceReceipt): boolean {
    if (receipt.status !== 1 || refs.some((ref) =>
      ref.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      ref.blockNumber !== receipt.blockNumber ||
      ref.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )) return false;
    return refs.every((ref) => receipt.logs.some((log) =>
      log.logIndex === ref.logIndex &&
      log.address.toLowerCase() === this.config.gatewayAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === ref.topic0.toLowerCase(),
    ));
  }

  private async ingestReceipt(receipt: RawSourceReceipt, reorg = false): Promise<boolean> {
    if (receipt.status !== 1) throw new Error('SOURCE_RECEIPT_STATUS_NOT_SUCCESS');
    const events = this.chain.decodeGatewayEvents(receipt);
    if (events.length === 0) throw new Error('CANDIDATE_RECEIPT_HAS_NO_MATCHING_EVENT');
    const state = this.store.readState();
    const enrolled = events.map((event) => {
      const record = state.enrollments[event.dealId.toLowerCase()];
      return Boolean(record && event.sourceBlockNumber >= record.effectiveFromSourceBlock);
    });
    if (enrolled.every((value) => !value)) {
      this.log({event: 'admission_rejected', reason: 'UNENROLLED', transactionHash: receipt.transactionHash});
      return true;
    }
    const mixed = enrolled.some(Boolean) && enrolled.some((value) => !value);
    if (events.length > this.config.limits.maxEventsPerTransaction) {
      throw new Error('EVENT_LIMIT_REACHED');
    }
    const taskId = taskIdOf(this.config.sourceChainId, receipt.transactionHash);
    const existing = this.store.listTasks().find((task) => task.taskId === taskId);
    if (!existing && this.store.listTasks().filter(isNonTerminalTask).length >= this.config.limits.maxNonTerminalTasks) {
      throw new Error('TASK_LIMIT_REACHED');
    }
    const records = await Promise.all(events.map(async (event) => this.newEvidenceRecord(event)));
    const nowIso = new Date(this.now()).toISOString();
    const inclusion = {
      sourceBlockNumber: receipt.blockNumber,
      sourceBlockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      receiptStatus: receipt.status,
      events: records,
      observedAt: nowIso,
    };
    let task: WorkerTask;
    if (!existing) {
      task = {
        schemaVersion: WORKER_SCHEMA_VERSION,
        taskId,
        createdAt: nowIso,
        updatedAt: nowIso,
        logical: {
          sourceChainId: this.config.sourceChainId,
          transactionHash: receipt.transactionHash,
          sourceSubmissionState: mixed ? 'ATTENTION_REQUIRED' : 'WAITING_ATTESTATION',
          currentInclusion: inclusion,
          inclusionHistory: [],
          submissionAttemptCount: 0,
          sourceAttentionReason: mixed ? 'MIXED_ADMISSION' : undefined,
          transitions: [transition(this.now(), null, mixed ? 'ATTENTION_REQUIRED' : 'WAITING_ATTESTATION', mixed ? 'MIXED_ADMISSION' : 'admitted canonical source receipt')],
          operationHistory: [],
        },
      };
    } else {
      task = existing;
      if (task.logical.currentInclusion?.sourceBlockHash.toLowerCase() === receipt.blockHash.toLowerCase()) return true;
      if (!reorg && await this.anyEvidenceSeen(task.logical.currentInclusion?.events ?? [])) {
        this.setTaskAttention(task, 'SOURCE_REORG_AFTER_DESTINATION_RECORDING');
        this.store.writeTask(task);
        return false;
      }
      const hadInFlight = Boolean(task.inFlight);
      const old = task.logical.currentInclusion;
      if (old) {
        for (const event of old.events) event.inclusionState = 'SUPERSEDED';
        old.supersededAt = nowIso;
        old.supersededReason = 'canonical same-hash re-inclusion';
        task.logical.inclusionHistory.push(old);
      }
      task.logical.currentInclusion = inclusion;
      task.logical.submissionEpoch = undefined;
      const attentionReason = hadInFlight ? 'SOURCE_REORG_WITH_IN_FLIGHT_ENVELOPE' : mixed ? 'MIXED_ADMISSION' : undefined;
      this.setSubmissionState(task, attentionReason ? 'ATTENTION_REQUIRED' : 'WAITING_ATTESTATION', attentionReason ?? 'canonical same-hash re-inclusion');
      task.logical.sourceAttentionReason = attentionReason;
    }
    this.store.writeTask(task);
    return !mixed;
  }

  private async newEvidenceRecord(event: DecodedGatewayEvent): Promise<EvidenceRecord> {
    const nowIso = new Date(this.now()).toISOString();
    return {
      ...event,
      identity: `${event.sourceChainId}:${event.transactionHash.toLowerCase()}:${event.sourceBlockHash.toLowerCase()}:${event.transactionLogOrdinal}`,
      expectedEvidenceId: await this.chain.evidenceId(event),
      inclusionState: 'CURRENT',
      contractState: 'UNSEEN',
      automationState: 'UNSEEN',
      rejectionReason: 'NONE',
      applicationAttemptCount: 0,
      firstObservedAt: nowIso,
      transitions: [transition(this.now(), null, 'UNSEEN', 'canonical source event admitted')],
    };
  }

  private async reconcileSourceCanonicality(): Promise<void> {
    for (const task of this.store.listTasks()) {
      const current = task.logical.currentInclusion;
      if (!current || task.logical.sourceSubmissionState === 'ORPHANED') continue;
      const receipt = await this.chain.sourceReceipt(task.logical.transactionHash);
      if (receipt?.blockHash.toLowerCase() === current.sourceBlockHash.toLowerCase()) continue;
      if (!receipt) {
        const anySeen = await this.anyEvidenceSeen(current.events);
        if (task.inFlight || anySeen) {
          for (const event of current.events) event.inclusionState = 'ORPHANED';
          task.logical.inclusionHistory.push({
            ...current,
            supersededAt: new Date(this.now()).toISOString(),
            supersededReason: 'source inclusion removed after destination activity',
          });
          task.logical.currentInclusion = undefined;
          this.setTaskAttention(task, task.inFlight ? 'SOURCE_REORG_WITH_IN_FLIGHT_ENVELOPE' : 'SOURCE_REORG_AFTER_DESTINATION_RECORDING');
        } else {
          for (const event of current.events) event.inclusionState = 'ORPHANED';
          task.logical.inclusionHistory.push({...current, supersededAt: new Date(this.now()).toISOString(), supersededReason: 'source inclusion removed'});
          task.logical.currentInclusion = undefined;
          this.setSubmissionState(task, 'ORPHANED', 'source inclusion removed before signing');
        }
        this.store.writeTask(task);
        continue;
      }
      const oldEvidenceSeen = await this.anyEvidenceSeen(current.events);
      try {
        await this.ingestReceipt(receipt, true);
        if (oldEvidenceSeen) {
          const updated = this.store.readTask(task.taskId);
          this.setTaskAttention(updated, 'SOURCE_REORG_AFTER_DESTINATION_RECORDING');
          this.store.writeTask(updated);
          this.log({event: 'source_reorg_incident', severity: 'high', taskId: task.taskId, reason: 'old evidence already recorded'});
        }
      } catch (error) {
        const failed = this.store.readTask(task.taskId);
        const old = failed.logical.currentInclusion;
        if (old) {
          for (const event of old.events) event.inclusionState = 'SUPERSEDED';
          old.supersededAt = new Date(this.now()).toISOString();
          old.supersededReason = `re-inclusion admission failed:${safeError(error)}`;
          failed.logical.inclusionHistory.push(old);
          failed.logical.currentInclusion = undefined;
        }
        this.setTaskAttention(failed, `SOURCE_REORG_READMISSION_FAILED:${safeError(error)}`);
        this.store.writeTask(failed);
      }
    }
  }

  private async anyEvidenceSeen(events: EvidenceRecord[]): Promise<boolean> {
    return (await Promise.all(events.map((event) => this.chain.seen(event.expectedEvidenceId)))).some(Boolean);
  }

  private async reconcileSemantic(task: WorkerTask): Promise<void> {
    const events = task.logical.currentInclusion?.events ?? [];
    if (events.length === 0) return;
    const seenValues = await Promise.all(events.map((event) => this.chain.seen(event.expectedEvidenceId)));
    const classification = reconcileSeen(seenValues);
    if (classification === 'MIXED') {
      this.setTaskAttention(task, 'MIXED_EXPECTED_ID_VISIBILITY');
      this.globalAttention(`MIXED_EXPECTED_ID_VISIBILITY:${task.taskId}`);
      this.store.writeTask(task);
      return;
    }
    if (classification === 'ALL_FALSE') {
      for (const event of events) {
        event.contractState = 'UNSEEN';
        if (event.automationState !== 'APPLICATION_IN_FLIGHT') event.automationState = 'UNSEEN';
      }
      this.store.writeTask(task);
      return;
    }
    if (task.logical.sourceSubmissionState !== 'ATTENTION_REQUIRED') {
      this.setSubmissionState(task, 'SUBMITTED', 'complete expected evidence set is present');
    }
    const applicationInFlightId = task.inFlight?.purpose.kind === 'APPLICATION'
      ? task.inFlight.purpose.evidenceId.toLowerCase()
      : undefined;
    for (const event of events) {
      const result = await this.chain.evidenceState(event.expectedEvidenceId);
      event.contractState = result.state;
      event.rejectionReason = result.reason;
      const preserveInFlight = applicationInFlightId === event.expectedEvidenceId.toLowerCase();
      if (result.state === 'UNSEEN') {
        if (!preserveInFlight) this.setEvidenceAttention(event, 'VERIFIER_SEEN_BUT_DEALS_REPORTS_UNSEEN');
      } else if (result.state === 'VERIFIED_PENDING') {
        const deal = await this.chain.dealView(event.dealId);
        const snapshot = {dealStatus: deal.status, designatedInvestor: deal.designatedInvestor};
        if (preserveInFlight) {
          event.prerequisiteSnapshot = snapshot;
          continue;
        }
        const changed = !event.prerequisiteSnapshot ||
          event.prerequisiteSnapshot.dealStatus !== snapshot.dealStatus ||
          event.prerequisiteSnapshot.designatedInvestor.toLowerCase() !== snapshot.designatedInvestor.toLowerCase();
        const alreadyReady = event.automationState === 'READY_TO_APPLY' && Boolean(event.applicationEpoch);
        if (!alreadyReady && changed) {
          const ready = this.isApplicationReady(event, deal);
          this.setEvidenceState(event, ready ? 'READY_TO_APPLY' : 'VERIFIED_PENDING', ready ? 'application prerequisite is now present' : 'application prerequisite remains absent');
          event.prerequisiteSnapshot = snapshot;
          if (ready && !event.applicationEpoch) event.applicationEpoch = newEpoch(this.now());
        } else if (!alreadyReady) this.setEvidenceState(event, 'VERIFIED_PENDING', 'application prerequisite unchanged');
      } else {
        if (!preserveInFlight) {
          this.setEvidenceState(event, automationFromContract(result.state), 'canonical evidence state reconciliation');
        }
      }
    }
    this.store.writeTask(task);
  }

  private isApplicationReady(event: EvidenceRecord, deal: DealView): boolean {
    if (deal.status === 0) return false;
    if (event.kind === 'FUNDING') return true;
    if (event.recipient.toLowerCase() !== deal.designatedInvestor.toLowerCase()) return true;
    return deal.status !== 1;
  }

  private async attemptSubmission(task: WorkerTask): Promise<void> {
    const epoch = task.logical.submissionEpoch;
    if (!epoch || !this.epochEligible(task, epoch, 'submission')) return;
    this.setSubmissionState(task, 'SUBMITTING', 'fresh proof attempt started');
    this.store.writeTask(task);
    try {
      const proof = await this.chain.freshProof(task.logical.transactionHash);
      const inclusion = task.logical.currentInclusion;
      if (!inclusion || proof.txHash.toLowerCase() !== task.logical.transactionHash.toLowerCase() ||
        proof.headerNumber !== inclusion.sourceBlockNumber || proof.txIndex !== inclusion.transactionIndex) {
        this.setTaskAttention(task, 'PROOF_SOURCE_INCLUSION_MISMATCH');
        this.store.writeTask(task);
        return;
      }
      const request = this.chain.submissionRequest(proof);
      const simulation = await this.chain.simulate(request);
      const classification = simulation.ok ? 'SUCCESS' : simulation.revertData ? classifySimulation(simulation.revertData) : 'FAIL_CLOSED';
      if (classification === 'ALREADY_RECORDED') {
        const visibility = reconcileSeen(await Promise.all(
          inclusion.events.map((event) => this.chain.seen(event.expectedEvidenceId)),
        ));
        if (visibility === 'ALL_TRUE') await this.reconcileSemantic(task);
        else {
          this.setTaskAttention(task, `ALREADY_RECORDED_WITH_${visibility}_VISIBILITY`);
          if (visibility === 'MIXED') this.globalAttention(`MIXED_EXPECTED_ID_VISIBILITY:${task.taskId}`);
          this.store.writeTask(task);
        }
        return;
      }
      if (classification === 'REFRESH_PROOF') {
        this.scheduleRetry(task, epoch, 'refreshable continuity proof simulation');
        return;
      }
      if (classification !== 'SUCCESS') {
        this.setTaskAttention(task, `SUBMISSION_SIMULATION_${classification}`);
        this.store.writeTask(task);
        return;
      }
      await this.persistSignedEnvelope(task, {
        kind: 'SUBMISSION',
        evidenceIds: inclusion.events.map((event) => event.expectedEvidenceId),
        sourceBlockHash: inclusion.sourceBlockHash,
      }, request);
    } catch (error) {
      if (isResourceStop(error)) {
        this.setTaskAttention(task, safeError(error));
        this.store.writeTask(task);
      } else this.scheduleRetry(task, epoch, `submission transport failure:${safeError(error)}`);
    }
  }

  private async attemptApplication(task: WorkerTask, evidence: EvidenceRecord): Promise<void> {
    const epoch = evidence.applicationEpoch;
    if (!epoch || !this.epochEligible(task, epoch, `application:${evidence.expectedEvidenceId}`, evidence)) return;
    try {
      const request = this.chain.applicationRequest(evidence.expectedEvidenceId);
      const simulation = await this.chain.simulate(request);
      const classification = simulation.ok ? 'SUCCESS' : simulation.revertData ? classifySimulation(simulation.revertData) : 'FAIL_CLOSED';
      if (classification !== 'SUCCESS') {
        this.setEvidenceAttention(evidence, `APPLICATION_SIMULATION_${classification}`);
        this.store.writeTask(task);
        return;
      }
      await this.persistSignedEnvelope(task, {kind: 'APPLICATION', evidenceId: evidence.expectedEvidenceId}, request);
    } catch (error) {
      if (isResourceStop(error)) {
        this.setEvidenceAttention(evidence, safeError(error));
        this.store.writeTask(task);
      } else this.scheduleRetry(task, epoch, `application transport failure:${safeError(error)}`, evidence);
    }
  }

  private async persistSignedEnvelope(task: WorkerTask, purpose: InFlightPurpose, request: TransactionRequest): Promise<void> {
    if (this.store.unresolvedLane()) throw new Error('Global write lane is occupied');
    const expectedNonce = this.expectedNextNonce();
    const nonces = await this.chain.nonces();
    if (nonces.latest !== expectedNonce || nonces.pending !== expectedNonce) {
      this.globalAttention(`UNEXPECTED_SIGNER_NONCE:expected=${expectedNonce},latest=${nonces.latest},pending=${nonces.pending}`);
      return;
    }
    const prepared = await this.chain.prepare(request, expectedNonce);
    const tasks = this.store.listTasks();
    const cutoff = this.now() - 24 * 60 * 60 * 1_000;
    const rollingActual = tasks.flatMap((candidate) => candidate.logical.operationHistory)
      .filter((operation) => Date.parse(operation.confirmedAt) >= cutoff)
      .reduce((sum, operation) => sum + BigInt(operation.actualFee), 0n);
    const reservations = tasks.reduce((sum, candidate) => sum + BigInt(candidate.inFlight?.maximumLiability ?? '0'), 0n);
    const liability = assertResourcePolicy({
      limits: this.config.limits,
      estimatedGas: prepared.estimate,
      finalGasLimit: prepared.gasLimit,
      finalPrice: prepared.price,
      signerBalance: await this.chain.signerBalance(),
      rollingActualFees: rollingActual,
      unresolvedReservations: reservations,
    });
    const signed = await this.chain.sign(prepared.request);
    const nowIso = new Date(this.now()).toISOString();
    task.inFlight = {
      purpose,
      transactionHash: signed.hash,
      rawTransaction: signed.raw,
      nonce: expectedNonce,
      chainId: this.config.destinationChainId,
      destination: this.config.dealsAddress,
      maximumLiability: liability.toString(),
      createdAt: nowIso,
      broadcastCount: 0,
    };
    if (purpose.kind === 'SUBMISSION') this.setSubmissionState(task, 'SUBMISSION_IN_FLIGHT', 'exact signed envelope persisted before broadcast');
    else {
      const evidence = task.logical.currentInclusion!.events.find((item) => item.expectedEvidenceId === purpose.evidenceId)!;
      this.setEvidenceState(evidence, 'APPLICATION_IN_FLIGHT', 'exact signed envelope persisted before broadcast');
      evidence.applicationAttemptCount += 1;
    }
    task.logical.submissionAttemptCount += purpose.kind === 'SUBMISSION' ? 1 : 0;
    this.store.writeTask(task);
    await this.reconcileEnvelope(task);
  }

  private async reconcileEnvelope(task: WorkerTask, operatorRequested = false): Promise<void> {
    let envelope = task.inFlight;
    if (!envelope) return;
    const receipt = await this.chain.destinationReceipt(envelope.transactionHash);
    if (receipt) {
      const canonicalHash = await this.chain.canonicalDestinationBlockHash(receipt.blockNumber);
      if (canonicalHash && canonicalHash.toLowerCase() === receipt.blockHash.toLowerCase()) {
        envelope.receiptBlockNumber = receipt.blockNumber;
        envelope.receiptBlockHash = receipt.blockHash;
        envelope.receiptStatus = receipt.status;
        this.store.writeTask(task);
        if (await this.chain.destinationHead() < receipt.blockNumber + 2) return;
        await this.finalizeEnvelope(task, receipt);
        return;
      }
      delete envelope.receiptBlockNumber;
      delete envelope.receiptBlockHash;
      delete envelope.receiptStatus;
      this.store.writeTask(task);
    }

    await this.reconcileEnvelopeSemantic(task);
    envelope = task.inFlight;
    if (!envelope) return;
    if (envelope.broadcastCount === 0) {
      if (await this.envelopeNonceIsCompatible(task)) await this.broadcastExact(task, operatorRequested);
      return;
    }
    if (envelope.resolutionDeadlineAt && this.now() >= Date.parse(envelope.resolutionDeadlineAt) && !operatorRequested) {
        this.setTaskAttention(task, 'IN_FLIGHT_RESOLUTION_WINDOW_EXPIRED');
        this.store.writeTask(task);
        return;
    }
    if (operatorRequested || this.now() - Date.parse(envelope.lastBroadcastAt ?? envelope.createdAt) >= 5_000) {
      if (await this.envelopeNonceIsCompatible(task)) await this.broadcastExact(task, operatorRequested);
    }
  }

  private async reconcileEnvelopeSemantic(task: WorkerTask): Promise<void> {
    const envelope = task.inFlight;
    if (!envelope) return;
    if (envelope.purpose.kind === 'SUBMISSION') {
      const visibility = reconcileSeen(await Promise.all(envelope.purpose.evidenceIds.map((id) => this.chain.seen(id))));
      if (visibility === 'MIXED') {
        this.setTaskAttention(task, 'MIXED_ENVELOPE_EVIDENCE_VISIBILITY');
        this.globalAttention(`MIXED_ENVELOPE_EVIDENCE_VISIBILITY:${task.taskId}`);
      } else if (visibility === 'ALL_TRUE' &&
        task.logical.currentInclusion?.sourceBlockHash.toLowerCase() === envelope.purpose.sourceBlockHash.toLowerCase() &&
        task.logical.sourceSubmissionState !== 'ATTENTION_REQUIRED') {
        this.setSubmissionState(task, 'SUBMITTED', 'signed envelope semantic submission is already satisfied');
      }
    } else {
      const evidence = this.findEvidence(task, envelope.purpose.evidenceId);
      if (!evidence) {
        this.setTaskAttention(task, 'APPLICATION_ENVELOPE_EVIDENCE_MISSING');
      } else {
        const result = await this.chain.evidenceState(envelope.purpose.evidenceId);
        evidence.contractState = result.state;
        evidence.rejectionReason = result.reason;
        if (result.state === 'VERIFIED_PENDING') {
          const deal = await this.chain.dealView(evidence.dealId);
          evidence.prerequisiteSnapshot = {dealStatus: deal.status, designatedInvestor: deal.designatedInvestor};
        }
      }
    }
    this.store.writeTask(task);
  }

  private async envelopeNonceIsCompatible(task: WorkerTask): Promise<boolean> {
    const envelope = task.inFlight!;
    const nonces = await this.chain.nonces();
    const compatible = nonces.latest === envelope.nonce &&
      (nonces.pending === envelope.nonce || nonces.pending === envelope.nonce + 1);
    if (!compatible) {
      this.globalAttention(
        `UNEXPECTED_SIGNER_NONCE:envelope=${envelope.nonce},latest=${nonces.latest},pending=${nonces.pending}`,
      );
    }
    return compatible;
  }

  private async broadcastExact(task: WorkerTask, operatorRequested: boolean): Promise<void> {
    const envelope = task.inFlight!;
    const nowIso = new Date(this.now()).toISOString();
    envelope.firstBroadcastAt ??= nowIso;
    envelope.resolutionDeadlineAt ??= new Date(this.now() + SIX_HOURS_MS).toISOString();
    envelope.lastBroadcastAt = nowIso;
    envelope.broadcastCount += 1;
    task.logical.transitions.push(transition(this.now(), 'IN_FLIGHT', 'IN_FLIGHT', operatorRequested ? 'manual exact-byte rebroadcast' : 'exact-byte broadcast attempt'));
    this.store.writeTask(task);
    this.log({
      event: 'exact_broadcast_attempt',
      taskId: task.taskId,
      destinationTransactionHash: envelope.transactionHash,
      nonce: envelope.nonce,
      broadcastCount: envelope.broadcastCount,
      resolutionDeadlineAt: envelope.resolutionDeadlineAt,
      operatorRequested,
    });
    try {
      const returnedHash = await this.chain.broadcast(envelope.rawTransaction);
      if (returnedHash.toLowerCase() !== envelope.transactionHash.toLowerCase()) {
        this.globalAttention(`BROADCAST_HASH_MISMATCH:${task.taskId}`);
      }
    } catch (error) {
      this.log({event: 'ambiguous_broadcast', taskId: task.taskId, transactionHash: envelope.transactionHash, error: safeError(error)});
    }
  }

  private async finalizeEnvelope(task: WorkerTask, receipt: DestinationReceipt): Promise<void> {
    const envelope = task.inFlight!;
    if (envelope.purpose.kind === 'SUBMISSION') {
      const visibility = reconcileSeen(await Promise.all(envelope.purpose.evidenceIds.map((id) => this.chain.seen(id))));
      if (visibility === 'MIXED') {
        this.setTaskAttention(task, 'MIXED_EXPECTED_ID_VISIBILITY_AFTER_RECEIPT');
        this.globalAttention(`MIXED_EXPECTED_ID_VISIBILITY:${task.taskId}`);
      } else if (visibility !== 'ALL_TRUE') {
        this.setTaskAttention(task, receipt.status === 0 ? 'MINED_REVERT_WITHOUT_SEMANTIC_SUCCESS' : 'SUCCESS_RECEIPT_WITHOUT_COMPLETE_EVIDENCE');
      }
    } else {
      const evidenceId = envelope.purpose.evidenceId;
      const evidence = this.findEvidence(task, evidenceId);
      if (!evidence) this.setTaskAttention(task, 'APPLICATION_ENVELOPE_EVIDENCE_MISSING');
      else {
        const result = await this.chain.evidenceState(evidence.expectedEvidenceId);
        evidence.contractState = result.state;
        evidence.rejectionReason = result.reason;
        if (receipt.status === 1 && result.state !== 'UNSEEN') {
          this.setEvidenceState(evidence, automationFromContract(result.state), 'confirmed successful application receipt');
          if (result.state === 'VERIFIED_PENDING') {
            const deal = await this.chain.dealView(evidence.dealId);
            evidence.prerequisiteSnapshot = {dealStatus: deal.status, designatedInvestor: deal.designatedInvestor};
            evidence.applicationEpoch = undefined;
          }
        } else if (receipt.status === 0 && isTerminal(automationFromContract(result.state))) {
          this.setEvidenceState(evidence, automationFromContract(result.state), 'confirmed revert but semantic application is terminal');
        } else {
          this.setEvidenceAttention(evidence, receipt.status === 0 ? 'MINED_REVERT_WITHOUT_TERMINAL_APPLICATION' : 'SUCCESS_APPLICATION_RETURNED_UNSEEN');
        }
      }
    }
    const timestamp = await this.chain.destinationBlockTimestamp(receipt.blockNumber);
    task.logical.operationHistory.push({
      purpose: envelope.purpose,
      transactionHash: envelope.transactionHash,
      nonce: envelope.nonce,
      receiptStatus: receipt.status,
      receiptBlockNumber: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash,
      confirmedAt: new Date(timestamp * 1_000).toISOString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      actualFee: actualFee(receipt.gasUsed, receipt.effectiveGasPrice).toString(),
    });
    this.log({
      event: 'operation_confirmed',
      taskId: task.taskId,
      sourceTransactionHash: task.logical.transactionHash,
      destinationTransactionHash: envelope.transactionHash,
      purpose: envelope.purpose.kind,
      receiptStatus: receipt.status,
      receiptBlockNumber: receipt.blockNumber,
      elapsedMs: this.now() - Date.parse(task.createdAt),
    });
    delete task.inFlight;
    this.store.writeTask(task);
    if (receipt.status === 1 || envelope.purpose.kind === 'SUBMISSION') await this.reconcileSemantic(task);
  }

  private findEvidence(task: WorkerTask, evidenceId: Hex): EvidenceRecord | undefined {
    const normalized = evidenceId.toLowerCase();
    return [task.logical.currentInclusion, ...task.logical.inclusionHistory]
      .filter((inclusion) => inclusion !== undefined)
      .flatMap((inclusion) => inclusion.events)
      .find((event) => event.expectedEvidenceId.toLowerCase() === normalized);
  }

  private expectedNextNonce(): number {
    const state = this.store.readState();
    const confirmed = this.store.listTasks().flatMap((task) => task.logical.operationHistory.map((operation) => operation.nonce));
    return confirmed.length === 0 ? state.bootstrapLatestNonce : Math.max(...confirmed) + 1;
  }

  private epochEligible(task: WorkerTask, epoch: AttemptEpoch, label: string, evidence?: EvidenceRecord): boolean {
    if (this.now() >= Date.parse(epoch.deadlineAt)) {
      if (evidence) this.setEvidenceAttention(evidence, `${label} epoch expired`);
      else this.setTaskAttention(task, `${label} epoch expired`);
      this.store.writeTask(task);
      return false;
    }
    return !epoch.nextAttemptAt || this.now() >= Date.parse(epoch.nextAttemptAt);
  }

  private scheduleRetry(task: WorkerTask, epoch: AttemptEpoch, reason: string, evidence?: EvidenceRecord): void {
    const delay = retryDelayMs(epoch, this.now(), this.random);
    if (delay <= 0) {
      if (evidence) this.setEvidenceAttention(evidence, `${reason}: epoch expired`);
      else this.setTaskAttention(task, `${reason}: epoch expired`);
    } else {
      epoch.lastAttemptAt = new Date(this.now()).toISOString();
      epoch.nextAttemptAt = new Date(this.now() + delay).toISOString();
      epoch.retryIndex += 1;
      if (!evidence) this.setSubmissionState(task, 'READY_FOR_PROOF', reason);
      task.logical.transitions.push(transition(this.now(), 'RETRY', 'RETRY', `${reason}; next in ${delay}ms`));
      this.log({
        event: 'retry_scheduled',
        taskId: task.taskId,
        evidenceId: evidence?.expectedEvidenceId,
        reason,
        nextAttemptAt: epoch.nextAttemptAt,
        deadlineAt: epoch.deadlineAt,
      });
    }
    this.store.writeTask(task);
  }

  private setSubmissionState(task: WorkerTask, to: WorkerTask['logical']['sourceSubmissionState'], reason: string): void {
    const from = task.logical.sourceSubmissionState;
    if (from !== to) {
      task.logical.transitions.push(transition(this.now(), from, to, reason));
      this.log({
        event: 'submission_transition',
        taskId: task.taskId,
        sourceTransactionHash: task.logical.transactionHash,
        from,
        to,
        reason,
      });
    }
    task.logical.sourceSubmissionState = to;
  }

  private setEvidenceState(event: EvidenceRecord, to: EvidenceRecord['automationState'], reason: string): void {
    const from = event.automationState;
    if (from !== to) {
      event.transitions.push(transition(this.now(), from, to, reason));
      this.log({
        event: 'evidence_transition',
        taskId: taskIdOf(event.sourceChainId, event.transactionHash),
        sourceTransactionHash: event.transactionHash,
        evidenceId: event.expectedEvidenceId,
        from,
        to,
        reason,
      });
    }
    event.automationState = to;
  }

  private setTaskAttention(task: WorkerTask, reason: string): void {
    task.logical.sourceAttentionReason = reason;
    this.setSubmissionState(task, 'ATTENTION_REQUIRED', reason);
  }

  private setEvidenceAttention(event: EvidenceRecord, reason: string): void {
    event.rejectionReason = reason;
    this.setEvidenceState(event, 'ATTENTION_REQUIRED', reason);
  }

  private globalAttention(reason: string): void {
    const state = this.store.readState();
    if (!state.globalAttentionReasons.includes(reason)) state.globalAttentionReasons.push(reason);
    this.store.writeState(state);
    this.log({event: 'GLOBAL_ATTENTION_REQUIRED', reason});
  }
}

export function summarizeState(state: WorkerState, tasks: WorkerTask[]): Record<string, unknown> {
  const lane = tasks.find((task) => task.inFlight);
  return {
    schemaVersion: state.schemaVersion,
    signerAddress: state.signerAddress,
    sourceCursor: state.sourceCursor,
    enrollments: Object.values(state.enrollments),
    globalAttentionReasons: state.globalAttentionReasons,
    globalLane: lane ? `BLOCKED_BY_GLOBAL_LANE(${lane.taskId}, ${lane.inFlight!.nonce})` : 'OPEN',
    tasks: tasks.map((task) => ({taskId: task.taskId, transactionHash: task.logical.transactionHash, ...aggregateTask(task)})),
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/0x[0-9a-fA-F]{128,}/g, '<redacted-hex>');
  return String(error).replace(/0x[0-9a-fA-F]{128,}/g, '<redacted-hex>');
}

function isResourceStop(error: unknown): boolean {
  return error instanceof Error && /^(GAS_CAP_EXCEEDED|FEE_CAP_EXCEEDED|ROLLING_BUDGET_EXCEEDED|BALANCE_RESERVE_EXCEEDED)$/.test(error.message);
}
