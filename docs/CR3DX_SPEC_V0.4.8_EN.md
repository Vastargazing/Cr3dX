# Cr3dX technical specification v0.4.8

**Project:** Cr3dX, Verified Cross-Chain Credit Layer
**Hackathon:** BUIDL CTC 2026 Fall, RWA track
**Deployment network:** Creditcoin3 Testnet, chain ID **102031**
**Source network:** Ethereum Sepolia

## Provenance and authority

This is the complete English rendering of the Cr3dX v0.4.8 specification. It
introduces no new behavioral rule. The frozen input used by the blind Phase A
model remains the Russian specification from commit
`cbc382b39fabd9a34b218fe6ff35699e18bdca4a`, with normative-package SHA-256
`c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`.
That immutable source is preserved in
[`cr3dx-spec-v0.4.0-final.md`](cr3dx-spec-v0.4.0-final.md).

Phase B matched 63/63 sealed traces, the implementation was aligned by commit
`1a308816ab3b73056718f6f174c47c10f9fb8cd3`, and a fresh v0.4.8 deployment
passed S6 live acceptance. Those post-release facts are not part of the sealed
Phase A input. Current addresses and evidence are recorded in
[`STATUS_EN.md`](STATUS_EN.md), the full historical [`STATUS.md`](STATUS.md), and
[`verification/v0.4.8-phase-b/`](verification/v0.4.8-phase-b/).

For v0.4.8, a disagreement between this rendering and the sealed Russian source
is a translation defect and must be reported and corrected here; it is not a
new semantic revision. Future behavioral revisions are authored in English and
follow [`WORKFLOW.md`](WORKFLOW.md).

## Changes in v0.4.8

This revision closes defects found by a second independent specification review
performed without access to the implementation. The reviewer read v0.4.6 while
the working document had already advanced to v0.4.7; the behavioral sections
were identical, so the review applied to the current base. The revision also
records two Creditcoin Team answers from 2026-08-20.

### 1. `DEFAULTED` is part of canonical classification

Payment classification is derived from accumulated amounts, but an already
recorded `DEFAULTED` outcome persists until full repayment. The current outcome
itself carries this fact; there is no hidden flag. Partial repayment after
default therefore does not erase default, and recomputing from evidence alone
cannot reconstruct that default was declared. INV-4 and section 4.3 use this
state machine.

### 2. `closedAtBlock` is outside economic state

The field records when the current canonical outcome value was first written.
It is frozen while the value is unchanged and is set to the current attested
source height when the value changes. It is outside INV-20 because it describes
registration time, not an economic fact.

### 3. New evidence is applied in two phases

The verifier stores immutable facts only. The path through the deals registry
first applies every funding evidence item created by the call, then every
repayment evidence item created by the call, preserving returned-ID order
within each phase. The order is deterministic: input transaction order, then
log order within a transaction. Previously submitted evidence is not advanced
automatically. This removes dependence on the order of funding and repayment
transactions in one input array.

### 4. INV-19 is a decision rule, not a storage-state invariant

The epistemic criterion from v0.4.6 is unchanged: pending is allowed when the
current canonical state cannot prove permanent inapplicability and an unmet
precondition remains whose resolution may make the evidence applicable. The
criterion must hold when classification is performed. Because there is no
automatic advancement, storage may legally retain evidence whose preconditions
became satisfied later.

### 5. INV-3 and INV-20 share one scope

Economic state is defined once in section 3.2. Both invariants protect it;
evidence state and `closedAtBlock` are outside it. Terminal evidence
classification may depend on delivery order without changing the economic
result. Reserved credit is deliberately inside the scope: repayments do not
touch it, but two independent field lists must not drift.

### 6. Previously underspecified behavior is closed

The revision specifies named errors for a transaction with no relevant logs,
unknown evidence, and invalid `markDefaulted`; atomic batch failure on a
duplicate; permission to create an already-overdue deal; the carrier and
timestamp of `DEFAULTED`; deterministic batch order; and worker consequences.

### 7. Proof-horizon answer recorded

Creditcoin Team stated in Discord `#buidl-ctc-qna` on 2026-08-20 that checkpoints
are retained forever and that cryptographic data for a transaction previously
proved through an attestation remains in an archive node. The first statement
is current runtime policy, not an immutable protocol invariant. The second
depends on archive-node operator policy. The complete question, answer,
provenance, and authority limits are in
[`ATTESTCOIN_INTEGRATION.md`](ATTESTCOIN_INTEGRATION.md). The historical v0.4.7
entry below is preserved because it was correct before that answer.

### 8. Status separates verified facts from unknowns

Changes 1 and 2 described existing behavior. Change 3 exposed a mismatch with
the then-current single-pass implementation. Conformance of the remaining rules
was not presumed before verification.

### 9. Zero gas difference is not treated as a stable rule

The measured difference between `verify` and `verifyAndEmit` remains zero on the
current network. Creditcoin Team indicated that `LOG3` should technically be
charged and that builders may see the cost rise by the size of that log. Our
estimate for an event with 32 bytes of data is about 1,756 gas. A final answer is
still open. Cr3dX uses `verify`, so this risk concerns integrations choosing
`verifyAndEmit`.

### Independent-review result

The reviewer found no route to use one credit limit twice, destroy an already
proved external fact, or make economic outcome depend on order beyond the cases
fixed here. No privileged action was found: the mutating surface is complete and
permissionless, while the credit layer's allowed caller is constructor-fixed
with no setter. The reviewer did not verify the proof horizon because it was an
explicit external question in the supplied document and was closed separately
by the team answer.

## Changes in v0.4.7

External fact: Creditcoin officially confirmed attestation configuration on
2026-08-20. The values are in section 2; mechanism and qualifications are in
`ATTESTCOIN_INTEGRATION.md`.

### 1. Attestation configuration gained a primary source

The source-block attestation interval is 10, the checkpoint interval is 10
attestations (100 source blocks), and 10 attestations are retained, both for
Testnet/Sepolia and Mainnet/Ethereum. Our observed retention window is now
corroboration rather than the source: checkpoint-grid phase explains the
measured boundary exactly. Planning uses the guaranteed floor of 100 blocks
from the attested head, approximately twenty minutes on Sepolia.

These are runtime parameters, not protocol invariants. They are exposed through
the configuration pallet and may change without a precompile ABI change or
notice. “A checkpoint every 100 blocks” must not be presented as an eternal
protocol property.

### 2. The worker always requests a new proof

The proof generator selects the anchor at request time. Cr3dX cannot select that
anchor or re-anchor an assembled proof. Before every submission and retry, the
worker requests a proof again. Stored continuity-proof bytes are never reused;
durable task state is the source transaction identity and event metadata.

### 3. The proof horizon was recorded as an open question

**Historical v0.4.8 note:** this entry was correct at publication. The question
was closed later on 2026-08-20; the current interpretation is in section 2 and
`ATTESTCOIN_INTEGRATION.md`.

The team had explained migration from attestation to checkpoint but had not yet
said checkpoints were retained without limit. Until the follow-up answer, the
specification claimed only the measured window of roughly one hour. This also
exposed an operational issue: exponential backoff makes attempt count a poor
measure of elapsed time, so retries gained a time ceiling and visible state.

### 4. The twenty-minute guideline gained a mechanism

Within the guideline, a recent attestation anchors a short proof. After it is
missed, the generator anchors to a checkpoint and produces a longer, more
expensive proof. Anchor choice does not affect correctness.

## Changes in v0.4.6

The `VERIFIED_PENDING` and INV-19 criterion was corrected. The earlier
“existence of a valid future state” formulation required knowledge unavailable
to the contract. For an invented `dealId` that will never match a deal, no such
future state exists, but a one-way hash cannot prove either that fact or that a
deal will not appear later.

