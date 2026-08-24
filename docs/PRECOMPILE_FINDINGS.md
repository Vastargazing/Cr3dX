# Creditcoin3 source investigation (block-prover / Attestcoin Protocol)

> **Status: revision 2 (after external review), annotated 2026-08-20.** R1, R2, R3, R4, R5, R6, the chain ID check and the documentation discrepancy section were corrected. A Findings section and systematic evidence for R8 were added. The Creditcoin Team's preliminary response is that `verifyAndEmit` should probably charge for the log; a final answer is pending. The change log is at the end of this file.

## Version

- Repository: `https://github.com/gluwa/creditcoin3.git`
- Branch (origin default): `usc-dev`
- Commit: `06657e9909721f7b55a57f9f3c528739361f0fee`
- Commit date: `Fri Aug 14 12:17:00 2026 +0000` (subject: "Bump version to 3.132.0")
- Also reviewed `https://github.com/gluwa/usc-testnet-bridge-examples.git`, commit `4ff9a3bf5d7fa8dbfec34ae9726d3f81405dca7b`, branch `main`, dated `Wed Jul 29 08:21:52 2026 -0700`.
- External crate `usc-abi-encoding` 0.5.0 (dependency at `Cargo.toml:286`; resolved from crates.io at `Cargo.lock:16736-16741`): its source was downloaded and reviewed.
- Transitive dependencies used for conclusions, with their actual pins from `Cargo.lock`:
  - `frontier_2`, branch `stable2512_patch_no_extension`, rev **`89b8cc6610ee528909b0919b76897cc9213d2560`** (provides `precompile-utils`, `fp-evm`).
  - `evm` 0.43.4, `git+https://github.com/rust-ethereum/evm?branch=v0.x`, rev **`a656db9050c65170b050360c3fa66c0fd8bf226a`** (provides the `PrecompileHandle` trait).

### Chain ID (corrected in revision 2)

The check used the **`genesis.runtimeGenesis.patch.evmChainId.chainId` field**, not text search. Text search produces a false match inside the runtime WASM hex string:

| File | `name` | `evmChainId.chainId` |
|---|---|---|
| `chainspecs/testnetSpec.json` | Creditcoin3 Testnet | **102031** ← target network |
| `chainspecs/devnetSpec.json` | Creditcoin3 Dev | 102032 |
| `chainspecs/uscDryRunSpec.json` | Creditcoin3 DryRun | **42** |
| `chainspecs/uscDevnetSpec.json` | Creditcoin3 USC Dev | not set (`null`) |
| `chainspecs/uscTestnetSpec.json` | Creditcoin3 USC Testnet | not set (`null`) |

The target network, 102031, is established. **The value 102033 does not occur in any chainspec as an actual `evmChainId`.** The earlier claim in revision 1 was an artifact of a text match inside the WASM blob and has been withdrawn.

- Precompile addresses are identical on testnet, mainnet and devnet (`precompiles/metadata/precompiles-creditcoin3-{testnet,mainnet,devnet}.json`).

## Summary

| Question | Short answer | Confidence |
|---|---|---|
| R1. What the proof commits to | Not an Ethereum MPT. It is a custom keccak256 tree over ABI-encoded "tx+receipt" pairs. `status` and logs are included in the proven bytes. **However:** root checks run only offchain, cover only `tx.inner`/`receipt.inner`, have two exceptions (empty blocks and pre-Byzantium mainnet), and establish consistency of RPC data with the received header, not canonicality of the header itself. `tx.from` and `receipt.gas_used` are not covered by Ethereum roots. | Established from code |
| R2. `verify`/`verifyAndEmit` | On the pinned revision, the signatures, return value and event are established. Verification logic and its manual gas charges are identical. `verifyAndEmit` additionally executes `LOG3` and `calculate_tx_index_impl`, **but charges for neither**, as described in Finding F-1. The Creditcoin Team's preliminary view is that the log should be charged; future behavior remains open. | Established from code at the pin; a charging change awaits the team's answer |
| R3. `calculateTxIndex` after verify? | It does not technically depend on `verify`: it is a pure function and reads no state. The reference contract calls it earlier. The correct interpretation of the Discord statement is a safety rule: the index can be *calculated* before verify, but should be *trusted* only after it. | Established from code |
| R4. Is `encodedTx` raw RLP? | No. It uses custom ABI encoding for the tx and receipt. **The canonical hash can be reconstructed deterministically** from the proven fields: legacy uses `keccak256(rlp(tx))`; typed transactions use `keccak256(type_byte ‖ rlp(payload))`. No ready implementation was found in the reviewed repositories. | Encoding established from code; reconstructability derived from the field set |
| R5. Continuity proof and batches | One proof covers a sequential block range for one `chain_key`; a batch contains up to 10 distinct heights per call. Precompile limits are `MAX_CONTINUITY_ROOTS = 50_000`, `MaxBatchSize = 10` and a 10 MiB payload. The pallet limit is **`max(max_catchup, attestation_interval)`**, not their product. | Established from code |
| R6. Source height/time | Source height and the **Attestcoin continuity digest** are available. There is no direct getter for the source header hash (`header_hash` is signed but not exposed), and no source timestamp was found. | Established from code |
| R7. `chainKey` and registry | An auto-incrementing `u64` (`GENESIS_CHAIN_KEY = 1`), not a hash. The registry is `SupportedChains: StorageMap<ChainKey, SupportedChain>`. Contracts use `ChainInfo`. Addresses are in `runtime/src/precompiles.rs`. The current live Testnet registry contents were not checked from code. | Mechanism established; live contents not checked |
| R8. Outbound messages | No surface was found. This was checked through a complete package inventory, not grep alone. Documentation describes Writability (Outbox → signatures → relayer → Inbox) and marks it as not yet released. | Bounded negative result |
| R9. Gas | `CONTINUITY_BLOCK_HASH_COST = 48`, `GAS_STORAGE_LOOKUP = 2_600`, `CALCULATE_TX_INDEX_BASE_COST = 10`, `CALCULATE_TX_INDEX_ITERATION_COST = 18`. These are **not the complete call cost** because calldata, event logs and db reads are excluded. | Established from code |

