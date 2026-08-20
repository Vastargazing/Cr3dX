# Invariant coverage matrix — v0.4.8

## Shared model vocabulary

`Econ(S)` is the single economic-state projection used for both INV-3 and
INV-20:

```text
per deal: status, fundedAmount, repaidAmount, onTimeRepaid, outstanding,
          canonical outcome classification (or none)
per borrower: reserved, exposure, score
```

Evidence state/reason and `closedAtBlock` are excluded. Terms are fixed inputs to
metamorphic comparisons. `outstanding = max(faceValue - repaidAmount, 0)`.

The model action alphabet is:

```text
createDeal; submitEvidence; submitEvidenceBatch; submitAndApply;
submitAndApplyBatch; applyEvidence(evidenceId); markDefaulted;
advanceAttestedHeight
```

Each evidence submission contains generated proof validity, source transaction
status, height, transaction index, ordered logs, emitter, kind, deal identity,
counterparty, recipient, amount, and event nonce. Only the submitted proof's
successful verification authorizes use of its transaction index and logs.

## Summary

| INV | Primary class | Check mode | Harness coverage |
|---|---|---|---|
| 1 | authorization | transition property | direct and generated |
| 2 | idempotence | continuous invariant | direct and generated |
| 3 | metamorphic | transition property | permutations/grouping |
| 4 | state | continuous invariant | direct and generated |
| 5 | arithmetic | continuous invariant | direct and generated |
| 6 | metamorphic | transition property | split-payment witness |
| 7 | authorization | continuous invariant | exposed-action witness |
| 8 | authorization | continuous invariant | verifier-boundary witness |
| 9 | arithmetic | continuous invariant | direct and generated |
| 10 | arithmetic | transition property | boundary witness |
| 11 | transition | transition property | exhaustive blocker mutations |
| 12 | arithmetic | continuous invariant | mixed-timing witnesses |
| 13 | idempotence | transition property | crossing-count witness |
| 14 | ordering | decision-time classification rule | threshold witness |
| 15 | metamorphic | transition property | uncovered-field mutation |
| 16 | ordering | transition property | trace-order witness |
| 17 | transition | transition property | multi-log witness |
| 18 | idempotence | transition property | permutations/crossing witness |
| 19 | state | decision-time classification rule | full current decision table |
| 20 | metamorphic | transition property | repayment permutations |
| 21 | state | continuous invariant | every outcome write/refinement |
| 22 | authorization | transition property | status × height witnesses |

## Executable invariant records

### INV-1

- **Property:** if a transition changes a deal into `FINANCED`,
  `PAID_LATE`, or `PAID_ON_TIME`, that transition consumes at least one
  evidence record created only after `verify(proof)` succeeded. Creation and
  `markDefaulted` cannot produce those statuses.
- **Class / mode:** authorization; transition property.
- **Smallest state:** one `CREATED` deal; for paid states, add valid funding to
  reach `FINANCED`.
- **Actions / preconditions:** generate every public action and valid/invalid
  proof flag; funding must cross `requiredFunding`; repayment must make the
  canonical payment predicate true.
- **Oracle:** transition provenance plus resulting status. The verifier store is
  the only evidence source.
- **Minimal negative counterexample:** `createDeal` or an administrative setter
  directly produces `FINANCED`; or unverified repayment produces `PAID_*`.
- **Witnesses:** verification-order test, administrative-bypass test, generated
  trace invariant checks.

### INV-2

- **Property:** for every `evidenceId`, its amount contributes to cumulative
  state at most once. A repeated submission atomically raises
  `EvidenceAlreadyRecorded`; repeated `applyEvidence` on `APPLIED` or
  `REJECTED_PERMANENT` is a no-op; pending retries make at most one transition
  to a terminal state.
- **Class / mode:** idempotence; continuous invariant.
- **Smallest state:** one deal and one verified evidence item.
- **Actions / preconditions:** resubmit the same identifier, duplicate it inside
  a batch, and call `applyEvidence` repeatedly before/after prerequisites.
