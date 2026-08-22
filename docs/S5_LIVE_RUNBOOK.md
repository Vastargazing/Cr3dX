# Cr3dX S5 live testnet runbook

This runbook contains the state-changing S1-S5 workflow that used to live in the
root README. Everything here runs against live testnets; nothing is mocked.

Use disposable testnet-only wallets. Read the whole mode and recovery section
before sending a transaction. S6 worker operation is separate and documented in
[`S6_WORKER_RUNBOOK.md`](S6_WORKER_RUNBOOK.md).

## Credential boundary

Choose one credential mode; do not combine them into one setup sequence:

- keep a protected env file outside the checkout and expose it through the
  git-ignored `.env` symlink; or
- inject the same variables through the inherited process environment, with no
  project `.env` at all.

`.env` is the only credential file that S1-S5 tooling loads automatically. The
tooling ultimately reads `process.env`, so inherited variables are equally valid.
Before converting an existing checkout, inspect the path with `ls -ld .env`,
check whether it is non-empty, and verify the presence of the two credential
variable names without printing their values. Do not remove, overwrite or replace
an existing credential file until it has been backed up and its storage mode is
understood.

The S6 launcher never reads project `.env`; it has separate checked `file` and
inherited `manager` modes. Do not reuse the S1-S5 wallet setup for an S6 signer.

If the parent shell exports `NODE_TLS_REJECT_UNAUTHORIZED=0`, remove it. Every
network script refuses to run while global certificate verification is disabled.
The commands below use `env -u NODE_TLS_REJECT_UNAUTHORIZED` explicitly.

## Wallet setup

Two EVM wallets are required:

- A: deployer and designated investor;
- B: borrower and payer.

For a new Linux checkout, create the private target before generating wallets:

```sh
test ! -e .env && test ! -L .env || { ls -ld .env; echo 'Inspect the existing .env before continuing.'; false; }
mkdir -p ~/.config/cr3dx
chmod 700 ~/.config/cr3dx
touch ~/.config/cr3dx/.env
chmod 600 ~/.config/cr3dx/.env
ln -s ~/.config/cr3dx/.env .env
npm run wallets:create
npm run build
```

`wallets:create` treats persistence as a security boundary. A missing `.env` is
created atomically as a regular file. An existing regular file is updated through
a unique exclusive sibling and atomic rename, preserving valid keys and unrelated
content. For a symlink, the resolved regular target is updated atomically and the
checkout symlink is preserved.

On POSIX the command requires final mode `0600`, verifies target and sibling
directory ownership and permissions, probes private sibling creation and rename
before generating a key, and refuses unsafe, dangling, non-regular or
unresolvable targets. Windows is not a target platform for live-secret storage
and receives no POSIX owner or mode guarantee. Private keys are never printed.

For an existing pair, populate the protected target yourself or export
`DEPLOYER_PRIVATE_KEY` and `BORROWER_PRIVATE_KEY` in the inherited process
environment. A project-local regular `.env` is not required.

## Faucet targets

Fund the public addresses printed by `wallets:create`:

