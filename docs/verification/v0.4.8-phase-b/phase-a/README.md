# Cr3dX v0.4.8 blind Phase A freeze

This snapshot is blind relative to the `Cr3dXDeals` and `Cr3dXCredit`
implementation. It is an independent reference model derived from the supplied
v0.4.8 normative package. The factual public ABI of the already accepted
`Cr3dXVerifier` was supplied inside that package as an allowed input.

## Input gate

- Package: `cr3dx-v0.4.8-blind-normative-package.md`
- Package SHA-256: `c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80`
- Source-specification provenance: `cbc382b39fabd9a34b218fe6ff35699e18bdca4a`
- Identified version: v0.4.8
- Invariant coverage found: contiguous INV-1 through INV-22
- Previous frozen blind artifact: none present in this isolated workspace
- Baseline status: fresh v0.4.8 baseline
- Blind-boundary status: intact

The only authoritative input used was the materialized package above, together
with its provenance label. No production checkout, source, implementation tests,
ABI/build output, deployment data, branch history, or other Cr3dX discussion was
opened or used.

## Frozen contents

- `invariant-coverage-matrix.md`: full executable records for INV-1…INV-22.
- `model/reference_model.py`: independent Deals/Credit/Verifier-boundary model.
- `model/test_reference_model.py`: model, negative, prescribed, generated, and
  metamorphic witnesses.
- `model/run_harness.py`: runnable harness entry point.
- `metamorphic-test-matrix.md`: fixed-fact transformation and comparison matrix.
- `test-catalog.md`: prescribed section 9 cases separated from independently
  derived tests and fuzz dimensions.
- `ambiguity-report.md`: v0.4.8 semantic-ambiguity result.
- `delta-note.md`: baseline/delta record.
- `freeze-manifest.md`: hashes and immutable snapshot identifier.

## Running the harness

From the `model` directory:

```text
python3 run_harness.py
```

The model requires Python 3 and `pycryptodome` (see `requirements.txt`). It does
not connect to any chain or production contract.

## Model boundary

Cryptographic proof validity is a generated input to the model. The harness
checks that no evidence is created until verification succeeds, that transaction
index calculation occurs afterwards, and that all subsequent fact extraction,
classification, accounting, batching, and state transitions match the normative
package. Hash inputs are encoded deterministically for executable identity tests;
no byte-for-byte production fixture is used as an oracle.

