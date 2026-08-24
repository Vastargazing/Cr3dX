# Cr3dX v0.4.8 Phase B verification checkpoint

Date: 2026-08-20

This directory is a document-only post-release checkpoint for the independent
Phase B replay of Cr3dX specification v0.4.8 against the aligned production
implementation.

## Result and claim boundary

- Specification v0.4.8 commit:
  `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`.
- Implementation commit:
  `1a308816ab3b73056718f6f174c47c10f9fb8cd3`.
- Phase B: 63/63 traces matched.
- Independently-derived group: 16/16 matched.
- Specification-prescribed group: 47/47 matched.
- Semantic mismatches: 0.
- Maximum recorded cgroup `MemoryPeak`: 479,408,128 bytes.

The exact claim supported by this checkpoint is: **the independent model and
the implementation matched on the complete pre-sealed 63-trace corpus**. This
is not a formal proof of all behavior.

The 47 specification-prescribed traces were mandated by the same specification
to both the reference model and the implementation. They are therefore weaker
independent evidence than the 16 independently-derived traces, and the two
groups are reported separately.

The replay did not change the production implementation.

## Methodology

Phase A built the executable reference model and its trace design from the
sealed normative input package without access to `Cr3dXDeals` or `Cr3dXCredit`.
The frozen Phase A material, including its payload ledger and seal, is preserved
under [`phase-a/`](phase-a/); see the
[`freeze-manifest.md`](phase-a/freeze-manifest.md) and the original
[`verification-report.md`](phase-a/verification-report.md).

In Phase B0, the complete 63-trace expectation corpus was exported from the
frozen model and sealed before any implementation access. The seal records the
corpus split, exact oracle inputs and output hashes. See the
[`B0 manifest`](phase-b0/b0-manifest.md),
[`B0 report`](phase-b0/b0-report.md),
[`expectation corpus`](phase-b0/expectation-corpus.json) and
[`B0 seal`](phase-b0/b0-seal.sha256).

In Phase B1, the pre-sealed expectations were replayed against the implementation
pinned at the commit above. The independently-derived 16-trace group and the
specification-prescribed 47-trace group were aggregated separately. All 63
traces matched with no semantic mismatch. The included evidence is limited to
the top-level final artifacts: the
[`independent aggregate`](phase-b1/independent/aggregate-report.json),
[`independent completion marker`](phase-b1/independent/COMPLETE.txt),
[`final replay report`](phase-b1/specification/PHASE-B-FINAL-REPORT.md),
[`specification aggregate`](phase-b1/specification/aggregate-report.json),
[`specification completion marker`](phase-b1/specification/COMPLETE.txt), and the
[`sealed 47-trace manifest`](phase-b1/specification/manifest.json). Per-trace
compiler logs, caches and build output are intentionally excluded.

## Authority and integrity anchors

| Artifact or authority | SHA-256 or commit |
| --- | --- |
| Normative input package | `c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80` |
| Specification v0.4.8 commit | `cbc382b39fabd9a34b218fe6ff35699e18bdca4a` |
| Implementation commit | `1a308816ab3b73056718f6f174c47c10f9fb8cd3` |
| Phase A canonical payload ledger | `c79858076b9323d9aeb0344b50bd3a4ac7845397411559f3a49f6b8864628546` |
| Phase A freeze manifest | `74337c98d1deff88bdc54bf3b7627f4c7cafb11f1a0350f39728be60b91ad851` |
| B0 expectation corpus | `728190bf6473eb9864c15aa754e6d9ec41406ae6e36a783f4a9ae40108af9979` |
| B0 exporter | `af9f9d0dc007fa540930a9a61b6669c1e9c6096d973eac05d806c6c366fb8e44` |
| B0 manifest | `4c3d2da18f67b4d4de3476de48306790e7ff6b8f2510410878165889f0e904bf` |
| B0 report | `c4cf7b12c1bf9ca3ad620cb6f3d73422712f84c02b7960c3d6f36072d7468f29` |
| B1 independent aggregate | `8ab5f54b155dd8266f0024fca76ddaa683b0841d277210ed560b1f989101d252` |
| B1 independent completion marker | `9cffba7023382d4d6e7ab49513ed0cdb0c1bf181a71851db0df9878ad28656c4` |
| B1 final replay report | `673a94d799a4cd34293d97b36a443cbf19cda8cfff2fcf1f54c9d15eb7b5b00b` |
| B1 specification aggregate | `09dd0e35c74c39f79d19c13fa09979ceaab528a7f5f02878e4d76833ac073615` |
| B1 specification completion marker | `f4ed858904293c1cc00d8114711e2dd1511adec4dbd0c9a2cb569299b890f97f` |
| Sealed 47-trace specification manifest | `227cc619bb7c8b0e71760a00cdf2a24b2b6d9c624ac2cb26a1d79224a5882c82` |

The final replay report additionally records the following execution-integrity
anchors:

| Replay component | SHA-256 |
| --- | --- |
| Specification sequential runner | `cdd2de5a205e88bd4ff0859f55469a21711ad5c0226901e163e35624e5798694` |
| Scoped helper | `dd4af98042888ffacf9195065d9c6275b5b6e0ebce509e971f9220c6f70d817b` |
| solc guard | `2314ce6e1380faae6615694c9aafbaa019c657a3ce7271315e79c81cbbb7bd05` |
| Replay Foundry configuration | `39fe6173671b5c428f2e2a34feafed7deee6f8f514c6567e264037a38222c11c` |
| Replay adapter | `f1a9efb5141f98c523a945f60e50a8484ccf4ba297c7c7976078e807b77686ed` |

The byte-preserved file inventory can be independently verified from the Phase
A and B0 seals and the B1 top-level `manifest.sha256` files included alongside
the evidence. Every file in this directory verifies against those seals today:

```sh
cd docs/verification/v0.4.8-phase-b/phase-a
sha256sum -c freeze-seal.sha256
sha256sum -c <(sed -n '/^## Exact payload file hashes/,/^## Freeze assertions/p' \
               freeze-manifest.md | grep -E '^[0-9a-f]{64}  ')
cd ../phase-b0 && sha256sum -c b0-seal.sha256
```

## Why these files are not tidied up

The sealed manifests record the absolute filesystem paths of the isolated model
workspace on the machine where Phase A and B0 ran. Those paths are inputs to the
hashes above: rewriting them to something shorter would break every seal, and
recomputing the seals afterwards would silently replace evidence sealed before
implementation access with evidence produced after it. That is exactly the
property this checkpoint exists to prove, so the files stay byte-exact and the
paths stay as they were recorded.

For the same reason nothing under this directory is reformatted, relinted or
line-wrapped to match the rest of the repository.
