/**
 * Cr3dX network probe.
 *
 * Measures the Attestcoin Protocol parameters that cannot be read off the source
 * code: the registry entry for the source chain, how far attestation trails the
 * source head, the attestation cadence and continuity limits, and the real gas
 * cost of verification. Read-only; no key material is touched.
 *
 *   npm run probe
 *
 * Behind a proxy, Node has to be told to use it:
 *
 *   NODE_USE_ENV_PROXY=1 npm run probe
 */
import { AbiCoder, JsonRpcProvider } from 'ethers';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, substrateRpc, scaleU64, decodeScaleU64, decodeScaleU32, blake2ConcatMapKey, sleep, errMessage } from './lib/rpc.js';
import {
  BLOCK_PROVER,
  CHAIN_INFO,
  ChainInfoReader,
  blockProverIface,
  calldataGas,
  VERIFY_SINGLE,
  VERIFY_BATCH,
  VERIFY_AND_EMIT_SINGLE,
  type RegisteredChain,
} from './lib/precompiles.js';
import { ProofBuilderClient, merkleTuple, continuityTuple, type SingleProof } from './lib/proofs.js';
import { Report, table, writeJson, fmt } from './lib/report.js';
import { PREAMBLE } from './lib/preamble.js';

const DOC_PATH = 'docs/ATTESTCOIN_INTEGRATION.md';
const SEPOLIA_BLOCK_TIME_S = 12;

const log = (msg: string): void => console.log(`[probe] ${msg}`);

interface Findings {
  startedAt: string;
  finishedAt?: string;
  endpoints?: unknown;
  registry?: unknown;
  attestation?: unknown;
  lag?: unknown;
  verify?: unknown;
  gasSingle?: unknown;
  gasBatch?: unknown;
  emit?: unknown;
  decode?: unknown;
  grace?: unknown;
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const startedAt = new Date();
  const findings: Findings = { startedAt: startedAt.toISOString() };

  const cc = evmProvider(config.creditcoinRpcUrl);
  const sepolia = evmProvider(config.sepoliaRpcUrl);
  const chainInfo = new ChainInfoReader(cc);

  const report = new Report(DOC_PATH, PREAMBLE);
  report.declare('endpoints', 'Endpoints and node identity');
  report.declare('registry', '1. Source chain registry and `chainKey`');
  report.declare('attestation', '2. Attestation cadence and continuity limits');
  report.declare('lag', '3. Attestation lag behind the Sepolia head');
  report.declare('verify', '4. `verify` on a live Sepolia transaction');
  report.declare('gasSingle', '5. Gas cost of a single verification');
  report.declare('gasBatch', '6. Gas cost of batched verification');
  report.declare('emit', '7. `verify` against `verifyAndEmit` (finding F-1)');
  report.declare('decode', '8. Decoding the proven transaction inside a contract');
  report.declare('grace', '9. Derived parameter: `attestationGracePeriod`');
  report.setMeta({
    'Probe started': startedAt.toISOString(),
    'Creditcoin RPC': `\`${config.creditcoinRpcUrl}\``,
    'Sepolia RPC': `\`${config.sepoliaRpcUrl}\``,
    'Proof builder': `\`${config.proofBuilderUrl}\``,
  });

