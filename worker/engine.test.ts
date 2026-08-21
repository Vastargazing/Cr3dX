import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {SingleProof} from '../scripts/lib/proofs.js';
import {Interface, keccak256, type TransactionRequest} from 'ethers';
import type {CandidateLogRef, DealView, DestinationReceipt, PreparedTransaction, RawSourceReceipt} from './chain.js';
import {WorkerEngine, type WorkerPort} from './engine.js';
import {StateStore} from './state.js';
import type {ContractEvidenceState, DecodedGatewayEvent, Hex, WorkerConfig, WorkerState, WorkerTask} from './types.js';

const TX = `0x${'10'.repeat(32)}` as Hex;
const BLOCK_A = `0x${'20'.repeat(32)}` as Hex;
const BLOCK_B = `0x${'21'.repeat(32)}` as Hex;
const GATEWAY = `0x${'30'.repeat(20)}` as Hex;
const DEAL_A = `0x${'40'.repeat(32)}` as Hex;
const DEAL_B = `0x${'41'.repeat(32)}` as Hex;
const INVESTOR = `0x${'50'.repeat(20)}` as Hex;
const BORROWER = `0x${'60'.repeat(20)}` as Hex;
const RAW = '0x02f8' as Hex;
const DEST_TX = keccak256(RAW) as Hex;
const VERIFIER_ERRORS = new Interface(['error EvidenceAlreadyRecorded(bytes32 evidenceId)']);

class FakeChain implements WorkerPort {
  head = 100;
  queried: Array<[number, number]> = [];
  candidates: CandidateLogRef[] = [];
  sourceReceipts = new Map<string, RawSourceReceipt | null>();
  decoded = new Map<string, DecodedGatewayEvent[]>();
  seenIds = new Set<string>();
  evidenceStates = new Map<string, {state: ContractEvidenceState; reason: string}>();
  deals = new Map<string, DealView>();
  attested = 1_000;
  proofFetches = 0;
  proofOverride: SingleProof | undefined;
  signCount = 0;
  broadcasted: Hex[] = [];
  broadcastError: Error | undefined;
  simulation: {ok: true} | {ok: false; revertData?: string} = {ok: true};
  nonce = {latest: 0, pending: 0};
  balance = 1_000_000_000n;
  destinationReceipts = new Map<string, DestinationReceipt | null>();
  destinationHeight = 0;
  canonicalHashes = new Map<number, Hex>();
  runtime = {attestationInterval: 10, checkpointInterval: 10};
  deploymentMismatch = false;
  prepareError: Error | undefined;