---

## R1. What the proof cryptographically commits to

**Answer:** `block-prover` does NOT verify inclusion in Ethereum `transactionsRoot`/`receiptsRoot` (MPT/RLP). On-chain it verifies inclusion in its **own** binary keccak256 tree. Each leaf is an ABI-encoded, not RLP-encoded, block of "transaction fields + receipt fields".

A leaf has the `0x00` prefix:
```rust
// common/merkle/src/keccak.rs:6-13
pub fn hash_leaf(input: &[u8]) -> H256 {
    let mut prefixed = sp_std::vec![crate::LEAF_HASH_PREPEND_VALUE; input.len() + 1];
    prefixed[1..].copy_from_slice(input);
    sp_io::hashing::keccak_256(&prefixed).into()
}
```
The tree is custom and pads with a zero hash (`common/merkle/src/keccak_merkle_tree.rs:34-35`, `PAD_HASH: H256 = H256([0; 32])`).

The leaf contents (`common/eth/src/lib.rs:172-178`) come from `usc_abi_encoding::abi::abi_encode(tx, rx, encoding)`.

`status` and logs are included in the encoded bytes (`usc-abi-encoding-0.5.0/src/abi/v1.rs:32-59`):
```rust
DynSolValue::Uint(U256::from(rx.status()), 8),   // status
DynSolValue::Uint(U256::from(rx.gas_used), 64),  // gas_used  <-- see the warning below
DynSolValue::Array(rx.inner.logs().iter().map(|log| { /* address, topics[], data */ }) ...),
DynSolValue::Bytes(log_blooms),
```
There is no separate Merkle/Patricia proof for logs. Logs are fields of the already Merkle-committed leaf. The precompile **does not check** `status`; the consuming contract must do so. The site documentation confirms this as well.

### Important: what exactly the root checks establish (corrected in revision 2)

Comparison with Ethereum roots runs **only offchain** when the attestor assembles a block. Its guarantees are narrower than revision 1 stated:

```rust
// common/eth/src/lib.rs:259-262
let tx_inners: Vec<_> = txs.iter().map(|t| t.inner.clone()).collect();
let computed_tx_root = calculate_transaction_root(&tx_inners);
if computed_tx_root != block.header.transactions_root { return Err(...); }
```
```rust
// common/eth/src/lib.rs:279-287
let inner_receipts: Vec<_> = receipts.iter().map(|r| r.clone().into_primitives_receipt().inner).collect();
let computed_receipt_root = calculate_receipt_root(&inner_receipts);
if computed_receipt_root != block.header.receipts_root { return Err(...); }
```

Four limitations are each established from code:

1. **The checks establish consistency, not canonicality.** They compare against `block.header` obtained through the same RPC. This protects against disagreement between `eth_getBlockByNumber` and `eth_getBlockReceipts`, including during a reorg, but does not establish that the header itself is canonical. Canonicality comes from attestor consensus, not from this check.

2. **For empty blocks, both checks are skipped entirely** (`common/eth/src/lib.rs:229-241`):
```rust
if block.transactions.is_empty() && receipts.is_empty() {
    trace!(block_number = expected_number, "Skipping header root check for empty block");
    return Ok(Self { chain_id, number: expected_number, hash, items: vec![] });
}
```

3. **The receipt root is not checked for pre-Byzantium Ethereum mainnet** (`common/eth/src/lib.rs:270-278`), with `ETHEREUM_MAINNET_CHAIN_ID = 1` (`lib.rs:200`) and `ETHEREUM_BYZANTIUM_BLOCK = 4_370_000` (`lib.rs:206`).