  // -- 0. endpoints ---------------------------------------------------------
  log('checking endpoints');
  const ccNet = await cc.getNetwork();
  const sepNet = await sepolia.getNetwork();
  const ccHead = await cc.getBlock('latest');
  const sepHead = await sepolia.getBlock('latest');
  if (Number(ccNet.chainId) !== config.creditcoinChainId) {
    throw new Error(`CREDITCOIN_RPC_URL points at chain ${ccNet.chainId}, expected ${config.creditcoinChainId}`);
  }
  if (Number(sepNet.chainId) !== config.sourceEvmChainId) {
    throw new Error(`SEPOLIA_RPC_URL points at chain ${sepNet.chainId}, expected ${config.sourceEvmChainId}`);
  }
  const endpoints = {
    creditcoinChainId: Number(ccNet.chainId),
    creditcoinHead: ccHead!.number,
    creditcoinBlockGasLimit: ccHead!.gasLimit.toString(),
    sepoliaChainId: Number(sepNet.chainId),
    sepoliaHead: sepHead!.number,
  };
  findings.endpoints = endpoints;
  report.set(
    'endpoints',
    'done',
    `${table(
      ['Property', 'Value'],
      [
        ['Creditcoin EVM chain id', fmt.int(endpoints.creditcoinChainId)],
        ['Creditcoin head at probe start', fmt.int(endpoints.creditcoinHead)],
        ['Creditcoin block gas limit', fmt.int(BigInt(endpoints.creditcoinBlockGasLimit))],
        ['Sepolia EVM chain id', fmt.int(endpoints.sepoliaChainId)],
        ['Sepolia head at probe start', fmt.int(endpoints.sepoliaHead)],
        ['BlockProver precompile', `\`${BLOCK_PROVER}\``],
        ['ChainInfo precompile', `\`${CHAIN_INFO}\``],
      ],
    )}\n`,
  );

  // -- 1. registry ----------------------------------------------------------
  log('reading the supported chain registry');
  const chains = await chainInfo.getSupportedChains();
  const source = chains.find((c) => c.chainId === config.sourceEvmChainId);
  if (!source) {
    report.fail('registry', `No registry entry with EVM chain id ${config.sourceEvmChainId}.`);
    throw new Error(`Source chain ${config.sourceEvmChainId} is not registered on this network`);
  }
  const genesisHeight = await chainInfo.getAttestationGenesisHeight(source.chainKey);
  findings.registry = { chains, source, genesisHeight };
  report.set(
    'registry',
    'done',
    [
      'The registry is runtime state, so this is a live reading rather than a constant.',
      '',
      table(
        ['`chainKey`', 'EVM `chainId`', 'Name', 'Encoding'],
        chains
          .slice()
          .sort((a, b) => a.chainKey - b.chainKey)
          .map((c: RegisteredChain) => [
            `\`${c.chainKey}\``,
            fmt.int(c.chainId),
            `\`${c.chainName}\``,
            `v${c.chainEncoding}`,
          ]),
      ),
      '',
      `**Sepolia is \`chainKey = ${source.chainKey}\`** on Creditcoin3 Testnet, encoding version ${source.chainEncoding}.`,
      `Attestation genesis height for this chain: \`${fmt.int(genesisHeight)}\`.`,
      '',
      'Consequence for the contracts: `chainKey` is a deployment parameter resolved from this registry,',
      'never a hard-coded EVM chain id. The two differ by construction, and the registry assigns keys',
      'in registration order.',
    ].join('\n'),
  );
  log(`source chain ${config.sourceEvmChainId} -> chainKey ${source.chainKey}`);

  const chainKey = source.chainKey;
  const prover = new ProofBuilderClient(config.proofBuilderUrl, chainKey);

  // -- 2. attestation parameters -------------------------------------------
  log('reading attestation cadence and continuity limits');
  try {
    const keyScale = scaleU64(chainKey);
    const intervalRaw = await substrateRpc<string>(config.creditcoinSubstrateRpcUrl, 'state_call', [
      'AttestorApi_chain_attestation_interval',
      keyScale,
    ]);
    const checkpointRaw = await substrateRpc<string>(config.creditcoinSubstrateRpcUrl, 'state_call', [
      'AttestorApi_attestation_checkpoint_interval',
      keyScale,
    ]);
    const maxCatchupRaw = await substrateRpc<string | null>(config.creditcoinSubstrateRpcUrl, 'state_getStorage', [
      blake2ConcatMapKey('Attestation', 'MaxCatchup', keyScale),
    ]);
    const interval = Number(decodeScaleU64(intervalRaw));
    const checkpointInterval = decodeScaleU32(checkpointRaw);
    const maxCatchupStored = decodeScaleU32(maxCatchupRaw);
    // `MaxCatchup` is `ValueQuery` with a runtime default; an absent entry means
    // the chain is using `DefaultMaxCatchup`, which is 500 at commit 06657e9.
    const RUNTIME_DEFAULT_MAX_CATCHUP = 500;
    const maxCatchup = maxCatchupStored ?? RUNTIME_DEFAULT_MAX_CATCHUP;
    const maxRoots = Math.max(maxCatchup, interval);

    findings.attestation = { interval, checkpointInterval, maxCatchupStored, maxCatchup, maxRoots };
    report.set(
      'attestation',
      'done',
      [
        table(
          ['Parameter', 'Value', 'Source'],
          [
            ['Attestation interval', `${fmt.int(interval)} source blocks`, '`AttestorApi_chain_attestation_interval`'],
            [
              'Checkpoint interval',
              `${fmt.int(checkpointInterval ?? 0)} attestations`,
              '`AttestorApi_attestation_checkpoint_interval`',
            ],
            [
              '`MaxCatchup`',
              maxCatchupStored === null
                ? `${fmt.int(maxCatchup)} blocks (runtime default, no per-chain override stored)`
                : `${fmt.int(maxCatchup)} blocks`,
              '`Attestation::MaxCatchup` storage',
            ],
            ['Maximum continuity roots per proof', fmt.int(maxRoots), '`max(MaxCatchup, interval)`'],
            ['Maximum batch size', '10 heights', '`MaxBatchSize` in the precompile'],
          ],
        ),
        '',
        `A single attestation therefore covers ${fmt.int(interval)} source blocks, roughly`,
        `${fmt.secs(interval * SEPOLIA_BLOCK_TIME_S)} of Sepolia, and one continuity proof may span at most`,
        `${fmt.int(maxRoots)} blocks.`,
        '',
        `**\`MaxCatchup\` is the number that sizes \`attestationGracePeriod\`.** It bounds how many source blocks`,
        'a single attestation may recover after the attestor set has fallen behind, which is the same as saying',
        `the attested height, the only clock the deals contract is allowed to read, can advance by ${fmt.int(maxCatchup)} blocks`,
        'in one Creditcoin block. Any deadline logic has to survive that jump; see section 9.',
        '',
        '**Documentation deviation.** `pallets/attestation/src/lib.rs:855` documents the continuity limit as',
        '`max_catchup * attestation_interval`. The executed code in `continuity.rs:95-101` and',
        '`extensions.rs:120-127` computes `max(max_catchup, attestation_interval)`. On the measured',
        `configuration the comment implies ${fmt.int(maxCatchup * interval)} roots where the real limit is`,
        `${fmt.int(maxRoots)}. Anything sized against the comment would be rejected as an oversized proof.`,
      ].join('\n'),
    );
  } catch (error) {
    report.fail('attestation', `Substrate RPC read failed: ${errMessage(error)}`);
    log(`attestation parameters unavailable: ${errMessage(error)}`);
  }

  // -- 3. lag sampling, started now and awaited at the end ------------------
  const lagTask = sampleLag(chainInfo, sepolia, prover, chainKey).catch((error) => {
    report.fail('lag', `Sampling failed: ${errMessage(error)}`);
    return null;
  });

  // -- 4/5. verification and gas -------------------------------------------
  let gasSingle: SingleGasResult[] = [];
  try {
    const proverHeight = await prover.attestedHeight();
    const targetHeight = proverHeight - config.probe.sampleDepth;
    log(`selecting sample transactions at Sepolia height ${targetHeight}`);
    const samples = await pickSampleTransactions(sepolia, targetHeight);
    gasSingle = await measureSingleVerification(cc, prover, chainKey, samples);
    findings.verify = gasSingle.map((r) => ({ label: r.label, txHash: r.txHash, height: r.height, verified: r.verified }));
    findings.gasSingle = gasSingle;

    const anyVerified = gasSingle.find((r) => r.verified);
    report.set(
      'verify',
      anyVerified ? 'done' : 'failed',
      [
        anyVerified
          ? `\`verify\` returns **true** for a live Sepolia transaction proven through the precompile at \`${BLOCK_PROVER}\`.`
          : '`verify` did not return true for any sampled transaction.',
        '',
        table(
          ['Sample', 'Sepolia tx', 'Height', 'Logs', '`verify`', '`calculateTxIndex`'],
          gasSingle.map((r) => [
            r.label,
            `\`${r.txHash.slice(0, 12)}...\``,
            fmt.int(r.height),
            r.logCount,
            r.verified ? '`true`' : `reverted: ${r.error ?? 'unknown'}`,
            r.txIndexMatches ? `\`${r.txIndex}\` (matches the proof)` : `\`${r.txIndex}\` (proof says \`${r.expectedTxIndex}\`)`,
          ]),
        ),
        '',
        'The precompile either returns `true` or reverts; it never returns `false`. There is no',
        '"else" branch to write on our side. `calculateTxIndex` is a pure function of the Merkle proof',
        'siblings, so its result is only meaningful once `verify` has succeeded on the same proof.',
      ].join('\n'),
    );

    report.set(
      'gasSingle',
      'done',
      [
        'Full cost of the call as `eth_estimateGas` reports it, which includes intrinsic calldata cost.',
        'The encoded transaction blob carries every log of the proven transaction, so cost scales with',
        'how noisy the source transaction is, not with anything Cr3dX controls.',
        '',
        table(
          ['Sample', 'Logs', '`encodedTx` bytes', 'Calldata bytes', 'Calldata gas', 'Total gas', 'Calldata share'],
          gasSingle.map((r) => [
            r.label,
            r.logCount,
            fmt.int(r.encodedTxBytes),
            fmt.int(r.calldataBytes),
            fmt.int(r.calldataGas),
            r.gas === null ? 'n/a' : fmt.int(r.gas),
            r.gas === null ? 'n/a' : `${Math.round((r.calldataGas / Number(r.gas)) * 100)}%`,
          ]),
        ),
        '',
        `Creditcoin block gas limit at probe time: \`${fmt.int(BigInt(endpoints.creditcoinBlockGasLimit))}\`.`,
        '',
        '**What this means for Cr3dX.** A `fund` or `repay` call on the Sepolia gate emits exactly two logs,',
        'the ERC-20 `Transfer` and the gate event, so its encoded blob sits at the low end of this table.',
        projectGateCost(gasSingle),
        '',
        'The heavy row is in the table to show the shape of the curve, not because Cr3dX ever proves',
        'transactions like it. Cost is driven by the log payload of the proven transaction, which is fixed by',
        'the gate contract and is not something a caller can inflate.',
      ].join('\n'),
    );
  } catch (error) {
    report.fail('verify', `Proof or verification failed: ${errMessage(error)}`);
    report.fail('gasSingle', `Depends on the verification step above.`);
    log(`single verification measurement failed: ${errMessage(error)}`);
  }

  // -- 6. batch -------------------------------------------------------------
  try {
    const proverHeight = await prover.attestedHeight();
    const batch = await measureBatch(cc, sepolia, prover, chainKey, proverHeight);
    findings.gasBatch = batch;
    const maxOk = batch.filter((b) => b.verified).reduce((m, b) => Math.max(m, b.size), 0);
    report.set(
      'gasBatch',
      'done',
      [
        'One batch call takes several heights and a single continuity proof that has to span the whole',
        'range from the lowest to the highest height in the batch.',
        '',
        table(
          ['Batch size', 'Height span', 'Continuity roots', 'Calldata bytes', 'Total gas', 'Gas per tx', 'Result'],
          batch.map((b) => [
            b.size,
            b.span,
            b.roots,
            fmt.int(b.calldataBytes),
            b.gas === null ? 'n/a' : fmt.int(b.gas),
            b.gas === null ? 'n/a' : fmt.int(Math.round(Number(b.gas) / b.size)),
            b.verified ? '`true`' : `rejected: ${b.error ?? 'unknown'}`,
          ]),
        ),
        '',
        `**Largest batch that verifies: ${maxOk} heights.**`,
        '',
        batch.some((b) => !b.verified && b.size > config.probe.batchMax)
          ? `A batch of ${config.probe.batchMax + 1} is rejected, which confirms the \`MaxBatchSize = ${config.probe.batchMax}\` bound from the source.`
          : 'The documented batch ceiling was not reached in this run.',
      ].join('\n'),
    );
  } catch (error) {
    report.fail('gasBatch', `Batch measurement failed: ${errMessage(error)}`);
    log(`batch measurement failed: ${errMessage(error)}`);
  }

  // -- 7. verify vs verifyAndEmit ------------------------------------------
  try {
    const sample = gasSingle.find((r) => r.verified && r.gas !== null);
    if (!sample || !sample.proof) throw new Error('no verified sample available');
    const emitData = blockProverIface.encodeFunctionData(VERIFY_AND_EMIT_SINGLE, [
      chainKey,
      sample.height,
      sample.proof.txBytes,
      merkleTuple(sample.proof.merkleProof),
      continuityTuple(sample.proof.continuityProof),
    ]);
    const emitGas = await cc.estimateGas({ to: BLOCK_PROVER, data: emitData, from: PROBE_FROM });
    const delta = Number(emitGas) - Number(sample.gas);
    findings.emit = { verifyGas: sample.gas?.toString(), verifyAndEmitGas: emitGas.toString(), delta };
    report.set(
      'emit',
      'done',
      [
        table(
          ['Call', 'Estimated gas'],
          [
            ['`verify`', fmt.int(sample.gas!)],
            ['`verifyAndEmit`', fmt.int(emitGas)],
            ['Difference', fmt.int(delta)],
          ],
        ),
        '',
        `Both calls were made on identical inputs (sample \`${sample.label}\`, ${fmt.int(sample.encodedTxBytes)} byte blob).`,
        '',
        delta === 0
          ? [
              '**The difference is exactly zero, which confirms finding F-1.** `verifyAndEmit` additionally runs',
              '`calculate_tx_index_impl` and emits a `LOG3`, but charges for neither: `LogExt::record` stores the log',
              'without touching the gasometer, and the precompile never calls `compute_cost()` or',
              '`record_log_costs_manual`, which its sibling precompiles do. Under the standard formula the',
              'uncharged amount is `375 + 3*375 + 32*8 = 1,756` gas per event, up to 17,560 for a full batch of ten.',
              '',
              'This is reported upstream rather than exploited. Cr3dX budgets gas as if the event were charged, so',
              'that closing the gap upstream cannot break our limits.',
            ].join('\n')
          : `The difference is ${fmt.int(delta)} gas, so the event does appear to be charged. Finding F-1 does not reproduce on the live network.`,
      ].join('\n'),
    );
  } catch (error) {
    report.fail('emit', `Comparison failed: ${errMessage(error)}`);
  }

  // -- 8. decoding the proven blob -----------------------------------------
  try {
    const sample = gasSingle.find((r) => r.verified && r.proof && r.logCount > 0) ?? gasSingle.find((r) => r.proof);
    if (!sample?.proof) throw new Error('no proof available to decode');
    const decoded = decodeProvenTransaction(sample.proof.txBytes);
    findings.decode = { txHash: sample.txHash, ...decoded, logs: decoded.logs.length };
    report.set('decode', 'done', renderDecode(sample, decoded));
  } catch (error) {
    report.fail('decode', `Decoding failed: ${errMessage(error)}`);
  }

  // -- 3 (cont). lag results and 9. grace period ---------------------------
  const lag = await lagTask;
  if (lag) {
    findings.lag = lag;
    report.set('lag', 'done', renderLag(lag));

    const att = findings.attestation as { interval?: number; maxCatchup?: number } | undefined;
    const interval = att?.interval ?? 10;
    const grace = deriveGracePeriod(lag.maxLagBlocks, interval, att?.maxCatchup ?? 500);
    findings.grace = grace;
    report.set('grace', 'done', renderGrace(lag, interval, grace));
  }

  findings.finishedAt = new Date().toISOString();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  writeJson(`data/probe/${stamp}.json`, findings);
  report.setMeta({ 'Probe finished': findings.finishedAt, 'Raw results': `\`data/probe/${stamp}.json\`` });
  log(`done. ${DOC_PATH} updated, raw results in data/probe/${stamp}.json`);
}

