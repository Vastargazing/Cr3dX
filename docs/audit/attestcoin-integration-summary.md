777c05fb2e2757974beb3e55041dd9da9180ee29 — Digest captured from `docs/ATTESTCOIN_INTEGRATION.md` at this commit; at merge, run `git log --oneline 777c05fb2e2757974beb3e55041dd9da9180ee29..HEAD -- docs/ATTESTCOIN_INTEGRATION.md docs/STATUS.md` to check for newer evidence.

# Attestcoin integration digest

## Short version

Cr3dX uses two Attestcoin precompiles on Creditcoin3 Testnet. `ChainInfo`
(`0x0000000000000000000000000000000000000FD3`) resolves Sepolia's runtime
`chainKey`—measured as `1`, not its EVM chain id `11155111`—and `BlockProver`
(`0x0000000000000000000000000000000000000FD2`) verifies fresh continuity and
Merkle proofs. After `verify` succeeds, Cr3dX derives the transaction index,
decodes the receipt, rejects `status = 0`, and accepts only events emitted by the
deployed gateway. This proves the funding or repayment transfer and lets the
credit outcome follow from proven source facts and attested source height. It
does not prove invoice authenticity, legal enforceability, borrower identity,
Sybil resistance, collateral, or repayment enforcement.

Live measurement found `47,276` gas for a gate-shaped two-log verification. A
10-height batch—the measured and enforced maximum—used `401,427` gas (`40,143`
per transaction); 11 heights reverted. In the accepted live credit flow,
`submitAndApply` used `334,222` gas for funding with 10 continuity roots,
`253,960` for a permanent refusal with 7 roots, and `340,088` for repayment with
9 roots.

A built continuity proof is perishable, but the source fact did not expire in
our test: after ordinary attestations were pruned, requesting a new proof
re-anchored the same transaction to a checkpoint and still verified, at about
`33,700` extra gas after one hour. The roughly 20-minute target keeps proofs
short; it is not a correctness deadline. In Discord `#buidl-ctc-qna` on
2026-08-20, the Creditcoin Team said checkpoints stay forever and archive nodes
retain the cryptographic evidence. These are current runtime-storage and
operator-infrastructure policies, not immutable protocol guarantees; our own
retention measurement covered only about one hour.

*Fact map: precompiles and `chainKey` — “Endpoints and node identity” and §1; proof semantics — §§4 and 8 plus README “Trust boundary”; verify/batch gas — §§5–6; `submitAndApply` gas — STATUS “v0.4.4” → “Живая приёмка на новом поведении”; re-anchoring and cost — “Proofs expire, facts do not” and “Attestation retention, measured”; team confirmation — “Retention and cadence, answered by the protocol team” → “The provability horizon, answered by the protocol team”.*

## Extended version

Cr3dX makes Attestcoin the only bridge between settlement on Ethereum Sepolia
and canonical credit state on Creditcoin3 Testnet. It reads the source-chain
registry through the `ChainInfo` precompile at
`0x0000000000000000000000000000000000000FD3`; the live registry assigned
Sepolia `chainKey = 1`, which is deliberately different from EVM chain id
`11155111` and therefore is resolved from runtime state rather than hard-coded.
The verifier calls `verify` on the `BlockProver` precompile at
`0x0000000000000000000000000000000000000FD2`, then calls
`calculateTxIndex` only after verification has succeeded.

`BlockProver` establishes that the encoded transaction/receipt was included
under the attested source-chain roots; it does not establish that the
transaction succeeded. Cr3dX therefore decodes the receipt itself, rejects
`status = 0`, reads the complete log list, and recognizes only genuine funding
or repayment events from the exact deployed gateway. The system can
cryptographically establish that funding happened, repayment happened, or the
attested source height passed a deadline, and its credit result follows from
those facts. The boundary is intentionally narrower than “creditworthiness”:
invoice authenticity, legal enforceability, real-world identity, Sybil
resistance, collateral, and enforcement remain outside the claim.