The criterion is epistemic: pending is allowed if current canonical state cannot
prove permanent inapplicability and an unmet precondition may later resolve.
Evidence for an unknown deal waits. Once the deal exists, mismatch with its
immutable terms causes permanent rejection. If the deal never exists, evidence
remains pending indefinitely. This is accepted, with storage spam bounded by
gas cost.

## Changes in v0.4.5

This editorial revision corrected six defects in v0.4.4 without changing target
behavior or deployed code.

### 1. `applyEvidence` is defined by state

Only terminal `APPLIED` and `REJECTED_PERMANENT` are idempotent.
`VERIFIED_PENDING` must re-check conditions on every targeted call and may apply,
reject permanently, or remain pending. Otherwise pending evidence could never be
advanced.

### 2. INV-19 is again the general criterion

Evidence is permanently rejected exactly when current canonical state proves it
can never apply. Pending is allowed while that cannot be proved and an unresolved
precondition may resolve. `WRONG_INVESTOR` and `WRONG_RECIPIENT` are consequences
of the criterion for the current model, not a replacement for it.

### 3. Two consequences for pending evidence are explicit

`dealId` binds `termsHash`, which binds borrower and designated investor, so the
same deal cannot later appear with different terms. A repayment to the correct
recipient while the deal is `CREATED` can never become permanently rejected: it
either applies after funding or remains pending indefinitely.

### 4. Permanent-reason priority is explicit

When funding has both the wrong recipient and wrong investor, recipient is
checked first and the result is `WRONG_RECIPIENT`.

### 5. Document status was corrected

The stale “code comes next” line survived implementation, redeployment, and live
acceptance. The document was updated to record that v0.4.4 was deployed and
accepted while v0.4.5 changed text only.

### 6. The v0.4.4 ordering violation is recorded openly

The required order was target specification, independent blind model and
implementation, then comparison. In fact code, tests, and live acceptance
preceded the final document revision and entered the same commit. The blind
reference-model workspace did not expose the implementation and semantic
decisions preceded code, so
decision independence survived. Wording independence cannot be proved because
the document was written next to completed implementation. No retrospective
spec-only commit was fabricated.

### 7. Twenty minutes is a freshness guideline, not expiration

An assembled continuity proof is not durable and is rebuilt before submission.
The guideline aims for a short, inexpensive proof. The proved fact itself does
not expire; after the guideline the generator can anchor a fresh proof to a
checkpoint without changing the fact's source height.

## Changes in v0.4.4

Six changes: two removed delivery-order or late-knowledge dependence; four made
the document match already implemented and live-accepted behavior.

### 1. `ALREADY_FUNDED` was removed

Rejecting funding after the threshold makes `fundedAmount` depend on delivery
order rather than actual payments. For `requiredFunding = 100` and payments 60,
50, and 40:

| Delivery order | Old behavior | `fundedAmount` |
|---|---|---:|
| 60, 50, 40 | 60; threshold at 110; third rejected | 110 |
| 50, 40, 60 | 50; 90; threshold at 150 | 150 |
| 40, 60, 50 | 40; threshold at 100; third rejected | 100 |

The same set of payments produced three answers controlled by worker delivery
order. This directly violated INV-3. Funding by the designated investor now
always applies, before and after the threshold. `fundedAmount` has no ceiling;
surplus is a voluntary gift from investor to borrower and is not returned.

The one-time event is threshold crossing, not payment. The transition condition
is “below before this payment and not below after it.” Because `fundedAmount`
never decreases, this is true exactly once. Reserved credit becomes exposure at
that crossing and never again.

### 2. Repayment recipient is checked against `designatedInvestor`

Checking `deal.investor` was impossible before funding, so a repayment to the
wrong address waited until funding and was then rejected. Waiting for a fact
that can never become applicable is a false state. The recipient is now checked
against immutable `designatedInvestor`, including before funding. A repayment
to the correct recipient still waits because an unfunded deal owes nothing.

### 3. There is no automatic advancement of pending evidence

Neither deal creation nor funding scans old evidence. The only path is targeted
`applyEvidence`. Scanning an unbounded set inside a transaction paid by an
arbitrary participant would embed denial of service. Discovery belongs to the
worker and interface.

### 4. The single-transaction path is part of the permitted surface

An earlier “no other public functions” statement accidentally contradicted the
`submitAndApply` path required by section 4.2. The state-changing surface is now
complete and explicit; there is still no cancellation, reserve release, or
administrative action.

### 5. `Cr3dXCredit` interface is complete

The specification now includes `openDeal`, `markFinanced`, and `reduceExposure`,
all `onlyDeals`, in addition to `recordOutcome(bytes32, Result)`. The credit
layer reads the attested source height itself for `closedAtBlock`.

### 6. `applyEvidence` behavior is complete

Exactly one case reverts: an identifier absent from the verifier. `APPLIED` and
`REJECTED_PERMANENT` are idempotent. `VERIFIED_PENDING` re-checks and returns its
new or unchanged state without reverting.

## Changes in v0.4.2

This revision made the document self-contained for blind review.

1. INV-3 and INV-12 were reconciled. Two full repayments of 1,100, one at source
   height 110 and one at 90 for `dueBlock = 100`, must produce `PAID_ON_TIME` in
   either delivery order. Status and outcome are canonical derivatives of all
   accumulated applied repayments, not the first threshold crossing.
2. Special-case lists for `VERIFIED_PENDING` were replaced by the general
   criterion in section 3.3, later corrected epistemically in v0.4.6.
3. `WRONG_RECIPIENT` was added for both funding and repayment.
4. Repayment applies even after a deal is closed.
5. Default is permitted only from `FINANCED`.
6. Outcome-counter changes use one general decrement-old/increment-new rule.
7. The submission interface was checked against the accepted verifier ABI; both
   submission functions return `bytes32[]`, enabling a single-transaction path.
8. INV-20 and its mandatory regression scenario were added.

## Changes in v0.4.1

Three uncovered cases were resolved before contract implementation.

### 1. Repeated and partial funding

> **Withdrawn in v0.4.4.** The `ALREADY_FUNDED` decision was removed because it
> made `fundedAmount` order-dependent. The historical text is summarized here;
> accumulation and one-time reserve transition remain current.

The withdrawn rule permanently rejected funding after the threshold. Partial
funding already accumulated as `fundedAmount += amount`, with transition at
`fundedAmount >= requiredFunding`. Unknown deals remained pending. Reserve moved
to exposure exactly once at threshold crossing. The accepted cost was that a
partially funded, abandoned deal could reserve the borrower's own limit forever.

### 2. Units

Contracts operate only in native token units. Solidity never reads `decimals` or
converts units. `BASE_LIMIT` is supplied already converted at deployment.

### 3. Score is clamped once after the complete calculation

```text
rawScore = 500 + 25*paidOnTimeCount - 50*paidLateCount - 200*defaultedCount
score    = clamp(300, 850, rawScore)
```

Stepwise clamping would make results depend on outcome order and violate INV-5.
`rawScore` is `int256`, because multiple defaults can make it negative before
the final clamp. Canonical per-deal outcomes and ordered borrower deal lists are
the source of truth; three counters are a constant-time derived cache.

## Changes from v0.3.4

Reserve release was removed completely: `releaseReserveEarly`,
`releaseExpiredReserve`, `reservationExpiryBlock`, `reserveReleased`, and their
invariant no longer exist. Three properties cannot coexist:

1. valid funding is always accepted, however late;
2. reserved credit can be released and reused for a new deal;
3. the credit limit is strict.

A borrower could create a deal, release its reserve, create another against the
same limit, then prove funding of the first. Exposure doubles. Repeating early
release repeats the attack. Rejecting late proof destroys real payments delayed
by attestation, while a soft limit makes enforcement decorative.