4. **Only `inner` is covered.** The root checks use `t.inner` and `r...inner`, while the ABI leaf includes two RPC-wrapper fields that are absent from the signed envelope or canonical receipt:
   - `tx.from`: `usc-abi-encoding-0.5.0/src/abi/v1.rs:24`, `DynSolValue::Address(tx.from)`. Every other transaction field is obtained through `tx.<method>()` / `signed_tx.tx()`, which means from `inner`; `from` is the only field read directly from the wrapper.
   - `receipt.gas_used`: `v1.rs:36`. The canonical receipt root commits to `cumulativeGasUsed`, not per-transaction `gasUsed`.

   Both fields are protected by the custom Merkle root and attestor signatures, but calling them "proven by Ethereum roots" is incorrect. Practical consequences for a consumer: recover `from` from the signature (all `v`/`r`/`s` or `yParity`/`r`/`s` components are in the leaf), and treat `gasUsed` as attestor-assured, not Ethereum-proven, unless it is separately derived from canonical receipts.

### `header_hash`: signed but not bound to the continuity proof (clarified in revision 2)

`header_hash` **is included** in the signed bytes (`primitives/attestor/src/lib.rs:300-321`):
```rust
pub fn serialize(&self) -> Vec<u8> {
    ...
    bytes.extend_from_slice(self.header_hash.as_ref());   // header_hash is signed
    bytes.extend_from_slice(self.root.as_bytes());
    ...
}
```
but **is not included** in the continuity digest (`primitives/attestor/src/lib.rs:324-328`):
```rust
pub fn digest(&self) -> Digest {
    compute_digest_for(self.header_number, &self.root, self.prev_digest.as_ref())
}
```
Therefore, the continuity chain checked by `block-prover` binds `(blockNumber, root, prevDigest)` and **does not bind** the proof to `header_hash`, although the signature does cover `header_hash`. The precompile provides no separate path to "prove that this root belongs to the block with this Ethereum hash."

### Roles (clarified in revision 2)

An **attestor** signs and submits an attestation. `commit_attestation` requires `ensure_signed` and membership in `ActiveAttestors` (`pallets/attestation/src/lib.rs:1063-1075`):
```rust
let account = ensure_signed(origin)?;
let active_attestors = ActiveAttestors::<T>::get(chain_key).into_iter().collect::<BTreeSet<_>>();
ensure!(active_attestors.contains(&account), Error::<T>::AttestorNotActive);
```
Creditcoin validators are responsible for including the extrinsic in a block and for runtime consensus. Revision 1 conflated these roles as "signed by attestors/validators"; that wording was corrected.

---

## R2. `verify` and `verifyAndEmit`

```rust
// precompiles/block-prover/src/lib.rs:126-147
#[precompile::public("verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))")]
#[precompile::view]
fn verify(handle: &mut impl PrecompileHandle, chain_key: u64, height: u64,
    encoded_transaction: BoundedBytes<ConstU10MB>,
    merkle_proof: TransactionMerkleProof, continuity_proof: ContinuityProof) -> EvmResult<bool>
```
```rust
// precompiles/block-prover/src/lib.rs:173-193
#[precompile::public("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))")]
fn verify_and_emit(handle: &mut impl PrecompileHandle, chain_key: u64, height: u64,
    encoded_transaction: BoundedBytes<ConstU10MB>,
    merkle_proof: TransactionMerkleProof, continuity_proof: ContinuityProof) -> EvmResult<bool>
```
The batch overloads are at `lib.rs:214-235` and `lib.rs:264-284`.

**Return value:** `EvmResult<bool>` returns either `true` or a revert with text (`false` is never returned), `lib.rs:330-336`.

**Event** (`lib.rs:52-56`, `verify.rs:252-266`):
```solidity
event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);
```
`chainKey` and `height` are indexed topics. `transactionIndex` is in data and is calculated at emission time through `calculate_tx_index_impl`.

**Difference and gas (corrected in revision 2).** Both functions use the shared `verify_impl`/`verify_batch_impl` with an `emit_events` flag. Precisely:

- verification logic and all its **manual** `record_cost` calls are identical;
- `verifyAndEmit` additionally executes `calculate_tx_index_impl` and `log3(...).record(handle)`;
- **neither operation is charged**, so the gas actually charged is identical.

Revision 1 stated that "gas consumption is identical," based on the doc comment at `lib.rs:104-106`. That is factually correct but concealed the reason. Finding **F-1** below traces the reason through the full dependency chain to `evm` rev `a656db9`.

**Selectors** are not printed in the code (checked by grep over the crate); they were calculated independently:

