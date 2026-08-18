# Разведка по исходникам Creditcoin3 (block-prover / Attestcoin Protocol)

> **Статус: ревизия 2 (после внешнего ревью).** Исправлены R1, R2, R3, R4, R5, R6, проверка chain ID и раздел расхождений с документацией; добавлен раздел «Находки» и систематическое доказательство для R8. Журнал изменений — в конце файла.

## Версия

- Репозиторий: `https://github.com/gluwa/creditcoin3.git`
- Ветка (default у origin): `usc-dev`
- Коммит: `06657e9909721f7b55a57f9f3c528739361f0fee`
- Дата коммита: `Fri Aug 14 12:17:00 2026 +0000` (subject: "Bump version to 3.132.0")
- Дополнительно прочитан `https://github.com/gluwa/usc-testnet-bridge-examples.git`, коммит `4ff9a3bf5d7fa8dbfec34ae9726d3f81405dca7b`, branch `main`, дата `Wed Jul 29 08:21:52 2026 -0700`.
- Внешний крейт `usc-abi-encoding` 0.5.0 (зависимость, `Cargo.toml:286`; резолв с crates.io, `Cargo.lock:16736-16741`) — исходник скачан и прочитан.
- Транзитивные зависимости, по которым делались выводы (реальные пины из `Cargo.lock`):
  - `frontier_2`, branch `stable2512_patch_no_extension`, rev **`89b8cc6610ee528909b0919b76897cc9213d2560`** (даёт `precompile-utils`, `fp-evm`).
  - `evm` 0.43.4, `git+https://github.com/rust-ethereum/evm?branch=v0.x`, rev **`a656db9050c65170b050360c3fa66c0fd8bf226a`** (даёт трейт `PrecompileHandle`).

### Chain ID (исправлено в ревизии 2)

Проверялось **по полю `genesis.runtimeGenesis.patch.evmChainId.chainId`**, а не текстовым поиском (текстовый поиск ложно срабатывает внутри hex-строки runtime WASM):

| Файл | `name` | `evmChainId.chainId` |
|---|---|---|
| `chainspecs/testnetSpec.json` | Creditcoin3 Testnet | **102031** ← целевая сеть |
| `chainspecs/devnetSpec.json` | Creditcoin3 Dev | 102032 |
| `chainspecs/uscDryRunSpec.json` | Creditcoin3 DryRun | **42** |
| `chainspecs/uscDevnetSpec.json` | Creditcoin3 USC Dev | не задан (`null`) |
| `chainspecs/uscTestnetSpec.json` | Creditcoin3 USC Testnet | не задан (`null`) |

Целевая сеть 102031 подтверждена. **Значение 102033 не встречается ни в одном chainspec как реальный `evmChainId`** — прежнее утверждение отчёта (ревизия 1) было артефактом текстового совпадения внутри WASM-блоба и отозвано.

- Адреса прекомпайлов идентичны на testnet/mainnet/devnet (`precompiles/metadata/precompiles-creditcoin3-{testnet,mainnet,devnet}.json`).

## Сводка

