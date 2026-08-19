/**
 * Drives the Sepolia gateway on the live network and freezes the resulting
 * transactions, with their Attestcoin proofs, as fixtures.
 *
 *   npm run capture:gate
 *
 * Produces three transactions and then waits once for attestation to reach the
 * highest of them, because attestation trails the Sepolia head by roughly seven
 * minutes and the proof builder's own cache trails that. Sending everything
 * first and waiting once turns three waits into one.
 *
 * Transactions produced:
 *
 *   1. `fund`  - the ordinary investor-to-borrower path
 *   2. `repay` - the ordinary borrower-to-investor path
 *   3. one transaction carrying two `FundingMade` events for the same deal plus
 *      a counterfeit event with the same topic0 from a lookalike contract
 *
 * The third exists because an externally owned account can only make one gateway
 * call per transaction, and the verifier stage has to be tested against a real
 * attested transaction where two proofs must come out of one transaction and an
 * impostor must be ignored.
 *
 * Requires both local testnet wallets, a deployed gateway in
 * deployments/sepolia.json, test ETH for A/B, and test USDC.
 */
import {
  AbiCoder,
  Contract,
  ContractFactory,
  formatUnits,
  Interface,
  keccak256,
  toUtf8Bytes,
  type TransactionReceipt,
} from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, errMessage, sleep } from './lib/rpc.js';
import { ChainInfoReader } from './lib/precompiles.js';
import { ProofBuilderClient, type SingleProof } from './lib/proofs.js';
import { loadArtifact, readDeployment, writeDeployment } from './lib/artifacts.js';
import { liveWallets, signerFromEnv } from './lib/wallet.js';
import {
  diagnose,
  FACE_VALUE,
  FUNDING,
  PARTIAL_A,
  PARTIAL_B,
  renderProjection,
  type UsdcState,
} from './lib/live-plan.js';

const OUT_DIR = 'test/fixtures/gate';
const log = (msg: string): void => console.log(`[gate] ${msg}`);