- **Oracle:** evidence-store cardinality and cumulative funding/repayment deltas.
- **Minimal negative counterexample:** one applied funding of 10 followed by a
  second `applyEvidence(id)` changes `fundedAmount` from 10 to 20.
- **Witnesses:** both atomic duplicate tests and terminal-idempotence test.

### INV-3

- **Property:** for a fixed set of verified source facts, every relevant
  transaction/log/application permutation that reaches the same applicable fact
  closure has equal `Econ(S)`. Evidence classification and `closedAtBlock` need
  not match.
- **Class / mode:** metamorphic; transition property over paired executions.
- **Smallest state:** one deal plus two facts whose order can differ; include a
  dependency pair (funding, repayment) for the focused witness.
- **Actions / preconditions:** permute transaction order, log order, batch
  grouping, delivery order, and explicit retry timing; compare only after the
  specified retry closure.
- **Oracle:** exact equality of `economic_state()`.
- **Minimal negative counterexample:** valid funding amounts 60 and 50 at a
  threshold of 100 yield 110 in one order but only 100 in the other because an
  implementation caps or rejects the post-threshold contribution.
- **Witnesses:** six funding permutations, two-phase order test, batch grouping
  with explicit retry, and allowed evidence-classification difference.

### INV-4

- **Property:** each deal has zero or one stored outcome. Its result equals:
  `PAID_ON_TIME` if `onTimeRepaid >= faceValue`; else `PAID_LATE` if
  `repaidAmount >= faceValue`; else preserved `DEFAULTED` if already stored;
  else none. Writes are limited to `DEFAULTED→PAID_LATE`,
  `DEFAULTED→PAID_ON_TIME`, `PAID_LATE→PAID_ON_TIME`, and same-value no-op.
  Only `markDefaulted` may create `DEFAULTED` from no outcome.
- **Class / mode:** state; continuous invariant.
- **Smallest state:** one financed deal; add an optional stored default and one
  repayment.
- **Actions / preconditions:** apply timely/late partial/full repayments and call
  `markDefaulted` only when eligible.
- **Oracle:** outcome-map cardinality, canonical-result function, and permitted
  refinement relation.
- **Minimal negative counterexample:** a full late payment overwrites a state
  with `onTimeRepaid >= faceValue` to `PAID_LATE`; or replay of partial evidence
  invents `DEFAULTED` without `markDefaulted`.
- **Witnesses:** branch-precedence, default preservation/refinement, and
  evidence-only replay tests.

### INV-5

- **Property:** cached counters by outcome equal a full recount of canonical
  outcomes, and `score = clamp(300,850,500 + 25*onTime - 50*late -
  200*defaulted)` using signed aggregate arithmetic and one final clamp.
- **Class / mode:** arithmetic; continuous invariant.
- **Smallest state:** one borrower and one deal whose outcome can be written and
  refined.
- **Actions / preconditions:** produce each outcome and every allowed refinement
  in multiple orders.
- **Oracle:** cached counters/score equal `full_recount_counters()` and
  `recomputed_score()`.
- **Minimal negative counterexample:** `DEFAULTED→PAID_LATE` increments late but
  fails to decrement default, so cached score differs from full recount.
- **Witnesses:** refinement counter test, signed/clamp-floor test, generated
  invariant checks.

### INV-6

- **Property:** partitioning the same repayment total for one deal into any
  number of evidence items cannot create more than one canonical deal outcome or
  more than its single counter contribution.
- **Class / mode:** metamorphic; transition property.
- **Smallest state:** one financed deal and a repayment total covering face
  value.
- **Actions / preconditions:** compare one payment `faceValue` with partitions
  summing to the same timely/late amounts.
- **Oracle:** same canonical classification and score; counters contain exactly
  one outcome for the deal.
- **Minimal negative counterexample:** two timely halves each increment
  `paidOnTime`, giving +50 instead of +25.
- **Witnesses:** repayment splitting/overpayment test and score recount.

### INV-7

- **Property:** the externally changing Deals surface is exactly creation,
  evidence submission/application, and permissionless default declaration;
  Credit mutations are reachable only through those Deals transitions. No role
  can directly mutate deal status, evidence, outcome, reserve, or exposure.
