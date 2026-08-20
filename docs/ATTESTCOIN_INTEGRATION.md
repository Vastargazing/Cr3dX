# Attestcoin Protocol integration notes

Cr3dX reads every cross-chain fact through the Attestcoin Protocol precompiles on
Creditcoin3 Testnet (chain id 102031), with Ethereum Sepolia as the source chain.
This document records what the live network actually does, as opposed to what the
source and the published documentation say it does. Numbers here come from two
places. The default is measurement: `npm run probe` (`scripts/probe.ts`) against the
live testnet, with raw results committed under `data/probe/`. Where the protocol team
has answered a question directly, their answer is the source and is cited with its
date; measurement is then kept alongside it as corroboration, not as the authority.

The block between the probe markers is regenerated on every run. Prose outside the
markers is written by hand and is preserved.

## Why this document exists

Three protocol properties cannot be read off the source code, and all three change
how the contracts have to be written:

1. **The source chain identifier is runtime state.** `chainKey` is an
   auto-incrementing Creditcoin-internal id, not the EVM chain id of the source
   chain. It has to be resolved from the on-chain registry.
2. **Attestation deliberately trails the source chain head.** The size of that lag
   determines `attestationGracePeriod`, the only thing standing between a healthy
   deal and a spurious default.
3. **The real cost of a verification call is dominated by calldata**, not by the
   precompile's own metering, because the encoded transaction blob carries every
   log of the proven transaction.

<!-- probe:begin -->

| Run metadata | |
|---|---|
| Probe started | 2026-08-19T08:07:55.856Z |
| Creditcoin RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Sepolia RPC | `https://ethereum-sepolia-rpc.publicnode.com` |
| Proof builder | `https://prover.cc3-testnet.creditcoin.network` |
| Probe finished | 2026-08-19T08:22:42.508Z |
| Raw results | `data/probe/2026-08-19T08-07-55-856Z.json` |

### Endpoints and node identity

| Property | Value |
|---|---|
| Creditcoin EVM chain id | 102,031 |
| Creditcoin head at probe start | 5,335,245 |
| Creditcoin block gas limit | 75,000,000 |
| Sepolia EVM chain id | 11,155,111 |
| Sepolia head at probe start | 11,519,912 |
| BlockProver precompile | `0x0000000000000000000000000000000000000FD2` |
| ChainInfo precompile | `0x0000000000000000000000000000000000000FD3` |

### 1. Source chain registry and `chainKey`

The registry is runtime state, so this is a live reading rather than a constant.

| `chainKey` | EVM `chainId` | Name | Encoding |
|---|---|---|---|
| `1` | 11,155,111 | `Sepolia ethereum` | v1 |
| `3` | 1 | `Ethereum` | v1 |

**Sepolia is `chainKey = 1`** on Creditcoin3 Testnet, encoding version 1.
Attestation genesis height for this chain: `0`.

Consequence for the contracts: `chainKey` is a deployment parameter resolved from this registry,
never a hard-coded EVM chain id. The two differ by construction, and the registry assigns keys
in registration order.

### 2. Attestation cadence and continuity limits

| Parameter | Value | Source |
|---|---|---|
| Attestation interval | 10 source blocks | `AttestorApi_chain_attestation_interval` |
| Checkpoint interval | 10 attestations | `AttestorApi_attestation_checkpoint_interval` |
| `MaxCatchup` | 500 blocks (runtime default, no per-chain override stored) | `Attestation::MaxCatchup` storage |
| Maximum continuity roots per proof | 500 | `max(MaxCatchup, interval)` |
| Maximum batch size | 10 heights | `MaxBatchSize` in the precompile |

A single attestation therefore covers 10 source blocks, roughly
2m 0s of Sepolia, and one continuity proof may span at most
500 blocks.

**`MaxCatchup` is the number that sizes `attestationGracePeriod`.** It bounds how many source blocks
a single attestation may recover after the attestor set has fallen behind, which is the same as saying
the attested height, the only clock the deals contract is allowed to read, can advance by 500 blocks
in one Creditcoin block. Any deadline logic has to survive that jump; see section 9.

**Documentation deviation.** `pallets/attestation/src/lib.rs:855` documents the continuity limit as
`max_catchup * attestation_interval`. The executed code in `continuity.rs:95-101` and
`extensions.rs:120-127` computes `max(max_catchup, attestation_interval)`. On the measured
configuration the comment implies 5,000 roots where the real limit is
500. Anything sized against the comment would be rejected as an oversized proof.

### 3. Attestation lag behind the Sepolia head

Attestation trails the Sepolia head on purpose, so that the attestation chain is never built on top of
blocks that could still be reorganised. The lag is the single most important number for Cr3dX, because
the deals contract uses attested source height as its only clock.

