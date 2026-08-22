# Cr3dX — состояние работ

Файл обновляется в конце каждой сессии. Сессия без обновления считается несделанной
работой. Каждая следующая сессия начинается с чтения `docs/WORKFLOW.md`, спецификации
(`docs/cr3dx-spec-v0.4.0-final.md`) и этого файла.

---

## 2026-08-22 — проверка onboarding глазами нового разработчика

Выполнен локальный проход по публичной документации, production-контрактам и
командам проверки без ключей, RPC и state-changing действий. Подробные наблюдения
сохранены в `docs/audit/onboarding-review-2026-08-22.md`.

README получил короткий порядок знакомства с проектом, явное пояснение
исторического имени файла спецификации, подсказку для Foundry PATH и быструю
итерационную тестовую команду. В шапку спецификации добавлена датированная
post-release non-normative аннотация: реализация v0.4.8 уже выровнена коммитом
`1a308816ab3b73056718f6f174c47c10f9fb8cd3`, Phase B завершена 63/63, точный
комплект задеплоен и принят. Отдельно зафиксировано замороженное нормативное
основание Phase B: spec-коммит `cbc382b39fabd9a34b218fe6ff35699e18bdca4a` и
SHA-256 входного пакета
`c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`.
Аннотация прямо исключена из запечатанного входа и не меняет поведение;
исторический журнал v0.4.8 не переписывался.

Все пять адресов в таблице deployed contracts теперь ведут на соответствующий
EVM explorer: Sepolia Etherscan для Gateway и test fixture, Creditcoin Testnet
Blockscout для Verifier, Deals и Credit.

Локальная проверка: Node.js `v22.22.1`, npm `9.2.0`, Forge `1.7.1`;
`typecheck` чистый; TypeScript 10/10 suites; Foundry 141/141, включая 8/8
invariant/property suites и 896 000 handler calls; отдельный быстрый Foundry
прогон без stateful invariant-файла также успешен. Forge дважды предупредил, что
read-only домашний каталог не позволяет обновить глобальный signature cache;
на сборку и результаты тестов это не повлияло.

Каталог `personal/` переименован в `assets/`: отслеживаемый проектный логотип
перенесён без изменения содержимого, а назначение каталога добавлено в repository
layout README.

В follow-up editorial pass ветка безопасно синхронизирована с
`origin/main@7933abea6c3b5cb721052a4f36d9882eaf578ba3`, куда уже вошёл dashboard из
PR #5. Незавершённый README/S5/deck diff до merge был сохранён path-scoped stash;
после разрешения конфликтов README и STATUS восстановлен поверх UI merge. UI,
package scripts и его evidence приняты без изменения. Историческая запись
dashboard ниже сохраняет состояние на момент своего коммита; текущий факт merge
зафиксирован здесь.

README сокращён с 680 до 205 строк и теперь служит входом в проект: назначение,
одна схема, live result, компактная trust boundary, адреса, dashboard, локальный
quickstart, contributor path и ссылки. Credentials, state-changing S5 modes,
recovery и legacy fixture перенесены без live-запуска в
`docs/S5_LIVE_RUNBOOK.md`; измерения и история остаются в своих evidence/status
документах. Существующий `assets/Cr3dX_RWA_Deck_v1.pptx` не открывался и не
изменялся; он включён как 56 KB presentation artifact, чтобы ссылка README не
была битой.

---

## 2026-08-21 — read-only dashboard принят и закоммичен

На ветке `ui/read-only-dashboard` добавлена одна desktop-first vanilla
TypeScript/Vite страница для объяснения уже принятой системы. Порядок страницы
теперь явный: Outcome, Economic state, Timeline, Worker, Verification. Proof path,
receipt table, deployment provenance и trust boundary сохранены внутри
Verification. Contracts, worker, deployments, live evidence, audit reports и
нормативные спецификации не менялись.

Главный provenance blocker закрыт архитектурно. Accepted snapshot от
`2026-08-21` на evidence commit
`f359c54c5647841a08e4e66dec267cf4cbeb110d` является статическим содержимым
страницы; production RPC renderer не пишет ни в одно его поле. Отдельная Live RPC
observation показывает destination block, локальное время чтения и точные
различия либо `MATCH`. Последующий transport failure оставляет предыдущее
успешное наблюдение только как `STALE`, с исходными block/time; без предыдущего
успеха live panel становится `UNAVAILABLE`. Ни одно live значение не получает
метку snapshot.

Regression выполняет последовательность frozen snapshot -> отличающийся live
success -> forced RPC failure. Он запрещает production `main.ts` любые ссылки на
immutable snapshot IDs, требует сохранение старых successful block/time и состояние
`STALE`. Убитый мутант — прежний
`refreshLiveState()`, который перезаписывал snapshot-поля live значениями, а при
ошибке возвращал только подпись `Snapshot`, не возвращая frozen значения.

Первый экран проверен при реальном viewport `1440x900`, `scrollY = 0`. Все шесть
обязательных значений полностью видимы:

| Значение | Вертикальные координаты, px |
|---|---:|
| `PAID_ON_TIME` | 318–355 |
| score `500 -> 525` | 281–397 |
| limit `5,000 -> 5,250 USDC` | 562–666 |
| exposure `0 USDC` | 562–666 |
| repaid `1.1 / 1.1 USDC` | 562–666 |
| external race: worker signatures `0`, broadcasts `0` | 562–666 |

При `390x844` compact header заканчивается на `73 px`, snapshot card начинается
на `91 px`, а `PAID_ON_TIME` виден на `259–281 px`, до headline, который
начинается на `541 px`. Горизонтального overflow после удаления mobile glow нет.

Фактический read-only RPC smoke прочитал Creditcoin destination block `5348994`
и вернул `MATCH` со snapshot. Ключи, wallet API и signing path не использовались.
Timeline показывает только сохранённые интервалы `1734 s`, `720 s`, `2799 s` и
`651 s`, с явной пометкой one-run/not-SLA и без реконструкции неизвестных
attested-height transition timestamps. Trust boundary отдельно говорит, что
Attestcoin доказывает inclusion, успешный receipt и настроенное Gateway event;
сам token transfer следует из проверенного Gateway code, а credit outcome — из
этих фактов и attested source height.

Vite настроен с `base: "./"`. Production `index.html` содержит только
`./assets/...`; browser smoke успешно загрузил HTML, CSS, JS и четыре receipt rows
как из production preview `/`, так и из временного static subpath `/Cr3dX/`.

Последовательно прошли `npm run typecheck`, `npm run ui:typecheck`,
`npm run test:ui`, `npm run ui:build`; production build: HTML `18.30 kB`, CSS
`31.26 kB`, JS `264.16 kB` до gzip. Forge и solc не запускались. Визуальная
приёмка пройдена; dashboard материализован коммитом
`86e3b15fd8987324a842940b5e87880949c83dfb` на ветке
`ui/read-only-dashboard`. Push и merge не выполнялись.

## 2026-08-21 — S6 live acceptance завершена на v0.4.8

Live продолжен только после adapter-fix коммита
`d3ff6317540d6b18d91628418c8e8372d9a079ae`. Deployment не повторялся:
использованы существующий Sepolia Gateway
`0x11DD8a4c790939DEa8CED631dB27Afe54334a749` и замороженный v0.4.8 комплект
Verifier `0xED64f6157408f211dda43649129EaC1F73161093`, Deals
`0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC`, Credit
`0x4a66732cA5B7f081585693332C79e636CE9c05C8`. Нормативная S6 spec,
контракты и deployment ledger не менялись.

Старые proof bytes для сохранённого repayment source hash
`0xe90b91457786d4e89104e157c746b2d8ec8d91b9462321602c96591a6c2d72ec`
не использовались. До подписи proof был запрошен заново. Ранний preflight
сохранил не все поля, поэтому неизвестные значения ниже не восстановлены
задним числом:

| Наблюдение одного repayment | Старый preflight | Fresh preflight после fix |
|---|---:|---:|
| source/query height | 11534643 | 11534643 |
| anchor type | не записан | attestation |
| anchor height | не записан | 11534650 |
| anchor digest | не записан | `0xb13a633af4c01dd3d691dcb87e48755583e95f283e0e33988c01afd2c8b82529` |
| continuity roots | не записаны | 8 |
| encoded transaction | не записан | 2080 B |
| proof JSON | не записан | 5791 B |
| `submitAndApply` calldata | не записана | 3140 B |
| simulation | SUCCESS | SUCCESS |
| gas estimate | 282203 | 282203 |

Оценка gas не изменилась. Поскольку форма старого proof не была записана,
никакая причина изменения или неизменности через elapsed time либо
ретроспективно предполагаемую форму proof не заявляется. Proof-builder ответил
`cached: true`, но это был новый HTTP-запрос перед подписью, а не повторное
использование локально сохранённых bytes. Anchor digest и его тип сверялись
через точный `ChainInfo.get_attestation_bounds`; последний элемент массива
continuity roots не выдаётся за anchor digest.

Repayment был намеренно подан до funding после approve
`0x156d44824068be9c74682cc37a5cd76ee36c3023340bac5cce03397bc3dfd19e`
в Sepolia-блоке 11534642. Worker подписал его
`submitAndApply` exact envelope с nonce 0 и отправил ровно один раз:
`0xa626556e0798a67d77b484896d10e662763d041c2e9ead2d0c4ad112f2955657`.
Receipt `status = 1`, блок 5347503, gasUsed 260288, 8 roots, anchor attestation
11534650 с digest `0xb13a633a…2529`. После двух последующих canonical
destination blocks контролируемый restart атомарно заменил maximum-liability
reservation на actual fee `0.000130144 CTC`; evidence осталось
`VERIFIED_PENDING`, потому что сделка ещё была `CREATED`.

Funding source tx
`0x376bde8f88c3dfa9059356d63f6866dc0209a7796ec1cdc14e9fb2a5ba203abe`
в блоке 11534796 (после approve
`0xc4d94417b86c1ddf1021b9143bf65a6c6282b1643b5f331de431b37c8720c6ac`
в блоке 11534795) был принят worker после достижения attested height 11534800.
Read-only preflight: 5 roots, anchor attestation 11534800 с digest
`0x1b47b11718ad1ae4ad133a45d7555a79cedb5b8a4e82d0017dcd2e6d2ac0d263`,
proof JSON 5679 B, encoded transaction 2080 B, calldata 3108 B, simulation
SUCCESS, estimate 364799 и final limit 437759. Exact envelope nonce 1 был
отправлен один раз как
`0xc740cf0ee69401817c32a310f6e2781ab63d125f7fc2bd299338cfe5fdc822ad`;
receipt `status = 1`, блок 5347560, gasUsed 340382. Отдельный restart после
глубины +2 записал actual fee `0.000170191 CTC` и удалил envelope.

После funding production `dealView` прочитал status 2 и правильного
designated investor. Repayment `applyEvidence` имел calldata 36 B, proof/roots/
anchor `N/A`, simulation SUCCESS, estimate 315264 и final limit 378317. Exact
envelope nonce 2 был отправлен один раз как
`0xa0c24a107398af5c99cc8cfaab0ea50f4542caff45c34bc8f539afbfa55b13b6`;
receipt `status = 1`, блок 5347573, gasUsed 292348. На глубине +2 ещё один
restart атомарно записал actual fee `0.000146174 CTC`, удалил envelope и
перевёл repayment evidence в `APPLIED`.

Итог основной сделки совпал полностью: `PAID_ON_TIME`, fundedAmount 1000000,
repaidAmount/onTimeRepaid 1100000, outstanding 0, exposure/reserve 0, score
`500 -> 525`, limit и available limit `5000000000 -> 5250000000`. Funding и
repayment evidence имеют `APPLIED/NONE`. Три worker-операции израсходовали
`0.000446509 CTC`; остаток signer — `0.019553491 CTC`, что выше reserve
`0.005 CTC`, а фактический 24h расход значительно ниже budget `0.01 CTC`.

Обязательный external-submission race выполнен вторым кошельком. После core
close allowance на 1 base unit создан approve-транзакцией
`0x08a09ccf48510dbf8423ea8347a91b5febd9d7e320abd988ae8e111c8ad52831`
в блоке 11534887, затем создан surplus funding на 1 base unit, source tx
`0x98c724cf613246c821b1a36acf765dedadc88fce36b9857ea86cf57d01a7e1ea`,
блок 11534891, evidence ID
`0xb7bf02c15afd864f4274428e9be186344e0191e616bc45b25ec2fab4d709d4d5`.
Worker сначала принял task в `WAITING_ATTESTATION`, затем после attestation
выполнил read-only production preflight: 10 roots, anchor attestation 11534900
с digest `0x640da336bc360324380245375a1bfea8346d894d71b2d3f50db2acd94f1d29b4`,
proof JSON 5928 B, encoded transaction 2080 B, calldata 3204 B, simulation
SUCCESS, estimate 288151. До worker broadcast второй кошелёк отправил свежий
proof напрямую транзакцией
`0x8d859033ecaec13d7ebb188f8673673af0d13b989202997d613bee38f78840c2`:
`status = 1`, блок 5347633, gasUsed 266056, те же 10 roots и тот же anchor.

После внешней победы worker увидел полный `seen` set и без подписи перевёл task
в `SUBMITTED/APPLIED`. У race-task `submissionAttemptCount = 0`,
`applicationAttemptCount = 0`, operation history пуст, envelope отсутствует;
worker nonce остался `3/3`, global lane открыта. Surplus funding применён и
fundedAmount стал 1000001, но `PAID_ON_TIME`, repayment totals и credit state не
изменились.

Измеренные source-to-destination интервалы: repayment до его verifier submission
1734 s; funding до worker submission 720 s; repayment до окончательного
`applyEvidence` 2799 s (включает намеренное ожидание funding prerequisite);
race source event до внешнего submission 651 s. Это наблюдения одного testnet
прогона, не SLA. Межоперационные gasUsed также не являются контролируемым
сравнением одной формы proof: операции меняли разные состояния. Для каждого
mined proof-bearing вызова exact roots и anchor записаны рядом с gasUsed, без
объяснения через прошедшее время.

