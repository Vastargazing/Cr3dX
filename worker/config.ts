import {isAbsolute, resolve} from 'node:path';
import {getAddress, id} from 'ethers';
import type {Hex, WorkerConfig} from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === '') && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function positiveBigInt(name: string): bigint {
  const raw = required(name);
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(`${name} must be a non-zero base-10 integer`);
  return BigInt(raw);
}

function address(name: string): Hex {
  return getAddress(required(name)) as Hex;
}

export function loadWorkerConfig(): WorkerConfig {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Refusing S6 worker with NODE_TLS_REJECT_UNAUTHORIZED=0');
  }
  const stateDirRaw = required('CR3DX_WORKER_STATE_DIR');
  if (!isAbsolute(stateDirRaw)) throw new Error('CR3DX_WORKER_STATE_DIR must be absolute');
  return {
    stateDir: resolve(stateDirRaw),
    sourceRpcUrl: required('CR3DX_WORKER_SOURCE_RPC_URL'),
    destinationRpcUrl: required('CR3DX_WORKER_DESTINATION_RPC_URL'),
    destinationSubstrateRpcUrl: required('CR3DX_WORKER_DESTINATION_SUBSTRATE_RPC_URL'),
    proofBuilderUrl: required('CR3DX_WORKER_PROOF_BUILDER_URL').replace(/\/+$/, ''),
    sourceChainId: positiveInteger('CR3DX_WORKER_SOURCE_CHAIN_ID'),
    sourceChainKey: positiveInteger('CR3DX_WORKER_SOURCE_CHAIN_KEY'),
    destinationChainId: positiveInteger('CR3DX_WORKER_DESTINATION_CHAIN_ID'),
    sourceStartBlock: nonNegativeInteger('CR3DX_WORKER_SOURCE_START_BLOCK'),
    gatewayAddress: address('CR3DX_WORKER_GATEWAY_ADDRESS'),
    verifierAddress: address('CR3DX_WORKER_VERIFIER_ADDRESS'),
    dealsAddress: address('CR3DX_WORKER_DEALS_ADDRESS'),
    fundingTopic: id('FundingMade(bytes32,address,address,uint256,uint256)') as Hex,
    repaymentTopic: id('RepaymentMade(bytes32,address,address,uint256,uint256)') as Hex,
    pollIntervalMs: positiveInteger('CR3DX_WORKER_POLL_INTERVAL_MS', 5_000),
    limits: {
      maxNonTerminalTasks: 1_000,
      maxEventsPerTransaction: 32,
      transactionGasCap: positiveBigInt('CR3DX_WORKER_TRANSACTION_GAS_CAP'),
      maxFeePerGasCap: positiveBigInt('CR3DX_WORKER_MAX_FEE_PER_GAS'),
      rolling24HourFeeBudget: positiveBigInt('CR3DX_WORKER_ROLLING_24H_FEE_BUDGET'),
      minimumSignerBalanceReserve: positiveBigInt('CR3DX_WORKER_MINIMUM_BALANCE_RESERVE'),
    },
  };
}

export function privateKeyFromEnvironment(): Hex {
  const mode = process.env.CR3DX_WORKER_SECRET_MODE;
  if (mode !== 'file' && mode !== 'manager') throw new Error('CR3DX_WORKER_SECRET_MODE must be file or manager');
  const raw = process.env.CR3DX_WORKER_PRIVATE_KEY;
  if (!raw) throw new Error('CR3DX_WORKER_PRIVATE_KEY is not injected');
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('CR3DX_WORKER_PRIVATE_KEY is not a 32-byte hex key');
  return key as Hex;
}
