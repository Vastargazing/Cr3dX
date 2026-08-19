import { JsonRpcProvider, Wallet } from 'ethers';

/**
 * Builds a signer from `DEPLOYER_PRIVATE_KEY`.
 *
 * The key is read from the environment and nowhere else. It is never logged,
 * never written to a deployment record, and never passed to anything that
 * serialises its arguments. `.env` is git-ignored from the first commit.
 */
export function signerFromEnv(provider: JsonRpcProvider): Wallet {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'DEPLOYER_PRIVATE_KEY is not set. Copy .env.example to .env and add the key of a Sepolia account ' +
        'that holds both test ETH and test USDC. The key stays in .env, which is git-ignored.',
    );
  }
  const normalised = key.startsWith('0x') ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error('DEPLOYER_PRIVATE_KEY is not a 32-byte hex private key. Not printing it.');
  }
  return new Wallet(normalised, provider);
}