  signerAddress(): Hex { return `0x${'12'.repeat(20)}`; }
  async sourceHead(): Promise<number> { return this.head; }
  async candidateLogs(from: number, to: number): Promise<CandidateLogRef[]> {
    this.queried.push([from, to]);
    return this.candidates.filter((candidate) => candidate.blockNumber >= from && candidate.blockNumber <= to);
  }
  async sourceReceipt(hash: Hex): Promise<RawSourceReceipt | null> { return this.sourceReceipts.get(hash.toLowerCase()) ?? null; }
  decodeGatewayEvents(receipt: RawSourceReceipt): DecodedGatewayEvent[] { return this.decoded.get(receipt.blockHash.toLowerCase()) ?? []; }
  async evidenceId(event: DecodedGatewayEvent): Promise<Hex> { return `0x${BigInt(event.eventNonce + (event.kind === 'REPAYMENT' ? '1' : '0')).toString(16).padStart(64, '0')}` as Hex; }
  async seen(id: Hex): Promise<boolean> { return this.seenIds.has(id.toLowerCase()); }
  async evidenceState(id: Hex): Promise<{state: ContractEvidenceState; reason: string}> { return this.evidenceStates.get(id.toLowerCase()) ?? {state: 'VERIFIED_PENDING', reason: 'NONE'}; }
  async dealView(id: Hex): Promise<DealView> { return this.deals.get(id.toLowerCase()) ?? {status: 0, designatedInvestor: INVESTOR}; }
  async attestedHeight(): Promise<number> { return this.attested; }
  async freshProof(): Promise<SingleProof> {
    this.proofFetches += 1;
    return this.proofOverride ?? {chainKey: 1, headerNumber: 100, txIndex: 2, txHash: TX, txBytes: '0x01', merkleProof: {root: BLOCK_A, siblings: []}, continuityProof: {lowerEndpointDigest: BLOCK_A, roots: []}, cached: false};
  }
  submissionRequest(): TransactionRequest { return {to: `0x${'80'.repeat(20)}`, data: '0x1111'}; }
  applicationRequest(id: Hex): TransactionRequest { return {to: `0x${'80'.repeat(20)}`, data: id}; }
  async simulate(): Promise<{ok: true} | {ok: false; revertData?: string}> { return this.simulation; }
  async prepare(request: TransactionRequest, nonce: number): Promise<PreparedTransaction> {
    if (this.prepareError) throw this.prepareError;
    return {request: {...request, nonce, gasLimit: 100n, gasPrice: 2n, chainId: 102031}, estimate: 90n, gasLimit: 100n, price: 2n};
  }
  async sign(): Promise<{raw: Hex; hash: Hex}> { this.signCount += 1; return {raw: RAW, hash: DEST_TX}; }
  async broadcast(raw: Hex): Promise<Hex> { this.broadcasted.push(raw); if (this.broadcastError) throw this.broadcastError; return DEST_TX; }
  async destinationReceipt(hash: Hex): Promise<DestinationReceipt | null> { return this.destinationReceipts.get(hash.toLowerCase()) ?? null; }
  async destinationHead(): Promise<number> { return this.destinationHeight; }
  async canonicalDestinationBlockHash(block: number): Promise<Hex | null> { return this.canonicalHashes.get(block) ?? null; }
  async destinationBlockTimestamp(): Promise<number> { return 1_700_000_000; }
  async nonces(): Promise<{latest: number; pending: number}> { return this.nonce; }
  async signerBalance(): Promise<bigint> { return this.balance; }
  async runtimeIntervals(): Promise<{attestationInterval: number; checkpointInterval: number}> { return this.runtime; }
  async assertDeploymentConfiguration(): Promise<void> { if (this.deploymentMismatch) throw new Error('mismatch'); }
}

test('coverage 1, 2, 3 and 28: duplicate delivery, multiple facts and restart overlap are lossless', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A), event(1, 'REPAYMENT', DEAL_A)]);
  await fixture.engine.scanOnce();
  await fixture.engine.scanOnce();
  const tasks = fixture.store.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.logical.currentInclusion!.events.length, 2);
  assert.equal(tasks[0]!.logical.currentInclusion!.events[0]!.transactionLogOrdinal, 0);
  assert.equal(tasks[0]!.logical.currentInclusion!.events[1]!.transactionLogOrdinal, 1);
  assert.deepEqual(fixture.chain.queried, [[100, 100], [100, 100]]);
  assert.equal(fixture.store.readState().sourceCursor?.blockNumber, 100);
});

test('coverage 5 and 6: waiting does not start an epoch; crash after proof fetch stores no proof and restart fetches fresh', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  fixture.chain.attested = 99;
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  let task = fixture.store.listTasks()[0]!;
  assert.equal(task.logical.sourceSubmissionState, 'WAITING_ATTESTATION');
  assert.equal(task.logical.submissionEpoch, undefined);
  fixture.chain.attested = 100;
  fixture.chain.prepareError = new Error('injected crash after proof fetch');
  await new WorkerEngine(fixture.config, fixture.store, fixture.chain, {now: () => now, random: () => 0.5, log: () => {}}).tick();
  task = fixture.store.listTasks()[0]!;
  assert.equal(task.inFlight, undefined);
  assert.equal(JSON.stringify(task.logical).includes('txBytes'), false);
  assert.equal(fixture.chain.proofFetches, 1);
  fixture.chain.prepareError = undefined;
  now = Date.parse(task.logical.submissionEpoch!.nextAttemptAt!);
  await new WorkerEngine(fixture.config, fixture.store, fixture.chain, {now: () => now, random: () => 0.5, log: () => {}}).tick();
  assert.equal(fixture.chain.proofFetches, 2);
  assert.equal(fixture.chain.signCount, 1);
});