Safe reserve release requires first preventing funding on the source network,
which needs the protocol's outbound direction. That is a one-way-model limit,
not an implementation defect. The accepted cost is that an abandoned deal
occupies only its own borrower's limit forever: a usability defect preferred to
limit bypass.

---

## 0. Positioning

**Cr3dX separates money movement from credit trust.**

Money moves directly between participants on Sepolia. Creditcoin stores the
canonical state of the credit relationship and its history. Attestcoin is the
only mechanism that permits state transitions from external events.

Invoice financing is the first use case, not the product itself.

The project rests on these distinctions:

- movement of money is not credit state;
- an external fact is not a trusted backend assertion;
- proof-delivery order is not economic event order;
- default does not make debt disappear;
- a credit limit is not decorative UI;
- proof validity is not applicability to a deal.

**Non-decorative check:** without Attestcoin, Cr3dX cannot know that a deal was
funded, repaid, or overdue.

---

## 1. Trust boundary

**Cryptographically established:** funding happened, repayment happened, the
deadline passed, and the credit outcome follows from those facts.

**Not established or claimed:** invoice delivery, legal enforceability of the
claim, or borrower identity.

Exact public wording: *Invoice authenticity and legal enforceability are
outside the v0.1 trust boundary.*

**Precise guarantee.** Inclusion is proved in Attestcoin's own tree over
transaction-and-receipt pairs, not directly in an Ethereum tree. Attestors
compare against canonical Ethereum roots off-chain while assembling the data.
The correct claim is that facts are confirmed by attestor consensus and checked
against source-block roots.

**Covered and uncovered fields.** Transaction fields and receipt logs are
covered. RPC-wrapper `from` and `gasUsed` are not covered by the canonical roots
and are never used in Cr3dX logic.

**No enforcement.** There is no collateral or escrow. The investor bears full
non-repayment risk; the borrower's consequence is reputational. This is stated
first in the demo.

**No Sybil resistance.** *Cr3dX score is address-level verified repayment
reputation, not Sybil-resistant creditworthiness.*

**Concrete roadmap boundary.** The protocol's outbound direction (Writability)
was not present in the code at the frozen revision; Creditcoin reported that it
was in final development and outside the hackathon scope. It would enable two
features fundamentally unavailable in v0.1: source-network escrow, providing
real enforcement rather than reputation, and safe reserve release, by first
preventing source funding and then releasing Creditcoin limit. Cr3dX deliberately
does not substitute a trusted operator.

---

## 2. Established protocol facts

**Proved data.** Transaction fields and log data are verified and available to
the contract. `status` is encoded in the proved leaf but the precompile does
**not** enforce it; the consumer must.

**Verification interface.** `verify(uint64 chainKey, uint64 height, bytes
encodedTx, TransactionMerkleProof, ContinuityProof)` returns `true` or reverts.
`verifyAndEmit` also emits `TransactionVerified`.

**`calculateTxIndex`.** Pure; its result may be trusted only after successful
verification of the same proof.

**Attested source height** is synchronously available through `ChainInfo`.
Attestation intentionally lags the source head so state is not built on blocks
that may reorganize.

**Source timestamp is unavailable.** Deadlines use source block heights.

**Batches.** At most 10 heights per call for one chain; one shared continuity
proof must span the minimum through maximum height.

**Precompile addresses:** BlockProver `0xFD2`, ChainInfo `0xFD3`.

**`chainKey`** is Creditcoin's internal sequential registry identifier, not an
EVM chain ID. It is read from the registry.

**`encodedTx`** uses a custom encoding, not RLP. A canonical transaction hash is
recoverable, but Cr3dX does not reconstruct it.

### Measured on live networks

Full tables, methodology, and raw data are in
[`ATTESTCOIN_INTEGRATION.md`](ATTESTCOIN_INTEGRATION.md) and `data/probe/`.

| Parameter | Value |
|---|---|
| Sepolia `chainKey` in the Testnet registry | **1**, encoding v1 |
| Attestation interval | 10 source blocks |
| `MaxCatchup` | 500 blocks |
| Maximum root-chain length | 500 = `max(MaxCatchup, interval)` |
| Maximum batch | 10 heights; 11 is rejected |
| Attestation lag behind Sepolia | 32–41 blocks, 6.5–8.5 minutes, ten-block sawtooth |
| Proof-generator cache lag | up to 10 additional blocks |
| `verify` gas, gateway-shaped transaction | about 47,000; calldata about 42% |
| Batch-of-10 gas | about 400,000 |
| `verify` versus `verifyAndEmit` | observed difference 0; Creditcoin indicated missing `LOG3` charging may be a billing issue; final answer open |
| **`attestationGracePeriod`** | **600 source blocks** |

`attestationGracePeriod` derives from `MaxCatchup`, not observed steady-state
lag. Attested height can advance 500 blocks in one Creditcoin block during
catch-up. The constant must survive one such jump:
`500 + 41 + 10 + 25 = 576`, rounded to 600.

### Confirmed by Creditcoin Team

Creditcoin Team response, Discord, 2026-08-20. The team answer is the primary
source; measurements are corroboration. Mechanism and qualifications are in
`ATTESTCOIN_INTEGRATION.md`.

| Parameter | Testnet / Sepolia | Mainnet / Ethereum |
|---|---|---|
| Attestation interval | every 10 source blocks | same |
| Checkpoint interval | every 10 attestations, or 100 source blocks | same |
| Attestation retention | 10 | same |

These are runtime parameters, exposed through the configuration pallet. They
can change without a precompile ABI change or notice. No contract invariant
depends on them.

**The observed window matches configuration exactly.** Bisection found the
oldest live attestation at 11,521,710 with attested head 11,521,850: a 140-block
distance. The extra 40 beyond 100 is not attestation lag; the bisection already
measured from the attested head, so adding lag would double-count it. It is the
head's phase within a 100-block checkpoint grid: the last checkpoint was
11,521,800, and ten attestations back is exactly 11,521,710.

Therefore 140 is not a constant. The window from attested head varies from
about 100 blocks just after a checkpoint to about 190 just before the next.
Planning uses the 100-block floor, the twenty-minute Sepolia guideline. Tying
pruning to checkpoint slicing is our inference from one exact match, not a team
statement; the 100-block floor holds without that inference. The same data show
that “10” counts attestations rather than checkpoints. Confirmation of that
unit was requested from the team.

**The proof generator chooses the anchor.** It uses the best available anchor
at request time. A proof anchored to a normal attestation stops working after
that attestation is pruned and must be replaced with a proof whose root chain
reaches a checkpoint. That is a different proof, not a repaired one. The only
remedy is a new API request.

**The proof horizon has two authority boundaries.** Asked whether a fresh proof
could later be assembled for an old transaction, Creditcoin Team said: (1)
checkpoints are stored forever, confirming future checkpoint anchoring under
current runtime storage policy, not an immutable protocol invariant; and (2)
cryptographic data for a transaction previously proved through an attestation
is preserved in an archive node, so it remains provable. The second is an
infrastructure statement: archive-node operator policy is not exposed through
configuration and is not a protocol guarantee. Our measurement covered only a
roughly one-hour window and is not the source for either claim.

The team's phrase about off-chain caching does not authorize reuse of an old
continuity proof; the author explicitly was unsure what “caching” meant. Rule 25
remains strict: durable state is transaction/event identity and a fresh proof is
requested for every submission and retry.

**`encodedTx` shape.** The blob is `abi.encode(uint8 txType, bytes[] chunks)`;
the receipt chunk is always last. `status` and the full log list are decoded in
one `abi.decode` without transaction-type branching. `from` and `gasUsed` live
in chunks this path never decodes, so rule 4 is enforced by decoder shape rather
than discipline.

