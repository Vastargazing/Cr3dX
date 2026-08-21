import {createHash} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, fsyncSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {getAddress, keccak256} from 'ethers';
import {WORKER_SCHEMA_VERSION, type Hex, type WorkerState, type WorkerTask} from './types.js';

function assertMode(path: string, expected: number): void {
  const metadata = statSync(path);
  const mode = metadata.mode & 0o777;
  if (mode !== expected) throw new Error(`${path} has mode ${mode.toString(8)}, required ${expected.toString(8)}`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`${path} is not owned by the worker user`);
}

function isHex(value: unknown, bytes?: number): value is Hex {
  return typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]${bytes === undefined ? '+' : `{${bytes * 2}}`}$`).test(value);
}

function assertEnvelope(task: WorkerTask): void {
  const envelope = task.inFlight!;
  if (!isHex(envelope.rawTransaction) || envelope.rawTransaction.length % 2 !== 0 ||
    !isHex(envelope.transactionHash, 32) || !isHex(envelope.destination, 20)) {
    throw new Error(`Corrupt task ${task.taskId}: malformed exact envelope bytes`);
  }
  if (keccak256(envelope.rawTransaction).toLowerCase() !== envelope.transactionHash.toLowerCase()) {
    throw new Error(`Corrupt task ${task.taskId}: exact envelope hash mismatch`);
  }
  if (!Number.isSafeInteger(envelope.nonce) || envelope.nonce < 0 ||
    !Number.isSafeInteger(envelope.chainId) || envelope.chainId <= 0 ||
    !Number.isSafeInteger(envelope.broadcastCount) || envelope.broadcastCount < 0 ||
    !/^\d+$/.test(envelope.maximumLiability) || BigInt(envelope.maximumLiability) <= 0n) {
    throw new Error(`Corrupt task ${task.taskId}: invalid exact envelope metadata`);
  }
  if (envelope.purpose.kind === 'SUBMISSION') {
    if (!Array.isArray(envelope.purpose.evidenceIds) || envelope.purpose.evidenceIds.length === 0 ||
      envelope.purpose.evidenceIds.some((id) => !isHex(id, 32)) ||
      new Set(envelope.purpose.evidenceIds.map((id) => id.toLowerCase())).size !== envelope.purpose.evidenceIds.length ||
      !isHex(envelope.purpose.sourceBlockHash, 32)) {
      throw new Error(`Corrupt task ${task.taskId}: invalid submission purpose`);
    }
  } else if (envelope.purpose.kind === 'APPLICATION') {
    if (!isHex(envelope.purpose.evidenceId, 32)) throw new Error(`Corrupt task ${task.taskId}: invalid application purpose`);
  } else throw new Error(`Corrupt task ${task.taskId}: unknown envelope purpose`);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = join(directory, `.tmp-${process.pid}-${Date.now()}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(directory);
}

export function taskIdOf(sourceChainId: number, transactionHash: string): string {
  return createHash('sha256').update(`${sourceChainId}:${transactionHash.toLowerCase()}`).digest('hex');
}

export class StateStore {
  readonly stateFile: string;
  readonly tasksDir: string;

  constructor(readonly stateDir: string) {
    this.stateFile = join(stateDir, 'worker-state.json');
    this.tasksDir = join(stateDir, 'tasks');
  }

  bootstrap(signerAddress: string, latestNonce: number, now = new Date()): WorkerState {
    if (existsSync(this.stateFile) || existsSync(this.tasksDir)) {
      throw new Error('State directory is already established; bootstrap refused');
    }
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, {recursive: true, mode: 0o700});
    assertMode(this.stateDir, 0o700);
    mkdirSync(this.tasksDir, {mode: 0o700});
    const state: WorkerState = {
      schemaVersion: WORKER_SCHEMA_VERSION,
      initializedAt: now.toISOString(),
      signerAddress: getAddress(signerAddress) as Hex,
      bootstrapLatestNonce: latestNonce,
      enrollments: {},
      enrollmentHistory: [],
      globalAttentionReasons: [],
    };
    atomicWriteJson(this.stateFile, state);
    return state;
  }

  assertEstablished(): void {
    if (!existsSync(this.stateDir) || !existsSync(this.stateFile) || !existsSync(this.tasksDir)) {
      throw new Error('Established worker state is missing; explicit bootstrap and nonce reconciliation are required');
    }
    assertMode(this.stateDir, 0o700);
    assertMode(this.tasksDir, 0o700);
  }

  readState(): WorkerState {
    this.assertEstablished();
    const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as WorkerState;
    if (state.schemaVersion !== WORKER_SCHEMA_VERSION) throw new Error(`Unsupported worker state schema ${state.schemaVersion}`);
    assertMode(this.stateFile, 0o600);
    return state;
  }

  writeState(state: WorkerState): void {
    if (state.schemaVersion !== WORKER_SCHEMA_VERSION) throw new Error('Refusing to write an unsupported state schema');
    atomicWriteJson(this.stateFile, state);
  }

  taskPath(taskId: string): string {
    if (!/^[0-9a-f]{64}$/.test(taskId)) throw new Error(`Invalid task id ${taskId}`);
    return join(this.tasksDir, `${taskId}.json`);
  }

  readTask(taskId: string): WorkerTask {
    const path = this.taskPath(taskId);
    const task = JSON.parse(readFileSync(path, 'utf8')) as WorkerTask;
    if (task.schemaVersion !== WORKER_SCHEMA_VERSION || task.taskId !== taskId) throw new Error(`Corrupt task ${taskId}`);
    if (task.inFlight) assertEnvelope(task);
    assertMode(path, 0o600);
    return task;
  }

  writeTask(task: WorkerTask): void {
    this.assertEstablished();
    if (task.schemaVersion !== WORKER_SCHEMA_VERSION) throw new Error('Refusing to write an unsupported task schema');
    task.updatedAt = new Date().toISOString();
    atomicWriteJson(this.taskPath(task.taskId), task);
  }

  listTasks(): WorkerTask[] {
    this.assertEstablished();
    return readdirSync(this.tasksDir)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .sort()
      .map((name) => this.readTask(name.slice(0, -5)));
  }

  unresolvedLane(): {task: WorkerTask; count: number} | undefined {
    const owners = this.listTasks().filter((task) => task.inFlight);
    if (owners.length > 1) throw new Error('More than one unresolved in-flight envelope: state corruption');
    return owners[0] ? {task: owners[0], count: owners.length} : undefined;
  }
}