Полная timing-разбивка использует только сохранённые source timestamps,
fresh-preflight timestamps и worker task JSON. Точный момент, когда proof-builder
впервые достиг нужной attested height, не зафиксирован ни для одного из трёх
source events: отсутствует timestamp самого перехода высоты. Поэтому следующие
fresh-preflight строки являются первым сохранённым подтверждением, что нужная
высота уже была доступна, а не временем самого attestation:

| Timing boundary | Наблюдение |
|---|---:|
| repayment source -> первое сохранённое fresh-proof подтверждение достаточной высоты | 1669.539 s |
| это подтверждение -> mined worker submission | 64.461 s |
| repayment submission receipt -> первая worker-финализация после depth +2 | 75.646 s |
| funding source -> первое сохранённое fresh-proof подтверждение достаточной высоты | 665.107 s |
| это подтверждение -> mined worker submission | 54.893 s |
| funding submission receipt -> первая worker-финализация после depth +2 | 106.120 s |
| race source -> первое сохранённое fresh-proof подтверждение достаточной высоты | 588.271 s |
| это подтверждение -> mined external submission | 62.729 s |
| external submission -> worker semantic reconciliation | 48.458 s; depth +2 не требовалась, worker envelope не существовал |

Для раннего repayment сохранены дополнительные границы. Source event -> первое
`VERIFIED_PENDING` заняло 1810.057 s. Первое `VERIFIED_PENDING` -> применение
funding evidence заняло 900.231 s; после funding worker увидел repayment
`READY_TO_APPLY` через 73.417 s. Применение funding -> mined `applyEvidence`,
который закрыл сделку как `PAID_ON_TIME`, заняло 88.712 s. Receipt
`applyEvidence` -> сохранённое worker-состояние `APPLIED` после depth +2 заняло
53.903 s. Итого source repayment -> on-chain `PAID_ON_TIME` осталось равным
2799 s; до локально сохранённого `APPLIED` прошло 2852.903 s.

Следовательно, границы attested-height transition -> submission в строгом
смысле остались `не зафиксировано`: отсутствует левая timestamp-граница.
Зафиксированы только приведённые интервалы от первого последующего успешного
fresh preflight. Момент достижения depth +2 также не записан отдельным chain
timestamp; сохранён момент первой worker-финализации после требуемой глубины.

Один параллельный read-only RPC preflight получил transport timeout; он ничего
не подписал и не записал. Последовательный повтор с новым proof request прошёл.
Новых protocol/implementation расхождений после `d3ff631…` не обнаружено.
Deploy и push не выполнялись.

## 2026-08-21 — S6 ABI decode blocker исправлен, live остаётся остановлен

После буквального `РАЗРЕШАЮ S6 LIVE` создан отдельный testnet-only worker signer
`0x16046B2b4FaE88f3D02264EAbbD24dC04912d2Bd`. Ключ хранится только во внешнем
regular-файле `0600` внутри каталога `0700`; checkout-local `.env` worker не
использует. Signer пополнен на `0.02 CTC` транзакцией
`0xf81d2ab073d69e2b6de67aeb2ec1d3c821b13d68e5514e1a90ae9a1b84b846ef`
в блоке 5347363. Bootstrap записал nonce 0, lane открыт, envelopes и фактические
worker-комиссии отсутствуют.

Для live-сценария borrower создал сделку
`0x5cf1f030363c28c3fa1862759ccc63b338d0a57fd682d9a6965a61acf93706fc`
транзакцией
`0xefd4dc75cacbffd1c232e595c50b7cc910cdcc4466818c2b9f935ac8b65169e8`:
designated investor A, required funding `1_000_000`, face value `1_100_000`,
due source block 11535634. Обычный enrollment эффективен с Sepolia-блока
11534638. Погашение намеренно отправлено до финансирования транзакцией
`0xe90b91457786d4e89104e157c746b2d8ec8d91b9462321602c96591a6c2d72ec`
в блоке 11534643; его evidence ID —
`0x65f1d8a980b49ec20510b047473785ebcfd6648c0d4cfafd3857241b9c8df213`.
Attestcoin достиг 11534650 за 501 секунду, proof построен свежим и
`submitAndApply` успешно прошёл `eth_call`.

Полный preflight перед первой worker-подписью показал signer nonce `0/0`, баланс
`0.02 CTC`, runtime intervals `10/10`, пустые queue/reservation/rolling fees и
открытую lane. Оценка intended `submitAndApply`: 282 203 gas, финальный gas limit
338 644, maximum liability `0.000338644 CTC` при cap 1 gwei; все policy caps
соблюдены.

Preflight выявил достижимый implementation blocker в `WorkerChain.dealView()`.
Непосредственная причина: ethers v6 возвращает единственный tuple `getDeal` уже
развёрнутым, поэтому `result[0]` является borrower address. Код ошибочно делал
`result[0] ?? result`, принимал строку адреса за tuple и читал её символы
`"7"`/`"3"` как status/investor; `getAddress("3")` падал. Системная причина:
engine tests использовали `FakeChain.dealView()` и обходили production adapter,
а прежние `worker/chain.test.ts` проверяли gateway-log decoding и signing surface,
но не фактическую ethers-v6 форму contract returns.

После отдельного `РАЗРЕШАЮ S6 ABI FIX` лишний unwrap удалён. Regression строит
ABI-encoded `getDeal` result, пропускает его через настоящий ethers `Contract` и
вызывает production `WorkerChain.dealView()`. Он проверяет точные status и
designated investor и падает на прежнем мутанте с тем же `invalid address`.

Все остальные structured reads `WorkerChain` проверены на форму ответа. Второго
unwrap/indexing defect не найдено: `evidenceStateOf` возвращает два отдельных
значения и правильно индексируется; gateway log `Result`, raw receipt/log arrays,
proof-builder JSON, fee/receipt/block objects и набор deployment getters читаются
согласно своим фактическим API shapes. Аудит нашёл отдельный fail-closed дефект в
Substrate SCALE read: `decodeScaleU64("0x")` возвращает `null`, но прежний
`Number(null)` превращал malformed response в допустимый interval 0. Проверка
`null` теперь предшествует числовому преобразованию; regression вызывает
production `runtimeIntervals()` через JSON-RPC fetch и убивает прежний coercion.

Известное отклонение покрытия остаётся: прямых adapter-level тестов пока нет для
raw `eth_getTransactionReceipt`, ethers Log/Receipt/Block/FeeData,
proof-builder JSON, положительной формы Substrate runtime response и
агрегированного deployment readback. Engine safety для них проверяется через
FakeChain, но это не проверка границы библиотек.

После обоих adapter fixes последовательно выполнены только разрешённые проверки:
`npm run test:worker` — 6/6 test-файлов, `npm run typecheck` — чисто,
`git diff --check` — чисто. Forge и solc не запускались.

Live остаётся остановлен до отдельного разрешения на возобновление. Worker ничего
не подписывал и не отправлял: signer nonce остаётся 0, evidence `UNSEEN`, deal
остаётся `CREATED`, exact envelope отсутствует. Исходную repayment-транзакцию
повторять нельзя; тот же сохранённый enrollment и source hash достаточны для
безопасного продолжения.

## 2026-08-21 — fresh v0.4.8 deployment для S6 подтверждён

После буквального `РАЗРЕШАЮ S6 DEPLOY V0.4.8` на Creditcoin3 Testnet 102031
последовательно развёрнуты свежие контракты из текущих v0.4.8 артефактов:

| Контракт | Адрес | Транзакция | Блок |
|---|---|---|---:|
| `Cr3dXVerifier` | `0xED64f6157408f211dda43649129EaC1F73161093` | `0xb37784b964bfb1cc7e4fd90f25dcb014a61415641c595fb83e8db7cdbbe4d37b` | 5347321 |
| `Cr3dXDeals` | `0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC` | `0xbbf95613e9f4152f49e4462cdfebdf3655e696bc3ae16114822665617bf891db` | 5347325 |
| `Cr3dXCredit` | `0x4a66732cA5B7f081585693332C79e636CE9c05C8` | создан внутри транзакции `Cr3dXDeals` | 5347325 |

Обе deployment-квитанции имеют `status = 1`. Creation calldata в обеих
транзакциях побайтно совпадает с локальными артефактами и аргументами, а runtime
`Verifier`, `Deals` и `Credit` совпадает после маскирования immutable-областей.
Wiring прочитан обратно с chain: verifier доверяет Sepolia gateway
`0x11DD8a4c790939DEa8CED631dB27Afe54334a749` и `chainKey = 1`; Deals указывает на
новый verifier и новый Credit; Credit указывает обратно на новый Deals.

Состояние свежее: `dealCount = 0`, для проверенных адресов score 500, limit и
available limit `5_000_000_000`, reserve и exposure равны нулю. Два deployment
израсходовали 3 938 214 gas и `0.001969107 CTC`; остаток deployer после включения
обоих блоков — `9999.9789024945 CTC`. Старые адреса сохранены в массивах
`previousVerifiers` и `previousDeals` с причинами замены.

Существующий Sepolia Gateway не передеплоен и не изменён: read-only проверка
подтвердила прежний deployment receipt, точное creation calldata, token
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` и event nonce 25.

Это закрывает deployment provenance gate, но не разрешает работу worker. Отдельный
worker signer пока не настроен и его CTC-баланс не установлен; deployer молча не
переиспользуется. Push, worker bootstrap, proof submission и иные продуктовые
транзакции не выполнялись. Следующий state-changing gate остаётся буквальным
`РАЗРЕШАЮ S6 LIVE` после создания и пополнения выделенного worker signer.

## 2026-08-21 — S6 worker реализован локально, live gate не открыт

Единственный нормативный вход реализации — document-only коммит
`8759a1649b489e0d7d0a163471063d908813b589`; SHA-256
`docs/S6_WORKER_SPEC.md` равен
`901628b5c8dbaab23fd09e6fa0b8a0b5ed6df5b05d65ba484df87911798289fc`.
Нормативный файл и контракты реализация не меняет.

Добавлен permissionless TypeScript worker:

- полный canonical-receipt admission с whole-transaction enrollment,
  `effectiveFromSourceBlock`, лимитами очереди/событий и сохранением cursor;
- отдельные inclusion, contract и automation state, append-only история reorg;
- атомарные JSON-файлы `0600`, каталоги `0700`, schema version 1 и fail-closed
  политика будущих миграций;
- глобальная nonce lane и сохранение exact signed envelope до первого broadcast;
- независимые semantic reconciliation и двухблочное разрешение exact receipt;
- максимальная ответственность по комиссии резервируется вместе с envelope и
  заменяется фактической комиссией подтверждённой квитанции;
- отдельные submission/application epochs, повтор pending repayment после
  изменения prerequisites и операторские `resume`/`resume-broadcast`;
- kernel `flock` и секретные режимы `file|manager`; checkout-local `.env` и
  `wallets:create` S6 не использует;
- CLI для bootstrap, enrollment, queue/status/attention, single-step/run,
  адресного advance и recovery.

Архитектура записана в `docs/S6_WORKER_ARCHITECTURE.md`, эксплуатация и recovery —
в `docs/S6_WORKER_RUNBOOK.md`, соответствие 46 обязательствам — в
`docs/S6_WORKER_TEST_MATRIX.md`.

Итоговый baseline выполнен последовательно, без параллельных компиляторов и
тестовых процессов:

- `npm run typecheck` — чисто;
- `npm run test:scripts` — 9/9 файловых suites, в том числе все 38 worker test
  cases и прежние script tests;
- `forge build` — чисто, предупреждений компилятора нет;
- non-invariant Foundry — 133/133;
- отдельный полный invariant baseline — 8/8: семь stateful invariants по
  256 campaigns × 500 calls, суммарно 896 000 handler calls, плюс fuzz-свойство;
- `git diff --check` и guards неизменности нормативной спеки/контрактов — чисто.

Live RPC, транзакции, deploy и push в implementation-коммите не выполнялись.
Позднейший fresh v0.4.8 deployment записан отдельным разделом выше. До отдельного
`РАЗРЕШАЮ S6 LIVE` worker не запускается против live сетей.

---

## 2026-08-20 — Phase B: независимая проверка v0.4.8 завершена

Спецификация v0.4.8 выпущена коммитом
`cbc382b39fabd9a34b218fe6ff35699e18bdca4a`; реализация приведена в соответствие
коммитом `1a308816ab3b73056718f6f174c47c10f9fb8cd3`. Phase B завершена
2026-08-20: независимая модель и реализация совпали на полном заранее
запечатанном корпусе из 63 трасс, 63/63, в том числе 16/16 независимо выведенных
и 47/47 предписанных спецификацией; семантических расхождений нет.

47 предписанных трасс являются более слабым независимым свидетельством, потому
что одна и та же спецификация задавала их обеим сторонам. Подробности, методика и
хеши сохранены в [verification checkpoint](verification/v0.4.8-phase-b/README.md)
и [финальном отчёте Phase B](verification/v0.4.8-phase-b/phase-b1/specification/PHASE-B-FINAL-REPORT.md).
Это результат на полном заранее запечатанном корпусе, а не формальное
доказательство всего поведения. S6 разблокирован, но не начат.

---

## 2026-08-20 — независимая рецензия, спецификация v0.4.8

Вторая независимая рецензия прочитала спецификацию без реализации и нашла пять
содержательных дефектов и блок недоопределённой семантики. Выпущена document-only
редакция v0.4.8; код, тесты и deployment-артефакты не менялись. Приведение
реализации и независимое обновление модели выполняются следующими этапами по
`docs/WORKFLOW.md`.

### Изменённая целевая семантика

- `DEFAULTED` сохраняется канонической функцией до полного погашения; отдельного
  флага нет, а пересчёт только по доказательствам не восстанавливает факт дефолта;
- `closedAtBlock` заморожен при неизменном итоге и исключён из экономического
  состояния;
- новые доказательства одного `submitAndApply*` применяются в две фазы — все
  фандинги, затем все погашения, — в детерминированном порядке идентификаторов;
- INV-19 проверяет классификацию в момент решения, а не непрерывное состояние
  хранилища;
- INV-3 и INV-20 ссылаются на единое определение экономического состояния; состояние
  доказательств и `closedAtBlock` в него не входят;
- закрыты именованные ошибки, атомарность дубликата в батче, просроченное создание,
  источник `DEFAULTED` и порядок внутри батча.

### Проверенная граница соответствия

- сохранение `DEFAULTED` после частичного погашения уже есть в текущем коде;
- `closedAtBlock` уже не меняется при записи того же итога;
- двухфазного применения нет: текущий код применяет возвращённые идентификаторы
  одним проходом в исходном порядке;
- соответствие остальных требований v0.4.8 полностью не проверялось и не
  предполагается заранее.

### Два ответа Creditcoin Team

Discord, `#buidl-ctc-qna`, 2026-08-20, автор `dL^ | Creditcoin`, Creditcoin Team.
Полные вопросы, ответы и границы авторитетности записаны в
`docs/ATTESTCOIN_INTEGRATION.md`.