---

## 3. Model

### 3.1 Identifiers

```text
dealId     = keccak256(creditcoinChainId, dealsContractAddress, dealSeq, termsHash)
termsHash  = keccak256(borrower, designatedInvestor, requiredFunding, faceValue, dueBlock)
evidenceId = keccak256(chainKey, blockHeight, txIndex, eventKind, eventNonce)
```

`txIndex` is obtained only after successful verification. `eventNonce` is read
from the verified log. Contracts do not use `sourceTxHash`; the UI may show an
explorer link and labels it informational.

### 3.2 Entities

**Deal**

```text
dealId, dealSeq, borrower, designatedInvestor, investor,
requiredFunding, fundedAmount, faceValue, repaidAmount, onTimeRepaid,
dueBlock, status
```

Constraint: `0 < requiredFunding <= faceValue`. All amounts are token-native
units. Contracts do not read `decimals`.

**Evidence**

```text
evidenceId, kind (FUNDING | REPAYMENT), dealId, counterparty, recipient,
amount, blockHeight, state, rejectionReason
```

`rejectionReason` is `NONE`, `WRONG_INVESTOR`, or `WRONG_RECIPIENT`. There are
exactly two permanent reasons in the current model; section 3.3 defines the
criterion that makes a reason permanent.

**CreditOutcome** — one canonical outcome per deal:

```text
dealId, result (PAID_ON_TIME | PAID_LATE | DEFAULTED), closedAtBlock
```

Payment classification uses accumulated amounts while preserving an already
declared default until full repayment:

```text
if onTimeRepaid >= faceValue:       PAID_ON_TIME
else if repaidAmount >= faceValue:  PAID_LATE
else if current outcome == DEFAULTED: DEFAULTED
else:                               no outcome
```

Only `markDefaulted` creates the transition from no outcome to `DEFAULTED`.
There is no hidden default flag. Partial repayment keeps
`repaidAmount < faceValue`, so the third branch preserves default.

`closedAtBlock` records when the **current value** of canonical outcome was first
written, not when the source-network deal closed. It is unchanged while the
outcome value is unchanged and becomes the current attested source height when
the value changes.

**Economic state** comprises deal status, accumulated amounts, outstanding,
reserved credit, exposure, score, and canonical-outcome classification.
Evidence state and `closedAtBlock` are not economic state.

### 3.3 Evidence state machine

```text
UNSEEN -- verify() ok --> VERIFIED_PENDING -- preconditions satisfied --> APPLIED
                              |
                              +-- permanent reason --> REJECTED_PERMANENT
```

Submission through the deals registry applies only evidence created by that
call, in two phases: all funding, then all repayment. Returned-ID order is
preserved in each phase. Old pending evidence advances only through targeted
`applyEvidence`; there is no automatic scan.

**Canonical `VERIFIED_PENDING` rule:**

> `VERIFIED_PENDING` is permitted exactly when the current canonical state
> cannot prove that the evidence is permanently inapplicable and an unmet
> precondition remains whose resolution may make the evidence applicable.

This is a classification rule at the time of initial application or targeted
`applyEvidence`, not a continuous invariant over stored records. A record may
legally remain pending after its precondition later becomes true, until someone
calls the targeted advancement path. Fuzzing checks the classification chosen
at the call, not continuous agreement of every stored item with current state.

If current canonical state already proves that application is impossible
forever, evidence becomes `REJECTED_PERMANENT`.

Before a deal exists, its terms cannot be recovered from the one-way `dealId`,
so evidence waits. Once a deal exists, its terms are unique because `dealId`
binds `termsHash`, which binds borrower, designated investor, required funding,
face value, and due block, assuming `keccak256` collision resistance. If an
invented or mistyped deal never appears, its evidence remains pending
indefinitely. This accepted storage cost is paid in gas.

The rule is a criterion rather than a case list so new cases cannot silently
fall outside the specification.

| Situation | State | Reason |
|---|---|---|
| No deal with this `dealId` | `VERIFIED_PENDING` | it may be created later |
| Correct-recipient repayment arrives before funding | `VERIFIED_PENDING` | an unfunded deal owes nothing; it may be funded later |
| Funding from someone other than designated investor | `REJECTED_PERMANENT` | `designatedInvestor` is immutable |
| Designated-investor funding above threshold | `APPLIED` | money moved; rejection would create order dependence |
| Wrong recipient | `REJECTED_PERMANENT` | recipient derives from immutable deal fields |

Current permanent reasons, as consequences of the general criterion:

- `WRONG_INVESTOR`: funding event investor differs from
  `designatedInvestor`;
- `WRONG_RECIPIENT`: funding recipient differs from `borrower`, or repayment
  recipient differs from `designatedInvestor`.

For funding with both mismatches, recipient is checked first and the result is
always `WRONG_RECIPIENT`. This is deterministic selection, not importance.

Repayment recipient is compared with `designatedInvestor`, not `deal.investor`.
After funding they are the same address; before funding only
`designatedInvestor` is known. A wrong-address repayment can therefore be
rejected immediately instead of waiting for funding that cannot rescue it.

If recipient matches while status is `CREATED`, permanent rejection is
unreachable. The repayment either applies after threshold funding or remains
pending indefinitely.

If a complete state table reveals another case that can never become
applicable, a third reason must not be added silently. First record the uncovered
case in a new specification revision.

### 3.4 Deal lifecycle

```text
CREATED -- fundedAmount >= requiredFunding --> FINANCED -- repaidAmount >= faceValue --> PAID_LATE
                                                |                                       |
                                                |                         onTimeRepaid >= faceValue
                                                |                                       v
                                                |              +--------------------> PAID_ON_TIME
                                                |              |
                                                +--> DEFAULTED -+
                                                     attested height > dueBlock + grace
```

`PAID_ON_TIME` is terminal because `onTimeRepaid` is monotonic. `PAID_LATE` and
`DEFAULTED` may be refined upward.

Allowed refinements:

```text
DEFAULTED    -> PAID_LATE
DEFAULTED    -> PAID_ON_TIME
PAID_LATE    -> PAID_ON_TIME
PAID_ON_TIME -> PAID_ON_TIME
```

Forbidden transitions:

```text
PAID_ON_TIME -> PAID_LATE    refinements are upward only
PAID_*       -> FINANCED     a closed deal does not reopen
PAID_*       -> DEFAULTED    default rule in section 4.3
```

Default is possible only from `FINANCED`, never `CREATED` or `PAID_*`.

There is no cancellation. Reserved credit is released only by funding threshold
crossing. A created deal can accept funding indefinitely.

Funding an already-overdue deal is deliberately accepted. It becomes
`FINANCED` and immediately eligible for default if the grace threshold has
passed. Rejecting overdue funding would destroy recognition of money that
actually moved. The investor chose the payment; the system records the fact.

### 3.5 Asset

One fixed test-USDC address on Sepolia. Amounts use native token units.

---

## 4. Contracts

### 4.1 `Cr3dXGateway.sol` on Sepolia

```solidity
function fund(bytes32 dealId, address borrower, uint256 amount) external;
function repay(bytes32 dealId, address investor, uint256 amount) external;

event FundingMade(bytes32 indexed dealId, address indexed investor, address indexed borrower, uint256 amount, uint256 nonce);
event RepaymentMade(bytes32 indexed dealId, address indexed payer, address indexed investor, uint256 amount, uint256 nonce);
```

The gateway moves tokens directly from sender to recipient. The token address
is fixed at deployment. It stores no funds and knows no Creditcoin state.

Investor and payer are explicit event fields sourced from `msg.sender`; the
credit layer relies on the event, not the transaction sender wrapper.