| Time (UTC) | Attested height | Prover cache | Sepolia head | Lag, blocks | Lag, wall clock |
|---|---|---|---|---|---|
| 08:08:03 | 11,519,880 | 11,519,870 | 11,519,913 | 33 | 6m 48s |
| 08:08:53 | 11,519,880 | 11,519,880 | 11,519,916 | 36 | 7m 24s |
| 08:09:39 | 11,519,880 | 11,519,880 | 11,519,921 | 41 | 8m 24s |
| 08:10:25 | 11,519,890 | 11,519,890 | 11,519,924 | 34 | 7m 0s |
| 08:11:11 | 11,519,890 | 11,519,890 | 11,519,928 | 38 | 7m 48s |
| 08:11:57 | 11,519,900 | 11,519,890 | 11,519,932 | 32 | 6m 24s |
| 08:12:43 | 11,519,900 | 11,519,900 | 11,519,936 | 36 | 7m 12s |
| 08:13:29 | 11,519,900 | 11,519,900 | 11,519,940 | 40 | 8m 0s |
| 08:14:15 | 11,519,910 | 11,519,900 | 11,519,944 | 34 | 6m 48s |
| 08:15:01 | 11,519,910 | 11,519,910 | 11,519,947 | 37 | 7m 24s |
| 08:15:47 | 11,519,910 | 11,519,910 | 11,519,951 | 41 | 8m 12s |
| 08:16:33 | 11,519,920 | 11,519,920 | 11,519,955 | 35 | 7m 0s |
| 08:17:19 | 11,519,920 | 11,519,920 | 11,519,959 | 39 | 7m 48s |
| 08:18:05 | 11,519,930 | 11,519,920 | 11,519,963 | 33 | 6m 36s |
| 08:18:52 | 11,519,930 | 11,519,930 | 11,519,967 | 37 | 7m 24s |
| 08:19:38 | 11,519,930 | 11,519,930 | 11,519,971 | 41 | 8m 12s |
| 08:20:24 | 11,519,940 | 11,519,940 | 11,519,974 | 34 | 6m 48s |
| 08:21:10 | 11,519,940 | 11,519,940 | 11,519,978 | 38 | 7m 36s |
| 08:21:56 | 11,519,950 | 11,519,940 | 11,519,982 | 32 | 6m 24s |
| 08:22:42 | 11,519,950 | 11,519,950 | 11,519,986 | 36 | 7m 12s |

| Statistic | Value |
|---|---|
| Minimum lag | 32 blocks |
| Mean lag | 36 blocks |
| Maximum lag | 41 blocks |
| Minimum lag, wall clock | 6m 24s |
| Maximum lag, wall clock | 8m 24s |
| Attested height steps between samples | 10, 10, 10, 10, 10, 10, 10 |
| Attestation cadence implied by those steps | 10 source blocks (greatest common divisor of the steps) |
| Attestation advance rate | 0.08 source blocks/s (Sepolia produces 0.08/s) |

The attested height advanced in step with Sepolia over this run.

**The prover cache column is a separate lag.** The proof builder service serves proofs from its own
ingested view, which trails the on-chain attestation. A height that `ChainInfo` reports as attested is not
necessarily servable yet, so the worker has to poll the proof builder, not just the precompile.

### 4. `verify` on a live Sepolia transaction

`verify` returns **true** for a live Sepolia transaction proven through the precompile at `0x0000000000000000000000000000000000000FD2`.

| Sample | Sepolia tx | Height | Logs | `verify` | `calculateTxIndex` |
|---|---|---|---|---|---|
| minimal | `0xa68b5bc72f...` | 11,519,806 | 0 | `true` | `2` (matches the proof) |
| gate-shaped | `0x57c006bfc3...` | 11,519,806 | 2 | `true` | `65` (matches the proof) |
| heaviest in block | `0xdd0ad0f29a...` | 11,519,806 | 30 | `true` | `0` (matches the proof) |

The precompile either returns `true` or reverts; it never returns `false`. There is no
"else" branch to write on our side. `calculateTxIndex` is a pure function of the Merkle proof
siblings, so its result is only meaningful once `verify` has succeeded on the same proof.

### 5. Gas cost of a single verification

Full cost of the call as `eth_estimateGas` reports it, which includes intrinsic calldata cost.
The encoded transaction blob carries every log of the proven transaction, so cost scales with
how noisy the source transaction is, not with anything Cr3dX controls.

| Sample | Logs | `encodedTx` bytes | Calldata bytes | Calldata gas | Total gas | Calldata share |
|---|---|---|---|---|---|---|
| minimal | 0 | 1,248 | 2,244 | 16,296 | 42,966 | 38% |
| gate-shaped | 2 | 1,792 | 2,788 | 20,332 | 47,276 | 43% |
| heaviest in block | 30 | 11,200 | 12,196 | 95,200 | 180,004 | 53% |