| Function | Selector |
|---|---|
| `verify` (single) | `0x7cc4e258` |
| `verifyAndEmit` (single) | `0x02f4d167` |
| `verify` (batch) | `0x1b5f6f88` |
| `verifyAndEmit` (batch) | `0x4da3b895` |
| `calculateTxIndex` | `0x44f85f1c` |
| topic0 `TransactionVerified` | `0x8a8df984...` |

---

## R3. Can `calculateTxIndex` be called only after successful verification?

**Technically, it does not depend on `verify`.** The wrapper (`lib.rs:303-324`) only charges gas and calls the pure implementation. There are no storage reads, modifiers or `require` clauses binding it to a previous `verify`. The implementation is bit arithmetic over `siblings`:
```rust
// precompiles/block-prover/src/verify.rs:122-156
for (bit_position, sibling) in merkle_proof.siblings.iter().enumerate() {
    if sibling.is_left { tx_index |= 1u64 << bit_position; }
}
```
The unit test calls it with an arbitrary `root` that was never verified (`tests_view.rs:474-491`). The Creditcoin reference contract calls it **before** verification to obtain a deduplication `queryId` (`usc-testnet-bridge-examples/contracts/sol/USCBase.sol:20-46`).

**Correct interpretation (clarified in revision 2).** Revision 1's wording, "the Discord statement is disproved," was too strong. The correct reading is a safety rule, not a technical restriction. The index can be **calculated** at any time. The function is pure and will return an "index" from arbitrary unverified proof data. It can be **trusted** as the transaction's position in an actual source block only after a successful `verify` for the same `merkle_proof`. Use before verify is valid only in the role used by Creditcoin itself: as a deterministic deduplication key, not as a fact about external-chain state.

---

## R4. Is `encodedTx` raw RLP or a custom encoding?

**It is not raw RLP.** It uses ABI encoding (`alloy::dyn_abi::DynSolValue`) that combines transaction and receipt fields, with `EncodingVersion::V1` from crate `usc-abi-encoding` 0.5.0.

The layout (`v1.rs:15-247`) is `type_id: uint8` (0-4); common fields `nonce`, `gasLimit`, `from`, `isToNull`, `to`, `value`, `input`; depending on type, `gasPrice` or `chainId`+`maxPriorityFeePerGas`+`maxFeePerGas`, `accessList`, signature (`v`/`r`/`s` for legacy, `yParity`/`r`/`s` for typed); for type 3, `maxFeePerBlobGas`+`blobVersionedHashes`; for type 4, `authorizationList`; then receipt fields.

**Can the canonical transaction hash be obtained? Yes (clarified in revision 2).**

Direct answer: the proven ABI fields are **sufficient** to reconstruct the signed transaction envelope deterministically and therefore its canonical hash:
- legacy (type 0): `keccak256(rlp(tx))`;
- typed (type 1-4): `keccak256(type_byte ‖ rlp(payload))`.

The `from` field is not needed. It is not part of the signed envelope and is redundant in the blob, which is also why Ethereum roots do not cover it, as discussed in R1.

**No ready implementation exists in the reviewed repositories.** The developers explicitly note that the real hash comes from RPC rather than being calculated from ABI bytes:
```rust
// proof-gen-api-server/src/services/continuity_service/helpers.rs:321-323
// The real transaction hash comes from the block fetch above (RLP-derived, not computed
// from the ABI-encoded bytes).
let tx_hash_opt = fetched_tx_hash;
```
`grep -rniI "rlp\b" --include="*.rs"` over the repository, excluding tests, returns only that line; there are no RLP-encoding functions. Revision 1 presented this as "not found." More precisely, **reconstruction is possible but must be implemented by the consumer**. In Solidity this is substantial work: an RLP encoder plus branching over 5 transaction types.

---

## R5. Continuity proofs and batches

**Structure** (`primitives/attestor/src/block.rs:212-222`):
```rust
pub struct ContinuityProof {
    pub lower_endpoint_digest: H256,
    pub roots: Vec<H256>,
}
```
The chain is `digest_i = keccak256(blockNumber_i ‖ roots[i] ‖ digest_{i-1})`; on-chain code compares only the final digest against an attestation or checkpoint (`continuity.rs:152-172`).

**Different blocks are supported within one `chain_key`.** A batch accepts an array of heights and one shared proof that must cover `[min(heights), max(heights)]`:
```rust
// precompiles/block-prover/src/verify.rs:336-361
let last_block_number = ...start_block_number.checked_add(roots_len_minus_one)...;
if last_block_number < max_height {
    return Self::revert_with_message("Continuity chain doesn't cover maximum query height");
}
```

**Limits:**

1. `MAX_CONTINUITY_ROOTS: usize = 50_000` (`verify.rs:52`), a defence-in-depth bound for external calls.
2. `MaxBatchSize = sp_core::ConstU32<10>` (`lib.rs:86`), established by test `tests_full_coverage.rs:1543-1584`.
3. `ConstU10MB = sp_core::ConstU32<10_485_760>` (`lib.rs:31-32`), the payload bound.

