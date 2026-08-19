import { withRetry } from './rpc.js';

export interface MerkleProofEntry {
  hash: string;
  isLeft: boolean;
}

export interface MerkleProof {
  root: string;
  siblings: MerkleProofEntry[];
}

export interface ContinuityProof {
  lowerEndpointDigest: string;
  roots: string[];
}

export interface SingleProof {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  txBytes: string;
  merkleProof: MerkleProof;
  continuityProof: ContinuityProof;
  cached: boolean;
}

export interface BatchProof {
  chainKey: number;
  fromHeader: number;
  toHeader: number;
  continuityProof: ContinuityProof;
  /** height -> txIndex -> entry */
  merkleProofs: Record<string, Record<string, { txHash: string; txBytes: string; merkleProof: MerkleProof }>>;
  cached: boolean;
}

/**
 * Client for the Attestcoin proof builder service. Endpoint layout taken from
 * @gluwa/usc-sdk 0.18.0 (proof-provider/service).
 */
export class ProofBuilderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly chainKey: number,
    private readonly timeoutMs = 120_000,
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /** Attested height as seen by the proof builder's own cache, which trails the chain. */
  async attestedHeight(): Promise<number> {
    const r = await this.json<{ attestedHeight: number }>(`/api/v1/attested-height/${this.chainKey}`);
    return r.attestedHeight;
  }

  async getProof(txHash: string, attempts = 3): Promise<SingleProof> {
    return withRetry(`proof for ${txHash}`, attempts, () =>
      this.json<SingleProof>(`/api/v1/proof-by-tx/${this.chainKey}/${txHash}`),
    );
  }

  async getBatchProof(txHashes: string[], attempts = 3): Promise<BatchProof> {
    return withRetry(`batch proof for ${txHashes.length} txs`, attempts, () =>
      this.json<BatchProof>(`/api/v1/proof-batch-by-tx/${this.chainKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(txHashes),
      }),
    );
  }
}

/** Calldata tuple for a MerkleProof, in the order the precompile ABI expects. */
export const merkleTuple = (p: MerkleProof): unknown[] => [p.root, p.siblings.map((s) => [s.hash, s.isLeft])];

export const continuityTuple = (p: ContinuityProof): unknown[] => [p.lowerEndpointDigest, p.roots];