`nonce` is one shared gateway counter for both event kinds.

### 4.2 `Cr3dXVerifier.sol` on Creditcoin

The actual accepted, compiled interface is:

```solidity
function submitEvidence(
    uint64 height,
    bytes calldata encodedTx,
    IBlockProver.MerkleProof calldata mp,
    IBlockProver.ContinuityProof calldata cp
) external returns (bytes32[] memory ids);

function submitEvidenceBatch(
    uint64[] calldata heights,
    bytes[] calldata encodedTxs,
    IBlockProver.MerkleProof[] calldata mps,
    IBlockProver.ContinuityProof calldata sharedCp
) external returns (bytes32[] memory ids); // 1..10 heights; shared proof spans range
```

Both functions return the created IDs. The verifier then stops: it stores
immutable verified facts, knows nothing about the deals registry, and never
calls it. The single-transaction path is therefore:

```text
Cr3dXDeals
  -> Verifier.submitEvidence(...)
  -> receives bytes32[] evidenceId
  -> applies those facts in two phases in the same transaction
```

There is no reverse dependency. `Deals` constructor-fixes `Verifier`; the
verifier never knows or calls `Deals`. Anyone may submit directly to the
verifier, and anyone may later call `applyEvidence(evidenceId)` in the registry.

Registry reads:

```solidity
function getEvidence(bytes32 evidenceId) external view returns (VerifiedEvidence memory);
function seen(bytes32 evidenceId) external view returns (bool);
function evidenceIdOf(uint64 height, uint64 txIndex, EvidenceKind kind, uint256 eventNonce) external view returns (bytes32);
```

Use `getEvidence`, not the generated storage getter; struct layout is optimized
for packing. Unknown IDs revert with named `UnknownEvidence`; an empty struct is
not a valid answer.

`evidenceId` is deployment-independent:
`keccak256(abi.encode(chainKey, height, txIndex, uint8(kind), eventNonce))`.
Redeployment reproduces the same IDs for the same facts. This was checked live.

Strict processing order, each failure named:

1. `verify(chainKey, height, encodedTx, mp, cp)`. Failure is a precompile revert;
   there is no false-return branch in Cr3dX.
2. `calculateTxIndex(mp)`, only after step 1.
3. Require `status == 1`; the precompile does not.
4. Scan every log of every proved transaction. A log is relevant only when its
   emitter is the fixed gateway and its topic is `FundingMade` or
   `RepaymentMade`. Every relevant event creates separate evidence; other logs
   are ignored. A proved transaction with no relevant fact reverts
   `NoRelevantEvidence`; in a batch this atomically reverts the batch.
5. Every `evidenceId` must be unseen. One duplicate atomically reverts the whole
   call with `EvidenceAlreadyRecorded`; there is no partial success.
6. Save immutable verified facts and stop. Direct submission leaves them
   unapplied until a registry call.

Returned-ID order is deterministic: input transaction order and then log order.
The limit of ten applies to heights, not IDs; one transaction may create several
facts. `from` and `gasUsed` are never used.

---

### 4.3 `Cr3dXDeals.sol` on Creditcoin

```solidity
function createDeal(address designatedInvestor, uint256 requiredFunding, uint256 faceValue, uint64 dueBlock) external returns (bytes32);
function applyEvidence(bytes32 evidenceId) external returns (EvidenceState, RejectionReason);
function markDefaulted(bytes32 dealId) external; // permissionless; uses attested height

function submitAndApply(uint64 height, bytes encodedTx, MerkleProof mp, ContinuityProof cp) external returns (bytes32[] memory);
function submitAndApplyBatch(uint64[] heights, bytes[] encodedTxs, MerkleProof[] mps, ContinuityProof sharedCp) external returns (bytes32[] memory);
```

This is the complete state-changing surface. View functions make no decisions.
The absence of cancellation, reserve release, and administrative actions is a
design property.

`submitAndApply` and `submitAndApplyBatch` apply only facts created by that call:

```text
ids = identifiers returned by verifier
for id in returned order: apply if kind == FUNDING
for id in returned order: apply if kind == REPAYMENT
```

Two phases are sufficient because dependency is one-way: funding can make
repayment applicable, repayment cannot make funding applicable. Old evidence is
not included. A general fixed-point scan is unnecessary and would have a
quadratic worst case. Repayment at height 50 and funding at 60 therefore produce
the same economic state for input orders `[50, 60]` and `[60, 50]`.

**`applyEvidence` behavior:**

- ID absent from the verifier: revert. An unverified ID is not pending; it does
  not exist.
- `APPLIED` or `REJECTED_PERMANENT`: return the terminal state without change or
  revert. Only these states are idempotent.
- `VERIFIED_PENDING`: re-check applicability. Apply if conditions are met;
  reject permanently if canonical state proves permanent inapplicability;
  otherwise remain pending. None of these branches reverts.

There is no automatic advancement of old pending evidence. Deal creation and
funding do not scan stored evidence. The sole path is targeted `applyEvidence`.
An unbounded scan paid by an arbitrary participant would be an embedded denial
of service; discovery belongs to the worker and UI.

Creating a deal whose `dueBlock` is already past is allowed. The deadline is
part of `termsHash`, and funds do not move until funding. After financing, such
a deal is immediately defaultable if attested height is already above
`dueBlock + attestationGracePeriod`, otherwise when that threshold is reached.

All time thresholds use attested Sepolia height from `ChainInfo`, never
Creditcoin `block.number`.

`attestationGracePeriod` covers the largest one-step attested-height jump,
structural lag, attestation interval, and worker submission time. It is supplied
at deployment from measurements; the current value is 600 source blocks.

Grace prevents cosmetic false defaults; it is not the basis of correctness.
Correctness comes from outcome accounting by source payment height. Even after
`DEFAULTED`, later delivery of evidence for an on-time payment refines the deal
to `PAID_ON_TIME`.

Default is allowed only from `FINANCED`:

```text
markDefaulted(dealId) requires:
    deal.status == FINANCED
    attested source height > deal.dueBlock + attestationGracePeriod
```

Unknown deals and every wrong status, including `CREATED`, `DEFAULTED`,
`PAID_ON_TIME`, and `PAID_LATE`, revert with `NotDefaultable`. An unrequested
deal owes nothing, and advancing height cannot default a repaid debt. Successful
`markDefaulted` writes canonical `DEFAULTED` with `closedAtBlock` equal to the
current attested source height.

**Full proved-amount accounting.** After every applied repayment:

```text
repaidAmount += amount
if blockHeight <= dueBlock: onTimeRepaid += amount
```

Amounts are never capped by remaining debt; capping would make the result
delivery-order-dependent.

Recompute canonical payment classification after every applied repayment while
preserving declared default until full repayment:

```text
if onTimeRepaid >= faceValue:       PAID_ON_TIME
else if repaidAmount >= faceValue:  PAID_LATE
else if current outcome == DEFAULTED: DEFAULTED
else:                               no outcome
```

The current outcome itself carries default. Partial repayment keeps
`DEFAULTED`; full repayment refines it to `PAID_LATE` or `PAID_ON_TIME`.
Recomputation from evidence alone cannot reconstruct the historical
`markDefaulted` call. INV-5 instead recomputes score from stored canonical
outcomes.

Deal status and `CreditOutcome` change in one transition and transaction. They
must never disagree.

Repayment applies regardless of whether the deal is already closed. It applies
in `FINANCED`, `DEFAULTED`, `PAID_LATE`, and `PAID_ON_TIME`, always increasing
`repaidAmount`, and `onTimeRepaid` when timely. The outcome is then refined or
left unchanged. A proved fact does not cease to exist because an outcome was
already recorded.

