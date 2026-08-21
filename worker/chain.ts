import {
  Contract,
  Interface,
  JsonRpcProvider,
  Network,
  Transaction,
  Wallet,
  getAddress,
  keccak256,
  toBeHex,
  zeroPadValue,
  type TransactionRequest,
} from 'ethers';
import {ProofBuilderClient, continuityTuple, merkleTuple, type SingleProof} from '../scripts/lib/proofs.js';
import {decodeScaleU32, decodeScaleU64, scaleU64, substrateRpc} from '../scripts/lib/rpc.js';
import type {
  ContractEvidenceState,
  DecodedGatewayEvent,
  Hex,
  WorkerConfig,
} from './types.js';

const VERIFIER_ABI = [
  'function chainKey() view returns (uint64)',
  'function gateway() view returns (address)',
  'function fundingTopic() view returns (bytes32)',
  'function repaymentTopic() view returns (bytes32)',
  'function seen(bytes32 evidenceId) view returns (bool)',
  'function evidenceIdOf(uint64 height,uint64 txIndex,uint8 kind,uint256 eventNonce) view returns (bytes32)',
];
const DEALS_ABI = [
  'function verifier() view returns (address)',
  'function chainKey() view returns (uint64)',
  'function submitAndApply(uint64 height,bytes encodedTx,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof,(bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) returns (bytes32[])',
  'function applyEvidence(bytes32 evidenceId) returns (uint8 state,uint8 reason)',
  'function evidenceStateOf(bytes32 evidenceId) view returns (uint8 state,uint8 reason)',
  'function getDeal(bytes32 dealId) view returns ((address borrower,uint64 dueBlock,uint8 status,address designatedInvestor,uint96 dealSeq,address investor,uint256 requiredFunding,uint256 fundedAmount,uint256 faceValue,uint256 repaidAmount,uint256 onTimeRepaid))',
];
const GATEWAY_IFACE = new Interface([
  'event FundingMade(bytes32 indexed dealId,address indexed investor,address indexed borrower,uint256 amount,uint256 nonce)',
  'event RepaymentMade(bytes32 indexed dealId,address indexed payer,address indexed investor,uint256 amount,uint256 nonce)',
]);

export interface RawSourceReceipt {
  transactionHash: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionIndex: number;
  status: number;
  logs: Array<{address: Hex; topics: Hex[]; data: Hex; logIndex: number; transactionHash: Hex}>;
}

export interface CandidateLogRef {
  transactionHash: Hex;
  blockNumber: number;
  blockHash: Hex;
  logIndex: number;
  topic0: Hex;
}

export interface DestinationReceipt {
  hash: Hex;
  status: number;
  blockNumber: number;
  blockHash: Hex;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface DealView {
  status: number;
  designatedInvestor: Hex;
}

export interface PreparedTransaction {
  request: TransactionRequest;
  estimate: bigint;
  gasLimit: bigint;
  price: bigint;
}

export function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Record<string, unknown>;
  for (const value of [candidate.data, (candidate.info as Record<string, unknown> | undefined)?.error]) {
    if (typeof value === 'string' && value.startsWith('0x')) return value;
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      if (typeof nested.data === 'string' && nested.data.startsWith('0x')) return nested.data;
    }
  }
  return undefined;
}

export class WorkerChain {
  readonly source: JsonRpcProvider;
  readonly destination: JsonRpcProvider;
  readonly verifier: Contract;
  readonly deals: Contract;
  readonly prover: ProofBuilderClient;
  readonly wallet?: Wallet;

  constructor(readonly config: WorkerConfig, privateKey?: Hex) {
    this.source = new JsonRpcProvider(config.sourceRpcUrl, Network.from(config.sourceChainId), {staticNetwork: true});
    this.destination = new JsonRpcProvider(config.destinationRpcUrl, Network.from(config.destinationChainId), {
      staticNetwork: true,
    });
    this.verifier = new Contract(config.verifierAddress, VERIFIER_ABI, this.destination);
    this.deals = new Contract(config.dealsAddress, DEALS_ABI, this.destination);
    this.prover = new ProofBuilderClient(config.proofBuilderUrl, config.sourceChainKey);
    if (privateKey) this.wallet = new Wallet(privateKey, this.destination);
  }