- **Class / mode:** authorization; continuous invariant over the action surface.
- **Smallest state:** empty model.
- **Actions / preconditions:** attempt a modeled administrative mutation as
  deployer, borrower, investor, and arbitrary caller.
- **Oracle:** every direct attempt raises `UNAUTHORIZED`; authorized public
  actions remain permissionless where prescribed.
- **Minimal negative counterexample:** deployer directly sets a deal to paid or
  releases its reserve.
- **Witnesses:** administrative-bypass absence test and fixed public alphabet.

### INV-8

- **Property:** every stored evidence item was extracted from a relevant gateway
  log in a source transaction for which the supplied proof verified first and
  `status == 1`.
- **Class / mode:** authorization; continuous invariant.
- **Smallest state:** empty evidence store and one submitted source transaction.
- **Actions / preconditions:** vary proof result, status, emitter, topic/kind,
  and log count.
- **Oracle:** the store changes only after successful verification and successful
  source-status/log gates.
- **Minimal negative counterexample:** a failed source transaction with a
  matching log creates one evidence item.
- **Witnesses:** failed verification/status, foreign emitter, and relevant-log
  tests.

### INV-9

- **Property:** every deal has nonnegative `outstanding`; borrower exposure equals
  the sum of outstanding for exactly `FINANCED` and `DEFAULTED` deals. Default
  does not release exposure; repayments reduce it saturating at zero; overpayment
  cannot make it negative or release it twice.
- **Class / mode:** arithmetic; continuous invariant.
- **Smallest state:** one financed deal.
- **Actions / preconditions:** partial/full/over repayments before and after
  default/outcome refinements.
- **Oracle:** `outstanding >= 0`, stored exposure equals
  `recomputed_exposure()`.
- **Minimal negative counterexample:** repay face value + 1 and obtain
  `outstanding = -1` or exposure below zero.
- **Witnesses:** overpayment, default exposure, closed-deal repayment, and
  generated trace checks.

### INV-10

- **Property:** `createDeal(faceValue)` succeeds only when
  `faceValue <= max(limit - (reserved + exposure), 0)`; otherwise it reverts
  without reserving or incrementing sequence. Available capacity uses saturating
  subtraction.
- **Class / mode:** arithmetic; transition property.
- **Smallest state:** one borrower with used capacity at or near limit.
- **Actions / preconditions:** create at `available`, `available+1`, and when
  exposure exceeds current limit after score decline.
- **Oracle:** success exactly at/below the boundary; `LimitExceeded` above; no
  unsigned wrap.
- **Minimal negative counterexample:** used 1000, limit 600; subtraction wraps to
  a huge value and permits another deal.
- **Witnesses:** hard-limit/reservation and exposure-above-limit tests.

### INV-11

- **Property:** funding is `APPLIED` whenever the deal exists, recipient equals
  borrower, and counterparty equals designated investor. It adds the full amount
  even if partial, excessive, late, post-threshold, or current capacity is zero.
  No `ALREADY_FUNDED` rejection exists.
- **Class / mode:** transition; transition property.
- **Smallest state:** one deal; variants add elapsed due height, exhausted limit,
  or an already crossed threshold.
- **Actions / preconditions:** apply correct funding while toggling every
  non-blocking dimension.
- **Oracle:** evidence `APPLIED` and exact `fundedAmount += amount`; only wrong
  immutable fields may reject.
- **Minimal negative counterexample:** threshold 100, already funded 110; later
  valid 40 is rejected as `ALREADY_FUNDED`, leaving 110 instead of 150.
- **Witnesses:** cumulative no-cap test, six permutations, past-due funding.

### INV-12

- **Property:** `status == PAID_ON_TIME` iff the sum of applied repayment amounts
  whose source `blockHeight <= dueBlock` is at least `faceValue`. Delivery height
  and attested height do not classify timeliness.
- **Class / mode:** arithmetic; continuous invariant.
- **Smallest state:** one financed deal and timely/late repayment facts.
- **Actions / preconditions:** split/mix repayments across the due boundary and
  permute delivery.
