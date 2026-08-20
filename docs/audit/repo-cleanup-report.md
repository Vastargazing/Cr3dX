777c05fb2e2757974beb3e55041dd9da9180ee29 — Отчёт снят с репозитория на этом коммите; при мёрже выполнить `git log --oneline 777c05fb2e2757974beb3e55041dd9da9180ee29..HEAD -- .` и повторить применимые проверки для изменившихся путей.

# Чистка репозитория перед сабмитом

Дата проверки: 2026-08-20. В snapshot — 115 tracked entries; secret-поиск
охватил 37 commits, достижимых через локальные refs на момент проверки. Живые
сетевые команды не запускались.

## 1. `personal/logo/Image Aug 18, 2026, 11_34_51 AM.png`

**Что проверено:** проверка пропущена по прямому указанию владельца репозитория от
2026-08-20: владелец подтвердил, что это его проектный логотип, и попросил сразу
перейти к пункту 2. Файл не открывался; его история, ссылки и визуальное содержимое
в рамках этого таска не анализировались.

**Что найдено:** решение владельца снимает исходный вопрос о постороннем файле.
Никаких изменений файла не сделано.

**Рекомендация:** оставить без изменений. Если позже потребуется переименование
для публичного использования, это отдельное решение владельца, не cleanup этого
аудита.

## 2. Секреты и приватные данные

**Что проверено:**

- все tracked text-файлы текущего HEAD;
- патчи всей достижимой истории через `git log --all --full-history -p` с
  редактированным выводом;
- полное содержимое каждого достижимого commit через `git rev-list --all` и
  `git grep` по каждой ревизии — это отдельно закрывает случаи, которые могли не
  появиться в обычном diff merge-коммита;
- история имён файлов на `.env`, `.key`, `.pem`, SSH key, keystore и wallet JSON;
- high-confidence паттерны приватных ключей, PEM/OpenSSH keys, seed/mnemonic
  phrases, Slack tokens, AWS access keys, GitHub tokens, OpenAI tokens, JWT,
  generic secret/token/password assignments, credentials в URL, Infura/Alchemy
  keys в endpoint и query-string API keys.

Совпадения потенциальных значений намеренно не печатались: фильтр выводил бы
только commit, path и тип секрета.

**Что найдено:** ни в HEAD, ни в достижимой истории high-confidence совпадений
нет. Единственный environment-файл в истории — `.env.example`; реальный `.env`,
private-key file, keystore или wallet JSON в git не появлялся. `.env.example`
содержит только публичные testnet endpoints, адрес тестового токена и пустые
закомментированные поля ключей.

Это pattern-based проверка, а не математическое доказательство отсутствия любого
произвольного high-entropy значения. При этом она охватывает заданные паттерны и
дополнительные распространённые credential formats.

**Рекомендация:** переписывать историю или ротировать credentials по результатам
этой проверки не требуется. Сохранить `.env`, `.env.local`, `*.key` и `*.pem` в
`.gitignore`; перед финальным push при желании повторить тот же scan на merge
commit.

## 3. Артефакты сборки и временные файлы

**Что проверено:** tracked paths для `node_modules/`, `dist/`, `*.tsbuildinfo`,
корневых Foundry `out/`, `cache/`, `broadcast/`, `.DS_Store`, `.idea/`,
`.vscode/`, а также суффиксов `~`, `.bak`, `.swp`, `.orig`.

**Что найдено:** вывод пустой — ни один такой файл не tracked. Все заданные
категории уже покрыты `.gitignore`: Node, TypeScript, Foundry, editor и OS
правила присутствуют. Anchored Foundry rules не скрывают `scripts/lib/`, а
Solidity dependencies остаются git submodules, как задумано.

**Рекомендация:** изменений не требуется. Текущие правила `.gitignore` оставить.

## 4. Логи и JSON-отчёты вне `data/`

**Что проверено:** все tracked `*.log`, все tracked `*.json` вне
`data/live/` и `data/probe/`, а также имена с `debug`, `dump`, `output`,
`console`, `transcript`, `trace`, `.tmp`, `.temp`, `.trace`, `.output` вне этих
evidence-каталогов.

**Что найдено:** tracked `*.log` вне `data/` отсутствуют. Случайных console dumps
или временных отчётов по именам не найдено. Остальные JSON относятся к четырём
осознанным классам:

- `package.json`, `package-lock.json`, `tsconfig.json` — package/tooling config;
- `deployments/*.json` — защищённые live deployment records;
- `test/fixtures/**/*.json` — зафиксированные decoder/gateway fixtures;
- `docs/verification/v0.4.8-phase-b/**/*.json` — Phase B verification corpus,
  aggregate reports и manifest. Они явно связаны из
  `docs/verification/v0.4.8-phase-b/README.md`; corpus также закреплён checksum в
  `phase-b0/b0-manifest.md`.

**Рекомендация:** ничего не удалять. Все найденные JSON имеют документированную
роль; `data/live/` и `data/probe/` не изменять.

## 5. Пустые/сиротские директории и мёртвые ссылки

**Что проверено:**

- локальные inline/reference Markdown links в `README.md` и во всех
  `docs/**/*.md`, с разрешением пути относительно исходного файла;
- tracked filesystem symlinks и их targets;
- zero-byte tracked files, `.gitkeep` и каталоги, выводимые из tracked paths;
- пустые директории в чистом клоне, исключая `.git`, `node_modules` и содержимое
  git submodules.

**Что найдено:** проверено 23 локальных Markdown targets, отсутствующих — 0.
Tracked symlinks, zero-byte files, `.gitkeep`, tracked empty/orphan directories и
пустые project directories в чистом клоне отсутствуют.

В рабочем checkout инструменты создали пустые `.agents/`, `agent/` и `.codex/`.
Они не tracked, не представлены в git tree, не влияют на `git status` и в чистом
клоне отсутствовали; это локальный контекст среды, а не содержимое проекта.

**Рекомендация:** изменений не требуется. Не добавлять placeholder-файлы ради
локальных tool directories.

## 6. Свежая проверка после чистого clone и `npm ci`

**Что проверено:** отдельный clone с `--recurse-submodules` в `/tmp`, затем
detached checkout точного snapshot
`777c05fb2e2757974beb3e55041dd9da9180ee29` и
`env -u NODE_TLS_REJECT_UNAUTHORIZED npm ci`.

**Что найдено:** npm установил 67 packages, audit сообщил 0 vulnerabilities.
После установки `git status --short --untracked-files=all` остался пустым;
`git status --ignored` показал только ожидаемый `node_modules/`. `package.json` и
`package-lock.json` не изменились. Все recursive submodules были на записанных
commits.

Во время проверки remote `main` продвинулся до `dd170871b5d57dee3d49e8efd0f2bf99a85618c5`
после merge веток первых двух аудитов. Диапазон от snapshot добавляет только
`docs/audit/readme-audit.md` и
`docs/audit/attestcoin-integration-summary.md`; они не входят в содержимое этого
snapshot-отчёта и должны быть учтены merge-time командой из первой строки.

**Рекомендация:** `.gitignore` менять не нужно. Перед merge выполнить команду из
hash-шапки; если диапазон по-прежнему содержит только два audit-файла, повторять
build-artifact и secret scan для остального дерева не требуется, достаточно
просмотреть эти два добавленных файла.

## Итог

Однозначного мусора для удаления не найдено. Ветка содержит только этот отчёт;
`personal/logo/`, `.env.example`, `deployments/`, `data/live/`, `data/probe/`,
`worker/` и git submodules не изменялись.