В 8:01 команда ответила, что checkpoints остаются навсегда, а криптографические
данные ранее доказанной через attestation транзакции сохраняются в archive node.
Первое записано как текущая политика хранения рантайма, второе — как зависимая от
операторов инфраструктурная политика; ни одно не названо неизменяемой гарантией
протокола. Фраза про off-chain caching не ослабляет запрет переиспользования старого
continuity proof.

В 8:05 команда предварительно ответила, что `verifyAndEmit`, вероятно, должен
тарифицировать лог и gas accounting может вырасти примерно на стоимость `LOG3`.
Наблюдаемая разница 0 сохранена как измерение текущей сети; окончательный ответ
ожидается. Cr3dX использует `verify`, поэтому логика контрактов от вопроса не
зависит.

### Результат независимой проверки

Не найдено пути двойного использования кредитного лимита, уничтожения уже
доказанного внешнего факта, привилегированного изменения состояния или другой
зависимости экономического результата от порядка, кроме исправленных случаев.
Горизонт доказуемости не входил в фактически проверенное рецензентом: он был открыт
в его входном документе и закрыт отдельным внешним ответом.

---

## 2026-08-20 — ответ команды Creditcoin по удержанию аттестаций, спецификация v0.4.7

**Историческая пометка v0.4.8:** раздел фиксирует состояние знаний на момент v0.4.7.
Follow-up о горизонте был отвечен позже 2026-08-20; действующий разбор находится в
верхнем разделе v0.4.8 и `docs/ATTESTCOIN_INTEGRATION.md`. Исходная запись ниже не
переписывается задним числом.

Команда Creditcoin ответила на наш вопрос о конфигурации аттестации (Discord,
2026-08-20). Ответ стал первоисточником вместо нашей бисекции; измерение оставлено
как подтверждение. Правки документные, поведение контрактов не менялось.

### Конфигурация

| Параметр | Testnet поверх Sepolia | Основная сеть поверх Ethereum |
|---|---|---|
| Интервал аттестации | каждые 10 блоков источника | так же |
| Интервал чекпоинта | каждые 10 аттестаций, то есть 100 блоков | так же |
| Удержание аттестаций | 10 | так же |

Параметры рантаймовые и доступны через паллету конфигурации, то есть могут
измениться без изменения ABI и без уведомления. Записаны с этой оговоркой: «чекпоинт
каждые 100 блоков» нигде не подаётся как вечное свойство протокола. Интервал
аттестации и интервал чекпоинта probe и так читает живыми через `state_call`.

### Наше измерение сошлось точно, но не так, как выглядело на первый взгляд

Разложение «140 = 40 блоков отставания аттестации + 100 блоков удержания» не сходится
с тем, что записано в измерении: бисекция считалась от **аттестованной** вершины
(11521850), а не от вершины Sepolia, поэтому отставание из этой цифры уже вычтено
и прибавлять его нельзя — это двойной счёт.

Остаток в 40 блоков объясняется иначе и объясняется точно. Удержание десяти
аттестаций применяется, судя по данным, при нарезке чекпоинта, а не непрерывно:
последний чекпоинт на 11521800, десять аттестаций назад от него — ровно 11521710,
что и есть наблюдавшаяся старейшая живая аттестация. Непрерывная вычистка предсказала
бы границу на 11521750–11521760, и бисекция это исключила. Пять аттестаций выше
чекпоинта (11521810–11521850) просто ещё не вычищены.

Два следствия. Во-первых, 140 — не константа: окно от аттестованной вершины дышит
примерно от 100 блоков сразу после чекпоинта до примерно 190 перед следующим,
и 140 было одной выборкой из этого диапазона. Во-вторых, планировать надо по полу
диапазона — **100 блоков от аттестованной вершины**, то есть ровно двадцать минут
Sepolia. Двадцатиминутный ориентир, оказывается, не круглая догадка, а этот пол.

Привязка вычистки к нарезке чекпоинта — наш вывод из одного точного совпадения,
не утверждение команды. Пол в 100 блоков верен в любом случае: непрерывная вычистка
дала бы плоские 90–100.

Из этих же данных следует, что 10 в «attestation retention» считает аттестации,
а не чекпоинты: десять чекпоинтов дали бы тысячу блоков живых аттестаций, а их
не было уже на полутора сотнях. Единицу у команды всё же запросили — от неё зависит
весь расчёт окна.

### Механизм деградации, со слов команды

Генератор пруфов сам привязывается к лучшему доступному якорю в момент запроса.
Пруф, привязанный к обычной аттестации, со временем перестаёт работать и требует
корней до чекпоинта — это другой пруф, а не починенный. За свежим пруфом надо просто
обратиться к API заново. Это подтверждает механизм, выведенный ранее из отказавших
фикстур.

### Горизонт доказуемости остался открытым

Команда объяснила переход на чекпоинт, но не сказала, что чекпоинты хранятся
неограниченно. Follow-up отправлен, ответа пока нет. До ответа формулировки
осторожные: проверено окно около часа, утверждений о вечной доказуемости нет ни
в спецификации, ни в интеграционных заметках. Прежние формулировки «факт остаётся
доказуемым бессрочно» исправлены в обоих документах, риск занесён в модель угроз
как открытый. Если хранение чекпоинтов окажется ограниченным, это перестаёт быть
вопросом цены и становится вопросом корректности: у доказательства появляется
реальный срок. Опасен при этом не сам срок, а наша стратегия повторов — отдельная
строка в модели угроз и правило 26.

### Следствие для S6

Зафиксировано в спецификации, раздел 7 и правила 24–26:

- воркер запрашивает пруф заново перед каждой подачей и перед каждым повтором;
- сохранённые байты continuity-пруфа не переиспользуются никогда — ни между
  повторами, ни после перезапуска, ни из фикстуры;
- долговечное состояние задачи — хеш транзакции источника и метаданные события,
  но не сгенерированный пруф;
- у повторов есть потолок по прошедшему времени, а не только по числу попыток,
  задержка кламплена сверху, при достижении потолка задача уходит в ручную подачу
  с явным сообщением. Причина в открытом горизонте доказуемости: экспоненциальная
  задержка делает число попыток плохой мерой времени, и терпеливый воркер может
  молча пережить точку невозврата, если срок у чекпоинтов всё-таки есть. Опасен
  здесь не протокол, а наша стратегия повторов;
- параметры аттестации воркер читает из сети на старте, а не зашивает константами:
  `AttestorApi_chain_attestation_interval` и
  `AttestorApi_attestation_checkpoint_interval` через `state_call`, помощники уже
  есть в `scripts/lib/rpc.ts`. Значения идут в лог, расхождение с записанными
  предположениями даёт предупреждение. Ни одно решение о корректности от них не
  зависит, поэтому недоступность вызовов старт не блокирует. Удержание аттестаций
  известного нам аксессора не имеет и при необходимости наблюдается через
  `get_attestation_bounds`.

Двадцатиминутный ориентир получил механизм, а не только цену: подаёшь быстро — якорем
становится недавняя аттестация и пруф короче; опоздал — генератор перепривязывается
к чекпоинту, пруф длиннее и подача дороже примерно на 34 000 газа. На корректность
это не влияет.

### Изменённые файлы

`docs/ATTESTCOIN_INTEGRATION.md` (новый раздел с ответом команды, исправлены три
места с утверждением о бессрочной доказуемости), `docs/cr3dx-spec-v0.4.0-final.md`
(v0.4.7: раздел 2, раздел 6, раздел 7, правила 24–26), этот файл.

### Незакрытое

Дата ответа команды проставлена как 2026-08-20 во всех трёх файлах. Если ответ
пришёл раньше, правка в трёх местах. Follow-up про хранение чекпоинтов и про
единицу в «attestation retention» отправлен, ответа нет.

---

## 2026-08-20 — S5: сквозной сценарий реализован и принят на живых сетях

Четыре переносимых документных коммита (`230d121`, `1d7e5d7`, `e0d10c7`,
`33c961d`) опубликованы в `origin/main`. Работа S5 ведётся в ветке
`s5/live-end-to-end`; S6 не начат.

### Безопасность TLS

`NODE_TLS_REJECT_UNAUTHORIZED=0` не найден ни в репозитории, ни в пользовательских
shell-файлах, ни в `/etc/environment` или systemd user environment. Он уже есть в
`/proc/1/environ`; PID 1 текущего рабочего окружения — `bwrap`. Значит переменную
вставляет внешний launcher sandbox до запуска shell, и удалить её навсегда изнутри
репозитория или дочернего процесса невозможно.

Зависимости переустановлены с включённой проверкой сертификатов командой
`env -u NODE_TLS_REJECT_UNAUTHORIZED npm ci`: 67 пакетов, 0 известных уязвимостей.
Все сетевые TypeScript-команды теперь аварийно отказываются работать, если видят
значение `0`; для управляемого извне shell README показывает явный безопасный
префикс `env -u NODE_TLS_REJECT_UNAUTHORIZED`.

### Реализованный сценарий

`scripts/deal-live.ts` теперь имеет две разные семантики:

- `npm run s5:fresh` перед первой сделкой разворачивает новый `Cr3dXDeals` и
  создаваемый им `Cr3dXCredit` поверх неизменных gateway/verifier, проверяет скор
  500, нулевые reserve/exposure и пустую историю, затем выполняет два полных
  прогона без вмешательства;
- `npm run s5:continue` использует накопленное состояние записанного реестра и
  делает ещё один прогон.

До первой транзакции общий preflight читает живые балансы и кредитное состояние.
Он считает `floor(B balance / 0.1 USDC)` и
`floor(availableLimit / 1.1 USDC)`, печатает score/reserve/exposure/limit и не
разрешает двухпрогонный запуск при B ниже 0.2 USDC либо недостаточном резерве.

Каждый прогон создаёт основную сделку, делает реальные A → B funding и B → A
repayment в Sepolia, ждёт proof builder с видимым прогрессом, строит proof заново
непосредственно перед каждым `submitAndApply`, проверяет `FINANCED`,
`PAID_ON_TIME`, освобождение экспозиции и согласованность скора, затем создаёт
вторую сделку и оставляет её в `CREATED`. Отрицательный живой факт B → B сохранён
и обязан получить `REJECTED_PERMANENT / WRONG_INVESTOR`.

После каждого шага печатаются статус, `fundedAmount`, `repaidAmount`,
`onTimeRepaid`, outstanding, reserve, exposure, score, limit и available limit.
Отчёт раздельно суммирует Sepolia gas/test ETH и Creditcoin gas/test CTC, длительность
обоих ожиданий, каждого прогона и всей команды. Успешная команда пишет полный
console log и JSON в `data/live/s5-<mode>-<timestamp>.{log,json}`.

### Локальная проверка

- `npm run typecheck`: чисто;
- `npm run test:scripts`: 25 именованных правил, все прошли (добавлены три правила
  CLI, двухпрогонного USDC и обеих формул ёмкости);
- `forge build`: успешно, прежнее косметическое предупреждение
  `test/GateLog.t.sol:63` про `view` остаётся;
- `forge test`: 132 passed, 0 failed, включая 8 stateful/property тестов; каждый
  из семи инвариантов сделал 256 прогонов и 128 000 вызовов без revert/discard.

### Живая приёмка fresh

Игнорируемый `.env` найден с обоими прежними testnet-only ключами; ни ключи, ни их
значения в вывод не попадали. `env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:fresh`
одной командой развернул новый реестр и кредитный слой, подтвердил начальные score
500, reserve/exposure 0 и пустую историю, затем выполнил два полных прогона без
ручного вмешательства.

| Поле | Значение |
|---|---|
| `Cr3dXDeals` | `0x80a9AE89DaD31A5AB5b3a6374F8159544ba59485` |
| `Cr3dXCredit` | `0x13AEC440a6cA605974Af15a9ef5B77EBC1442480` |
| deployment tx / block | `0xd5ed5e5b…bfdf` / `5340937` |
| run 1 | `PAID_ON_TIME`, score `500 → 525`, limit `5000 → 5250 USDC` |
| run 2 | `PAID_ON_TIME`, score `525 → 550`, limit `5250 → 5500 USDC` |
| итог | exposure `0`, reserve `2.2 USDC`; обе подделки `WRONG_INVESTOR` |

Времена ожидания funding/repayment: `7m01s / 7m10s` для первого прогона и
`8m44s / 9m16s` для второго. Полное время команды `38m20s`; прогоны заняли
`17m12s` и `20m46s`. Sepolia: `672 978` gas и
`0.000708508217397735` test ETH. Creditcoin: `5 373 281` gas и
`0.0026866405` test CTC, включая развёртывание. Эталон:
`data/live/s5-fresh-2026-08-20T05-30-18-335Z.{json,log}`.

Старый реестр не мигрирован: он записан в `previousDeals` с причиной, а сделки и
история остались на прежнем адресе.

