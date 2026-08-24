S6 live evidence checkpoint: `f359c54c5647841a08e4e66dec267cf4cbeb110d`
(`Record S6 live acceptance evidence`). This commit is the immutable repository
index and interpretation of the S6 STATUS evidence.

Earlier source digest: `777c05fb2e2757974beb3e55041dd9da9180ee29`,
captured from `docs/ATTESTCOIN_INTEGRATION.md` at that commit. At merge, use:

```text
git log --oneline 777c05fb2e2757974beb3e55041dd9da9180ee29..HEAD -- docs/ATTESTCOIN_INTEGRATION.md docs/STATUS.md
```

This checks for newer evidence.

# Attestcoin integration digest

## Short version

Cr3dX uses two Attestcoin precompiles on Creditcoin3 Testnet. `ChainInfo`
(`0x0000000000000000000000000000000000000FD3`) resolves Sepolia's runtime
`chainKey`, measured as `1`. `BlockProver`
(`0x0000000000000000000000000000000000000FD2`) verifies transaction inclusion.
Cr3dX then verifies source receipt success and accepts only a genuine event from
the configured Gateway. The ERC-20 transfer is not established directly by the
Attestcoin proof. It follows from the verified Gateway code, which emits the
event only after a successful `transferFrom`. The credit outcome then follows
from those facts and the attested source height.

The probe's `47,276` gas result was `eth_estimateGas`, including calldata, for a
third-party two-log Sepolia transaction with the Gateway's shape. Its encoded
blob was 1,792 B, it existed before the Cr3dX Gateway, and no Creditcoin
transaction was sent. The maximum accepted batch of 10 heights estimated
`401,427` gas, or `40,143` per source transaction. Eleven heights were rejected
during estimation with `heights: Value is too large for length`, matching
`MaxBatchSize = 10`; there was no mined revert.

The historical v0.4.4 acceptance on 2026-08-19 and the S6 v0.4.8 acceptance are
separate evidence sets. They used different deployments, proof shapes and
contract state transitions. They are not a before/after comparison and do not
show that v0.4.8 became cheaper or more expensive.

A built continuity proof is perishable, while the source fact may remain
provable through a new proof and a surviving checkpoint. In a controlled
same-transaction observation, 60 additional roots added 1,920 calldata bytes
and exactly `33,744` gas in all three pairs. This is proof-shape evidence, not a
claim that elapsed time itself costs gas.

In Discord `#buidl-ctc-qna` on 2026-08-20, `dL^ | Creditcoin`, Creditcoin Team,
said that checkpoints stay forever and that cryptographic evidence stays in
the archive node. In our reading, the first statement describes current runtime
checkpoint-storage policy; the second depends on archive-node operator and
infrastructure policy. Neither is presented as an immutable protocol guarantee.
Our own retention measurement covered only about one hour.

*Short fact map: precompiles, registry, probe estimates, lag, retention and team
source come from `docs/ATTESTCOIN_INTEGRATION.md` and its raw files under
`data/probe/`. Historical v0.4.4 credit evidence comes from
`data/live/deal-2026-08-19T16-57-41-969Z.json`. S6 comes from the STATUS section
dated 2026-08-21, "S6 live acceptance завершена на v0.4.8", pinned by commit
`f359c54c5647841a08e4e66dec267cf4cbeb110d`, and destination transactions
`0xa626556e0798a67d77b484896d10e662763d041c2e9ead2d0c4ad112f2955657`,
`0xc740cf0ee69401817c32a310f6e2781ab63d125f7fc2bd299338cfe5fdc822ad`,
`0xa0c24a107398af5c99cc8cfaab0ea50f4542caff45c34bc8f539afbfa55b13b6`
and `0x8d859033ecaec13d7ebb188f8673673af0d13b989202997d613bee38f78840c2`.
The on-chain transactions are external primary evidence. The STATUS commit is
their immutable repository index and the project's interpretation.*

## Extended version

### Integration identity and trust boundary

Creditcoin3 Testnet has EVM chain id 102031. Sepolia has EVM chain id 11155111,
but its measured Attestcoin `chainKey` is `1`. The values differ by construction:
the registry assigns keys in registration order. Cr3dX reads the key from
runtime state and does not hard-code the EVM chain id as a `chainKey`.

`BlockProver` establishes source transaction inclusion. Cr3dX verifies the
source receipt status and recognizes only correctly shaped events from the exact
configured Gateway. The directly established boundary is therefore:

1. source transaction inclusion;
2. successful source transaction status;
3. a genuine configured Gateway event.

The ERC-20 transfer itself is not a direct Attestcoin-proof claim. It follows
from the verified Gateway implementation, which emits a funding or repayment
event only after the token's `transferFrom` succeeds. Credit state and outcome
then follow from these established facts and the attested source height. Invoice
authenticity, legal enforceability, identity, Sybil resistance, collateral and
repayment enforcement remain outside the claim.

