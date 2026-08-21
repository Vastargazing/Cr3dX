# Cr3dX

**Verified cross-chain credit layer.** Money moves on Ethereum Sepolia. Credit
state lives on Creditcoin. The only thing that connects them is the Attestcoin
Protocol: no relayer, no oracle, no trusted backend.

Built for BUIDL CTC 2026 Fall, RWA track.

---

## What it does

Invoice financing is the first use case, not the product. A borrower opens a deal
against an invoice. A designated investor funds it in Sepolia, sending USDC
straight to the borrower with no escrow in between. Creditcoin learns that the
funding happened only when a proof of the Sepolia transaction passes through the
Attestcoin `BlockProver` precompile. Repayment works the same way in reverse, and
the credit outcome that follows is a consequence of proven facts rather than of
anyone's assertion.

The design separates two things that are usually conflated:

- **where value moves** - Sepolia, directly between the two parties;
- **where credit truth lives** - Creditcoin, as canonical state and history.

Take Attestcoin out and Cr3dX cannot tell whether a deal was funded, whether it
was repaid, or whether it came due. That is the test the integration is built to
pass.

## Trust boundary

Stated plainly, because a credit product that overstates its guarantees is worse
than one that has none.

**Proven cryptographically:** the source transaction was included and succeeded,
a genuine event came from the configured Gateway, the attested source height
passed the deadline, and the credit outcome follows from those facts. The ERC-20
transfer follows from verified Gateway code, which emits only after successful
`transferFrom`; it is not established directly by the Attestcoin proof.

**Not proven, and not claimed:** that the invoice is real, that the claim is
legally enforceable, or who the borrower is. *Invoice authenticity and legal
enforceability are outside the v0.1 trust boundary.*

**No enforcement.** There is no collateral and no escrow. The investor carries
the full risk of non-repayment; their protection is the borrower's reputational
record.

**No Sybil resistance.** *Cr3dX score is address-level verified repayment
reputation, not Sybil-resistant creditworthiness.*

## Networks and addresses

| Role | Network | Chain id |
|---|---|---|
| Credit layer, deployment target | Creditcoin3 Testnet | 102031 |
| Settlement, source chain | Ethereum Sepolia | 11155111 |

Sepolia's identifier inside Creditcoin is a `chainKey` assigned by the on-chain
registry, which is not the EVM chain id. It is resolved at runtime; see
[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md).

### The asset

```
Sepolia USDC   0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238   6 decimals
```

**Read that address, not the symbol.** More than one token on Sepolia calls itself
USDC with six decimals. The gateway accepts exactly this one, fixed at deployment
and unchangeable afterwards. A transfer of a different USDC will succeed at the
token and produce no gateway event at all, which looks like a broken bridge and is
not one. Test tokens for this address come from https://faucet.circle.com.

The deployment script refuses to run if the configured address does not report the
expected symbol and decimals. That check protects the operator from a typo; it is
not a security boundary, because a symbol is not an identifier. The security
anchor is the address.

### Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `Cr3dXGateway` | Ethereum Sepolia | [`0x11DD8a4c790939DEa8CED631dB27Afe54334a749`](https://sepolia.etherscan.io/address/0x11DD8a4c790939DEa8CED631dB27Afe54334a749) |
| `Cr3dXVerifier` | Creditcoin3 Testnet | `0xED64f6157408f211dda43649129EaC1F73161093` |
| `Cr3dXDeals` | Creditcoin3 Testnet | `0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC` |
| `Cr3dXCredit` | Creditcoin3 Testnet | `0x4a66732cA5B7f081585693332C79e636CE9c05C8` |
| `DoubleFundingFixture` | Ethereum Sepolia | `0x014B96AB1E09b4F041451787F62A244fA9c180E6` |

An earlier verifier at `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` was superseded
and is kept in `deployments/creditcoin.json` with the reason. It landed on the
same address as the Sepolia gateway, because the same account deployed each as
its first transaction on its chain and a contract address derives from the
deployer and its nonce. That is legal and confusing: a verifier misconfigured
with the gateway's address would have looked identical to a correct one. The
deployment script now refuses such a collision outright.

Its facts are still on chain, and the redeployed verifier reproduced every
evidence identifier byte for byte, because an identifier is a hash of the source
fact rather than of the contract that recorded it.