- **Oracle:** exact equality of status predicate and
  `onTimeRepaid >= faceValue`.
- **Minimal negative counterexample:** timely 600 + late 500 for face 1100 becomes
  `PAID_ON_TIME` by using total repaid rather than timely total.
- **Witnesses:** branch precedence, mixed split, INV-20 regression.

### INV-13

- **Property:** creation reserves face value; only the unique verified funding
  transition from `before < requiredFunding` to `after >= requiredFunding`
  subtracts that reserve and adds face value to exposure. Partial funding and all
  later funding do neither.
- **Class / mode:** idempotence; transition property.
- **Smallest state:** one created/reserved deal and funding pieces that cross its
  threshold.
- **Actions / preconditions:** apply pieces below, crossing, and above threshold
  in every order.
- **Oracle:** reserve/exposure deltas occur on exactly one action and conserve
  used capacity at the crossing.
- **Minimal negative counterexample:** each partial payment moves face value,
  making exposure 2× face value after two pieces.
- **Witnesses:** cumulative crossing test, six permutations, hard-limit reuse.

### INV-14

- **Property:** a default-time decision reads only attested source height and
  succeeds exactly when `attestedHeight > dueBlock + grace` and status is
  `FINANCED`. Timeliness uses source log height. Local execution block/time is
  absent from the model.
- **Class / mode:** ordering; decision-time classification rule.
- **Smallest state:** one financed deal at the strict threshold boundary.
- **Actions / preconditions:** set attested height to threshold and threshold+1;
  vary source log height independently.
- **Oracle:** threshold equality rejects; threshold+1 permits; repayment
  timeliness follows log height.
- **Minimal negative counterexample:** `markDefaulted` succeeds at equality or
  because a local chain block number is high while attested height is not.
- **Witnesses:** strict threshold/past-due test and default-only test.

### INV-15

- **Property:** changing only uncovered RPC wrapper fields `from` or `gasUsed`
  leaves all stored evidence and economic state unchanged.
- **Class / mode:** metamorphic; transition property.
- **Smallest state:** one verified transaction with one relevant log.
- **Actions / preconditions:** hold covered transaction/log facts and proof result
  fixed; mutate uncovered fields arbitrarily.
- **Oracle:** identical identifiers, evidence facts, classifications, and
  `Econ(S)`.
- **Minimal negative counterexample:** changing wrapper `from` changes the stored
  investor and turns valid funding into `WRONG_INVESTOR`.
- **Witnesses:** uncovered-field metamorphic test.

### INV-16

- **Property:** `calculateTxIndex(proof)` occurs only after successful
  `verify` of that same proof. Failure exposes no calculated index and commits no
  evidence.
- **Class / mode:** ordering; transition property.
- **Smallest state:** empty verifier and one proof submission.
- **Actions / preconditions:** submit valid and invalid proof variants.
- **Oracle:** trace prefix is `verify → calculateTxIndex`; failed verification
  has no later trace point or state change.
- **Minimal negative counterexample:** invalid proof still supplies a trusted
  index used to create an evidence ID.
- **Witnesses:** verify-order trace test.

### INV-17

- **Property:** every relevant matching log in a verified successful transaction
  yields exactly one evidence item; unrelated/foreign logs yield none. Returned
  IDs preserve transaction order then log order, and event nonce distinguishes
  multiple events.
- **Class / mode:** transition; transition property.
- **Smallest state:** one transaction with two matching logs.
- **Actions / preconditions:** permute log order; add foreign and unrelated logs.
- **Oracle:** created count equals relevant-log count and ordered IDs equal the
  identifier function for each log.
- **Minimal negative counterexample:** a transaction with two gateway events
  yields only the first evidence item.
- **Witnesses:** multi-log and stable transaction/log-order tests.

### INV-18

- **Property:** monotone `fundedAmount` makes the predicate
  `before < requiredFunding <= after` true at most once. Therefore
  `CREATED→FINANCED` and reserve→exposure occur exactly once, independent of
  payment count/order; subsequent funding still accumulates.
