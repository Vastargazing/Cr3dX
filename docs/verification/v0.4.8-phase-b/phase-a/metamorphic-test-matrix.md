# Metamorphic test matrix — v0.4.8

## Comparison scopes

| Scope | Fields compared | Fields explicitly excluded |
|---|---|---|
| `Econ(S)` for INV-3 and INV-20 | deal status; funded, repaid, and on-time-repaid amounts; outstanding; borrower reserve, exposure, score; canonical outcome classification | evidence state/reason; `closedAtBlock` |
| Evidence extraction/order | ordered evidence IDs and immutable evidence facts | later application state unless the row requires it |
| Decision-time classification | state and rejection reason chosen by that invocation | later canonical-state changes until explicit retry |
| Full continuous checks | counters versus full recount; exposure versus outstanding sum; status versus outcome | none of those continuous fields |

Terms and the multiset of source facts are held fixed unless a row explicitly
names a mutation.

## Fixed-fact transformations

| Dimension | Base witness | Generated variants | Required comparison | Expected result |
|---|---|---|---|---|
| Transaction order | one funding tx at height 60 and one repayment tx at height 50 | both input orders in one `submitAndApplyBatch` | `Econ(S)` | equal; two phases apply funding first |
| Transaction order, cumulative funding | amounts 60, 50, 40; threshold 100 | all 6 transaction/application orders | `Econ(S)` and funded amount | equal; funded 150, crossing once |
| Log order | one verified tx with two gateway events | every log permutation | each run returns IDs in its own log order; after applying fixed facts compare `Econ(S)` | ordered identifiers track log order; economics equal |
| Stable identifier order | two transactions, one with two relevant logs | transaction permutations and log permutations | returned ID sequence | exactly transaction order then log order |
| Batch grouping | funding + repayment | one batch; separate batches repayment-first; separate batches funding-first | after explicit retry closure, `Econ(S)` | equal |
| Batch grouping without retry | separately submitted correct repayment before funding | funding delivered later in a different call | old evidence state and current economics before retry | old repayment remains pending; repaid amount remains zero |
| Funding/repayment delivery | correct repayment earlier in source height than funding | same-call both input orders; separate delivery orders | same-call `Econ(S)`; separate path after retry `Econ(S)` | equal only at prescribed closure; no implicit retry |
| Repayment delivery | full late at 110 and full timely at 90; face 1100, due 100 | both orders | `Econ(S)` | repaid 2200, timely 1100, outstanding 0, paid on time |
| Repayment splitting | one full payment versus partitions with identical timely/late totals | random positive/zero partitions and permutations | outcome, counters, score, exposure | equal; one deal contributes one outcome |
| Overpayment | face amount plus arbitrary excess | split and delivery permutations | amounts in full; saturated outstanding/exposure | total repaid includes excess; outstanding/exposure never negative |
| Explicit retry timing | repayment pending on `CREATED` | retry before funding, immediately after funding, much later | after final retry, `Econ(S)` | equal; earlier no-op retries do not duplicate |
| Default declaration timing | default eligible before full timely or late repayment | declare before repayment; attempt after repayment | final `Econ(S)` | same paid classification; post-payment default rejects |
| Default memory | default then partial repayment | different partial repayment delivery orders | result and original `closedAtBlock` | default preserved until a full-payment branch wins |
| `closedAtBlock` timing | direct late closure versus default then late refinement | different attested heights at writes | `Econ(S)` only | equal economics; metadata may differ |
| Uncovered RPC fields | fixed verified transaction/log | arbitrary `from` and `gasUsed` | all evidence/economic fields | identical |
| Early/late classification | wrong-investor funding before versus after deal creation | early pending without retry; late immediate classification | `Econ(S)` only | equal economics; evidence state may differ |

## Mutation oracles

Each transformation is paired with a focused faulty mutation:

- **Single input-order pass:** apply returned IDs in raw order rather than two
  phases. Repayment-first same-call input incorrectly remains pending.
- **Threshold cap:** stop adding valid funding after threshold. The six 60/50/40
  permutations disagree or end below 150.
- **Implicit pending scan:** funding loops through previously stored evidence.
  Separate repayment-first delivery changes repaid state without explicit retry.
- **Terminal repayment ignore:** stop applying repayment once status is paid or
  defaulted. Cumulative amounts and later refinements become order-dependent.
- **Residual truncation:** add only `min(amount,outstanding)`. Full late/timely
  permutations produce different cumulative amounts.
- **Delivery-time timeliness:** compare current attested height rather than source
  log height. Delayed timely proof becomes late.
- **Default reconstruction:** recompute from evidence only and drop the stored
  default branch. Partial repayment erases default.
- **Economic metadata leakage:** include `closedAtBlock` in INV-3/20 comparison.
  Valid alternative delivery/default timings falsely fail.
- **Continuous INV-19 sweep:** automatically reclassify or declare stale every
  pending record whenever state changes. A legally pending stored record falsely
  violates the property.

## Generation bounds

- Transaction count per verifier call: 1…10.
- Relevant logs per transaction: 0…multiple, interleaved with unrelated and
  foreign-emitter logs.
- Amounts: 0; threshold−1; threshold; threshold+1; face−1; face; face+1; large
  overpayment.
- Heights: due−1; due; due+1; default threshold−1; threshold; threshold+1.
- Evidence histories: unseen, pending, applied, permanently rejected; retry each
  zero, one, and multiple times.
- Status histories: created, financed, defaulted, paid late, paid on time and all
  permitted refinements.
- Default timing: before any repayment, between partial repayments, after a full
  repayment (must reject), and never.
- Borrower accounting: unused capacity, exactly exhausted capacity, and exposure
  above the reduced post-default limit.