test('coverage 38: effective height, event cap and queue cap reject without losing cursor position', async () => {
  const future = setup([event(0, 'FUNDING', DEAL_A)]);
  const futureState = future.store.readState();
  futureState.enrollments[DEAL_A.toLowerCase()]!.effectiveFromSourceBlock = 101;
  future.store.writeState(futureState);
  await future.engine.scanOnce();
  assert.equal(future.store.listTasks().length, 0);
  assert.equal(future.store.readState().sourceCursor?.blockNumber, 100);

  const tooMany = setup(Array.from({length: 33}, (_, index) => event(index, 'FUNDING', DEAL_A)));
  await tooMany.engine.scanOnce();
  assert.match(tooMany.store.readState().globalAttentionReasons[0]!, /EVENT_LIMIT_REACHED/);
  assert.equal(tooMany.store.readState().sourceCursor, undefined);

  const full = setup([event(0, 'FUNDING', DEAL_A)]);
  full.config.limits.maxNonTerminalTasks = 0;
  await full.engine.scanOnce();
  assert.match(full.store.readState().globalAttentionReasons[0]!, /TASK_LIMIT_REACHED/);
  assert.equal(full.store.readState().sourceCursor, undefined);
});

test('coverage 38 and 46: mixed admission and contradictory candidate stop before cursor advancement', async () => {
  const mixed = setup([event(0, 'FUNDING', DEAL_A), event(1, 'REPAYMENT', DEAL_B)], [DEAL_A]);
  await mixed.engine.scanOnce();
  assert.equal(mixed.store.listTasks()[0]!.logical.sourceAttentionReason, 'MIXED_ADMISSION');
  assert.equal(mixed.store.readState().sourceCursor, undefined);

  const failed = setup([event(0, 'FUNDING', DEAL_A)]);
  failed.chain.sourceReceipts.set(TX, {...receipt(), status: 0});
  await failed.engine.scanOnce();
  assert.match(failed.store.readState().globalAttentionReasons[0]!, /SOURCE_RECEIPT_CONTRADICTION/);
  assert.equal(failed.store.readState().sourceCursor, undefined);

  const wrongBlock = setup([event(0, 'FUNDING', DEAL_A)]);
  wrongBlock.chain.candidates = [{...wrongBlock.chain.candidates[0]!, blockHash: BLOCK_B}];
  await wrongBlock.engine.scanOnce();
  assert.match(wrongBlock.store.readState().globalAttentionReasons[0]!, /SOURCE_RECEIPT_CONTRADICTION/);
  assert.equal(wrongBlock.store.readState().sourceCursor, undefined);
});

test('coverage 6-12, 14, 17, 33 and 44: one exact envelope owns the global lane across retry and restart', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  fixture.chain.broadcastError = new Error('timeout after send');
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  let task = fixture.store.listTasks()[0]!;
  assert.equal(fixture.chain.proofFetches, 1);
  assert.equal(fixture.chain.signCount, 1);
  assert.equal(task.inFlight?.rawTransaction, RAW);
  assert.equal(task.inFlight?.broadcastCount, 1);
  assert.equal(task.inFlight?.resolutionDeadlineAt, new Date(now + 6 * 60 * 60 * 1_000).toISOString());

  const restarted = new WorkerEngine(fixture.config, fixture.store, fixture.chain, {now: () => now, random: () => 0.5, log: () => {}});
  now += 5_000;
  await restarted.tick();
  task = fixture.store.listTasks()[0]!;
  assert.equal(fixture.chain.signCount, 1);
  assert.deepEqual(fixture.chain.broadcasted, [RAW, RAW]);
  assert.equal(task.inFlight?.resolutionDeadlineAt, new Date(1_000 + 6 * 60 * 60 * 1_000).toISOString());
  const blocked = structuredClone(task);
  blocked.taskId = 'f'.repeat(64);
  blocked.logical.transactionHash = `0x${'f0'.repeat(32)}`;
  delete blocked.inFlight;
  blocked.logical.sourceSubmissionState = 'SUBMITTED';
  blocked.logical.currentInclusion!.events[0]!.contractState = 'VERIFIED_PENDING';
  blocked.logical.currentInclusion!.events[0]!.automationState = 'READY_TO_APPLY';
  fixture.store.writeTask(blocked);
  await restarted.tick();
  assert.equal(fixture.chain.signCount, 1);
  assert.equal(fixture.store.readTask(blocked.taskId).logical.currentInclusion!.events[0]!.automationState, 'READY_TO_APPLY');
  assert.match(JSON.stringify(fixture.store.listTasks().map((candidate) => candidate.logical)), /SUBMISSION_IN_FLIGHT/);
});