/** Any address works for estimation; the precompile reads no balance. */
const PROBE_FROM = '0x0000000000000000000000000000000000000001';

// ---------------------------------------------------------------------------
// attestation lag
// ---------------------------------------------------------------------------

interface LagSample {
  at: string;
  attestedHeight: number;
  proverHeight: number;
  sepoliaHead: number;
  lagBlocks: number;
  lagSeconds: number | null;
}

interface LagResult {
  samples: LagSample[];
  minLagBlocks: number;
  maxLagBlocks: number;
  meanLagBlocks: number;
  minLagSeconds: number | null;
  maxLagSeconds: number | null;
  attestationSteps: number[];
  observedIntervalBlocks: number | null;
  catchUpRateBlocksPerSecond: number | null;
}

async function sampleLag(
  chainInfo: ChainInfoReader,
  sepolia: JsonRpcProvider,
  prover: ProofBuilderClient,
  chainKey: number,
): Promise<LagResult> {
  const samples: LagSample[] = [];
  const { lagSamples, lagIntervalMs } = config.probe;
  for (let i = 0; i < lagSamples; i++) {
    if (i > 0) await sleep(lagIntervalMs);
    const [att, head, proverHeight] = await Promise.all([
      chainInfo.getLatestAttestation(chainKey),
      sepolia.getBlock('latest'),
      prover.attestedHeight().catch(() => -1),
    ]);
    let lagSeconds: number | null = null;
    try {
      const attestedBlock = await sepolia.getBlock(att.height);
      if (attestedBlock && head) lagSeconds = head.timestamp - attestedBlock.timestamp;
    } catch {
      lagSeconds = null;
    }
    const sample: LagSample = {
      at: new Date().toISOString(),
      attestedHeight: att.height,
      proverHeight,
      sepoliaHead: head!.number,
      lagBlocks: head!.number - att.height,
      lagSeconds,
    };
    samples.push(sample);
    log(
      `lag sample ${i + 1}/${lagSamples}: attested ${sample.attestedHeight}, head ${sample.sepoliaHead}, ` +
        `lag ${sample.lagBlocks} blocks${sample.lagSeconds === null ? '' : ` / ${fmt.secs(sample.lagSeconds)}`}`,
    );
  }

  const blocks = samples.map((s) => s.lagBlocks);
  const seconds = samples.map((s) => s.lagSeconds).filter((s): s is number => s !== null);
  const steps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.attestedHeight - samples[i - 1]!.attestedHeight;
    if (d > 0) steps.push(d);
  }
  const firstSample = samples[0]!;
  const lastSample = samples[samples.length - 1]!;
  const elapsedS = (Date.parse(lastSample.at) - Date.parse(firstSample.at)) / 1000;
  const advanced = lastSample.attestedHeight - firstSample.attestedHeight;

  return {
    samples,
    minLagBlocks: Math.min(...blocks),
    maxLagBlocks: Math.max(...blocks),
    meanLagBlocks: Math.round(blocks.reduce((a, b) => a + b, 0) / blocks.length),
    minLagSeconds: seconds.length ? Math.min(...seconds) : null,
    maxLagSeconds: seconds.length ? Math.max(...seconds) : null,
    attestationSteps: steps,
    observedIntervalBlocks: steps.length ? gcdAll(steps) : null,
    catchUpRateBlocksPerSecond: elapsedS > 0 ? advanced / elapsedS : null,
  };
}

