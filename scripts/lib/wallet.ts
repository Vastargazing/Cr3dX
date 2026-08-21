import { JsonRpcProvider, Wallet } from 'ethers';

/**
 * Builds a signer from a named private-key environment variable.
 *
 * Keys are read from the environment and nowhere else. They are never logged,
 * written to deployment records, or included in validation errors. `.env` is
 * git-ignored from the first commit.
 */
export function signerFromEnv(provider: JsonRpcProvider, variable = 'DEPLOYER_PRIVATE_KEY'): Wallet {
  const key = process.env[variable];
  if (!key) {
    throw new Error(
      `${variable} is not set. Provide it through the inherited process environment, or run ` +
        '`npm run wallets:create` to store testnet keys in an allowed regular .env or its resolved external symlink target.',
    );
  }
  const normalised = key.startsWith('0x') ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error(`${variable} is not a 32-byte hex private key. Not printing it.`);
  }
  return new Wallet(normalised, provider);
}

export function liveWallets(provider: JsonRpcProvider): { deployer: Wallet; borrower: Wallet } {
  const deployer = signerFromEnv(provider, 'DEPLOYER_PRIVATE_KEY');
  const borrower = signerFromEnv(provider, 'BORROWER_PRIVATE_KEY');
  if (deployer.address.toLowerCase() === borrower.address.toLowerCase()) {
    throw new Error('Wallet A and wallet B resolve to the same address. Two distinct testnet keypairs are required.');
  }
  return { deployer, borrower };
}
