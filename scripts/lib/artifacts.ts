import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

export interface Artifact {
  abi: unknown[];
  bytecode: string;
}

/**
 * Loads a contract artifact produced by `forge build`.
 *
 * Deployment goes through ethers rather than `forge script` because the target
 * is a Substrate EVM and the deployment path should be the same plain
 * JSON-RPC one the worker will use, with no forge-specific behaviour in between.
 */
export function loadArtifact(sourceFile: string, contractName: string): Artifact {
  const path = `out/${sourceFile}/${contractName}.json`;
  if (!existsSync(path)) {
    throw new Error(`Missing artifact ${path}. Run \`npm run build\` first.`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const bytecode: string = raw.bytecode?.object ?? '';
  if (!bytecode || bytecode === '0x') throw new Error(`Artifact ${path} has no bytecode`);
  return { abi: raw.abi, bytecode };
}

export interface Deployment {
  network: string;
  chainId: number;
  [key: string]: unknown;
}

const DEPLOYMENTS_DIR = 'deployments';

export function deploymentPath(network: string): string {
  return `${DEPLOYMENTS_DIR}/${network}.json`;
}

export function readDeployment(network: string): Deployment | null {
  const path = deploymentPath(network);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
}

/** Merges into the existing record rather than replacing it. */
export function writeDeployment(network: string, entries: Record<string, unknown>): Deployment {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const current = readDeployment(network) ?? {};
  const merged = { ...current, ...entries } as Deployment;
  writeFileSync(deploymentPath(network), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
