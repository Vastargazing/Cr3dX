/**
 * The hard gate: a real Sepolia transaction proven end to end on Creditcoin.
 *
 *   npm run verify:live
 *
 * Walks the whole path with nothing simulated:
 *
 *   real Sepolia transaction
 *     -> fresh Attestcoin proof from the proof builder
 *     -> Cr3dXVerifier.submitEvidence on Creditcoin
 *     -> verify, calculateTxIndex, status check, walk every log
 *     -> genuine gateway events accepted, lookalike ignored
 *     -> one immutable fact per genuine event
 *
 * Runs against the fixtures captured in `test/fixtures/gate/`, using their
 * transaction hashes only. **Proofs are fetched fresh, never replayed from the
 * fixture.** A continuity proof anchors to an attestation that the chain
 * eventually prunes: a proof captured two hours ago no longer verifies, while
 * the same transaction proves fine with a newly built proof. See
 * docs/ATTESTCOIN_INTEGRATION.md.
 */
import { Contract, Interface, formatUnits } from 'ethers';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { ProofBuilderClient } from './lib/proofs.js';
import { readDeployment } from './lib/artifacts.js';
import { signerFromEnv } from './lib/wallet.js';

const FIXTURE_DIR = 'test/fixtures/gate';
const log = (msg: string): void => console.log(`[live] ${msg}`);

const VERIFIER_ABI = [
  'function chainKey() view returns (uint64)',
  'function gateway() view returns (address)',
  'function seen(bytes32) view returns (bool)',
  'function evidenceIdOf(uint64 height, uint64 txIndex, uint8 kind, uint256 eventNonce) view returns (bytes32)',
  'function getEvidence(bytes32) view returns (tuple(bytes32 dealId, address counterparty, uint64 blockHeight, uint8 kind, bool recorded, address recipient, uint64 txIndex, uint256 amount, uint256 eventNonce))',
  'function submitEvidence(uint64 height, bytes encodedTx, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) returns (bytes32[])',
  'event EvidenceRecorded(bytes32 indexed evidenceId, bytes32 indexed dealId, uint8 indexed kind, address counterparty, address recipient, uint256 amount, uint64 blockHeight, uint64 txIndex, uint256 eventNonce)',
];

interface GateFixture {
  name: string;
  why: string;
  txHash: string;
  dealId: string;
  gatewayLogs: { kind: string; dealId: string; amount: string; eventNonce: string; recipient: string }[];
  impostorLogs: { emitter: string }[];
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);

  if (!existsSync(FIXTURE_DIR)) {
    throw new Error(
      `No gate fixtures in ${FIXTURE_DIR}. Run \`npm run capture:gate\` first: this check proves the live ` +
        'path end to end and has nothing to work on without real gateway transactions.',
    );
  }

  const deployment = readDeployment('creditcoin');
  if (!deployment?.verifier) {
    throw new Error('No verifier in deployments/creditcoin.json. Run `npm run deploy:creditcoin` first.');
  }

  const cc = evmProvider(config.creditcoinRpcUrl);
  const signer = signerFromEnv(cc);
  const verifier = new Contract(deployment.verifier as string, VERIFIER_ABI, signer);
  const iface = new Interface(VERIFIER_ABI);

  const chainKey = Number(await verifier.getFunction('chainKey')());
  const gateway = ((await verifier.getFunction('gateway')()) as string).toLowerCase();
  log(`verifier ${deployment.verifier}, chainKey ${chainKey}, trusts gateway ${gateway}`);

  const prover = new ProofBuilderClient(config.proofBuilderUrl, chainKey);

  const names = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''));

  let failures = 0;
  for (const name of names) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}.json`, 'utf8')) as GateFixture;
    log('');
    log(`=== ${fixture.name}: ${fixture.why}`);
    log(`    source tx https://sepolia.etherscan.io/tx/${fixture.txHash}`);

    // Fresh proof. Replaying the captured one would test nothing but our own
    // JSON, and would fail anyway once its anchor attestation has been pruned.
    const proof = await prover.getProof(fixture.txHash, 5);
    log(`    fresh proof: height ${proof.headerNumber}, ${proof.continuityProof.roots.length} continuity roots`);

    const args = [
      proof.headerNumber,
      proof.txBytes,
      [proof.merkleProof.root, proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft])],
      [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots],
    ];

    // Dry run first, so a failure is reported as a revert reason rather than as
    // a burnt transaction.
    let expectedIds: string[];
    try {
      expectedIds = (await verifier.getFunction('submitEvidence').staticCall(...args)) as string[];
    } catch (error) {
      log(`    FAILED before sending: ${errMessage(error)}`);
      failures++;
      continue;
    }

    const expectedCount = fixture.gatewayLogs.length;
    log(`    call would create ${expectedIds.length} facts; the fixture holds ${expectedCount} genuine gateway events`);
    if (fixture.impostorLogs.length > 0) {
      log(`    and ${fixture.impostorLogs.length} lookalike event(s) that must be ignored`);
    }

    const tx = await verifier.getFunction('submitEvidence')(...args);
    const receipt = await tx.wait();
    log(`    submitted ${tx.hash}, gas used ${receipt.gasUsed}`);

    const recorded = receipt.logs
      .filter((l: any) => l.address.toLowerCase() === (deployment.verifier as string).toLowerCase())
      .map((l: any) => iface.parseLog({ topics: l.topics, data: l.data }))
      .filter(Boolean);

    const problems: string[] = [];
    if (recorded.length !== expectedCount) {
      problems.push(`recorded ${recorded.length} facts, expected ${expectedCount}`);
    }
    const ids = new Set(recorded.map((e: any) => e.args.evidenceId as string));
    if (ids.size !== recorded.length) problems.push('duplicate evidence identifiers');

    for (let i = 0; i < recorded.length; i++) {
      const got = recorded[i]!.args;
      const want = fixture.gatewayLogs[i];
      if (!want) continue;
      if (got.dealId !== want.dealId) problems.push(`fact ${i}: dealId ${got.dealId} != ${want.dealId}`);
      if (got.amount.toString() !== want.amount) problems.push(`fact ${i}: amount ${got.amount} != ${want.amount}`);
      if (got.eventNonce.toString() !== want.eventNonce) {
        problems.push(`fact ${i}: eventNonce ${got.eventNonce} != ${want.eventNonce}`);
      }
      if ((got.recipient as string).toLowerCase() !== want.recipient.toLowerCase()) {
        problems.push(`fact ${i}: recipient ${got.recipient} != ${want.recipient}`);
      }
      const expectedKind = want.kind === 'FUNDING' ? 0 : 1;
      if (Number(got.kind) !== expectedKind) problems.push(`fact ${i}: kind ${got.kind} != ${want.kind}`);
      log(
        `    fact ${i}: ${want.kind} nonce ${got.eventNonce}, ${formatUnits(got.amount, 6)} to ${got.recipient}, id ${(got.evidenceId as string).slice(0, 12)}...`,
      );
    }

    // The lookalike must have left nothing. Its identifier is derivable, so this
    // is checkable rather than merely absent from the log list.
    for (const impostor of fixture.impostorLogs ?? []) {
      log(`    lookalike from ${impostor.emitter}: not recorded (emitter is not the gateway)`);
    }

    if (problems.length) {
      failures++;
      for (const p of problems) log(`    MISMATCH: ${p}`);
    } else {
      log(`    OK`);
    }
  }

  log('');
  if (failures > 0) {
    throw new Error(`${failures} of ${names.length} fixtures did not pass the live path`);
  }
  log(`all ${names.length} fixtures passed the live path end to end`);
}

main().catch((error) => {
  console.error(`[live] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
