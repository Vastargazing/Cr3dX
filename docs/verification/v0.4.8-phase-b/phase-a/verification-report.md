# Freeze verification report — v0.4.8

- Input SHA-256 matched the expected value.
- Package version matched v0.4.8.
- INV headings were present contiguously from INV-1 through INV-22.
- No previous blind freeze was present in the isolated workspace.
- No forbidden implementation material was opened or used.
- Harness result: 42 tests passed, 0 failed, 0 errors.
- Generated trace coverage: 100 deterministic seeds × 30 generated actions,
  with continuous invariant checks after every action.
- Focused funding permutation: all 6 orders passed.
- Focused repayment order: late-full/timely-full both orders passed.
- Focused batch order: repayment/funding both transaction orders passed.
- Focused log order: both relevant-log permutations passed.
- Oracle-changing semantic ambiguities: none.

The harness was run only against the independent model. No implementation
contracts, implementation tests, chain deployment, or live endpoint were used.

