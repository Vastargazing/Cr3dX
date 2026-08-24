# Cr3dX S6 — permissionless proof worker

Status: accepted normative S6 implementation specification.

Target base: current `main` commit `cbbb33062a1743d1bf8e88e8f6ee2604fbe77c4e`.

The contract tree at this base is unchanged from `777c05fb2e2757974beb3e55041dd9da9180ee29`. The intervening commits add three audit documents. Their findings are normative inputs to S6 where this document cites them, especially the P0 secret-provisioning finding in `docs/audit/readme-audit.md`.

Phase B authority:

- specification v0.4.8: `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`;
- aligned implementation: `1a308816ab3b73056718f6f174c47c10f9fb8cd3`;
- verification checkpoint: `a5259e2837cbb96fc33fadd9e0bc19317f427754`;
- Phase B: `63/63 matched`.

This document defines the S6 worker. It does not alter contract semantics.

## 1. Objective

The worker autonomously carries confirmed external payment events from Sepolia to the Cr3dX credit layer on Creditcoin:

1. observe relevant `GateLog` events;
2. persist their identities;
3. wait until the source transaction is attestable;
4. request a fresh Attestcoin proof;
5. submit the proof through the public verifier interface;
6. apply resulting evidence through public deal interfaces;
7. revisit evidence that remains pending until its prerequisites become satisfied.

The worker must survive process restarts, provider failures and ambiguous transaction broadcasts without losing a fact or creating an unsafe alternative transaction.

## 2. Trust model

The worker is an untrusted liveness component.

It may delay progress or stop. It cannot forge a fact, bypass proof verification or mutate credit state without satisfying the same public contract checks available to every address.

S6 must not add:

- worker-only contract methods;
- privileged worker roles;
- exclusive submission rights;
- a trusted off-chain decision that changes protocol correctness;
- contract changes of any kind.

Manual submission by an arbitrary address remains possible at all times.

## 3. Normative sources

Implementations must read and follow:

- the sealed Cr3dX specification v0.4.8;
- `docs/ATTESTCOIN_INTEGRATION.md`;
- the current `docs/STATUS.md`;
- `docs/audit/readme-audit.md` at the target base;
- the existing S5 safe-broadcast and resume implementation;
- the deployed public ABIs.

Where this S6 document conflicts with those sources, implementation must stop and report the conflict instead of silently choosing behavior.

## 4. Event identity and transaction grouping

One source transaction may emit multiple relevant facts.

The identity of an event record within one concrete source inclusion is:

```text
sourceChainId + transactionHash + sourceBlockHash + transaction-local log ordinal
```

The transaction-local ordinal is the event's position inside that transaction's receipt logs. It is not the RPC block-global `logIndex`, which can change if the same transaction is re-included in a different block. The current block-global index is stored only as inclusion metadata. Event kind plus the gateway's decoded `eventNonce` is a fingerprint of one concrete source inclusion, not a stable cross-reorganization identity: gateway execution may assign a different nonce when the same transaction is re-included under different preceding state. The stable cross-inclusion task identity is only `(sourceChainId, transactionHash)`; inclusion-specific event records are versioned beneath it.

Each observation also stores:

- source block number;
- source block hash;
- emitting contract address;
- decoded event type and fields;
- first-observed timestamp.

Attestcoin proof generation and verifier submission operate at source-transaction granularity. Therefore event records remain distinct while events sharing `(sourceChainId, transactionHash)` may share one proof/submission job.

The persistent `taskId` is a deterministic filesystem-safe encoding or hash of `(sourceChainId, transactionHash)`. It is stable across restart and never derived from local insertion order. All event records belonging to that source transaction are stored under the same task.

The implementation must not assume one transaction produces one fact.

### 4.1 Admission and resource policy

“Relevant” does not mean every syntactically valid event emitted by the public gateway. The worker is a permissionless protocol participant spending its own gas, not a public promise to subsidize every gateway user.

Because verifier submission processes every matching gateway log in a source transaction atomically, admission is decided for the complete source transaction, not independently per selected log. A transaction is admitted only when all of the following hold:

1. its source chain, gateway address and topic equal the configured deployment;
2. the complete canonical source receipt has `status == 1`, and its log set and shapes decode canonically;
3. every verifier-relevant gateway event in that transaction has a `dealId` explicitly enrolled for its source block;
4. the task and complete transaction event limits below are not exceeded.

A transaction mixing enrolled and unenrolled deal events is not partially submitted. Its enrolled records become visible as `ATTENTION_REQUIRED` with reason `MIXED_ADMISSION`; the worker never assumes it can make the verifier record only a subset.

Enrollment controls only this worker's willingness to spend gas. It creates no on-chain privilege and does not prevent anyone from submitting an unenrolled fact manually. Enrollment is persisted and auditable. The MVP does not infer enrollment merely from arbitrary gateway traffic.

Every enrollment stores `effectiveFromSourceBlock`. Ordinary `enroll <dealId>` reads a canonical source head and sets the value to `head + 1`, so local wall-clock order is irrelevant to later backfill. A retroactive value is accepted only through an explicit `enroll <dealId> --effective-from <block>` operator command and records the requested block, current head, timestamp and operator reason in the audit history. Admission requires `event.blockNumber >= effectiveFromSourceBlock` for every relevant event in the transaction.

Normative limits:

- at most 1,000 non-terminal tasks in the queue;
- at most 32 admitted gateway events in one source transaction;
- operator-supplied non-zero caps for transaction gas, maximum fee per gas, rolling 24-hour fee budget and minimum signer balance reserve; monetary caps have no unsafe built-in defaults;
- before signing, both the estimate and the final populated `gasLimit` must fit the gas-limit cap; budget accounting uses the final transaction's maximum liability: `gasLimit * maxFeePerGas` for EIP-1559 or `gasLimit * gasPrice` for a legacy transaction;
- every unresolved envelope reserves its full maximum liability; the rolling budget equals confirmed `gasUsed * effectiveGasPrice` fees in the preceding 24 hours by destination block time plus all unresolved reservations plus the proposed transaction's liability;
- after destination confirmation, the envelope reservation is replaced by that actual receipt fee and the unused difference is released.

