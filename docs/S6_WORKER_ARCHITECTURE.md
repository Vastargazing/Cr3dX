# S6 worker architecture

The sole normative input is commit
`8759a1649b489e0d7d0a163471063d908813b589`, whose
`docs/S6_WORKER_SPEC.md` has SHA-256
`901628b5c8dbaab23fd09e6fa0b8a0b5ed6df5b05d65ba484df87911798289fc`.
This implementation changes no contract and has no worker-only authority.

## Components

- `worker/chain.ts` is the production adapter for Sepolia receipts, the
  Attestcoin proof builder and the public Creditcoin ABIs.
- `worker/engine.ts` owns admission, reconciliation, scheduling and the single
  global write lane.
- `worker/state.ts` owns schema validation and crash-safe JSON replacement.
- `worker/policy.ts` contains deterministic state, retry, simulation and fee
  decisions.
- `worker/cli.ts` exposes operator commands. `worker/launch.sh` acquires the
  kernel lock before it reads a secret or starts Node.

The worker calls only `submitAndApply` for one source transaction and
`applyEvidence` for one evidence ID. It does not call a batch method or an
administrative method.

## Persistent model

Schema version 1 uses:

```text
stateDir/
  worker-state.json
  worker.lock
  tasks/<sha256(sourceChainId:transactionHash)>.json
```

`worker-state.json` contains the source cursor, enrollment history, bootstrap
signer identity and global attention reasons. Each task has a `logical` section
and at most one `inFlight` envelope. Inclusion state, destination contract state
and automation state are separate fields. Old source inclusions are append-only
history; their event nonces and evidence IDs are never rewritten into a new
inclusion.

A submission envelope snapshots the exact evidence-ID set and source block hash
represented by its signed calldata. A reorganization may replace the current
inclusion, but receipt and semantic reconciliation of that envelope continue
against the snapshotted IDs. Application envelopes resolve their evidence record
from current or historical inclusions.

Files are written as mode `0600` temporary siblings, flushed, renamed and then
followed by a directory flush. The state and task directories must be `0700`.
Temporary orphan names are ignored. On read, an envelope's stored hash is
recomputed from its exact raw bytes. More than one in-flight task is corruption.

The logical section never contains proof bytes. A proof is fetched for one new
submission attempt and discarded unless it has already become calldata inside a
signed exact envelope. The envelope stores its full maximum fee liability; after
two destination blocks confirm the canonical receipt, the same atomic task write
replaces that reservation with the actual receipt fee.

### Schema policy

There is no implicit migration. A reader accepts only schema version 1 and fails
closed on another version. A future schema requires a separately reviewed,
backup-first offline migration that preserves task IDs, inclusion history,
operation history and unresolved raw envelopes byte for byte. Deleting the state
directory is not a migration and does not authorize bootstrap with the same
signer.

## Source admission and reorganization

Scanning restarts at `max(sourceStartBlock, cursor - 100)` in inclusive windows
of at most 1,000 blocks. `eth_getLogs` is only a candidate index. Admission reads
the complete canonical receipt, requires `status == 1`, confirms every reported
candidate is present and ABI-decodes every verifier-relevant gateway log.

Admission is whole-transaction. Every relevant deal must be enrolled for that
source height, and the 32-event and 1,000-nonterminal-task limits must fit before
the cursor advances. An entirely unenrolled transaction is durably skipped. A
mixed enrollment or a candidate/receipt contradiction stops cursor advancement.

For a same-hash re-inclusion, the full receipt is decoded again. The prior array
becomes `SUPERSEDED`; height, transaction index, receipt ordinal, gateway nonce
and every expected evidence ID are rebuilt. Removal before destination work
creates an `ORPHANED` tombstone. Reorganization after signing or destination
recording preserves all evidence and the envelope and raises attention.

## Reconciliation and nonce safety

Before signing, all expected IDs must be all absent or all present. Mixed
visibility is a worker-global invariant failure. The signer latest and pending
nonces must both equal the nonce derived from bootstrap plus confirmed local
operation history.

Signing produces this ordering:

1. simulate the exact sender/destination/value/calldata;
2. estimate gas and populate final fee fields;
3. enforce estimate, final gas, fee, rolling budget and balance-reserve caps;
4. sign locally and compute the transaction hash;
5. atomically persist exact bytes and their maximum liability;
6. only then call the broadcast RPC.

Once step 5 occurs, no other task can sign. Timeout, restart, external semantic
success and `seen == false` cannot create another signature. The saved bytes are
broadcast at least once and are the only bytes eligible for rebroadcast. Semantic
success and nonce resolution remain independent until the exact hash has a
canonical receipt plus two later destination blocks.

Before every first broadcast or exact-byte rebroadcast, signer nonces must remain
compatible with the envelope (`latest == N`, `pending == N` or `N + 1`). Any
other observation raises worker-global attention without rewriting unrelated task
states. The exact receipt, when present, remains authoritative for resolution.

The six-hour envelope window never resets. Expiry preserves the bytes and keeps
`BLOCKED_BY_GLOBAL_LANE(taskId, nonce)` active for operator action. There is no
automatic gas bump, cancellation or same-nonce replacement.

## Pending evidence

After a complete evidence set appears, each evidence ID is reconciled through
`evidenceStateOf`. Terminal results remain terminal. For pending evidence the
worker stores the relevant deal prerequisite snapshot. A change can create a new
independent six-hour application epoch; time spent merely pending consumes no
epoch. This is how a repayment recorded before funding becomes eligible after
funding, including across restart.

## Security boundary

The entrypoint does not import dotenv. Signing requires explicit `file` or
`manager` mode. File mode resolves a regular external file, rejects a checkout
target, requires worker ownership and `0600`, and requires its containing
directory to be worker-owned without group/other write permission. Manager mode
uses only the inherited environment. Logs and inspection redact raw envelope
bytes and never contain private keys or proof bytes.