test('coverage 13, 15, 19, 33 and 36: semantic success does not free nonce; exact receipt needs two later blocks', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  const evidenceId = task.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  fixture.chain.seenIds.add(evidenceId.toLowerCase());
  fixture.chain.evidenceStates.set(evidenceId.toLowerCase(), {state: 'APPLIED', reason: 'NONE'});
  const destinationBlockHash = `0x${'71'.repeat(32)}` as Hex;
  fixture.chain.destinationReceipts.set(DEST_TX, {hash: DEST_TX, status: 1, blockNumber: 10, blockHash: destinationBlockHash, gasUsed: 50n, effectiveGasPrice: 2n});
  fixture.chain.canonicalHashes.set(10, destinationBlockHash);
  fixture.chain.destinationHeight = 11;
  await fixture.engine.tick();
  assert.ok(fixture.store.listTasks()[0]!.inFlight);
  fixture.chain.destinationHeight = 12;
  await fixture.engine.tick();
  const completed = fixture.store.listTasks()[0]!;
  assert.equal(completed.inFlight, undefined);
  assert.equal(completed.logical.operationHistory[0]!.actualFee, '100');
  assert.equal(completed.logical.currentInclusion!.events[0]!.automationState, 'APPLIED');
});

test('coverage 7 and 33: restart broadcasts a persisted envelope once even after external semantic success', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  const task = fixture.store.listTasks()[0]!;
  const evidenceId = task.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  fixture.chain.seenIds.add(evidenceId.toLowerCase());
  task.inFlight = {
    purpose: {kind: 'SUBMISSION', evidenceIds: [evidenceId], sourceBlockHash: BLOCK_A}, transactionHash: DEST_TX, rawTransaction: RAW, nonce: 0, chainId: 102031,
    destination: fixture.config.dealsAddress, maximumLiability: '200', createdAt: new Date(1_000).toISOString(), broadcastCount: 0,
  };
  task.logical.sourceSubmissionState = 'SUBMISSION_IN_FLIGHT';
  fixture.store.writeTask(task);
  await fixture.engine.tick();
  assert.deepEqual(fixture.chain.broadcasted, [RAW]);
  assert.equal(fixture.store.readTask(task.taskId).inFlight?.broadcastCount, 1);
  assert.equal(fixture.chain.signCount, 0);
});

test('coverage 17 and 35: the persisted envelope deadline expires without bump, replacement or deletion', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  fixture.chain.broadcastError = new Error('underpriced');
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const deadline = fixture.store.listTasks()[0]!.inFlight!.resolutionDeadlineAt!;
  now = Date.parse(deadline) + 1;
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  assert.ok(task.inFlight);
  assert.equal(fixture.chain.signCount, 1);
  assert.equal(task.logical.sourceAttentionReason, 'IN_FLIGHT_RESOLUTION_WINDOW_EXPIRED');
});

test('coverage 25 and 35: operator exact-byte rebroadcast remains possible after expiry without resetting the deadline', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const initial = fixture.store.listTasks()[0]!;
  const deadline = initial.inFlight!.resolutionDeadlineAt!;
  now = Date.parse(deadline) + 1;
  await fixture.engine.resumeBroadcast(initial.taskId);
  const resumed = fixture.store.readTask(initial.taskId);
  assert.equal(resumed.inFlight!.resolutionDeadlineAt, deadline);
  assert.equal(resumed.inFlight!.broadcastCount, 2);
  assert.deepEqual(fixture.chain.broadcasted, [RAW, RAW]);
  assert.equal(fixture.chain.signCount, 1);
});

test('coverage 10 and 44: unexpected signer nonce blocks exact rebroadcast and sets only global attention', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  const priorState = task.logical.sourceSubmissionState;
  now += 5_000;
  fixture.chain.nonce = {latest: 1, pending: 1};
  await fixture.engine.tick();
  assert.deepEqual(fixture.chain.broadcasted, [RAW]);
  assert.match(fixture.store.readState().globalAttentionReasons[0]!, /UNEXPECTED_SIGNER_NONCE/);
  assert.equal(fixture.store.readTask(task.taskId).logical.sourceSubmissionState, priorState);
});