Outcome refinement does not touch reserve or exposure. `DEFAULTED -> PAID_*`
and `PAID_LATE -> PAID_ON_TIME` are reclassification, not new accounting.
Exposure follows proved amounts:

```text
outstanding(deal) = max(faceValue - repaidAmount, 0)
```

Overpayment cannot make outstanding negative or release exposure twice.
Attestation lag does not affect timeliness; source block height does.

**Funding application:**

- unknown `dealId`: `VERIFIED_PENDING`;
- event recipient differs from `borrower`: `REJECTED_PERMANENT`,
  `WRONG_RECIPIENT`;
- event investor differs from `designatedInvestor`: `REJECTED_PERMANENT`,
  `WRONG_INVESTOR`;
- otherwise always execute `fundedAmount += amount`;
- if the amount crosses from below `requiredFunding` to at-or-above it, perform
  `CREATED -> FINANCED`, fix investor, and convert reserve to exposure.

Recipient is checked before investor; if both mismatch, the reason is
`WRONG_RECIPIENT`.

Funding accumulates without a ceiling. Neither insufficient nor surplus amounts
are rejected because the money already moved. Surplus is a voluntary gift from
investor to borrower; Creditcoin cannot invent a source-network refund.

The transition is threshold crossing, not current-sum state. Because
`fundedAmount` never decreases, “below before, not below after” is true for
exactly one applied funding item in every order.

Reserve converts to exposure exactly once:

```text
createDeal                        reserved += faceValue

ordinary funding                 fundedAmount += amount
                                 reserved and exposure unchanged

threshold crossing               CREATED -> FINANCED
before: fundedAmount < required  reserved -= faceValue
after:  fundedAmount >= required exposure += faceValue
```

Funding by the designated investor always applies, regardless of limit, time,
overdue deadline, amount size, or a threshold already reached. A deal still
cannot be financed twice: only one crossing converts reserve to exposure.

**Repayment application:**

- unknown `dealId`: `VERIFIED_PENDING`;
- event recipient differs from `designatedInvestor`: `REJECTED_PERMANENT`,
  `WRONG_RECIPIENT`, including before funding;
- status `CREATED`: `VERIFIED_PENDING`; recipient is correct but an unfunded
  deal has no debt;
- otherwise accumulate amounts and recompute outcome in `FINANCED`,
  `DEFAULTED`, `PAID_LATE`, or `PAID_ON_TIME`.

Repayment never applies to `CREATED`; otherwise an unfunded deal could become
`PAID_ON_TIME`, contradicting the lifecycle and leaving its reserve undefined.

Repayment may arrive before funding and wait. Delivery order never changes the
economic outcome; see INV-20.

**Explicit limitation.** The payment network does not know credit-layer state,
so funds sent to the wrong address or wrong deal can be lost. Mitigation is an
addressed deal and UI-populated parameters.

### 4.4 `Cr3dXCredit.sol` on Creditcoin

```solidity
// state-changing, all onlyDeals; `deals` is constructor-fixed with no setter
function openDeal(bytes32 dealId, address borrower, uint256 faceValue) external onlyDeals;
function markFinanced(bytes32 dealId) external onlyDeals;
function reduceExposure(bytes32 dealId, uint256 amount) external onlyDeals;
function recordOutcome(bytes32 dealId, Result r) external onlyDeals;

// views
function scoreOf(address borrower) external view returns (uint16);
function limitOf(address borrower) external view returns (uint256);
function availableLimitOf(address borrower) external view returns (uint256);
function exposureOf(address borrower) external view returns (uint256);
function reservedOf(address borrower) external view returns (uint256);
```

```text
BASE_SCORE       500
BASE_LIMIT       deployment parameter in native token units
                 (5,000 six-decimal USDC = 5_000_000_000)
PAID_ON_TIME    +25
PAID_LATE       -50
DEFAULTED      -200

rawScore = BASE_SCORE + 25*paidOnTime - 50*paidLate - 200*defaulted // int256
score    = clamp(300, 850, rawScore)                                 // uint16
limit    = BASE_LIMIT * score / BASE_SCORE
```

Clamp once after the complete calculation. Stepwise clamping would make score
depend on outcome order and violate INV-5. `rawScore` is signed because several
defaults legitimately drive it below zero before the clamp. Score is a pure
function of the multiset of outcomes.

Canonical per-deal outcomes and the ordered borrower deal list are the source of
truth and audit trail. Three counters are a derived cache.

One general mechanism handles every outcome change:

```text
when recording a new canonical outcome:
    if new equals old:
        change nothing, including closedAtBlock
    if old exists and differs:
        decrement counter(old)
    if new differs from old:
        increment counter(new)
        store new canonical outcome
        closedAtBlock = current attested source height
```

This is constant time. Special casing only `DEFAULTED -> paid` would omit other
allowed refinements. Outcome refinement does not recalculate exposure; repayment
already changed `repaidAmount` when applied.

Reserve and exposure:

```text
createDeal                        reserved += faceValue
fundedAmount crosses required    reserved -= faceValue; exposure += faceValue

exposure(borrower) = sum outstanding for FINANCED and DEFAULTED deals
                     (closed deals have zero outstanding by construction)
used               = reserved + exposure
availableLimit     = used >= limit ? 0 : limit - used
```

Deal reserve is removed only at funding threshold crossing, exactly once. No
other path exists, so one limit cannot support two deals. Partial funding does
not touch reserve. Subtraction must saturate because exposure may legally exceed
limit after a score decrease. Default does not release exposure; debt still
exists.

---

## 5. Invariants

- **INV-1.** `FINANCED`, `PAID_ON_TIME`, and `PAID_LATE` are reachable only
  through evidence that passed the verifier.
- **INV-2.** One `evidenceId` is accounted at most once.
- **INV-3.** For a fixed set of verified facts, economic state is independent of
  their delivery and application order. Evidence state is outside the scope: the
  same fact may legally remain `VERIFIED_PENDING` when submitted early or receive
  immediate terminal classification when submitted later, provided economic
  outcome is equal.
- **INV-4.** Each deal has at most one canonical `CreditOutcome`. It refines only
  upward through section 3.4 transitions and always equals the canonical rule:
  `PAID_ON_TIME` when `onTimeRepaid >= faceValue`; otherwise `PAID_LATE` when
  `repaidAmount >= faceValue`; otherwise preserved `DEFAULTED` when current
  outcome is already `DEFAULTED`; otherwise no outcome.
- **INV-5.** Score computed from counters always equals full recomputation from
  the borrower's canonical per-deal outcomes. Outcome order does not matter.
- **INV-6.** Splitting a payment cannot increase score.
- **INV-7.** No role, including deployer or borrower, can directly change deal
  status, evidence, outcome, or reserve.
- **INV-8.** Every evidence item refers to a verified event in a verified
  transaction.
- **INV-9.** `outstanding` is never negative; `exposure` equals the sum of
  `outstanding` over `FINANCED` and `DEFAULTED` deals.
- **INV-10.** `createDeal` is impossible when `faceValue > availableLimit`, with
  saturating available-limit calculation.
- **INV-11.** Funding whose recipient equals `deal.borrower` and whose investor
  equals `deal.designatedInvestor` always applies. Limit, time, overdue
  `dueBlock`, insufficient amount, and an already crossed threshold cannot
  reject it. `fundedAmount` has no upper bound.
- **INV-12.** `PAID_ON_TIME` is possible exactly when
  `onTimeRepaid >= faceValue`, meaning applied repayments at
  `blockHeight <= dueBlock` cover face value.
- **INV-13.** A deal's reserve is removed only when verified funding crosses
  `requiredFunding`, exactly once. Partial funding does not touch reserve. One
  credit limit cannot support two deals.
- **INV-14.** Every decision that a time threshold passed uses attested source
  height.