A transaction whose complete canonical receipt contains no log matching the configured gateway address and either configured topic is safely irrelevant and creates no task. A valid matching transaction whose relevant deal set is entirely unenrolled likewise creates no task and consumes no destination gas; its bounded structured admission log records the source identity and rejection reason, while the durable cursor records scan progress.

If `eth_getLogs` reports the configured gateway/topic but the complete canonical receipt has `status != 1`, omits that reported log, or contains a matching log whose shape contradicts the configured ABI, this is not an irrelevant transaction. It is a provider, deployment or decoder inconsistency: set worker-level `GLOBAL_ATTENTION_REQUIRED` and do not advance the durable cursor past the candidate log.

If an enrolled event cannot be admitted because a queue or resource limit is reached, ingestion stops before advancing the durable cursor past that log and exposes worker-level `GLOBAL_ATTENTION_REQUIRED`; the event must not be silently skipped. If a queued operation exceeds a fee or balance cap, its retry epoch pauses in `ATTENTION_REQUIRED` without signing or deleting the task.

## 5. Persistent state

The MVP uses human-readable JSON files on disk. SQLite and other databases are out of scope.

Layout:

```text
<stateDir>/
  worker-state.json
  worker.lock
  tasks/
    <taskId>.json
```

Each source-transaction task has one JSON file. Distinct event identities from that transaction are stored as an evidence-record array inside the task. Every evidence record stores its own inclusion state, expected identifier for that inclusion, canonical contract state, automation state, application-attempt epoch, rejection reason and transition history. The task file also stores the source-transaction submission state and submission-attempt epoch shared by the current inclusion array. Superseded inclusion arrays remain in append-only history.

The task file contains structurally separate `logical` and optional `inFlight` sections, so an unresolved signed envelope can be committed atomically with its task or evidence transition. An envelope identifies exactly one purpose: submission of the source transaction or application of one evidence ID.

`worker-state.json` stores the schema version, source cursor, enrollments and global worker metadata. It may contain a recomputable budget cache, but that cache is never authoritative.

Each task file stores the maximum-liability reservation beside its unresolved envelope and stores confirmed receipt fees in its immutable operation history. Creating an envelope and its reservation is one atomic task-file replacement. Resolving the envelope converts that reservation into `gasUsed * effectiveGasPrice` confirmed fee in the same atomic replacement that records the canonical receipt and clears the raw envelope.

On startup and before every budget decision, unresolved liability and rolling actual fees are derived from all authoritative task files. A missing, stale or inconsistent `worker-state.json` cache is discarded and rebuilt. Therefore a crash cannot resolve an envelope in one file while leaving the authoritative fee ledger understated in another.

The unresolved global write lane is likewise derived and cross-checked from task files; more than one unresolved `inFlight` section is corruption and blocks startup.

Every write uses a temporary file in the same directory, flushes it, atomically renames it over the destination and flushes the directory. Orphan temporary files are never treated as committed state. Files use mode `0600` and the state directory uses `0700`; signing is refused when the underlying filesystem cannot enforce the required permissions.

The logical task record may persist:

- event and transaction identities;
- decoded metadata;
- source block identity;
- workflow state;
- retry-window timestamps;
- evidence identifiers;
- public on-chain transaction hashes;
- receipt and error classifications;
- an audit history of state transitions.

The logical task record must not persist:

- a reusable Attestcoin proof;
- proof bytes intended for a future logical attempt;
- a proof fixture as production input;
- private keys.

Writes must be atomic. The MVP is single-process and must use a kernel-held, non-blocking exclusive advisory lock for the lifetime of the process. The pathname `worker.lock` is only the inode on which that lock is held; its continued existence after a crash is harmless. A mere `O_EXCL` lock file, PID file or unconditional stale-file deletion is not sufficient. Kernel release after process death permits restart, while a live holder makes a second process fail before reading secrets or signing.

The in-flight envelope defined below is a separate recovery record. Its signed raw transaction may contain proof bytes inside calldata. This is explicitly allowed: the worker is preserving an already signed transaction whose chain outcome is unknown, not caching a proof for reuse in another transaction.

Tests for “no stored proof” apply to logical task records, logs and future-attempt caches. They must not reject proof bytes that occur only inside the exact signed raw transaction of an unresolved in-flight envelope.

### 5.1 Global nonce ownership

The MVP permits only one worker-originated state-changing transaction in flight globally across all tasks and operation types. This includes verifier submissions and address-specific evidence application.

While an envelope with nonce `N` is unresolved, no task may sign or broadcast a transaction with nonce `N+1` or any later nonce. Observation, backfill and read-only reconciliation may continue, but the global write lane remains blocked.

This condition is displayed as a separate global overlay:

```text
BLOCKED_BY_GLOBAL_LANE(ownerTaskId, nonce)
```

It does not rewrite unrelated task or evidence states to `ATTENTION_REQUIRED`. They retain their own derived states while the scheduler refuses state-changing work. Global configuration/invariant failures may separately put the worker itself into `GLOBAL_ATTENTION_REQUIRED`.

This is a whole-worker write halt, not merely a pause of the owning task. It prevents verifier submission for every other source transaction and prevents application of already-pending funding or repayment evidence. A single stuck transaction can therefore stop all automated economic progress until it resolves or an operator intervenes. This is an accepted MVP liveness limitation and must be visible in status output and the live runbook.

The worker signer must be dedicated to one running worker instance. Before signing, the worker reconciles its local envelope with the signer’s pending on-chain nonce. An unexpected nonce change sets worker-level `GLOBAL_ATTENTION_REQUIRED` until on-chain state is reconciled; it does not rewrite unrelated task states.

This serialization is an intentional MVP throughput tradeoff. It prevents nonce gaps, cross-task replacement races and multiple tasks independently guessing the signer nonce.

### 5.2 Lost local state

