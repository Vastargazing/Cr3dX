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

## Networks

| Role | Network | Chain id |
|---|---|---|
| Credit layer, deployment target | Creditcoin3 Testnet | 102031 |
| Settlement, source chain | Ethereum Sepolia | 11155111 |

Sepolia's identifier inside Creditcoin is a `chainKey` assigned by the on-chain
registry, which is not the EVM chain id. It is resolved at runtime; see
[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md).

## Repository layout

```
contracts/       Solidity sources
  interfaces/    the Attestcoin precompiles, transcribed from the runtime
  libraries/     decoding of proven source transactions
test/            Foundry tests
  fixtures/      transaction blobs captured from live Sepolia
scripts/         TypeScript tooling: network probe, fixture capture, deployment
  lib/           shared clients for the precompiles and the proof builder
worker/          proof worker: watches the gate, waits for attestation, submits
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

Network measured, contract foundation in place: the precompile interfaces and the
decoder for proven source transactions, tested against live blobs. The Sepolia gate
is next. Running detail is in [docs/STATUS.md](docs/STATUS.md).
