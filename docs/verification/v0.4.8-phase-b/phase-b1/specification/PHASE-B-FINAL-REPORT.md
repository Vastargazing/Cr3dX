# Cr3dX v0.4.8 Phase B final replay report

Date: 2026-08-20

## Outcome

`Phase B: 63/63 matched`

- `Phase B independent-core: 16/16 matched`
- `Phase B specification-prescribed: 47/47 matched`

The 16 independently-derived traces are the stronger evidence group because
their scenarios were derived independently of the implementation. The 47
specification-prescribed traces were prescribed by the same specification to
both the reference model and the implementation and therefore provide less
independent evidence. The two groups are reported separately for that reason.

## Evidence groups

| Group | Matched | Aggregate SHA-256 |
| --- | ---: | --- |
| independently-derived | 16/16 | `8ab5f54b155dd8266f0024fca76ddaa683b0841d277210ed560b1f989101d252` |
| specification-prescribed | 47/47 | `09dd0e35c74c39f79d19c13fa09979ceaab528a7f5f02878e4d76833ac073615` |

The independently-derived group consists of the accepted `Replay_000` pilot
and the subsequent 15-trace sequential run. None of those 16 traces was
rerun while executing the specification-prescribed group.

## Execution controls

The 47 specification-prescribed traces ran in their exact sealed relative
order. Each result was completed and checked before the next trace was
materialized. There was no parallel replay.

For every trace, the runner enforced:

- exactly one active adapter and one active replay trace;
- pinned implementation HEAD
  `1a308816ab3b73056718f6f174c47c10f9fb8cd3` in detached state;
- Phase A/B0, sealed corpus, manifest, adapter, config, solc guard and helper
  SHA-256 checks;
- no active compiler process and exclusive runner/compiler locks;
- `MemAvailable >= 6 GiB` and `SwapFree >= 1 GiB` before execution;
- one foreground `forge`, one `solc`, and `--threads 1`;
- a systemd scope with `MemoryHigh=3G`, `MemoryMax=4G`,
  `MemorySwapMax=1G`, and `OOMPolicy=continue`;
- persisted stdout, stderr, process statuses, GNU time, cgroup
  `memory.peak`, unit status, replay postcondition, compilation unit and unit
  cleanup state before proceeding.

The runner encountered no semantic mismatch, adapter failure, compiler
incident, environment incident or resource refusal.

## Result audit

Across all 63 accepted trace result directories:

- 63/63 runner exit statuses are zero;
- 63/63 compiler/test exit statuses are zero;
- 63/63 replay postconditions are one;
- 63/63 cgroup `MemoryPeak` values were persisted;
- minimum recorded cgroup `MemoryPeak`: 237,940,736 bytes;
- maximum recorded cgroup `MemoryPeak`: 479,408,128 bytes;
- maximum GNU-time resident set size: 461,856 KiB.

For the 47 specification-prescribed result directories specifically:

- 47/47 contain a `MATCHED` marker;
- 47/47 expected and actual 41-file compilation units match;
- 47/47 unit-status queries succeeded with `Result=success` and inactive
  final unit state;
- 47/47 unit cleanup postconditions are one;
- no `STOPPED.txt` marker exists.

After completion, no `forge`, `solc`, or `solc-0.8.28` process remained.

## Integrity anchors

- specification manifest:
  `227cc619bb7c8b0e71760a00cdf2a24b2b6d9c624ac2cb26a1d79224a5882c82`
- specification sequential runner:
  `cdd2de5a205e88bd4ff0859f55469a21711ad5c0226901e163e35624e5798694`
- scoped helper:
  `dd4af98042888ffacf9195065d9c6275b5b6e0ebce509e971f9220c6f70d817b`
- solc guard:
  `2314ce6e1380faae6615694c9aafbaa019c657a3ce7271315e79c81cbbb7bd05`
- replay Foundry config:
  `39fe6173671b5c428f2e2a34feafed7deee6f8f514c6567e264037a38222c11c`
- adapter:
  `f1a9efb5141f98c523a945f60e50a8484ccf4ba297c7c7976078e807b77686ed`
- sealed corpus:
  `728190bf6473eb9864c15aa754e6d9ec41406ae6e36a783f4a9ae40108af9979`
- specification aggregate:
  `09dd0e35c74c39f79d19c13fa09979ceaab528a7f5f02878e4d76833ac073615`
- specification completion marker:
  `f4ed858904293c1cc00d8114711e2dd1511adec4dbd0c9a2cb569299b890f97f`

## Isolation

The implementation clone's only tracked diff is the authorized replay-only
profile in `foundry.toml`. There is no tracked diff under `contracts/` or the
existing implementation tests/helpers. Replay sources, fixtures, manifests,
runners and results remain in the pre-authorized untracked Phase B paths.

The production checkout at `/media/va/DATA/code_driveD/Cr3dX` has no tracked
working-tree diff from this work. No implementation fix or integration change
was made during replay.