Deterministic source identities, GateLog backfill and `seen(evidenceId)` can reconstruct much of the logical queue, but they cannot reconstruct the exact raw bytes of a lost unresolved in-flight envelope. A false `seen` read also cannot prove that the lost transaction is absent from the mempool.

Therefore catastrophic loss or deletion of the established state directory is not automatically recoverable in the MVP. The worker must not silently recreate an empty queue and continue signing with the same signer.

A missing state directory is accepted only through an explicit first-run/bootstrap operation after the operator establishes that the dedicated signer has no unresolved nonce. Otherwise startup fails with `ATTENTION_REQUIRED` guidance for manual nonce and on-chain evidence reconciliation. State-directory backup is an operator responsibility.

## 6. State machine

There are three distinct state layers. They must not be collapsed into one mutable enum.

### 6.1 Source-transaction submission state

| State | Meaning |
|---|---|
| `OBSERVED` | All currently canonical admitted events for the transaction are persisted. |
| `WAITING_ATTESTATION` | The source transaction is not yet provable with a current proof. |
| `READY_FOR_PROOF` | A submission epoch may obtain a fresh proof. |
| `SUBMITTING` | A fresh proof is being obtained and a submission transaction prepared. |
| `SUBMISSION_IN_FLIGHT` | An exact signed verifier-submission envelope exists. |
| `SUBMITTED` | The complete expected evidence-ID set is present on the verifier. |
| `ORPHANED` | The observed source inclusion was removed before destination finalization. |
| `ATTENTION_REQUIRED` | Submission automation stopped and operator action is required. |
| `FAILED` | Irrecoverable local schema/data corruption. |

### 6.2 Per-evidence state

Source inclusion and destination contract state are orthogonal fields. Every evidence record has:

```text
inclusionState = CURRENT | SUPERSEDED | ORPHANED
```

Only a `CURRENT` inclusion may drive new proof or application work. `SUPERSEDED` and `ORPHANED` records remain historical and never masquerade as a destination rejection.

| State | Meaning |
|---|---|
| `UNSEEN` | The expected identifier is absent from the verifier. |
| `VERIFIED_PENDING` | The verifier holds the fact, but `Cr3dXDeals` reports that an application prerequisite is missing. |
| `READY_TO_APPLY` | A previously pending fact is now eligible for an address-specific application attempt. |
| `APPLICATION_IN_FLIGHT` | An exact signed application envelope exists for this evidence ID. |
| `APPLIED` | `Cr3dXDeals` reports `APPLIED`. |
| `REJECTED_PERMANENT` | `Cr3dXDeals` reports `REJECTED_PERMANENT`, with its canonical reason. |
| `ATTENTION_REQUIRED` | This evidence cannot continue automatically, but remains persisted. |

`APPLIED` and `REJECTED_PERMANENT` are terminal for one evidence record. A source transaction may legitimately contain evidence records in different states at the same time.

### 6.3 Derived aggregate task state

The displayed aggregate task state is derived, never independently written. The global lane overlay is displayed alongside it and is not part of this precedence. Apply the first matching rule in this order:

1. `FAILED` if the task record has irrecoverable local corruption;
2. `ATTENTION_REQUIRED` if the source task or any current evidence record requires attention;
3. `WAITING_RECEIPT` if any unresolved exact envelope belongs to the task;
4. `ORPHANED` if the source task has no current canonical inclusion;
5. the current source-submission state while any current expected evidence remains `UNSEEN`;
6. `READY_TO_APPLY` if any current evidence is ready for application;
7. `VERIFIED_PENDING` if any current evidence remains pending;
8. `COMPLETED_WITH_REJECTIONS` if every current evidence is terminal and at least one is `REJECTED_PERMANENT`;
9. `COMPLETED` if every current evidence is `APPLIED`.

The aggregate view also reports counts for every per-evidence state. It never erases a mixed outcome behind a single success flag.

Every transition is persisted with timestamp and reason.

`ATTENTION_REQUIRED` is not a terminal protocol failure. It does not delete the task or modify the evidence status on-chain.

## 7. Proof lifecycle

### 7.1 Before signing

A proof is a short-lived transport artifact.

- Fetch it immediately before building a new submission transaction.
- Do not store it in the logical queue.
- Do not log it.
- Do not reuse it after restart.
- If the worker crashes after fetching but before signing, fetch a new proof.
- Every new logical submission attempt obtains a fresh proof.

### 7.2 After signing and first broadcast attempt

An exact signed transaction is not a reusable proof cache. It is the recovery record of a transaction whose chain outcome may already exist.

Before broadcast, compute the transaction hash and atomically persist an in-flight envelope containing:

```text
transaction hash
signed raw transaction bytes
nonce
chain id
destination
task/purpose identity
first and last broadcast timestamps
first-broadcast resolution deadline
receipt block number and hash when observed
destination confirmation progress
```

If broadcast returns a timeout or otherwise unknown result:

- query by the precomputed transaction hash;
- do not fetch a new proof;
- do not sign another transaction;
- do not change nonce or calldata;
- rebroadcast only the exact same raw bytes.

This remains true across restart.

No alternative transaction for the same operation may be created while the in-flight outcome is unknown.

Persisting an exact signed envelope commits the worker to broadcasting those bytes at least once. If an external actor satisfies the semantic operation after the envelope is persisted but before its first broadcast, the worker still broadcasts only the saved exact bytes and starts the envelope-resolution window. This may intentionally produce a confirmed duplicate revert and spend gas; it resolves the already chosen nonce without inventing an alternative signature. A crash in the signed-before-broadcast boundary follows the same rule on restart.

Semantic satisfaction and envelope resolution are independent facts. Discovery that the intended evidence or application state already exists stops creation of new logical attempts, but does not cancel an already persisted envelope, prove what happened to the worker's transaction or free its nonce.

An exact envelope is automatically resolved only when the exact precomputed transaction hash has a successful or reverted receipt in the canonical destination chain and two additional destination blocks have been built after its receipt block. At each check, the receipt block hash must still resolve to the same canonical block. A confirmed revert resolves the nonce but not necessarily the semantic operation.