4. **The pallet limit is `max(...)`, not a product (CORRECTED in revision 2).**

Revision 1 gave `max_catchup * attestation_interval`. This was **an error**: the value came from a stale comment next to the enum variant, not executable code. The actual implementation is:
```rust
// pallets/attestation/src/continuity.rs:95-101
let max_catchup = MaxCatchup::<T>::get(chain_key) as u64;
let attestation_interval = Self::chain_attestation_interval(chain_key);
let max_roots = max_catchup.max(attestation_interval) as usize;
ensure!(
    attestation.continuity_proof.len() <= max_roots,
    Error::<T>::OversizedContinuityProof
);
```
The signed extension applies the same rule at txpool admission:
```rust
// pallets/attestation/src/extensions.rs:120-127
let max_roots = max_catchup.max(attestation_interval) as usize;
if attestation.continuity_proof.len() > max_roots { /* OVERSIZED_PROOF_CODE */ }
```
The doc comment there (`extensions.rs:181`) also says `max(max_catchup, attestation_interval)`. The stale source of the error is `pallets/attestation/src/lib.rs:855`: `// Continuity proof roots exceeds max_catchup * attestation_interval`. This internal discrepancy between comment and code is recorded in the discrepancy section.

The practical difference is material: with `max_catchup = 10`, `attestation_interval = 100`, the real limit is 100, not 1000.

---

## R6. Source height and time

**Height is available, but the return value is a digest, not the source block hash (CORRECTED in revision 2).**

```rust
// precompiles/chain-info/src/lib.rs:185-192
if let Some(last_digest) = LastDigest::<Runtime>::get(chain_key) {
    handle.record_db_read::<Runtime>(last_digest.encoded_size())?;
    Ok(HeightHashResult { height: last_digest.0, hash: last_digest.1, is_attestation: true, exists: true })
}
```
Storage type (`pallets/attestation/src/lib.rs:357-358`):
```rust
pub type LastDigest<T: Config> = StorageMap<_, Blake2_128Concat, ChainKey, (u64, Digest), OptionQuery>;
```
The `hash` field in `HeightHashResult` is therefore the **Attestcoin continuity digest**, not the Ethereum `header_hash`. The fallback branch returns `last_checkpoint.digest`, which is also a digest. The field name `hash` is misleading; revision 1 made this exact mistake.

The accurate short form is:

> Source height and the Creditcoin continuity digest are available. There is no direct getter for the source header hash or source timestamp.

`header_hash` exists inside the signed `AttestationData` and is covered by the signature, as described in R1, but `ChainInfo` does not expose it.

Methods available without a transaction Merkle proof (`precompiles/chain-info/src/lib.rs`) are `get_latest_attestation_height_and_hash` (177-206), `get_latest_checkpoint_height_and_hash` (208-228), `is_height_attested` (463-582), `get_checkpoint_for_height` (635-658), plus `find_highest_attested_before`, `find_lowest_attested_after`, `get_attestation_bounds`, `get_attestation_height_for_digest`, `get_attestation_genesis_height`.

Qualification: this is a synchronous read of Creditcoin storage available to a contract on Creditcoin itself, not a portable offchain proof structure.

**No timestamp was found.** The signed structure has no time field:
```rust
// primitives/attestor/src/lib.rs:262-268
pub struct AttestationData<H> {
    pub chain_key: ChainKey,
    pub header_number: Height,
    pub header_hash: H,
    pub root: H256,
    pub prev_digest: Option<Digest>,
}
```
Search scope: `pallets/attestation/src/lib.rs`, `precompiles/chain-info/src/lib.rs`, `precompiles/block-prover/src/*.rs`, `primitives/attestor/src/*.rs`, `common/eth/src/lib.rs`. The only `timestamp` matches are for `pallet_timestamp` in the test mock runtime (`precompiles/block-prover/src/mock.rs`).

---

## R7. `chainKey` and supported networks

An auto-incrementing counter, not a hash (`pallets/supported-chains/src/lib.rs:98-102`):
```rust
pub const GENESIS_CHAIN_KEY: ChainKey = 1;
pub type ChainKeyValue<T> = StorageValue<_, ChainKey, ValueQuery, ConstU64<GENESIS_CHAIN_KEY>>;
```
It is assigned by `register_chain`, which is restricted to `OperatorsOrigin` (`lib.rs:176-256`). The registry is `SupportedChains: StorageMap<ChainKey, SupportedChain>` plus `ChainIdAndNameToUniqKey` (`lib.rs:77-96`).

**`ChainKey` ≠ `ChainId`:** the first is Creditcoin's internal sequential id; the second is the actual EIP-155 chain id of the external network. Do not conflate them.