Creditcoin block gas limit at probe time: `75,000,000`.

**What this means for Cr3dX.** A `fund` or `repay` call on the Sepolia gate emits exactly two logs,
the ERC-20 `Transfer` and the gate event, so its encoded blob sits at the low end of this table.
Across these samples each additional log adds about 332 bytes to the encoded
blob and about 4,568 gas to the call. Extrapolating to a two-log gate transaction gives
roughly **1,911 bytes and 52,102 gas** for one verification, well inside a
single Creditcoin block.

The heavy row is in the table to show the shape of the curve, not because Cr3dX ever proves
transactions like it. Cost is driven by the log payload of the proven transaction, which is fixed by
the gate contract and is not something a caller can inflate.

### 6. Gas cost of batched verification

One batch call takes several heights and a single continuity proof that has to span the whole
range from the lowest to the highest height in the batch.

| Batch size | Height span | Continuity roots | Calldata bytes | Total gas | Gas per tx | Result |
|---|---|---|---|---|---|---|
| 1 | 1 | 5 | 2,980 | 51,043 | 51,043 | `true` |
| 2 | 2 | 6 | 5,540 | 87,291 | 43,646 | `true` |
| 5 | 5 | 9 | 13,284 | 194,105 | 38,821 | `true` |
| 10 | 10 | 14 | 26,276 | 401,427 | 40,143 | `true` |
| 11 | 11 | 15 | 29,092 | n/a | n/a | rejected: execution reverted: "heights: Value is too large for length" |

**Largest batch that verifies: 10 heights.**

A batch of 11 is rejected, which confirms the `MaxBatchSize = 10` bound from the source.

### 7. `verify` against `verifyAndEmit` (finding F-1)

| Call | Estimated gas |
|---|---|
| `verify` | 42,966 |
| `verifyAndEmit` | 42,966 |
| Difference | 0 |

Both calls were made on identical inputs (sample `minimal`, 1,248 byte blob).

**The difference is exactly zero, which confirms finding F-1.** `verifyAndEmit` additionally runs
`calculate_tx_index_impl` and emits a `LOG3`, but charges for neither: `LogExt::record` stores the log
without touching the gasometer, and the precompile never calls `compute_cost()` or
`record_log_costs_manual`, which its sibling precompiles do. Under the standard formula the
uncharged amount is `375 + 3*375 + 32*8 = 1,756` gas per event, up to 17,560 for a full batch of ten.

This is reported upstream rather than exploited. Cr3dX budgets gas as if the event were charged, so
that closing the gap upstream cannot break our limits.

### 8. Decoding the proven transaction inside a contract

The verifier contract has to read two things out of the proven transaction: the receipt status, which
the precompile deliberately does not check, and the full log list. Both live inside `encodedTx`, whose
encoding is custom rather than RLP.

The layout is `abi.encode(uint8 txType, bytes[] chunks)`. Chunk composition depends on the transaction
type, but **the receipt chunk is always the last one**, and its own layout is identical for every type:

```solidity
struct ProvenLog { address emitter; bytes32[] topics; bytes data; }

(, bytes[] memory chunks) = abi.decode(encodedTx, (uint8, bytes[]));
(uint8 status, , ProvenLog[] memory logs, ) =
    abi.decode(chunks[chunks.length - 1], (uint8, uint64, ProvenLog[], bytes));
```

No branching on transaction type is required. That matters, because the reconnaissance report expected
the encoding to force a five-way decoder on any consumer: it does, but only for reconstructing the
canonical transaction hash, which Cr3dX does not need. Reading `status` and the logs costs one `abi.decode`.

The two fields that are not covered by the canonical Ethereum roots, `from` and `gasUsed`, live in chunks
this path never touches, so the rule that they must not influence Cr3dX state is enforced by the decoder
shape rather than by discipline.

Verified against the live blob for `0x57c006bfc30a58d1dce8399f6628cb85f8300f96ef3c1ebff4a11dbd7231ed94`. The receipt-chunk-is-last property was read off
the encoder for all five transaction types; the live check below covers the type that Cr3dX gate calls
actually produce.


| Field | Value |
|---|---|
| Transaction type | 2 (EIP-1559) |
| Chunks | 3, sizes 288 / 256 / 960 bytes |
| Receipt `status` | `1` |
| Logs recovered | 2 |
| First log emitter | `0xb00C497fC72D8eD10d4679b158d8bc9219E8e7Aa` |
| First log topics | 2 |

**`status` is our responsibility.** The precompile proves that the encoded pair was included, not that
the transaction succeeded. A reverted transaction carries a perfectly valid proof with `status = 0`, and
nothing in the protocol stops it from being submitted as evidence. Cr3dX rejects it explicitly.

