/**
 * Deploys Cr3dXGateway to Sepolia.
 *
 *   npm run deploy:gateway
 *
 * Requires DEPLOYER_PRIVATE_KEY in .env and a Sepolia account with test ETH.
 * Writes the resulting address to deployments/sepolia.json, which is committed:
 * addresses are public, and the demo has to be reproducible from the repository.
 */
import { Contract, ContractFactory, formatEther, formatUnits } from 'ethers';
import { config, warnIfProxyIgnored } from './lib/config.js';
import { evmProvider, errMessage } from './lib/rpc.js';
import { loadArtifact, writeDeployment, readDeployment } from './lib/artifacts.js';
import { signerFromEnv } from './lib/wallet.js';

const log = (msg: string): void => console.log(`[deploy] ${msg}`);

const ERC20_METADATA_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

async function main(): Promise<void> {
  warnIfProxyIgnored(log);
  const provider = evmProvider(config.sepoliaRpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.sourceEvmChainId) {
    throw new Error(`SEPOLIA_RPC_URL points at chain ${net.chainId}, expected ${config.sourceEvmChainId}`);
  }

  const signer = signerFromEnv(provider);
  const balance = await provider.getBalance(signer.address);
  log(`deployer ${signer.address}, balance ${formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error('The deployer has no Sepolia ETH. Fund it before deploying.');
  }

  await checkTokenConfiguration(provider, signer.address);

  const existing = readDeployment('sepolia');
  if (existing?.gateway) {
    log(`deployments/sepolia.json already records a gateway at ${existing.gateway}.`);
    log('Delete that entry to deploy a fresh one. Redeploying invalidates every fixture captured against it.');
    return;
  }

  const artifact = loadArtifact('Cr3dXGateway.sol', 'Cr3dXGateway');
  const factory = new ContractFactory(artifact.abi as any, artifact.bytecode, signer);
  log(`deploying with token ${config.sepoliaUsdc} baked in permanently`);
  const gateway = await factory.deploy(config.sepoliaUsdc);
  const tx = gateway.deploymentTransaction();
  log(`sent ${tx?.hash}, waiting for inclusion`);
  await gateway.waitForDeployment();
  const address = await gateway.getAddress();
  const receipt = await tx!.wait();

  const onChainToken: string = await (gateway as any).token();
  if (onChainToken.toLowerCase() !== config.sepoliaUsdc.toLowerCase()) {
    throw new Error(`Deployed gateway reports token ${onChainToken}, expected ${config.sepoliaUsdc}`);
  }

  writeDeployment('sepolia', {
    network: 'sepolia',
    chainId: config.sourceEvmChainId,
    token: config.sepoliaUsdc,
    tokenSymbol: config.expectedTokenSymbol,
    tokenDecimals: config.expectedTokenDecimals,
    gateway: address,
    gatewayDeploymentTx: tx?.hash,
    gatewayDeploymentBlock: receipt?.blockNumber,
    deployedBy: signer.address,
  });

  log(`gateway deployed at ${address} in block ${receipt?.blockNumber}`);
  log(`recorded in deployments/sepolia.json`);
  log(`explorer: https://sepolia.etherscan.io/address/${address}`);
}

/**
 * Configuration guard, not a security check.
 *
 * Sepolia carries more than one token calling itself USDC with six decimals, so
 * matching the symbol proves nothing about which one this is. What it does catch
 * is a mistyped or stale address in .env, before that address is baked into an
 * immutable field and every fixture captured afterwards has to be thrown away.
 * The security anchor is the address itself.
 */
async function checkTokenConfiguration(provider: ReturnType<typeof evmProvider>, deployer: string): Promise<void> {
  const code = await provider.getCode(config.sepoliaUsdc);
  if (code === '0x') {
    throw new Error(`No contract at ${config.sepoliaUsdc}. Check SEPOLIA_USDC in .env.`);
  }
  const token = new Contract(config.sepoliaUsdc, ERC20_METADATA_ABI, provider);
  const [symbol, decimals] = (await Promise.all([
    token.getFunction('symbol')(),
    token.getFunction('decimals')(),
  ])) as [string, bigint];
  if (symbol !== config.expectedTokenSymbol) {
    throw new Error(
      `Token at ${config.sepoliaUsdc} reports symbol "${symbol}", expected "${config.expectedTokenSymbol}". ` +
        'Either the address is wrong or EXPECTED_TOKEN_SYMBOL is. Refusing to bake it in.',
    );
  }
  if (Number(decimals) !== config.expectedTokenDecimals) {
    throw new Error(
      `Token at ${config.sepoliaUsdc} reports ${decimals} decimals, expected ${config.expectedTokenDecimals}. ` +
        'Every amount in the demo is written in native units against that assumption. Refusing to bake it in.',
    );
  }
  const held = (await token.getFunction('balanceOf')(deployer)) as bigint;
  log(`token ${config.sepoliaUsdc} is "${symbol}" with ${decimals} decimals`);
  log(`deployer holds ${formatUnits(held, decimals)} ${symbol}`);
  if (held === 0n) {
    log('Warning: the deployer holds none of it. Deployment will work; the demo will not.');
    log('Faucet: https://faucet.circle.com');
  }
}

main().catch((error) => {
  console.error(`[deploy] fatal: ${errMessage(error)}`);
  process.exitCode = 1;
});