An earlier registry at `0x52B54F4aC836C5b32fFec72a2f03f1C22174B756`, with its
credit layer, is kept in `deployments/creditcoin.json` with the reason. It
enforced the rules of specification v0.4.2, which refused funding from the
designated investor once the threshold had been crossed. That refusal made the
funded total depend on the order proofs arrived in, so v0.4.4 removed it, and a
registry cannot be migrated: its deals, reserves and credit history are its
state.

`Cr3dXCredit` was deployed by `Cr3dXDeals`, in the registry's own constructor.
The two need each other's addresses, and the usual answer to that circle is an
initialiser that some privileged address may call once. The moment such an
address exists, *no role, including the deployer, can change a status, a proof,
an outcome or a reserve* stops being true, and that sentence is the product. So
the credit layer's owner is fixed at construction and there is no setter to
point it anywhere else.

`DoubleFundingFixture` is test infrastructure and not part of the system. It
exists to produce one transaction that an externally owned account cannot: two
gateway events plus a counterfeit, all in one call.

The same addresses are recorded in `deployments/`, which the scripts read.

## Repository layout

```
contracts/       Solidity sources, the production perimeter
  Cr3dXGateway   the Sepolia end: moves tokens, emits a provable fact
  Cr3dXVerifier  the Creditcoin end: the only door an external fact comes through
  Cr3dXDeals     the registry: what a proven fact means for a deal
  Cr3dXCredit    score, limit, reserve, exposure, canonical outcomes
  interfaces/    the Attestcoin precompiles, transcribed from the runtime
  libraries/     decoding of proven source transactions
test/            Foundry tests
  helpers/       test infrastructure, never part of the system
  fixtures/      transactions captured from live Sepolia, with their proofs
scripts/         TypeScript tooling: network probe, fixture capture, deployment
  lib/           shared clients for the precompiles and the proof builder
worker/          proof worker: watches the gate, waits for attestation, submits
deployments/     live addresses, committed
docs/            specification, protocol reconnaissance, integration notes, status
data/probe/      raw measurement output, committed as evidence
data/live/       live end-to-end runs with their measured gas, committed
```

Contracts and their tests are built with Foundry, because the specification calls
for invariant fuzzing. Scripts, deployment and the worker are TypeScript on ethers
v6, which is also what the protocol SDK is written in.

## Setup

Requires Node.js 20 or newer and Foundry.

```sh
git clone --recurse-submodules https://github.com/Vastargazing/Cr3dX.git
cd Cr3dX
env -u NODE_TLS_REJECT_UNAUTHORIZED npm ci
curl -L https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup
export PATH="$HOME/.foundry/bin:$PATH"
cp .env.example .env
```

If you already cloned without submodules, `git submodule update --init --recursive`
fetches the Solidity dependencies.

The S1-S5 scripts read the git-ignored checkout-local `.env`. The S6 worker does
not: its launcher requires an explicit external checked file or an inherited
secret-manager environment. `.env.example` documents both sets of variable
names without containing a key. Public defaults are enough for the read-only
probe and all local tests.

If your parent shell exports `NODE_TLS_REJECT_UNAUTHORIZED=0`, remove it. Every
network script refuses to run while global certificate verification is disabled.
For a shell you do not control, prefix the command with
`env -u NODE_TLS_REJECT_UNAUTHORIZED`, as in the live commands below.

## Building and testing

```sh
npm run build         # forge build
npm test              # forge test
npm run test:scripts  # node --test over the tooling's own logic
npm run test:worker   # deterministic S6 worker coverage, no network or keys
npm run typecheck     # tsc --noEmit over the TypeScript side
```

The decoder tests run against transaction blobs captured from live Sepolia rather
than against blobs written by hand. To refresh them:

```sh
npm run capture:fixtures
```

The capture reads expected values from `eth_getTransactionReceipt` and cross-checks
them against the attested blob before writing anything, so a fixture can only be
written if the protocol's encoding and Ethereum's own receipt agree.

## S6 permissionless proof worker

S6 is implemented as an untrusted liveness component under `worker/`. It watches
complete canonical gateway receipts, waits for a fresh Attestcoin proof, submits
through the public `submitAndApply` method and revisits individual pending facts
through public `applyEvidence`. It adds no role or contract method and performs no
cross-task batching.

The normative implementation input is commit
`8759a1649b489e0d7d0a163471063d908813b589`. Operator setup, explicit bootstrap,
deal enrollment and exact-envelope recovery are documented in
[the S6 runbook](docs/S6_WORKER_RUNBOOK.md). The persistent model and nonce
safety argument are in [the architecture note](docs/S6_WORKER_ARCHITECTURE.md),
and the 46-point deterministic coverage map is in
[the test matrix](docs/S6_WORKER_TEST_MATRIX.md).

