import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {keccak256} from 'ethers';
import {StateStore, atomicWriteJson, taskIdOf} from './state.js';
import {WORKER_SCHEMA_VERSION, type WorkerTask} from './types.js';

test('coverage 4: JSON replacement is atomic, mode-safe and orphan temporaries are ignored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cr3dx-state-'));
  const path = join(directory, 'value.json');
  atomicWriteJson(path, {version: 1});
  atomicWriteJson(path, {version: 2});
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {version: 2});
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const store = bootstrapStore();
  writeFileSync(join(store.tasksDir, '.tmp-crash'), '{not json', {mode: 0o600});
  store.writeTask(taskFixture('a'.repeat(64)));
  assert.equal(store.listTasks().length, 1);
});

test('coverage 1 and 3: task identity is deterministic and independent of insertion order', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(taskIdOf(11155111, hash), taskIdOf(11155111, hash.toUpperCase().replace('0X', '0x')));
  assert.notEqual(taskIdOf(1, hash), taskIdOf(2, hash));
});

test('coverage 18 and 43: proof is absent from logical JSON while envelope reservation shares the task write', () => {
  const store = bootstrapStore();
  const task = taskFixture('b'.repeat(64));
  task.inFlight = {
    purpose: {kind: 'SUBMISSION', evidenceIds: [`0x${'20'.repeat(32)}`], sourceBlockHash: `0x${'10'.repeat(32)}`}, transactionHash: keccak256('0xfeedbeef') as `0x${string}`, rawTransaction: '0xfeedbeef', nonce: 0,
    chainId: 1, destination: `0x${'12'.repeat(20)}`, maximumLiability: '999', createdAt: new Date(0).toISOString(), broadcastCount: 0,
  };
  store.writeTask(task);
  const json = JSON.parse(readFileSync(store.taskPath(task.taskId), 'utf8')) as WorkerTask;
  assert.equal(JSON.stringify(json.logical).includes('feedbeef'), false);
  assert.equal(json.inFlight?.rawTransaction, '0xfeedbeef');
  assert.equal(json.inFlight?.maximumLiability, '999');
});

test('coverage 39 and 40: missing established state and multiple lanes fail closed', () => {
  const missing = new StateStore(join(mkdtempSync(join(tmpdir(), 'cr3dx-missing-')), 'never-created'));
  assert.throws(() => missing.readState(), /explicit bootstrap/);
  const store = bootstrapStore();
  for (const id of ['c'.repeat(64), 'd'.repeat(64)]) {
    const task = taskFixture(id);
    task.inFlight = {
      purpose: {kind: 'SUBMISSION', evidenceIds: [`0x${'20'.repeat(32)}`], sourceBlockHash: `0x${'10'.repeat(32)}`}, transactionHash: keccak256('0x01') as `0x${string}`, rawTransaction: '0x01', nonce: 0,
      chainId: 1, destination: `0x${'12'.repeat(20)}`, maximumLiability: '1', createdAt: new Date(0).toISOString(), broadcastCount: 0,
    };
    store.writeTask(task);
  }
  assert.throws(() => store.unresolvedLane(), /More than one unresolved/);
});

function bootstrapStore(): StateStore {
  const parent = mkdtempSync(join(tmpdir(), 'cr3dx-store-'));
  const stateDir = join(parent, 'state');
  mkdirSync(stateDir, {mode: 0o700});
  const store = new StateStore(stateDir);
  store.bootstrap(`0x${'12'.repeat(20)}`, 0, new Date(0));
  return store;
}

function taskFixture(taskId: string): WorkerTask {
  return {
    schemaVersion: WORKER_SCHEMA_VERSION,
    taskId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    logical: {
      sourceChainId: 1,
      transactionHash: `0x${taskId}`,
      sourceSubmissionState: 'OBSERVED',
      inclusionHistory: [],
      submissionAttemptCount: 0,
      transitions: [],
      operationHistory: [],
    },
  };
}