  signerAddress(): Hex {
    if (!this.wallet) throw new Error('Signing key is not available');
    return this.wallet.address as Hex;
  }

  async sourceHead(): Promise<number> {
    return this.source.getBlockNumber();
  }

  async candidateLogs(fromBlock: number, toBlock: number): Promise<CandidateLogRef[]> {
    if (toBlock - fromBlock + 1 > 1_000) throw new Error('Source query exceeds the 1,000-block window');
    const logs = await this.source.getLogs({
      address: this.config.gatewayAddress,
      fromBlock,
      toBlock,
      topics: [[this.config.fundingTopic, this.config.repaymentTopic]],
    });
    return logs.map((log) => ({
      transactionHash: log.transactionHash.toLowerCase() as Hex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash as Hex,
      logIndex: log.index,
      topic0: log.topics[0] as Hex,
    }));
  }

  async sourceReceipt(transactionHash: Hex): Promise<RawSourceReceipt | null> {
    const raw = (await this.source.send('eth_getTransactionReceipt', [transactionHash])) as Record<string, unknown> | null;
    if (!raw) return null;
    const blockNumber = Number(BigInt(raw.blockNumber as string));
    const blockHash = raw.blockHash as Hex;
    const canonicalBlock = await this.source.getBlock(blockNumber);
    if (!canonicalBlock?.hash || canonicalBlock.hash.toLowerCase() !== blockHash.toLowerCase()) return null;
    return {
      transactionHash: raw.transactionHash as Hex,
      blockNumber,
      blockHash,
      transactionIndex: Number(BigInt(raw.transactionIndex as string)),
      status: Number(BigInt(raw.status as string)),
      logs: (raw.logs as Array<Record<string, unknown>>).map((log) => ({
        address: log.address as Hex,
        topics: log.topics as Hex[],
        data: log.data as Hex,
        logIndex: Number(BigInt(log.logIndex as string)),
        transactionHash: log.transactionHash as Hex,
      })),
    };
  }

  decodeGatewayEvents(receipt: RawSourceReceipt): DecodedGatewayEvent[] {
    const events: DecodedGatewayEvent[] = [];
    for (let ordinal = 0; ordinal < receipt.logs.length; ordinal += 1) {
      const log = receipt.logs[ordinal]!;
      if (log.address.toLowerCase() !== this.config.gatewayAddress.toLowerCase()) continue;
      const topic = log.topics[0]?.toLowerCase();
      if (topic !== this.config.fundingTopic.toLowerCase() && topic !== this.config.repaymentTopic.toLowerCase()) continue;
      if (log.topics.length !== 4 || (log.data.length - 2) / 2 !== 64) throw new Error('MATCHING_LOG_SHAPE_MISMATCH');
      let parsed;
      try {
        parsed = GATEWAY_IFACE.parseLog({topics: log.topics, data: log.data});
      } catch {
        throw new Error('MATCHING_LOG_ABI_MISMATCH');
      }
      if (!parsed) throw new Error('MATCHING_LOG_ABI_MISMATCH');
      const funding = parsed.name === 'FundingMade';
      events.push({
        sourceChainId: this.config.sourceChainId,
        transactionHash: receipt.transactionHash,
        sourceBlockNumber: receipt.blockNumber,
        sourceBlockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        transactionLogOrdinal: ordinal,
        rpcLogIndex: log.logIndex,
        emitter: getAddress(log.address) as Hex,
        kind: funding ? 'FUNDING' : 'REPAYMENT',
        dealId: parsed.args[0] as Hex,
        counterparty: getAddress(parsed.args[1]) as Hex,
        recipient: getAddress(parsed.args[2]) as Hex,
        amount: (parsed.args[3] as bigint).toString(),
        eventNonce: (parsed.args[4] as bigint).toString(),
      });
    }
    return events;
  }

  async evidenceId(event: DecodedGatewayEvent): Promise<Hex> {
    return (await this.verifier.getFunction('evidenceIdOf')(
      event.sourceBlockNumber,
      event.transactionIndex,
      event.kind === 'FUNDING' ? 0 : 1,
      event.eventNonce,
    )) as Hex;
  }

