/**
 * Creates the two local testnet wallets through Foundry's `cast wallet new`.
 *
 * Private keys are captured in memory, written only through the git-ignored
 * `.env` persistence boundary (or its resolved symlink target), and never
 * printed. Existing keys are preserved. Output contains addresses only, so it
 * is safe to paste into faucet forms and run logs.
 */
import { execFileSync } from 'node:child_process';
import {existsSync} from 'node:fs';
import { homedir } from 'node:os';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import { Wallet } from 'ethers';
import {updateWalletEnv, WALLET_ROLES} from './lib/env-persistence.js';

const ENV_PATH = '.env';
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

interface CastWallet {
  address: string;
  private_key: string;
}

function findCast(): string {
  const configured = process.env.CAST_BIN;
  if (configured) return configured;
  try {
    execFileSync('cast', ['--version'], { stdio: 'ignore' });
    return 'cast';
  } catch {
    const foundryCast = join(homedir(), '.foundry', 'bin', 'cast');
    if (existsSync(foundryCast)) return foundryCast;
  }
  throw new Error('Foundry cast was not found. Install Foundry or set CAST_BIN to the cast executable.');
}

function generateKeys(count: number): string[] {
  if (count === 0) return [];
  let stdout: string;
  try {
    stdout = execFileSync(findCast(), ['wallet', 'new', '--json', '--number', String(count)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Foundry failed to generate the wallets. Its output was suppressed in case it contained secrets.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Foundry returned unexpected wallet output. It was suppressed in case it contained secrets.');
  }
  if (!Array.isArray(parsed) || parsed.length !== count) {
    throw new Error('Foundry returned an unexpected wallet count. Its output was suppressed.');
  }
  return parsed.map((entry) => {
    const wallet = entry as Partial<CastWallet>;
    if (!wallet.private_key || !PRIVATE_KEY.test(wallet.private_key)) {
      throw new Error('Foundry returned an invalid private key. Its output was suppressed.');
    }
    const derived = new Wallet(wallet.private_key).address;
    if (!wallet.address || derived.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('Foundry wallet address/key validation failed. Its output was suppressed.');
    }
    return wallet.private_key;
  });
}

export interface WalletCreationOptions {
  envPath?: string;
  walletGenerator?: (count: number) => string[];
  writeLine?: (line: string) => void;
}

export function runWalletCreation(options: WalletCreationOptions = {}): void {
  const writeLine = options.writeLine ?? console.log;
  const {keys, symlink} = updateWalletEnv({
    envPath: options.envPath ?? ENV_PATH,
    generateKeys: options.walletGenerator ?? generateKeys,
  });

  for (let i = 0; i < WALLET_ROLES.length; i++) {
    writeLine(`${WALLET_ROLES[i]!.label}: ${new Wallet(keys[i]!).address}`);
  }
  writeLine(
    symlink
      ? 'Private keys were written to the protected .env symlink target and were not printed.'
      : 'Private keys were written to the ignored .env and were not printed.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runWalletCreation();
  } catch (error) {
    console.error(`[wallets] fatal: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