### 9. Derived parameter: `attestationGracePeriod`

`attestationGracePeriod` is the margin the deals contract adds to `dueBlock` before a deal may be marked
defaulted. It exists because attested source height, not wall clock time, is the only clock the contract
is allowed to read, and that clock neither runs smoothly nor stays a fixed distance behind reality.

```
markDefaulted requires:  attestedSourceHeight > deal.dueBlock + attestationGracePeriod
```

**What the measurement shows.** The lag is a sawtooth rather than a constant: attested height advances in
whole steps of 10 blocks while Sepolia produces blocks continuously, so the distance to the head
swings between 32 and 41 blocks with the step size as its amplitude.
Every step in this run was exactly 10 blocks. Attestation kept pace with Sepolia throughout;
no backlog and no catch-up burst occurred in the sampling window.

**What the measurement cannot show, and why the constant is larger than the measurement.** A sampling
window that happens to be healthy says nothing about the failure mode this parameter exists for. Attestation
is produced by an attestor set that can fall behind, and when it recovers it recovers in bulk: `MaxCatchup`
is 500 blocks, which is exactly how far the contract's clock may leap in a single Creditcoin block.
A grace period sized against the steady-state lag would be crossed by one such leap, and every deal whose
due block fell inside it would be marked defaulted at once, for reasons that have nothing to do with any
borrower.

The constant therefore has to cover four things, all in source blocks:

| Component | Value | Why |
|---|---|---|
| `MaxCatchup` | 500 | the largest single jump the attested height can make |
| Maximum observed lag | 41 | steady-state distance from the Sepolia head |
| Attestation interval | 10 | the clock only moves in whole steps |
| Submission allowance | 25 | worker time to see the attestation, fetch a proof from the builder, and land a Creditcoin transaction |
| Sum | 576 |  |
| **Recommended constant** | **600** | rounded up to whole hours, about 2h of Sepolia |

`attestationGracePeriod = 600` is a constructor argument of the deals contract, not a hard-coded
constant, so a demo deployment can use a smaller value to show the default path without waiting.

**What this constant is not.** It does not carry correctness. Correctness comes from the settlement rule:
an outcome is decided by the source block height of the payment, never by when its proof arrived. A deal
that was marked defaulted is still resolved to `PAID_ON_TIME` by a later proof of a payment made before
`dueBlock`. That separation is deliberate, and it is what makes the parameter safe to get wrong: if
correctness rested on the grace period, a single `MaxCatchup`-sized jump in the attested height would
break it.

What the constant does carry is the honesty of the record. Oversizing it delays a default marking on a
deal that is already unrecoverable. Undersizing it stamps defaults on healthy borrowers for reasons that
have nothing to do with them, and a credit history full of defaults that were later reversed is worth
less than one that never fabricated them.

<!-- probe:end -->

---

## The decoder, and a correction to the reconnaissance report

Written by hand, outside the probe block. Section 8 above is the live measurement;
this is what was built on top of it and what it cost.

### Wire format, settled

The reconnaissance report (`docs/PRECOMPILE_FINDINGS.md`, R4) describes `encodedTx`
as a single ABI-encoded tuple with a flat field list that branches five ways by
transaction type, and concludes that a Solidity consumer faces "a five-way decoder".
That is an accurate account of the *logical* fields and it is what the SDK exposes
as its `types` array, but it is not the shape on the wire. The actual encoding is

```
abi.encode(uint8 txType, bytes[] chunks)
```

and the receipt chunk is always the last element, with the same layout for every
transaction type:

```
abi.encode(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)
```

Confirmed two ways. In the encoder source, `usc-abi-encoding` 0.5.0,
`src/abi/v1.rs`: types 0, 1 and 2 build three chunks with `encode_receipt_fields`
last (lines 79-81, 101-103, 124-126), types 3 and 4 build four with the same field
last (lines 181-183, 208-210), and `abi_encode` wraps them as
`Tuple(type_id, Array(chunks))` at line 289. On the live network, against captured
Sepolia blobs of types 0, 1, 2 and 3.

The practical difference is large. A consumer that needs the receipt status and the
logs, which is exactly what Cr3dX needs and nothing more, writes one `abi.decode`
and never looks at the transaction type. The five-way branch is only required for
reconstructing the canonical transaction hash, which Cr3dX does not do.

### What this buys, beyond convenience

`from` and `gasUsed` are the two fields the protocol carries but the canonical
Ethereum roots do not cover, and the specification forbids letting either influence
any Cr3dX decision. Both live in chunks this decoder never opens; `gasUsed` is
touched only because ABI decoding is positional, and is discarded on the same line.
The rule is enforced by the shape of the function rather than by anyone remembering
it during review.

### Test fixtures

