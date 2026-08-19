import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Environment variable ${name} is not a number: ${raw}`);
  return v;
}

export const config = {
  creditcoinRpcUrl: required('CREDITCOIN_RPC_URL', 'https://rpc.cc3-testnet.creditcoin.network'),
  creditcoinSubstrateRpcUrl: required('CREDITCOIN_SUBSTRATE_RPC_URL', process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network'),
  proofBuilderUrl: required('CREDITCOIN_PROOF_BUILDER_URL', 'https://prover.cc3-testnet.creditcoin.network').replace(/\/+$/, ''),
  sepoliaRpcUrl: required('SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com'),

  /** EVM chain id of the source chain. Used only to find it in the Creditcoin registry. */
  sourceEvmChainId: num('SOURCE_EVM_CHAIN_ID', 11155111),
  /** EVM chain id of the deployment target, asserted against the live node. */
  creditcoinChainId: num('CREDITCOIN_CHAIN_ID', 102031),

  probe: {
    lagSamples: num('PROBE_LAG_SAMPLES', 20),
    lagIntervalMs: num('PROBE_LAG_INTERVAL_MS', 45_000),
    batchMax: num('PROBE_BATCH_MAX', 10),
    /**
     * How far below the attested height to pick sample transactions. The proof
     * builder trails the on-chain attestation, so the newest attested block is
     * not necessarily servable yet.
     */
    sampleDepth: num('PROBE_SAMPLE_DEPTH', 64),
  },
} as const;

/**
 * Node does not honour HTTP(S)_PROXY for `fetch` unless asked to. Warn instead
 * of failing with an opaque "failed to detect network".
 */
export function warnIfProxyIgnored(log: (s: string) => void): void {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  const enabled = process.env.NODE_USE_ENV_PROXY;
  if (proxy && !enabled) {
    log(`A proxy is configured (${proxy}) but Node will ignore it. Re-run with NODE_USE_ENV_PROXY=1 if requests time out.`);
  }
}