### Continue, восстановление после RPC timeout и окончательная приёмка

Два промежуточных обычных прогона обнаружили операционную неоднозначность:
публичный RPC мог оборвать `eth_sendRawTransaction` до возврата хеша. Первый обрыв
случился перед repayment, второй — перед созданием резервной сделки. Для явного
восстановления добавлен `s5:resume -- <dealId>`: он проверяет указанный deal и
никогда не переигрывает уже применённый funding или repayment.

Корневая причина закрыта в обычном пути: каждая транзакция теперь сначала полностью
заполняется и подписывается локально, её хеш вычисляется до первого RPC-write, а
при неоднозначном timeout повторно отправляются только те же raw bytes с тем же
nonce и хешем. Стартовые read-only вызовы и чтение состояния получили ограниченные
повторы; chain ID задаётся статически из конфигурации.

После этой правки обычный
`env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:continue` прошёл одной командой:
primary `0xd2aff908…d32e`, reserved `0x16fb6c31…a2c9`, `PAID_ON_TIME`, exposure
`0`, score `600 → 625`, limit `6000 → 6250 USDC`, итоговый reserve `5.5 USDC`.
Funding ждал `8m02s`, repayment `8m54s`, вся команда `20m08s`. Sepolia:
`336 507` gas и `0.000362021353852173` test ETH; Creditcoin: `1 340 274` gas и
`0.000670137` test CTC. Эталон окончательного обычного прогона:
`data/live/s5-continue-2026-08-20T06-42-34-699Z.{json,log}`.

### Локальный файл ключей на этой машине

Текущий checkout находится на `fuseblk` (`/dev/sda1`), который в этой конфигурации
не сохраняет POSIX mode bits: `chmod 600 .env` завершается успешно, но повторный
`stat` всё равно показывает `0777`. Поэтому прежняя формулировка README, будто
`wallets:create` гарантирует mode `0600` на любом носителе, для этой машины неверна.
`.env` остаётся git-ignored, но это не заменяет файловую изоляцию. Для реальных
секретов checkout или сам файл должен находиться на файловой системе, которая
поддерживает права Unix; используемые здесь ключи только testnet.
`wallets:create` теперь проверяет фактический mode до чтения существующего файла
или генерации новых ключей и на таком носителе отказывается работать. Отрицательная
проверка на этой машине дала ожидаемое сообщение `mode 777 after chmod 600` без
печати секрета.

### Аудит README глазами нового человека

Убраны четыре места, где раньше требовалось догадываться: какой из одноимённых
USDC нужен, где брать три тестовых актива, должен ли пользователь вручную делать
`approve`, и означает ли повторный запуск сброс состояния. README теперь приводит
адрес токена/gateway/verifier/current Deals/Credit, официальные faucet-маршруты,
имена двух ключей `.env`, автоматический approve, одну команду fresh-приёмки и
отдельную команду продолжения. Остаётся неизбежный внешний шаг — получить тестовые
активы; краны нельзя честно встроить в репозиторий.

Исторически на момент этого этапа верхний раздел той редакции дополнял вывод:
горизонт хранения checkpoint ещё не был установлен. В v0.4.8 этот вопрос закрыт
последующим ответом Creditcoin Team; запись здесь сохраняет состояние знаний S5.

S6 не начат.

---

## 2026-08-19 — v0.4.5: исправлена спецификация, поведение не менялось

Только документная редакция. Контракты, тесты, deployment-артефакты и живая сеть
не менялись.

Исправлены шесть дефектов v0.4.4:

- `applyEvidence` теперь описан по состояниям: идемпотентны только `APPLIED` и
  `REJECTED_PERMANENT`, а `VERIFIED_PENDING` перепроверяется и может перейти в
  терминальное состояние;
- INV-19 снова сформулирован общим критерием невозможности будущего применения;
  две текущие причины являются следствием, а не законом, заданным числом;
- явно записано, что `dealId` связывает единственную версию условий сделки;
- явно записано, что правильное погашение в `CREATED` не может получить постоянный
  отказ: оно либо применится после фандинга, либо продолжит ждать;
- для фандинга явно объявлен порядок `WRONG_RECIPIENT` перед `WRONG_INVESTOR`;
- статус документа приведён к реальности: v0.4.4 задеплоена и принята.

### Нарушение процесса в v0.4.4

Для v0.4.4 требовался порядок «целевая спецификация → параллельно слепая модель и
реализация → сравнение». Фактически код, тесты и живая приёмка были завершены до
окончательной редакции спецификации и вошли с ней в один коммит `7e705167`.

Слепой агент реализацию не видел, а смысловые решения были приняты до написания
кода. Поэтому независимость решений сохранилась. Но документ писался рядом с
готовой реализацией, и независимость его формулировок доказать нельзя. Отдельный
spec-only коммит от старого состояния не создаётся: он восстановил бы изоляцию
доступа только задним числом и изображал бы причинную независимость, которой уже
нет. Правильный порядок восстанавливается с v0.4.5 и действует на будущее.

### Проверка на новой машине

Toolchain восстановлен с нуля: Node.js `v22.22.1`, npm `9.2.0`, стабильный Foundry
`v1.7.1` (`4072e487`). `npm ci` установил 67 пакетов по lockfile, npm audit сообщил
0 известных уязвимостей.

Проверки текущего `main`:

- `forge test`: 132 passed, 0 failed, 0 skipped; stateful invariants — 256 прогонов
  по 128 000 вызовов, без revert и discard;
- `npm run test:scripts`: все 22 именованных `it(...)` прошли;
- `npm run typecheck`: чисто;
- `forge build`: успешно, но утверждение прежней машины «без предупреждений» на
  Foundry v1.7.1 не воспроизвелось. Solc выдал одно предупреждение только в тесте:
  `test/GateLog.t.sol:63`, `_onlyGatewayLog()` можно ограничить до `view`.

Окружение новой машины экспортирует `NODE_TLS_REJECT_UNAUTHORIZED=0`, хотя npm
`strict-ssl=true`. Поэтому npm предупредил, что TLS-проверка отключена переменной
окружения. Lockfile и его integrity-хеши применились, но причину переменной нужно
устранить до следующего скачивания зависимостей; это свойство машины, не проекта.

### Read-only сверка задеплоенного v0.4.4

Публичный Creditcoin3 Testnet RPC вернул runtime bytecode текущего `Cr3dXDeals`.
Его длина — 7165 байт. После обнуления позиций четырёх immutable-групп он побайтно
совпал с локальной сборкой; SHA-256 обеих нормализованных строк:
`bf5d00eeb494e901b2fed1abf681545053c9ff12bb25544a54f5b0103e9fa4f0`.

Read-only вызовы подтвердили:

| Поле | Значение |
|---|---|
| `Cr3dXDeals` | `0x3360E0d2ff86BDd1B3b906c1AaB62E5bD5fc967c` |
| `Cr3dXCredit` | `0x8234C87eCE3a88a7A9E2f987Ec44acc9f801529d` |
| `Cr3dXDeals.verifier()` | `0xAf07fCFe36079bD37E94f40f928EE8b088f56B47` |
| `Cr3dXDeals.chainKey()` | `1` |
| `Cr3dXDeals.attestationGracePeriod()` | `600` |
| `Cr3dXCredit.deals()` | текущий `Cr3dXDeals` |

Принятая сделка `0xecde8d9f…ceac` читается с `status = 5` (`PAID_ON_TIME`),
`designatedInvestor == investor == 0x0e4Fbc15…56C6`, `fundedAmount = 1 000 000`,
`repaidAmount = onTimeRepaid = 1 100 000`. Совпадение runtime bytecode подтверждает,
что на указанном адресе живёт именно локальная реализация, в которой фандинг
накапливается после порога, а получатель погашения сверяется с
`designatedInvestor`.

---

## 2026-08-19 — v0.4.4: фандинг накапливается без потолка, получатель погашения сверяется с назначенным инвестором

Шесть правок. Две меняют поведение, четыре приводят документ в соответствие с уже
работающим кодом. Порядок был: код, тесты, живая приёмка, потом редакция.

### Что было не так

**Проверка `ALREADY_FUNDED` делала `fundedAmount` зависимым от порядка доставки.**
При `requiredFunding = 100` три платежа от назначенного инвестора на 60, 50 и 40
дают 110, 150 или 100 в зависимости от того, какой пруф воркер собрал первым. Три
разных ответа на одно множество совершённых платежей, и каждый неверен одинаково:
деньги отправлены, значит сумма обязана их считать. Это нарушение INV-3.

Убрано целиком. Фандинг от назначенного инвестора применяется всегда, `fundedAmount`
не имеет верхней границы, избыток является добровольным подарком инвестора заёмщику.
Один раз происходит не платёж, а **пересечение**: условие перехода записано как «до
платежа было ниже порога, после стало не ниже», а не как свойство текущей суммы.
`fundedAmount` не убывает, поэтому такое условие истинно ровно для одного фандинга.

**Получатель погашения сверялся с `deal.investor`, которого до фандинга нет.**
Платёж, ушедший не по тому адресу, поэтому ждал в `VERIFIED_PENDING` до фандинга — и
отклонялся сразу после. Ожидание факта, который, придя, всё равно откажет, это ложь
в состоянии того же сорта, против которого введено правило `VERIFIED_PENDING`.

Теперь сверка с `designatedInvestor`, неизменяемым и известным с создания сделки.
После фандинга это тот же адрес, потому что фандинг применяется только от
назначенного инвестора и в `investor` записывается именно он, — правка меняет
поведение исключительно до фандинга. Погашение верному получателю до фандинга
по-прежнему ждёт: адрес верный, но непрофинансированная сделка ничего не должна, а
`PAID_ON_TIME` у сделки, которую никто не финансировал, противоречит 3.4 и INV-1.

**`deal.investor` теперь не читается нигде.** Это аудиторская запись о том, кто
заплатил на пересечении, а не вход какого-либо решения. Записано в natspec, чтобы
следующий читатель не искал несуществующую логику.

### Что было верно, но не записано

- однотранзакционный путь входит в разрешённую поверхность 4.3; прежняя фраза
  «больше публичных функций у контракта нет» отрицала `submitAndApply`, которого
  требует 4.2;
- интерфейс `Cr3dXCredit` дополнен `openDeal`, `markFinanced`, `reduceExposure`, все
  `onlyDeals`; сигнатура `recordOutcome(bytes32, Result)` сохранена дословно;
- поведение `applyEvidence` задано: ревертит ровно на неизвестном верификатору
  идентификаторе; терминальные состояния идемпотентны, ожидающее перепроверяется;
- автоматического доведения ожидающих доказательств не существует, и это записано
  явно: обход неограниченного множества внутри чужой транзакции — отказ в
  обслуживании, встроенный в контракт.

### Следствия в спецификации

INV-11 переформулирован, INV-18 переведён с количества платежей на однократность
пересечения, INV-19 стал о двух причинах. Раздел 11 вырос до 23 правил. Отменённое
решение v0.4.1 не переписано задним числом, а помечено как отозванное: история
решений остаётся историей.

### Передеплой

Поведение изменилось, а реестр не мигрируется: его состояние — это сделки, резервы и
кредитная история.

| Контракт | Адрес |
|---|---|
| `Cr3dXDeals` | `0x3360E0d2ff86BDd1B3b906c1AaB62E5bD5fc967c` |
| `Cr3dXCredit` | `0x8234C87eCE3a88a7A9E2f987Ec44acc9f801529d` |

Транзакция `0x3f39822da9f21bf79e6215eb4b6312101d8abae0e5e54e6aea91ceb579f6b2c3`,
блок 5337276, газ 2 625 205. Прежний реестр `0x52B54F4a…B756` вместе со своим
кредитным слоем лежит в `previousDeals` с причиной.

### Живая приёмка на новом поведении

Сделка `0xecde8d9f…ceac`, полный путь без расхождений: `PAID_ON_TIME`, экспозиция 0,
скор 500 → 525, лимит 5000 → 5250 USDC. Подделка снова `REJECTED_PERMANENT` /
`WRONG_INVESTOR` — причина сохранила значение 1, сдвинулось только `WRONG_RECIPIENT`
с 3 на 2, и это учтено в `deal-live.ts`.

| Операция | Газ | Корней |
|---|---:|---:|
| `createDeal` | 259 548 | |
| `submitAndApply` фандинг | 334 222 | 10 |
| `submitAndApply` отказ | 253 960 | 7 |
| `submitAndApply` погашение | 340 088 | 9 |

Сырые данные: `data/live/deal-2026-08-19T16-57-41-969Z.json`.

### Тесты

132 зелёных в forge, 22 в скриптовых. Новые:

- `test_fundingIsIndependentOfDeliveryOrder` — сценарий 60, 50, 40 при пороге 100 во
  всех шести порядках, ответ 150 везде;
- `test_fundingAFinancedDealIsStillApplied` — вместо прежнего теста на отказ;
- `test_repaymentToTheWrongRecipientIsRefusedBeforeFundingToo`;
- `test_repaymentBeforeFundingWaitsForTheDealToBeFinanced` — переформулирован: ждёт не
  инвестора, а финансирования;
- `test_thereAreExactlyTwoPermanentReasons` — пинует и нумерацию enum, которую сдвинуло
  удаление `ALREADY_FUNDED`.

В хендлере инвариантов применимость фандинга больше не включает «порог не достигнут»,
а получатель погашения берётся от `designatedInvestor`.

---

## 2026-08-19 — S4: реестр сделок и кредитный слой

Оба контракта написаны, задеплоены и прогнаны на живых сетях. Полный кредитный
путь прошёл без единого расхождения: сделка создана, профинансирована реальным
переводом в Sepolia, погашена, закрыта как `PAID_ON_TIME`, скор и лимит выросли.

### Адреса

| Контракт | Сеть | Адрес |
|---|---|---|
| `Cr3dXDeals` | Creditcoin3 Testnet | `0x52B54F4aC836C5b32fFec72a2f03f1C22174B756` |
| `Cr3dXCredit` | Creditcoin3 Testnet | `0x240B41fFE4F5A1D6047c9024873D636D70a99780` |