### Attestation lag and grace

Two distinct observations form the current lag corpus:

| Observation | Source-block lag | Wall-clock observation |
|---|---:|---:|
| Probe window, 2026-08-19 | 32 to 41 | 6m24s to 8m24s |
| First acceptance run, 2026-08-19 | 39 to 42 | maximum 516 s |

The combined observed range is 32 to 42 source blocks. These are observations,
not constants or an SLA. The grace calculation used `41` as its lag term.
Including the later observed `42` does not change the rounded
`attestationGracePeriod = 600`, which is primarily sized against the 500-block
`MaxCatchup` failure mode.

### Probe estimates, not spent gas

The single-call and batch probe values below came from `eth_estimateGas`. They
include intrinsic calldata cost, but no Creditcoin transaction was sent for
these calls.

| Probe operation | Result | Exact scope |
|---|---:|---|
| Gate-shaped `verify` | `47,276` estimated gas | third-party two-log Sepolia transaction; 1,792 B encoded blob; existed before the Cr3dX Gateway; not a real Gateway transaction |
| Batch `verify`, 10 heights | `401,427` estimated gas total; `40,143` per source transaction | maximum accepted batch, consistent with `MaxBatchSize = 10` |
| Batch `verify`, 11 heights | rejected during estimation | `heights: Value is too large for length`; no mined revert |

`ATTESTCOIN_INTEGRATION.md`'s `~52,102` extrapolation is excluded from the
measured table. The value refers to the real Gateway transaction class, whose
live encoded blob was 2,080 B; it is an extrapolation, not a measurement and not
mined `gasUsed`.

### Historical v0.4.4 acceptance

The historical live credit run was recorded on 2026-08-19 against the now
superseded v0.4.4 `Cr3dXDeals` registry
`0x3360E0d2ff86BDd1B3b906c1AaB62E5bD5fc967c`. Its raw evidence is
`data/live/deal-2026-08-19T16-57-41-969Z.json`.

| v0.4.4 operation | Mined gasUsed | Roots | State transition |
|---|---:|---:|---|
| Funding `submitAndApply` | `334,222` | 10 | `CREATED` to `FINANCED` |
| Permanent-refusal `submitAndApply` | `253,960` | 7 | refused: `REJECTED_PERMANENT`, reason `WRONG_INVESTOR` |
| Repayment `submitAndApply` | `340,088` | 9 | repayment applied; deal closed `PAID_ON_TIME` |

### S6 v0.4.8 acceptance

S6 used the different v0.4.8 deployment: Verifier
`0xED64f6157408f211dda43649129EaC1F73161093`, Deals
`0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC`, and Credit
`0x4a66732cA5B7f081585693332C79e636CE9c05C8`.

| S6 operation | Destination transaction | Mined gasUsed | Proof and transition |
|---|---|---:|---|
| Repayment `submitAndApply` | `0xa626556e0798a67d77b484896d10e662763d041c2e9ead2d0c4ad112f2955657` | `260,288` | 8 roots; attestation 11534650, digest `0xb13a633af4c01dd3d691dcb87e48755583e95f283e0e33988c01afd2c8b82529`; submitted intentionally before funding, recorded as `VERIFIED_PENDING` because the deal was `CREATED` |
| Funding `submitAndApply` | `0xc740cf0ee69401817c32a310f6e2781ab63d125f7fc2bd299338cfe5fdc822ad` | `340,382` | 5 roots; attestation 11534800, digest `0x1b47b11718ad1ae4ad133a45d7555a79cedb5b8a4e82d0017dcd2e6d2ac0d263`; evidence applied; deal `CREATED` to `FINANCED` |
| Repayment `applyEvidence` | `0xa0c24a107398af5c99cc8cfaab0ea50f4542caff45c34bc8f539afbfa55b13b6` | `292,348` | no proof, roots and anchor N/A; pending repayment applied after funding; deal closed `PAID_ON_TIME` |
| External-race `submitAndApply` | `0x8d859033ecaec13d7ebb188f8673673af0d13b989202997d613bee38f78840c2` | `266,056` | second wallet; 10 roots; attestation 11534900, digest `0x640da336bc360324380245375a1bfea8346d894d71b2d3f50db2acd94f1d29b4`; surplus 1 base unit applied to the closed deal; fundedAmount `1,000,000` to `1,000,001`; outcome unchanged |

The second wallet won the external-submission race that the acceptance plan
requires. The worker reconciled the complete `seen` set without signing or
broadcasting for that task.

Rows from different deployments or different state transitions are evidence
records only. They are not a controlled comparison between proof size and gas.
S6 is also not directly comparable with v0.4.4, so these records cannot support
a claim that v0.4.8 is cheaper or more expensive.

### S6 proof requests before signing decisions

