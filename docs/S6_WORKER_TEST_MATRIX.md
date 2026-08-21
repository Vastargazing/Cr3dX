# S6 deterministic acceptance matrix

The test names carry coverage numbers. `npm run test:worker` executes the files
below without network access, secrets or live transactions.

| # | Deterministic evidence |
|---:|---|
| 1 | `engine.test.ts`: duplicate delivery; `state.test.ts`: stable task ID. |
| 2 | `chain.test.ts` and `engine.test.ts`: multiple receipt-local events. |
| 3 | `engine.test.ts`: persisted cursor and 100-block restart overlap. |
| 4 | `state.test.ts`: fsync/rename replacement and ignored orphan temporary. |
| 5 | `engine.test.ts`: restart while waiting creates no premature epoch. |
| 6 | `engine.test.ts`: injected failure after fresh proof, inclusion mismatch and restart; no proof persisted. |
| 7 | `engine.test.ts`: restart from persisted signed-before-broadcast envelope. |
| 8 | `engine.test.ts`: timeout after broadcast leaves exact envelope. |
| 9 | `engine.test.ts`: one lane blocks both submission and ready application work. |
| 10 | `engine.test.ts`: blocked task cannot sign the later nonce; unexpected latest/pending drift blocks exact rebroadcast globally. |
| 11 | `engine.test.ts`: every rebroadcast byte string equals the stored raw string. |
| 12 | `engine.test.ts`: restarted engine resumes the unknown outcome without signing. |
| 13 | `engine.test.ts`: precomputed ID and all-seen recovery without local receipt completion. |
| 14 | `engine.test.ts`: all-false read under an envelope produces no alternative signature. |
| 15 | `engine.test.ts`: receipt observed before completion write, then finalized. |
| 16 | `policy.test.ts` and `engine.test.ts`: closed selector/string table, missing revert data and inconsistent `EvidenceAlreadyRecorded` fail closed. |
| 17 | `engine.test.ts`: expired underpriced envelope remains and no bump is signed. |
| 18 | `state.test.ts`: proof absent from logical JSON, raw envelope exception preserved. |
| 19 | `engine.test.ts`: external complete-set semantic win keeps the original task/lane. |
| 20 | `engine.test.ts`: repayment stays pending while the deal is only created. |
| 21 | `engine.test.ts`: restart then funding prerequisite change creates application work. |
| 22 | `policy.test.ts`: elapsed six-hour ceiling and deadline-clamped backoff. |
| 23 | `engine.test.ts`: manual resume creates an audited fresh epoch. |
| 24 | `engine.test.ts`: resume refuses unresolved in-flight bytes. |
| 25 | `engine.test.ts`: resume-broadcast emits only stored bytes, including after envelope-window expiry. |
| 26 | `launcher.test.ts`: live kernel lock excludes a second process. |
| 27 | `engine.test.ts`: runtime 10/10 drift is warning-only; unreadable/mismatched startup fails. |
| 28 | `engine.test.ts`: reconnect overlap delivers no duplicate task/event. |
| 29 | `engine.test.ts`: canonical source removal/re-inclusion paths. |
| 30 | `chain.test.ts`: production worker source has no batch/admin/worker-only call. |
| 31 | `policy.test.ts`: APPLIED/PENDING/REJECTED mixed aggregate and counts. |
| 32 | `policy.test.ts`: all-false, all-true and forbidden mixed visibility. |
| 33 | `engine.test.ts`: external success cannot release an unbroadcast or broadcast envelope. |
| 34 | `policy.test.ts` and `engine.test.ts`: independent late application epoch. |
| 35 | `engine.test.ts`: restart, automatic rebroadcast and post-expiry operator rebroadcast never change the first-broadcast deadline. |
| 36 | `engine.test.ts`: two-block depth and receipt disappearance before depth. |
| 37 | `chain.test.ts` and `engine.test.ts`: full same-hash re-decode, changed IDs, post-sign/seen incidents, different-hash replacement and immutable history. |
| 38 | `enrollment.test.ts`, `engine.test.ts`, `policy.test.ts`: effective height, explicit retroactivity, task/event caps and fee caps. |
| 39 | `launcher.test.ts` and `state.test.ts`: forced-death lock reacquisition and multi-lane corruption. |
| 40 | `state.test.ts`: missing established state refuses implicit bootstrap. |
| 41 | `launcher.test.ts` and `chain.test.ts`: explicit file/manager modes, inert key-file parsing, checkout rejection and no dotenv/wallets path. |
| 42 | `engine.test.ts`: mined revert uses receipt status plus semantic reads, never a selector. |
| 43 | `policy.test.ts`, `state.test.ts`, `engine.test.ts`: final liability reservation becomes actual fee. |
| 44 | `policy.test.ts` and `engine.test.ts`: lane overlay leaves unrelated evidence state unchanged. |
| 45 | `engine.test.ts`: successful application post-state table: applied, rejected, pending; unseen fails closed. |
| 46 | `chain.test.ts` and `engine.test.ts`: reported candidate status/presence/shape contradiction stops cursor. |

Ranges grouped into one crash/restart harness still assert each precondition and
postcondition named above. Contract suites remain separate and unchanged.
