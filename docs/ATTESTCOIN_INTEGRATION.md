# Attestcoin Protocol integration notes

Cr3dX reads every cross-chain fact through the Attestcoin Protocol precompiles on
Creditcoin3 Testnet (chain id 102031), with Ethereum Sepolia as the source chain.
This document records what the live network actually does, as opposed to what the
source and the published documentation say it does. Every number below is produced
by `npm run probe` (`scripts/probe.ts`) against the live testnet; raw results are
committed under `data/probe/`.

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

**Getting this wrong is asymmetric.** Oversizing it delays a default record on a deal that is already
unrecoverable. Undersizing it fabricates defaults against healthy borrowers. Marking a deal defaulted is
not terminal in Cr3dX either way: a later proven repayment still resolves it to `PAID_ON_TIME` or
`PAID_LATE`, decided by the source block height of the payment rather than by when the proof happened to
arrive. The grace period keeps the record honest; it is not a safety boundary.

<!-- probe:end -->