`scripts/capture-fixtures.ts` scans attested Sepolia blocks for the shapes that
break decoders rather than the shapes that flatter them, and freezes them under
`test/fixtures/`. Expected values are read from `eth_getTransactionReceipt`, then
cross-checked field by field against the attested blob before a fixture is written.
A decoder that is consistently wrong therefore cannot pass: it would have to be
wrong in exactly the same way as Ethereum's own receipt.

| Fixture | Type | Status | Logs | Blob | Why it is in the set |
|---|---|---|---|---|---|
| `eip1559-two-logs` | 2 | 1 | 2 | 2,048 B | the exact shape of a Cr3dX gate call |
| `eip1559-no-logs` | 2 | 1 | 0 | 1,248 B | empty log array must decode, not revert |
| `reverted` | 0 | **0** | 0 | 1,376 B | a valid proof of a failed transaction |
| `legacy` | 0 | 1 | 17 | 6,848 B | different chunk layout |
| `access-list` | 1 | 1 | 1 | 1,632 B | different chunk layout |
| `blob-carrying` | 3 | 1 | 3 | 3,936 B | four chunks, the strongest test of the claim |
| `many-logs` | 2 | 1 | 43 | 17,376 B | long array, where offset mistakes surface |

Type 4 (EIP-7702 authorization) did not appear in the scanned range. Its receipt
chunk is last in the encoder source like every other type, but that is a reading of
the code, not a live observation.

### Decoding cost

Measured by `forge test --match-test test_decodingCost`:

| Fixture | Blob | Logs | Gas |
|---|---|---|---|
| `eip1559-no-logs` | 1,248 B | 0 | 3,817 |
| `reverted` | 1,376 B | 0 | 3,829 |
| `access-list` | 1,632 B | 1 | 5,380 |
| `eip1559-two-logs` | 2,048 B | 2 | **6,943** |
| `blob-carrying` | 3,936 B | 3 | 9,238 |
| `legacy` | 6,848 B | 17 | 29,993 |
| `many-logs` | 17,376 B | 43 | 71,200 |

The row that matters is the gate-shaped one: 6,943 gas against roughly 47,000 for
the verification it sits inside, most of which is calldata. Decoding is not where
this system spends money, so the decoder is written for the compiler's bounds-checked
decoder rather than for hand-rolled assembly that would save a few thousand gas and
introduce a class of bug the specification has no defence against.

### EVM target

Creditcoin3 runs `fp_evm::Config::cancun()` (`runtime/src/lib.rs:461`), so Cancun
opcodes are available on the deployment target. Contracts compile with
`evm_version = "cancun"` for both networks.

---

## Proofs expire, facts do not

Found while building the verifier, and it changes what the worker has to do.

Every fixture captured on the previous stage stopped verifying about two hours
after capture. The precompile rejects them with:

```
execution reverted: "Continuity proof does not match attestation or checkpoint"
```

Nothing was wrong with the fixtures. Requesting a **fresh** proof for the same
transaction returns:

| | Captured proof | Fresh proof, same transaction |
|---|---|---|
| `encodedTx` | identical | identical |
| Merkle proof | identical | identical |
| `lowerEndpointDigest` | identical | identical |
| Continuity roots | 5 | **35** |
| `verify` on chain | reverts | `true` |

### Why

A continuity proof chains from its lower endpoint through one root per source
block until it reaches something the chain still holds: an attestation or a
checkpoint. Attestations are retained for a bounded window and then pruned;
checkpoints survive longer, and there is one per ten attestations, which at an
attestation interval of ten source blocks means one per hundred blocks. How long
checkpoints themselves are kept is not established — see *Retention and cadence,
answered by the protocol team* below.

So a fresh proof anchors to a nearby attestation and is short. Once that
attestation is pruned, the same fact is provable only by chaining out to the next
surviving checkpoint, which is further away. The proof gets longer. The fact does
not change.

### What follows for Cr3dX

**A proof is perishable; treat it as a message in flight, not as stored state.**
The worker must not queue a built proof and retry it hours later after a failure.
On retry it rebuilds. A retry loop that replays a stale proof will fail forever
against a chain that would happily accept the fact, which is the worst kind of
outage: permanent, self-inflicted, and looking exactly like a protocol problem.

**Fixtures store the transaction hash, not the proof.** `test/fixtures/gate/*.json`
carries the proof for reference, but `scripts/verify-live.ts` ignores it and
fetches a fresh one. A test that replayed a stored proof would go red on its own
after a couple of hours and tell nobody anything true.

**Cost drifts upward with age, then settles.** Thirty extra roots is about 960
extra bytes of calldata, roughly 15,000 gas, plus the precompile's 48 gas per
root. Modest, and it stops growing once the proof is anchored to the checkpoint
grid rather than to a pruned attestation. Proving promptly is still cheaper than
proving late.