Contract access: `ChainInfo.get_supported_chains()` (`chain-info/src/lib.rs:122-138`) and `get_chain_by_key(uint64)` (140-160).

Addresses (`runtime/src/precompiles.rs:29-46`): `0xFD1` SubstrateTransfer (4049), `0xFD2` **BlockProver** (4050), `0xFD3` **ChainInfo** (4051), `0xFD4` AttestorStash (4052), `0x13B9` Sr25519 (5049), `0x13BA` Ed25519 (5050).

**Qualification (added in revision 2):** everything above describes the mechanism. **The current live Testnet 102031 registry contents, including which networks are registered under which `chainKey`, cannot be determined from source code.** This is runtime state. It requires a node query through `ChainInfo.get_supported_chains()` or a storage query, outside the scope of source review.

---

## R8. Message direction (Creditcoin → external EVM network)

**Not found.** Revision 2 replaces grep-only evidence with an inventory of the complete surface.

Complete map of custom components at this pin:

- **Pallets** (`pallets/`): `attestation`, `randomness`, `supported-chains`, all of them.
- **Precompiles** (`precompiles/`): `attestor-stash`, `block-prover`, `chain-info`, `ed25519-verifier`, `sr25519-verifier`, `substrate-transfer`, all of them.
- **Public Solidity interfaces** (`precompiles/metadata/sol/`): exactly six files, one per precompile.
- **Runtime composition** (`runtime/src/lib.rs:1079-1118`, `construct_runtime!`): Substrate system and consensus pallets plus Frontier (`Ethereum`, `EVM`, `EVMChainId`, `DynamicFee`, `BaseFee`, `HotfixSufficients`) plus `Attestation`, `SupportedChains`, `Randomness`, `Operators`, `MultiBlockMigrations`.

The complete public function set across all six interfaces covers signature verification, reading attestations, checkpoints and the chain registry, attestor stake management, and `transfer_substrate`. **There is no function that queues a message for an external network, no Outbox and no export of an aggregate signature for external consumption.**

Expanded text search over all tracked files and extensions, including `outbox`, which revision 1 omitted:
```
git grep -rlin "outbox\|inbox\|writabil\|writable" -- .
→ checkpoint-builder/README.md   (false positive: "output path is writable")
```
In `usc-testnet-bridge-examples`, the only "reverse" flow is an offchain worker that signs Sepolia transactions with the same key used on Creditcoin (`loan-flow/worker.ts:52,94,100`, `CREDITCOIN_WALLET_PRIVATE_KEY`). It is a trusted operator, not a proof.

**Documentation** describes Writability (Outbox → signatures → relayer → Inbox) and explicitly marks it as unreleased: *"Writability is undergoing 3rd party testing and audits."*

**Conclusion:** at pin `06657e9`, the trustless outbound direction is absent. This negative result is bounded to the two reviewed repositories; an implementation may exist in private or not-yet-merged branches.

---

## R9. Gas

```rust
// precompiles/block-prover/src/verify.rs
pub const CONTINUITY_BLOCK_HASH_COST: u64 = 48;        // :30
pub const GAS_STORAGE_LOOKUP: u64 = 2_600;             // :33
pub const MAX_CONTINUITY_ROOTS: usize = 50_000;        // :52  (not gas)
pub const CALCULATE_TX_INDEX_BASE_COST: u64 = 10;      // :56
pub const CALCULATE_TX_INDEX_ITERATION_COST: u64 = 18; // :58
```
Charging: Merkle proof uses `CONTINUITY_BLOCK_HASH_COST × siblings` (`verify.rs:75-88`); continuity uses `× roots.len()` (`continuity.rs:144-150`); storage reads use multiples of `GAS_STORAGE_LOOKUP` (`lib.rs:345-393`, `continuity.rs:88-91`).

`ChainInfo` independently duplicates the same constant (`chain-info/src/lib.rs:25`) and also uses `record_db_read`. `AttestorStash` declares no `GAS_*` constants. It dispatches through `RuntimeHelper::try_dispatch`, with gas determined by the pallet's weight-to-gas mapping.

**Qualification (added in revision 2):** these are **manual charges inside the precompile, not the complete call cost**. Costs outside these constants include transaction-level calldata, which is material for large `encodedTx` values up to 10 MiB, `record_db_read` in `ChainInfo`, standard EVM overhead and the **uncharged event log** described in F-1. These constants alone are not sufficient for call budgeting.

---

## Findings

### F-1. At the inspected pin, `verifyAndEmit` does not charge for its EVM log

**Finding:** `verifyAndEmit` emits a `LOG3` but does not charge gas for it. The full chain was inspected at the pinned revisions.