The saved repayment source transaction had the same `282,203` gas estimate in
the earlier and post-fix preflights. The earlier observation did not save its
proof shape, so it is not reconstructed:

| Repayment observation | Earlier preflight | Post-fix client request |
|---|---:|---:|
| Source/query height | 11534643 | 11534643 |
| Anchor type and height | not recorded | attestation 11534650 |
| Anchor digest | not recorded | `0xb13a633af4c01dd3d691dcb87e48755583e95f283e0e33988c01afd2c8b82529` |
| Continuity roots | not recorded | 8 |
| Encoded transaction | not recorded | 2,080 B |
| Proof JSON | not recorded | 5,791 B |
| `submitAndApply` calldata | not recorded | 3,140 B |
| Simulation | SUCCESS | SUCCESS |
| Gas estimate | `282,203` | `282,203` |

The funding client request recorded 5 roots, attestation 11534800, a 2,080 B
encoded transaction, 5,679 B proof JSON, 3,108 B calldata, successful
simulation and a `364,799` estimate. The external-race request recorded 10
roots, attestation 11534900, a 2,080 B encoded transaction, 5,928 B proof JSON,
3,204 B calldata, successful simulation and a `288,151` estimate. These
observations were recorded before any signing decision; in the race case the
worker never signed.

Only the saved repayment proof builder response is established to have contained
`cached: true`. The semantics of that server response field are not documented
here. The worker made a new HTTP request before signing and did not reuse locally
saved proof bytes. The evidence does not establish whether the server recomputed
the proof or returned a server-side cache. A fresh client request therefore does
not guarantee selection of the freshest available anchor. This is an open
question about proof builder service behavior, not a worker-policy guarantee and
not a defect in the worker's no-local-proof-reuse policy.

No gas change is attributed to elapsed time. The repayment estimate did not
change, and the old proof shape is unknown. The other S6 operations changed
different contract states and do not isolate proof shape.

### Controlled proof re-anchoring observation

A continuity proof is tied to the anchor available when it is built. Once an
ordinary attestation is pruned, replaying that proof can revert even though a
new proof for the same source transaction can anchor to a surviving checkpoint.
The measured formula was:

`roots = nearest surviving anchor - query height + 1`.

The same three transactions were observed promptly and about an hour later:

| Fixture | Roots, immediate | Roots, checkpoint-anchored | Gas, immediate | Gas, later | Exact delta |
|---|---:|---:|---:|---:|---:|
| Double funding | 2 | 62 | `317,037` | `350,781` | `33,744` |
| Funding | 8 | 68 | `158,749` | `192,493` | `33,744` |
| Repayment | 5 | 65 | `177,385` | `211,129` | `33,744` |

Each pair added exactly 60 roots and 1,920 calldata bytes. The expected delta
was approximately `33,600`: 16 gas per added byte plus 48 gas per root. The
observed delta was exactly `33,744` in all three pairs. This comparison controls
the source transactions and observes the changed proof path. It does not make
elapsed time itself a gas-cost cause.

Under the observed cadence, an immediate proof can carry at most 11 roots and a
checkpoint-anchored proof at most 101, both below the 500-root ceiling. This is
a cost and freshness objective, not a fact-expiry deadline or SLA.

### Protocol-team statement and project interpretation

The source is Discord `#buidl-ctc-qna`, 2026-08-20, `dL^ | Creditcoin`,
Creditcoin Team. The answer said that checkpoints stay forever and that the
cryptographic evidence stays in the archive node.

In our reading, the first statement describes the current runtime
checkpoint-storage policy. The second depends on archive-node operator and
infrastructure policy. Neither statement is declared an immutable protocol
guarantee. Our independent retention measurement covered only about one hour.

*Extended fact map: integration surface, registry order, proof semantics, probe
estimates, lag, grace, proof re-anchoring and the protocol-team statement come
from `docs/ATTESTCOIN_INTEGRATION.md`, `data/probe/` and the referenced STATUS
sections. Historical v0.4.4 state and gas come from
`data/live/deal-2026-08-19T16-57-41-969Z.json`. S6 comes from the STATUS section
dated 2026-08-21, "S6 live acceptance завершена на v0.4.8", at immutable commit
`f359c54c5647841a08e4e66dec267cf4cbeb110d`, plus destination transactions
`0xa626556e0798a67d77b484896d10e662763d041c2e9ead2d0c4ad112f2955657`,
`0xc740cf0ee69401817c32a310f6e2781ab63d125f7fc2bd299338cfe5fdc822ad`,
`0xa0c24a107398af5c99cc8cfaab0ea50f4542caff45c34bc8f539afbfa55b13b6`
and `0x8d859033ecaec13d7ebb188f8673673af0d13b989202997d613bee38f78840c2`.
The on-chain transactions are external primary evidence. The STATUS commit is
the immutable repository index and interpretation of the result.*