const GATEWAY_ABI = [
  'function token() view returns (address)',
  'function nonce() view returns (uint256)',
  'function fund(bytes32 dealId, address borrower, uint256 amount)',
  'function repay(bytes32 dealId, address investor, uint256 amount)',
  'event FundingMade(bytes32 indexed dealId, address indexed investor, address indexed borrower, uint256 amount, uint256 nonce)',
  'event RepaymentMade(bytes32 indexed dealId, address indexed payer, address indexed investor, uint256 amount, uint256 nonce)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

interface Captured {
  name: string;
  why: string;
  txHash: string;
  blockNumber: number;
}

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const sepolia = evmProvider(config.sepoliaRpcUrl);
  const { deployer: investor, borrower: payer } = liveWallets(sepolia);

  const deployment = readDeployment('sepolia');
  if (!deployment?.gateway) {
    throw new Error('No gateway in deployments/sepolia.json. Run `npm run deploy:sepolia` first.');
  }
  const gatewayAddress = deployment.gateway as string;
  const gateway = new Contract(gatewayAddress, GATEWAY_ABI, investor);
  const tokenAddress = (await gateway.getFunction('token')()) as string;
  const token = new Contract(tokenAddress, ERC20_ABI, investor);
  const payerToken = token.connect(payer) as Contract;
  const payerGateway = gateway.connect(payer) as Contract;
  const decimals = Number(await token.getFunction('decimals')());

  log(`gateway ${gatewayAddress}, token ${tokenAddress} with ${decimals} decimals`);

  // Same projection and the same verdict as `npm run preflight`, deliberately.
  // This run sends real transactions, so it refuses to start on balances that
  // look like the wreckage of a previous attempt rather than a clean start.
  const existingHelper = deployment.doubleFundingFixture as string | undefined;
  const [investorHeld, payerHeld, helperHeld] = (await Promise.all([
    token.getFunction('balanceOf')(investor.address),
    token.getFunction('balanceOf')(payer.address),
    existingHelper ? token.getFunction('balanceOf')(existingHelper) : Promise.resolve(0n),
  ])) as [bigint, bigint, bigint];

  const actual: UsdcState = {a: investorHeld, b: payerHeld, helper: helperHeld};
  log(`A/investor ${investor.address}: ${formatUnits(investorHeld, decimals)} tokens`);
  log(`B/borrower-payer ${payer.address}: ${formatUnits(payerHeld, decimals)} tokens`);
  const diagnosis = diagnose(actual);
  log('USDC through the ordered run, projected from these balances:');
  for (const line of renderProjection(diagnosis.projection, decimals)) log(`  ${line}`);

  if (diagnosis.verdict !== 'ready') {
    const stage = diagnosis.stage ? ` These balances match exactly what ${diagnosis.stage} leaves behind.` : '';
    throw new Error(
      `Refusing to send transactions: ${diagnosis.summary}.${stage} ` +
        `${diagnosis.actions.join('; ')}. Run \`npm run preflight\` for the full picture.`,
    );
  }

  const captured: Captured[] = [];

  // -- 1 and 2: the ordinary paths ----------------------------------------
  await ensureAllowance(token, investor.address, gatewayAddress, FUNDING);

  const dealSimple = keccakLabel('cr3dx/fixture/simple-deal');
  log(`fund: deal ${dealSimple}, ${formatUnits(FUNDING, decimals)} from A to B`);
  const fundRc = await send(gateway.getFunction('fund')(dealSimple, payer.address, FUNDING));
  captured.push({
    name: 'fund',
    why: 'the ordinary investor-to-borrower path, one gateway event beside the token Transfer',
    txHash: fundRc.hash,
    blockNumber: fundRc.blockNumber,
  });

  // `send` returns only after the receipt succeeds. This check deliberately
  // sits between transactions: the minimum-funding plan relies on B receiving
  // FUNDING before B can spend FACE_VALUE.
  await requireTokenBalance(token, payer.address, FACE_VALUE, decimals, 'B after confirmed fund receipt');

  await ensureAllowance(payerToken, payer.address, gatewayAddress, FACE_VALUE);
  log(`repay: deal ${dealSimple}, ${formatUnits(FACE_VALUE, decimals)} from B to A`);
  const repayRc = await send(payerGateway.getFunction('repay')(dealSimple, investor.address, FACE_VALUE));
  captured.push({
    name: 'repay',
    why: 'the ordinary repayment path',
    txHash: repayRc.hash,
    blockNumber: repayRc.blockNumber,
  });

  // The same invariant protects the reused funds: A must have received the
  // repayment before approving/calling the double-funding helper.
  await requireTokenBalance(
    token,
    investor.address,
    PARTIAL_A + PARTIAL_B,
    decimals,
    'A after confirmed repay receipt',
  );

  // -- 3: two genuine fundings and one impostor in one transaction ---------
  const helperAddress = await ensureFixtureHelper(investor, gatewayAddress);
  await ensureAllowance(token, investor.address, helperAddress, PARTIAL_A + PARTIAL_B);

  const helperArtifact = loadArtifact('DoubleFundingFixture.sol', 'DoubleFundingFixture');
  const helper = new Contract(helperAddress, helperArtifact.abi as any, investor);
  const dealDouble = keccakLabel('cr3dx/fixture/double-funded-deal');
  log(`double funding: deal ${dealDouble}, ${formatUnits(PARTIAL_A, decimals)} + ${formatUnits(PARTIAL_B, decimals)}`);
  const doubleRc = await send(
    helper.getFunction('emitTwoFundingsAndOneImpostor')(dealDouble, payer.address, PARTIAL_A, PARTIAL_B),
  );
  captured.push({
    name: 'double-funding',
    why:
      'two FundingMade events for the same deal from the real gateway, differing only by event nonce, ' +
      'plus a counterfeit with the same topic0 from a lookalike contract',
    txHash: doubleRc.hash,
    blockNumber: doubleRc.blockNumber,
  });

  writeDeployment('sepolia', { doubleFundingFixture: helperAddress });

  // -- wait once, then prove everything ------------------------------------
  const highest = Math.max(...captured.map((c) => c.blockNumber));
  const chainKey = await resolveChainKey();
  const prover = new ProofBuilderClient(config.proofBuilderUrl, chainKey);
  await waitForAttestation(prover, highest);

  mkdirSync(OUT_DIR, { recursive: true });
  const index: unknown[] = [];
  for (const c of captured) {
    log(`proving ${c.name}: ${c.txHash}`);
    const proof = await prover.getProof(c.txHash, 5);
    const receipt = await sepolia.getTransactionReceipt(c.txHash);
    if (!receipt) throw new Error(`no receipt for ${c.txHash}`);
    const fixture = buildFixture(c, proof, receipt, {
      chainKey,
      gateway: gatewayAddress,
      token: tokenAddress,
      helper: helperAddress,
      dealSimple,
      dealDouble,
    });
    writeFileSync(`${OUT_DIR}/${c.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
    index.push({
      name: c.name,
      why: c.why,
      txHash: c.txHash,
      height: proof.headerNumber,
      logs: fixture.logs.length,
      gatewayLogs: fixture.gatewayLogs.length,
      impostorLogs: fixture.impostorLogs.length,
    });
    log(
      `  saved ${OUT_DIR}/${c.name}.json: ${fixture.logs.length} logs, ` +
        `${fixture.gatewayLogs.length} from the gateway, ${fixture.impostorLogs.length} impostor`,
    );
  }
  writeFileSync(`${OUT_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  log(`done, ${index.length} fixtures in ${OUT_DIR}`);
}

const gatewayIface = new Interface(GATEWAY_ABI);
const FUNDING_MADE_TOPIC = gatewayIface.getEvent('FundingMade')!.topicHash;
const REPAYMENT_MADE_TOPIC = gatewayIface.getEvent('RepaymentMade')!.topicHash;

function buildFixture(
  c: Captured,
  proof: SingleProof,
  receipt: TransactionReceipt,
  ctx: {
    chainKey: number;
    gateway: string;
    token: string;
    helper: string;
    dealSimple: string;
    dealDouble: string;
  },
): any {
  const coder = AbiCoder.defaultAbiCoder();
  const [txType, chunks] = coder.decode(['uint8', 'bytes[]'], proof.txBytes) as unknown as [bigint, string[]];
  const [status, , decodedLogs] = coder.decode(
    ['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
    chunks[chunks.length - 1]!,
  ) as unknown as [bigint, bigint, [string, string[], string][], string];

  const logs = receipt.logs.map((l) => ({ emitter: l.address, topics: [...l.topics], data: l.data }));

  // The attested blob and the Ethereum receipt must agree before anything is
  // written, for the same reason as in the decoder fixtures: otherwise the
  // fixture only proves that our decoder agrees with itself.
  if (decodedLogs.length !== logs.length) {
    throw new Error(`${c.name}: blob has ${decodedLogs.length} logs, receipt has ${logs.length}`);
  }
  for (let i = 0; i < logs.length; i++) {
    const a = decodedLogs[i]!;
    const b = logs[i]!;
    if (a[0].toLowerCase() !== b.emitter.toLowerCase()) {
      throw new Error(`${c.name}: log ${i} emitter differs between blob and receipt`);
    }
  }
  if (Number(status) !== Number(receipt.status)) {
    throw new Error(`${c.name}: status differs between blob and receipt`);
  }

  const isGatewayEvent = (l: { emitter: string; topics: string[] }): boolean =>
    l.emitter.toLowerCase() === ctx.gateway.toLowerCase() &&
    l.topics.length > 0 &&
    (l.topics[0] === FUNDING_MADE_TOPIC || l.topics[0] === REPAYMENT_MADE_TOPIC);

  const gatewayLogs = logs
    .map((l, index) => ({ index, ...l }))
    .filter(isGatewayEvent)
    .map((l) => ({
      logIndex: l.index,
      kind: l.topics[0] === FUNDING_MADE_TOPIC ? 'FUNDING' : 'REPAYMENT',
      dealId: l.topics[1],
      counterparty: `0x${l.topics[2]!.slice(26)}`,
      recipient: `0x${l.topics[3]!.slice(26)}`,
      amount: coder.decode(['uint256', 'uint256'], l.data)[0].toString(),
      eventNonce: coder.decode(['uint256', 'uint256'], l.data)[1].toString(),
    }));

  // Logs that carry a gateway topic0 but were emitted by something else. The
  // verifier must ignore exactly these, and only the emitter distinguishes them.
  const impostorLogs = logs
    .map((l, index) => ({ index, ...l }))
    .filter(
      (l) =>
        l.topics.length > 0 &&
        (l.topics[0] === FUNDING_MADE_TOPIC || l.topics[0] === REPAYMENT_MADE_TOPIC) &&
        l.emitter.toLowerCase() !== ctx.gateway.toLowerCase(),
    )
    .map((l) => ({ logIndex: l.index, emitter: l.emitter, topic0: l.topics[0] }));

  return {
    name: c.name,
    why: c.why,
    capturedAt: new Date().toISOString(),
    note:
      c.name === 'double-funding'
        ? 'The investor recorded in both FundingMade events is the helper contract, not an externally owned ' +
          'account, because the helper is the caller and the gateway records msg.sender on purpose. This is ' +
          'correct, not broken accounting.'
        : undefined,
    chainKey: ctx.chainKey,
    sourceChainId: config.sourceEvmChainId,
    gateway: ctx.gateway,
    token: ctx.token,
    impostorContract: c.name === 'double-funding' ? ctx.helper : undefined,
    dealId: c.name === 'double-funding' ? ctx.dealDouble : ctx.dealSimple,
    txHash: proof.txHash,
    height: proof.headerNumber,
    txIndex: proof.txIndex,
    txType: Number(txType),
    status: Number(receipt.status),
    logCount: logs.length,
    logs,
    gatewayLogs,
    impostorLogs,
    encodedTx: proof.txBytes,
    merkleProof: proof.merkleProof,
    continuityProof: proof.continuityProof,
  };
}

async function resolveChainKey(): Promise<number> {
  const cc = evmProvider(config.creditcoinRpcUrl);
  const chains = await new ChainInfoReader(cc).getSupportedChains();
  const source = chains.find((c) => c.chainId === config.sourceEvmChainId);
  if (!source) throw new Error(`Source chain ${config.sourceEvmChainId} is not in the registry`);
  return source.chainKey;
}

/** Polls the proof builder, which trails the on-chain attestation. */
async function waitForAttestation(prover: ProofBuilderClient, height: number): Promise<void> {
  const started = Date.now();
  const timeoutMs = 45 * 60_000;
  for (;;) {
    const attested = await prover.attestedHeight().catch(() => -1);
    if (attested >= height) {
      log(`attested height ${attested} covers block ${height}`);
      return;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    log(`waiting for attestation: ${attested} of ${height}, ${height - attested} blocks to go, ${waited}s elapsed`);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Attestation did not reach block ${height} within 45 minutes. Transactions are on chain; rerun to prove them.`);
    }
    await sleep(30_000);
  }
}

async function ensureAllowance(token: Contract, owner: string, spender: string, amount: bigint): Promise<void> {
  const current = (await token.getFunction('allowance')(owner, spender)) as bigint;
  if (current >= amount) {
    log(`allowance for ${spender} is already sufficient`);
    return;
  }
  log(`approving ${spender} for ${amount}`);
  const rc = await send(token.getFunction('approve')(spender, amount));
  log(`  approved in ${rc.hash}`);
  const confirmed = (await token.getFunction('allowance')(owner, spender)) as bigint;
  if (confirmed < amount) {
    throw new Error(`Allowance for ${spender} is ${confirmed}, expected at least ${amount} after confirmed receipt`);
  }
}

async function requireTokenBalance(
  token: Contract,
  account: string,
  required: bigint,
  decimals: number,
  stage: string,
): Promise<void> {
  const held = (await token.getFunction('balanceOf')(account)) as bigint;
  log(`${stage}: ${formatUnits(held, decimals)} tokens, need ${formatUnits(required, decimals)}`);
  if (held < required) {
    throw new Error(
      `${stage} has ${formatUnits(held, decimals)} tokens, expected at least ${formatUnits(required, decimals)}`,
    );
  }
}

async function ensureFixtureHelper(signer: ReturnType<typeof signerFromEnv>, gateway: string): Promise<string> {
  const existing = readDeployment('sepolia');
  if (existing?.doubleFundingFixture) {
    log(`reusing fixture helper at ${existing.doubleFundingFixture}`);
    return existing.doubleFundingFixture as string;
  }
  const artifact = loadArtifact('DoubleFundingFixture.sol', 'DoubleFundingFixture');
  log('deploying the fixture helper (test infrastructure, not part of the system)');
  const factory = new ContractFactory(artifact.abi as any, artifact.bytecode, signer);
  const helper = await factory.deploy(gateway);
  await helper.waitForDeployment();
  const address = await helper.getAddress();
  log(`  helper at ${address}`);
  return address;
}

async function send(pending: Promise<any>): Promise<{ hash: string; blockNumber: number }> {
  const tx = await pending;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} failed`);
  return { hash: tx.hash, blockNumber: receipt.blockNumber };
}

/**
 * Deterministic per label, so a rerun names the same deals and the fixtures stay
 * comparable across captures. These are fixture identifiers only; real deal
 * identifiers are derived by the deals contract from its own state.
 */
function keccakLabel(label: string): string {
  return keccak256(toUtf8Bytes(label));
}

main().catch((error) => {
  console.error(`[gate] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
