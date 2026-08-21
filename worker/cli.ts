#!/usr/bin/env node
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {WorkerChain} from './chain.js';
import {loadWorkerConfig, privateKeyFromEnvironment} from './config.js';
import {summarizeState, WorkerEngine} from './engine.js';
import {enrollDeal} from './enrollment.js';
import {aggregateTask} from './policy.js';
import {StateStore} from './state.js';
import type {Hex, WorkerTask} from './types.js';

const [command = 'help', ...args] = process.argv.slice(2);

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function stateStoreOnly(): StateStore {
  const raw = process.env.CR3DX_WORKER_STATE_DIR;
  if (!raw) throw new Error('CR3DX_WORKER_STATE_DIR is required');
  return new StateStore(resolve(raw));
}

function taskForInspection(task: WorkerTask): Record<string, unknown> {
  return {
    schemaVersion: task.schemaVersion,
    taskId: task.taskId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    aggregate: aggregateTask(task),
    logical: task.logical,
    inFlight: task.inFlight
      ? {
          ...task.inFlight,
          rawTransaction: '<redacted exact signed envelope>',
        }
      : undefined,
  };
}

async function signingEngine(): Promise<{engine: WorkerEngine; chain: WorkerChain; store: StateStore}> {
  const config = loadWorkerConfig();
  const chain = new WorkerChain(config, privateKeyFromEnvironment());
  const store = new StateStore(config.stateDir);
  print({event: 'secret_provisioning', secretMode: process.env.CR3DX_WORKER_SECRET_MODE, provenance: process.env.CR3DX_WORKER_SECRET_PROVENANCE ?? 'inherited manager environment'});
  return {engine: new WorkerEngine(config, store, chain), chain, store};
}

async function main(): Promise<void> {
  if (command === 'help') {
    print('commands: bootstrap, enroll, enrollments, status, list, inspect, attention, run, step, advance, resume, resume-broadcast');
    return;
  }
  if (command === 'bootstrap') {
    const config = loadWorkerConfig();
    const chain = new WorkerChain(config, privateKeyFromEnvironment());
    const store = new StateStore(config.stateDir);
    if (existsSync(store.stateFile)) throw new Error('Worker state already exists');
    await chain.assertDeploymentConfiguration();
    const nonces = await chain.nonces();
    if (nonces.latest !== nonces.pending) throw new Error(`Bootstrap refuses unresolved signer nonce: latest=${nonces.latest}, pending=${nonces.pending}`);
    const state = store.bootstrap(chain.signerAddress(), nonces.latest);
    print({bootstrapped: config.stateDir, signerAddress: state.signerAddress, nonce: nonces.latest, sourceStartBlock: config.sourceStartBlock});
    return;
  }
  if (command === 'status' || command === 'list' || command === 'enrollments' || command === 'attention' || command === 'inspect') {
    const store = stateStoreOnly();
    const state = store.readState();
    const tasks = store.listTasks();
    if (command === 'status') print(summarizeState(state, tasks));
    else if (command === 'list') print(tasks.map((task) => ({taskId: task.taskId, transactionHash: task.logical.transactionHash, ...aggregateTask(task)})));
    else if (command === 'enrollments') print({enrollments: Object.values(state.enrollments), history: state.enrollmentHistory});
    else if (command === 'attention') print({global: state.globalAttentionReasons, tasks: tasks.filter((task) => aggregateTask(task).state === 'ATTENTION_REQUIRED').map(taskForInspection)});
    else {
      const taskId = args[0];
      if (!taskId) throw new Error('inspect requires <taskId>');
      print(taskForInspection(store.readTask(taskId)));
    }
    return;
  }
  if (command === 'enroll') {
    const dealId = args[0];
    if (!dealId || !/^0x[0-9a-fA-F]{64}$/.test(dealId)) throw new Error('enroll requires a bytes32 dealId');
    const config = loadWorkerConfig();
    const chain = new WorkerChain(config);
    await chain.assertDeploymentConfiguration();
    const store = new StateStore(config.stateDir);
    const state = store.readState();
    const head = await chain.sourceHead();
    const effectiveIndex = args.indexOf('--effective-from');
    const reasonIndex = args.indexOf('--reason');
    const enrollment = enrollDeal({
      state,
      dealId,
      observedSourceHead: head,
      effectiveFromSourceBlock: effectiveIndex >= 0 ? Number(args[effectiveIndex + 1]) : undefined,
      reason: reasonIndex >= 0 ? args[reasonIndex + 1] : undefined,
      now: new Date(),
    });
    store.writeState(state);
    print(enrollment);
    return;
  }
  const {engine} = await signingEngine();
  if (command === 'resume') {
    if (!args[0]) throw new Error('resume requires <taskId>');
    await engine.resume(args[0]);
    print({resumed: args[0]});
    return;
  }
  await engine.startupChecks();
  if (command === 'step') {
    await engine.scanOnce();
    await engine.tick();
    print({step: 'complete'});
  } else if (command === 'advance') {
    if (!args[0]) throw new Error('advance requires <taskId>');
    await engine.advanceTask(args[0]);
    print({advanced: args[0]});
  } else if (command === 'resume-broadcast') {
    if (!args[0]) throw new Error('resume-broadcast requires <taskId>');
    await engine.resumeBroadcast(args[0]);
    print({resumeBroadcast: args[0]});
  } else if (command === 'run') {
    for (;;) {
      try {
        await engine.scanOnce();
        await engine.tick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        print({event: 'worker_loop_retry', message: message.replace(/0x[0-9a-fA-F]{128,}/g, '<redacted-hex>')});
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, engine.config.pollIntervalMs));
    }
  } else throw new Error(`Unknown command ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({event: 'worker_error', command, message: message.replace(/0x[0-9a-fA-F]{128,}/g, '<redacted-hex>')})}\n`);
  process.exitCode = 1;
});