**Waiting costs gas; how far that holds is not known.** Across everything observed
so far the retention window is a cost question, not a correctness one, and the deals
contract settles a fact against its source block height no matter when the proof
arrives. The longest gap actually exercised is about an hour. Whether a fact proven a
week late is still provable at all depends on how long checkpoints are kept, which the
protocol team has not stated; see *The provability horizon is still open* below.

---

## The live path, measured

Recorded on the first end-to-end acceptance run, 2026-08-19. Sepolia gateway
`0x11DD8a4c790939DEa8CED631dB27Afe54334a749`, Creditcoin verifier at the same
address on chain 102031. Three real Sepolia transactions, proven and recorded.

### Continuity proof size has an exact formula, and it is not about age

The earlier section established that proofs expire and grow. The live run pins
down the mechanism precisely. Proofs fetched within minutes of the transactions:

| Transaction | Height | Continuity roots |
|---|---:|---:|
| `fund` | 11521633 | 8 |
| `repay` | 11521636 | 5 |
| `double-funding` | 11521639 | 2 |

The attested height at that moment was 11521640. In every case:

```
roots = nearestSurvivingAnchor - queryHeight + 1
```

11521640 - 11521633 + 1 = 8. 11521640 - 11521636 + 1 = 5. 11521640 - 11521639 + 1 = 2.

The same formula explains the aged fixtures from the earlier stage, and shows
what the anchor becomes once the fine-grained attestations are gone:

| Fixture | Height | Roots when fresh | Roots a day later | Implied anchor |
|---|---:|---:|---:|---:|
| `reverted` | 11520066 | 5 | 35 | 11520100 |
| `many-logs` | 11520060 | n/a | 41 | 11520100 |

Both aged proofs anchor to **11520100**, a multiple of 100. That is the
checkpoint grid: ten blocks per attestation, ten attestations per checkpoint. So
proof size is not a function of how old the fact is, it is the distance to the
nearest anchor the chain still holds, and that anchor degrades from the
attestation grid to the checkpoint grid once retention expires.

The practical bound follows directly. A proof built promptly costs at most one
attestation interval of roots, so eleven at the very worst. A proof built after
retention expires costs at most one checkpoint interval, so a hundred and one.
Neither is close to the 500-root ceiling, and the gas difference between them is
roughly 1,600 bytes of calldata.

### Gas, measured rather than estimated

Replaces the synthetic figures from the unit tests, which excluded calldata and
the precompile's own metering.

| Submission | Gateway events | Blob | Calldata | Calldata gas | Total gas |
|---|---:|---:|---:|---:|---:|
| `repay` | 1 | 2,080 B | 3,044 B | 44,204 | **177,385** |
| `fund` | 1 | 2,080 B | 3,140 B | 45,356 | 158,749 |
| `double-funding` | 2 | 3,840 B | 4,772 B | 57,680 | **317,037** |

**Take 177,385 as the cost of a one-fact submission, not 158,749.** The cheaper
row is an artefact that occurs exactly once in a gateway's lifetime: its event
carried nonce 0, and a zero stores into a fresh slot for 2,200 gas where a
non-zero costs 22,100. Accounting for that and for the three extra continuity
roots the `fund` proof happened to carry:

```
(22,100 - 2,200) - 3 x 48 = 19,756 gas expected
133,181 - 113,393         = 19,788 gas observed
```

A residue of 32 gas. The difference is entirely storage semantics, not anything
about funding versus repayment.

At the measured Creditcoin gas price of 0.5 gwei, a one-fact submission costs
0.000089 CTC, and deploying the verifier cost 0.000635 CTC. The whole Creditcoin
side of a deal is a fraction of a cent.

### Attestation lag on the day

| | |
|---|---|
| Lag when the last transaction landed | 39 blocks |
| Time for attestation to cover it | 490 s |
| Lag sampled after the run | 42 blocks, 516 s |
| Attestation steps observed | 11521600, 610, 620, 630, 640 |

Every step was exactly ten blocks, and the lag sat at 39 to 42 blocks against
the 32 to 41 measured on the first day. The `attestationGracePeriod` of 600
blocks remains sized against `MaxCatchup`, which is the failure mode this run
did not exercise and would not have shown.

### The proof builder caught up completely

During the run the builder's cache trailed the on-chain attestation by up to ten
blocks, as before. Sampled after the run it was level with it, at 11521650 on
both. The trailing cache is a transient, not a fixed offset, so the worker still
has to poll the builder rather than assume a constant delay.

---

## Attestation retention, measured

The verifier was redeployed about an hour after the first acceptance run and the
same three transactions were proven again. Nothing about them had changed, but
their proofs had:

