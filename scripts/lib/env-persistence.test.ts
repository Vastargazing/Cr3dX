import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {runWalletCreation} from '../create-wallets.js';
import {updateWalletEnv} from './env-persistence.js';

const KEY_A = `0x${'11'.repeat(32)}`;
const KEY_B = `0x${'22'.repeat(32)}`;
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cr3dx-wallet-env-'));
  roots.push(root);
  return root;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function fakeGenerator(keys = [KEY_A, KEY_B]): (count: number) => string[] {
  return (count) => keys.slice(0, count);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, {recursive: true, force: true});
});

describe('wallet env persistence', () => {
  it('creates a missing .env as a regular private file', () => {
    const envPath = join(temporaryRoot(), '.env');
    const result = updateWalletEnv({envPath, generateKeys: fakeGenerator()});

    assert.equal(lstatSync(envPath).isFile(), true);
    assert.equal(lstatSync(envPath).isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(mode(envPath), 0o600);
    assert.equal(result.changed, true);
    assert.match(readFileSync(envPath, 'utf8'), /DEPLOYER_PRIVATE_KEY=/);
    assert.match(readFileSync(envPath, 'utf8'), /BORROWER_PRIVATE_KEY=/);
  });

  it('atomically updates a regular .env while preserving content and a valid existing key', () => {
    const envPath = join(temporaryRoot(), '.env');
    writeFileSync(envPath, `PUBLIC_SETTING=keep\nDEPLOYER_PRIVATE_KEY=${KEY_A}\n`, {mode: 0o600});

    const result = updateWalletEnv({envPath, generateKeys: fakeGenerator([KEY_B])});
    const updated = readFileSync(envPath, 'utf8');
    assert.match(updated, /PUBLIC_SETTING=keep/);
    assert.match(updated, new RegExp(`DEPLOYER_PRIVATE_KEY=${KEY_A}`));
    assert.match(updated, new RegExp(`BORROWER_PRIVATE_KEY=${KEY_B}`));
    if (process.platform !== 'win32') assert.equal(mode(envPath), 0o600);
    assert.deepEqual(result.keys, [KEY_A, KEY_B]);
  });

  it('preserves a checkout symlink and writes its real external target (kills checkout rename mutant)', () => {
    const root = temporaryRoot();
    const checkout = join(root, 'checkout');
    const external = join(root, 'secrets');
    mkdirSync(checkout, {mode: 0o700});
    mkdirSync(external, {mode: 0o700});
    const target = join(external, '.env');
    const envPath = join(checkout, '.env');
    writeFileSync(target, 'PUBLIC_SETTING=keep\n', {mode: 0o600});
    symlinkSync(target, envPath);
    const linkBefore = readlinkSync(envPath);

    updateWalletEnv({envPath, generateKeys: fakeGenerator()});

    assert.equal(lstatSync(envPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(envPath), linkBefore);
    assert.match(readFileSync(target, 'utf8'), /DEPLOYER_PRIVATE_KEY=/);
    assert.equal(readdirSync(checkout).join(','), '.env', 'no checkout-local key-bearing temporary file exists');
    assert.deepEqual(readdirSync(external), ['.env'], 'the successful atomic sibling was removed by rename');
    if (process.platform !== 'win32') assert.equal(mode(target), 0o600);
  });

  it('preserves the symlink through the production CLI without printing generated keys', () => {
      const root = temporaryRoot();
      const checkout = join(root, 'checkout');
      const external = join(root, 'secrets');
      mkdirSync(checkout, {mode: 0o700});
      mkdirSync(external, {mode: 0o700});
      const target = join(external, '.env');
      const envPath = join(checkout, '.env');
      writeFileSync(target, 'PUBLIC_SETTING=keep\n', {mode: 0o600});
      symlinkSync(target, envPath);

      const output: string[] = [];
      runWalletCreation({envPath, walletGenerator: fakeGenerator(), writeLine: (line) => output.push(line)});
      assert.equal(lstatSync(envPath).isSymbolicLink(), true);
      assert.match(readFileSync(target, 'utf8'), /DEPLOYER_PRIVATE_KEY=/);
      assert.doesNotMatch(output.join('\n'), new RegExp(KEY_A, 'i'));
      assert.doesNotMatch(output.join('\n'), new RegExp(KEY_B, 'i'));
  });

  it('rejects a dangling symlink before generation or writing', () => {
    const root = temporaryRoot();
    const envPath = join(root, '.env');
    symlinkSync(join(root, 'missing'), envPath);
    let generated = false;

    assert.throws(
      () => updateWalletEnv({envPath, generateKeys: () => ((generated = true), [KEY_A, KEY_B])}),
      /dangling|resolved safely/,
    );
    assert.equal(generated, false);
    assert.equal(lstatSync(envPath).isSymbolicLink(), true);
  });

  it('rejects a symlink to a directory before generation', () => {
    const root = temporaryRoot();
    const target = join(root, 'directory');
    const envPath = join(root, '.env');
    mkdirSync(target);
    symlinkSync(target, envPath);
    let generated = false;

    assert.throws(
      () => updateWalletEnv({envPath, generateKeys: () => ((generated = true), [KEY_A, KEY_B])}),
      /not a regular file/,
    );
    assert.equal(generated, false);
  });

  it('rejects an unexpected regular-path filesystem type', () => {
    const root = temporaryRoot();
    const envPath = join(root, '.env');
    mkdirSync(envPath);
    let generated = false;

    assert.throws(
      () => updateWalletEnv({envPath, generateKeys: () => ((generated = true), [KEY_A, KEY_B])}),
      /unexpected filesystem type/,
    );
    assert.equal(generated, false);
  });

  it(
    'rejects a target attributed to another POSIX user before generation',
    {skip: process.platform === 'win32' || typeof process.getuid !== 'function'},
    () => {
      const envPath = join(temporaryRoot(), '.env');
      writeFileSync(envPath, '', {mode: 0o600});
      let generated = false;

      assert.throws(
        () =>
          updateWalletEnv({
            envPath,
            expectedUid: process.getuid!() + 1,
            generateKeys: () => ((generated = true), [KEY_A, KEY_B]),
          }),
        /another user/,
      );
      assert.equal(generated, false);
    },
  );

  it('rejects a group/world-writable target parent before generation', {skip: process.platform === 'win32'}, () => {
    const root = temporaryRoot();
    const unsafeParent = join(root, 'unsafe-parent');
    const envPath = join(unsafeParent, '.env');
    mkdirSync(unsafeParent, {mode: 0o700});
    writeFileSync(envPath, '', {mode: 0o600});
    chmodSync(unsafeParent, 0o777);
    let generated = false;

    try {
      assert.throws(
        () => updateWalletEnv({envPath, generateKeys: () => ((generated = true), [KEY_A, KEY_B])}),
        /parent is writable by group or others/,
      );
      assert.equal(generated, false);
    } finally {
      chmodSync(unsafeParent, 0o700);
    }
  });

  it('does not overwrite or expose an existing invalid private key', () => {
    const envPath = join(temporaryRoot(), '.env');
    const original = 'PUBLIC_SETTING=keep\nDEPLOYER_PRIVATE_KEY=invalid-secret-value\n';
    writeFileSync(envPath, original, {mode: 0o600});
    let generated = false;

    let error: unknown;
    try {
      updateWalletEnv({envPath, generateKeys: () => ((generated = true), [KEY_A, KEY_B])});
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /DEPLOYER_PRIVATE_KEY exists.*invalid/);
    assert.doesNotMatch(error.message, /invalid-secret-value/);
    assert.equal(generated, false);
    assert.equal(readFileSync(envPath, 'utf8'), original);
  });

  it('rejects identical existing role keys without generating or writing', () => {
    const envPath = join(temporaryRoot(), '.env');
    const original = `DEPLOYER_PRIVATE_KEY=${KEY_A}\nBORROWER_PRIVATE_KEY=${KEY_A}\n`;
    writeFileSync(envPath, original, {mode: 0o600});
    let generated = false;

    assert.throws(
      () => updateWalletEnv({envPath, generateKeys: () => ((generated = true), [])}),
      /identical/,
    );
    assert.equal(generated, false);
    assert.equal(readFileSync(envPath, 'utf8'), original);
  });

  it('keeps the old target intact and cleans the unique sibling on a pre-rename failure', () => {
    const root = temporaryRoot();
    const envPath = join(root, '.env');
    const original = `PUBLIC_SETTING=keep\nDEPLOYER_PRIVATE_KEY=${KEY_A}\n`;
    writeFileSync(envPath, original, {mode: 0o600});

    assert.throws(
      () =>
        updateWalletEnv({
          envPath,
          generateKeys: fakeGenerator([KEY_B]),
          beforeRename: () => {
            throw new Error('injected crash');
          },
        }),
      /injected crash/,
    );
    assert.equal(readFileSync(envPath, 'utf8'), original);
    assert.deepEqual(readdirSync(root), ['.env']);
  });

  it('repairs an existing POSIX mode to 0600 before generation', {skip: process.platform === 'win32'}, () => {
    const envPath = join(temporaryRoot(), '.env');
    writeFileSync(envPath, '', {mode: 0o644});
    chmodSync(envPath, 0o644);

    updateWalletEnv({envPath, generateKeys: fakeGenerator()});
    assert.equal(mode(envPath), 0o600);
  });
});
