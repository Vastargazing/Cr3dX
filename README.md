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

**Proven cryptographically:** the funding transfer happened, the repayment
happened, the deadline passed, and the credit outcome follows from those facts.

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

Live addresses are recorded in `deployments/sepolia.json` and in
[docs/STATUS.md](docs/STATUS.md) as they are deployed.

## Repository layout

```
contracts/       Solidity sources, the production perimeter
  Cr3dXGateway   the Sepolia end: moves tokens, emits a provable fact
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
```

Contracts and their tests are built with Foundry, because the specification calls
for invariant fuzzing. Scripts, deployment and the worker are TypeScript on ethers
v6, which is also what the protocol SDK is written in.

## Setup

Requires Node.js 20 or newer and Foundry.

```sh
git clone --recurse-submodules https://github.com/Vastargazing/Cr3dX.git
cd Cr3dX
npm install
curl -L https://foundry.paradigm.xyz | bash && foundryup
cp .env.example .env
```

If you already cloned without submodules, `git submodule update --init --recursive`
fetches the Solidity dependencies.

`.env` is git-ignored and is the only place credentials are ever read from. The
defaults in `.env.example` point at public endpoints and are enough to run the
probe and the test suite, both of which are read-only and need no key.

## Building and testing

```sh
npm run build      # forge build
npm test           # forge test
npm run typecheck  # tsc --noEmit over the TypeScript side
```

The decoder tests run against transaction blobs captured from live Sepolia rather
than against blobs written by hand. To refresh them:

```sh
npm run capture:fixtures
```

The capture reads expected values from `eth_getTransactionReceipt` and cross-checks
them against the attested blob before writing anything, so a fixture can only be
written if the protocol's encoding and Ethereum's own receipt agree.

## Reproducing the Sepolia side

Everything below runs against live testnets. Nothing here is mocked.

**What you need first.** A Sepolia account with test ETH for gas, and test USDC
from https://faucet.circle.com for the address printed above. Put that account's
private key in `.env` as `DEPLOYER_PRIVATE_KEY`. The key is read from `.env` and
nowhere else, is never printed, and `.env` is git-ignored.

```sh
npm run build
npm run deploy:gateway    # checks the token, then deploys Cr3dXGateway
npm run capture:gate      # approve, fund, repay, and prove all of it
npm run deploy:verifier   # deploys Cr3dXVerifier to Creditcoin
npm run verify:live       # the whole path, end to end, nothing simulated
```

`npm run verify:live` is the claim the project stands on, executed rather than
asserted: a real Sepolia transaction, a freshly built Attestcoin proof, on-chain
verification, and one immutable fact per genuine gateway event, with a lookalike
event in the same transaction ignored. It fetches proofs fresh every run and
never replays the ones stored in the fixtures, because a continuity proof stops
verifying once the attestation it anchors to has been pruned. See
[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md).

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
- [docs/STATUS.md](docs/STATUS.md) - running log of what works and what does not.

## Status

Network measured, the Sepolia gateway and the Creditcoin verifier written and
tested. The deals registry and credit layer are next. Running detail is in
[docs/STATUS.md](docs/STATUS.md).