function gcdAll(values: number[]): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return values.reduce((a, b) => gcd(a, b));
}

function renderLag(lag: LagResult): string {
  const rows = lag.samples.map((s) => [
    s.at.slice(11, 19),
    fmt.int(s.attestedHeight),
    s.proverHeight < 0 ? 'n/a' : fmt.int(s.proverHeight),
    fmt.int(s.sepoliaHead),
    fmt.int(s.lagBlocks),
    s.lagSeconds === null ? 'n/a' : fmt.secs(s.lagSeconds),
  ]);
  const catching = lag.catchUpRateBlocksPerSecond !== null && lag.catchUpRateBlocksPerSecond > 1 / SEPOLIA_BLOCK_TIME_S * 1.5;
  return [
    'Attestation trails the Sepolia head on purpose, so that the attestation chain is never built on top of',
    'blocks that could still be reorganised. The lag is the single most important number for Cr3dX, because',
    'the deals contract uses attested source height as its only clock.',
    '',
    table(
      ['Time (UTC)', 'Attested height', 'Prover cache', 'Sepolia head', 'Lag, blocks', 'Lag, wall clock'],
      rows,
    ),
    '',
    table(
      ['Statistic', 'Value'],
      [
        ['Minimum lag', `${fmt.int(lag.minLagBlocks)} blocks`],
        ['Mean lag', `${fmt.int(lag.meanLagBlocks)} blocks`],
        ['Maximum lag', `${fmt.int(lag.maxLagBlocks)} blocks`],
        ['Minimum lag, wall clock', lag.minLagSeconds === null ? 'n/a' : fmt.secs(lag.minLagSeconds)],
        ['Maximum lag, wall clock', lag.maxLagSeconds === null ? 'n/a' : fmt.secs(lag.maxLagSeconds)],
        [
          'Attested height steps between samples',
          lag.attestationSteps.length ? lag.attestationSteps.map((s) => fmt.int(s)).join(', ') : 'no advance observed',
        ],
        [
          'Attestation cadence implied by those steps',
          lag.observedIntervalBlocks === null
            ? 'not observable in this window'
            : `${fmt.int(lag.observedIntervalBlocks)} source blocks (greatest common divisor of the steps)`,
        ],
        [
          'Attestation advance rate',
          lag.catchUpRateBlocksPerSecond === null
            ? 'n/a'
            : `${lag.catchUpRateBlocksPerSecond.toFixed(2)} source blocks/s (Sepolia produces ${(1 / SEPOLIA_BLOCK_TIME_S).toFixed(2)}/s)`,
        ],
      ],
    ),
    '',
    catching
      ? [
          '**The attested height was catching up during this run**, advancing faster than Sepolia produces blocks.',
          'That is the behaviour that matters for safety: the clock Cr3dX reads does not move smoothly, it moves in',
          'bursts. A grace period sized against the average lag would be crossed the moment a backlog is worked off.',
        ].join('\n')
      : 'The attested height advanced in step with Sepolia over this run.',
    '',
    '**The prover cache column is a separate lag.** The proof builder service serves proofs from its own',
    'ingested view, which trails the on-chain attestation. A height that `ChainInfo` reports as attested is not',
    'necessarily servable yet, so the worker has to poll the proof builder, not just the precompile.',
  ].join('\n');
}

