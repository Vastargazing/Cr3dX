export const PREAMBLE = `# Attestcoin Protocol integration notes

Cr3dX reads every cross-chain fact through the Attestcoin Protocol precompiles on
Creditcoin3 Testnet (chain id 102031), with Ethereum Sepolia as the source chain.
This document records what the live network actually does, as opposed to what the
source and the published documentation say it does. Every number below is produced
by \`npm run probe\` (\`scripts/probe.ts\`) against the live testnet; raw results are
committed under \`data/probe/\`.

The block between the probe markers is regenerated on every run. Prose outside the
markers is written by hand and is preserved.

## Why this document exists

Three protocol properties cannot be read off the source code, and all three change
how the contracts have to be written:

1. **The source chain identifier is runtime state.** \`chainKey\` is an
   auto-incrementing Creditcoin-internal id, not the EVM chain id of the source
   chain. It has to be resolved from the on-chain registry.
2. **Attestation deliberately trails the source chain head.** The size of that lag
   determines \`attestationGracePeriod\`, the only thing standing between a healthy
   deal and a spurious default.
3. **The real cost of a verification call is dominated by calldata**, not by the
   precompile's own metering, because the encoded transaction blob carries every
   log of the proven transaction.
`;