test('coverage 36: a receipt disappearing before confirmation depth restores unresolved exact-byte recovery', async () => {
  let now = 1_000;
  const fixture = setup([event(0, 'FUNDING', DEAL_A)], [DEAL_A], () => now);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const blockHash = `0x${'73'.repeat(32)}` as Hex;
  fixture.chain.destinationReceipts.set(DEST_TX, {hash: DEST_TX, status: 1, blockNumber: 30, blockHash, gasUsed: 1n, effectiveGasPrice: 1n});
  fixture.chain.canonicalHashes.set(30, blockHash);
  fixture.chain.destinationHeight = 31;
  await fixture.engine.tick();
  fixture.chain.destinationReceipts.delete(DEST_TX);
  now += 5_000;
  await fixture.engine.tick();
  assert.ok(fixture.store.listTasks()[0]!.inFlight);
  assert.deepEqual(fixture.chain.broadcasted, [RAW, RAW]);
});

test('coverage 20, 21 and 34: repayment remains pending across restart then gets an independent application epoch', async () => {
  const fixture = setup([event(0, 'REPAYMENT', DEAL_A)]);
  await fixture.engine.scanOnce();
  const task = fixture.store.listTasks()[0]!;
  const evidenceId = task.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  fixture.chain.seenIds.add(evidenceId.toLowerCase());
  fixture.chain.evidenceStates.set(evidenceId.toLowerCase(), {state: 'VERIFIED_PENDING', reason: 'NONE'});
  fixture.chain.deals.set(DEAL_A.toLowerCase(), {status: 1, designatedInvestor: INVESTOR});
  await fixture.engine.tick();
  assert.equal(fixture.store.listTasks()[0]!.logical.currentInclusion!.events[0]!.automationState, 'VERIFIED_PENDING');
  assert.equal(fixture.chain.signCount, 0);

  fixture.chain.deals.set(DEAL_A.toLowerCase(), {status: 2, designatedInvestor: INVESTOR});
  const restarted = new WorkerEngine(fixture.config, fixture.store, fixture.chain, {log: () => {}});
  await restarted.tick();
  const ready = fixture.store.listTasks()[0]!;
  assert.equal(ready.inFlight?.purpose.kind, 'APPLICATION');
  assert.ok(ready.logical.currentInclusion!.events[0]!.applicationEpoch);
  assert.equal(fixture.chain.signCount, 1);
});

test('coverage 23-25: resume creates epochs, refuses a live envelope, and resume-broadcast uses stored bytes', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  let task = fixture.store.listTasks()[0]!;
  task.logical.sourceSubmissionState = 'ATTENTION_REQUIRED';
  fixture.store.writeTask(task);
  await fixture.engine.resume(task.taskId);
  task = fixture.store.readTask(task.taskId);
  assert.equal(task.logical.submissionEpoch?.resumedByOperator, true);
  await fixture.engine.tick();
  task = fixture.store.readTask(task.taskId);
  await assert.rejects(() => fixture.engine.resume(task.taskId), /resume-broadcast/);
  const raw = task.inFlight!.rawTransaction;
  await fixture.engine.resumeBroadcast(task.taskId);
  assert.equal(fixture.chain.broadcasted.at(-1), raw);
  assert.equal(fixture.chain.signCount, 1);
});

test('coverage 29 and 37: same-hash re-inclusion re-decodes nonce and preserves immutable history', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  const replacementReceipt = receipt(BLOCK_B, 101);
  fixture.chain.sourceReceipts.set(TX, replacementReceipt);
  fixture.chain.decoded.set(BLOCK_B, [event(0, 'FUNDING', DEAL_A, BLOCK_B, 101, '99')]);
  fixture.chain.candidates = [candidate(replacementReceipt)];
  fixture.chain.head = 101;
  await fixture.engine.scanOnce();
  const task = fixture.store.listTasks()[0]!;
  assert.equal(task.logical.inclusionHistory.length, 1);
  assert.equal(task.logical.inclusionHistory[0]!.events[0]!.inclusionState, 'SUPERSEDED');
  assert.equal(task.logical.currentInclusion!.events[0]!.eventNonce, '99');
  assert.notEqual(task.logical.currentInclusion!.events[0]!.expectedEvidenceId, task.logical.inclusionHistory[0]!.events[0]!.expectedEvidenceId);
});

