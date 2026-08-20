/**
 * Creates the two local testnet wallets through Foundry's `cast wallet new`.
 *
 * Private keys are captured in memory, written only to the git-ignored `.env`,
 * and never printed. Existing keys are preserved. Output contains addresses
 * only, so it is safe to paste into faucet forms and run logs.
 */
import { execFileSync } from 'node:child_process';
import {chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';

const ENV_PATH = '.env';
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const roles = [
  { label: 'A (deployer/investor)', variable: 'DEPLOYER_PRIVATE_KEY' },
  { label: 'B (borrower/payer)', variable: 'BORROWER_PRIVATE_KEY' },
] as const;

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

function readKey(envText: string, variable: string): string | undefined {
  const match = envText.match(new RegExp(`^${variable}=(.+)$`, 'm'));
  if (!match) return undefined;
  const value = match[1]!.trim();
  if (!PRIVATE_KEY.test(value)) {
    throw new Error(`${variable} exists in .env but is invalid. Not printing it and refusing to overwrite it.`);
  }
  return value;
}

function generate(count: number): CastWallet[] {
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
    return { address: derived, private_key: wallet.private_key };
  });
}

function assertPrivateModeSupport(): void {
  if (process.platform === 'win32') return;
  const existing = existsSync(ENV_PATH);
  const checkedPath = existing ? ENV_PATH : `${ENV_PATH}.permissions-check-${process.pid}`;
  try {
    if (!existing) writeFileSync(checkedPath, '', {encoding: 'utf8', flag: 'wx', mode: 0o600});
    chmodSync(checkedPath, 0o600);
    const actual = statSync(checkedPath).mode & 0o777;
    if ((actual & 0o077) !== 0) {
      throw new Error(
        `the filesystem reports mode ${actual.toString(8)} after chmod 600; refusing to store private keys here. ` +
          'Use a checkout on a filesystem with Unix permissions, or provide the variables without an .env file.',
      );
    }
  } finally {
    if (!existing && existsSync(checkedPath)) unlinkSync(checkedPath);
  }
}

function main(): void {
  assertPrivateModeSupport();
  const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const existing = roles.map((role) => readKey(original, role.variable));
  const created = generate(existing.filter((key) => !key).length);
  let nextCreated = 0;
  const keys = existing.map((key) => key ?? created[nextCreated++]!.private_key);

  if (keys[0]!.toLowerCase() === keys[1]!.toLowerCase()) {
    throw new Error('Wallet A and wallet B are identical. Refusing to save duplicate roles.');
  }

  let next = original.trimEnd();
  for (let i = 0; i < roles.length; i++) {
    if (!existing[i]) next += `${next ? '\n' : ''}${roles[i]!.variable}=${keys[i]}`;
  }
  next += '\n';

  if (created.length > 0 || !existsSync(ENV_PATH)) {
    const tempPath = `${ENV_PATH}.tmp`;
    writeFileSync(tempPath, next, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, ENV_PATH);
  }
  chmodSync(ENV_PATH, 0o600);

  for (let i = 0; i < roles.length; i++) {
    console.log(`${roles[i]!.label}: ${new Wallet(keys[i]!).address}`);
  }
  console.log('Private keys are stored only in ignored .env and were not printed.');
}

try {
  main();
} catch (error) {
  console.error(`[wallets] fatal: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