- Sepolia ETH: choose a current faucet from
  [ethereum.org's Sepolia page](https://ethereum.org/en/developers/docs/networks/#sepolia);
- Circle test USDC: use [faucet.circle.com](https://faucet.circle.com), select
  Ethereum Sepolia and token
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`;
- Creditcoin test CTC: use the EVM-address flow in the
  [official faucet guide](https://docs.creditcoin.org/wallets/using-testnet-faucet).

Conservative targets for the two-run `s5:fresh` path:

| Wallet | Sepolia ETH | Circle test USDC | Creditcoin test CTC |
|---|---:|---:|---:|
| A, deployer and investor | 0.02 | 1.0 | 0.02 |
| B, borrower and payer | 0.005 | 0.2 | 0; the script tops it up |

B needs CTC for `createDeal`. The live script transfers CTC from A when B is
short. The two-run USDC minimum follows the actual circulation: A funds B with
1.0 USDC, B adds 0.1 and repays 1.1 to A, so A can fund the next run with the
returned funds.

## Current live anchors

Read addresses, not symbols or deployment filenames:

| Object | Address |
|---|---|
| Sepolia USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |
| `Cr3dXVerifier` | `0xED64f6157408f211dda43649129EaC1F73161093` |
| current `Cr3dXDeals` | `0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC` |
| current `Cr3dXCredit` | `0x4a66732cA5B7f081585693332C79e636CE9c05C8` |

The scripts read the same anchors from `deployments/`.

## Read-only preflight

Run the integrated preflight for the exact selected mode before sending anything:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode fresh --runs 2 --preflight-only
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run deal:live -- --mode continue --runs 1 --preflight-only
```

The preflight checks every blocker before deployment or transaction submission.
For two runs B must already hold at least 0.2 USDC. It prints two finite capacities:

```text
balance runs = floor(B USDC balance / 0.1 USDC)
reserve runs = floor(available credit limit / 1.1 USDC)
```

## Fresh and continue modes

The modes have deliberately different state effects.

Before `fresh`, understand that it creates a new testnet Deals/Credit pair, sends
a Creditcoin deployment transaction, and changes tracked
`deployments/creditcoin.json`. The previous pair moves to `previousDeals`; the new
`deals` and constructor-created `credit` become current. A clean checkout is
expected to become dirty.

After success or interruption, inspect `git status --short` and
`git diff -- deployments/creditcoin.json`, confirm the deployment receipt and
addresses, and retain the diff as evidence or deliberately archive/discard it
only after review. Never lose an unexplained deployment diff.

```sh
# Deploy a fresh Deals/Credit pair and execute two complete runs.
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:fresh

# Keep the recorded Deals/Credit state and execute one accumulating run.
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:continue
```

Both are one-command paths. The script performs approvals when needed, creates a
deal and sends real Sepolia funding from A to B. B then sends a separate
unauthorized funding self-transfer. Its proof must end as
`REJECTED_PERMANENT / WRONG_INVESTOR`.

The valid funding proof produces `FINANCED`. B repays A, the script waits for a
fresh proof and observes `PAID_ON_TIME`, then creates a second deal and leaves it
in `CREATED`. It prints deal sums, reserve, exposure, score, total limit and
available limit after every step.

Only a successful command writes the final machine-readable JSON and complete
transcript to `data/live/s5-<mode>-<timestamp>.{log,json}`. A caught failure writes
only an `s5-failed-*.log`; a hard interruption may leave neither final artifact.

Writes are signed locally and their transaction hashes are known before the RPC
call. If `eth_sendRawTransaction` times out, the script checks that hash and may
rebroadcast only the identical raw transaction. It never guesses by sending a new
logical operation.

Every completed run permanently leaves one 1.1 USDC reserve, spends 0.1 USDC of
B's own balance and adds an on-time outcome until the score reaches its ceiling.
This is expected state drift. Only `fresh` makes the first score transition
deterministically 500 to 525; `continue` uses existing history.

## Recovery and resume

If a run stops after `createDeal`, use the printed deal ID if it is available.
Otherwise take the create-transaction hash, or find the borrower's transaction to
the recorded Deals address in the Creditcoin explorer, and inspect its
`DealCreated` receipt. The first indexed argument is the primary deal ID.

The following recovery commands are read-only:

```sh
export CREDITCOIN_RPC_URL="${CREDITCOIN_RPC_URL:-https://rpc.cc3-testnet.creditcoin.network}"
export DEALS_ADDRESS=0x<deals-address-from-deployments/creditcoin.json>
env -u NODE_TLS_REJECT_UNAUTHORIZED cast receipt 0x<create-tx-hash> --rpc-url "$CREDITCOIN_RPC_URL"
env -u NODE_TLS_REJECT_UNAUTHORIZED cast logs \
  --rpc-url "$CREDITCOIN_RPC_URL" --address "$DEALS_ADDRESS" \
  --from-block <creation-block> --to-block <creation-block> \
  'DealCreated(bytes32 indexed,address indexed,address indexed,uint256,uint256,uint64,uint96)'
```

Read the deal before deciding whether to resume:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED cast call "$DEALS_ADDRESS" \
  'getDeal(bytes32)((address,uint64,uint8,address,uint96,address,uint256,uint256,uint256,uint256,uint256))' \
  0x<deal-id> --rpc-url "$CREDITCOIN_RPC_URL"
```

The tuple fields are borrower, due block, numeric status, designated investor,
sequence, audit-only investor, required funding, funded amount, face value,
repaid amount and on-time repaid amount. Both allowed resume rows also require
the borrower and designated investor to match the configured wallets.

| Status | Meaning | `s5:resume` |
|---:|---|---|
| 0 | `NONE`, unknown deal | refused |
| 1 | `CREATED`, funding not applied | refused |
| 2 | `FINANCED` | allowed only with non-zero outstanding debt; sends repayment and finishes the run |
| 3 | `DEFAULTED` | refused |
| 4 | `PAID_LATE` | refused |
| 5 | `PAID_ON_TIME` | allowed only with the matching on-time outcome and zero debt; creates only the reserved second deal |

The resume command is state-changing. Run it only for an explicitly inspected,
eligible deal:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:resume -- 0x<deal-id>
```

The receipt and explorer remain the recovery source of truth because a process
kill can occur before a durable transcript exists.

## Legacy fixture path

The standalone fixture preflight is read-only, but it is not the integrated S5
preflight above:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run preflight
```

Its related capture is state-changing:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run capture:gate
```

The legacy path projects this circulation:

```text
step                                               A         B    helper
start                                            1.0       0.1       0.0
fund: A pays B                                   0.0       1.1       0.0
repay: B pays A                                  1.1       0.0       0.0
double funding: A supplies the helper            0.1       0.0       1.0
double funding: helper pays B twice              0.1       1.0       0.0
```

Only 1.1 USDC of new money is needed because it circulates. A half-finished run
can leave the tokens in B while a simple balance check reports that A is short.
The preflight recognises exact intermediate states and tells the operator to move
existing tokens back instead of wasting a faucet cooldown.

`capture:gate` first runs the same gate and refuses balances that do not look like
a clean start. After the gate passes it sends the historical fixture
transactions. It waits for confirmed allowances and receipts before each next
step. Its helper output is never the preflight for `s5:fresh` or `s5:continue`.

## Related live checks and evidence

Both gateway functions use `transferFrom`; approve the gateway first when driving
contracts manually. The scripts perform approvals. An allowance revert is a token
setup failure, not an Attestcoin failure.

`capture:gate` and proof submission can wait roughly ten minutes while attestation
catches up. The delay is protocol reorg protection, not by itself a stall.

For a fresh source-transaction proof and immutable-fact check:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run verify:live
```

Protocol measurements, proof freshness and retention boundaries are in
[`ATTESTCOIN_INTEGRATION.md`](ATTESTCOIN_INTEGRATION.md). Accepted transaction
hashes, timing, gas, score transitions and superseded deployments are in
[`STATUS.md`](STATUS.md). Machine-readable runs and transcripts are in
`data/live/`.