test('coverage 37: a source reorg after signing preserves the old envelope identity and the new inclusion', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const before = fixture.store.listTasks()[0]!;
  const oldId = before.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  const replacementReceipt = receipt(BLOCK_B, 101);
  fixture.chain.sourceReceipts.set(TX, replacementReceipt);
  fixture.chain.decoded.set(BLOCK_B, [event(0, 'FUNDING', DEAL_A, BLOCK_B, 101, '99')]);
  fixture.chain.candidates = [candidate(replacementReceipt)];
  fixture.chain.head = 101;
  await fixture.engine.scanOnce();
  let task = fixture.store.readTask(before.taskId);
  const newId = task.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  assert.notEqual(newId, oldId);
  assert.deepEqual(task.inFlight?.purpose, {kind: 'SUBMISSION', evidenceIds: [oldId], sourceBlockHash: BLOCK_A});
  assert.equal(task.logical.sourceAttentionReason, 'SOURCE_REORG_WITH_IN_FLIGHT_ENVELOPE');

  fixture.chain.seenIds.add(oldId.toLowerCase());
  const receiptHash = `0x${'75'.repeat(32)}` as Hex;
  fixture.chain.destinationReceipts.set(DEST_TX, {hash: DEST_TX, status: 1, blockNumber: 50, blockHash: receiptHash, gasUsed: 1n, effectiveGasPrice: 1n});
  fixture.chain.canonicalHashes.set(50, receiptHash);
  fixture.chain.destinationHeight = 52;
  await fixture.engine.tick();
  task = fixture.store.readTask(before.taskId);
  assert.equal(task.inFlight, undefined);
  assert.deepEqual(task.logical.operationHistory[0]!.purpose, {kind: 'SUBMISSION', evidenceIds: [oldId], sourceBlockHash: BLOCK_A});
  assert.equal(task.logical.currentInclusion!.events[0]!.expectedEvidenceId, newId);
  assert.equal(task.logical.sourceSubmissionState, 'ATTENTION_REQUIRED');
});

test('coverage 37: reorganization after destination evidence preserves both inclusions and raises an incident', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  const before = fixture.store.listTasks()[0]!;
  const oldId = before.logical.currentInclusion!.events[0]!.expectedEvidenceId;
  fixture.chain.seenIds.add(oldId.toLowerCase());
  const replacementReceipt = receipt(BLOCK_B, 101);
  fixture.chain.sourceReceipts.set(TX, replacementReceipt);
  fixture.chain.decoded.set(BLOCK_B, [event(0, 'FUNDING', DEAL_A, BLOCK_B, 101, '77')]);
  fixture.chain.candidates = [candidate(replacementReceipt)];
  fixture.chain.head = 101;
  await fixture.engine.scanOnce();
  const task = fixture.store.readTask(before.taskId);
  assert.equal(task.logical.inclusionHistory.length, 1);
  assert.ok(task.logical.currentInclusion);
  assert.equal(task.logical.sourceAttentionReason, 'SOURCE_REORG_AFTER_DESTINATION_RECORDING');
});

test('coverage 37: a different transaction hash creates a separate task rather than mutating the first', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  fixture.chain.sourceReceipts.set(TX, null);
  const otherTx = `0x${'11'.repeat(32)}` as Hex;
  const otherReceipt: RawSourceReceipt = {...receipt(BLOCK_B, 101), transactionHash: otherTx};
  otherReceipt.logs = otherReceipt.logs.map((log) => ({...log, transactionHash: otherTx}));
  const otherEvent = {...event(0, 'FUNDING', DEAL_A, BLOCK_B, 101, '88'), transactionHash: otherTx};
  fixture.chain.sourceReceipts.set(otherTx, otherReceipt);
  fixture.chain.decoded.set(BLOCK_B, [otherEvent]);
  fixture.chain.candidates = [candidate(otherReceipt)];
  fixture.chain.head = 101;
  await fixture.engine.scanOnce();
  const tasks = fixture.store.listTasks();
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((task) => task.logical.transactionHash === TX)!.logical.sourceSubmissionState, 'ORPHANED');
  assert.ok(tasks.find((task) => task.logical.transactionHash === otherTx)!.logical.currentInclusion);
});