| Вопрос | Краткий ответ | Уверенность |
|---|---|---|
| R1. Что коммитится в пруфе | Не Ethereum MPT: собственное keccak256-дерево поверх ABI-кодированных пар «tx+receipt». `status` и логи входят в доказанные байты. **Но:** root-проверки выполняются только offchain, покрывают лишь `tx.inner`/`receipt.inner`, имеют два исключения (пустые блоки, pre-Byzantium mainnet), и доказывают согласованность RPC-данных с полученным header — не каноничность самого header. `tx.from` и `receipt.gas_used` Ethereum-корнями не покрыты. | Подтверждено кодом |
| R2. `verify`/`verifyAndEmit` | Сигнатуры, возврат и событие подтверждены. Логика проверки и её ручные gas-charges идентичны; `verifyAndEmit` дополнительно исполняет `LOG3` и `calculate_tx_index_impl`, **но не тарифицирует ни то, ни другое** — см. «Находки», F-1. | Подтверждено кодом (цепочка до `evm` rev) |
| R3. `calculateTxIndex` после verify? | Технически не зависит от `verify`: чистая функция, состояния не читает; reference-контракт вызывает её раньше. Корректная трактовка Discord — правило безопасности: *вычислить* индекс можно до verify, *доверять* ему — только после. | Подтверждено кодом |
| R4. `encodedTx` — сырой RLP? | Не RLP, кастомная ABI-кодировка (tx+receipt). **Да, канонический хеш детерминированно реконструируем** из доказанных полей: legacy — `keccak256(rlp(tx))`, typed — `keccak256(type_byte ‖ rlp(payload))`. Готовой реализации в проверенных репозиториях нет. | Кодировка — подтверждена; реконструируемость — вывод из состава полей |
| R5. Continuity proof и батчи | Один пруф покрывает последовательный диапазон блоков одной `chain_key`; батч — до 10 разных высот за вызов. Лимиты прекомпайла: `MAX_CONTINUITY_ROOTS = 50_000`, `MaxBatchSize = 10`, payload 10 MiB. Лимит паллеты — **`max(max_catchup, attestation_interval)`**, не произведение. | Подтверждено кодом |
| R6. Высота/время источника | Доступны source height и **Attestcoin continuity digest**. Прямого getter'а для source header hash нет (`header_hash` подписан, но наружу не отдаётся), source timestamp — не найден. | Подтверждено кодом |
| R7. `chainKey` и реестр | Автоинкрементный `u64` (`GENESIS_CHAIN_KEY = 1`), не хеш. Реестр — `SupportedChains: StorageMap<ChainKey, SupportedChain>`. Из контракта — `ChainInfo`. Адреса — `runtime/src/precompiles.rs`. Актуальный live-состав реестра Testnet по коду не проверяется. | Механизм — подтверждён; live-состав — не проверялся |
| R8. Исходящие сообщения | Не найдено ни одной поверхности (проверено по полной карте пакетов, а не grep'ом). Документация описывает Writability (Outbox → подписи → relayer → Inbox) и помечает как ещё не выпущенную. | Ограниченный отрицательный результат |
| R9. Газ | `CONTINUITY_BLOCK_HASH_COST = 48`, `GAS_STORAGE_LOOKUP = 2_600`, `CALCULATE_TX_INDEX_BASE_COST = 10`, `CALCULATE_TX_INDEX_ITERATION_COST = 18`. Это **не полная стоимость вызова** (нет calldata, event log, db-read). | Подтверждено кодом |

---

## R1. Что криптографически коммитится в пруфе

**Ответ:** `block-prover` НЕ проверяет включение в Ethereum `transactionsRoot`/`receiptsRoot` (MPT/RLP). On-chain проверяется включение в **собственное** бинарное keccak256-дерево поверх листьев, где лист — ABI-кодированный (не RLP) блок «поля транзакции + поля receipt».

Лист — с префиксом `0x00`:
```rust
// common/merkle/src/keccak.rs:6-13
pub fn hash_leaf(input: &[u8]) -> H256 {
    let mut prefixed = sp_std::vec![crate::LEAF_HASH_PREPEND_VALUE; input.len() + 1];
    prefixed[1..].copy_from_slice(input);
    sp_io::hashing::keccak_256(&prefixed).into()
}
```
Дерево — кастомное, padding нулевым хешем (`common/merkle/src/keccak_merkle_tree.rs:34-35`, `PAD_HASH: H256 = H256([0; 32])`).

Содержимое листа (`common/eth/src/lib.rs:172-178`) — вызов `usc_abi_encoding::abi::abi_encode(tx, rx, encoding)`.

`status` и логи входят в закодированные байты (`usc-abi-encoding-0.5.0/src/abi/v1.rs:32-59`):
```rust
DynSolValue::Uint(U256::from(rx.status()), 8),   // status
DynSolValue::Uint(U256::from(rx.gas_used), 64),  // gas_used  <-- см. предупреждение ниже
DynSolValue::Array(rx.inner.logs().iter().map(|log| { /* address, topics[], data */ }) ...),
DynSolValue::Bytes(log_blooms),
```
Отдельного Merkle/Patricia-пруфа по логам нет — логи это просто поля уже промерклленного листа. Прекомпайл `status` **не проверяет**; это обязанность контракта-потребителя (подтверждается и документацией сайта).

### Важно: что именно доказывают root-проверки (исправлено в ревизии 2)

Сверка с Ethereum-корнями выполняется **только offchain**, при сборке блока аттестором, и её гарантии уже́, чем формулировалось в ревизии 1:

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

Четыре ограничения, каждое подтверждено кодом:

1. **Проверяется согласованность, а не каноничность.** Сверка идёт с `block.header`, полученным по тому же RPC. Она защищает от рассогласования `eth_getBlockByNumber` / `eth_getBlockReceipts` (в т.ч. при реорге), но не доказывает, что сам header канонический. За каноничность отвечает консенсус аттесторов, а не эта проверка.

2. **Пустые блоки — обе проверки пропускаются целиком** (`common/eth/src/lib.rs:229-241`):
```rust
if block.transactions.is_empty() && receipts.is_empty() {
    trace!(block_number = expected_number, "Skipping header root check for empty block");
    return Ok(Self { chain_id, number: expected_number, hash, items: vec![] });
}
```

3. **Pre-Byzantium Ethereum mainnet — receipt root не проверяется** (`common/eth/src/lib.rs:270-278`), константы `ETHEREUM_MAINNET_CHAIN_ID = 1` (`lib.rs:200`), `ETHEREUM_BYZANTIUM_BLOCK = 4_370_000` (`lib.rs:206`).

4. **Покрыт только `inner`.** Root-проверки берут `t.inner` и `r...inner`, тогда как в ABI-лист попадают два поля RPC-обёртки, которых нет в подписанном envelope / каноническом receipt:
   - `tx.from` — `usc-abi-encoding-0.5.0/src/abi/v1.rs:24`, `DynSolValue::Address(tx.from)`. Все прочие tx-поля идут через `tx.<method>()` / `signed_tx.tx()`, т.е. из `inner`; `from` — единственное взятое напрямую из обёртки.
   - `receipt.gas_used` — `v1.rs:36`. Канонический receipt root коммитит `cumulativeGasUsed`, а не per-tx `gasUsed`.

   Оба поля защищены кастомным Merkle-корнем и подписью аттесторов, но **называть их «доказанными Ethereum-корнями» некорректно**. Практические следствия для потребителя: `from` следует восстанавливать через recovery подписи (все компоненты `v`/`r`/`s` или `yParity`/`r`/`s` в листе есть), а `gasUsed` без отдельного вывода из канонических receipts принимать как attestor-assured, не как Ethereum-proven.

### `header_hash`: подписан, но не связан с continuity proof (уточнено в ревизии 2)

`header_hash` **входит** в подписываемые байты (`primitives/attestor/src/lib.rs:300-321`):
```rust
pub fn serialize(&self) -> Vec<u8> {
    ...
    bytes.extend_from_slice(self.header_hash.as_ref());   // header_hash подписывается
    bytes.extend_from_slice(self.root.as_bytes());
    ...
}
```
но **не входит** в continuity digest (`primitives/attestor/src/lib.rs:324-328`):
```rust
pub fn digest(&self) -> Digest {
    compute_digest_for(self.header_number, &self.root, self.prev_digest.as_ref())
}
```
Итог: цепочка континьюити, которую проверяет `block-prover`, связывает `(blockNumber, root, prevDigest)` и **не связывает** пруф с `header_hash`, хотя сам `header_hash` подписью покрыт. Отдельного пути «докажи, что этот root принадлежит блоку с таким-то Ethereum-хешем» прекомпайл не предоставляет.

### Роли (уточнено в ревизии 2)

Attestation подаёт и подписывает **аттестор**: `commit_attestation` требует `ensure_signed` и членства в `ActiveAttestors` (`pallets/attestation/src/lib.rs:1063-1075`):
```rust
let account = ensure_signed(origin)?;
let active_attestors = ActiveAttestors::<T>::get(chain_key).into_iter().collect::<BTreeSet<_>>();
ensure!(active_attestors.contains(&account), Error::<T>::AttestorNotActive);
```
Валидаторы Creditcoin отвечают за включение экстринсика в блок и консенсус рантайма. Формулировка ревизии 1 «подписано аттесторами/валидаторами» смешивала роли и исправлена.

---

## R2. `verify` и `verifyAndEmit`

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
Batch-перегрузки — `lib.rs:214-235` и `lib.rs:264-284`.

**Возврат:** `EvmResult<bool>` — либо `true`, либо revert с текстом (`false` не возвращается никогда), `lib.rs:330-336`.

**Событие** (`lib.rs:52-56`, `verify.rs:252-266`):
```solidity
event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);
```
`chainKey`/`height` — indexed-топики, `transactionIndex` — в data, вычисляется в момент эмита через `calculate_tx_index_impl`.

**Различие и газ (исправлено в ревизии 2).** Обе функции идут через общий `verify_impl`/`verify_batch_impl` с флагом `emit_events`. Точная формулировка:

- логика проверки и все её **ручные** `record_cost` — идентичны;
- `verifyAndEmit` дополнительно исполняет `calculate_tx_index_impl` и `log3(...).record(handle)`;
- **ни то, ни другое не тарифицируется** — фактически списанный газ совпадает.

Ревизия 1 писала «расход газа идентичен», опираясь на doc-комментарий `lib.rs:104-106`; это верно по факту, но скрывало причину. Причина разобрана как отдельная находка **F-1** ниже — с полной цепочкой до `evm` rev `a656db9`.

**Селекторы** — в коде не напечатаны (проверено grep по crate), вычислены самостоятельно:

| Функция | Selector |
|---|---|
| `verify` (single) | `0x7cc4e258` |
| `verifyAndEmit` (single) | `0x02f4d167` |
| `verify` (batch) | `0x1b5f6f88` |
| `verifyAndEmit` (batch) | `0x4da3b895` |
| `calculateTxIndex` | `0x44f85f1c` |
| topic0 `TransactionVerified` | `0x8a8df984...` |

---

## R3. `calculateTxIndex` — можно ли вызывать только после успешной верификации?

**Технически — не зависит от `verify`.** Обёртка (`lib.rs:303-324`) только заряжает газ и вызывает чистую реализацию; ни storage-чтения, ни модификатора, ни `require`, привязывающих к предыдущему `verify`, нет. Реализация — битовая арифметика над `siblings`:
```rust
// precompiles/block-prover/src/verify.rs:122-156
for (bit_position, sibling) in merkle_proof.siblings.iter().enumerate() {
    if sibling.is_left { tx_index |= 1u64 << bit_position; }
}
```
Юнит-тест вызывает её с произвольным, никогда не верифицированным `root` (`tests_view.rs:474-491`). Reference-контракт Creditcoin вызывает её **до** верификации, чтобы получить `queryId` для дедупликации (`usc-testnet-bridge-examples/contracts/sol/USCBase.sol:20-46`).

**Корректная трактовка (уточнено в ревизии 2).** Формулировка ревизии 1 «утверждение Discord опровергнуто» — слишком сильная. Правильное прочтение: это правило безопасности, а не техническое ограничение. Индекс **вычислить** можно когда угодно — функция чистая и на непроверенных данных вернёт «индекс» от произвольного пруфа; **доверять** ему как позиции транзакции в реальном блоке источника можно только после успешного `verify` для того же `merkle_proof`. Использование до verify допустимо ровно в той роли, в какой его применяет сама Creditcoin: как детерминированный ключ дедупликации, не как факт о состоянии внешней сети.

---

## R4. `encodedTx` — сырой RLP или собственная кодировка?

**Не сырой RLP.** ABI-кодировка (`alloy::dyn_abi::DynSolValue`), объединяющая tx- и receipt-поля; `EncodingVersion::V1`, крейт `usc-abi-encoding` 0.5.0.

Состав (`v1.rs:15-247`): `type_id: uint8` (0-4); общие поля `nonce`, `gasLimit`, `from`, `isToNull`, `to`, `value`, `input`; по типам — `gasPrice` либо `chainId`+`maxPriorityFeePerGas`+`maxFeePerGas`, `accessList`, подпись (`v`/`r`/`s` для legacy, `yParity`/`r`/`s` для typed), для type 3 — `maxFeePerBlobGas`+`blobVersionedHashes`, для type 4 — `authorizationList`; затем receipt-поля.

**Можно ли получить канонический хеш транзакции? Да (уточнено в ревизии 2).**

Прямой ответ: доказанных ABI-полей **достаточно** для детерминированного восстановления подписанного transaction envelope и, следовательно, канонического хеша:
- legacy (type 0): `keccak256(rlp(tx))`;
- typed (type 1-4): `keccak256(type_byte ‖ rlp(payload))`.

Поле `from` для этого не нужно — оно не входит в подписываемый конверт и присутствует в блобе избыточно (что и делает его непокрытым Ethereum-корнями, см. R1).

**Готовой реализации в проверенных репозиториях нет.** Более того, разработчики явно фиксируют, что настоящий хеш берётся из RPC, а не считается из ABI-байт:
```rust
// proof-gen-api-server/src/services/continuity_service/helpers.rs:321-323
// The real transaction hash comes from the block fetch above (RLP-derived, not computed
// from the ABI-encoded bytes).
let tx_hash_opt = fetched_tx_hash;
```
`grep -rniI "rlp\b" --include="*.rs"` по репозиторию (без тестов) даёт только эту строку — функций RLP-энкодинга нет. Ревизия 1 подавала это как «не найдено»; корректнее: **реконструкция возможна, но реализовать её придётся самим** (в Solidity это заметная работа: RLP-энкодер + ветвление по 5 типам).

---

## R5. Continuity proof и батчи

**Структура** (`primitives/attestor/src/block.rs:212-222`):
```rust
pub struct ContinuityProof {
    pub lower_endpoint_digest: H256,
    pub roots: Vec<H256>,
}
```
Цепочка `digest_i = keccak256(blockNumber_i ‖ roots[i] ‖ digest_{i-1})`; on-chain сравнивается только финальный digest с аттестацией или чекпоинтом (`continuity.rs:152-172`).

**Разные блоки — да, в пределах одной `chain_key`.** Batch принимает массив высот и один общий пруф, обязанный покрыть `[min(heights), max(heights)]`:
```rust
// precompiles/block-prover/src/verify.rs:336-361
let last_block_number = ...start_block_number.checked_add(roots_len_minus_one)...;
if last_block_number < max_height {
    return Self::revert_with_message("Continuity chain doesn't cover maximum query height");
}
```

**Лимиты:**

1. `MAX_CONTINUITY_ROOTS: usize = 50_000` (`verify.rs:52`) — defence-in-depth для внешних вызовов.
2. `MaxBatchSize = sp_core::ConstU32<10>` (`lib.rs:86`), подтверждён тестом `tests_full_coverage.rs:1543-1584`.
3. `ConstU10MB = sp_core::ConstU32<10_485_760>` (`lib.rs:31-32`) — payload.

4. **Лимит паллеты — `max(...)`, не произведение (ИСПРАВЛЕНО в ревизии 2).**

Ревизия 1 указывала `max_catchup * attestation_interval`. Это **ошибка**: значение было взято из устаревшего комментария рядом с enum-вариантом, а не из исполняемого кода. Реальная реализация:
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
То же самое в signed extension на txpool-admission:
```rust
// pallets/attestation/src/extensions.rs:120-127
let max_roots = max_catchup.max(attestation_interval) as usize;
if attestation.continuity_proof.len() > max_roots { /* OVERSIZED_PROOF_CODE */ }
```
Doc-комментарий там же (`extensions.rs:181`) тоже говорит `max(max_catchup, attestation_interval)`. Устаревший источник ошибки — `pallets/attestation/src/lib.rs:855`: `// Continuity proof roots exceeds max_catchup * attestation_interval`. Это внутреннее расхождение комментария с кодом внесено в раздел расхождений.

Практическая разница существенна: при `max_catchup = 10`, `attestation_interval = 100` реальный лимит — 100, а не 1000.

---

## R6. Высота и время источника

**Высота — есть. Но возвращается digest, а не source block hash (ИСПРАВЛЕНО в ревизии 2).**

```rust
// precompiles/chain-info/src/lib.rs:185-192
if let Some(last_digest) = LastDigest::<Runtime>::get(chain_key) {
    handle.record_db_read::<Runtime>(last_digest.encoded_size())?;
    Ok(HeightHashResult { height: last_digest.0, hash: last_digest.1, is_attestation: true, exists: true })
}
```
Тип storage (`pallets/attestation/src/lib.rs:357-358`):
```rust
pub type LastDigest<T: Config> = StorageMap<_, Blake2_128Concat, ChainKey, (u64, Digest), OptionQuery>;
```
То есть поле `hash` в `HeightHashResult` — это **continuity digest Attestcoin**, а не Ethereum `header_hash`. Fallback-ветка возвращает `last_checkpoint.digest` — тоже digest. Название поля `hash` вводит в заблуждение; ревизия 1 на это купилась.

Корректная краткая формулировка:

> Доступны source height и Creditcoin continuity digest. Прямого getter'а для source header hash нет, для source timestamp — нет.

`header_hash` существует внутри подписанной `AttestationData` и покрыт подписью (см. R1), но наружу через `ChainInfo` не отдаётся.

Доступные методы без merkle-пруфа транзакции (`precompiles/chain-info/src/lib.rs`): `get_latest_attestation_height_and_hash` (177-206), `get_latest_checkpoint_height_and_hash` (208-228), `is_height_attested` (463-582), `get_checkpoint_for_height` (635-658), плюс `find_highest_attested_before`, `find_lowest_attested_after`, `get_attestation_bounds`, `get_attestation_height_for_digest`, `get_attestation_genesis_height`.

Оговорка: это синхронное чтение стораджа Creditcoin, доступное контракту на самой Creditcoin, а не переносимая offchain-структура доказательства.

**Timestamp — не найдено.** Подписываемая структура полей времени не содержит:
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
Где искал: `pallets/attestation/src/lib.rs`, `precompiles/chain-info/src/lib.rs`, `precompiles/block-prover/src/*.rs`, `primitives/attestor/src/*.rs`, `common/eth/src/lib.rs`. Единственные совпадения по `timestamp` — `pallet_timestamp` в тестовом mock-рантайме (`precompiles/block-prover/src/mock.rs`).

---

## R7. `chainKey` и поддерживаемые сети

Автоинкрементный счётчик, не хеш (`pallets/supported-chains/src/lib.rs:98-102`):
```rust
pub const GENESIS_CHAIN_KEY: ChainKey = 1;
pub type ChainKeyValue<T> = StorageValue<_, ChainKey, ValueQuery, ConstU64<GENESIS_CHAIN_KEY>>;
```
Назначение при `register_chain` (только `OperatorsOrigin`, `lib.rs:176-256`); реестр — `SupportedChains: StorageMap<ChainKey, SupportedChain>` и `ChainIdAndNameToUniqKey` (`lib.rs:77-96`).

**`ChainKey` ≠ `ChainId`:** первый — внутренний последовательный id Creditcoin, второй — реальный EIP-155 chain id внешней сети. Не путать.

Из контракта: `ChainInfo.get_supported_chains()` (`chain-info/src/lib.rs:122-138`), `get_chain_by_key(uint64)` (140-160).

Адреса (`runtime/src/precompiles.rs:29-46`): `0xFD1` SubstrateTransfer (4049), `0xFD2` **BlockProver** (4050), `0xFD3` **ChainInfo** (4051), `0xFD4` AttestorStash (4052), `0x13B9` Sr25519 (5049), `0x13BA` Ed25519 (5050).

**Оговорка (добавлено в ревизии 2):** всё вышеперечисленное — механизм. **Актуальный live-состав реестра на Testnet 102031 (какие сети реально зарегистрированы и с какими `chainKey`) по исходникам определить нельзя** — это runtime-состояние. Требуется запрос к ноде (`ChainInfo.get_supported_chains()` или storage query), что выходит за рамки чтения кода.

---

## R8. Направление сообщений (Creditcoin → внешняя EVM-сеть)

**Не найдено.** В ревизии 2 grep-доказательство заменено на инвентаризацию полной поверхности.

Полная карта кастомных компонентов на этом пине:

- **Паллеты** (`pallets/`): `attestation`, `randomness`, `supported-chains` — всё.
- **Прекомпайлы** (`precompiles/`): `attestor-stash`, `block-prover`, `chain-info`, `ed25519-verifier`, `sr25519-verifier`, `substrate-transfer` — всё.
- **Публичные Solidity-интерфейсы** (`precompiles/metadata/sol/`): ровно шесть файлов, по одному на прекомпайл.
- **Состав рантайма** (`runtime/src/lib.rs:1079-1118`, `construct_runtime!`): системные/консенсусные паллеты Substrate + Frontier (`Ethereum`, `EVM`, `EVMChainId`, `DynamicFee`, `BaseFee`, `HotfixSufficients`) + `Attestation`, `SupportedChains`, `Randomness`, `Operators`, `MultiBlockMigrations`.

Полный список публичных функций всех шести интерфейсов — верификация подписей, чтение аттестаций/чекпоинтов/реестра сетей, управление стейком аттестора, `transfer_substrate`. **Ни одной функции постановки сообщения в очередь на внешнюю сеть, ни Outbox, ни экспорта агрегированной подписи для потребления снаружи.**

Расширенный текстовый поиск (все tracked-файлы, все расширения, включая `outbox`, которого не было в ревизии 1):
```
git grep -rlin "outbox\|inbox\|writabil\|writable" -- .
→ checkpoint-builder/README.md   (ложное срабатывание: "output path is writable")
```
В `usc-testnet-bridge-examples` единственный «обратный» поток — offchain-воркер, подписывающий транзакции на Sepolia тем же ключом, что и на Creditcoin (`loan-flow/worker.ts:52,94,100`, `CREDITCOIN_WALLET_PRIVATE_KEY`) — доверенный оператор, не пруф.

**Документация** описывает Writability (Outbox → подписи → relayer → Inbox) и прямо помечает как не выпущенную: *"Writability is undergoing 3rd party testing and audits."*

**Вывод:** на пине `06657e9` трастлес-исходящее направление отсутствует. Отрицательный результат ограничен двумя прочитанными репозиториями — реализация может существовать в закрытых или ещё не смёрдженных ветках.

---

## R9. Газ

```rust
// precompiles/block-prover/src/verify.rs
pub const CONTINUITY_BLOCK_HASH_COST: u64 = 48;        // :30
pub const GAS_STORAGE_LOOKUP: u64 = 2_600;             // :33
pub const MAX_CONTINUITY_ROOTS: usize = 50_000;        // :52  (не газ)
pub const CALCULATE_TX_INDEX_BASE_COST: u64 = 10;      // :56
pub const CALCULATE_TX_INDEX_ITERATION_COST: u64 = 18; // :58
```
Начисление: merkle — `CONTINUITY_BLOCK_HASH_COST × siblings` (`verify.rs:75-88`); континьюити — `× roots.len()` (`continuity.rs:144-150`); storage-чтения — кратно `GAS_STORAGE_LOOKUP` (`lib.rs:345-393`, `continuity.rs:88-91`).

`ChainInfo` независимо дублирует ту же константу (`chain-info/src/lib.rs:25`) и дополнительно использует `record_db_read`. `AttestorStash` собственных `GAS_*` не объявляет — диспатчит через `RuntimeHelper::try_dispatch`, газ определяется weight-to-gas маппингом паллеты.

**Оговорка (добавлено в ревизии 2):** перечисленное — **ручные charges внутри прекомпайла, а не полная стоимость вызова**. Вне этих констант остаются: стоимость calldata на уровне транзакции (существенна при больших `encodedTx` — до 10 MiB), `record_db_read` в `ChainInfo`, стандартные накладные EVM и **нетарифицированный event log** (см. F-1). Оценивать бюджет вызова только по этим числам нельзя.

---

## Находки

### F-1. `verifyAndEmit` не тарифицирует стоимость EVM-лога

**Существо:** `verifyAndEmit` эмитит `LOG3`, но не начисляет за него газ. Цепочка проверена целиком на закреплённых ревизиях.

1. Вызов в block-prover — single (`verify.rs:252-266`) и в цикле по каждому элементу батча (`verify.rs:432-445`):
```rust
let tx_index = Self::calculate_tx_index_impl(&merkle_proof)?;
let event_data = ethabi::encode(&[Token::Uint(tx_index.into())]);
log3(handle.context().address, SELECTOR_LOG_TRANSACTION_VERIFIED,
     H256::from_low_u64_be(chain_key), H256::from_low_u64_be(height), event_data)
    .record(handle)?;
```
2. `LogExt::record` только сохраняет лог — `frontier_2@89b8cc6:precompiles/src/evm/logs.rs:99-107`:
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
   Показательно: `compute_cost()` существует в том же трейте — и block-prover его не вызывает.
3. `PrecompileHandle::log` → `Handler::log` — `evm@a656db9:src/executor/stack/executor.rs:1762-1764`, далее `executor.rs:1457-1465`:
```rust
fn log(&mut self, address: H160, topics: Vec<H256>, data: Vec<u8>) -> Result<(), ExitError> {
    event!(Log { address, topics: &topics, data: &data });
    self.state.log(address, topics, data);
    Ok(())
}
```
   Обращения к gasometer нет — лог просто складывается в state.
4. `record_log_costs_manual` в block-prover **отсутствует**, тогда как соседние прекомпайлы его вызывают: `attestor-stash/src/lib.rs:112,151,193` (`4,0`), `:380` (`2,0`), `substrate-transfer/src/lib.rs:52` (`3,32`).

**Величина.** Формула (`frontier_2@89b8cc6:precompiles/src/evm/costs.rs:26-52`): `G_LOG=375`, `G_LOGTOPIC=375`, `G_LOGDATA=8`. Для `log3` (3 топика, 32 байта data):

```
375 + 3×375 + 32×8 = 1 756 gas на событие
```

При батче из 10 — до **17 560 gas** недобора на вызов. Отдельно не тарифицируется и повторный проход `calculate_tx_index_impl` в emit-пути.

**Почему это важно для нас:** `verify` и `verifyAndEmit` стоят одинаково не потому, что событие бесплатно, а потому что его стоимость не начисляется. Планировать газ-бюджет по наблюдаемому расходу на этом пине рискованно: если недобор закроют (это выглядит как непреднамеренный пропуск, учитывая соседние прекомпайлы), стоимость `verifyAndEmit` вырастет на ~1.8k за событие, и заложенные лимиты газа могут перестать сходиться.

**Оговорка:** вывод построен на чтении цепочки вызовов, а не на исполнении. Дешёвая проверка на живой сети — сравнить `eth_estimateGas` для `verify` и `verifyAndEmit` на одинаковых входах: расхождение около нуля подтвердит находку, ~1756 — опровергнет.

### F-2. Комментарий у `OversizedContinuityProof` противоречит коду

`pallets/attestation/src/lib.rs:855` говорит `max_catchup * attestation_interval`, код в двух местах считает `max(...)` (см. R5). Комментарий опасен тем, что завышает предполагаемый лимит в разы — ровно на этом ошиблась ревизия 1 отчёта.

---

## Расхождения с документацией

### 1. Внутри репозитория (README / Solidity-доки vs. реализация)

- **Устаревшие имена.** `precompiles/block-prover/README.md` описывает `verifyQuery`/`verifyQueryView`/`verifyBatchQueries`/`verifyBatchQueriesView` и статус-коды (`0=Success, 1=MerkleProofInvalid...`). В коде таких имён нет: `verify`/`verifyAndEmit`, без статус-кодов (либо `true`, либо revert). README ссылается на `gluwa/creditcoin3-next` и `precompiles/native-query-verifier` — директория называется `precompiles/block-prover`.

- **Газ (уточнено в ревизии 2).** Ревизия 1 утверждала, что «ни одно» число из README не совпадает с кодом. **Это неверно:** `Storage lookup | 2,600` (`README.md:114`, `block_prover.sol:68,176`) точно совпадает с `GAS_STORAGE_LOOKUP = 2_600`. Расходятся остальные: `Base 21,000`, `Per TX byte 16`, `Per sibling 200`, `Per continuity block 400`, веса `100000`/`50000` — в коде им ничего не соответствует. Нюанс: `README.md:112` описывает 400/блок как «hash (~48) + overhead (~350)», то есть 48 фигурирует как компонент задуманной модели, из которой реализован только сам хеш.

- **`ExampleUsage.sol` не компилируется** против текущего интерфейса: использует `ContinuityProof.blocks: ContinuityBlock[]`, актуальный интерфейс — `ContinuityProof.roots: bytes32[]`.

- **Противоречие о позиции `roots[0]`.** Doc-комментарии `lib.rs:113,159` говорят «blocks[0] is at queryHeight**-1**»; реализация (`verify.rs:194,233`, `start_block_number = height`) и `.sol`-интерфейс сходятся на `queryHeight`. Для оффчейн-генератора ориентироваться на `verify.rs`.

- **README: «минимум 2 блока в цепи»** — код принимает `roots.len() >= 1` (`continuity.rs:104-109`) с особым случаем «цепь заканчивается в queryHeight» (`continuity.rs:184-190`).

- **`OversizedContinuityProof`** — см. F-2.

### 2. Код vs. docs.creditcoin.org

- **Writability.** Сайт описывает Outbox → подписи → relayer → Inbox и помечает фичу как проходящую тестирование и аудит. Противоречия с кодом нет — есть разрыв между описанным будущим и текущим пином.
- **Модель газа.** Сайт даёт формулу в CTC (`≈2.3×10⁻⁵ + 2.9×10⁻⁷ × continuity_hash_count`), качественно согласующуюся с линейностью по `roots.len()`, но без сырых констант — сверить точно нельзя, приоритет у `verify.rs`.
- **Статус транзакции.** Сайт подтверждает вывод R1: *"a dApp's attestcoin smart contract MUST check the 'status' field"* — прекомпайл сам `status` не проверяет.
- **Ссылки в README `usc-testnet-bridge-examples`** на `docs.creditcoin.org/usc/...` дают 404 — контент переехал в `/attestcoin-protocol/...`.
- **R3/R4/R6/R7** сайт либо не покрывает (chainKey, timestamp), либо описывает слишком общо. Код — единственный источник.

---

## Открытое

1. **Weight-to-gas коэффициент рантайма** — `runtime/src/lib.rs` целиком на предмет `WeightToFee`/`GasWeightMapping` не читался; нужен для перевода weight-based стоимостей `AttestorStash` в газ.
2. **Логика построения чекпоинтов** (`Checkpoints`, `CheckpointBuckets`, `CHECKPOINT_BUCKET_SIZE`) — читались только геттеры в `chain-info`, не код создания в `pallets/attestation/src/lib.rs`.
3. **Механизм агрегации подписей.** `primitives/attestor/src/bls.rs` не разбирался; в `pallets/attestation/src/` поиск `verify_aggregate`/`fast_aggregate`/`verify_signature` совпадений не дал, а `commit_attestation` работает через `ensure_signed` + членство в `ActiveAttestors`. Как именно достигается кворум и где проверяется агрегированная подпись — **не выяснено**, утверждать не берусь.
4. **Компоненты `attestor/`, `checkpoint-builder/`, `checkpoint-verifier/`, `cc3-indexer/`** — только список файлов и README.
5. **`proof-gen-api-server`** — прочитан только `continuity_service/helpers.rs`.
6. **Live-состояние Testnet 102031** — состав реестра сетей, реальные `chainKey`, текущие `max_catchup`/`attestation_interval` (от них зависит фактический лимит из R5). Требует запросов к ноде.
7. **F-1 не проверена исполнением** — нужен `eth_estimateGas` на живой сети (метод проверки описан в F-1).
8. **docs.creditcoin.org** вычитан выборочно, не целиком.

---

## Журнал изменений (ревизия 1 → ревизия 2)

| # | Что | Было | Стало |
|---|---|---|---|
| 1 | Лимит паллеты (R5) | `max_catchup * attestation_interval` | `max(max_catchup, attestation_interval)` — по `continuity.rs:97`, `extensions.rs:123` |
| 2 | Chain ID (Версия) | «102033 встречается в uscDryRunSpec*.json» | Отозвано: совпадение внутри WASM-хекса; реальный `evmChainId` DryRun = 42, таблица по всем спекам |
| 3 | Газ README (Расхождения) | «ни одно число не совпадает» | `Storage lookup 2,600` совпадает; остальные — нет |
| 4 | Root-проверки (R1) | «гарантирует, что данные из настоящего блока Ethereum» | Согласованность RPC-данных с header, не каноничность; + skip для пустых блоков и pre-Byzantium; + `tx.from`/`receipt.gas_used` вне корней |
| 5 | `header_hash` (R1) | «не входит в digest» (и только) | Не входит в digest, **но** входит в `serialize()` и покрыт подписью |
| 6 | Роли (R1) | «подписано аттесторами/валидаторами» | Подписывает и коммитит аттестор (`ensure_signed` + `ActiveAttestors`); валидаторы обеспечивают консенсус блока |
| 7 | `hash` из ChainInfo (R6) | «аттестованные высота+хэш источника» | Height + **continuity digest**; source header hash наружу не отдаётся |
| 8 | Газ verify/verifyAndEmit (R2) | «расход идентичен» (как факт) | Идентичен потому, что лог не тарифицируется → вынесено в находку F-1 |
| 9 | R4 | «реконструкция — наш инференс, не найдено» | Прямой ответ: да, реконструируем; формулы для legacy/typed; реализации в репозиториях нет |
| 10 | R3 | «утверждение Discord опровергнуто» | Смягчено: правило безопасности (вычислить можно до verify, доверять — после) |
| 11 | R8 | grep по `.rs`, без `outbox` | Полная карта паллет/прекомпайлов/интерфейсов/рантайма + расширенный git grep |
| 12 | R7, R9 | — | Добавлены оговорки: live-состав реестра не проверен; константы ≠ полная стоимость вызова |
