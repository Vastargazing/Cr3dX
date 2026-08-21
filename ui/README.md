# Cr3dX read-only dashboard

This single-page Vite application explains the accepted S6 testnet run in the
order a reviewer needs it: outcome, economic state, observed timeline, worker
behavior and verification evidence.

## Run and verify

```bash
npm run ui:dev
npm run ui:typecheck
npm run test:ui
npm run ui:build
npm run ui:preview
```

Vite is configured with a relative base. Production asset references therefore
remain valid when `ui/dist/` is served at `/`, `/Cr3dX/` or another static
subpath.

## Two sources, never conflated

**Accepted snapshot** is the frozen, commit-pinned result from `2026-08-21` at
`f359c54c5647841a08e4e66dec267cf4cbeb110d`. Its displayed outcome and economics
are static page content and the RPC renderer has no code path that writes to
them.

**Live RPC observation** is a separate panel populated only by public Creditcoin
view calls. Each successful read carries its destination block, local read time
and an exact comparison with the accepted snapshot. If a later RPC request
fails, the panel becomes `STALE` and retains the last successful read with its
original block and time. Without a prior success it becomes `UNAVAILABLE` and
shows no live values. Neither case changes or relabels the snapshot.

## Read-only boundary

The browser code has no wallet provider, signer, transaction submission, private
configuration, backend, local worker state, analytics, remote fonts or CDN
assets. Its contract ABIs contain view functions only. The test suite fixes this
surface, checks the snapshot/live crash boundary, and verifies the accepted
snapshot, Phase B evidence, timeline and trust-boundary copy.