- **INV-15.** No field outside canonical source roots, including `from` and
  `gasUsed`, influences state.
- **INV-16.** `txIndex` is calculated only after successful verification of the
  same proof.
- **INV-17.** Every relevant event in a proved transaction creates exactly one
  evidence item.
- **INV-18.** `fundedAmount` crosses `requiredFunding` exactly once, so
  `CREATED -> FINANCED` and reserve-to-exposure conversion happen exactly once,
  regardless of funding count or order. This is an invariant about crossing,
  not payment count.
- **INV-19.** At classification time, evidence receives
  `REJECTED_PERMANENT` exactly when current canonical state proves permanent
  inapplicability. At the same moment `VERIFIED_PENDING` is allowed when that
  cannot be proved and an unmet precondition may make the evidence applicable.
  This is a call-time decision rule, not an invariant over all stored records.
  The current model yields `WRONG_INVESTOR` and `WRONG_RECIPIENT`; the former
  applies only to funding and the latter to both kinds. The count of reasons is
  a consequence of the model, not part of the criterion.
- **INV-20.** For a fixed set of applied repayment evidence, economic state is
  independent of delivery order. `closedAtBlock` is outside scope because it is
  registration time, not an economic fact.
- **INV-21.** `deal.status` and canonical `CreditOutcome` never disagree; one
  transition in one transaction updates both.
- **INV-22.** `markDefaulted` is possible only from `FINANCED`. `CREATED`,
  `PAID_ON_TIME`, and `PAID_LATE` never transition to `DEFAULTED` at any attested
  height.

Observable INV-3 boundary: wrong-investor funding submitted before deal creation
is pending because terms are unknown; the same fact after creation is
permanently rejected. Economic state is equal in both orders even though
evidence state differs.

### Mandatory INV-20 regression

```text
faceValue = 1100
dueBlock  = 100

A: repayment 1100 at height 110  (late)
B: repayment 1100 at height 90   (on time)
```

`A -> B` and `B -> A` must both produce:

```text
repaidAmount = 2200
onTimeRepaid = 1100
outstanding  = 0
status       = PAID_ON_TIME
outcome      = PAID_ON_TIME
counters, score, and exposure equal
```

This counterexample exposed the v0.4.1 contradiction between INV-3 and INV-12.

---

## 6. Threat model

| Threat | Treatment |
|---|---|
| Forged proof | Protocol attestor consensus |
| Replay of a valid proof | INV-2 |
| Two events in one transaction mistaken for replay | Event nonce in ID; INV-17 |
| Proof from an old deployment | `dealId` includes registry address and chain ID |
| Event from an impostor contract | Verified log-emitter address |
| Reverted source transaction | Explicit `status == 1` |
| Investor substituted through uncovered field | Investor comes from log; INV-15 |
| Trusting index before proof verification | INV-16 |
| Score farming by payment splitting | INV-6 |
| Outcome depends on delivery order | Full-amount accounting; INV-3 and INV-12 |
| Proof submitter affects timeliness | Source block height determines timeliness |
| False default from attestation lag | `attestationGracePeriod`; INV-14 |
| One limit used twice | Reserve removed only by funding; INV-13 |
| Funds destroyed by time or limit rejection | No cancellation or timer; INV-11 |
| Funds destroyed by insufficient-funding rejection | Funding accumulates; INV-11 |
| Same deal financed twice | Threshold crosses once; INV-18. Surplus applies without doubling exposure |
| `fundedAmount` depends on delivery order | Uncapped accumulation; INV-3 and INV-11 |
| Score depends on outcome order | One final clamp; INV-5 |
| Deal outcome depends on repayment order | Recompute from accumulated amounts; INV-20 |
| Deal status and credit outcome diverge | One atomic transition; INV-21 |
| Repaid deal defaulted after height advances | Default only from `FINANCED`; INV-22 |
| Proved repayment ignored after close | Repayment applies in every non-`CREATED` status; section 4.3 |
| Wrong-recipient payment accepted | `WRONG_RECIPIENT`; INV-19 |
| Wrong-recipient payment waits forever | Compare with immutable `designatedInvestor` |
| One transaction scans every pending item | No automatic advancement; targeted `applyEvidence` only |
| Negative raw-score overflow | Signed `rawScore` |
| Exposure above limit underflows | Saturating subtraction; INV-10 |
| Default releases limit | INV-9 |
| Storage spam for nonexistent deals | Gas-bounded and accepted |
| Abandoned deal reserves limit forever | Accepted usability cost affecting only that borrower |
| Sybil and self-funding | Explicitly outside trust boundary |
| Worker failure | Manual permissionless submission |
| Invented invoice | Explicitly outside trust boundary |
| Old fact cannot be reproved after normal attestation pruning | Team reports permanent checkpoints and archive-node cryptographic data, with runtime/infrastructure authority limits; build a fresh proof before every submission |
| Infinite retry task remains invisible | Elapsed-time and attempt ceilings, bounded delay, visible task state; proof horizon is separate |

---

## 7. Worker

```text
WATCHING -> PENDING_ATTESTATION -> PROVING -> SUBMITTING -> DONE | FAILED
```

The worker watches gateway events, waits until attested source height reaches the
transaction block, requests a ProofBuilder proof, submits, and retries with
exponential backoff. When automatic retries are exhausted, the task becomes
visible for manual submission. A disk queue survives restart.

Batches are atomic on duplicates. If an outside submitter has already recorded
one fact, `EvidenceAlreadyRecorded` reverts the entire worker batch; the fact is
not destroyed. The worker rebuilds without the duplicate or advances the
recorded fact through targeted `applyEvidence`.

**Request a new proof before every submission and retry.** The generator selects
the anchor at request time. Cr3dX cannot influence that selection or re-anchor
an assembled proof. Saved continuity-proof bytes are never reused between
attempts, after restart, or from a fixture.

**Durable task state is source transaction and event identity:** transaction
hash, height, index, kind, event nonce, and decoded log fields. Generated proof
bytes are an in-flight message: assemble, submit, discard. Restart resumes by
requesting a new proof, not replaying stale proof bytes.

**Freshness guideline: about twenty minutes after the height becomes attested.**
This is 100 Sepolia blocks, the guaranteed floor of ten retained attestations at
ten-block intervals. The actual window can reach roughly 190 blocks depending
on checkpoint-grid phase, so planning uses the floor. Inside it, a recent
attestation usually anchors a short proof; afterward a checkpoint produces a
longer proof and roughly 34,000 additional gas in the measured comparison. This
is cost, not expiration. Anchor choice does not affect correctness, and source
height does not change with delivery delay.

**Automatic retries have elapsed-time and attempt ceilings.** Attempt count
alone does not bound task duration under exponential backoff. Delay is capped.
At the ceiling, only automatic retries stop: task and metadata remain, on-chain
`Evidence` state is unchanged, no terminal rejection is invented, and the UI
permits manual submission or explicit automatic-resume.

**Read attestation parameters from the network at startup.** Attestation and
checkpoint intervals are available through `state_call` methods
`AttestorApi_chain_attestation_interval` and
`AttestorApi_attestation_checkpoint_interval`; helpers exist in
`scripts/lib/rpc.ts`. Log the values and warn on disagreement with recorded
assumptions. They affect freshness planning and diagnostics only, never a
correctness decision, so unavailability does not block startup. No separate
known accessor exposes retention; it may be observed through
`get_attestation_bounds` when needed.

No separate default-height polling is required; the contract reads it. The
worker and SDK are TypeScript.

---

## 8. Demo scenario

Required flow:

1. A borrower with no history creates a deal: funding 1,000, face value 1,100,
   designated investor. Score, limit, and reserve are visible. `dueBlock` leaves
   more room than the attestation-lag window.
