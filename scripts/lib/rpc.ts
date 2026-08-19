import { JsonRpcProvider, Network } from 'ethers';
import { blake2AsHex, xxhashAsHex } from '@polkadot/util-crypto';
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';

export function evmProvider(url: string, chainId?: number): JsonRpcProvider {
  return chainId === undefined
    ? new JsonRpcProvider(url)
    : new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true });
}

let rpcId = 0;

export async function substrateRpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method} failed with HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

/** SCALE encoding of a u64 as a hex string (little endian, 8 bytes). */
export function scaleU64(value: number | bigint): string {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), true);
  return u8aToHex(buf);
}

export function decodeScaleU64(hex: string | null): bigint | null {
  if (!hex || hex === '0x') return null;
  const bytes = hexToU8a(hex);
  if (bytes.length < 8) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

export function decodeScaleU32(hex: string | null): number | null {
  if (!hex || hex === '0x') return null;
  const bytes = hexToU8a(hex);
  if (bytes.length < 4) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

/** Storage key of a `StorageMap<_, Blake2_128Concat, K, V>` entry. */
export function blake2ConcatMapKey(pallet: string, item: string, scaleEncodedKey: string): string {
  const key = hexToU8a(scaleEncodedKey);
  return u8aToHex(
    u8aConcat(
      hexToU8a(xxhashAsHex(pallet, 128)),
      hexToU8a(xxhashAsHex(item, 128)),
      hexToU8a(blake2AsHex(key, 128)),
      key,
    ),
  );
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      onRetry?.(i, error);
      if (i < attempts) await sleep(1_000 * 2 ** (i - 1));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${errMessage(last)}`);
}

export function errMessage(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return short ?? error.message;
  }
  return String(error);
}
