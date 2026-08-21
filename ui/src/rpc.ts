import { Contract, JsonRpcProvider, getAddress } from "ethers";

import {
  ACCEPTED_SNAPSHOT,
  CREDITCOIN_RPC_URL,
  DEPLOYMENT,
  EVIDENCE,
} from "./snapshot";

const DEAL_STATUS = [
  "NONE",
  "CREATED",
  "FINANCED",
  "DEFAULTED",
  "PAID_LATE",
  "PAID_ON_TIME",
] as const;

const EVIDENCE_STATE = [
  "UNSEEN",
  "VERIFIED_PENDING",
  "APPLIED",
  "REJECTED_PERMANENT",
] as const;

const DEALS_ABI = [
  "function getDeal(bytes32 dealId) view returns ((address borrower,uint64 dueBlock,uint8 status,address designatedInvestor,uint96 dealSeq,address investor,uint256 requiredFunding,uint256 fundedAmount,uint256 faceValue,uint256 repaidAmount,uint256 onTimeRepaid) deal)",
  "function outstandingOf(bytes32 dealId) view returns (uint256)",
  "function evidenceStateOf(bytes32 evidenceId) view returns (uint8 state,uint8 reason)",
] as const;

const CREDIT_ABI = [
  "function scoreOf(address borrower) view returns (uint16)",
  "function limitOf(address borrower) view returns (uint256)",
  "function availableLimitOf(address borrower) view returns (uint256)",
  "function reservedOf(address borrower) view returns (uint256)",
  "function exposureOf(address borrower) view returns (uint256)",
] as const;

interface DealResult {
  borrower: string;
  designatedInvestor: string;
  status: bigint;
  fundedAmount: bigint;
  repaidAmount: bigint;
  onTimeRepaid: bigint;
}

export interface LiveState {
  chainId: number;
  blockNumber: number;
  observedAt: Date;
  borrower: string;
  designatedInvestor: string;
  status: string;
  fundedAmount: bigint;
  repaidAmount: bigint;
  onTimeRepaid: bigint;
  outstanding: bigint;
  score: number;
  limit: bigint;
  availableLimit: bigint;
  reserved: bigint;
  exposure: bigint;
  repaymentEvidence: string;
  raceEvidence: string;
}

function enumLabel(labels: readonly string[], value: bigint, kind: string): string {
  const index = Number(value);
  const label = labels[index];
  if (label === undefined) throw new Error(`Unknown ${kind} value ${index}`);
  return label;
}

export async function readLiveState(): Promise<LiveState> {
  const provider = new JsonRpcProvider(CREDITCOIN_RPC_URL);

  try {
    const deals = new Contract(DEPLOYMENT.deals, DEALS_ABI, provider);
    const credit = new Contract(DEPLOYMENT.credit, CREDIT_ABI, provider);
    const getDeal = deals.getFunction("getDeal");
    const outstandingOf = deals.getFunction("outstandingOf");
    const evidenceStateOf = deals.getFunction("evidenceStateOf");
    const scoreOf = credit.getFunction("scoreOf");
    const limitOf = credit.getFunction("limitOf");
    const availableLimitOf = credit.getFunction("availableLimitOf");
    const reservedOf = credit.getFunction("reservedOf");
    const exposureOf = credit.getFunction("exposureOf");
    const [network, blockNumber, rawDeal] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      getDeal(ACCEPTED_SNAPSHOT.dealId) as Promise<DealResult>,
    ]);

    const chainId = Number(network.chainId);
    if (chainId !== DEPLOYMENT.chainId) {
      throw new Error(`Expected chain ${DEPLOYMENT.chainId}, received ${chainId}`);
    }

    const borrower = getAddress(rawDeal.borrower);
    const designatedInvestor = getAddress(rawDeal.designatedInvestor);
    const [
      outstanding,
      score,
      limit,
      availableLimit,
      reserved,
      exposure,
      repaymentEvidence,
      raceEvidence,
    ] = await Promise.all([
      outstandingOf(ACCEPTED_SNAPSHOT.dealId) as Promise<bigint>,
      scoreOf(borrower) as Promise<bigint>,
      limitOf(borrower) as Promise<bigint>,
      availableLimitOf(borrower) as Promise<bigint>,
      reservedOf(borrower) as Promise<bigint>,
      exposureOf(borrower) as Promise<bigint>,
      evidenceStateOf(EVIDENCE.repayment) as Promise<readonly [bigint, bigint]>,
      evidenceStateOf(EVIDENCE.race) as Promise<readonly [bigint, bigint]>,
    ]);

    return {
      chainId,
      blockNumber,
      observedAt: new Date(),
      borrower,
      designatedInvestor,
      status: enumLabel(DEAL_STATUS, rawDeal.status, "deal status"),
      fundedAmount: rawDeal.fundedAmount,
      repaidAmount: rawDeal.repaidAmount,
      onTimeRepaid: rawDeal.onTimeRepaid,
      outstanding,
      score: Number(score),
      limit,
      availableLimit,
      reserved,
      exposure,
      repaymentEvidence: enumLabel(EVIDENCE_STATE, repaymentEvidence[0], "evidence state"),
      raceEvidence: enumLabel(EVIDENCE_STATE, raceEvidence[0], "evidence state"),
    };
  } finally {
    provider.destroy();
  }
}