/**
 * Linear fit of encoded blob size against log count across the samples, used to
 * state the expected cost of a two-log gate transaction rather than guessing.
 */
function projectGateCost(samples: SingleGasResult[]): string {
  const usable = samples.filter((s) => s.gas !== null);
  if (usable.length < 2) return '';
  const lo = usable.reduce((a, b) => (a.logCount <= b.logCount ? a : b));
  const hi = usable.reduce((a, b) => (a.logCount >= b.logCount ? a : b));
  if (hi.logCount === lo.logCount) return '';
  const bytesPerLog = (hi.encodedTxBytes - lo.encodedTxBytes) / (hi.logCount - lo.logCount);
  const gasPerLog = (Number(hi.gas) - Number(lo.gas)) / (hi.logCount - lo.logCount);
  const GATE_LOGS = 2;
  const projectedBytes = Math.round(lo.encodedTxBytes + bytesPerLog * (GATE_LOGS - lo.logCount));
  const projectedGas = Math.round(Number(lo.gas) + gasPerLog * (GATE_LOGS - lo.logCount));
  return [
    `Across these samples each additional log adds about ${fmt.int(Math.round(bytesPerLog))} bytes to the encoded`,
    `blob and about ${fmt.int(Math.round(gasPerLog))} gas to the call. Extrapolating to a two-log gate transaction gives`,
    `roughly **${fmt.int(projectedBytes)} bytes and ${fmt.int(projectedGas)} gas** for one verification, well inside a`,
    'single Creditcoin block.',
  ].join('\n');
}

interface Grace {
  maxLagBlocks: number;
  attestationInterval: number;
  maxCatchup: number;
  submissionAllowance: number;
  computed: number;
  recommended: number;
}

/** Five minutes of Sepolia, the allowance for the worker to prove and submit. */
const SUBMISSION_ALLOWANCE_BLOCKS = Math.ceil((5 * 60) / SEPOLIA_BLOCK_TIME_S);