The shortest local inspection path is:

```sh
export CR3DX_WORKER_STATE_DIR="$HOME/.local/state/cr3dx-worker"
npm run worker -- status
```

Signing-capable commands must go through `worker/launch.sh` (the `npm run worker`
scripts do). The launcher acquires a non-blocking kernel lock before reading a
secret. File mode requires an external regular file owned by the worker user with
mode `0600`, inside a worker-owned non-writable-by-others directory. Manager mode
requires direct inherited injection. Neither mode loads `.env` or calls
`wallets:create`.

No live S6 operation is authorized by the presence of this implementation. The
configured Creditcoin contracts are an exact fresh v0.4.8 deployment; worker
state-changing use still stops for `РАЗРЕШАЮ S6 LIVE`.

## Reproducing the live S5 scenario

Everything below runs against live testnets. Nothing here is mocked.

**What you need first.** Two disposable testnet-only EVM wallets. A is the
deployer/investor; B is the borrower/payer. Keep the secret file outside the
checkout and expose it through the git-ignored `.env` symlink. This is the
recommended layout even when the checkout's filesystem supports Unix modes: the
repository can move or be deleted without moving the keys with it.

For a new checkout on Linux, create the private target before generating wallets:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm ci
mkdir -p ~/.config/cr3dx
chmod 700 ~/.config/cr3dx
touch ~/.config/cr3dx/.env
chmod 600 ~/.config/cr3dx/.env
ln -s ~/.config/cr3dx/.env .env
npm run wallets:create
npm run build
# Fund the two printed public addresses, then run the complete acceptance:
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:fresh
```

`wallets:create` follows the symlink, verifies that its target is mode `0600`,
and puts both generated private keys there as `DEPLOYER_PRIVATE_KEY` and
`BORROWER_PRIVATE_KEY`. If the target filesystem cannot enforce private Unix
permissions, it refuses before generating a key. It prints only the public
addresses. For an existing pair, populate the protected target yourself or
export the two variables in the shell; no project-local regular `.env` is needed.

Fund the public addresses that the command prints:

- Sepolia ETH: choose a currently listed faucet from
  [ethereum.org's Sepolia network page](https://ethereum.org/en/developers/docs/networks/#sepolia);
- Circle test USDC: [faucet.circle.com](https://faucet.circle.com), selecting
  Ethereum Sepolia and token address
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`;
- Creditcoin test CTC: use the EVM-address flow in the
  [official Creditcoin faucet guide](https://docs.creditcoin.org/wallets/using-testnet-faucet).

The current live anchors are explicit, because a symbol or a deployment-file
name is not an identifier:

| Object | Address |
|---|---|
| Sepolia USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `Cr3dXGateway` | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |
| `Cr3dXVerifier` | `0xED64f6157408f211dda43649129EaC1F73161093` |
| current `Cr3dXDeals` | `0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC` |
| current `Cr3dXCredit` | `0x4a66732cA5B7f081585693332C79e636CE9c05C8` |

There are two deliberately different modes:

```sh
# Deploy a new Deals/Credit pair, assert score 500 and empty history/reserve/
# exposure, then execute two consecutive complete runs without intervention.
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:fresh

# Keep the recorded Deals/Credit state and execute one more accumulating run.
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:continue
```

Both are one-command paths. The script performs approvals when needed, creates
the deal, sends real Sepolia funding A to B, waits with visible attestation
progress, builds a fresh proof immediately before `submitAndApply`, observes
`FINANCED`, repays B to A, waits and proves again, observes `PAID_ON_TIME`, then
opens a second deal and deliberately leaves it in `CREATED`. It prints status,
all deal sums, reserve, exposure, score, total limit and available limit after
every step. It also writes the complete console transcript and a machine-readable
JSON report to `data/live/s5-<mode>-<timestamp>.{log,json}`.

Writes are signed locally and their transaction hashes are known before the RPC
call. If `eth_sendRawTransaction` times out, the script checks that hash and may
rebroadcast only the identical raw transaction. It never guesses by sending a new
logical operation. If an older run stopped after a confirmed primary step, inspect
the on-chain deal first and resume that explicit deal only:

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED npm run s5:resume -- 0x<deal-id>
```

Preflight is part of the same command and sends nothing until every blocker has
passed. For two runs B must already hold at least 0.2 USDC. It prints both finite
run capacities from live state:

```text
balance runs = floor(B USDC balance / 0.1 USDC)
reserve runs = floor(available credit limit / 1.1 USDC)
```

Every run permanently leaves one 1.1 USDC reserve, spends 0.1 USDC of B's own
balance, and adds an on-time outcome until the score reaches its ceiling. This is
expected state drift, not a cleanup bug. `fresh` is the only mode in which the
first score transition is deterministically 500 to 525; `continue` reports and
uses whatever history is already on chain.

**`preflight` sends nothing** and is safe to run at any point. It projects the
whole USDC chain step by step from the balances actually on chain and prints
where the run would stop:

```
step                                               A         B    helper
start                                            1.0       0.1       0.0
fund: A pays B                                   0.0       1.1       0.0
repay: B pays A                                  1.1       0.0       0.0
double funding: A supplies the helper            0.1       0.0       1.0
double funding: helper pays B twice              0.1       1.0       0.0
```

Only 1.1 USDC of new money is ever needed for the whole run, because the money
circulates: A pays B 1.0, B pays A back 1.1, and A reuses that to drive the
double-funding fixture.

That circulation is also why a half-finished run is dangerous to restart. It
leaves the tokens sitting in B, which any "does each account hold enough" check
reports as *A needs more USDC*, advice that spends a faucet cooldown while your
own tokens sit one wallet away. Preflight recognises the exact state each stage
leaves behind, says which one it matches, and tells you to move the tokens back
instead. `capture:gate` runs the same check and refuses to send anything on
balances that do not look like a clean start.


The two-run `s5:fresh` command starts with these conservative faucet targets:

| Wallet | Sepolia ETH | Circle test USDC | Creditcoin test CTC |
|---|---:|---:|---:|
| A, deployer and investor | 0.02 | 1.0 | 0.02 |
| B, borrower and payer | 0.005 | 0.2 | 0 (the script tops it up) |

B's CTC is only needed for `createDeal`, since the borrower opens the deal.
The live script tops B up from A when it is short: A holds the CTC, and a transfer
between two wallets you already control is cheaper than a faucet round trip in
the middle of a demo. `preflight` says which of the two will happen.

The S5 USDC minimums use the actual order of the demo: A funds B with 1.0 USDC,
B adds 0.1 of its own balance and repays 1.1 USDC to A, so A can fund the next
run with the returned funds. B therefore needs 0.2 USDC of its own for two runs.
ETH and CTC values are deliberate gas safety budgets.

Separately, the older `preflight`/`capture:gate` fixture path reuses the returned
funds for its 0.4 + 0.6 USDC double-funding fixture. That reuse is enforced, not
assumed: `preflight` executes the balance arithmetic, while `capture:gate` waits
for the successful fund receipt and checks B has at
least 1.1 USDC before repayment, then waits for the repayment receipt and checks
A has at least 1.0 USDC before approving and calling the helper. Confirmed
allowances are read back from the token before the next transaction is sent.

`npm run verify:live` is the claim the project stands on, executed rather than
asserted: a real Sepolia transaction, a freshly built Attestcoin proof, on-chain
verification, and one immutable fact per genuine gateway event, with a lookalike
event in the same transaction ignored. It fetches proofs fresh every run and
never replays stored continuity proofs. Roughly twenty minutes is a practical
freshness target for keeping proofs short, not an expiry deadline for the fact:
within the observed window, older facts re-anchor to checkpoints with a newly
built proof. Creditcoin Team says checkpoints stay forever under the current
runtime storage policy and archive nodes retain the cryptographic evidence needed
for a future fresh proof; these are operational policies, not immutable protocol
guarantees. See
[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md).

`npm run s5:continue` is the same claim carried through to a credit outcome. B
opens a deal, A funds it on Sepolia, B also sends a funding for the same deal
which nothing entitles B to do, both are proven and applied in one Creditcoin
transaction each, B repays, and the deal closes as `PAID_ON_TIME` with the score
and the limit moving. The impostor funding lands in `REJECTED_PERMANENT` with
`WRONG_INVESTOR`; it is a self-transfer, so it demonstrates the refusal without
moving any money. The scenario also leaves a second unfunded deal reserved.
Measured gas, native test ETH/CTC spent, both attestation waits, per-run time and
total wall time are written to `data/live/` with the run. No USD conversion is
made.

The reference `s5:fresh` run of 2026-08-20 completed two consecutive runs in
38m20s. Funding/repayment attestation waits were 7m01s/7m10s and 8m44s/9m16s.
Score moved 500 → 525 → 550, final exposure was zero, and the two deliberately
unfunded deals left 2.2 USDC reserved. Costs were measured, not estimated:

| Chain | Gas | Native test token spent |
|---|---:|---:|
| Sepolia | 672,978 | 0.000708508217397735 ETH |
| Creditcoin | 5,373,281 | 0.0026866405 CTC |

The complete transcript and machine-readable report are
`data/live/s5-fresh-2026-08-20T05-30-18-335Z.{log,json}`.

For comparison, the earlier one-run path of 2026-08-19 measured these individual
operations:

| Operation | Chain | Gas | Continuity roots |
|---|---|---:|---:|
| `createDeal` | Creditcoin | 259,548 | |
| `fund` | Sepolia | 59,292 | |
| `submitAndApply`, funding | Creditcoin | 334,222 | 10 |
| `submitAndApply`, refused funding | Creditcoin | 253,960 | 7 |
| `repay` | Sepolia | 59,260 | |
| `submitAndApply`, repayment | Creditcoin | 340,088 | 9 |

Applying a repayment costs more than applying a funding at a comparable proof
size, because it writes more: two accumulators, the exposure, and the canonical
outcome with its counters. The refused funding is the floor: verification plus
one cold write recording the decision.

**Both gateway functions spend an allowance.** `fund` and `repay` move tokens with
`transferFrom`, so the token must be approved for the gateway address first. The
scripts do this for you; if you drive the contracts by hand and skip it, the call
reverts inside the token with an allowance error. That failure has nothing to do
with Attestcoin, and it is by far the most likely thing to go wrong when
reproducing the demo, so it is worth recognising on sight.

`npm run capture:gate` sends its transactions immediately and then waits in one
block for attestation to catch up, which takes roughly ten minutes: attestation
trails the Sepolia head by about seven minutes by design, and the proof builder's
own cache trails that. The wait is the protocol's reorg protection, not a stall.
Progress is printed each poll.

## Measuring the live network

Several protocol parameters are runtime state and cannot be read off the source:
the registry entry for Sepolia, how far attestation trails the source chain head,
and the real gas cost of a verification. The probe measures them against the live
testnet and writes the results into
[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md).

```sh
npm run probe
```

The run takes about fifteen minutes, most of it sampling attestation lag. Raw
results land in `data/probe/`.

If your machine reaches the internet through a proxy, Node has to be told to use
it, otherwise every request fails as a network detection timeout:

```sh
NODE_USE_ENV_PROXY=1 npm run probe
```

## Documentation

- [docs/cr3dx-spec-v0.4.0-final.md](docs/cr3dx-spec-v0.4.0-final.md) - the
  specification. Frozen; it changes only when the code proves it wrong.
- [docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md) - measured
  behaviour of the live protocol, and where it deviates from its documentation.
- [docs/PRECOMPILE_FINDINGS.md](docs/PRECOMPILE_FINDINGS.md) - reconnaissance of
  the protocol sources, with line references.
- [docs/S6_WORKER_SPEC.md](docs/S6_WORKER_SPEC.md) - accepted normative worker specification.
- [docs/S6_WORKER_RUNBOOK.md](docs/S6_WORKER_RUNBOOK.md) - bootstrap, enrollment,
  operation and exact-envelope recovery.
- [docs/STATUS.md](docs/STATUS.md) - running log of what works and what does not.

## Status

The whole credit path works end to end on live testnets, with nothing simulated
anywhere in it: a deal opened on Creditcoin, funded by a real Sepolia transfer,
proven through Attestcoin, financed, repaid, and closed as `PAID_ON_TIME` with
the borrower's score and limit moving as a consequence. A funding sent by an
address that is not the designated investor was refused permanently in the same
run, and a counterfeit gateway event in an earlier one was ignored because its
emitter was not the gateway.

The permissionless proof worker is implemented and deterministically covered
locally. Exact fresh v0.4.8 deployment provenance is established; its live
acceptance still requires separate authorization and a dedicated funded worker
signer. The demo interface follows after the worker's live cycle. Running detail,
transaction hashes and measured gas are in
[docs/STATUS.md](docs/STATUS.md).