The live probe also measured operational timing. Attestation advanced in
10-source-block steps and trailed Sepolia by 32–41 blocks (6m24s–8m24s) during
one healthy sampling window; those observations are not constants. The
`attestationGracePeriod` is therefore 600 source blocks, sized against the
500-block runtime `MaxCatchup` failure mode rather than the ordinary lag.

| Measured Creditcoin operation | Gas | Scope |
|---|---:|---|
| Gate-shaped `verify`, 2 logs | `47,276` | `eth_estimateGas`, including calldata |
| Batch `verify`, 10 heights | `401,427` total; `40,143` per transaction | maximum accepted batch; 11 reverted |
| Live verifier submission, one repayment fact | `177,385` | preferred one-fact baseline; the first-ever funding was artificially cheaper because nonce zero reduced storage cost |
| Live verifier submission, two genuine gateway facts | `317,037` | one double-funding transaction |
| `submitAndApply`, funding | `334,222` | 10 continuity roots |
| `submitAndApply`, permanent refusal | `253,960` | 7 continuity roots |
| `submitAndApply`, repayment | `340,088` | 9 continuity roots |

The batch result is an efficiency measurement, not an unlimited-throughput
claim: the precompile accepted at most 10 heights. Gas is also input-shaped.
`encodedTx` contains every source receipt log, so calldata dominates more as a
transaction becomes noisier; Cr3dX gateway calls are constrained to the
two-log ERC-20 `Transfer` plus gateway-event shape. On the current testnet,
`verify` and `verifyAndEmit` both estimated `42,966` gas on the same minimal
input, but the Creditcoin engineer said the latter's `LOG3` should probably be
charged. That pricing question remains open upstream; Cr3dX uses `verify`, so
its contract path does not depend on the zero-difference behavior.

The strongest reliability result is that proof freshness and fact durability
are different. A continuity proof is bound to the best anchor available when
the proof builder creates it. Once an ordinary attestation is pruned, that
specific proof reverts with “Continuity proof does not match attestation or
checkpoint”; replaying it is wrong. A fresh request for the same transaction
keeps `encodedTx`, the Merkle proof, and the lower endpoint unchanged but builds
a different continuity path to a surviving checkpoint, and the on-chain
verification succeeds.

The measured formula was
`roots = nearestSurvivingAnchor - queryHeight + 1`. Fresh funding, repayment,
and double-funding proofs carried 8, 5, and 2 roots against attested height
11521640. About an hour later they carried 68, 65, and 62 roots against
checkpoint 11521700. Sixty extra roots added about 1,920 calldata bytes and
about `33,700` observed gas. Under the then-current cadence, prompt proofs carry
at most 11 roots and checkpoint-anchored proofs at most 101, both below the
500-root ceiling. The worker's roughly 20-minute objective is thus a cost and
freshness target, not a fact-expiry deadline; every submission and retry must
request a new proof.

Finally, the long horizon is externally sourced rather than extrapolated from
that one-hour experiment. In Discord `#buidl-ctc-qna` on 2026-08-20 at 8:01 AM,
`dL^ | Creditcoin` answered that checkpoints stay forever and that archive nodes
retain the cryptographic evidence. The first statement describes current
runtime checkpoint-storage policy; the second depends on archive-node operator
policy. Neither is an immutable protocol guarantee, and the two should not be
collapsed into an unconditional promise that every historical transaction is
provable forever.

*Fact map: integration surface — “Endpoints and node identity”, §§1 and 4; receipt validation and claim boundary — §8, “The decoder, and a correction to the reconnaissance report”, and README “Trust boundary”; cadence/grace — §§2–3 and 9; verify, batch, and verifier-submission gas — §§5–6 and “The live path, measured” → “Gas, measured rather than estimated”; `submitAndApply` gas — STATUS “v0.4.4” → “Живая приёмка на новом поведении”; proof formula and re-anchoring — “Proofs expire, facts do not”, “The live path, measured” → “Continuity proof size has an exact formula”, and “Attestation retention, measured”; team authority and limits — “Retention and cadence, answered by the protocol team” → “The provability horizon, answered by the protocol team”.*