  async seen(evidenceId: Hex): Promise<boolean> {
    return (await this.verifier.getFunction('seen')(evidenceId)) as boolean;
  }

  async evidenceState(evidenceId: Hex): Promise<{state: ContractEvidenceState; reason: string}> {
    const result = await this.deals.getFunction('evidenceStateOf')(evidenceId);
    const states: ContractEvidenceState[] = ['UNSEEN', 'VERIFIED_PENDING', 'APPLIED', 'REJECTED_PERMANENT'];
    const reasons = ['NONE', 'WRONG_INVESTOR', 'WRONG_RECIPIENT'];
    const state = states[Number(result[0])];
    if (!state) throw new Error(`Unknown on-chain evidence state ${result[0]}`);
    return {state, reason: reasons[Number(result[1])] ?? `UNKNOWN_${result[1]}`};
  }

  async dealView(dealId: Hex): Promise<DealView> {
    const result = await this.deals.getFunction('getDeal')(dealId);
    const deal = result[0] ?? result;
    return {status: Number(deal.status ?? deal[2]), designatedInvestor: getAddress(deal.designatedInvestor ?? deal[3]) as Hex};
  }

  async attestedHeight(): Promise<number> {
    return this.prover.attestedHeight();
  }

  async freshProof(transactionHash: Hex): Promise<SingleProof> {
    return this.prover.getProof(transactionHash, 1);
  }

  submissionRequest(proof: SingleProof): TransactionRequest {
    return {
      to: this.config.dealsAddress,
      data: this.deals.interface.encodeFunctionData('submitAndApply', [
        proof.headerNumber,
        proof.txBytes,
        merkleTuple(proof.merkleProof),
        continuityTuple(proof.continuityProof),
      ]),
      value: 0n,
    };
  }

  applicationRequest(evidenceId: Hex): TransactionRequest {
    return {
      to: this.config.dealsAddress,
      data: this.deals.interface.encodeFunctionData('applyEvidence', [evidenceId]),
      value: 0n,
    };
  }

  async simulate(request: TransactionRequest): Promise<{ok: true} | {ok: false; revertData?: string}> {
    if (!this.wallet) throw new Error('Signing key is not available');
    try {
      await this.destination.call({...request, from: this.wallet.address});
      return {ok: true};
    } catch (error) {
      return {ok: false, revertData: extractRevertData(error)};
    }
  }