| Fixture | Height | Roots, minutes after the fact | Roots, an hour later | Gas then | Gas an hour later |
|---|---:|---:|---:|---:|---:|
| `double-funding` | 11521639 | 2 | 62 | 317,037 | 350,781 |
| `fund` | 11521633 | 8 | 68 | 158,749 | 192,493 |
| `repay` | 11521636 | 5 | 65 | 177,385 | 211,129 |

Every fresh proof anchored at 11521640, the attested tip at the time. Every hour
old proof anchored at **11521700**, a checkpoint boundary. The extra cost is
almost exactly what the extra roots imply: 60 roots is 1,920 bytes of calldata at
16 gas a byte plus 48 gas a root inside the precompile, so about 33,600, against
33,700 observed.

### The window

`get_attestation_bounds` distinguishes the two kinds of anchor, and the answer is
unambiguous. Around the hour-old heights:

```
height 11521650: parent 11521600 (isAttestation=false), child 11521700 (isAttestation=false)
height 11521800: parent 11521790 (isAttestation=true),  child 11521800 (isAttestation=true)
```

Both bounds around the older height are checkpoints. The attestations that used
to sit between them on the ten-block grid are gone.

Bisecting for the oldest surviving attestation, with the attested tip at
11521850, put the boundary between 11521700 and 11521710:

| | |
|---|---|
| Retention window | about 140 source blocks behind the attested tip |
| In time | about 28 minutes of Sepolia |
| In attestations | about 14 |

That was one sample at one moment, and at the time the exact figure was held as an
order of magnitude rather than a constant, with the count-or-age question left open
for the protocol team. The team has since answered: pruning is by count, and ten
attestations are retained. That accounts for this boundary to the block, but only
once the checkpoint grid is taken into account, and it means the 140 is not a
constant. See *Retention and cadence, answered by the protocol team*.

### What follows

**Proving promptly is a cost decision with a deadline.** Inside the window a
proof carries at most one attestation interval of roots, eleven at worst. Outside
it, the anchor is the checkpoint grid and the proof carries up to a hundred and
one. The measured price of missing the window is about 34,000 gas per submission.

**Missing it is a bill, as far as anything observed goes.** The deals contract
settles by source block height regardless of when the proof arrives, and past the
window the fact was still provable through the checkpoint grid an hour later. That
is the extent of what has been tested. It is not a demonstration that the fact stays
provable indefinitely, and the checkpoint retention question is still open below.

**The worker gets a concrete target.** Submit within roughly twenty minutes of a
height becoming attested and proofs stay short. That is comfortable: the builder
trails the chain by at most a handful of blocks, and building and sending takes
seconds. The target is a freshness heuristic rather than an expiry: the proof builder
chooses the anchor at the moment of the request, so submitting promptly means the
anchor is a recent attestation and the proof is short, while submitting late means it
has re-anchored to a checkpoint and the proof is longer and dearer. Correctness is
unaffected either way.

**Evidence identifiers are independent of the verifier instance.** The redeployed
verifier produced byte-identical identifiers for the same facts, which is what
`keccak256(abi.encode(chainKey, height, txIndex, kind, eventNonce))` promises and
now demonstrates. A redeployment replays the same history to the same names.

---

## Retention and cadence, answered by the protocol team

The Creditcoin team answered our question directly. Their answer, not our bisection,
is the source for the configuration below; the measurement stays as corroboration and
is reconciled against it further down.

| Parameter | Creditcoin3 Testnet, source Sepolia | Creditcoin mainnet, source Ethereum |
|---|---|---|
| Attestation interval | every 10 source blocks | same |
| Checkpoint interval | every 10 attestations, i.e. every 100 source blocks | same |
| Attestation retention | 10 | same |

**Source:** Creditcoin team, Discord, 2026-08-20.

**These are runtime parameters, not protocol invariants.** They are set by the runtime
and exposed through the configuration pallet, which means a runtime upgrade or a
governance action can change any of them without touching the precompile ABI, without
a release note aimed at us, and without anything in this repository noticing. So
"a checkpoint every 100 blocks" must not be written down as a permanent property of
the protocol: it is the product of two current settings, and both can move. Two of the
three are already read live by the probe — `AttestorApi_chain_attestation_interval`
and `AttestorApi_attestation_checkpoint_interval`, both reading 10 on every run so far
— which is the pattern the rest of our assumptions should follow where an accessor
exists.

### The measurement decomposes exactly, once the checkpoint grid is accounted for

The bisection put the oldest surviving attestation at 11521710, with the attested tip
at 11521850: 140 source blocks, or about fourteen attestations. Ten retained
attestations is 100 blocks, so the two numbers do not match head-on, and the
40-block remainder is worth being precise about, because it is easy to reach for the
wrong explanation.

It is **not** the attestation lag. The lag — 32 to 41 blocks over the probe run — is
the distance between the Sepolia head and the attested tip, and this bisection was
run against the attested tip, so the lag has already been subtracted out. Adding it
back would double-count.

