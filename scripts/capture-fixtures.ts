/**
 * Captures real proven-transaction blobs from Sepolia and freezes them as test
 * fixtures for the Solidity decoder.
 *
 *   npm run capture:fixtures
 *
 * The decoder is the one piece of Cr3dX that consumes a foreign encoding, so it
 * is tested against blobs the protocol actually produced rather than against
 * blobs we would have produced ourselves. The capture deliberately hunts for the
 * awkward shapes: a reverted transaction, a transaction with no logs at all, a
 * legacy transaction, and a blob-carrying transaction, because the claim being
 * tested is that the receipt chunk is last regardless of transaction type.
 */
import { AbiCoder, JsonRpcProvider } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { ChainInfoReader } from './lib/precompiles.js';
import { ProofBuilderClient } from './lib/proofs.js';

const OUT_DIR = 'test/fixtures';
const log = (msg: string): void => console.log(`[fixtures] ${msg}`);

interface Wanted {
  name: string;
  why: string;
  match: (c: Candidate) => boolean;
  /** Higher is a better example of the same category. */
  score?: (c: Candidate) => number;
}

interface Candidate {
  txHash: string;
  height: number;
  txType: number;
  status: number;
  logCount: number;
  inputBytes: number;
}

const WANTED: Wanted[] = [
  {
    name: 'eip1559-two-logs',
    why: 'the exact shape of a Cr3dX gate call: an ERC-20 transfer plus one application event',
    match: (c) => c.txType === 2 && c.status === 1 && c.logCount === 2,
  },
  {
    name: 'eip1559-no-logs',
    why: 'a proven transaction that emits nothing, so the log array decodes empty rather than reverting',
    match: (c) => c.txType === 2 && c.status === 1 && c.logCount === 0,
  },
  {
    name: 'reverted',
    why: 'a perfectly valid proof of a failed transaction; the precompile does not check status, we must',
    match: (c) => c.status === 0,
    score: (c) => c.logCount,
  },
  {
    name: 'legacy',
    why: 'transaction type 0 has a different chunk layout, and the decoder must not care',
    match: (c) => c.txType === 0 && c.status === 1,
    score: (c) => c.logCount,
  },
  {
    name: 'access-list',
    why: 'transaction type 1, another chunk layout',
    match: (c) => c.txType === 1 && c.status === 1,
    score: (c) => c.logCount,
  },
  {
    name: 'blob-carrying',
    why: 'transaction type 3 splits the type-specific fields across two chunks, the strongest test of the claim',
    match: (c) => c.txType === 3,
    score: (c) => c.logCount,
  },
  {
    name: 'many-logs',
    why: 'upper end of the cost curve, and a log array long enough to catch offset mistakes',
    match: (c) => c.status === 1 && c.logCount >= 15,
    score: (c) => c.logCount,
  },
];

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const cc = evmProvider(config.creditcoinRpcUrl);
  const sepolia = evmProvider(config.sepoliaRpcUrl);
  const chainInfo = new ChainInfoReader(cc);

  const chains = await chainInfo.getSupportedChains();
  const source = chains.find((c) => c.chainId === config.sourceEvmChainId);
  if (!source) throw new Error(`Source chain ${config.sourceEvmChainId} is not in the registry`);
  const prover = new ProofBuilderClient(config.proofBuilderUrl, source.chainKey);

  const top = (await prover.attestedHeight()) - config.probe.sampleDepth;
  const found = new Map<string, Candidate>();

  const MAX_BLOCKS = 40;
  for (let i = 0; i < MAX_BLOCKS && found.size < WANTED.length; i++) {
    const height = top - i;
    let candidates: Candidate[];
    try {
      candidates = await scanBlock(sepolia, height);
    } catch (error) {
      log(`block ${height} skipped: ${errMessage(error)}`);
      continue;
    }
    for (const want of WANTED) {
      const matches = candidates.filter(want.match);
      if (matches.length === 0) continue;
      const best = want.score ? matches.reduce((a, b) => (want.score!(a) >= want.score!(b) ? a : b)) : matches[0]!;
      const current = found.get(want.name);
      if (!current || (want.score && want.score(best) > want.score(current))) {
        found.set(want.name, best);
      }
    }
    log(
      `scanned ${height} (${candidates.length} txs), have ${found.size}/${WANTED.length}: ` +
        `${[...found.keys()].join(', ')}`,
    );
  }

  const missing = WANTED.filter((w) => !found.has(w.name)).map((w) => w.name);
  if (missing.length) log(`not found within ${MAX_BLOCKS} blocks, skipping: ${missing.join(', ')}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const index: unknown[] = [];
  for (const want of WANTED) {
    const c = found.get(want.name);
    if (!c) continue;
    log(`proving ${want.name}: ${c.txHash}`);
    const proof = await prover.getProof(c.txHash);

    // Expected values come from the Ethereum receipt, never from our own decode
    // of the blob. Otherwise the fixture would only prove that the decoder
    // agrees with itself, and a decoder that is consistently wrong would pass.
    const expected = await expectedFromReceipt(sepolia, c.txHash);
    const decoded = decode(proof.txBytes);
    assertMatchesReceipt(want.name, decoded, expected);

    const fixture = {
      name: want.name,
      why: want.why,
      capturedAt: new Date().toISOString(),
      chainKey: source.chainKey,
      sourceChainId: config.sourceEvmChainId,
      txHash: proof.txHash,
      height: proof.headerNumber,
      txIndex: proof.txIndex,
      txType: decoded.txType,
      chunkCount: decoded.chunks,
      // Everything below is the Ethereum receipt's own account of the
      // transaction, cross-checked against the blob above at capture time.
      status: expected.status,
      logCount: expected.logs.length,
      logEmitters: expected.logs.map((l) => l.emitter),
      logTopicCounts: expected.logs.map((l) => l.topics.length),
      logFirstTopics: expected.logs.map((l) => l.topics[0] ?? ZERO32),
      logDataLengths: expected.logs.map((l) => (l.data.length - 2) / 2),
      logs: expected.logs,
      encodedTx: proof.txBytes,
      // Kept for the verifier stage. Continuity proofs reference attestation
      // digests that the chain prunes eventually, so a stale fixture must be
      // recaptured rather than trusted.
      merkleProof: proof.merkleProof,
      continuityProof: proof.continuityProof,
    };
    writeFileSync(`${OUT_DIR}/${want.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
    index.push({
      name: want.name,
      why: want.why,
      txHash: proof.txHash,
      height: proof.headerNumber,
      txType: decoded.txType,
      status: expected.status,
      logs: expected.logs.length,
      encodedTxBytes: (proof.txBytes.length - 2) / 2,
    });
    log(
      `  saved ${OUT_DIR}/${want.name}.json (type ${decoded.txType}, status ${expected.status}, ` +
        `${expected.logs.length} logs, blob matches the Ethereum receipt)`,
    );
  }
  writeFileSync(`${OUT_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  log(`done, ${index.length} fixtures`);
}

async function scanBlock(sepolia: JsonRpcProvider, height: number): Promise<Candidate[]> {
  const tag = `0x${height.toString(16)}`;
  const [receipts, block] = await Promise.all([
    sepolia.send('eth_getBlockReceipts', [tag]),
    sepolia.send('eth_getBlockByNumber', [tag, true]),
  ]);
  if (!Array.isArray(receipts)) return [];
  const byHash = new Map<string, any>((block?.transactions ?? []).map((t: any) => [t.hash, t]));
  return receipts.map((r: any) => {
    const tx = byHash.get(r.transactionHash);
    return {
      txHash: r.transactionHash,
      height,
      txType: Number(tx?.type ?? r.type ?? 0),
      status: Number(r.status),
      logCount: (r.logs as unknown[]).length,
      inputBytes: tx?.input ? (tx.input.length - 2) / 2 : 0,
    };
  });
}

interface DecodedLog {
  emitter: string;
  topics: string[];
  data: string;
}

/**
 * Reference implementation of what the Solidity library has to reproduce:
 * `abi.encode(uint8 txType, bytes[] chunks)`, receipt chunk last, always.
 */
function decode(encodedTx: string): { txType: number; chunks: number; status: number; logs: DecodedLog[] } {
  const coder = AbiCoder.defaultAbiCoder();
  const [txType, chunks] = coder.decode(['uint8', 'bytes[]'], encodedTx) as unknown as [bigint, string[]];
  const [status, , logs] = coder.decode(
    ['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
    chunks[chunks.length - 1]!,
  ) as unknown as [bigint, bigint, [string, string[], string][], string];
  return {
    txType: Number(txType),
    chunks: chunks.length,
    status: Number(status),
    logs: logs.map(([emitter, topics, data]) => ({ emitter, topics: [...topics], data })),
  };
}

const ZERO32 = `0x${'0'.repeat(64)}`;

interface Expected {
  status: number;
  logs: DecodedLog[];
}

/** The transaction as Ethereum itself reports it, independent of the blob. */
async function expectedFromReceipt(sepolia: JsonRpcProvider, txHash: string): Promise<Expected> {
  const receipt = await sepolia.send('eth_getTransactionReceipt', [txHash]);
  if (!receipt) throw new Error(`no receipt for ${txHash}`);
  return {
    status: Number(receipt.status),
    logs: (receipt.logs as any[]).map((l) => ({
      emitter: l.address as string,
      topics: [...(l.topics as string[])],
      data: l.data as string,
    })),
  };
}

/**
 * The blob and the Ethereum receipt must agree field by field. A mismatch here
 * means either the decoder is wrong or the attested blob does not describe the
 * transaction it claims to; both are reasons to stop, not to write a fixture.
 */
function assertMatchesReceipt(name: string, decoded: { status: number; logs: DecodedLog[] }, expected: Expected): void {
  const fail = (what: string, got: unknown, want: unknown): never => {
    throw new Error(`${name}: blob and Ethereum receipt disagree on ${what}: blob ${got}, receipt ${want}`);
  };
  if (decoded.status !== expected.status) fail('status', decoded.status, expected.status);
  if (decoded.logs.length !== expected.logs.length) fail('log count', decoded.logs.length, expected.logs.length);
  for (let i = 0; i < expected.logs.length; i++) {
    const a = decoded.logs[i]!;
    const b = expected.logs[i]!;
    if (a.emitter.toLowerCase() !== b.emitter.toLowerCase()) fail(`log ${i} emitter`, a.emitter, b.emitter);
    if (a.topics.length !== b.topics.length) fail(`log ${i} topic count`, a.topics.length, b.topics.length);
    for (let t = 0; t < b.topics.length; t++) {
      if (a.topics[t]!.toLowerCase() !== b.topics[t]!.toLowerCase()) fail(`log ${i} topic ${t}`, a.topics[t], b.topics[t]);
    }
    if (a.data.toLowerCase() !== b.data.toLowerCase()) fail(`log ${i} data`, a.data.slice(0, 20), b.data.slice(0, 20));
  }
}

main().catch((error) => {
  console.error(`[fixtures] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