test('coverage 16: simulation transport failure without revert data fails closed before signing', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  fixture.chain.simulation = {ok: false};
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  assert.equal(fixture.chain.signCount, 0);
  assert.equal(task.logical.sourceAttentionReason, 'SUBMISSION_SIMULATION_FAIL_CLOSED');
});

test('coverage 16 and 32: EvidenceAlreadyRecorded with an all-false expected set fails closed', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  fixture.chain.simulation = {
    ok: false,
    revertData: VERIFIER_ERRORS.encodeErrorResult('EvidenceAlreadyRecorded', [`0x${'01'.repeat(32)}`]),
  };
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  assert.equal(fixture.chain.signCount, 0);
  assert.equal(task.logical.sourceAttentionReason, 'ALREADY_RECORDED_WITH_ALL_FALSE_VISIBILITY');
});

test('coverage 6: a proof for a different source inclusion fails closed before signing', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  fixture.chain.proofOverride = {
    chainKey: 1, headerNumber: 999, txIndex: 2, txHash: TX, txBytes: '0x01',
    merkleProof: {root: BLOCK_A, siblings: []}, continuityProof: {lowerEndpointDigest: BLOCK_A, roots: []}, cached: false,
  };
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  assert.equal(fixture.chain.signCount, 0);
  assert.equal(task.logical.sourceAttentionReason, 'PROOF_SOURCE_INCLUSION_MISMATCH');
});

test('coverage 27: runtime drift is a warning, while deployment mismatch is a startup error', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  fixture.chain.runtime = {attestationInterval: 11, checkpointInterval: 10};
  await fixture.engine.startupChecks();
  assert.match(fixture.store.readState().runtimeObservation?.warning ?? '', /runtime drift/);
  fixture.chain.deploymentMismatch = true;
  await assert.rejects(() => fixture.engine.startupChecks(), /mismatch/);
});

test('coverage 42 and 45: mined application outcomes use post-state, including legal pending and permanent rejection', async () => {
  for (const postState of ['APPLIED', 'VERIFIED_PENDING', 'REJECTED_PERMANENT', 'UNSEEN'] as const) {
    const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
    await fixture.engine.scanOnce();
    const task = fixture.store.listTasks()[0]!;
    const evidenceId = task.logical.currentInclusion!.events[0]!.expectedEvidenceId;
    fixture.chain.seenIds.add(evidenceId.toLowerCase());
    fixture.chain.evidenceStates.set(evidenceId.toLowerCase(), {state: 'VERIFIED_PENDING', reason: 'NONE'});
    fixture.chain.deals.set(DEAL_A.toLowerCase(), {status: 2, designatedInvestor: INVESTOR});
    await fixture.engine.tick();
    fixture.chain.evidenceStates.set(evidenceId.toLowerCase(), {state: postState, reason: postState === 'REJECTED_PERMANENT' ? 'WRONG_INVESTOR' : 'NONE'});
    const blockHash = `0x${'72'.repeat(32)}` as Hex;
    fixture.chain.destinationReceipts.set(DEST_TX, {hash: DEST_TX, status: 1, blockNumber: 20, blockHash, gasUsed: 1n, effectiveGasPrice: 1n});
    fixture.chain.canonicalHashes.set(20, blockHash);
    fixture.chain.destinationHeight = 22;
    await fixture.engine.tick();
    assert.equal(
      fixture.store.listTasks()[0]!.logical.currentInclusion!.events[0]!.automationState,
      postState === 'UNSEEN' ? 'ATTENTION_REQUIRED' : postState,
    );
  }
});