`seen == true`, expected application state, a missing receipt, `latestNonce > N`, or a receipt for an unknown replacement does not by itself resolve the exact envelope. An unexplained consumed nonce or replacement sets worker-level `GLOBAL_ATTENTION_REQUIRED` for explicit operator reconciliation without rewriting unrelated task states.

After both semantic and envelope outcomes are resolved as applicable:

- on success, confirm actual on-chain state;
- on confirmed revert, close and classify the envelope;
- only a subsequent logical attempt may fetch a fresh proof;
- remove raw bytes from active state only after the destination-confirmation rule above, retaining public audit metadata.

The same exact-rebroadcast rule applies to state-changing `applyEvidence` transactions.

### 7.3 On-chain reconciliation and precomputed evidence IDs

For every gateway log that the verifier will treat as relevant in the complete source transaction, the worker computes the expected identifier before submission through the verifier’s canonical function:

```text
evidenceIdOf(height, txIndex, kind, eventNonce)
```

The identifier is independent of the verifier deployment instance and is stored with the task before broadcast.

At startup, after an RPC timeout and before any rebroadcast, the worker queries canonical on-chain state:

- `seen(evidenceId)` for verifier submission;
- stored evidence status and the relevant deal/economic state for application.

On-chain state is authoritative for semantic operation state, while the exact canonical receipt is authoritative for envelope/nonce resolution:

- if every expected `seen(evidenceId)` is true, verifier submission is semantically satisfied even when the worker receipt is unavailable; stop treating submission as semantically outstanding and reconcile every evidence record;
- if the expected application state is already present, the application operation is semantically satisfied even when the worker receipt is unavailable; any worker envelope remains independently unresolved;
- a receipt alone does not replace final state reconciliation.

For one admitted source transaction, the complete expected evidence-ID set is atomic at the verifier. Before signing and during every reconciliation, the observed set must therefore be either all false or all true:

- all false permits a new submission only when no unresolved envelope exists and the submission epoch permits it;
- all true marks semantic submission satisfied;
- a mixed set is an invariant violation caused by decoder/configuration mismatch, wrong deployment or corrupted assumptions. It transitions the owning task to `ATTENTION_REQUIRED` and sets worker-level `GLOBAL_ATTENTION_REQUIRED`; the worker must not submit only the apparently missing subset or rewrite unrelated task states.

The inference is intentionally one-sided. `seen(evidenceId) == false` proves only that evidence is not present at the queried state. It does not prove that the signed transaction is absent from the mempool or cannot still be included. Therefore a false read never authorizes a different signed transaction while the original envelope remains unresolved.

### 7.4 Pre-sign simulation and mined outcome classification

An ordinary EVM receipt exposes only success or failure status; it does not contain revert data. Exact error selectors are therefore a pre-sign simulation input, not a normative property of a mined receipt.

Before signing every submission or application transaction, run `eth_call` and gas estimation against the same destination, sender, value and calldata. Classify returned revert data with this closed allowlist:

| Pre-sign result | Automatic action |
|---|---|
| Simulation succeeds | Apply gas, fee, balance and budget policy, then sign if the relevant epoch still permits it. |
| `EvidenceAlreadyRecorded` | Query the complete expected ID set. All true means semantic submission is already satisfied and no new envelope is created; mixed or all false means `ATTENTION_REQUIRED`. |
| ABI-decoded `Error(string)` whose string equals exactly `Continuity proof does not match attestation or checkpoint` | The sole automatically refreshable pre-sign error. Discard the unsaved proof and fetch a fresh proof within the submission epoch. No envelope exists yet. |
| `SourceTransactionFailed` for an already admitted task | Provider, receipt, decoder or proof inconsistency, because admission required canonical `status == 1`; transition to `ATTENTION_REQUIRED`. |
| `NoRelevantEvidence`, `MalformedGatewayLog` or malformed transaction/proof input | Decoder, gateway or configuration mismatch; `ATTENTION_REQUIRED`. |
| `UnknownEvidence` during application | Deployment/state mismatch; `ATTENTION_REQUIRED`. |
| Gas estimate exceeds cap, insufficient balance, fee-budget exhaustion or maximum-liability check fails | Resource/policy stop; `ATTENTION_REQUIRED`, with no signature. |
| Any unknown revert selector or inconsistent decoded result | Fail closed to `ATTENTION_REQUIRED`; record only selector/hash and safe metadata. |

The refresh allowlist contains exactly the one string above. Matching occurs after ABI decoding, not by substring or raw-byte search. Any other selector, any other `Error(string)` value, malformed revert data or future protocol error transitions to `ATTENTION_REQUIRED`. Expanding the allowlist requires a new reviewed document revision.

After a mined receipt reaches the destination-confirmation depth:

- Successful verifier submission (`status == 1`): resolve the envelope/nonce and require the complete expected ID set to be all true. Any other result is `ATTENTION_REQUIRED`.
- Successful `applyEvidence` (`status == 1`): resolve the envelope/nonce and query that evidence's canonical `evidenceStateOf` result. `APPLIED` and `REJECTED_PERMANENT` are terminal; `VERIFIED_PENDING` is a valid non-error result that is persisted and ends the current application epoch; `UNSEEN` is inconsistent and transitions to `ATTENTION_REQUIRED`.
- Mined revert (`status == 0`): resolve the envelope/nonce, but do not infer a selector. Read the complete semantic state. If all expected IDs are seen or the intended application is already terminal, mark the semantic operation satisfied; otherwise transition to `ATTENTION_REQUIRED`. Do not automatically create a fresh-proof attempt from receipt status alone.

An optional debug/trace RPC may be stored as additional diagnostic provenance, but S6 correctness and recovery must not depend on trace availability.

An RPC, proof-builder or provider transport failure before signing is retryable within the relevant attempt epoch. Any error returned after an exact signed transaction has been handed to a broadcast API is treated as an ambiguous broadcast unless the canonical chain later supplies a qualifying receipt; only exact raw-byte rebroadcast is allowed meanwhile.

