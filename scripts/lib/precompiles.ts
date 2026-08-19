import { Interface, JsonRpcProvider, dataLength, toUtf8String } from 'ethers';

/** Attestcoin precompile addresses. Source: runtime/src/precompiles.rs. */
export const BLOCK_PROVER = '0x0000000000000000000000000000000000000FD2';
export const CHAIN_INFO = '0x0000000000000000000000000000000000000FD3';

/**
 * Hand-written from precompiles/metadata/sol/block_prover.sol and chain_info.sol
 * on gluwa/creditcoin3 @ 06657e9. Kept here rather than pulled from the SDK so
 * the exact calldata layout stays under our control while measuring gas.
 */
export const BLOCK_PROVER_ABI = [
  'function verify(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) view returns (bool)',
  'function verify(uint64 chainKey, uint64[] heights, bytes[] encodedTransactions, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs, (bytes32 lowerEndpointDigest,bytes32[] roots) sharedContinuityProof) view returns (bool)',
  'function verifyAndEmit(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) returns (bool)',
  'function verifyAndEmit(uint64 chainKey, uint64[] heights, bytes[] encodedTransactions, (bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs, (bytes32 lowerEndpointDigest,bytes32[] roots) sharedContinuityProof) returns (bool)',
  'function calculateTxIndex((bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof) view returns (uint64)',
  'event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex)',
] as const;

export const CHAIN_INFO_ABI = [
  'function get_supported_chains() view returns ((uint64 chainKey,uint64 chainId,bytes chainName,uint8 chainEncoding)[] chains)',
  'function get_chain_by_key(uint64 chainKey) view returns (((uint64 chainKey,uint64 chainId,bytes chainName,uint8 chainEncoding) info,bool exists) result)',
  'function get_attestation_genesis_height(uint64 chainKey) view returns (uint64 genesisHeight)',
  'function get_latest_attestation_height_and_hash(uint64 chainKey) view returns ((uint64 height,bytes32 hash,bool isAttestation,bool exists) result)',
  'function get_latest_checkpoint_height_and_hash(uint64 chainKey) view returns ((uint64 height,bytes32 hash,bool isAttestation,bool exists) result)',
  'function is_height_attested(uint64 chainKey, uint64 targetHeight) view returns (bool isAttested)',
  'function get_attestation_bounds(uint64 chainKey, uint64 targetHeight) view returns ((uint64 parentHeight,bytes32 parentHash,bool parentIsAttestation,uint64 childHeight,bytes32 childHash,bool childIsAttestation,bool isAttested) result)',
] as const;

export const blockProverIface = new Interface([...BLOCK_PROVER_ABI]);
export const chainInfoIface = new Interface([...CHAIN_INFO_ABI]);

/** Fragment signatures, needed because verify/verifyAndEmit are overloaded. */
export const VERIFY_SINGLE = 'verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))';
export const VERIFY_BATCH = 'verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))';
export const VERIFY_AND_EMIT_SINGLE = 'verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))';
export const VERIFY_AND_EMIT_BATCH = 'verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))';

export interface RegisteredChain {
  chainKey: number;
  chainId: number;
  chainName: string;
  chainEncoding: number;
}

export interface AttestationHead {
  height: number;
  digest: string;
  isAttestation: boolean;
  exists: boolean;
}

export class ChainInfoReader {
  constructor(private readonly provider: JsonRpcProvider) {}

  private async call(fn: string, args: unknown[]): Promise<any> {
    const data = chainInfoIface.encodeFunctionData(fn, args);
    const ret = await this.provider.call({ to: CHAIN_INFO, data });
    return chainInfoIface.decodeFunctionResult(fn, ret);
  }

  async getSupportedChains(): Promise<RegisteredChain[]> {
    const [chains] = await this.call('get_supported_chains', []);
    return (chains as any[]).map((c) => ({
      chainKey: Number(c.chainKey),
      chainId: Number(c.chainId),
      chainName: decodeChainName(c.chainName),
      chainEncoding: Number(c.chainEncoding),
    }));
  }

  async getLatestAttestation(chainKey: number): Promise<AttestationHead> {
    const [r] = await this.call('get_latest_attestation_height_and_hash', [chainKey]);
    return { height: Number(r.height), digest: r.hash, isAttestation: r.isAttestation, exists: r.exists };
  }

  async getLatestCheckpoint(chainKey: number): Promise<AttestationHead> {
    const [r] = await this.call('get_latest_checkpoint_height_and_hash', [chainKey]);
    return { height: Number(r.height), digest: r.hash, isAttestation: r.isAttestation, exists: r.exists };
  }

  async getAttestationGenesisHeight(chainKey: number): Promise<number> {
    const [h] = await this.call('get_attestation_genesis_height', [chainKey]);
    return Number(h);
  }

  async isHeightAttested(chainKey: number, height: number): Promise<boolean> {
    const [ok] = await this.call('is_height_attested', [chainKey, height]);
    return Boolean(ok);
  }
}

/** `chainName` is `bytes` on the wire; the registry stores plain ASCII. */
function decodeChainName(raw: string): string {
  try {
    return toUtf8String(raw);
  } catch {
    return raw;
  }
}

/** Intrinsic calldata gas under EIP-2028: 4 per zero byte, 16 per non-zero byte. */
export function calldataGas(data: string): { bytes: number; zeroBytes: number; gas: number } {
  const bytes = dataLength(data);
  let zeroBytes = 0;
  for (let i = 2; i < data.length; i += 2) {
    if (data[i] === '0' && data[i + 1] === '0') zeroBytes++;
  }
  return { bytes, zeroBytes, gas: zeroBytes * 4 + (bytes - zeroBytes) * 16 };
}
