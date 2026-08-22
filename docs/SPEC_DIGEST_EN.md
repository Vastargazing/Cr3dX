# Cr3dX specification digest

> **Non-normative English guide.** The frozen Russian v0.4.8 specification in
> [`cr3dx-spec-v0.4.0-final.md`](cr3dx-spec-v0.4.0-final.md) (commit
> `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`) remains authoritative. Where this
> digest and the specification disagree, the specification wins and this file is
> the one with the defect.

This digest restates the state model, evidence classification and accounting
rules of specification sections 3 and 4 for readers who do not read Russian.
It introduces no normative rule; current-deployment values and
implementation-only names are labelled explicitly. The invariants INV-1 to
INV-22 already exist in English, each
stated as a property with its oracle, in the sealed Phase A
[invariant coverage matrix](verification/v0.4.8-phase-b/phase-a/invariant-coverage-matrix.md);
its opening block defines the economic-state projection `Econ(S)` used below.
The trust boundary is in the [README](../README.md). The worker is specified in
English in [`S6_WORKER_SPEC.md`](S6_WORKER_SPEC.md).

## 1. Identifiers and units

```text
termsHash  = keccak256(borrower, designatedInvestor, requiredFunding, faceValue, dueBlock)
dealId     = keccak256(creditcoinChainId, dealsContractAddress, dealSeq, termsHash)
evidenceId = keccak256(abi.encode(chainKey, blockHeight, txIndex, uint8(kind), eventNonce))
```

The specification defines the field sequence of `termsHash` and `dealId`; the
current implementation encodes those fields with `abi.encode`, widening every
field to a full word. For `evidenceId` the specification itself fixes the exact
`abi.encode` form, so a redeployed verifier reproduces the same identifiers.

- `txIndex` is taken only after the same proof has passed `verify`.
- `eventNonce` is the gateway's own counter, read from the verified log and shared
  by both event kinds, so two events of one transaction never collide.
- `chainKey` is Creditcoin's internal registry identifier of the source chain,
  not its EVM chain id. It is resolved from the registry at deployment.
- All amounts are native token units. Sepolia USDC has six decimals, so
  `1_000_000` is 1 USDC. No contract reads `decimals`.
- Deal terms require `0 < requiredFunding <= faceValue`.

## 2. Deal lifecycle

```text
CREATED --fundedAmount >= requiredFunding--> FINANCED --repaidAmount >= faceValue--> PAID_LATE
                                              |                                        |
                                              |                         onTimeRepaid >= faceValue
                                              |                                        v
                                              |               +--------------------> PAID_ON_TIME
                                              |               |
                                              +--> DEFAULTED -+
                                                   (attested source height > dueBlock + grace)
```

Allowed refinements, all upward: `DEFAULTED -> PAID_LATE`,
`DEFAULTED -> PAID_ON_TIME`, `PAID_LATE -> PAID_ON_TIME`. `PAID_ON_TIME` is
terminal because `onTimeRepaid` only grows. Forbidden: `PAID_ON_TIME -> PAID_LATE`,
any `PAID_* -> FINANCED`, any `PAID_* -> DEFAULTED`.

- `markDefaulted` is permissionless and is valid only from `FINANCED`, when the
  attested source height exceeds `dueBlock + attestationGracePeriod` (600 source
  blocks on the current deployment). Every other status, including an unknown
  deal, reverts with the named error `NotDefaultable`. A call before the height
  threshold also reverts; the specification names no error for it, the
  implementation calls it `DefaultTooEarly`.
- There is no cancel, no reserve release and no administrative function. A
  created deal can accept funding forever. Otherwise-valid funding of an overdue
  deal is still applied. The financed deal is immediately defaultable only if the
  attested source height already exceeds `dueBlock + attestationGracePeriod`;
  otherwise it becomes defaultable when that threshold is crossed. Creating a
  deal whose `dueBlock` has already passed is allowed.
- Deadlines are judged against the attested source height read from the
  `ChainInfo` precompile, never against Creditcoin's own block number or time.

## 3. Canonical outcome

The outcome is a state machine, not a pure function of the sums. It is
recomputed after every applied repayment:

```text
if onTimeRepaid >= faceValue:          PAID_ON_TIME
else if repaidAmount >= faceValue:     PAID_LATE
else if current outcome == DEFAULTED:  DEFAULTED
else:                                  no outcome
```