Деплой одной транзакцией `0xec79896bea7f99d35cb39bb889f70e5754ec0a4ba53407abfb1eb029213a8302`,
блок 5337092, газ 2 662 805. Параметры: `baseLimit = 5 000 000 000` нативных
единиц (5000 USDC при шести знаках), `attestationGracePeriod = 600` блоков
источника.

**Кредитный слой развёрнут реестром, из его конструктора.** Контрактам нужны
адреса друг друга, и обычный ответ на этот круг — инициализатор, который кто-то
имеет право вызвать один раз. В момент, когда такой адрес существует, фраза
«ни у одной роли, включая деплоера, нет возможности изменить статус, доказательство,
итог или резерв» перестаёт быть правдой, а это и есть продукт. Поэтому `deals` в
кредитном слое фиксируется как `msg.sender` при конструировании, и сеттера нет.
Цена — кредитный слой невозможно развернуть отдельно; она куплена не зря.

### Живая приёмка

Один прогон `npm run deal:live`, ничего не смоделировано.

| Шаг | Транзакция | Итог |
|---|---|---|
| B создаёт сделку | `0x2f489e35…81b8` | сделка `0xad82869a…a566c`, резерв 1.1 USDC |
| A финансирует в Sepolia | `0x26e5773e…a2f5` | 1.0 USDC напрямую от A к B |
| B «финансирует» ту же сделку | `0x94fac74a…6e7c` | самоперевод, денег не двигает |
| подача фандинга | `0x1035ed71…765f` | `FINANCED`, резерв стал экспозицией 1.1 |
| подача подделки | `0x80a3b4a7…ebf6` | `REJECTED_PERMANENT` / `WRONG_INVESTOR` |
| B погашает в Sepolia | `0x2f9facc6…b565` | 1.1 USDC напрямую от B к A |
| подача погашения | `0xb70a2e80…7446` | `PAID_ON_TIME`, экспозиция 0, скор 500 → 525 |

Лимит вырос с 5000.00 до 5250.00 USDC. Итог помечен аттестованной высотой
источника 11522220. Кешированный скор сошёлся с полным пересчётом по каноническим
итогам — это INV-5, проверенный на живой сети, а не только в тестах.

**Негативный случай встроен в основной прогон, а не показан отдельно.** B
отправляет фандинг по своей же сделке, назначенный инвестор — A. Это самоперевод
B → B: он ничего не стоит, но производит настоящее событие гейта, настоящий пруф
и настоящий постоянный отказ на живых данных.

### Измеренный газ

| Операция | Сеть | Газ | Корней continuity |
|---|---|---:|---:|
| `createDeal` | Creditcoin | 259 548 | |
| `fund` | Sepolia | 59 292 | |
| `fund` (подделка) | Sepolia | 51 668 | |
| `submitAndApply` фандинг | Creditcoin | 336 658 | 10 |
| `submitAndApply` подделка | Creditcoin | 257 292 | 7 |
| `repay` | Sepolia | 59 260 | |
| `submitAndApply` погашение | Creditcoin | 338 044 | 1 |

Погашение с одним корнем обошлось дороже фандинга с десятью. Это не аномалия:
корень стоит около 380 газа (34 000 за ~90 лишних корней, замерено в подготовке к
S4), то есть девять корней разницы — это около 3 400. Значит применение погашения
делает работы примерно на 4 800 газа больше, чем применение фандинга. Так и есть:
погашение пишет `repaidAmount`, `onTimeRepaid`, уменьшает экспозицию и записывает
канонический итог со счётчиками, а фандинг — сумму, инвестора, статус и перенос
резерва.

Отказ подделки — это нижняя граница стоимости подачи: верификация плюс одна
холодная запись решения. 257 292 при семи корнях.

Сырые данные прогона: `data/live/deal-2026-08-19T16-09-14-728Z.json`.

### Модель, как она реализована

**Итог сделки — производное от накопленных сумм, а не защёлка.** После каждого
применённого погашения он вычисляется заново из `onTimeRepaid` и `repaidAmount` и
уточняется только вверх. Именно это снимает противоречие между INV-3 и INV-12:
позднее погашение, доставленное раньше своевременного, даёт то же конечное
состояние, что и обратный порядок.

**Три вещи отсутствуют намеренно:** отмены сделки, освобождения резерва и любых
административных функций. Каждая из них либо уничтожает реально отправленные
деньги, либо позволяет одному лимиту обеспечить две сделки. Отсутствие проверено
механически, а не глазами: `scripts/lib/source-rules.test.ts` грепает
`contracts/` на сеттеры, `onlyOwner`, паузы, инициализаторы, `selfdestruct`,
спасательные и отменяющие функции, а заодно на `block.timestamp`, `block.number`
и на связывание `gasUsed` с именем. Это INV-7, INV-14 и INV-15, проверенные
там, где их проще проверить чтением, чем достижением состояния.

**Ожидающее доказательство не стоит ни одного слота.** `VERIFIED_PENDING` не
хранится: если реестр ничего не записал о факте, который есть у верификатора,
факт ждёт. Пруф может ждать сколько угодно, и платить за это хранением было бы
странно.

### Тесты

130 зелёных в forge (было 62), 22 в скриптовых (было 17).

| | |
|---|---|
| Юнит и негативные | `test/Cr3dXDeals.t.sol` (40), `test/Cr3dXCredit.t.sol` (18) |
| Инвариантные, фаззинг | `test/Cr3dXInvariants.t.sol`, 6 инвариантов по 128 000 вызовов |
| Свойства | независимость скора от порядка исходов, дробление платежа |
| Правила по исходникам | `scripts/lib/source-rules.test.ts` |
| Верность хелпера | `test/GateLog.t.sol` |

**Инвариантный прогон проверяет сам себя на бессодержательность.** `afterInvariant`
считает, сколько сделок дошло докуда: 35 сделок, 79 применённых фактов, 79
отказов, из них 5 в `FINANCED`, 3 в `DEFAULTED`, 15 закрытых. Инварианты над
системой, до которой ничего не дошло, проходят вечно и не проверяют ничего.

**Призрачный учёт ведётся снаружи.** Хендлер держит собственную сумму по каждой
сделке, обновляемую только когда применение вернуло `APPLIED`. Инвариант сравнивает
реестр с ней, а не с самим собой: сравнение контракта с собственным состоянием
проходит при любом поведении, а двойной учёт видно только против независимого
счёта. Это INV-2 и INV-17.

**Хелпер, который пересказывает кодировку событий гейта, закреплён тестом.**
`GateLog` собирает лог руками, потому что гонять настоящий гейт с минтом,
аппрувом и переводом на каждый вызов фаззера слишком дорого. `test/GateLog.t.sol`
гоняет настоящий гейт, берёт то, что он реально записал, собирает то же самое
через хелпер и сравнивает побайтово. Без этого теста фаззинг мог бы бодро
проверять кодировку, которую никто не эмитит.

### Покрытие инвариантов

| | Где проверяется |
|---|---|
| INV-1 | статусы достижимы только через `_apply`; сумма подтверждена призрачным учётом |
| INV-2 | `test_applyingTheSameEvidenceTwiceChangesNothing`, `invariant_totalsMatchTheIndependentTally` |
| INV-3 | `test_partialRepaymentsAreOrderIndependent`, `testFuzz_theScoreIsIndependentOfOutcomeOrder` |
| INV-4 | `invariant_statusOutcomeAndTotalsNeverDiverge`, тесты уточнения вверх |
| INV-5 | `invariant_theScoreCacheMatchesTheCanonicalRecords`, `test_theClampIsAppliedOnceToTheFinishedSum` |
| INV-6 | `testFuzz_splittingAPaymentDoesNotRaiseTheScore` |
| INV-7 | `test_onlyTheRegistryMayWriteToTheCreditLayer`, правила по исходникам |
| INV-8 | `test_applyingEvidenceTheVerifierNeverSawReverts` плюс тесты верификатора |
| INV-9 | `invariant_exposureIsTheOutstandingDebtOfOpenDeals`, `invariant_outstandingNeverWraps` |
| INV-10 | `test_unfundedDealsExhaustTheLimit`, проверка в хендлере, `invariant_availableLimitIsTheSaturatedRemainder` |
| INV-11 | проверка применимости в хендлере на каждом фандинге, `test_fundingAnOverdueDealIsApplied` |
| INV-12 | `invariant_statusOutcomeAndTotalsNeverDiverge`, в обе стороны |
| INV-13 | `invariant_reserveIsTheFaceValueOfUnfinancedDeals`, `test_theReserveBecomesExposureExactlyOnce` |
| INV-14 | `test_markDefaultedNeedsTheAttestedHeightPastDueBlockPlusGrace`, правила по исходникам |
| INV-15 | правила по исходникам, тесты декодера |
| INV-16 | тесты верификатора, порядок вызовов |
| INV-17 | `test_oneTransactionWithTwoEventsProducesTwoApplications` |
| INV-18 | `test_fundingAFinancedDealIsRejectedForever` |
| INV-19 | `test_thereAreExactlyThreePermanentReasons`, проверка в хендлере |
| INV-20 | `test_inv20RegressionScenarioWithTheSpecificationsOwnNumbers`, оба порядка |
| INV-21 | `invariant_statusOutcomeAndTotalsNeverDiverge`, `test_paidLateIsRefinedUpwardToPaidOnTime` |
| INV-22 | `test_markDefaultedIsRejectedFromEveryOtherStatus`, проверка в хендлере |

Все обязательные отдельные случаи из раздела 9 закрыты поимённо, включая
регрессию к INV-20 с буквальными числами спецификации (1100, 100, 110, 90).

### Три неточности спецификации, найденные при реализации

Ни одна не является противоречием и ни одна не помешала работе. Спеку не правил:
она заморожена, а решение о правке — не моё.

**1. Раздел 4.3 говорит «больше публичных функций у контракта нет» после списка из
трёх.** При этом раздел 4.2 требует однотранзакционного пути, то есть четвёртой
изменяющей функции — `submitAndApply`. Читаю фразу как «нет функций отмены,
освобождения резерва и административных», что она и объясняет следующим абзацем.
Реализовано по 4.2. Формулировку стоит уточнить, чтобы слепой агент не построил
модель, в которой `submitAndApply` не существует.

**2. Раздел 4.4 перечисляет у `Cr3dXCredit` один изменяющий метод, `recordOutcome`.**
Таблица резерва и экспозиции в том же разделе описывает операции, которые кто-то
обязан вызывать. Добавлены `openDeal`, `markFinanced`, `reduceExposure`, все
`onlyDeals`. Сигнатура `recordOutcome(bytes32, Result)` сохранена дословно,
поэтому кредитный слой сам читает аттестованную высоту для `closedAtBlock`.

**3. Не сказано, что делает `applyEvidence` с неизвестным идентификатором и с
ожидающим.** Выбрано: реверт `UnknownEvidence` только на факт, которого у
верификатора нет. Терминальные состояния идемпотентны; ожидающее доказательство
перепроверяет условия и может примениться, получить постоянный отказ или продолжить
ждать. Ответить «ждёт» на непроверенный идентификатор было бы ложью: он ничего не
ждёт, его нет. Ревертить на ожидающем нельзя вовсе — это сломало бы погашение,
пришедшее раньше фандинга.

### Что дальше

S5, сквозной сценарий, и S6, воркер. Не начинать без отдельного промпта.

---

## 2026-08-19 — подготовка к S4: спецификация v0.4.2 и передеплой верификатора

`Cr3dXDeals` и `Cr3dXCredit` не начинал. Спека заморожена и готова к слепому ревью.

### 1. Фактический ABI верификатора

Проверено по скомпилированному артефакту, не по памяти и не по промптам:

```
submitEvidence(uint64,bytes,MerkleProof,ContinuityProof)             -> bytes32[]   YES
submitEvidenceBatch(uint64[],bytes[],MerkleProof[],ContinuityProof)  -> bytes32[]   YES
```

Обе `nonpayable`, обе возвращают массив идентификаторов. **Выбран однотранзакционный
путь**, записан в раздел 4.2 спецификации. Обратной зависимости не возникает:
`Deals` знает адрес `Verifier` из конструктора, `Verifier` о `Deals` не знает.

### 2. Передеплой верификатора

| | |
|---|---|
| Новый адрес | `0xAf07fCFe36079bD37E94f40f928EE8b088f56B47` |
| Транзакция деплоя, блок 5336861 | `0x921bfdf94b3152b1a23ccf7f61fd7c6607ea0986484ea282015585a551eeb1fe` |
| Прежний адрес | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |

Прежний верификатор из истории не убран: лежит в `deployments/creditcoin.json`
в массиве `previousVerifiers` вместе с причиной передеплоя и временем.

**Пустую транзакцию для сдвига нонса не отправлял, и вот почему.** Нонс A на
Creditcoin к этому моменту был уже 4: деплой занял 0, три `submitEvidence`
живой приёмки заняли 1, 2 и 3. Вместо отправки пустой транзакции вслепую я
вычислил предсказанный CREATE-адрес для текущего нонса и проверил, что он
отличается от адреса гейта. Цель шага достигнута, механизм оказался лишним.

Проверку встроил в скрипт навсегда, а не выполнил разово: `deploy-verifier.ts`
теперь считает предсказанный адрес до отправки и **отказывается деплоить**, если
он совпал бы с адресом гейта, плюс перепроверяет фактический адрес после
включения. Передеплой требует явного `REDEPLOY_REASON`, иначе скрипт отказывает.

### 3. Живая smoke-проверка нового верификатора

Прогнан полный `verify:live` со свежесобранными пруфами, все три фикстуры зелёные.

| Фикстура | Транзакция подачи | Газ | Фактов |
|---|---|---:|---:|
| double-funding | `0x01335c8186ac2f34ed517f91d46f3fb83c59894ff86b81084d03e56bc15e7216` | 350 781 | 2 |
| fund | `0xd91a774b52a7be448e7e15b55827b70165b1d64aac2c73f4fc3c4d0a0ca41b01` | 192 493 | 1 |
| repay | `0x1e0537ff8b5185507bb68814be083b6f2c698afc0e50ab909fd9edbed9a8c18a` | 211 129 | 1 |