- **Class / mode:** idempotence; transition property.
- **Smallest state:** one deal and at least two funding items spanning threshold.
- **Actions / preconditions:** all permutations of 60, 50, 40 at threshold 100.
- **Oracle:** final funded 150, one status transition, reserve 0, exposure exactly
  face value.
- **Minimal negative counterexample:** checking only `after >= threshold` repeats
  exposure addition on the 40 payment.
- **Witnesses:** all six prescribed permutations.

### INV-19

- **Property:** at each classification call, permanent rejection occurs iff the
  current canonical state proves eternal inapplicability. In this model the only
  derived reasons are funding wrong investor and either kind wrong recipient;
  funding checks recipient before investor. Missing deal and correct-recipient
  repayment on `CREATED` remain pending. Stored pending items need not be
  reclassified when prerequisites later change.
- **Class / mode:** state; decision-time classification rule.
- **Smallest state:** one verified pending evidence; optional deal controls which
  immutable terms are knowable.
- **Actions / preconditions:** classify before/after deal creation, before/after
  funding, with every immutable mismatch combination, and on explicit retry.
- **Oracle:** exact `(state, reason)` chosen at that call. No
  `ALREADY_FUNDED` reason is allowed.
- **Minimal negative counterexample:** correct-recipient repayment submitted in
  `CREATED` is permanently rejected; or wrong recipient remains pending; or old
  pending evidence is implicitly retried by later funding.
- **Witnesses:** unknown-deal, mismatch priority, both reason tests, pending/retry,
  and decision-time storage test.

### INV-20

- **Property:** for a fixed multiset of applied repayment facts, all delivery
  permutations have equal `Econ(S)`. Amounts accumulate in full; timely amount is
  selected by source height; canonical classification is recomputed after each
  application. `closedAtBlock` is excluded.
- **Class / mode:** metamorphic; transition property over paired executions.
- **Smallest state:** one financed deal and two repayments on opposite sides of
  due block.
- **Actions / preconditions:** timely/late partial/full/over payments in every
  order; optional default before eligible repayment delivery.
- **Oracle:** equality of `economic_state()` only.
- **Minimal negative counterexample:** face 1100, late full at 110 then timely
  full at 90 remains `PAID_LATE`, while reverse order is `PAID_ON_TIME`.
- **Witnesses:** exact prescribed 1100/110/90 regression, grouping/retry, default
  timing, and `closedAtBlock` exclusion.

### INV-21

- **Property:** after every transition, an existing canonical outcome's result
  equals `deal.status`; no outcome implies status is `CREATED` or `FINANCED`.
  Outcome counter update, outcome write, `closedAtBlock`, and status change are
  one atomic model step.
- **Class / mode:** state; continuous invariant.
- **Smallest state:** one financed deal capable of default and payment
  refinements.
- **Actions / preconditions:** execute no-outcome→default,
  default→late/on-time, late→on-time, and same-result recomputation.
- **Oracle:** `deal.status.value == outcome.result.value` after every action.
- **Minimal negative counterexample:** late-to-on-time refinement updates Credit
  outcome but leaves deal status `PAID_LATE`.
- **Witnesses:** transition-by-transition internal invariant test and all seeded
  traces.

### INV-22

- **Property:** `markDefaulted` succeeds iff deal exists, status is exactly
  `FINANCED`, and `attestedHeight > dueBlock + grace`; it is the only no-outcome
  to `DEFAULTED` action. Unknown, `CREATED`, `DEFAULTED`, `PAID_LATE`, and
  `PAID_ON_TIME` all raise `NotDefaultable`.
- **Class / mode:** authorization; transition property.
- **Smallest state:** one deal plus enough correct funding to reach `FINANCED`.
- **Actions / preconditions:** cross product of statuses with height at/below/
  above threshold.
- **Oracle:** success only in the single allowed cell; all failures are atomic
  `NotDefaultable`.
- **Minimal negative counterexample:** an unfunded `CREATED` deal becomes
  `DEFAULTED` at a sufficiently high attested height.
- **Witnesses:** strict threshold test, unknown/status negative test, default
  refinement tests.

