export const CREDITCOIN_RPC_URL = "https://rpc.cc3-testnet.creditcoin.network";
export const CREDITCOIN_EXPLORER_URL = "https://creditcoin-testnet.blockscout.com";
export const SEPOLIA_EXPLORER_URL = "https://sepolia.etherscan.io";
export const REPOSITORY_URL = "https://github.com/Vastargazing/Cr3dX";

export const ACCEPTED_EVIDENCE_COMMIT =
  "f359c54c5647841a08e4e66dec267cf4cbeb110d";

export const DEPLOYMENT = Object.freeze({
  chainId: 102031,
  sourceChainId: 11155111,
  gateway: "0x11DD8a4c790939DEa8CED631dB27Afe54334a749",
  verifier: "0xED64f6157408f211dda43649129EaC1F73161093",
  deals: "0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC",
  credit: "0x4a66732cA5B7f081585693332C79e636CE9c05C8",
});

export const EVIDENCE = Object.freeze({
  repayment: "0x65f1d8a980b49ec20510b047473785ebcfd6648c0d4cfafd3857241b9c8df213",
  race: "0xb7bf02c15afd864f4274428e9be186344e0191e616bc45b25ec2fab4d709d4d5",
});

export const ACCEPTED_SNAPSHOT = Object.freeze({
  acceptedAt: "2026-08-21",
  dealId: "0x5cf1f030363c28c3fa1862759ccc63b338d0a57fd682d9a6965a61acf93706fc",
  status: "PAID_ON_TIME",
  fundedAmount: 1_000_001n,
  repaidAmount: 1_100_000n,
  onTimeRepaid: 1_100_000n,
  outstanding: 0n,
  exposure: 0n,
  reserved: 0n,
  scoreBefore: 500,
  scoreAfter: 525,
  limitBefore: 5_000_000_000n,
  limitAfter: 5_250_000_000n,
});

export const LIVE_OPERATIONS = Object.freeze([
  {
    label: "Repayment proof",
    action: "submitAndApply",
    hash: "0xa626556e0798a67d77b484896d10e662763d041c2e9ead2d0c4ad112f2955657",
    gasUsed: 260_288,
    roots: 8,
    anchor: 11_534_650,
    note: "Stored as VERIFIED_PENDING before funding",
  },
  {
    label: "Funding proof",
    action: "submitAndApply",
    hash: "0xc740cf0ee69401817c32a310f6e2781ab63d125f7fc2bd299338cfe5fdc822ad",
    gasUsed: 340_382,
    roots: 5,
    anchor: 11_534_800,
    note: "Converted reserve into exposure",
  },
  {
    label: "Pending repayment",
    action: "applyEvidence",
    hash: "0xa0c24a107398af5c99cc8cfaab0ea50f4542caff45c34bc8f539afbfa55b13b6",
    gasUsed: 292_348,
    roots: null,
    anchor: null,
    note: "Automatically closed the deal",
  },
  {
    label: "External race",
    action: "reconciled",
    hash: "0x8d859033ecaec13d7ebb188f8673673af0d13b989202997d613bee38f78840c2",
    gasUsed: 266_056,
    roots: 10,
    anchor: 11_534_900,
    note: "Worker signed and broadcast nothing",
  },
]);

export const SOURCE_TRANSACTIONS = Object.freeze({
  repayment: "0xe90b91457786d4e89104e157c746b2d8ec8d91b9462321602c96591a6c2d72ec",
  funding: "0x376bde8f88c3dfa9059356d63f6866dc0209a7796ec1cdc14e9fb2a5ba203abe",
  race: "0x98c724cf613246c821b1a36acf765dedadc88fce36b9857ea86cf57d01a7e1ea",
});

export function creditcoinAddressUrl(address: string): string {
  return `${CREDITCOIN_EXPLORER_URL}/address/${address}`;
}

export function creditcoinTransactionUrl(hash: string): string {
  return `${CREDITCOIN_EXPLORER_URL}/tx/${hash}`;
}

export function sepoliaTransactionUrl(hash: string): string {
  return `${SEPOLIA_EXPLORER_URL}/tx/${hash}`;
}

export function evidenceDocumentUrl(path: string): string {
  return `${REPOSITORY_URL}/blob/${ACCEPTED_EVIDENCE_COMMIT}/${path}`;
}