## 8. Attestation timing and proof freshness

The worker uses approximately 20 minutes, roughly 100 source blocks from the attested head, as an operational freshness target.

This target is not:

- a proof-expiry guarantee;
- a correctness deadline;
- a reason to delete a task;
- evidence that an old fact became permanently unprovable.

Late proof generation may produce a longer proof and increase submission cost by approximately 34,000 gas. The worker should act promptly without changing task semantics when the target is missed.

## 9. Retry policy

Automatic retry ceilings are based on elapsed time, not attempt count. Retry time is represented by persisted attempt epochs rather than one task-wide clock.

Normative MVP parameters:

| Parameter | Value |
|---|---|
| Submission epoch | 6 hours from first entry into `READY_FOR_PROOF` or explicit manual resume |
| Application epoch | 6 hours per evidence ID from each transition into `READY_TO_APPLY` or explicit manual resume |
| In-flight resolution window | 6 hours from the envelope's first broadcast attempt |
| Initial delay | 5 seconds |
| Multiplier | 2 |
| Maximum delay | 5 minutes |
| Jitter | uniform from -10% to +10% |

The delay sequence before jitter is `5s, 10s, 20s, 40s, 80s, 160s, 300s`, then remains capped at 300 seconds. A delay is also capped by the remaining applicable epoch/window, so the worker never sleeps past its deadline.

Tests use an injected clock and deterministic random source.

Observation time and time spent only in `WAITING_ATTESTATION` do not consume the submission epoch. The initial submission epoch is created atomically when the task first becomes `READY_FOR_PROOF`. Provider downtime before that transition may delay readiness but cannot exhaust retries before the first submission attempt becomes possible.

Each evidence record owns an independent application epoch. Time spent in `VERIFIED_PENDING` does not consume it. When a prerequisite change first makes that evidence `READY_TO_APPLY`, a new six-hour application epoch is created atomically. One evidence can therefore become applicable days after submission without inheriting an expired submission clock or another evidence's application clock.

The in-flight resolution window is attached to an exact envelope, starts at its first broadcast attempt and is never reset by restart or exact-byte rebroadcast. It is not an attempt epoch and does not authorize a new signature when it expires.

Requirements:

- persist every epoch start and deadline;
- restart does not reset it;
- use the parameters above;
- jitter must not make the deadline unbounded;
- reaching the ceiling transitions to `ATTENTION_REQUIRED`;
- the task and metadata remain stored;
- manual resume creates new explicit epochs only for eligible retryable task/evidence records and writes an audit entry.

Attestation waiting and transaction-outcome resolution must be distinguishable from ordinary retryable errors.

### 9.1 Stuck transactions and gas replacement

The MVP performs no automatic gas-price bump, same-nonce replacement or cancellation transaction.

Rebroadcasting exact bytes may not advance an underpriced transaction. When the defined in-flight resolution window is exhausted:

- the owning task transitions to `ATTENTION_REQUIRED`;
- the unresolved envelope remains preserved;
- the global write lane remains blocked because its nonce is unresolved;
- other tasks may continue read-only progress but may not sign later nonces;
- the operator decides whether to wait, rebroadcast the same bytes or perform an explicit external nonce intervention.

If an operator replaces or cancels the nonce outside worker automation, the worker must detect the nonce change, reconcile expected on-chain evidence/application state and require an explicit resume. The worker never silently signs an automatic replacement.

## 10. Source ingestion

The worker persists its source cursor and performs backfill after restart.

On every startup with an existing cursor, scanning begins at:

```text
max(configuredSourceStartBlock, savedCursorBlock - 100)
```

RPC log queries use inclusive windows of at most 1,000 blocks. Replayed overlap and inclusive boundary duplicates are harmless because event identity is deterministic.

On an explicit first-run/bootstrap operation, `configuredSourceStartBlock` is mandatory and must be the GateLog deployment block or an explicitly audited later block. The worker must not guess a recent starting height. This operation is distinct from unexpectedly finding a missing state directory for an already established worker; that condition follows section 5.2 and must not silently bootstrap.

For each window, relevant events are durably written before the cursor advances past that window. Cursor writes use the same atomic file protocol as task writes.

It must handle:

- duplicate log delivery;
- provider reconnect;
- source cursor recovery;
- multiple relevant logs in one transaction;
- source block hash changes before proof availability;
- logs removed by a source reorganization.

An observed RPC log alone is not the final cryptographic boundary. Proof availability and verifier acceptance remain authoritative.

### 10.1 Source reorganization transitions

Every admitted event retains its current source block number, block hash and transaction index plus an append-only inclusion history.

- If a log is removed before signing and the transaction has no new canonical inclusion, set the old records' `inclusionState = ORPHANED`, set the source task to `ORPHANED`, retain a tombstone and do not fetch or submit a proof. Their destination contract state remains a separate field.
- If the same transaction hash is canonically re-included before signing, fetch its complete new canonical receipt, require `status == 1`, decode every gateway log again and repeat whole-transaction admission against the new block and enrollment effective heights. Height, transaction index, log positions, event nonces and therefore the complete evidence-ID set may all differ.
- For an accepted re-inclusion, mark the prior inclusion array `SUPERSEDED`, append it unchanged to history, create a new `CURRENT` evidence array, compute new expected IDs and return the source task to `WAITING_ATTESTATION`. Never mutate old event nonces or IDs into the new inclusion.
- If the re-included transaction fails canonical receipt validation or whole-transaction admission, preserve the prior array as `SUPERSEDED` and transition the task to `ATTENTION_REQUIRED`; do not submit a partial or stale set.
- A replacement transaction with a different hash is a different task. The old task remains an `ORPHANED` tombstone; it is never rewritten into the replacement.
- If the affected source task already has an exact signed destination envelope, do not alter or delete that envelope. Mark that task `ATTENTION_REQUIRED`, retain the `BLOCKED_BY_GLOBAL_LANE` overlay and continue nonce reconciliation only; unrelated task states remain unchanged.
- If any old expected evidence ID is already present on the destination, source reorganization is a protocol-level incident the worker cannot undo. Preserve both inclusion histories and all destination facts, stop automation for the task with `ATTENTION_REQUIRED`, and emit a high-severity structured alert.