Only `markDefaulted` creates `DEFAULTED`; the third branch carries it forward, so a
partial repayment after a default keeps `DEFAULTED` and a full repayment refines
it. `deal.status` and the credit layer's outcome change in the same transition of
the same transaction (INV-21).

`closedAtBlock` is the attested source height at which the current outcome value
was first written. It is frozen while the outcome does not change and is not
part of the economic state.

**Economic state** (the scope of INV-3 and INV-20): deal status, accumulated
sums, outstanding, reserve, exposure, score and the canonical outcome
classification. Evidence state and `closedAtBlock` are outside it.

## 4. Evidence state machine

```text
UNSEEN --verify ok--> VERIFIED_PENDING --preconditions met--> APPLIED
                             |
                             +--permanent reason--> REJECTED_PERMANENT
```

The rule for `VERIFIED_PENDING` is a criterion, not a list:

> Pending is permitted if and only if the current canonical state cannot prove
> that the evidence is inapplicable forever, and an unresolved precondition
> remains that could make it applicable later.

It is applied at decision time, that is at the first application attempt and at
every explicit `applyEvidence`. Stored pending facts whose preconditions later
closed legitimately remain pending until somebody calls `applyEvidence` (INV-19).

Exactly two permanent reasons follow from the criterion. Both are a mismatch
against a field fixed at deal creation:

| Reason | Funding | Repayment |
|---|---|---|
| `WRONG_RECIPIENT` | recipient is not `deal.borrower` | recipient is not `deal.designatedInvestor` |
| `WRONG_INVESTOR` | payer is not `deal.designatedInvestor` | not applicable |

For funding the recipient is checked first, so a fact that trips both always
reports `WRONG_RECIPIENT`. A third reason may not be added quietly.

| Situation | State | Why |
|---|---|---|
| no deal with this `dealId` | `VERIFIED_PENDING` | the deal can still be created |
| repayment to the right address before funding | `VERIFIED_PENDING` | an unfunded deal owes nothing; it may be funded later |
| funding from a non-designated investor | `REJECTED_PERMANENT` | `designatedInvestor` is immutable |
| funding from the designated investor above the threshold | `APPLIED` | the money moved; refusing it would make the total order dependent |
| wrong recipient | `REJECTED_PERMANENT` | derived from immutable deal fields |

A fact for a `dealId` that never gets created stays pending forever. That is
accepted and paid for in gas by the submitter.

## 5. Applying evidence

**Entry points.** The verifier records immutable facts and assigns no meaning.
The registry's `submitAndApply` and `submitAndApplyBatch` (up to ten heights
under one continuity proof) prove, record and apply in one transaction;
`applyEvidence(evidenceId)` drives a previously recorded fact. Direct submission
to the verifier stays open to anyone. The complete permissionless user surface
on Creditcoin is `Verifier.submitEvidence*` plus `Deals.createDeal`,
`submitAndApply*`, `applyEvidence` and `markDefaulted`. `Credit` exposes its
state-changing methods only to the `Deals` contract bound at construction; they
are not user-callable. On Sepolia the surface is `Gateway.fund` and
`Gateway.repay`.

**Verifier refusals.** A proof of a transaction with receipt `status != 1` is
refused: the precompile does not check the status, the verifier must (the
specification requires the check, the implementation names the error
`SourceTransactionFailed`). A verified transaction with no gateway log reverts
(`NoRelevantEvidence`). An identifier recorded before reverts
(`EvidenceAlreadyRecorded`), and inside a batch that failure is atomic. Every
matching log of a transaction produces exactly one fact; a single transaction
carrying two gateway events yields two.

**Two phases.** `submitAndApply*` applies only the facts it just created: first
every funding in returned order, then every repayment in returned order. Funding
can make a repayment applicable, never the reverse. Facts recorded earlier are
not revisited by any call except an explicit `applyEvidence` on their
identifier; there is no automatic sweep.

**Funding.**

- no deal: `VERIFIED_PENDING`;
- recipient is not `deal.borrower`: `WRONG_RECIPIENT`;
- payer is not `deal.designatedInvestor`: `WRONG_INVESTOR`;
- otherwise `fundedAmount += amount`, always: not limited by the credit limit,
  by time, by an overdue `dueBlock`, by a short amount or by an already crossed
  threshold. Funding accumulates without a ceiling; a surplus is a gift to the
  borrower;
