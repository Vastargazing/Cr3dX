# Аудит README глазами нового человека

Дата проверки: 2026-08-20. Проверяемая ревизия: `777c05f` (`main`).

## Как проверялось

README был сначала прочитан целиком без просмотра кода. Затем проект был заново
клонирован командой из README в отдельный временный каталог с рекурсивной
инициализацией сабмодулей. Foundry был установлен в отдельный временный `HOME`,
чтобы проверка не зависела от уже установленной копии и не меняла пользовательское
окружение. `.env` и live-команды не использовались.

Фактическое окружение и результат:

- Node.js `v22.22.1`, npm `9.2.0`;
- официальный `foundryup` установил текущий stable Foundry/Forge `1.7.1`;
- `env -u NODE_TLS_REJECT_UNAUTHORIZED npm ci` — 67 пакетов, 0 vulnerabilities;
- `npm run build` — 53 Solidity-файла, Solc `0.8.28`, успех с одной
  нефатальной warning о mutability в `test/GateLog.t.sol`;
- `npm test` — 141 passed, 0 failed, 0 skipped, примерно 150 секунд;
- `npm run typecheck` — успех;
- `npm run test:scripts` — 3 passed, 0 failed.

## Находки

### 1. P0 — последовательное выполнение Setup ломает рекомендованный S5 symlink

**Место:** `Setup`, строки 151–159; `Reproducing the live S5 scenario`, строки
197–216.

**Что неочевидно:** Setup безусловно создаёт обычный файл командой
`cp .env.example .env`. Следующий live-раздел для «new checkout» безусловно
выполняет `ln -s ~/.config/cr3dx/.env .env`. Если читатель идёт сверху вниз, `ln`
завершается с `File exists`. README не говорит, что это альтернативные схемы, и
не даёт безопасного перехода с одной на другую.

**Что добавить/переформулировать:** в Setup явно предложить два взаимоисключающих
варианта:

1. local/read-only: `.env` вообще не нужен для перечисленных build/test-команд;
2. live S5: создать защищённый внешний target и symlink вместо `cp`.

Если нужен путь миграции, привести команды, которые сначала проверяют, что в
существующем `.env` нет секретов, а не советуют безусловно удалить или
перезаписать файл.

### 2. P0 — утверждение, что `wallets:create` следует по symlink, не соответствует реализации

**Место:** `Reproducing the live S5 scenario`, строки 218–223.

**Что неочевидно:** README обещает, что `wallets:create` следует по `.env`
symlink и записывает ключи во внешний target. Реализация читает symlink target,
но при появлении новых ключей записывает `.env.tmp`, а затем вызывает
`renameSync('.env.tmp', '.env')` (`scripts/create-wallets.ts`, строки 119–123).
На Unix такой rename заменяет сам symlink обычным файлом. Внешний target остаётся
пустым, а ключи оказываются в checkout-local `.env`. Это также означает, что
зафиксированная в README и `docs/STATUS.md` защитная схема фактически не закрыта.

**Что добавить/переформулировать:** сначала исправить запись в
`wallets:create`, чтобы атомарно обновлялся разрешённый target без замены symlink,
и добавить regression test на сохранение symlink. До исправления README не должен
утверждать, что команда следует по ссылке; безопаснее временно требовать экспорт
двух переменных из внешнего secret manager/файла и не запускать
`wallets:create` через symlink.

### 3. P1 — в разделе смешаны два разных preflight, а безопасная S5-команда не приведена

**Место:** `Reproducing the live S5 scenario`, строки 246–255, 276–314 и
334–340.

**Что неочевидно:** сначала сказано, что preflight является частью `s5:fresh` и
`s5:continue`. Затем отдельный `preflight` назван read-only и показана проекция с
`helper`/double-funding, но команды `npm run preflight` в README нет. Только ближе
к концу выясняется, что это старый `preflight`/`capture:gate` fixture path, а не
интегрированный S5 preflight. В коде при этом существует отдельный безопасный
S5-флаг `--preflight-only`, но README его не показывает. Читатель не может без
кода понять, какой preflight проверяет именно выбранный `fresh`/`continue` run и
как запустить его без транзакций.