Поддельное событие снова проигнорировано. **Идентификаторы фактов совпали с
прежним верификатором побайтово** — идентификатор является хешем факта источника,
а не контракта, который его записал.

### 4. Находка: измерено окно хранения аттестаций

Газ вырос примерно на 34 000 на подачу против первого прогона. Причина не в
контракте: корней в continuity-пруфе стало 62/68/65 вместо 2/8/5, потому что между
прогонами прошёл час.

Проверил через `get_attestation_bounds`: для высот часовой давности обе границы
имеют `isAttestation = false`, то есть это чекпоинты. Аттестации на десятиблочной
сетке между ними вычищены. Бисекцией нашёл границу окна:

| | |
|---|---|
| Окно хранения аттестаций | около 140 блоков источника от аттестованной вершины |
| В минутах | около 28 минут Sepolia |
| В аттестациях | около 14 |

Один замер в один момент, поэтому цифра — порядок величины, а не константа.
Форма явления достоверна, точное значение нет; пруним ли по количеству или по
возрасту — вопрос к команде Creditcoin.

Следствие для S6: подавать пруф в пределах примерно двадцати минут после
аттестации высоты. Внутри окна пруф несёт до 11 корней, снаружи до 101. Цена
опоздания измерена: около 34 000 газа. Ничего при этом не теряется, факт остаётся
доказуемым бессрочно через чекпоинты. Подробности в `ATTESTCOIN_INTEGRATION.md`.

**Уточнено 2026-08-20.** Цифры окна подтверждены командой протокола, но вывод
о бессрочной доказуемости был нашим допущением, а не их утверждением, и снят.
См. запись за 2026-08-20 ниже.

### 5. Спецификация обновлена до v0.4.2

**Устранено противоречие INV-3 против INV-12.** Контрпример: два полных погашения
по 1100 при `faceValue = 1100`, `dueBlock = 100`, на высотах 110 и 90. Порядок
«позднее, затем своевременное» давал `PAID_LATE`, обратный — `PAID_ON_TIME`, потому
что итог разрешалось перезаписывать только при выходе из `DEFAULTED`.

Исправление: статус и `CreditOutcome` являются каноническими производными от всего
накопленного множества применённых погашений. Итог пересчитывается после каждого
применения и уточняется только вверх. `PAID_ON_TIME` терминален, потому что
`onTimeRepaid` монотонно растёт.

Остальное внесённое:

- общее правило `VERIFIED_PENDING` вместо перечня случаев, критерием существования
  допустимого будущего состояния;
- третья постоянная причина отказа `WRONG_RECIPIENT`, применимая к обоим типам
  доказательств; утверждение «постоянный отказ только для фандинга» отозвано;
- погашение применяется в любом статусе сделки, включая закрытый;
- статус и итог обновляются одним переходом в одной транзакции;
- дефолт разрешён исключительно из `FINANCED`;
- уточнение итога не трогает резерв и экспозицию;
- общий механизм смены счётчиков вместо специальной ветки для `DEFAULTED → paid`;
- фактический однотранзакционный интерфейс подачи доказательств;
- раздел 11 переписан: 20 правил без разрывов нумерации. Прежнее правило 9 всё ещё
  утверждало «постоянных причин ровно две, третью добавлять нельзя» и противоречило
  бы `WRONG_RECIPIENT`.

**Добавлены три инварианта, а не один.** INV-20 — независимость итога от порядка
доставки, как и просили. Сверх того INV-21 (статус и итог не расходятся) и INV-22
(дефолт только из `FINANCED`). Причина: слепой агент пишет тесты по списку
инвариантов, и требования, оставшиеся только прозой, он с большой вероятностью
пропустит. Оба новых правила были в задании как обязательные, поэтому сделал их
проверяемыми. Если считаешь лишним — скажи, откачу.

### 6. Аудит полноты спецификации

Все 18 пунктов из задания присутствуют в документе, INV-1..INV-22 на месте.
Дополнительно вычитал на противоречия, оставленные прежними редакциями, и нашёл
два: определение `CreditOutcome` в 3.2 всё ещё говорило «перезаписывается ровно один
раз, при выходе из `DEFAULTED`», а `rejectionReason` перечислял три значения вместо
четырёх. Оба исправлены.

### 7. Артефакт для слепого агента

`test/invariants/SPEC_AMBIGUITIES.md` создан пустым, с форматом записи и явным
указанием, что основной разработчик его не заполняет. Обязательным полем сделан
минимальный сценарий, различающий прочтения: неоднозначность, которую не различает
ни один сценарий, — это вопрос формулировки, а не неоднозначность.

### Задеплоенные адреса

| Что | Сеть | Адрес |
|---|---|---|
| Тестовый USDC Circle | Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | Sepolia | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |
| `DoubleFundingFixture` | Sepolia | `0x014B96AB1E09b4F041451787F62A244fA9c180E6` |
| `Cr3dXVerifier` | Creditcoin 102031 | `0xAf07fCFe36079bD37E94f40f928EE8b088f56B47` |
| `Cr3dXVerifier`, прежний | Creditcoin 102031 | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |

### Следующий шаг

Одновременный запуск S4 основного разработчика и слепого агента по замороженной
v0.4.2.

---

## 2026-08-19 — живая приёмка S2 и S3: жёсткий гейт закрыт

Реальная транзакция Sepolia прошла весь путь до записанных фактов на Creditcoin.
Симуляции в пути нет ни на одном шаге. **DoD S2 и S3 закрыты.**

### Задеплоенные адреса

| Что | Сеть | Адрес |
|---|---|---|
| Тестовый USDC Circle | Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | Sepolia | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |
| `DoubleFundingFixture` | Sepolia | `0x014B96AB1E09b4F041451787F62A244fA9c180E6` |
| `Cr3dXVerifier` | Creditcoin 102031 | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |

**Гейт и верификатор имеют одинаковый адрес.** Это арифметика, а не ошибка
копирования: оба развёрнуты одним аккаунтом A как его первая транзакция в
соответствующей сети, а адрес контракта выводится из деплоера и нонса. Разные
контракты в разных сетях. Записал явно, потому что в логах и обозревателе это
выглядит подозрительно и на это легко потратить время.

### Хеши транзакций

**Sepolia**

| Шаг | Хеш |
|---|---|
| Деплой гейта, блок 11521629 | `0xdda8e394e2db076dc611b553a54226f0f5ba8f60f7d6a53ca67e281a18a45efb` |
| `approve` гейту от A | `0x21f6dd4b2ade4ae239814e07403e02d409a8d406f03f2edfcc54d6f0b161a888` |
| `fund`, 1.0 USDC A → B, блок 11521633 | `0x7344adfaab250aba574737c284e797c5bdac388afb480767bf260a4571cb7ce2` |
| `approve` гейту от B | `0xdb8bf32895642c7da6e0d6d0115d06cd82bc13d8b0718975466ed882553be69c` |
| `repay`, 1.1 USDC B → A, блок 11521636 | `0xd1d8a4f37fe8a243429c3621f7b54c3325030046af4ae49d898af06f41b4408c` |
| `approve` хелперу от A | `0x463146e63629e3ef95049d8f1a59ddeae8d2e71918451438376d48fdca6a8217` |
| Двойной фандинг, блок 11521639 | `0x5aab6aa7af7218f775984d0a93c735d3be870a1602a139daa9d4f6dc21b4c2b8` |

**Creditcoin**

| Шаг | Хеш |
|---|---|
| Деплой верификатора, блок 5336695 | `0x4a3a4469fec70131b37bb0e53c27b0818647c0c10436752bbf15568942876643` |
| `submitEvidence` двойного фандинга | `0x9b544bf3694a405f9bac7100a0ed773541bc728745fa7dcb828af013df420601` |
| `submitEvidence` фандинга | `0xab20e63246b4bee1d9ce17225c96ef74fef29562bd1fa799eb77b08e15d1c4a2` |
| `submitEvidence` погашения | `0xaa53dfff1ff2594c293fa170d16e316d0d6f22f3286c4d6f2a477407710573df` |

Сделки в фикстурах: простая `0x476b7f7f…ef64`, двойная `0x9f0692fd…8301`.

### Вывод verify:live целиком

```
verifier 0x11DD8a4c790939DEa8CED631dB27Afe54334a749, chainKey 1,
trusts gateway 0x11dd8a4c790939dea8ced631db27afe54334a749

=== double-funding: two FundingMade events for the same deal from the real
    gateway, differing only by event nonce, plus a counterfeit with the same
    topic0 from a lookalike contract
    fresh proof: height 11521639, 2 continuity roots
    call would create 2 facts; the fixture holds 2 genuine gateway events
    and 1 lookalike event(s) that must be ignored
    submitted 0x9b544bf3…0601, gas used 317037
    fact 0: FUNDING nonce 2, 0.4 to 0x73eEb564…62DF, id 0x396120ce64…
    fact 1: FUNDING nonce 3, 0.6 to 0x73eEb564…62DF, id 0xe64cef7c0f…
    lookalike from 0x014B96AB…80E6: not recorded (emitter is not the gateway)
    OK

=== fund: the ordinary investor-to-borrower path
    fresh proof: height 11521633, 8 continuity roots
    submitted 0xab20e632…c4a2, gas used 158749
    fact 0: FUNDING nonce 0, 1.0 to 0x73eEb564…62DF, id 0x7c143dd0ef…
    OK

=== repay: the ordinary repayment path
    fresh proof: height 11521636, 5 continuity roots
    submitted 0xaa53dfff…73df, gas used 177385
    fact 0: REPAYMENT nonce 1, 1.1 to 0x0e4Fbc15…56C6, id 0x13aac6e639…
    OK

all 3 fixtures passed the live path end to end
```

### Проверено независимо, чтением из хранилища

Вывод скрипта я не принимал на веру: прочитал каждый факт обратно через
`getEvidence` и `seen` с цепи. Все четыре записаны, `recorded = true`, поля
совпадают с событиями гейта.

| Идентификатор | Тип | Сумма | Nonce | Высота | txIndex |
|---|---|---:|---:|---:|---:|
| `0x396120ce643e0661831792bd7ea3eae407150dc7486ee4c65073252053358e5e` | FUNDING | 0.4 | 2 | 11521639 | 127 |
| `0xe64cef7c0f747505f9c07287c0cbca1712fdcfcee8e443947cf4907dd51bcebe` | FUNDING | 0.6 | 3 | 11521639 | 127 |
| `0x7c143dd0efb0768404fad383a7c4d1870d15cd95a09afdea14cc43e47f0a1cd7` | FUNDING | 1.0 | 0 | 11521633 | 85 |
| `0x13aac6e639153fffb267d147ce28838d2960d1a9eb1b56266a30fb4a50287945` | REPAYMENT | 1.1 | 1 | 11521636 | 99 |

Два факта двойного фандинга различаются **только номером события**: одна
транзакция, один `dealId`, одна высота, один `txIndex`, один получатель. Ради
этого номер и введён в идентификатор, и здесь он единственный, что их разделяет.

Плательщик в обоих — адрес хелпера `0x014B96AB…80E6`, а не внешний аккаунт.
Это ожидаемо и описано заранее: гейт пишет `msg.sender`, а вызывает хелпер.

**Подделка не оставила следа.** Вычислил идентификатор, который она получила бы
(её номер события `type(uint256).max`), и проверил:

```
id it would have had: 0xaf017dfac9457084995c261d4a9cfb100301ec9dac4bb9b2bb5f2200d6487d67
seen(): false    dealId in storage: 0x000…000    amount: 0
```

### Негативные проверки на живой сети, с точными причинами реверта

Все три вернули ошибки **нашего кода**, а не прекомпайла:

| Случай | Сырые данные реверта | Декодировано |
|---|---|---|
| Повтор того же пруфа | `0x1f294fff7c143dd0…1cd7` | `EvidenceAlreadyRecorded(0x7c143dd0…1cd7)` |
| Чужая транзакция, 43 лога | `0x3bc722d0` | `NoRelevantEvidence()` |
| Зареверченная транзакция источника | `0x4d904ea0…afc8420…058` | `SourceTransactionFailed(11520066, 88)` |

Третий случай — самый содержательный. **Прекомпайл пруф принял**: транзакция
действительно была включена в блок. Отклонил её наш явный чек `status == 1`.
Ровно то разделение ответственности, ради которого этот чек существует: протокол
доказывает включение, а не успех.

### Измеренный газ, заменяет синтетические цифры

| Подача | Событий гейта | Блоб | Calldata | Газ calldata | Итого |
|---|---:|---:|---:|---:|---:|
| `repay` | 1 | 2 080 Б | 3 044 Б | 44 204 | **177 385** |
| `fund` | 1 | 2 080 Б | 3 140 Б | 45 356 | 158 749 |
| Двойной фандинг | 2 | 3 840 Б | 4 772 Б | 57 680 | **317 037** |

**За стоимость подачи одного факта брать 177 385, а не 158 749.** Более дешёвая
строка — артефакт, который случается в жизни гейта ровно один раз: у её события
номер 0, а запись нуля в холодный слот стоит 2 200 против 22 100 за ненулевое
значение. Сходится с точностью до 32 газа:

```
(22 100 - 2 200) - 3 × 48 = 19 756 ожидаемо
133 181 - 113 393         = 19 788 наблюдаемо
```

Разница целиком объясняется семантикой хранилища, а не тем, что фандинг чем-то
отличается от погашения.

Цена газа на Creditcoin 0.5 gwei, значит подача одного факта стоит
**0.000089 CTC**, деплой верификатора обошёлся в **0.000635 CTC**. Вся сторона
Creditcoin по сделке — доли цента.

### Фактическая задержка аттестации

