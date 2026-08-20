# Test catalog and provenance — v0.4.8

## Specification-prescribed cases

The cases in this section are prescribed by section 9 of the supplied normative
package; the test design as a whole is not claimed to have been independently
invented.

### Unit and invariant families prescribed by section 9

- Status transitions; evidence state machine; score, reserve, and exposure
  arithmetic; log extraction; deal/evidence identifiers.
- Fuzz invariants INV-2, INV-3, INV-4, INV-5, INV-6, INV-9, INV-10, INV-11,
  INV-12, INV-13, INV-17, INV-18, INV-19, INV-20, INV-21, and INV-22.
- INV-19 is checked only when a classification decision is made.

### Negative cases prescribed by section 9

- Duplicate submission and atomic duplicate inside one batch.
- Verified transaction with no relevant log; foreign emitter; source
  transaction `status == 0`.
- Wrong funding investor; wrong repayment recipient before and after funding.
- Deal over available limit.
- Default at/before the attested-height threshold.
- `markDefaulted` for unknown deals and all non-`FINANCED` statuses.
- `getEvidence` and `applyEvidence` for unknown evidence IDs.

### Focused cases prescribed by section 9

- Reverse delivery of two partial repayments.
- Late partial plus timely full repayment in both orders.
- Funding an already overdue deal.
- Valid post-threshold funding remains applied without a second accounting move.
- All six permutations of funding 60, 50, 40 at threshold 100 end at 150.
- Wrong-recipient repayment before funding rejects immediately.
- Correct-recipient repayment before funding stays pending and needs later
  explicit retry; `CREATED` never closes from repayment.
- Same-call repayment/funding in both transaction orders uses funding-first
  application.
- Previously stored pending repayment is not implicitly retried by later funding.
- Repeated application behavior for applied, rejected, pending, and unknown IDs.
- Unfunded deals can exhaust reservation capacity.
- Overpayment saturation and exposure above limit.
- Multiple relevant events in one transaction.
- Full late and timely payments in both orders (the INV-20 regression).
- Repayment after closure still accumulates and does not touch reserve.
- `PAID_LATE→PAID_ON_TIME`; no `PAID_ON_TIME→PAID_LATE` downgrade.
- Partial repayment after default preserves default and its `closedAtBlock`.
- Same outcome leaves `closedAtBlock`; changed outcome updates it.
- Wrong-recipient permanent rejection for both evidence kinds.
- Default refinements to both paid outcomes.

## Independently derived metamorphic cases

- Mutation of uncovered `from` and `gasUsed` fields while holding covered facts
  fixed.
- A direct paid outcome versus default-then-paid refinement has equal economic
  state even when `closedAtBlock` differs.
- Early wrong-investor evidence can remain pending while the same late-delivered
  fact is rejected, with equal economic state.
- Default declaration before full repayment versus rejected declaration after
  full repayment converges to the same payment classification.
- One-batch and split-batch funding/repayment paths converge after, and only
  after, the required explicit retry closure.

## Independently derived fuzz dimensions

- Zero amounts in addition to boundary and overpayment amounts (the package does
  not prescribe a positive evidence amount constraint).
- Cross-products of retry timing with deal creation, funding threshold crossing,
  and permanent-field mismatches.
- Mixed status histories with funding continuing after financing/default/payment.
- Score-floor histories containing enough defaults to make raw signed score
  negative before final clamp.
- Generated sequences with funding, repayment, default attempts, and explicit
  retry, checking continuous state after every action.

## Independently derived minimal counterexamples

- Post-threshold rejection: threshold 100, funding 110 then 40; faulty total 110,
  correct total 150.
- Double exposure: threshold 100, pieces 60 then 50; faulty crossing logic moves
  face value twice.
- Residual truncation: face 1100, late 1100 then timely 1100; faulty total 1100 or
  permanent late outcome, correct total 2200 and on-time outcome.
- Stale outcome counter: default refined to late without decrementing default;
  cache disagrees with full recount after one transition.
- Default erasure: default plus partial repayment below face; a pure
  evidence-only recomputation returns no outcome instead of preserved default.
- Metadata overreach: identical paid-late economics reached at attested heights
  701 and 800; comparing `closedAtBlock` falsely rejects economic equivalence.

## Additional negative cases

- Verification failure cannot expose or use `txIndex` and commits no evidence.
- Empty and 11-transaction batches fail the model batch-size gate.
- Recipient wins deterministically when both funding recipient and investor are
  wrong.
- Direct administrative mutation is unavailable.
- A post-payment default attempt fails even at arbitrarily high attested height.
- A pending retry before prerequisites is a non-reverting no-op and cannot make
  later application count twice.