Tombstones and superseded inclusion metadata are not garbage-collected during S6. No reorganization transition authorizes a different transaction while an exact destination envelope remains unresolved.

## 11. Runtime configuration

At startup, read from the Creditcoin runtime:

- attestation interval;
- checkpoint interval.

Log both values structurally. Compare them with documented assumptions.

A mismatch produces a warning but does not invalidate a proof or block the worker. If the runtime values cannot be read at all, report an explicit startup/configuration error.

Do not claim an accessor that the integration documentation does not confirm.

## 12. No worker batching and external-submission races

The MVP worker does not call cross-task batch submission or batch application methods. It uses one source-transaction submission at a time and address-specific evidence application.

This removes atomic batch rollback and batch rebuilding from the worker state machine. Contract batch semantics remain covered by the v0.4.8 contract and Phase B suites, but are not an S6 automation feature.

An external address may still submit the same source transaction, either singly or as part of its own batch, between worker preflight and worker broadcast.

The worker must:

1. compute and query all expected evidence IDs before signing;
2. retain the original task if an external submission wins the race;
3. require the complete expected-ID set to be all false or all true;
4. use `seen(evidenceId)` and stored evidence state as semantic authority;
5. treat an already-present complete set as semantically satisfied rather than lost;
6. keep any worker envelope and its nonce lane unresolved until the independent receipt rule in section 7.2 is satisfied;
7. reconcile a confirmed duplicate revert through the matrix in section 7.4 without creating an unsafe alternative transaction;
8. continue address-specific application for each evidence record still requiring it.

The external-submission race is a required deterministic and live test, not a demo-time contingency.

## 13. Pending evidence

The contracts do not automatically revisit old pending evidence.

The worker must persist its evidence IDs and re-evaluate them after relevant prerequisites change.

Required scenario:

1. repayment arrives before funding;
2. repayment evidence becomes pending;
3. worker persists the evidence ID and reason;
4. funding later becomes applied;
5. worker calls address-specific `applyEvidence` for repayment;
6. the process survives restart between any steps.

## 14. Operator interface

The worker exposes commands or equivalent operations to:

- run continuously;
- explicitly bootstrap a new empty state directory only after the signer-nonce safety check in section 5.2;
- enroll and list serviced deal IDs with their `effectiveFromSourceBlock`, including an explicitly audited retroactive-enrollment form;
- list the queue;
- inspect a task without exposing secrets or proof bytes;
- list `ATTENTION_REQUIRED` tasks;
- run `resume <taskId>` to create new eligible submission/application epochs with timestamp and audit reason `manual operator resume`;
- run `resume-broadcast <taskId>` to re-check canonical on-chain state and, only if still unresolved, rebroadcast the exact stored raw transaction;
- manually advance a selected task through public methods;
- safely resume an unresolved broadcast using its stored exact envelope.

Manual operations use the same permissionless contract interfaces as automation.

`resume <taskId>` is rejected while the task has an unresolved in-flight envelope, because it would begin a new logical attempt. The operator must use `resume-broadcast <taskId>` or resolve the nonce externally.

`resume-broadcast <taskId>` never fetches a proof, signs a transaction, changes calldata, resets an attempt epoch or the original envelope-resolution deadline, or creates a new nonce. It records an operator audit event and submits only the stored bytes after the on-chain reconciliation rules in section 7.3.

## 15. Security and filesystem requirements

- Only `.env.example` belongs in Git.
- Private keys never appear in logs or queue records.
- Signing requires an explicit `CR3DX_WORKER_SECRET_MODE=file|manager`; absence or an unknown value refuses signing.
- In `file` mode, an absolute `CR3DX_WORKER_ENV_FILE` is mandatory. A launcher resolves its real target, requires a regular file owned by the worker user with mode `0600`, rejects a target inside the checkout, and verifies that its containing directory path is not writable by group or others. Only after those checks does the launcher read the key and pass it to the child worker through the environment; the worker does not reopen or watch the file.
- In `manager` mode, a secret manager injects the key directly into the inherited environment. Filesystem permission checks are not applicable; the preflight explicitly records `secretMode=manager` and never prints the value.
- The worker entrypoint must not load a checkout-local `.env`, invoke `wallets:create`, or infer a secret mode from the mere presence of an environment variable.
- The known P0 in `docs/audit/readme-audit.md` remains a separate repository finding: current `wallets:create` can replace the symlink with a regular checkout-local file. Until that utility is fixed and regression-tested, it is forbidden for S6 key provisioning.
- Refuse signing when the secret file or worker state directory cannot enforce safe permissions.
- Protect in-flight raw transactions: they cannot reveal the private key, but rebroadcasting them can spend gas and consume a nonce.

## 16. Observability

Structured logs must include:

- stable task identity;
- state transition and reason;
- source and destination transaction hashes;
- evidence IDs when known;
- retry-window timing;
- runtime interval values;
- receipt classification;
- elapsed end-to-end timing.

Logs must exclude private keys and proof bytes.

## 17. Local acceptance tests

Required deterministic coverage:

