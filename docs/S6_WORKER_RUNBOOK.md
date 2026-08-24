# S6 worker runbook

This runbook is local-only until the exact live gate in the normative S6 spec is
completed. The implementation does not deploy contracts and must not assume the
S5 addresses are v0.4.8 deployments.

## 1. Configure state and secrets

Create a dedicated state directory and a separate secret directory on a
filesystem that enforces Unix permissions:

```sh
install -d -m 700 ~/.local/state/cr3dx-worker ~/.config/cr3dx-worker
install -m 600 /dev/null ~/.config/cr3dx-worker/worker.env
```

Put `CR3DX_WORKER_PRIVATE_KEY=0x...` in the external file. Use a dedicated
testnet signer with no unexplained pending nonce. Do not use a checkout-local
`.env`, its symlink, or `npm run wallets:create` for S6.

Export the public configuration shown in `.env.example`, including exact
v0.4.8 deployment addresses and non-zero gas, fee, rolling-budget and balance
caps. Then select one secret mode:

```sh
export CR3DX_WORKER_STATE_DIR="$HOME/.local/state/cr3dx-worker"
export CR3DX_WORKER_SECRET_MODE=file
export CR3DX_WORKER_ENV_FILE="$HOME/.config/cr3dx-worker/worker.env"
```

For a secret manager, inject `CR3DX_WORKER_PRIVATE_KEY` into the inherited
environment and set `CR3DX_WORKER_SECRET_MODE=manager`.

## 2. Bootstrap exactly once

Bootstrap is explicit and requires `latestNonce == pendingNonce`. It also checks
the configured verifier/deals/gateway/chainKey/topics through read-only calls.

```sh
npm run worker:bootstrap
```

Never bootstrap an empty directory merely because established state was lost.
Reconcile the dedicated signer nonce, all known transaction hashes and on-chain
evidence manually first. Restore a backup when possible.

## 3. Enroll deals

Ordinary enrollment reads the canonical source head and begins at `head + 1`:

```sh
npm run worker -- enroll 0xDEAL_ID
```

Retroactive work must be explicit and records the current head and reason:

```sh
npm run worker -- enroll 0xDEAL_ID --effective-from 12345678 --reason "audited pre-enrollment transfer"
npm run worker -- enrollments
```

Enrollment controls this worker's gas spending only. It creates no on-chain
privilege.

## 4. Inspect and run locally

```sh
npm run worker -- status
npm run worker -- list
npm run worker -- inspect TASK_ID
npm run worker -- attention
npm run worker:step
npm run worker -- run
```

`step` performs one backfill/reconciliation/scheduling pass. `run` repeats it.
Both can sign and broadcast when configured; do not invoke them against live
networks before the exact authorization phrase `РАЗРЕШАЮ S6 LIVE`. The phrase is
in the operator's own language and is matched literally, so that no paraphrase
can be mistaken for consent to spend real funds.

Status reports the global lane separately from task states:

```text
BLOCKED_BY_GLOBAL_LANE(ownerTaskId, nonce)
```

## 5. Recovery

Retry a logical operation only when there is no exact envelope:

```sh
npm run worker -- resume TASK_ID
```

If an envelope exists, `resume` refuses. Reconcile and resend only its stored
bytes:

```sh
npm run worker -- resume-broadcast TASK_ID
```

This command does not fetch a proof, change fees/calldata/nonce, reset the
six-hour deadline or sign. If an operator externally replaces or cancels the
nonce, the worker detects nonce drift and requires manual state reconciliation.

`advance TASK_ID` runs the ordinary public-method scheduler for one selected
task. It cannot bypass the global lane.

## 6. Attention checklist

- `MIXED_ADMISSION`: audit every gateway event in the complete source receipt;
  partial submission is impossible.
- `MIXED_EXPECTED_ID_VISIBILITY`: verify deployment addresses, ABI, source
  inclusion and `chainKey`; do not submit only missing IDs.
- `SOURCE_RECEIPT_CONTRADICTION`: compare `eth_getLogs` with a canonical complete
  receipt and stop advancing the cursor.
- `IN_FLIGHT_RESOLUTION_WINDOW_EXPIRED`: keep the exact envelope and nonce lane;
  decide whether to wait, exact-rebroadcast or intervene externally.
- `UNEXPECTED_SIGNER_NONCE`: inspect latest/pending nonce and external use of the
  dedicated signer. Do not clear the lane based on `seen` alone.
- fee/balance cap: raise a cap only through an explicit operator decision; no
  signature was created.

Back up the entire mode-`0700` state directory, including the persistent lock
pathname. The pathname is not ownership; the kernel lock is.

## 7. Live gate

Before live work, establish deployed bytecode/commit provenance for v0.4.8 and
prepare the complete preflight required by S6 section 18. Then stop for the exact
authorization. This implementation session performed no live RPC operation,
transaction, deployment or push.