1. The block-prover call, for a single item (`verify.rs:252-266`) and inside the loop for every batch item (`verify.rs:432-445`):
```rust
let tx_index = Self::calculate_tx_index_impl(&merkle_proof)?;
let event_data = ethabi::encode(&[Token::Uint(tx_index.into())]);
log3(handle.context().address, SELECTOR_LOG_TRANSACTION_VERIFIED,
     H256::from_low_u64_be(chain_key), H256::from_low_u64_be(height), event_data)
    .record(handle)?;
```
2. `LogExt::record` only stores the log, at `frontier_2@89b8cc6:precompiles/src/evm/logs.rs:99-107`:
```rust
impl LogExt for Log {
    fn record(self, handle: &mut impl PrecompileHandle) -> EvmResult {
        handle.log(self.address, self.topics, self.data)?;
        Ok(())
    }
    fn compute_cost(&self) -> EvmResult<u64> {
        crate::evm::costs::log_costs(self.topics.len(), self.data.len())
    }
}
```
   Notably, `compute_cost()` exists in the same trait and block-prover does not call it.
3. `PrecompileHandle::log` → `Handler::log`, at `evm@a656db9:src/executor/stack/executor.rs:1762-1764`, then `executor.rs:1457-1465`:
```rust
fn log(&mut self, address: H160, topics: Vec<H256>, data: Vec<u8>) -> Result<(), ExitError> {
    event!(Log { address, topics: &topics, data: &data });
    self.state.log(address, topics, data);
    Ok(())
}
```
   There is no gasometer call; the log is simply stored in state.
4. `record_log_costs_manual` is **absent** from block-prover, while neighboring precompiles call it at `attestor-stash/src/lib.rs:112,151,193` (`4,0`), `:380` (`2,0`) and `substrate-transfer/src/lib.rs:52` (`3,32`).

**Magnitude.** Our calculated estimate uses the formula (`frontier_2@89b8cc6:precompiles/src/evm/costs.rs:26-52`): `G_LOG=375`, `G_LOGTOPIC=375`, `G_LOGDATA=8`. For `log3` with 3 topics and 32 bytes of data:

```
375 + 3×375 + 32×8 = 1,756 gas per event
```

For a batch of 10, the undercharge is up to **17,560 gas** per call. The repeated `calculate_tx_index_impl` pass in the emit path is also uncharged.

**Why this matters to us:** `verify` and `verifyAndEmit` cost the same not because the event is free, but because its cost is not charged. Planning a gas budget from the observed cost at this pin is risky. If the undercharge is addressed, which appears to be an unintended omission given the neighboring precompiles, the cost of `verifyAndEmit` will rise by about 1.8k per event and existing gas limits may no longer fit.

**Live check and external status.** On identical inputs, Creditcoin3 Testnet
`eth_estimateGas` returned 42 966 for both functions, a difference of 0. The
methodology and data are in `docs/ATTESTCOIN_INTEGRATION.md`. On 2026-08-20, the
Creditcoin Team gave the preliminary response that the log should technically be
charged and gas recording may increase by approximately the cost of a `LOG3`;
a final answer is pending. F-1 therefore remains an exact description of the
pinned revision and current measurement, not a prediction of future charging.

### F-2. The `OversizedContinuityProof` comment contradicts the code

`pallets/attestation/src/lib.rs:855` says `max_catchup * attestation_interval`; code in two places calculates `max(...)`, as shown in R5. The comment is dangerous because it overstates the expected limit by a large factor. Revision 1 made exactly this mistake.

---

## Documentation discrepancies

### 1. Inside the repository (README / Solidity docs vs. implementation)

- **Stale names.** `precompiles/block-prover/README.md` describes `verifyQuery`/`verifyQueryView`/`verifyBatchQueries`/`verifyBatchQueriesView` and status codes (`0=Success, 1=MerkleProofInvalid...`). Those names are absent from the code, which provides `verify`/`verifyAndEmit` with no status codes, returning either `true` or a revert. The README points to `gluwa/creditcoin3-next` and `precompiles/native-query-verifier`; the directory is named `precompiles/block-prover`.

- **Gas (clarified in revision 2).** Revision 1 claimed that "none" of the README values matched the code. **That is incorrect:** `Storage lookup | 2,600` (`README.md:114`, `block_prover.sol:68,176`) exactly matches `GAS_STORAGE_LOOKUP = 2_600`. The remaining values differ: `Base 21,000`, `Per TX byte 16`, `Per sibling 200`, `Per continuity block 400`, weights `100000`/`50000`; nothing in the code corresponds to them. Nuance: `README.md:112` describes 400/block as "hash (~48) + overhead (~350)," so 48 appears as a component of the intended model, but only the hash itself is implemented.

- **`ExampleUsage.sol` does not compile** against the current interface. It uses `ContinuityProof.blocks: ContinuityBlock[]`; the current interface is `ContinuityProof.roots: bytes32[]`.

- **Contradiction over `roots[0]`.** Doc comments at `lib.rs:113,159` say "blocks[0] is at queryHeight**-1**"; the implementation (`verify.rs:194,233`, `start_block_number = height`) and `.sol` interface agree on `queryHeight`. An offchain generator should follow `verify.rs`.