1. duplicate event delivery;
2. multiple relevant events in one source transaction;
3. backfill after restart;
4. crash-safe JSON replacement and orphan temporary-file handling;
5. restart while waiting for attestation;
6. crash after proof fetch but before signing;
7. crash after signing but before broadcast;
8. RPC timeout after broadcast;
9. global serialization of verifier and application transactions under one nonce lane;
10. refusal to sign nonce `N+1` while nonce `N` is unresolved;
11. identical raw-byte rebroadcast;
12. restart with unknown broadcast outcome;
13. precomputed evidence ID and `seen(evidenceId)` recovery without a receipt;
14. `seen(evidenceId) == false` does not authorize an alternative transaction;
15. successful receipt before local completion write;
16. table-driven pre-sign simulation classification: exact ABI-decoded continuity-error string is the sole refreshable case; every other selector/string fails closed;
17. underpriced/stuck transaction reaches `ATTENTION_REQUIRED` without automatic gas bump;
18. proof bytes are absent from logical tasks/logs but permitted only inside the unresolved exact raw envelope;
19. external single-or-batch submission wins the race against the worker’s single-source submission;
20. repayment pending before funding;
21. restart between funding and repayment re-application;
22. elapsed retry ceiling to `ATTENTION_REQUIRED`;
23. `resume <taskId>` creates new eligible attempt epochs and an audit entry;
24. `resume <taskId>` refuses an unresolved in-flight envelope;
25. `resume-broadcast <taskId>` rechecks on-chain state and sends only exact stored bytes;
26. exclusive queue lock;
27. runtime configuration drift warning;
28. provider reconnect with lossless backfill;
29. source reorganization handling;
30. absence of worker-only contract operations;
31. one source transaction whose evidence records simultaneously become `APPLIED`, `VERIFIED_PENDING` and `REJECTED_PERMANENT`, including deterministic aggregate-state derivation;
32. complete expected-ID reconciliation: all false, all true and forbidden mixed `seen` results;
33. semantic operation satisfied while the worker envelope remains nonce-unresolved, including external success after signing but before first broadcast: exact bytes are still sent once and the lane remains blocked;
34. independent submission and per-evidence application epochs, including an evidence record becoming ready after several days pending;
35. persisted in-flight resolution deadline that restart and exact rebroadcast do not reset;
36. canonical receipt plus two subsequent destination blocks before raw-envelope deletion, including a receipt disappearing before that depth;
37. source reorganization before signing, full same-hash receipt re-decode with changed height/index/event nonce, different-hash replacement, inclusion-state history and reorganization after signing/evidence recording;
38. admission allowlist with `effectiveFromSourceBlock`, normal and retroactive enrollment, event/task caps, fee budget and cursor preservation when an enrolled event cannot be admitted;
39. kernel lock exclusion and immediate safe reacquisition after forced process death despite the persistent lock pathname;
40. missing established state refuses silent bootstrap with the same signer;
41. S6 key provisioning refuses the audited `.env`/`wallets:create` symlink path and enforces explicit `file` and `manager` modes;
42. mined `status == 0` receipt resolves only the envelope, supplies no selector and uses post-receipt semantic reads to choose satisfied versus `ATTENTION_REQUIRED`;
43. fee budget checks the final populated gas limit, atomically stores maximum liability with the envelope and atomically replaces it with actual receipt cost, including crash/restart boundaries;
44. `BLOCKED_BY_GLOBAL_LANE(ownerTaskId, nonce)` halts writes without changing unrelated task/evidence states;
45. successful `applyEvidence` produces each legal post-state: `APPLIED`, `REJECTED_PERMANENT` and non-error `VERIFIED_PENDING`, while `UNSEEN` raises attention;
46. configured gateway/topic reported by `eth_getLogs` but contradicted by full receipt status/presence/shape causes `GLOBAL_ATTENTION_REQUIRED` without cursor advancement.

Priority classification:

- P0: tests 1–26 and 28–46. These protect against lost facts, duplicate transactions, nonce deadlocks, resource-drain paths and broken recovery.
- P1: test 27. The runtime-drift warning remains part of the target specification; if schedule forces deferral, it must be an explicit documented deviation rather than a silent omission.

These numbered items are behavioral coverage obligations, not a requirement for 46 separate test files or functions. Closely related crash and recovery boundaries, including cases 4, 6, 7 and 12, may use one table-driven harness with injected crash points and restart assertions. Simulation classes in 16, mined outcomes in 42/45 and reorganization transitions in 37 should likewise be table-driven. Combining their mechanics must not silently remove any listed precondition, transition or postcondition.

Existing requirements remain green:

- Foundry suite;
- invariant suite;
- TypeScript typecheck;
- script tests;
- formatting and `git diff --check`.

Heavy compilers and test suites run sequentially. The operator receives advance notice of commands and expected load.

## 18. Deployment and live gates

S5 addresses must not be assumed to contain the v0.4.8 implementation.

Before live acceptance:

1. establish exact deployed bytecode and commit provenance;
2. if v0.4.8 is not deployed, stop;
3. contract deployment requires a separate command and is not performed by the worker;
4. supply exact v0.4.8 deployment addresses as a mandatory live prerequisite;
5. record the addresses and read-only verification results.

Before the first state-changing live operation, produce a preflight containing:

- networks and RPC endpoints without secrets;
- GateLog and Cr3dX contract addresses;
- signer address and balance;
- declared secret mode and either successful external-file permission checks or `manager` provenance, without secret values;
- signer latest and pending nonces, confirmation that no unresolved envelope exists, and current global write-lane status;
- configured gas/fee/budget caps, reserved unresolved-envelope liability, actual rolling fees and maximum liability of every intended transaction;
- enrolled deal IDs and their `effectiveFromSourceBlock` values;
- runtime intervals;
- queued task count;
- intended transactions;
- run and recovery commands.

Then stop until the exact authorization phrase below. It is matched
literally, in the operator's own language, so that no paraphrase and no
English sentence produced in passing can be mistaken for consent to spend
real funds:

```text
РАЗРЕШАЮ S6 LIVE
```

## 19. Live Definition of Done

- A funding event on Sepolia autonomously becomes applied evidence on Creditcoin.
- A repayment event autonomously becomes applied evidence.
- Credit score/economic state changes as expected and exposure is released.
- The worker survives a controlled restart.
- Pending repayment is later applied after funding.
- The external-submission race is demonstrated live with a second wallet: after worker preflight and before its single-source broadcast, the second wallet submits the same source transaction directly or inside its own batch; the worker then reconciles `seen(evidenceId)` or a confirmed duplicate revert without creating a new unsafe transaction.
- Source transaction hashes, Creditcoin transaction hashes and evidence IDs are recorded.
- Full-cycle elapsed timing is recorded in `docs/STATUS.md`.
- Final on-chain state is verified read-only.

