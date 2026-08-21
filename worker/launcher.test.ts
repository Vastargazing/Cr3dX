import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import test from 'node:test';

const launch = resolve('worker/launch.sh');

test('coverage 41: secret modes fail closed and checked file mode accepts only an external 0600 target', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cr3dx-launch-'));
  chmodSync(parent, 0o700);
  const stateDir = join(parent, 'state');
  const envFile = join(parent, 'worker.env');
  writeFileSync(envFile, `CR3DX_WORKER_PRIVATE_KEY=0x${'11'.repeat(32)}\n`, {mode: 0o600});
  const base = {...process.env, CR3DX_WORKER_STATE_DIR: stateDir, CR3DX_WORKER_VALIDATE_SECRET_ONLY: '1'};

  const absent = spawnSync(launch, ['bootstrap'], {env: base, encoding: 'utf8'});
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /SECRET_MODE/);

  const managerMissing = spawnSync(launch, ['bootstrap'], {env: {...base, CR3DX_WORKER_SECRET_MODE: 'manager'}, encoding: 'utf8'});
  assert.notEqual(managerMissing.status, 0);
  assert.match(managerMissing.stderr, /must inject/);

  const file = spawnSync(launch, ['bootstrap'], {env: {...base, CR3DX_WORKER_SECRET_MODE: 'file', CR3DX_WORKER_ENV_FILE: envFile}, encoding: 'utf8'});
  assert.equal(file.status, 0, file.stderr);

  const checkoutLocal = spawnSync(launch, ['bootstrap'], {
    env: {...base, CR3DX_WORKER_SECRET_MODE: 'file', CR3DX_WORKER_ENV_FILE: resolve('.env.example')},
    encoding: 'utf8',
  });
  assert.notEqual(checkoutLocal.status, 0);
  assert.match(checkoutLocal.stderr, /outside the checkout/);

  const marker = join(parent, 'must-not-exist');
  writeFileSync(envFile, `CR3DX_WORKER_PRIVATE_KEY=0x${'11'.repeat(32)}\ntouch ${marker}\nCR3DX_WORKER_STATE_DIR=/tmp/override\n`, {mode: 0o600});
  const inert = spawnSync(launch, ['bootstrap'], {env: {...base, CR3DX_WORKER_SECRET_MODE: 'file', CR3DX_WORKER_ENV_FILE: envFile}, encoding: 'utf8'});
  assert.equal(inert.status, 0, inert.stderr);
  assert.equal(existsSync(marker), false);

  chmodSync(envFile, 0o644);
  const permissive = spawnSync(launch, ['bootstrap'], {env: {...base, CR3DX_WORKER_SECRET_MODE: 'file', CR3DX_WORKER_ENV_FILE: envFile}, encoding: 'utf8'});
  assert.notEqual(permissive.status, 0);
  assert.match(permissive.stderr, /mode 0600/);
});

test('coverage 26 and 39: kernel lock excludes a live holder and is reusable after process death', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cr3dx-lock-'));
  chmodSync(parent, 0o700);
  const stateDir = join(parent, 'state');
  mkdirSync(stateDir, {mode: 0o700});
  const lockPath = join(stateDir, 'worker.lock');
  const holder = spawn('flock', ['--exclusive', '--no-fork', lockPath, 'sleep', '30'], {stdio: 'ignore'});
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const env = {
    ...process.env,
    CR3DX_WORKER_STATE_DIR: stateDir,
    CR3DX_WORKER_SECRET_MODE: 'manager',
    CR3DX_WORKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    CR3DX_WORKER_VALIDATE_SECRET_ONLY: '1',
  };
  const blocked = spawnSync(launch, ['bootstrap'], {env, encoding: 'utf8'});
  assert.notEqual(blocked.status, 0);
  holder.kill('SIGKILL');
  await new Promise<void>((resolveExit) => holder.once('exit', () => resolveExit()));
  const reacquired = spawnSync(launch, ['bootstrap'], {env, encoding: 'utf8'});
  assert.equal(reacquired.status, 0, reacquired.stderr);
});
