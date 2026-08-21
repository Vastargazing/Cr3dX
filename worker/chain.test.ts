import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Interface} from 'ethers';
import {WorkerChain, type RawSourceReceipt} from './chain.js';
import type {Hex, WorkerConfig} from './types.js';

const gateway = `0x${'11'.repeat(20)}` as Hex;
const investor = `0x${'22'.repeat(20)}` as Hex;
const borrower = `0x${'33'.repeat(20)}` as Hex;
const dealId = `0x${'44'.repeat(32)}` as Hex;
const txHash = `0x${'55'.repeat(32)}` as Hex;
const blockHash = `0x${'66'.repeat(32)}` as Hex;
const iface = new Interface([
  'event FundingMade(bytes32 indexed dealId,address indexed investor,address indexed borrower,uint256 amount,uint256 nonce)',
  'event RepaymentMade(bytes32 indexed dealId,address indexed payer,address indexed investor,uint256 amount,uint256 nonce)',
]);

test('coverage 2 and 37: canonical ABI decode keeps receipt-local ordinal separate from RPC log index and re-decodes nonce', () => {
  const chain = new WorkerChain(config());
  const funding = iface.encodeEventLog(iface.getEvent('FundingMade')!, [dealId, investor, borrower, 100n, 7n]);
  const repayment = iface.encodeEventLog(iface.getEvent('RepaymentMade')!, [dealId, borrower, investor, 80n, 8n]);
  const receipt: RawSourceReceipt = {
    transactionHash: txHash, blockNumber: 100, blockHash, transactionIndex: 3, status: 1,
    logs: [
      {address: `0x${'99'.repeat(20)}`, topics: [`0x${'00'.repeat(32)}`], data: '0x', logIndex: 90, transactionHash: txHash},
      {address: gateway, topics: funding.topics as Hex[], data: funding.data as Hex, logIndex: 101, transactionHash: txHash},
      {address: gateway, topics: repayment.topics as Hex[], data: repayment.data as Hex, logIndex: 105, transactionHash: txHash},
    ],
  };
  const decoded = chain.decodeGatewayEvents(receipt);
  assert.deepEqual(decoded.map((event) => [event.kind, event.transactionLogOrdinal, event.rpcLogIndex, event.eventNonce]), [
    ['FUNDING', 1, 101, '7'],
    ['REPAYMENT', 2, 105, '8'],
  ]);
  assert.equal(decoded[0]!.dealId, dealId);
  assert.equal(decoded[0]!.counterparty, investor);
  assert.equal(decoded[1]!.recipient, investor);
});

test('coverage 46: matching gateway/topic with a non-canonical shape fails loudly', () => {
  const chain = new WorkerChain(config());
  const receipt: RawSourceReceipt = {
    transactionHash: txHash, blockNumber: 100, blockHash, transactionIndex: 3, status: 1,
    logs: [{address: gateway, topics: [config().fundingTopic, dealId], data: '0x', logIndex: 1, transactionHash: txHash}],
  };
  assert.throws(() => chain.decodeGatewayEvents(receipt), /SHAPE_MISMATCH/);
});

test('coverage 30 and 41: production worker contains no batching, privileged contract call, dotenv, or wallets:create path', () => {
  const sources = ['worker/chain.ts', 'worker/config.ts', 'worker/engine.ts', 'worker/cli.ts']
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  for (const forbidden of ['submitAndApplyBatch', 'submitEvidenceBatch', 'markDefaulted(', 'createDeal(', "dotenv", 'wallets:create']) {
    assert.equal(sources.includes(forbidden), false, `forbidden production worker token: ${forbidden}`);
  }
  assert.match(sources, /submitAndApply/);
  assert.match(sources, /applyEvidence/);
});

function config(): WorkerConfig {
  return {
    stateDir: '/unused', sourceRpcUrl: 'http://source', destinationRpcUrl: 'http://destination', destinationSubstrateRpcUrl: 'http://substrate',
    proofBuilderUrl: 'http://proof', sourceChainId: 11155111, sourceChainKey: 1, destinationChainId: 102031, sourceStartBlock: 1,
    gatewayAddress: gateway, verifierAddress: `0x${'77'.repeat(20)}`, dealsAddress: `0x${'88'.repeat(20)}`,
    fundingTopic: iface.getEvent('FundingMade')!.topicHash as Hex, repaymentTopic: iface.getEvent('RepaymentMade')!.topicHash as Hex,
    pollIntervalMs: 5_000,
    limits: {maxNonTerminalTasks: 1_000, maxEventsPerTransaction: 32, transactionGasCap: 1n, maxFeePerGasCap: 1n, rolling24HourFeeBudget: 1n, minimumSignerBalanceReserve: 1n},
  };
}