## 20. Non-goals

S6 does not include:

- contract changes;
- worker-originated cross-task batching;
- a distributed/HA worker cluster;
- privileged keeper economics;
- UI implementation;
- production-mainnet key custody;
- a guarantee of proof generation service availability.

## 21. Required outputs

- TypeScript worker implementation;
- persistent state schema and migrations/versioning policy;
- deterministic test suite;
- operator CLI/runbook;
- architecture and recovery documentation;
- `.env.example` updates without secrets;
- `docs/STATUS.md` update;
- local S6 commit;
- separate live report after authorized acceptance.

## 22. Resolved MVP implementation policy

The independent review resolved all previously open implementation-policy choices:

1. storage uses one human-readable JSON task file per source transaction, atomic same-directory temporary-file replacement and one exclusive process lock;
2. submission, per-evidence application and exact-envelope resolution use distinct persisted six-hour epochs/windows; observation, attestation waiting and `VERIFIED_PENDING` time do not consume an attempt epoch;
3. restart backfill begins 100 blocks before the stored cursor and queries at most 1,000 blocks per RPC window;
4. the MVP worker performs no cross-task batching;
5. `resume <taskId>` begins new eligible logical attempt epochs, while `resume-broadcast <taskId>` can only resend an unresolved exact signed envelope;
6. every evidence record owns separate inclusion, contract and automation state; aggregate task state is derived by the precedence rule in section 6.3, while global nonce blockage is a separate overlay;
7. semantic operation satisfaction never releases a nonce; only the exact canonical receipt at the required destination depth or explicit operator reconciliation resolves an envelope;
8. the expected evidence-ID set for one source transaction is reconciled atomically as all false or all true; mixed visibility stops automation;
9. only explicitly enrolled deals are serviced from their persisted effective source blocks, with mandatory queue, gas, fee, maximum-liability budget and balance limits; reservations and actual fees are authoritative in the same atomic task records as their envelopes;
10. the queue uses a kernel-held process lock, not lock-file existence or unsafe stale deletion;
11. S6 keys use an explicit checked external-file launcher or declared secret-manager mode; the audited `wallets:create` symlink path is forbidden;
12. source reorganization transitions, the single exact refreshable pre-sign error and post-receipt semantic actions are closed by sections 10.1 and 7.4;
13. once an exact envelope is persisted, it is broadcast at least once even if an external actor satisfies the operation before that first broadcast.

Exact v0.4.8 deployment addresses are not implementation policy. They remain a mandatory external prerequisite of the live gate in section 18.

## 23. Review closure and implementation gate

The final review must verify the following closure matrix against this exact file hash:

| Review issue | Normative resolution |
|---|---|
| Multiple facts in one source transaction | Per-evidence inclusion/contract/automation state plus derived aggregate state, sections 5 and 6. |
| `ORPHANED` mixed into destination evidence state | Separate `inclusionState` and destination contract state, sections 6.2 and 10.1. |
| Accepted GateLog later produces `SourceTransactionFailed` | Admission requires canonical `status == 1`; later disagreement is `ATTENTION_REQUIRED`, sections 4.1 and 7.4. |
| Semantic success confused with nonce resolution | Independent envelope rule and two-block confirmation depth, sections 7.2–7.3. |
| Pending evidence inherits an expired clock | Separate submission, application and envelope clocks, section 9. |
| Receipt assumed to contain a revert selector | Selectors are pre-sign simulation inputs; mined failures use semantic reads, section 7.4. |
| Refreshable-error allowlist left open-ended | Exactly one ABI-decoded continuity-error string is refreshable; expansion requires a document revision, section 7.4. |
| Partial `seen` set treated as missing work | Mixed set is an invariant violation; no partial submission, sections 7.3 and 12. |
| Reorganization and destination finality unspecified | Full receipt re-decode, separate inclusion state and tombstones, section 10.1; receipt depth, section 7.2. |
| Re-inclusion assumed to preserve `eventNonce` | Kind/nonce is inclusion-specific; every same-hash inclusion is fully re-decoded and re-admitted, sections 4 and 10.1. |
| Public gateway can drain worker gas | Whole-transaction enrollment from explicit effective blocks plus queue and maximum-liability fee limits, section 4.1. |
| Budget cache can diverge from task envelope | Reservation and confirmed fee share the task's atomic transition; global totals are derived, sections 4.1 and 5. |
| Successful application assumed to become terminal | `VERIFIED_PENDING` is a valid successful result; exact four-way post-state matrix is in section 7.4. |
| Contradictory configured gateway log silently skipped | Receipt/status/shape inconsistency stops the global worker before cursor advancement, section 4.1. |
| Crash leaves or bypasses lock file | Kernel-held lock; pathname existence is not ownership, section 5. |
| Base omitted later audit findings | Base updated to `cbbb33062a1743d1bf8e88e8f6ee2604fbe77c4e`, with audit input in section 3. |
| Existing deployment mistaken for v0.4.8 | Mandatory provenance/deployment stop, section 18. |
| Unsafe `.env` symlink path reused for S6 | Explicit checked-file or secret-manager mode; `wallets:create` path forbidden, section 15. |
| External success occurs after signing but before broadcast | Persisted exact bytes are still broadcast once to resolve the chosen nonce, section 7.2. |
| Global nonce blockage mutates unrelated task state | Separate `BLOCKED_BY_GLOBAL_LANE` overlay, sections 5.1 and 6.3. |

After this draft is accepted, it is copied into the repository in a document-only commit based on the target `main`. That commit changes no contracts, scripts, tests or live records. Its exact hash is the sole authorization base for implementation on `s6/worker`; implementation starts only from that committed document artifact, never from uncommitted instructions or an untracked copy.

Final review is a safety/consistency gate. A new blocker must identify a reachable counterexample, conflicting normative rules or a missing action for an already claimed failure mode. New product capabilities or availability improvements are deferred unless they are necessary to preserve a stated safety property.