2. The investor calls Sepolia `fund`; 1,000 USDC goes directly to the borrower.
3. The demo honestly shows attested source height catching up to the transaction
   block.
4. The deal becomes `FINANCED`; reserve becomes exposure.
5. A payer calls `repay`; 1,100 USDC goes directly to the investor.
6. The deal becomes `PAID_ON_TIME`; outcome is recorded, exposure is released,
   and score rises.
7. The borrower creates another deal; the contract enforces the increased
   available limit.
8. Negative path: replay is rejected; funding from a non-designated investor
   becomes `REJECTED_PERMANENT` with a reason.

Stretch: overdue deal, attested-height `DEFAULTED`, occupied exposure, limit
rejection, late repayment, and `PAID_LATE`.

The voiceover states that attestation lag protects against source-network
reorganizations; it is not latency introduced by Cr3dX.

---

## 9. Tests

- **Unit:** status transitions, evidence state machine, score/reserve/exposure
  arithmetic, log decoding, and identifiers.
- **Negative:** replay; atomic duplicate inside a batch; proved transaction with
  no relevant log; wrong log emitter; `status == 0`; wrong funding investor;
  wrong repayment recipient before and after funding; deal above limit; default
  before attested threshold; `markDefaulted` for unknown deal or wrong status;
  unknown-ID `getEvidence` and `applyEvidence`.
- **Invariant fuzzing:** INV-2, INV-3, INV-4, INV-5, INV-6, INV-9, INV-10,
  INV-11, INV-12, INV-13, INV-17, INV-18, INV-19, INV-20, INV-21, INV-22.
  INV-19 is checked as call-time classification, not a continuous storage
  property.
- **E2E:** full path on live testnets from clean state in one script.
- **Tested but not required in demo:** `DEFAULTED -> PAID_LATE` and
  `DEFAULTED -> PAID_ON_TIME`.

Mandatory distinguishing cases:

1. Two partial repayments delivered in reverse source-height order give the
   same result.
2. Late partial plus on-time full repayment gives `PAID_ON_TIME` in either
   application order.
3. Funding for a deal whose `dueBlock` already passed applies.
4. Designated-investor funding after threshold applies and does not convert
   reserve to exposure twice.
5. Funding payments 60, 50, and 40 with `requiredFunding = 100` produce
   `fundedAmount = 150` in all six delivery orders.
6. Wrong-recipient repayment before funding rejects immediately; correct
   recipient waits and applies later. No repayment amount closes `CREATED`.
7. Repayment and funding created by one call in both input orders produce equal
   economic state through funding-first and repayment-second phases.
8. A repayment submitted separately before funding remains stored pending after
   separate funding until targeted `applyEvidence`; this does not violate
   INV-19.
9. Repeating `applyEvidence` on applied, rejected, and pending evidence does not
   revert or corrupt state; unknown ID reverts.
10. Created but unfunded deals can exhaust limit and prevent a new deal.
11. Overpayment cannot make outstanding negative; exposure above limit cannot
    underflow.
12. One transaction with two gateway events creates two evidence items.
13. Late and on-time full repayments in either order produce `PAID_ON_TIME`, the
    mandatory INV-20 regression.
14. Repayment on a closed deal increases `repaidAmount` without changing
    reserve.
15. `PAID_LATE` refines to `PAID_ON_TIME` when an on-time repayment arrives, and
    deal status changes in the same transition.
16. Later late repayment never refines `PAID_ON_TIME` downward.
17. `markDefaulted` rejects `CREATED`, `PAID_ON_TIME`, and `PAID_LATE`.
18. Partial repayment after default preserves `DEFAULTED` and its old
    `closedAtBlock`.
19. Rewriting the same outcome preserves `closedAtBlock`; changing outcome sets
    the current attested source height.
20. Wrong-recipient funding and repayment each become
    `REJECTED_PERMANENT/WRONG_RECIPIENT`.
21. Overpayment beyond face value cannot release exposure twice.

---

## 10. Work order

Measure network parameters -> gateway and verifier -> deals registry and credit
layer -> worker -> demo UI -> tests and integration documentation -> deck ->
video and submission.

Submit two days before platform close. If time is short, reduce interface scope,
not tests or integration documentation.

---

## 11. Rules for implementers

### Verification and evidence

1. Call `verify` strictly before `calculateTxIndex`.
2. `verify` reverts rather than returning false; do not write a false branch.
3. Check `status` explicitly; the precompile does not.
4. Never use `from` or `gasUsed` in logic.
5. Read `chainKey` from the registry; do not hardcode source EVM chain ID.
6. Scan every log, not only the first. Return IDs deterministically: batch
   transaction order, then log order. Through the registry, apply only facts
   created by this call in two phases, funding then repayment, preserving order.
7. Never use Creditcoin `block.timestamp` or `block.number` for deadlines; use
   attested source height only.

### Accounting

8. Use saturating subtraction for limits and outstanding amounts.
9. Do not reject designated-investor funding by time, limit, overdue deadline,
   insufficient amount, or already reached threshold. Such a “fix” destroys
   recognition of money and breaks INV-11. Threshold crossing, not payment,
   happens once.
10. Do not add reserve release, cancellation, or administrative actions. Their
    absence is a decision.
11. Contract amounts are token-native units. Do not read `decimals` or convert
    inside Solidity.
12. Compute `rawScore` signed and clamp once after the complete calculation.

### Outcomes and statuses

13. Recompute payment classification after every applied repayment from
    accumulated amounts; preserve previously recorded `DEFAULTED` until full
    repayment. The current outcome carries default; do not add a hidden flag.
    Refine upward only.
14. Update deal status and credit outcome in one transition and transaction.
15. Apply repayment regardless of closed status. Closure does not erase a proved
    fact.
16. Permit `markDefaulted` only from `FINANCED`.
17. At every classification, use the general permanent-inapplicability
    criterion. If permanent inapplicability cannot be proved and an unresolved
    precondition may resolve, remain pending. The current two reasons are
    consequences, not the criterion. Record a newly uncovered case here before
    adding another reason.
18. Compare repayment recipient with `designatedInvestor`, before checking
    whether the deal is funded.
19. Do not automatically advance old pending evidence. Only targeted
    `applyEvidence` does so. Two-phase application of facts created by the
    current `submitAndApply*` is not automatic advancement.
20. `applyEvidence` reverts only for an ID absent from the verifier. `APPLIED`
    and `REJECTED_PERMANENT` are idempotent. `VERIFIED_PENDING` re-checks and
    applies, rejects, or remains pending without reverting.

### Process

21. Keys live in `.env`; `.env` is ignored from the first commit; the repository
    is public.
22. Record documentation/reality discrepancies in
    `ATTESTCOIN_INTEGRATION.md`; they belong in the pitch.
23. The specification is frozen. Change behavior only for a recorded
    contradiction or uncovered case, with the reason in the revision history.
24. “Submit within roughly twenty minutes” concerns proof freshness and cost,
    not fact lifetime. Missing it does not change source height; the generator
    re-anchors a fresh, longer proof to a checkpoint. Continued provability is
    bounded by the team's runtime-policy and archive-operator statements; do not
    elevate them to immutable protocol guarantees.
25. Continuity proof is not a stored artifact. Request it again before every
    submission and retry. Never submit saved proof bytes from queue, restart, or
    fixture. Persist source transaction and event metadata. A proof anchored to
    a pruned attestation is replaced, not repaired.
26. Bound worker automatic retries by elapsed time and attempt count, and cap
    delay. At the ceiling stop only automation: preserve task and metadata, do
    not mutate on-chain evidence or invent terminal classification, expose the
    task in the UI, and allow manual submission or explicit resume.
