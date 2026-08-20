# Freeze manifest — Cr3dX v0.4.8 blind Phase A

## Authority and provenance

- Source specification commit (provenance label only):
  `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`
- Materialized package SHA-256:
  `c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`
- Specification version: `v0.4.8`
- Required invariant range: `INV-1` through `INV-22` (all present)

## Exact authority input list

One input artifact was used:

```text
/home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/cr3dx-v0.4.8-blind-normative-package.md
```

The provenance value above identifies its source specification; it was not used
to open a commit. No previous frozen blind artifact existed in this isolated
workspace, so there is no prior artifact/commit hash.

Runtime-only dependencies (`Python 3`, `pycryptodome`) execute the model and are
not normative inputs.

## Immutable snapshot identifier

The isolated directory did not contain a valid Git repository, so the freeze uses
an equivalent content-addressed identifier:

```text
cr3dx-v0.4.8-phase-a-sha256-ledger:c79858076b9323d9aeb0344b50bd3a4ac7845397411559f3a49f6b8864628546
```

It is the SHA-256 of the exact UTF-8 ledger below, including each newline, with
entries sorted bytewise by relative path. The manifest itself is excluded to
avoid a self-hash cycle; its independent SHA-256 is reported by the freeze seal
and handoff.

## Exact payload file hashes

```text
9feb983169162efc1e196dbfbf2e816c67015af469953f5fcd9b7c4b378d443c  README.md
7afa60a6340027c9869722610adde85cfd039ed6d986313706b26c15a78d02b0  ambiguity-report.md
7991cb53e9e2e06ca944ee30ad44df554d575ccba37610c2d8245b3950b7ca5a  delta-note.md
a82ec443f92486491e3d08591040fdbfe4617b116470d3e168acaf9431c2f330  invariant-coverage-matrix.md
774e6e757ace41d738e1745c607fe42f46cd3bc477ad4caa233f12654dd6ee3b  metamorphic-test-matrix.md
b195e3a42e1ab4ba39a6ee12ce6e6b34fa1c2e7cdd7514e6a8e97af9a9eab7ee  model/reference_model.py
e893421c298155b992d477c59ee5763af2886d6dda04f6d1b9dbfcf0b0d197d7  model/requirements.txt
87c21156ee83d2670779dbadc6a755a5d1147939b726f6be32ddd7ee3bdc45a9  model/run_harness.py
ad0757c3f2438af6d356f006f82eaf86adbb1df79a264610b7e9ce7afec55429  model/test_reference_model.py
a63b0f9255975575dfbc1b6b07bda1e053e99cd2cf03e491f049196c6ae24a7c  test-catalog.md
36c874f69aceaa260efff35c8503011d06b15348f083187d4a8fadbd8c8ee063  verification-report.md
```

## Freeze assertions

- Fresh v0.4.8 baseline; no prior freeze was modified.
- 22/22 invariants have full executable coverage records.
- Harness: 42 passed, 0 failed, 0 errors.
- Oracle-changing semantic ambiguities: none.
- Blind boundary remained intact relative to `Cr3dXDeals` and `Cr3dXCredit`.
- Phase A only; no production adapter, implementation test, deployment, or Phase B
  activity is included.