- if `fundedAmount` was below `requiredFunding` before this fact and is at or
  above it after: `CREATED -> FINANCED`, the investor is recorded from the proven
  log, and the reserve becomes exposure. This crossing happens exactly once per
  deal however many fundings arrive and in whatever order (INV-18).

**Repayment.**

- no deal: `VERIFIED_PENDING`;
- recipient is not `deal.designatedInvestor`: `WRONG_RECIPIENT`, including
  before funding;
- deal in `CREATED`: `VERIFIED_PENDING`;
- otherwise, in `FINANCED`, `DEFAULTED`, `PAID_LATE` and `PAID_ON_TIME` alike:
  `repaidAmount += amount`, and if the proven source height is at or below
  `dueBlock` also `onTimeRepaid += amount`. Amounts are never trimmed to the
  remaining balance. The specification lists no check on the payer, so a third
  party may repay. Then the canonical outcome is recomputed.

Timeliness comes from the source block height of the payment, so a slow worker
cannot turn an on-time payment into a late one.

**`applyEvidence` behaviour.** Reverts only for an identifier the verifier never
recorded (`UnknownEvidence`). `APPLIED` and `REJECTED_PERMANENT` return their
state and change nothing. `VERIFIED_PENDING` is reclassified: applied, rejected
forever, or left pending. None of those branches reverts.

## 6. Reserve, exposure, score and limit

```text
createDeal                       reserved += faceValue
any applied funding              fundedAmount += amount; reserve and exposure unchanged
threshold crossing               reserved -= faceValue; exposure += faceValue   (once)
applied repayment                exposure -= (outstanding before - outstanding after)

outstanding(deal) = max(faceValue - repaidAmount, 0)
exposure(borrower) = sum of outstanding over deals in FINANCED and DEFAULTED
used               = reserved + exposure
availableLimit     = used >= limit ? 0 : limit - used
```

Every subtraction saturates at zero. Exposure can legitimately exceed the limit
after a score drop. Default does not release exposure: the debt still exists.
Refining an outcome upward moves no money. Overpayment does not push
`outstanding` below zero and does not release exposure twice. `createDeal` fails
when `faceValue > availableLimit` (INV-10), and that is the only reason it fails
besides invalid terms.

```text
BASE_SCORE   500        PAID_ON_TIME  +25
MIN_SCORE    300        PAID_LATE     -50
MAX_SCORE    850        DEFAULTED    -200
BASE_LIMIT   deployment parameter, 5000 USDC = 5_000_000_000 on the current deployment

rawScore = 500 + 25*paidOnTime - 50*paidLate - 200*defaulted    (signed)
score    = clamp(300, 850, rawScore)                             (clamped once)
limit    = BASE_LIMIT * score / 500
```

The clamp is applied once to the finished sum, so the score is a pure function of
the multiset of outcomes (INV-5). Changing an outcome decrements the old
counter and increments the new one; writing the same outcome again changes
nothing, including `closedAtBlock`. The three counters are a cache; the
per-deal outcomes and the borrower's deal list are canonical, and INV-5 says the
two always agree (the implementation exposes the recomputation on chain as
`scoreFromOutcomes`).

## 7. Mandatory INV-20 regression

```text
faceValue = 1100, dueBlock = 100
A: repayment 1100 at height 110 (late)
B: repayment 1100 at height 90  (on time)
```

Orders `A -> B` and `B -> A` must both end with `repaidAmount = 2200`,
`onTimeRepaid = 1100`, `outstanding = 0`, status and outcome `PAID_ON_TIME`, and
identical counters, score and exposure.

## 8. Where the rest lives

- Rules for implementers (specification section 11) are restated in the NatSpec
  of each production contract; the contracts are the English reading of the
  specification and cite invariant numbers inline.
- Measured protocol behaviour, proof freshness and the attestation window:
  [`ATTESTCOIN_INTEGRATION.md`](ATTESTCOIN_INTEGRATION.md).
- What was implemented, deployed and observed: the top of
  [`STATUS.md`](STATUS.md), in Russian, with addresses and transaction hashes.