What the remainder is, is the phase of the tip within the checkpoint grid. Retention
of ten is evidently applied when a checkpoint is cut rather than continuously:

| Term | Height |
|---|---:|
| Attested tip at bisection time | 11521850 |
| Most recent checkpoint at or below it | 11521800 |
| Ten retained attestations, counted back from that checkpoint | 11521710 … 11521800 |
| **Predicted oldest survivor** | **11521710** |
| **Observed oldest survivor** | **11521710** |

Exact, to the block. Continuous pruning would predict a boundary at 11521750–11521760
instead, and the bisection ruled that out: 11521710 was alive. The five attestations
above the checkpoint (11521810 through 11521850) are simply not pruned yet, and the
next checkpoint at 11521900 is what will take them.

Two consequences for how the 140 should be read.

**It is not a constant, and it is not an average to plan against.** The window behind
the attested tip breathes with the tip's position in the 100-block checkpoint cycle:
about 100 blocks just after a checkpoint is cut, about 190 just before the next one.
140 was one draw from that range. Sizing anything against 140 assumes a phase we do
not control.

**The number to plan against is 100 blocks behind the attested tip**, the floor of
that range — the guarantee that holds at every phase. At Sepolia's twelve seconds a
block that is twenty minutes, which is where the worker's twenty-minute freshness
target comes from and why it is the right size rather than a round guess.

That the pruning cadence is tied to checkpoint creation is our inference from a single
exact fit, not something the team stated. The fit is good enough to act on, and the
planning floor of 100 blocks holds either way, since continuous pruning would give a
flat 90 to 100.

### What the 10 in "attestation retention" counts

Ten attestations, not ten checkpoints. The team's phrasing does not carry the unit on
its own, and the difference matters: ten retained checkpoints would be a thousand
source blocks of anchors rather than a hundred.

Our own measurement settles it. Under a ten-checkpoint reading, fine-grained
attestations would have survived roughly a thousand source blocks back. The bisection
found the opposite: attestations were already gone 150 blocks back, and both bounds
around 11521650 were checkpoints. The ten-attestation reading predicts the observed
boundary exactly, as set out above.

Confirmation has been requested from the team. Until it arrives the unit is inferred
from our data rather than stated by the source, and the whole window calculation rests
on it — a thousand-block window and a hundred-block one are different products for the
worker — so it is worth re-checking if the team's reply says otherwise.

### Degradation, in the team's words

The proof generator binds a proof to the best anchor available at the moment the proof
is requested. That choice belongs to the generator; there is no way to influence it
from our side and no way to re-anchor a proof after the fact.

- A proof anchored to an ordinary attestation stops working once that attestation is
  pruned. Proving the same fact then requires roots reaching back to a checkpoint,
  which is a different proof, not a repaired one.
- The remedy is to ask the API again. A fresh request for the same transaction returns
  a proof anchored to whatever exists now, and it verifies.

This is the mechanism that *Proofs expire, facts do not* inferred from the failing
fixtures, now confirmed by the people who built it. It is why re-requesting the proof
before every submission is a rule for the worker rather than an optimisation.

### The provability horizon is still open

The team explained the transition from attestation anchors to checkpoint anchors. They
did not say that checkpoints are retained without limit, and nothing in the answer
rules out a checkpoint retention bound of its own.

- **Established:** inside the retained-attestation window a proof is short; outside it
  the anchor is the checkpoint grid and the proof is longer, by a measured 34,000 gas
  on our transaction shapes.
- **Not established:** that an arbitrarily old transaction stays provable. The longest
  gap actually exercised here is about an hour.

A follow-up asking exactly this has been sent; there is no answer yet. Until there is,
nothing in this document should claim that arbitrarily old facts remain provable
forever, and statements about late proofs stay inside what has been observed.

The stake is worth naming, because it changes category. If checkpoints are kept
without limit, submission timing is purely a cost question, as recorded above. If
checkpoints are bounded too, then evidence has a real deadline after which a fact
cannot be proven at all. That is a correctness question, and it stays open until the
team answers.

**The exposure there is our retry strategy, not the protocol.** A worker retrying with
exponential backoff has no natural stopping point, and a bounded attempt count is not
a bounded wait: each attempt costs longer than the last, so ten attempts can span a
day. A task left to retry patiently would cross any such deadline in silence and turn
a recoverable failure into a fact that can no longer be proven at all — self-inflicted,
and indistinguishable from a protocol fault when it surfaced. So the retry ceiling is
set on elapsed time as well as attempt count, the backoff is clamped, and hitting the
ceiling hands the task to manual submission with an explicit message. That holds
whether or not checkpoints turn out to be bounded; it costs nothing if they are not.