test('coverage 42: mined revert resolves only the envelope and fails closed from post-state', async () => {
  const fixture = setup([event(0, 'FUNDING', DEAL_A)]);
  await fixture.engine.scanOnce();
  await fixture.engine.tick();
  const blockHash = `0x${'74'.repeat(32)}` as Hex;
  fixture.chain.destinationReceipts.set(DEST_TX, {hash: DEST_TX, status: 0, blockNumber: 40, blockHash, gasUsed: 10n, effectiveGasPrice: 3n});
  fixture.chain.canonicalHashes.set(40, blockHash);
  fixture.chain.destinationHeight = 42;
  await fixture.engine.tick();
  const task = fixture.store.listTasks()[0]!;
  assert.equal(task.inFlight, undefined);
  assert.equal(task.logical.sourceAttentionReason, 'MINED_REVERT_WITHOUT_SEMANTIC_SUCCESS');
  assert.equal(task.logical.operationHistory[0]!.receiptStatus, 0);
});

function setup(events: DecodedGatewayEvent[], enrollments: Hex[] = [DEAL_A, DEAL_B], now: () => number = () => 1_000) {
  const config = workerConfig();
  const stateDir = join(mkdtempSync(join(tmpdir(), 'cr3dx-engine-')), 'state');
  mkdirSync(stateDir, {mode: 0o700});
  const store = new StateStore(stateDir);
  store.bootstrap(`0x${'12'.repeat(20)}`, 0, new Date(0));
  const state = store.readState();
  for (const dealId of enrollments) state.enrollments[dealId.toLowerCase()] = {dealId, effectiveFromSourceBlock: 100, enrolledAt: new Date(0).toISOString()};
  store.writeState(state);
  const chain = new FakeChain();
  const sourceReceipt = receipt();
  chain.sourceReceipts.set(TX, sourceReceipt);
  chain.decoded.set(BLOCK_A, events);
  chain.candidates = [candidate(sourceReceipt)];
  const engine = new WorkerEngine(config, store, chain, {now, random: () => 0.5, log: () => {}});
  return {config, store, chain, engine};
}

function receipt(blockHash = BLOCK_A, blockNumber = 100): RawSourceReceipt {
  return {
    transactionHash: TX, blockNumber, blockHash, transactionIndex: 2, status: 1,
    logs: [{address: GATEWAY, topics: [workerConfig().fundingTopic], data: `0x${'00'.repeat(64)}`, logIndex: 7, transactionHash: TX}],
  };
}

function candidate(sourceReceipt: RawSourceReceipt): CandidateLogRef {
  return {transactionHash: sourceReceipt.transactionHash, blockNumber: sourceReceipt.blockNumber, blockHash: sourceReceipt.blockHash, logIndex: 7, topic0: workerConfig().fundingTopic};
}

function event(ordinal: number, kind: 'FUNDING' | 'REPAYMENT', dealId: Hex, blockHash = BLOCK_A, blockNumber = 100, nonce = String(ordinal + 1)): DecodedGatewayEvent {
  return {
    sourceChainId: 11155111, transactionHash: TX, sourceBlockNumber: blockNumber, sourceBlockHash: blockHash,
    transactionIndex: 2, transactionLogOrdinal: ordinal, rpcLogIndex: 7 + ordinal, emitter: GATEWAY, kind, dealId,
    counterparty: INVESTOR, recipient: kind === 'FUNDING' ? BORROWER : INVESTOR, amount: '100', eventNonce: nonce,
  };
}

function workerConfig(): WorkerConfig {
  return {
    stateDir: '/unused', sourceRpcUrl: 'http://source', destinationRpcUrl: 'http://destination', destinationSubstrateRpcUrl: 'http://substrate',
    proofBuilderUrl: 'http://proof', sourceChainId: 11155111, sourceChainKey: 1, destinationChainId: 102031, sourceStartBlock: 100,
    gatewayAddress: GATEWAY, verifierAddress: `0x${'81'.repeat(20)}`, dealsAddress: `0x${'80'.repeat(20)}`,
    fundingTopic: `0x${'90'.repeat(32)}`, repaymentTopic: `0x${'91'.repeat(32)}`, pollIntervalMs: 5_000,
    limits: {maxNonTerminalTasks: 1_000, maxEventsPerTransaction: 32, transactionGasCap: 1_000n, maxFeePerGasCap: 100n, rolling24HourFeeBudget: 1_000_000n, minimumSignerBalanceReserve: 1n},
  };
}