**Что добавить/переформулировать:** разделить названия и привести точные команды,
например:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode fresh --runs 2 --preflight-only
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode continue --runs 1 --preflight-only
```

Standalone `npm run preflight` вынести в явно помеченный legacy fixture
subsection и рядом объяснить, что его таблица с `helper` не описывает S5.

### 4. P1 — `s5:fresh` изменяет tracked deployment record, но README описывает только on-chain эффект

**Место:** `Reproducing the live S5 scenario`, строки 246–264.

**Что неочевидно:** текст говорит «Deploy a new Deals/Credit pair», но не говорит,
что команда после preflight отправляет deployment-транзакцию и переписывает
tracked `deployments/creditcoin.json`: текущая пара переносится в
`previousDeals`, а новая становится `deals`/`credit`. После запуска чистый clone
становится dirty. Это важный побочный эффект даже для testnet и особенно важен
при повторном запуске или прерывании сразу после deployment.

**Что добавить/переформулировать:** перед командой явно перечислить два эффекта:
необратимо создаётся новая testnet-пара и обновляется tracked deployment record.
Указать, какой diff ожидаем, где сохраняется предыдущая пара и что делать с
локальным deployment diff после воспроизведения.

### 5. P1 — recovery-инструкция требует недокументированного способа найти и проверить deal

**Место:** `Reproducing the live S5 scenario`, строки 263–274.

**Что неочевидно:** при сбое предлагается «inspect the on-chain deal first» и
передать `0x<deal-id>`, но README не объясняет:

- где взять primary deal id после оборванного запуска;
- какой RPC/explorer/call использовать для проверки;
- какие статусы допустимы для resume.

Реализация принимает только primary deal в `FINANCED` либо уже закрытый
`PAID_ON_TIME`; для остальных статусов команда отказывается. Кроме того,
`data/live/s5-*.{log,json}` записываются только в самом конце успешной команды.
При сбое после транзакции durable-файла с deal id может не быть, несмотря на
предшествующую формулировку о «complete console transcript».

**Что добавить/переформулировать:** привести точную команду/ссылку для получения
deal id из `DealCreated`, команду чтения `getDeal`, расшифровку статусов и явную
матрицу «состояние → можно ли `s5:resume`». Отдельно уточнить, что log/JSON
создаются только при успехе, либо изменить runner так, чтобы transcript
стримился на диск с начала запуска.

### 6. P2 — первый пошаговый обзор S5 пропускает обязательную impostor-транзакцию

**Место:** `Reproducing the live S5 scenario`, строки 257–264; недостающий шаг
объяснён только в строках 355–361.

**Что неочевидно:** абзац начинается с «The script performs…» и выглядит как
полная последовательность, но между настоящим funding и ожиданием attestation
скрипт ещё отправляет от B отдельную unauthorized funding self-transfer, строит
для неё proof и проверяет `REJECTED_PERMANENT / WRONG_INVESTOR`. Это означает
дополнительную подписанную Sepolia-транзакцию, allowance и gas, которые становятся
видны читателю только примерно через сто строк.

**Что добавить/переформулировать:** включить impostor funding и его ожидаемый
результат в первый пошаговый обзор; поздний абзац оставить как объяснение, зачем
используется self-transfer.

### 7. P2 — README одновременно утверждает, что credentials читаются только из `.env`, и разрешает shell variables

**Место:** `Setup`, строки 164–166; `Reproducing the live S5 scenario`, строки
218–223.

**Что неочевидно:** фраза «`.env` … is the only place credentials are ever read
from» противоречит последующей инструкции экспортировать
`DEPLOYER_PRIVATE_KEY` и `BORROWER_PRIVATE_KEY` в shell без project-local `.env`.
Код фактически читает `process.env`, куда dotenv лишь дополнительно загружает
файл.

**Что добавить/переформулировать:** заменить на точное утверждение: «`.env` —
единственный credential file, который автоматически читает проект; те же
переменные можно безопасно передать через process environment». Для local
build/test отдельно сказать, что ни `.env`, ни credentials не требуются.

### 8. P2 — показанные network-команды не везде снимают запрещённый TLS override

**Место:** `Setup`, строки 168–171; `Building and testing`, строки 182–187;
`Measuring the live network`, строки 417–429.

**Что неочевидно:** README говорит, что каждый network script отказывается
работать при `NODE_TLS_REJECT_UNAUTHORIZED=0`, и советует использовать
`env -u NODE_TLS_REJECT_UNAUTHORIZED`. Однако показанные команды
`npm run capture:fixtures`, `npm run probe` и
`NODE_USE_ENV_PROXY=1 npm run probe` не содержат этого префикса. Все эти скрипты
импортируют общий TLS guard и при таком parent environment завершаются до сетевой
проверки. В окружении этого аудита переменная действительно была равна `0`, так
что расхождение не теоретическое.

**Что добавить/переформулировать:** во всех network command blocks использовать
одинаковый безопасный запуск. Proxy-вариант должен одновременно включать proxy и
снимать override, например:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED NODE_USE_ENV_PROXY=1 npm run probe
```