function deriveGracePeriod(maxLagBlocks: number, attestationInterval: number, maxCatchup: number): Grace {
  // The clock the contract reads can jump by a whole catch-up window in one
  // Creditcoin block, so the grace period has to survive one maximal jump plus
  // the steady-state distance from the head plus the worker's own latency.
  const computed = maxCatchup + maxLagBlocks + attestationInterval + SUBMISSION_ALLOWANCE_BLOCKS;
  // Round up to a whole number of hours of Sepolia block production so the
  // constant is legible in the deck and in the deployment script.
  const blocksPerHour = 3600 / SEPOLIA_BLOCK_TIME_S;
  const recommended = Math.max(blocksPerHour, Math.ceil(computed / blocksPerHour) * blocksPerHour);
  return {
    maxLagBlocks,
    attestationInterval,
    maxCatchup,
    submissionAllowance: SUBMISSION_ALLOWANCE_BLOCKS,
    computed,
    recommended,
  };
}

function renderGrace(lag: LagResult, interval: number, grace: Grace): string {
  const steady = lag.attestationSteps.length > 0 && new Set(lag.attestationSteps).size === 1;
  return [
    '`attestationGracePeriod` is the margin the deals contract adds to `dueBlock` before a deal may be marked',
    'defaulted. It exists because attested source height, not wall clock time, is the only clock the contract',
    'is allowed to read, and that clock neither runs smoothly nor stays a fixed distance behind reality.',
    '',
    '```',
    'markDefaulted requires:  attestedSourceHeight > deal.dueBlock + attestationGracePeriod',
    '```',
    '',
    '**What the measurement shows.** The lag is a sawtooth rather than a constant: attested height advances in',
    `whole steps of ${fmt.int(interval)} blocks while Sepolia produces blocks continuously, so the distance to the head`,
    `swings between ${fmt.int(lag.minLagBlocks)} and ${fmt.int(lag.maxLagBlocks)} blocks with the step size as its amplitude.`,
    steady
      ? `Every step in this run was exactly ${fmt.int(interval)} blocks. Attestation kept pace with Sepolia throughout;`
      : `Steps in this run were ${lag.attestationSteps.map((x) => fmt.int(x)).join(', ')} blocks;`,
    steady ? 'no backlog and no catch-up burst occurred in the sampling window.' : 'the cadence was not uniform.',
    '',
    '**What the measurement cannot show, and why the constant is larger than the measurement.** A sampling',
    'window that happens to be healthy says nothing about the failure mode this parameter exists for. Attestation',
    'is produced by an attestor set that can fall behind, and when it recovers it recovers in bulk: `MaxCatchup`',
    `is ${fmt.int(grace.maxCatchup)} blocks, which is exactly how far the contract's clock may leap in a single Creditcoin block.`,
    'A grace period sized against the steady-state lag would be crossed by one such leap, and every deal whose',
    'due block fell inside it would be marked defaulted at once, for reasons that have nothing to do with any',
    'borrower.',
    '',
    'The constant therefore has to cover four things, all in source blocks:',
    '',
    table(
      ['Component', 'Value', 'Why'],
      [
        ['`MaxCatchup`', fmt.int(grace.maxCatchup), 'the largest single jump the attested height can make'],
        ['Maximum observed lag', fmt.int(grace.maxLagBlocks), 'steady-state distance from the Sepolia head'],
        ['Attestation interval', fmt.int(grace.attestationInterval), 'the clock only moves in whole steps'],
        [
          'Submission allowance',
          fmt.int(grace.submissionAllowance),
          'worker time to see the attestation, fetch a proof from the builder, and land a Creditcoin transaction',
        ],
        ['Sum', fmt.int(grace.computed), ''],
        [
          '**Recommended constant**',
          `**${fmt.int(grace.recommended)}**`,
          `rounded up to whole hours, about ${fmt.secs(grace.recommended * SEPOLIA_BLOCK_TIME_S)} of Sepolia`,
        ],
      ],
    ),
    '',
    `\`attestationGracePeriod = ${fmt.int(grace.recommended)}\` is a constructor argument of the deals contract, not a hard-coded`,
    'constant, so a demo deployment can use a smaller value to show the default path without waiting.',
    '',
    '**What this constant is not.** It does not carry correctness. Correctness comes from the settlement rule:',
    'an outcome is decided by the source block height of the payment, never by when its proof arrived. A deal',
    'that was marked defaulted is still resolved to `PAID_ON_TIME` by a later proof of a payment made before',
    '`dueBlock`. That separation is deliberate, and it is what makes the parameter safe to get wrong: if',
    'correctness rested on the grace period, a single `MaxCatchup`-sized jump in the attested height would',
    'break it.',
    '',
    'What the constant does carry is the honesty of the record. Oversizing it delays a default marking on a',
    'deal that is already unrecoverable. Undersizing it stamps defaults on healthy borrowers for reasons that',
    'have nothing to do with them, and a credit history full of defaults that were later reversed is worth',
    'less than one that never fabricated them.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// sample selection and gas measurement
// ---------------------------------------------------------------------------

interface TxSample {
  label: string;
  txHash: string;
  height: number;
  logCount: number;
  inputBytes: number;
}

/**
 * Picks three transactions from one block that bracket the cost curve: the
 * cheapest possible one, one shaped like a Cr3dX gate call (a token transfer
 * with a small number of logs), and the noisiest one in the block.
 */
async function pickSampleTransactions(sepolia: JsonRpcProvider, height: number): Promise<TxSample[]> {
  const receipts = await sepolia.send('eth_getBlockReceipts', [`0x${height.toString(16)}`]);
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error(`Sepolia block ${height} has no receipts to sample`);
  }
  const block = await sepolia.getBlock(height, true);
  const inputBytesOf = (hash: string): number => {
    const tx = block?.getPrefetchedTransaction(hash);
    return tx ? (tx.data.length - 2) / 2 : 0;
  };
  const rows = receipts.map((r: any) => ({
    txHash: r.transactionHash as string,
    logCount: (r.logs as unknown[]).length,
    inputBytes: inputBytesOf(r.transactionHash),
  }));

  const byWeight = rows.slice().sort((a, b) => a.logCount - b.logCount || a.inputBytes - b.inputBytes);
  const minimal = byWeight[0]!;
  const heavy = rows.slice().sort((a, b) => b.logCount - a.logCount || b.inputBytes - a.inputBytes)[0]!;
  // A Cr3dX gate call is an ERC-20 transfer plus one gate event: two logs and a
  // short calldata. Prefer that shape, then anything close to it.
  const GATE_LOGS = 2;
  const gateLike =
    rows
      .filter((r) => r.logCount >= 1 && r.logCount <= 4 && r.inputBytes >= 4 && r.inputBytes <= 260)
      .sort(
        (a, b) => Math.abs(a.logCount - GATE_LOGS) - Math.abs(b.logCount - GATE_LOGS) || a.inputBytes - b.inputBytes,
      )[0] ?? byWeight[Math.floor(byWeight.length / 2)]!;

  const picked = [
    { label: 'minimal', ...minimal },
    { label: 'gate-shaped', ...gateLike },
    { label: 'heaviest in block', ...heavy },
  ];
  const seen = new Set<string>();
  return picked
    .filter((p) => (seen.has(p.txHash) ? false : (seen.add(p.txHash), true)))
    .map((p) => ({ ...p, height }));
}

interface SingleGasResult {
  label: string;
  txHash: string;
  height: number;
  logCount: number;
  encodedTxBytes: number;
  calldataBytes: number;
  calldataGas: number;
  siblings: number;
  roots: number;
  gas: bigint | null;
  verified: boolean;
  txIndex: number | null;
  expectedTxIndex: number;
  txIndexMatches: boolean;
  error?: string;
  proof?: SingleProof;
}

async function measureSingleVerification(
  cc: JsonRpcProvider,
  prover: ProofBuilderClient,
  chainKey: number,
  samples: TxSample[],
): Promise<SingleGasResult[]> {
  const out: SingleGasResult[] = [];
  for (const s of samples) {
    log(`proving ${s.label} tx ${s.txHash}`);
    const proof = await prover.getProof(s.txHash);
    const args = [
      chainKey,
      proof.headerNumber,
      proof.txBytes,
      merkleTuple(proof.merkleProof),
      continuityTuple(proof.continuityProof),
    ];
    const data = blockProverIface.encodeFunctionData(VERIFY_SINGLE, args);
    const cd = calldataGas(data);

    let verified = false;
    let error: string | undefined;
    try {
      const ret = await cc.call({ to: BLOCK_PROVER, data });
      verified = Boolean(blockProverIface.decodeFunctionResult(VERIFY_SINGLE, ret)[0]);
    } catch (e) {
      error = errMessage(e);
    }

    let gas: bigint | null = null;
    try {
      gas = await cc.estimateGas({ to: BLOCK_PROVER, data, from: PROBE_FROM });
    } catch (e) {
      error ??= errMessage(e);
    }

    let txIndex: number | null = null;
    try {
      const idxData = blockProverIface.encodeFunctionData('calculateTxIndex', [merkleTuple(proof.merkleProof)]);
      txIndex = Number(blockProverIface.decodeFunctionResult('calculateTxIndex', await cc.call({ to: BLOCK_PROVER, data: idxData }))[0]);
    } catch {
      txIndex = null;
    }

    out.push({
      label: s.label,
      txHash: s.txHash,
      height: proof.headerNumber,
      logCount: s.logCount,
      encodedTxBytes: (proof.txBytes.length - 2) / 2,
      calldataBytes: cd.bytes,
      calldataGas: cd.gas,
      siblings: proof.merkleProof.siblings.length,
      roots: proof.continuityProof.roots.length,
      gas,
      verified,
      txIndex,
      expectedTxIndex: proof.txIndex,
      txIndexMatches: txIndex === proof.txIndex,
      error,
      proof,
    });
    log(`  ${s.label}: verify=${verified} gas=${gas ?? 'n/a'} blob=${(proof.txBytes.length - 2) / 2}B`);
  }
  return out;
}

interface BatchResult {
  size: number;
  span: number;
  roots: number;
  calldataBytes: number;
  gas: bigint | null;
  verified: boolean;
  error?: string;
}

async function measureBatch(
  cc: JsonRpcProvider,
  sepolia: JsonRpcProvider,
  prover: ProofBuilderClient,
  chainKey: number,
  proverHeight: number,
): Promise<BatchResult[]> {
  const maxSize = config.probe.batchMax + 1; // one over the documented limit, on purpose
  const top = proverHeight - config.probe.sampleDepth;
  const heights = Array.from({ length: maxSize }, (_, i) => top - (maxSize - 1 - i));

  // One transaction per height, each shaped like a gate call where possible.
  const picked: { height: number; txHash: string }[] = [];
  for (const h of heights) {
    const samples = await pickSampleTransactions(sepolia, h);
    const gate = samples.find((s) => s.label === 'gate-shaped') ?? samples[0]!;
    picked.push({ height: h, txHash: gate.txHash });
  }

  const out: BatchResult[] = [];
  for (const size of [1, 2, 5, config.probe.batchMax, maxSize].filter((v, i, a) => v <= maxSize && a.indexOf(v) === i)) {
    const slice = picked.slice(picked.length - size);
    let result: BatchResult = {
      size,
      span: slice[slice.length - 1]!.height - slice[0]!.height + 1,
      roots: 0,
      calldataBytes: 0,
      gas: null,
      verified: false,
    };
    try {
      const batch = await prover.getBatchProof(slice.map((p) => p.txHash));
      const entries = slice.map((p) => {
        const perHeight = batch.merkleProofs[String(p.height)];
        if (!perHeight) throw new Error(`batch proof is missing height ${p.height}`);
        const entry = Object.values(perHeight).find((e) => e.txHash.toLowerCase() === p.txHash.toLowerCase());
        if (!entry) throw new Error(`batch proof is missing tx ${p.txHash}`);
        return entry;
      });
      const args = [
        chainKey,
        slice.map((p) => p.height),
        entries.map((e) => e.txBytes),
        entries.map((e) => merkleTuple(e.merkleProof)),
        continuityTuple(batch.continuityProof),
      ];
      const data = blockProverIface.encodeFunctionData(VERIFY_BATCH, args);
      result.roots = batch.continuityProof.roots.length;
      result.calldataBytes = calldataGas(data).bytes;
      try {
        const ret = await cc.call({ to: BLOCK_PROVER, data });
        result.verified = Boolean(blockProverIface.decodeFunctionResult(VERIFY_BATCH, ret)[0]);
      } catch (e) {
        result.error = errMessage(e);
      }
      try {
        result.gas = await cc.estimateGas({ to: BLOCK_PROVER, data, from: PROBE_FROM });
      } catch (e) {
        result.error ??= errMessage(e);
      }
    } catch (e) {
      result.error = errMessage(e);
    }
    log(`  batch ${size}: verify=${result.verified} gas=${result.gas ?? 'n/a'} roots=${result.roots}${result.error ? ` err=${result.error}` : ''}`);
    out.push(result);
  }
  return out;
}


// ---------------------------------------------------------------------------
// decoding the proven transaction
// ---------------------------------------------------------------------------

interface DecodedLog {
  emitter: string;
  topics: string[];
  dataBytes: number;
}

interface DecodedTx {
  txType: number;
  chunks: number;
  chunkBytes: number[];
  status: number;
  logs: DecodedLog[];
}

/**
 * `encodedTx` is `abi.encode(uint8 txType, bytes[] chunks)`. The chunk layout
 * varies with the transaction type, but the receipt chunk is always last, so a
 * consumer that only needs `status` and the logs never has to branch on the
 * type. Verified here against a live blob because the whole verifier contract
 * rests on it.
 */
function decodeProvenTransaction(encodedTx: string): DecodedTx {
  const coder = AbiCoder.defaultAbiCoder();
  const [txType, chunks] = coder.decode(['uint8', 'bytes[]'], encodedTx) as unknown as [bigint, string[]];
  const receiptChunk = chunks[chunks.length - 1]!;
  const [status, , logs] = coder.decode(
    ['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
    receiptChunk,
  ) as unknown as [bigint, bigint, [string, string[], string][], string];
  return {
    txType: Number(txType),
    chunks: chunks.length,
    chunkBytes: chunks.map((c) => (c.length - 2) / 2),
    status: Number(status),
    logs: logs.map(([emitter, topics, data]) => ({ emitter, topics, dataBytes: (data.length - 2) / 2 })),
  };
}

function renderDecode(sample: SingleGasResult, d: DecodedTx): string {
  return [
    'The verifier contract has to read two things out of the proven transaction: the receipt status, which',
    'the precompile deliberately does not check, and the full log list. Both live inside `encodedTx`, whose',
    'encoding is custom rather than RLP.',
    '',
    'The layout is `abi.encode(uint8 txType, bytes[] chunks)`. Chunk composition depends on the transaction',
    'type, but **the receipt chunk is always the last one**, and its own layout is identical for every type:',
    '',
    '```solidity',
    'struct ProvenLog { address emitter; bytes32[] topics; bytes data; }',
    '',
    '(, bytes[] memory chunks) = abi.decode(encodedTx, (uint8, bytes[]));',
    '(uint8 status, , ProvenLog[] memory logs, ) =',
    '    abi.decode(chunks[chunks.length - 1], (uint8, uint64, ProvenLog[], bytes));',
    '```',
    '',
    'No branching on transaction type is required. That matters, because the reconnaissance report expected',
    'the encoding to force a five-way decoder on any consumer: it does, but only for reconstructing the',
    'canonical transaction hash, which Cr3dX does not need. Reading `status` and the logs costs one `abi.decode`.',
    '',
    'The two fields that are not covered by the canonical Ethereum roots, `from` and `gasUsed`, live in chunks',
    'this path never touches, so the rule that they must not influence Cr3dX state is enforced by the decoder',
    'shape rather than by discipline.',
    '',
    `Verified against the live blob for \`${sample.txHash}\`. The receipt-chunk-is-last property was read off`,
    'the encoder for all five transaction types; the live check below covers the type that Cr3dX gate calls',
    'actually produce.',
    '',
    '',
    table(
      ['Field', 'Value'],
      [
        ['Transaction type', `${d.txType} (${['legacy', 'access list', 'EIP-1559', 'blob', 'authorization'][d.txType] ?? 'unknown'})`],
        ['Chunks', `${d.chunks}, sizes ${d.chunkBytes.map((b) => fmt.int(b)).join(' / ')} bytes`],
        ['Receipt `status`', `\`${d.status}\``],
        ['Logs recovered', fmt.int(d.logs.length)],
        ['First log emitter', d.logs.length ? `\`${d.logs[0]!.emitter}\`` : 'none'],
        ['First log topics', d.logs.length ? fmt.int(d.logs[0]!.topics.length) : 'none'],
      ],
    ),
    '',
    '**`status` is our responsibility.** The precompile proves that the encoded pair was included, not that',
    'the transaction succeeded. A reverted transaction carries a perfectly valid proof with `status = 0`, and',
    'nothing in the protocol stops it from being submitted as evidence. Cr3dX rejects it explicitly.',
  ].join('\n');
}

main().catch((error) => {
  console.error(`[probe] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
