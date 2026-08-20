import { FACE_VALUE, FUNDING } from './live-plan.js';

export type LiveMode = 'fresh' | 'continue';

export interface LiveOptions {
  mode: LiveMode;
  runs: number;
  preflightOnly: boolean;
  resumeDeal: string | null;
}

/** B permanently spends only the difference between repayment and funding. */
export const BORROWER_USDC_PER_RUN = FACE_VALUE - FUNDING;

export function parseLiveOptions(argv: string[]): LiveOptions {
  let mode: LiveMode | undefined;
  let runs = 1;
  let preflightOnly = false;
  let resumeDeal: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      const value = argv[++i];
      if (value !== 'fresh' && value !== 'continue') {
        throw new Error(`--mode must be fresh or continue, got ${value ?? 'nothing'}`);
      }
      mode = value;
    } else if (arg === '--runs') {
      const value = argv[++i];
      runs = Number(value);
      if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${value ?? 'nothing'}`);
    } else if (arg === '--preflight-only') {
      preflightOnly = true;
    } else if (arg === '--resume-deal') {
      const value = argv[++i];
      if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`--resume-deal must be a bytes32 deal id, got ${value ?? 'nothing'}`);
      }
      resumeDeal = value;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!mode) throw new Error('Choose an explicit mode: --mode fresh or --mode continue');
  if (resumeDeal && mode !== 'continue') throw new Error('--resume-deal is only valid with --mode continue');
  if (resumeDeal && runs !== 1) throw new Error('--resume-deal cannot be combined with multiple runs');
  return {mode, runs, preflightOnly, resumeDeal};
}

export function runCapacity(balance: bigint, perRun: bigint): bigint {
  if (perRun <= 0n) throw new Error('per-run amount must be positive');
  return balance / perRun;
}

export function requiredBorrowerUsdc(runs: number): bigint {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  return BORROWER_USDC_PER_RUN * BigInt(runs);
}