### 9. P3 — нет зафиксированного tested toolchain и ожидаемого масштаба тестов

**Место:** `Setup`, строки 147–159; `Building and testing`, строки 173–180.

**Что неочевидно:** Node ограничен только снизу, а `foundryup` всегда ставит
текущий stable. Сегодня это воспроизводится, но позднее reader не сможет отличить
регрессию проекта от несовместимости нового Forge. `npm test` примерно 150 секунд
ничего не печатал отдельными интервалами и использовал 128,000 calls на каждый
инвариант; без краткого ожидания это можно принять за зависание.

**Что добавить/переформулировать:** назвать проверенные версии без обязательного
жёсткого pin (на этой ревизии Node `22.22.1`, Forge `1.7.1`, Solc `0.8.28`) и
краткий success baseline: 53 compiled files, 141 Solidity tests, 3 script tests,
`typecheck` без вывода, ориентировочно 2–3 минуты для `npm test` на обычной машине.

## Внутренняя согласованность адресов

Расхождений не найдено.

| README | Deployment record | Результат |
|---|---|---|
| Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `deployments/sepolia.json.token` | совпадает |
| Gateway `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` | `deployments/sepolia.json.gateway` и `deployments/creditcoin.json.sourceGateway` | совпадает |
| Verifier `0xAf07fCFe36079bD37E94f40f928EE8b088f56B47` | `deployments/creditcoin.json.verifier` | совпадает |
| Deals `0x80a9AE89DaD31A5AB5b3a6374F8159544ba59485` | `deployments/creditcoin.json.deals` | совпадает |
| Credit `0x13AEC440a6cA605974Af15a9ef5B77EBC1442480` | `deployments/creditcoin.json.credit` | совпадает |
| DoubleFundingFixture `0x014B96AB1E09b4F041451787F62A244fA9c180E6` | `deployments/sepolia.json.doubleFundingFixture` | совпадает |

Также совпадают chain ids: Creditcoin3 Testnet `102031` и Sepolia `11155111`.

## Сверка с прошлым аудитом в `docs/STATUS.md`

Пункты, перечисленные под заголовком «Аудит README глазами нового человека» за
2026-08-20, не продублированы как новые находки:

- точный USDC address указан;
- faucet-маршруты для ETH/USDC/CTC указаны;
- имена `DEPLOYER_PRIVATE_KEY` и `BORROWER_PRIVATE_KEY` указаны;
- автоматический approve и ручной allowance failure объяснены;
- `fresh` и `continue` разделены, state drift объяснён.

Эти пять пунктов действительно присутствуют в текущем README. Однако соседнее
утверждение о защищённом symlink-пути для `wallets:create` не соответствует
реализации; оно вынесено отдельно как находка 2, а не как повтор уже закрытого
пункта.

## Что сознательно не выполнялось

Не запускались `wallets:create`, `preflight`, `s5:fresh`, `s5:continue`,
`s5:resume`, `capture:fixtures`, `capture:gate`, `probe`, `verify:live` и любые
другие команды, читающие live RPC или отправляющие testnet-транзакции. `.env`,
ключи, `deployments/` и `worker/` не изменялись.