| | |
|---|---|
| Отставание, когда легла последняя транзакция | 39 блоков |
| Время до покрытия аттестацией | 490 с |
| Отставание, замеренное после прогона | 42 блока, 516 с |
| Наблюдённые шаги | 11521600, 610, 620, 630, 640 |

Каждый шаг ровно 10 блоков. Против 32–41 блока в первый день — согласуется,
ближе к верхней границе окна. `attestationGracePeriod` остаётся 600: он
рассчитан на `MaxCatchup`, а этот режим прогон не задел и показать не мог.

### Находка: точная формула размера continuity-пруфа

Ранее было зафиксировано, что пруфы протухают и растут. Прогон дал механизм
точно:

```
roots = ближайший сохранившийся якорь - высота запроса + 1
```

Проверено на трёх свежих пруфах при аттестованной высоте 11521640: 8, 5 и 2
корня для высот 11521633, 11521636, 11521639. И на состаренных фикстурах: 35 и
41 корень для высот 11520066 и 11520060, оба якоря сходятся в **11520100** —
кратное сотне, то есть сетка чекпоинтов (10 блоков на аттестацию, 10 аттестаций
на чекпоинт).

Значит размер пруфа зависит не от возраста факта, а от расстояния до ближайшего
якоря, который цепь ещё держит, и якорь деградирует с сетки аттестаций на сетку
чекпоинтов, когда истекает retention. Практическая граница: до 11 корней при
своевременной сборке и до 101 после истечения retention. Ни то, ни другое не
близко к потолку в 500.

Подробности в `docs/ATTESTCOIN_INTEGRATION.md`.

### Что не делалось

S4 не начинал. Фикстуры руками не правил, тесты под результат не подгонял.
Расхождений, требующих правки, не возникло.

### Следующий шаг

S4, реестр сделок и кредитный слой. Жёсткий гейт перед ним пройден: реальная
транзакция Sepolia доходит до сохранённого доказательства с корректно
разобранными полями события.

---

## 2026-08-19 — preflight: цепочка балансов и защита от частичного прогона

Ждём ответа инженеров Creditcoin в Discord. Живой прогон не запускался: кошельки
пусты, пять faucet-пополнений в ожидании. S4 не начинал.

### Что было и что не сходилось

Preflight проверял, что каждому счёту хватает на старте, отдельными сравнениями
`held >= required`. Три требования из четырёх были закрыты честно: `capture:gate`
ждёт квитанцию (`send` возвращает управление только после успешного receipt),
проверки балансов стоят между транзакциями, allowance перечитывается с цепи после
подтверждения, preflight ничего не отправляет. Проверено чтением кода и запуском.

Два требования закрыты не были:

1. **Цепочка не считалась.** `validateLiveUsdcPlan()` считал арифметику над
   константами `INITIAL_USDC_A` и `INITIAL_USDC_B`, а не над фактическими
   балансами. Результат не зависел от состояния сети вообще: при нулевых
   балансах печаталось `OK ordered USDC plan`. Таблицы не было, шаг снабжения
   хелпера не моделировался, конечные балансы не выводились.

2. **Расхождение со стартовым состоянием не детектировалось.** Односторонние
   проверки `>=` ловят «не хватает», но не ловят «перекошено». После упавшего
   после `fund` прогона A = 0, B = 1.1, и старый preflight советовал
   «send at least 1.0 more test USDC to A» — то есть отправлял к крану, пока
   токены лежат в соседнем кошельке. Faucet-кулдаун тратится впустую, а прогон
   остаётся так же заблокирован.

### Сделано

- `scripts/lib/live-plan.ts` переписан. `projectUsdc(start)` проигрывает все
  четыре движения от **фактических** балансов, включая отдельный шаг снабжения
  хелпера, и останавливается на первом непокрытом движении. `diagnose(actual)`
  различает нехватку токенов и их неправильное размещение.
- Четыре канонических состояния прогона распознаются точно: чистый старт, после
  `fund`, после `repay`, завершённый прогон. Совпадение называется в выводе.
- Ненулевой баланс хелпера трактуется как обломки упавшей транзакции: между
  прогонами он всегда ноль, потому что пересылает всё внутри одной транзакции.
- Preflight печатает таблицу по шагам и отделяет «нужен кран» от «перенеси
  обратно из B». Перекос попадает в блокеры конфигурации, а не в список крана:
  faucet его не исправит.
- Все пробелы фондирования сообщаются за один проход. Раньше проекция
  останавливалась на первом шаге и про B не говорила вовсе, что превращало один
  визит к крану в два.
- `capture:gate` использует ту же `diagnose` и отказывается отправлять
  транзакции на балансах, не похожих на чистый старт.
- `scripts/lib/live-plan.test.ts`, 17 тестов на `node --test`,
  `npm run test:scripts`. Покрыты именно те случаи, которые дорого
  воспроизводить на тестнете: остановка после `fund`, после `repay`, повторный
  запуск поверх завершённого прогона, хелпер с остатком, односторонний кран.

### Проверено

`npm run typecheck`, `forge build`, `forge test` (62), `npm run test:scripts` (17),
живой `npm run preflight` против Sepolia и Creditcoin.

Живой вывод сейчас: кошельки пусты, таблица останавливается на первом шаге,
список действий содержит все пять пополнений.

### Роли и адреса кошельков

| Роль | Адрес |
|---|---|
| A, деплоер и инвестор | `0x0e4Fbc156afdd9271267E64F11CDba99747156C6` |
| B, заёмщик и плательщик | `0x73eEb564d3DebFdc2baf3281f9645C0068E862DF` |

Ключи только в `.env` с правами 0600, не печатаются нигде.

### Следующий шаг

Пять пополнений, затем четыре команды живого прогона и закрытие DoD S3.

---

## 2026-08-19 — S3, верификатор

### СТОП: предусловие этапа не выполнено

Артефактов S2 нет ни в репозитории, ни на диске, ни на origin. Проверено:
`deployments/sepolia.json` отсутствует, `test/fixtures/gate/` отсутствует,
`git status` чистый, других веток на origin нет, поиск по файловой системе пуст.

Значит гейт не задеплоен и живых фикстур не существует. Без них не закрывается
главный тест этапа на живых данных и не закрывается DoD. Всё остальное сделано,
включая тот же тест на реальных логах реального гейта в локальной EVM.

### Сделано

- **`contracts/Cr3dXVerifier.sol`.** Единственная точка входа внешних фактов.
  `submitEvidence` и `submitEvidenceBatch` возвращают массив созданных
  идентификаторов, как зафиксировано под S4.
- **`contracts/interfaces/ICr3dXGatewayEvents.sol`** — оба события объявлены один
  раз и наследуются обеими сторонами. Гейт их эмитит, верификатор берёт из них
  топики. Скопированная константа компилировалась бы вечно, молча не совпадая ни
  с чем.
- **62 теста, все зелёные**, сборка без предупреждений компилятора и линтера.
  24 из них на верификаторе.
- **Скрипты:** `npm run deploy:verifier`, `npm run verify:live`.

### Главный тест этапа

`test_twoGenuineFundingsAndOneImpostorYieldExactlyTwoFacts`. Настоящий
`Cr3dXGateway` и настоящий `DoubleFundingFixture` исполняются в локальной EVM,
их реальные логи снимаются через `vm.recordLogs` и переупаковываются в блоб в
формате протокола. На вход верификатора идут три лога с совпадающим `topic0` плюс
шумные `Transfer`. На выходе ровно два факта, с проверкой содержимого: разные
идентификаторы, разные номера событий, один и тот же `dealId`, суммы 400 и 600,
получатель заёмщик, а поддельное событие не оставило следа — его идентификатор
вычисляется явно и проверяется, что `seen` по нему ложь и хранилище пустое.

Симулирован только ответ прекомпайла «да или нет» на пруф: в локальной EVM
Attestcoin нет. Логи, события и блоб настоящие. Валидность пруфа проверяется
отдельно, на живой сети, скриптом `verify:live`.

### Проверка порядка verify → calculateTxIndex

`view`-функция не может ничего записать, поэтому прямой лог вызовов невозможен.
Взводятся оба вызова на отказ с различимыми сообщениями, и вернувшееся сообщение
называет тот, который отработал первым. Тест `test_verifyRunsBeforeCalculateTxIndex`.

### Негативные тесты

На реальных аттестованных блобах, снятых на S1: нулевой статус (`reverted`),
транзакция без логов (`eip1559-no-logs`), 43 лога без единого нашего
(`many-logs` → `NoRelevantEvidence`). Синтетические там, где живого случая не
существует: провалившаяся транзакция с нашими событиями в логах (на цепи логи
revert не переживают, но блоб может утверждать что угодно), лог без топиков,
чужой эмитент с нашим `topic0`, повтор, батч из 11, пустой батч, рассинхрон длин
массивов, атомарность батча.

### Измеренная стоимость

| Вызов | Газ |
|---|---|
| `submitEvidence`, 1 лог, 1 факт | 133 283 |
| `submitEvidence`, 3 лога, 3 факта | 367 677 |

Это то, что добавляет Cr3dX поверх самой верификации (около 47 000 на живой сети
для формы гейта) и calldata. Основная статья — запись факта: пять холодных слотов
по 20 000.

Первая редакция стоила 179 431 на факт: структура занимала семь слотов. После
переупаковки пять, минус 46 000 (26 %). Дальше сокращать можно только сузив
`amount` до `uint128` — не стал: молчаливое усечение доказанной денежной суммы
это не та экономия, ради которой стоит рисковать, и судья, увидевший `uint128` на
кросс-чейн сумме, будет прав, подняв бровь.

Флаг `seen` упакован в свободные байты слота факта, а не вынесен в отдельный
`mapping`. Внешняя сигнатура `seen(bytes32) → bool` та же, но второй холодной
записи на 20 000 нет.

### Граница между контрактами зафиксирована

Верификатор отвечает «что произошло» и хранит неизменяемые факты. Он не знает,
что такое сделка, ожидание или отказ. Зависимость односторонняя: реестр
развернётся вторым, получит адрес верификатора в конструкторе и будет читать
через `getEvidence(bytes32) → VerifiedEvidence`. Обратных вызовов нет, поэтому
функция связывания двух контрактов после развёртывания не нужна.

Отдельно проверено тестом, что у верификатора нет привилегированной поверхности:
восемь имён вроде `owner()`, `setGateway(address)`, `deleteEvidence(bytes32)` —
все обязаны отвалиться.

### Находка: пруфы протухают

Continuity-пруфы из фикстур S1 перестали верифицироваться примерно через два часа
после снятия. Свежий пруф той же транзакции проходит: `encodedTx`, merkle-пруф и
`lowerEndpointDigest` идентичны, а корней стало 35 вместо 5.

Причина: пруф тянется до ближайшей сохранившейся аттестации или чекпоинта.
Аттестации хранятся ограниченное время и вычищаются, чекпоинты остаются, и их
один на десять аттестаций, то есть примерно один на сто блоков источника.

Следствие для S6, важное: **пруф это сообщение в полёте, а не состояние.** Воркер
не имеет права положить построенный пруф в очередь и повторить его через час.
При повторе он пересобирает пруф. Цикл ретраев, переигрывающий протухший пруф,
будет падать вечно на цепи, которая приняла бы этот факт — худший вид отказа:
постоянный, самонанесённый и внешне неотличимый от проблемы протокола.

`verify:live` поэтому берёт из фикстур только хеш транзакции, а пруф запрашивает
заново каждый запуск. Подробности в `docs/ATTESTCOIN_INTEGRATION.md`.

### Задеплоенные адреса

| Что | Сеть | Адрес |
|---|---|---|
| Тестовый USDC | Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | Sepolia | не задеплоен |
| `DoubleFundingFixture` | Sepolia | не задеплоен |
| `Cr3dXVerifier` | Creditcoin 102031 | не задеплоен |

### Что нужно от тебя

Ключ так и не появился в `.env`, поэтому ни одна из четырёх команд не выполнена.
Нужен один счёт с тестовым ETH и тестовым USDC в Sepolia (3.1 USDC хватит) и
тестовым CTC на Creditcoin.

```sh
# .env: DEPLOYER_PRIVATE_KEY=0x...
npm run build
npm run deploy:gateway     # Sepolia
npm run capture:gate       # три транзакции, потом ~10 минут ожидания аттестации
npm run deploy:verifier    # Creditcoin, chainKey берётся из живого реестра
npm run verify:live        # жёсткий гейт DoD
```

`verify:live` печатает по каждой фикстуре: свежий пруф, сколько фактов создалось,
их поля, и что поддельное событие проигнорировано. Принеси вывод — запишу адреса,
хеши и реальный расход газа сюда и в README.

### Следующий шаг

Закрыть DoD S3 четырьмя командами выше. Затем S4, реестр сделок и кредитный слой.

---

## 2026-08-19 — S2, гейт в Sepolia

### Сделано

- **`contracts/Cr3dXGateway.sol`.** Две функции, один общий счётчик, два события,
  четыре именованные ошибки, ноль привилегированных ролей. Токен `immutable`,
  задаётся при развёртывании. Переводы через `SafeERC20`.
- **`test/helpers/DoubleFundingFixture.sol`** — вспомогательный контракт для снятия
  фикстуры. Явно вне продакшн-периметра: лежит в `test/`, не в `contracts/`.
- **38 тестов, все зелёные**, сборка без предупреждений:
  - 21 на гейте, 5 на вспомогательном контракте, 12 с предыдущего этапа;
  - отказы: нулевой `dealId`, нулевой получатель, нулевая сумма, отсутствие
    allowance, не-контракт вместо токена;
  - неизменность баланса гейта сформулирована дельтой, как и требовалось;
  - насильно присланные токены не трогаются последующими операциями;
  - токен, возвращающий `false`, отклоняется; токен, не возвращающий ничего,
    принимается;
  - отсутствие привилегированной поверхности проверяется вызовами `owner()`,
    `pause()`, `withdraw()` и ещё семи имён — все обязаны отвалиться, fallback-а нет;
  - гейт не принимает эфир, чтобы в нём нечему было застревать;
  - раскладка событий проверяется **настоящим декодером из S1**, а не переписанным
    от руки описанием: рассинхрон гейта и декодера падает здесь, а не на тестнете.
