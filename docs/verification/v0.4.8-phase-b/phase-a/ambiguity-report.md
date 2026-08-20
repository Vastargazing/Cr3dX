# v0.4.8 ambiguity report

## Oracle-changing semantic ambiguities

None found.

The supplied passages consistently define:

- canonical outcome precedence and stored-default memory;
- `closedAtBlock` write/update/no-op behavior and metadata scope;
- funding-first then repayment application for newly created evidence only;
- decision-time, rather than continuous, interpretation of INV-19;
- the general eternal-inapplicability criterion and its two current reasons;
- cumulative uncapped funding and unique threshold crossing;
- one economic-state definition for INV-3 and INV-20;
- strict default-height comparison and `FINANCED`-only authorization;
- atomic submission failure and terminal application idempotence.

No coordinator decision is required before using the frozen Phase A oracle.

## Non-semantic model labels and abstractions

The package requires named failures but does not spell an ABI error identifier for
every verifier failure (for example, failed source transaction status and invalid
batch length). The harness uses explicit stable model tags
`SOURCE_TRANSACTION_FAILED` and `INVALID_BATCH_SIZE`; it does not assert those are
production ABI spellings. This does not change success/failure, atomicity, or any
state oracle.

The cryptographic precompile is represented by a generated verification result.
Identifier tests cover deterministic binding, event-kind/nonce separation, and
stable order without importing implementation fixtures.