- **README: "minimum 2 blocks in chain."** Code accepts `roots.len() >= 1` (`continuity.rs:104-109`) with the special case "chain ends in queryHeight" (`continuity.rs:184-190`).

- **`OversizedContinuityProof`:** see F-2.

### 2. Code vs. docs.creditcoin.org

- **Writability.** The site describes Outbox → signatures → relayer → Inbox and marks the feature as undergoing testing and audit. This does not contradict the code; it is a gap between the described future and the current pin.
- **Gas model.** The site provides a formula in CTC (`≈2.3×10⁻⁵ + 2.9×10⁻⁷ × continuity_hash_count`) that qualitatively agrees with linear scaling by `roots.len()`, but provides no raw constants. Exact comparison is impossible, so `verify.rs` takes priority.
- **Transaction status.** The site supports the R1 conclusion: *"a dApp's attestcoin smart contract MUST check the 'status' field"*. The precompile does not check `status` itself.
- **Links in the `usc-testnet-bridge-examples` README** to `docs.creditcoin.org/usc/...` return 404; the content moved to `/attestcoin-protocol/...`.
- **R3/R4/R6/R7** are either not covered by the site (chainKey, timestamp) or described too generally. Code is the only source.

---

## Open items

1. **Runtime weight-to-gas coefficient:** `runtime/src/lib.rs` was not read in full for `WeightToFee`/`GasWeightMapping`. This is required to convert the weight-based costs of `AttestorStash` into gas.
2. **Checkpoint construction logic** (`Checkpoints`, `CheckpointBuckets`, `CHECKPOINT_BUCKET_SIZE`): only getters in `chain-info` were read, not the construction code in `pallets/attestation/src/lib.rs`.
3. **Signature aggregation mechanism.** `primitives/attestor/src/bls.rs` was not analyzed. A search for `verify_aggregate`/`fast_aggregate`/`verify_signature` in `pallets/attestation/src/` returned no matches, while `commit_attestation` uses `ensure_signed` plus membership in `ActiveAttestors`. How quorum is reached and where the aggregate signature is checked is **not established**, and this report makes no claim about it.
4. **Components `attestor/`, `checkpoint-builder/`, `checkpoint-verifier/`, `cc3-indexer/`:** only file lists and README files were reviewed.
5. **`proof-gen-api-server`:** only `continuity_service/helpers.rs` was reviewed.
6. **Live Testnet 102031 state:** chain registry contents, actual `chainKey` values, current `max_catchup`/`attestation_interval`, which determine the effective limit in R5. Node queries are required.
7. **Future charging for F-1:** the Creditcoin Team's preliminary view is that the log should be charged; a final answer is pending.
8. **docs.creditcoin.org:** reviewed selectively, not in full.

---

## Change log (revision 1 → revision 2)

| # | Item | Before | After |
|---|---|---|---|
| 1 | Pallet limit (R5) | `max_catchup * attestation_interval` | `max(max_catchup, attestation_interval)`, from `continuity.rs:97`, `extensions.rs:123` |
| 2 | Chain ID (Version) | "102033 occurs in uscDryRunSpec*.json" | Withdrawn: a match inside WASM hex; the actual DryRun `evmChainId` is 42, with a table covering all specs |
| 3 | README gas (Discrepancies) | "no value matches" | `Storage lookup 2,600` matches; the others do not |
| 4 | Root checks (R1) | "guarantees that data comes from a real Ethereum block" | RPC data is consistent with the header, not established as canonical; plus empty-block and pre-Byzantium skips; plus `tx.from`/`receipt.gas_used` outside the roots |
| 5 | `header_hash` (R1) | "not included in digest" (only) | Not included in the digest, **but** included in `serialize()` and covered by the signature |
| 6 | Roles (R1) | "signed by attestors/validators" | An attestor signs and commits (`ensure_signed` + `ActiveAttestors`); validators provide block consensus |
| 7 | `hash` from ChainInfo (R6) | "attested source height+hash" | Height plus **continuity digest**; the source header hash is not exposed |
| 8 | Gas for verify/verifyAndEmit (R2) | "consumption is identical" (as a fact) | Identical because the log is uncharged, promoted to Finding F-1 |
| 9 | R4 | "reconstruction is our inference, not found" | Direct answer: yes, reconstructable; formulas for legacy/typed; no implementation in the repositories |
| 10 | R3 | "Discord statement disproved" | Softened: safety rule (calculate before verify, trust after) |
| 11 | R8 | grep over `.rs`, without `outbox` | Complete map of pallets/precompiles/interfaces/runtime plus expanded git grep |
| 12 | R7, R9 | Not applicable | Qualifications added: live registry contents not checked; constants are not the complete call cost |