  async prepare(request: TransactionRequest, nonce: number): Promise<PreparedTransaction> {
    if (!this.wallet) throw new Error('Signing key is not available');
    const base = {...request, from: this.wallet.address, nonce};
    const estimate = await this.destination.estimateGas(base);
    const gasLimit = (estimate * 120n + 99n) / 100n;
    const fees = await this.destination.getFeeData();
    if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
      return {
        request: {
          ...request,
          nonce,
          chainId: this.config.destinationChainId,
          type: 2,
          gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        },
        estimate,
        gasLimit,
        price: fees.maxFeePerGas,
      };
    }
    if (fees.gasPrice === null) throw new Error('Destination RPC returned no usable fee data');
    return {
      request: {...request, nonce, chainId: this.config.destinationChainId, type: 0, gasLimit, gasPrice: fees.gasPrice},
      estimate,
      gasLimit,
      price: fees.gasPrice,
    };
  }

  async sign(request: TransactionRequest): Promise<{raw: Hex; hash: Hex}> {
    if (!this.wallet) throw new Error('Signing key is not available');
    const raw = (await this.wallet.signTransaction(request)) as Hex;
    return {raw, hash: keccak256(raw) as Hex};
  }

  async broadcast(raw: Hex): Promise<Hex> {
    const response = await this.destination.broadcastTransaction(raw);
    return response.hash as Hex;
  }

  async destinationReceipt(hash: Hex): Promise<DestinationReceipt | null> {
    const receipt = await this.destination.getTransactionReceipt(hash);
    if (!receipt) return null;
    return {
      hash: receipt.hash as Hex,
      status: receipt.status ?? 0,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash as Hex,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
    };
  }

  async destinationHead(): Promise<number> {
    return this.destination.getBlockNumber();
  }

  async canonicalDestinationBlockHash(blockNumber: number): Promise<Hex | null> {
    return ((await this.destination.getBlock(blockNumber))?.hash as Hex | undefined) ?? null;
  }

  async destinationBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.destination.getBlock(blockNumber);
    if (!block) throw new Error(`Destination block ${blockNumber} is unavailable`);
    return block.timestamp;
  }

  async nonces(): Promise<{latest: number; pending: number}> {
    if (!this.wallet) throw new Error('Signing key is not available');
    const [latest, pending] = await Promise.all([
      this.destination.getTransactionCount(this.wallet.address, 'latest'),
      this.destination.getTransactionCount(this.wallet.address, 'pending'),
    ]);
    return {latest, pending};
  }

  async signerBalance(): Promise<bigint> {
    if (!this.wallet) throw new Error('Signing key is not available');
    return this.destination.getBalance(this.wallet.address);
  }

  async runtimeIntervals(): Promise<{attestationInterval: number; checkpointInterval: number}> {
    const key = scaleU64(this.config.sourceChainKey);
    const [attestationRaw, checkpointRaw] = await Promise.all([
      substrateRpc<string>(this.config.destinationSubstrateRpcUrl, 'state_call', [
        'AttestorApi_chain_attestation_interval',
        key,
      ]),
      substrateRpc<string>(this.config.destinationSubstrateRpcUrl, 'state_call', [
        'AttestorApi_attestation_checkpoint_interval',
        key,
      ]),
    ]);
    const attestationInterval = Number(decodeScaleU64(attestationRaw));
    const checkpointInterval = decodeScaleU32(checkpointRaw);
    if (!Number.isSafeInteger(attestationInterval) || checkpointInterval === null) {
      throw new Error('Runtime interval RPC returned malformed SCALE values');
    }
    return {attestationInterval, checkpointInterval};
  }

  async assertDeploymentConfiguration(): Promise<void> {
    const [sourceChainIdRaw, destinationChainIdRaw, verifierChainKey, gateway, fundingTopic, repaymentTopic, dealsVerifier, dealsChainKey] = await Promise.all([
      this.source.send('eth_chainId', []),
      this.destination.send('eth_chainId', []),
      this.verifier.getFunction('chainKey')(),
      this.verifier.getFunction('gateway')(),
      this.verifier.getFunction('fundingTopic')(),
      this.verifier.getFunction('repaymentTopic')(),
      this.deals.getFunction('verifier')(),
      this.deals.getFunction('chainKey')(),
    ]);
    const mismatches: string[] = [];
    if (Number(BigInt(sourceChainIdRaw as string)) !== this.config.sourceChainId) mismatches.push('source chain ID');
    if (Number(BigInt(destinationChainIdRaw as string)) !== this.config.destinationChainId) mismatches.push('destination chain ID');
    if (Number(verifierChainKey) !== this.config.sourceChainKey) mismatches.push('verifier chainKey');
    if (Number(dealsChainKey) !== this.config.sourceChainKey) mismatches.push('deals chainKey');
    if (getAddress(gateway) !== getAddress(this.config.gatewayAddress)) mismatches.push('gateway');
    if ((fundingTopic as string).toLowerCase() !== this.config.fundingTopic.toLowerCase()) mismatches.push('funding topic');
    if ((repaymentTopic as string).toLowerCase() !== this.config.repaymentTopic.toLowerCase()) mismatches.push('repayment topic');
    if (getAddress(dealsVerifier) !== getAddress(this.config.verifierAddress)) mismatches.push('deals verifier');
    if (mismatches.length > 0) throw new Error(`Deployment/configuration mismatch: ${mismatches.join(', ')}`);
  }

  static topicAddress(topic: Hex): Hex {
    return getAddress(`0x${topic.slice(-40)}`) as Hex;
  }

  static canonicalTopicAddress(address: Hex): Hex {
    return zeroPadValue(address, 32) as Hex;
  }

  static quantity(value: number): Hex {
    return toBeHex(value) as Hex;
  }

  static decodeSignedEnvelope(raw: Hex): Transaction {
    return Transaction.from(raw);
  }
}
