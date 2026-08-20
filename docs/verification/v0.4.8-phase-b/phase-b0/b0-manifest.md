# Cr3dX v0.4.8 Phase B0 expectation-seal manifest

## Specification and frozen-parent seals

- Specification provenance: `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`
- Specification version: `v0.4.8`
- Normative package SHA-256:
  `c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`
- Phase A payload snapshot:
  `c79858076b9323d9aeb0344b50bd3a4ac7845397411559f3a49f6b8864628546`
- Phase A manifest SHA-256:
  `74337c98d1deff88bdc54bf3b7627f4c7cafb11f1a0350f39728be60b91ad851`

The Phase A harness passed 42 tests before export and 42 tests after export. The
three hashes above matched both before and after.

## Exact input list

All paths below are read-only Phase A authority or its original materialized
normative input.

```text
c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/cr3dx-v0.4.8-blind-normative-package.md
74337c98d1deff88bdc54bf3b7627f4c7cafb11f1a0350f39728be60b91ad851  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/freeze-manifest.md
a82ec443f92486491e3d08591040fdbfe4617b116470d3e168acaf9431c2f330  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/invariant-coverage-matrix.md
774e6e757ace41d738e1745c607fe42f46cd3bc477ad4caa233f12654dd6ee3b  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/metamorphic-test-matrix.md
a63b0f9255975575dfbc1b6b07bda1e053e99cd2cf03e491f049196c6ae24a7c  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/test-catalog.md
b195e3a42e1ab4ba39a6ee12ce6e6b34fa1c2e7cdd7514e6a8e97af9a9eab7ee  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/model/reference_model.py
ad0757c3f2438af6d356f006f82eaf86adbb1df79a264610b7e9ce7afec55429  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/model/test_reference_model.py
87c21156ee83d2670779dbadc6a755a5d1147939b726f6be32ddd7ee3bdc45a9  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/model/run_harness.py
e893421c298155b992d477c59ee5763af2886d6dda04f6d1b9dbfcf0b0d197d7  /home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/cr3dx-v0.4.8-phase-a/model/requirements.txt
```

`requirements.txt` is recorded as a runtime dependency input, not normative
authority. No other oracle or implementation source was used.

## Output hashes before manifest sealing

```text
af9f9d0dc007fa540930a9a61b6669c1e9c6096d973eac05d806c6c366fb8e44  export_expectations.py
728190bf6473eb9864c15aa754e6d9ec41406ae6e36a783f4a9ae40108af9979  expectation-corpus.json
c4cf7b12c1bf9ca3ad620cb6f3d73422712f84c02b7960c3d6f36072d7468f29  b0-report.md
```

The manifest's own SHA-256, together with all four required artifact hashes, is
recorded in `b0-seal.sha256` to avoid a self-hash cycle.

## Corpus counts

- Total traces: 63
- Total ordered actions: 250
- Expected named-failure actions: 25
- Metamorphic traces: 37
- Fixed seeds: `0`, `7`, `42`

By provenance:

```text
independently_derived  16
spec_prescribed       47
```

By ordered evidence class:

```text
independently_derived_metamorphic_permutations          12
two_phase_funding_before_repayment                       6
classification_decision_time_and_explicit_re_evaluation 8
accounting_boundaries                                   21
named_errors_and_atomicity                              11
specification_prescribed_mandatory_cases                 5
```

Every representable Phase A metamorphic row is linked. M01–M05 and M08–M16 are
explicit relation rows; M06 (no implicit retry) and M07 (funding/repayment
delivery) are retained as provenance links on the split-delivery traces rather
than duplicated as semantically identical traces.

## Commands run

Commands are recorded by semantic purpose; every invocation used only the frozen
Phase A directory or the new B0 output directory.

```text
sha256sum <normative-package>
sha256sum freeze-manifest.md
find <phase-a> ... | sha256sum                 # canonical Phase A payload ledger
rg <provenance-and-version> freeze-manifest.md
PYTHONDONTWRITEBYTECODE=1 python3 run_harness.py  # before export: 42/42
PYTHONDONTWRITEBYTECODE=1 python3 export_expectations.py
jq <corpus-count-and-shape-validation> expectation-corpus.json
rg <raw-id-and-forbidden-path-patterns> expectation-corpus.json export_expectations.py
PYTHONDONTWRITEBYTECODE=1 python3 run_harness.py  # after export: 42/42
sha256sum freeze-manifest.md
find <phase-a> ... | sha256sum                 # after-export payload ledger
sha256sum <normative-package>
sha256sum export_expectations.py expectation-corpus.json
PYTHONDONTWRITEBYTECODE=1 python3 export_expectations.py  # determinism rerun
sha256sum export_expectations.py expectation-corpus.json
sha256sum <exact Phase A oracle inputs>
```

The exporter additionally validates unique trace IDs, contiguous step indices,
per-step call/state/scope presence, declared economic equivalence classes, and
metamorphic-row coverage before writing JSON.

## Blind-boundary declaration

No path, clone, worktree, cached checkout, source excerpt, implementation test,
build artifact, commit, or diff for the `Cr3dXDeals` or `Cr3dXCredit`
implementation was opened, searched, statted, hashed, listed, or otherwise
inspected. No implementation memory or external-agent memory was used. Phase A
was not modified.

No Foundry adapter was created, no replay was performed, and Phase B1 was not
started. This manifest seals Phase B0 only.

