import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename, dirname, resolve} from 'node:path';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export const WALLET_ROLES = [
  {label: 'A (deployer/investor)', variable: 'DEPLOYER_PRIVATE_KEY'},
  {label: 'B (borrower/payer)', variable: 'BORROWER_PRIVATE_KEY'},
] as const;

interface PreparedTarget {
  requestedPath: string;
  targetPath: string;
  original: string;
  existed: boolean;
  symlink: boolean;
  device?: bigint;
  inode?: bigint;
  size?: bigint;
  modifiedAt?: bigint;
}

export interface WalletEnvUpdateOptions {
  envPath: string;
  generateKeys: (count: number) => string[];
  /** Test seam for the crash boundary after the sibling is durable but before rename. */
  beforeRename?: () => void;
  /** Test seam for the POSIX ownership check; production always uses process.getuid(). */
  expectedUid?: number;
}

export interface WalletEnvUpdateResult {
  keys: [string, string];
  changed: boolean;
  targetPath: string;
  symlink: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function privateMode(path: string): void {
  if (process.platform === 'win32') return;
  chmodSync(path, 0o600);
  const actual = statSync(path, {bigint: true}).mode & 0o777n;
  if (actual !== 0o600n) {
    throw new Error(
      `The filesystem reports mode ${actual.toString(8)} after chmod 600; refusing to store private keys. ` +
        'Use a filesystem with private POSIX modes or inject the variables through the process environment.',
    );
  }
}

function assertOwnedRegularFile(
  path: string,
  expectedUid: number | undefined,
): {device: bigint; inode: bigint; size: bigint; modifiedAt: bigint} {
  const info = statSync(path, {bigint: true});
  if (!info.isFile()) throw new Error('The resolved .env target is not a regular file; refusing to store private keys.');
  if (process.platform !== 'win32' && expectedUid !== undefined && info.uid !== BigInt(expectedUid)) {
    throw new Error('The resolved .env target belongs to another user; refusing to store private keys.');
  }
  privateMode(path);
  const checked = statSync(path, {bigint: true});
  return {device: checked.dev, inode: checked.ino, size: checked.size, modifiedAt: checked.mtimeNs};
}

function assertPrivateParent(targetPath: string, expectedUid: number | undefined): void {
  if (process.platform === 'win32') return;
  const parent = statSync(dirname(targetPath), {bigint: true});
  if (!parent.isDirectory()) throw new Error('The .env target parent is not a directory; refusing to generate keys.');
  if (expectedUid !== undefined && parent.uid !== BigInt(expectedUid)) {
    throw new Error('The .env target parent belongs to another user; refusing to generate keys.');
  }
  if ((parent.mode & 0o022n) !== 0n) {
    throw new Error('The .env target parent is writable by group or others; refusing to generate keys.');
  }
}

function uniqueSibling(targetPath: string, purpose: string): string {
  return resolve(dirname(targetPath), `.${basename(targetPath)}.cr3dx-${purpose}-${process.pid}-${randomUUID()}`);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Verifies exclusive private creation and same-directory atomic rename before any key is generated. */
function assertPrivateAtomicFilesystem(targetPath: string): void {
  const first = uniqueSibling(targetPath, 'probe');
  const second = uniqueSibling(targetPath, 'probe-renamed');
  let fd: number | undefined;
  try {
    fd = openSync(first, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, '', {encoding: 'utf8'});
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    privateMode(first);
    renameSync(first, second);
    const renamed = lstatSync(second);
    if (!renamed.isFile()) throw new Error('The atomic-write probe did not remain a regular file.');
  } catch {
    throw new Error(
      'The .env target filesystem cannot complete a private atomic sibling write; no wallet keys were generated.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(first);
    removeIfPresent(second);
  }
}

function prepareTarget(envPath: string, expectedUid: number | undefined): PreparedTarget {
  const requestedPath = resolve(envPath);
  let requested;
  try {
    requested = lstatSync(requestedPath);
  } catch (error) {
    if (!isMissing(error)) throw new Error('The .env path cannot be inspected safely; refusing to generate keys.');
    assertPrivateParent(requestedPath, expectedUid);
    assertPrivateAtomicFilesystem(requestedPath);
    return {requestedPath, targetPath: requestedPath, original: '', existed: false, symlink: false};
  }

  let targetPath: string;
  let symlink: boolean;
  if (requested.isSymbolicLink()) {
    symlink = true;
    try {
      targetPath = realpathSync(requestedPath);
    } catch {
      throw new Error('The .env symlink is dangling or cannot be resolved safely; refusing to generate keys.');
    }
  } else if (requested.isFile()) {
    symlink = false;
    targetPath = requestedPath;
  } else {
    throw new Error('The .env path has an unexpected filesystem type; refusing to generate keys.');
  }

  const identity = assertOwnedRegularFile(targetPath, expectedUid);
  assertPrivateParent(targetPath, expectedUid);
  assertPrivateAtomicFilesystem(targetPath);
  return {
    requestedPath,
    targetPath,
    original: readFileSync(targetPath, 'utf8'),
    existed: true,
    symlink,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    modifiedAt: identity.modifiedAt,
  };
}

function readKey(envText: string, variable: string): string | undefined {
  const match = envText.match(new RegExp(`^${variable}=(.+)$`, 'm'));
  if (!match) return undefined;
  const value = match[1]!.trim();
  if (!PRIVATE_KEY.test(value)) {
    throw new Error(`${variable} exists in .env but is invalid. It was not printed or overwritten.`);
  }
  return value;
}

function assertDistinct(keys: readonly string[]): asserts keys is [string, string] {
  if (keys.length !== WALLET_ROLES.length || keys.some((key) => !PRIVATE_KEY.test(key))) {
    throw new Error('Wallet generation returned invalid private-key data. Its output was suppressed.');
  }
  if (keys[0]!.toLowerCase() === keys[1]!.toLowerCase()) {
    throw new Error('Wallet A and wallet B are identical. Refusing to save duplicate roles.');
  }
}

function render(original: string, existing: readonly (string | undefined)[], keys: readonly string[]): string {
  let next = original.trimEnd();
  for (let i = 0; i < WALLET_ROLES.length; i += 1) {
    if (!existing[i]) next += `${next ? '\n' : ''}${WALLET_ROLES[i]!.variable}=${keys[i]}`;
  }
  return `${next}\n`;
}

function assertTargetUnchanged(target: PreparedTarget): void {
  if (!target.existed) {
    try {
      lstatSync(target.requestedPath);
      throw new Error('The .env path appeared during wallet generation; refusing to replace it.');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  const requested = lstatSync(target.requestedPath);
  if (target.symlink) {
    if (!requested.isSymbolicLink() || realpathSync(target.requestedPath) !== target.targetPath) {
      throw new Error('The .env symlink changed during wallet generation; refusing to write keys.');
    }
  } else if (!requested.isFile()) {
    throw new Error('The .env file changed type during wallet generation; refusing to write keys.');
  }
  const current = statSync(target.targetPath, {bigint: true});
  if (
    !current.isFile() ||
    current.dev !== target.device ||
    current.ino !== target.inode ||
    current.size !== target.size ||
    current.mtimeNs !== target.modifiedAt
  ) {
    throw new Error('The resolved .env target changed during wallet generation; refusing to write keys.');
  }
}

function atomicReplace(target: PreparedTarget, contents: string, beforeRename?: () => void): void {
  const temporary = uniqueSibling(target.targetPath, 'write');
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, contents, {encoding: 'utf8'});
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    privateMode(temporary);
    assertTargetUnchanged(target);
    beforeRename?.();
    renameSync(temporary, target.targetPath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(temporary);
    throw error;
  }
}

export function updateWalletEnv(options: WalletEnvUpdateOptions): WalletEnvUpdateResult {
  const expectedUid = options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const target = prepareTarget(options.envPath, expectedUid);
  const existing = WALLET_ROLES.map((role) => readKey(target.original, role.variable));
  const present = existing.filter((key): key is string => key !== undefined);
  if (present.length === WALLET_ROLES.length) assertDistinct(present);

  const generated = options.generateKeys(WALLET_ROLES.length - present.length);
  if (generated.length !== WALLET_ROLES.length - present.length || generated.some((key) => !PRIVATE_KEY.test(key))) {
    throw new Error('Wallet generation returned invalid private-key data. Its output was suppressed.');
  }
  let nextGenerated = 0;
  const keys = existing.map((key) => key ?? generated[nextGenerated++]!);
  assertDistinct(keys);

  const changed = generated.length > 0 || !target.existed;
  if (changed) atomicReplace(target, render(target.original, existing, keys), options.beforeRename);
  return {keys, changed, targetPath: target.targetPath, symlink: target.symlink};
}