- **Скрипты:** `npm run deploy:gateway`, `npm run capture:gate`.
- **README:** адрес токена явным текстом, полный путь воспроизведения, отдельный
  абзац про `approve`.

### Сломано / не работает

Ничего. Но **этап не закрыт**: контракт не задеплоен и живых фикстур нет, потому
что `DEPLOYER_PRIVATE_KEY` в `.env` отсутствует, а ключи я не запрашиваю.

### Что нужно от тебя, чтобы закрыть S2

Счёт: тестовый ETH на газ плюс тестовый USDC с faucet.circle.com для адреса
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Нужно 3.1 USDC суммарно
(1.0 + 1.1 + 0.4 + 0.6 в нативных единицах, то есть суммы фикстур намеренно мелкие).

```sh
# ключ в .env: DEPLOYER_PRIVATE_KEY=0x...
npm run build
npm run deploy:gateway
npm run capture:gate
```

`capture:gate` отправляет три транзакции сразу, затем ждёт аттестацию одним блоком
(примерно 10 минут) и снимает пруфы. Логи принеси, я запишу адреса и хеши сюда.

### Задеплоенные адреса

| Что | Сеть | Адрес |
|---|---|---|
| Тестовый USDC | Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | Sepolia | не задеплоен |
| `DoubleFundingFixture` | Sepolia | не задеплоен |

Живые адреса пишутся в `deployments/sepolia.json` автоматически.

### Решения, принятые на этом этапе

**Событие эмитится до перевода.** Порядок: проверки, инкремент счётчика, событие,
`safeTransferFrom`. Это канонический checks-effects-interactions, и он же означает,
что токен, вошедший повторно, не может получить уже использованный номер. Сорвавшийся
перевод откатывает транзакцию целиком, поэтому событие не может пережить платёж,
который оно описывает. В логах гейта событие идёт перед `Transfer` токена, что
проверено тестом.

**Функции вывода застрявших токенов нет и не будет.** Она требует того, кто вправе
её вызвать, а появление такого адреса ломает утверждение «никто не может помешать
доказанному факту». Застрявший баланс инертен, и это проверяется тестом.

**OpenZeppelin подключён** ради `SafeERC20`. Писать обработку возвратных значений
руками в коде, который будут читать судьи, хуже, чем взять аудированную библиотеку.

### Форма фикстуры двух событий

Одна транзакция, три интересных лога:

1. `FundingMade` от настоящего гейта, `dealId` = D, номер N;
2. `FundingMade` от **вспомогательного контракта** с тем же `topic0` — подделка;
3. `FundingMade` от настоящего гейта, тот же `dealId` = D, номер N+1.

Подделка стоит между настоящими намеренно: верификатор, останавливающийся на первом
совпадении, и верификатор, берущий последнее, оба ошибутся заметно. Плюс шумные
`Transfer` от самого токена.

Оба настоящих события различаются **только номером** — именно поэтому взяты два
фандинга, а не фандинг с погашением: у разных типов идентификаторы разошлись бы уже
по типу, и тест прошёл бы при полностью сломанном учёте номера.

**Инвестором в обоих событиях будет адрес вспомогательного контракта**, а не внешний
аккаунт, потому что вызывает он. Это правильно: гейт пишет `msg.sender` намеренно,
чтобы кредитный слой читал плательщика из доказанного поля лога, а не из поля `from`
транзакции, которое каноническими корнями Ethereum не покрыто. Записано и здесь, и
в комментарии контракта, и в самой фикстуре — чтобы на S4 это не приняли за сломанный
учёт.

### Следующий шаг

Закрыть S2 деплоем и снятием фикстур, затем S3, верификатор.

Жёсткий гейт перед S4 (реальная транзакция Sepolia проходит весь путь до сохранённого
доказательства с корректно разобранными полями события) не пройден: он и есть
содержание S3.

---

## 2026-08-19 — S1, фундамент контрактов

### Сделано

- **Спецификация обновлена до редакции v0.4.1.** Три решения внесены в тело документа
  с записью причины в журнале изменений: накопительный и повторный фандинг, нативные
  единицы токена, кламп скора один раз к итогу. Затронуты разделы 2, 3.2, 3.3, 3.4,
  4.3, 4.4, 5, 6 и 11. INV-11 сужен до точной формулировки, добавлены INV-18 и INV-19,
  правила 13 и 14. Имя файла сохранено намеренно.
- **Foundry развёрнут:** `foundry.toml`, `forge-std` подключён сабмодулем,
  `evm_version = "cancun"`. Проверено по исходнику рантайма: Creditcoin исполняет EVM
  в конфигурации Cancun (`runtime/src/lib.rs:461`), занижать target не нужно.
- **Интерфейсы прекомпайлов:** `contracts/interfaces/IBlockProver.sol`,
  `contracts/interfaces/IChainInfo.sol` — сигнатуры перенесены дословно из
  `precompiles/metadata/sol/` коммита `06657e9`, потому что они определяют селекторы.
- **Декодер:** `contracts/libraries/ProvenTransaction.sol`. Достаёт `status` и полный
  список логов одним `abi.decode` без ветвления по типу транзакции.
  `contracts/libraries/Attestcoin.sol` — адреса прекомпайлов.
- **Захват фикстур:** `scripts/capture-fixtures.ts` сканирует аттестованные блоки
  Sepolia и морозит блобы в `test/fixtures/`. Ожидаемые значения берутся из
  `eth_getTransactionReceipt` и сверяются с блобом поле в поле до записи фикстуры.
- **12 тестов, все зелёные:** 9 на живых блобах, 3 фаззинг-свойства.

### Сломано / не работает

Ничего.

### Форма `encodedTx` — исправление к отчёту разведки

`docs/PRECOMPILE_FINDINGS.md`, R4 описывает блоб как плоский ABI-кортеж с ветвлением
по пяти типам транзакций и делает вывод, что потребителю на Solidity нужен
пятиходовый декодер. Это верное описание логических полей, но не формы на проводе.
Реальная форма:

```
abi.encode(uint8 txType, bytes[] chunks)
```

Чанк квитанции всегда последний, его раскладка одинакова для всех типов:

```
abi.encode(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)
```

Подтверждено дважды: по исходнику `usc-abi-encoding` 0.5.0 (`src/abi/v1.rs`, типы 0–2
собирают три чанка, типы 3–4 четыре, `encode_receipt_fields` последний во всех пяти;
обёртка `Tuple(type_id, Array(chunks))` на строке 289) и на живых блобах типов 0, 1,
2 и 3. Пятиходовое ветвление нужно только для восстановления канонического хеша
транзакции, чего Cr3dX не делает.

Побочный эффект, важный для правила 4: `from` и `gasUsed` лежат в чанках, которые
этот путь не открывает. Запрет на их использование обеспечивается формой функции, а
не памятью ревьюера.

### Измеренная стоимость декодирования

| Фикстура | Блоб | Логов | Газ |
|---|---|---|---|
| `eip1559-no-logs` | 1 248 Б | 0 | 3 817 |
| `reverted` | 1 376 Б | 0 | 3 829 |
| `access-list` | 1 632 Б | 1 | 5 380 |
| `eip1559-two-logs` | 2 048 Б | 2 | **6 943** |
| `blob-carrying` | 3 936 Б | 3 | 9 238 |
| `legacy` | 6 848 Б | 17 | 29 993 |
| `many-logs` | 17 376 Б | 43 | 71 200 |

Значимая строка — форма гейта: 6 943 газа против примерно 47 000 на всю верификацию,
в которой она находится. Декодирование не является местом расхода, поэтому используется
декодер компилятора с проверкой границ, а не ассемблер ради нескольких тысяч газа.

### Задеплоенные адреса

Нет.

### Следующий шаг

S2, гейт в Sepolia. Токен: тестовый USDC Circle
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, символ `USDC`, `decimals` = 6,
проверено вызовом на живой сети. Выбран из-за публичного крана на faucet.circle.com;
если нужен другой, скажи до S2, адрес зашивается при развёртывании.

Демонстрационные суммы в нативных единицах: финансирование 1000 USDC =
`1_000_000_000`, номинал 1100 USDC = `1_100_000_000`, `BASE_LIMIT` 5000 USDC =
`5_000_000_000`.

### Открытые вопросы

Нет. Три вопроса предыдущей сессии закрыты решениями и внесены в спецификацию.

Не покрыто наблюдением: транзакции типа 4 (EIP-7702) в просканированном диапазоне
Sepolia не встретились. Чанк квитанции у них последний по исходнику энкодера, но
живого подтверждения нет.

---

## 2026-08-19 — W1, измерение параметров живой сети

### Сделано

- Каркас репозитория: `package.json`, `tsconfig.json`, `.gitignore` с `.env` в первой
  строке секции секретов, `.env.example`. Ключи читаются только из `.env`.
- `scripts/probe.ts` и `scripts/lib/*` — измеритель параметров живой сети.
  Полностью read-only, приватные ключи не нужны и не запрашиваются.
- `docs/ATTESTCOIN_INTEGRATION.md` — генерируется прогоном probe между маркерами
  `<!-- probe:begin -->` / `<!-- probe:end -->`. Текст вне маркеров пишется руками и
  перезапуском не затирается.
- `README.md` — англоязычный, границы доверия сформулированы явно.
- Сырые результаты замеров: `data/probe/*.json`.

Все девять пунктов первой задачи закрыты, включая стоп-условие: `verify` возвращает
`true` на реальной транзакции Sepolia.

### Сломано / не работает

Ничего. Замечания по окружению:

- Node не использует системный прокси для `fetch` по умолчанию. При настроенном
  `HTTPS_PROXY` прогон падает с таймаутом определения сети. Запускать как
  `NODE_USE_ENV_PROXY=1 npm run probe`; probe об этом предупреждает сам.
- Публичный RPC `https://rpc.sepolia.org` отдаёт 404, `https://sepolia.drpc.org`
  требует платный тариф. Рабочий бесплатный:
  `https://ethereum-sepolia-rpc.publicnode.com`.

### Измеренные параметры сети

Полные таблицы и обоснования — в `docs/ATTESTCOIN_INTEGRATION.md`.

| Параметр | Значение |
|---|---|
| `chainKey` Sepolia в реестре Testnet | **1** (Ethereum mainnet — 3) |
| Версия кодировки для Sepolia | v1 |
| Интервал аттестации | 10 блоков источника |
| Интервал чекпоинта | 10 аттестаций |
| `MaxCatchup` | 500 блоков (значение по умолчанию рантайма, override не задан) |
| Предельная длина цепочки корней | 500 = `max(MaxCatchup, interval)` |
| Максимальный размер батча | 10 высот, 11 отклоняется |
| Отставание аттестации | 32–41 блок, 6.5–8.5 минут, пила с шагом 10 |
| Отставание кеша proof builder от аттестации | до 10 блоков |
| Газ: `verify`, транзакция без логов | 42 966 |
| Газ: `verify`, транзакция формы гейта (2 лога) | 47 276 |
| Газ: батч из 10 | 401 427, около 40 100 на транзакцию |
| `verify` против `verifyAndEmit` | наблюдаемое расхождение 0; Creditcoin Team предварительно считает, что лог должен тарифицироваться, окончательный ответ ожидается |
| **`attestationGracePeriod`** | **600 блоков источника** (~2 часа Sepolia) |
| Формула grace | `MaxCatchup 500 + max lag 41 + interval 10 + запас на отправку 25 = 576`, округлено до 600 |

Ключевое для W2: `encodedTx` это `abi.encode(uint8 txType, bytes[] chunks)`, и чанк
квитанции всегда последний. `status` и логи достаются одним `abi.decode` без ветвления
по типу транзакции. Поля `from` и `gasUsed` лежат в чанках, которые этот путь не
трогает вовсе.

### Задеплоенные адреса

Нет. Контракты не написаны — по стоп-условию первой задачи.

### Следующий шаг

W2: гейт в Sepolia и верификатор.

1. Поставить Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).
   Решение по инструментам: контракты и тесты на Foundry, потому что спецификация
   требует инвариантных фаззинг-тестов; скрипты, деплой и воркер на TypeScript и
   ethers v6, потому что на них же написан SDK протокола.
2. `Cr3dXGateway.sol` в Sepolia, `Cr3dXVerifier.sol` на Creditcoin.
3. Три вопроса по спецификации ждут решения — см. раздел ниже.

### Открытые вопросы по спецификации

Не блокируют W1, но должны быть закрыты до того, как подключится агент, пишущий тесты
по спецификации: интерфейсы после этого менять дорого.

1. **Повторный фандинг уже профинансированной сделки.** INV-11 требует применять
   валидное доказательство фандинга всегда. Единственная разрешённая постоянная
   причина отказа — фандинг не от назначенного инвестора. Но применить второй фандинг
   к сделке в `FINANCED` нечем: резерв уже снят, повторное `exposure += faceValue`
   удвоит экспозицию. Предлагаемая трактовка: доказательство остаётся в
   `VERIFIED_PENDING` навсегда и учёта не трогает. Это согласуется с уже признанным в
   §4.3 ограничением «средства, отправленные по чужой сделке, теряются», и не
   отклоняет доказательство, а просто не находит для него применения.
2. **Единицы `BASE_LIMIT`.** «5000 единиц токена» при §3.5 «суммы в нативных единицах
   токена». Предлагаю трактовать как 5000 целых токенов, то есть `5000 * 10**decimals`
   тестового USDC, и задавать параметром развёртывания.
3. **Хранение итогов для INV-5.** Скор считается с клампами (потолок 850, пол 300),
   поэтому он зависит от порядка итогов, а не только от их количества. Значит
   агрегатные счётчики нарушат INV-5 при перезаписи итога на выходе из `DEFAULTED`.
   Предлагаю хранить упорядоченный список сделок заёмщика и пересчитывать скор
   проигрыванием текущих итогов по порядку.
