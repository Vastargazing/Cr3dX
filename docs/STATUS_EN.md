# Cr3dX current status

## Status and authority

Snapshot date: 2026-08-24. Last behavioral commit on `main`:
`229d084efd898e16526699da8988de88af9bf1b5`. Everything committed after it is
documentation, packaging and presentation: the English specification, this
status file, the workflow rendering, the submission deck and the pre-submission
editorial pass. No contract, test or deployment changed.

[`STATUS.md`](STATUS.md) is the complete Russian chronological source journal.
It preserves implementation, deployment, acceptance and editorial history, with
the newest entry first. This file is a compact, non-normative English index of
the current state. It is not a translation and must not become a second ledger.

[`CR3DX_SPEC_V0.4.8_EN.md`](CR3DX_SPEC_V0.4.8_EN.md) is the complete public
English specification. The Russian v0.4.8 file remains the immutable input used
by the completed Phase A/B verification chain. Its commit is
`cbc382b39fabd9a34b218fe6ff35699e18bdca4a`, and the normative package SHA-256 is
`c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`.
[`SPEC_DIGEST_EN.md`](SPEC_DIGEST_EN.md) is a shorter non-normative guide. An
independent specification-side review closed four earlier digest boundary and
wording findings without finding a new semantic defect.

## Current implementation and deployment

Cr3dX uses the following current deployment:

| Contract | Network | Chain ID | Address |
| --- | --- | ---: | --- |
| `Cr3dXGateway` | Ethereum Sepolia | 11155111 | `0x11DD8a4c790939DEa8CED631dB27Afe54334a749` |
| `Cr3dXVerifier` | Creditcoin3 Testnet | 102031 | `0xED64f6157408f211dda43649129EaC1F73161093` |
| `Cr3dXDeals` | Creditcoin3 Testnet | 102031 | `0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC` |
| `Cr3dXCredit` | Creditcoin3 Testnet | 102031 | `0x4a66732cA5B7f081585693332C79e636CE9c05C8` |

The Gateway moves Sepolia USDC and emits source events. The Verifier records
proven source facts. Deals classifies and applies evidence, and Credit stores the
paired credit state. Canonical addresses, deployment transactions, previous
deployments and constructor parameters are in the tracked
[`Sepolia`](../deployments/sepolia.json) and
[`Creditcoin`](../deployments/creditcoin.json) ledgers.

## Independent verification

The v0.4.8 Phase B replay matched all `63/63` sealed traces with zero semantic
mismatches:

- `16/16` independently-derived traces;
- `47/47` specification-prescribed traces.

Phase A built the model without access to the Deals or Credit implementation.
Phase B0 exported and sealed all expectations before implementation access, and
Phase B1 replayed them against implementation commit
`1a308816ab3b73056718f6f174c47c10f9fb8cd3`. The 47 prescribed traces provide
less independent evidence because the same specification prescribed them to
both sides. See the [Phase B checkpoint](verification/v0.4.8-phase-b/README.md),
the [B0 seal and report](verification/v0.4.8-phase-b/phase-b0/b0-report.md), and
the [final replay report](verification/v0.4.8-phase-b/phase-b1/specification/PHASE-B-FINAL-REPORT.md).

## S6 live acceptance

The accepted S6 run intentionally submitted repayment before funding. The
repayment was verified on Creditcoin and remained `VERIFIED_PENDING` while the
deal was still `CREATED`. After funding was proven and applied, the worker used
the targeted `applyEvidence` path to apply the stored repayment without another
source proof.

The required external-submission race was won by a second wallet. The worker
reconciled the complete on-chain `seen` set and created `0` signatures and `0`
broadcasts for the race task. The primary deal ended `PAID_ON_TIME`; score moved
from `500` to `525`, exposure was `0`, and both funding and repayment evidence
were applied. Full hashes, blocks, gas, timing and saved task observations are in
the [2026-08-21 S6 entry in the source journal](STATUS.md) and the English
[Attestcoin integration digest](audit/attestcoin-integration-summary.md#s6-v048-acceptance).

## Dashboard

The dashboard is read-only. Its frozen accepted S6 snapshot is rendered
separately from optional live public-RPC observation, and a failed refresh cannot
rewrite snapshot evidence. It has no wallet, signing path or backend. See
[`ui/`](../ui/) and its [local instructions](../ui/README.md).

## Verified baseline

The latest recorded local baseline is:

- Foundry `141/141`, including `8/8` invariant/property suites and 896,000
  handler calls;
- TypeScript `10/10` file suites, 89 tests;
- `npm run typecheck`, `npm run ui:typecheck`, `npm run test:ui` (`15/15`) and
  `npm run ui:build` completed successfully.

During edits, `npm run check:quick` runs the Foundry suites without the stateful
invariant file, the TypeScript suites and the type check. Before handoff, run the
full baseline sequentially:

```sh
npm test
npm run test:scripts
npm run typecheck
npm run ui:typecheck
npm run test:ui
npm run ui:build
```

This document-only change does not rerun that baseline.

## Open protocol questions

- The tariff for `verifyAndEmit` and its `LOG3` remains an upstream open
  question. The 2026-08-19 measurement observed no difference from `verify`,
  while the Creditcoin Team's preliminary interpretation is that the event
  should be charged.
- The exact semantics of the proof builder's `cached` response field remain
  undocumented. A fresh client request does not establish whether the service
  recomputed a proof or returned a server-side cached result.

These are boundaries of current knowledge about upstream behavior, not known
Cr3dX defects.

## Detailed sources

- [Russian chronological source journal](STATUS.md)
- [Complete English specification](CR3DX_SPEC_V0.4.8_EN.md)
- [English specification digest](SPEC_DIGEST_EN.md)
- [Frozen Russian Phase B input](cr3dx-spec-v0.4.0-final.md)
- [Attestcoin integration measurements and source notes](ATTESTCOIN_INTEGRATION.md)
- [Phase B verification checkpoint](verification/v0.4.8-phase-b/README.md)
- [S5 live runbook](S5_LIVE_RUNBOOK.md)
- [S6 worker runbook](S6_WORKER_RUNBOOK.md)
- [English audit index](audit/README.md)
