// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cr3dXGateway} from "../contracts/Cr3dXGateway.sol";
import {Cr3dXVerifier} from "../contracts/Cr3dXVerifier.sol";
import {IBlockProver} from "../contracts/interfaces/IBlockProver.sol";
import {ICr3dXGatewayEvents} from "../contracts/interfaces/ICr3dXGatewayEvents.sol";
import {Attestcoin} from "../contracts/libraries/Attestcoin.sol";
import {ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";
import {MockBlockProver} from "./helpers/MockBlockProver.sol";
import {BlobBuilder} from "./helpers/BlobBuilder.sol";
import {MockERC20} from "./helpers/MockERC20.sol";
import {DoubleFundingFixture} from "./helpers/DoubleFundingFixture.sol";

/// @title Cr3dXVerifierTest
/// @notice Tests the single entry point through which every external fact enters
///         Cr3dX.
///
/// @dev **What is real here and what is not.** The gateway is the real contract,
///      driven for real, and the logs the tests feed in are the logs it actually
///      emitted, captured with `vm.recordLogs` and re-encoded into the protocol's
///      blob layout. What is simulated is the precompile's yes-or-no on a proof,
///      because a local EVM has no Attestcoin. Proof validity is exercised
///      separately against the live precompile by `scripts/verify-live.ts`. No
///      test in this file should be read as evidence that a proof is valid.
///
///      Several negative cases use blobs captured verbatim from live Sepolia,
///      where the point is the shape of a real transaction rather than the
///      events in it.
contract Cr3dXVerifierTest is Test {
    using BlobBuilder for ProvenLog[];

    uint64 internal constant CHAIN_KEY = 1;
    uint64 internal constant HEIGHT = 11_520_066;
    uint64 internal constant TX_INDEX = 7;

    Cr3dXVerifier internal verifier;
    Cr3dXGateway internal gateway;
    MockERC20 internal token;
    MockBlockProver internal prover;

    address internal investor = makeAddr("investor");
    address internal borrower = makeAddr("borrower");

    bytes32 internal constant DEAL = keccak256("deal-1");
    uint256 internal constant FUNDING = 1_000_000_000;
    uint256 internal constant FACE_VALUE = 1_100_000_000;

    IBlockProver.MerkleProof internal proof;
    IBlockProver.ContinuityProof internal continuity;

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        gateway = new Cr3dXGateway(IERC20(address(token)));
        verifier = new Cr3dXVerifier(CHAIN_KEY, address(gateway));

        // The mock lives at the precompile's real address, so the verifier makes
        // exactly the call it will make in production.
        prover = new MockBlockProver();
        vm.etch(address(Attestcoin.BLOCK_PROVER), address(prover).code);
        _prover().setTxIndex(TX_INDEX);

        token.mint(investor, 100 * FUNDING);
        token.mint(borrower, 100 * FACE_VALUE);

        proof.root = keccak256("merkle-root");
        proof.siblings.push(IBlockProver.MerkleProofEntry({hash: keccak256("sibling"), isLeft: true}));
        continuity.lowerEndpointDigest = keccak256("lower");
        continuity.roots.push(keccak256("root"));
    }

    // ------------------------------------------------------------------
    // the test this stage exists for
    // ------------------------------------------------------------------

    /// @notice One transaction carrying two genuine fundings and one impostor
    ///         yields exactly two facts, and exactly the right two.
    ///
    /// @dev Four properties at once, which is why this is the test that matters:
    ///      all logs are walked rather than the first match taken; a matching
    ///      topic is not enough, the emitter decides; two events in one
    ///      transaction do not collapse into one; and the event nonce is doing
    ///      real work in the identifier.
    ///
    ///      The impostor sits between the two genuine events, so a verifier that
    ///      stops at the first match and one that keeps only the last are both
    ///      wrong in a way this test sees.
    function test_twoGenuineFundingsAndOneImpostorYieldExactlyTwoFacts() public {
        DoubleFundingFixture fixture = new DoubleFundingFixture(gateway);
        vm.prank(investor);
        token.approve(address(fixture), FUNDING);

        vm.recordLogs();
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL, borrower, 400_000_000, 600_000_000);
        ProvenLog[] memory logs = BlobBuilder.fromRecorded(vm.getRecordedLogs());

        // Three FundingMade logs go in: two from the gateway, one from the
        // lookalike, plus the token's own Transfer logs as noise.
        assertEq(
            _countTopic(logs, ICr3dXGatewayEvents.FundingMade.selector), 3, "setup: three matching topics"
        );

        bytes32[] memory ids =
            verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);

        assertEq(ids.length, 2, "exactly two facts, not one and not three");
        assertTrue(ids[0] != ids[1], "the two facts must have distinct identifiers");

        Cr3dXVerifier.VerifiedEvidence memory first = verifier.getEvidence(ids[0]);
        Cr3dXVerifier.VerifiedEvidence memory second = verifier.getEvidence(ids[1]);

        assertEq(uint8(first.kind), uint8(Cr3dXVerifier.EvidenceKind.FUNDING), "first is a funding");
        assertEq(uint8(second.kind), uint8(Cr3dXVerifier.EvidenceKind.FUNDING), "second is a funding");
        assertEq(first.dealId, DEAL, "both name the same deal");
        assertEq(second.dealId, DEAL, "both name the same deal");
        assertEq(first.amount, 400_000_000, "first amount");
        assertEq(second.amount, 600_000_000, "second amount");
        assertEq(first.recipient, borrower, "both pay the borrower");
        assertEq(second.recipient, borrower, "both pay the borrower");

        // The counterparty is the fixture contract, not the externally owned
        // account, because the gateway records `msg.sender` and the helper is the
        // caller. Correct, and asserted so it is never mistaken for a bug.
        assertEq(first.counterparty, address(fixture), "payer is the calling contract");
        assertEq(second.counterparty, address(fixture), "payer is the calling contract");

        // The nonces are what separate them. Everything else is identical.
        assertTrue(first.eventNonce != second.eventNonce, "the event nonces must differ");
        assertEq(first.blockHeight, HEIGHT, "height recorded");
        assertEq(first.txIndex, TX_INDEX, "index recorded, and only trustworthy after verify");

        // The impostor left nothing anywhere. Its identifier would be the one
        // built from its own nonce, which was deliberately set to a sentinel.
        bytes32 impostorId =
            verifier.evidenceIdOf(HEIGHT, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, type(uint256).max);
        assertFalse(verifier.seen(impostorId), "the counterfeit must not have been recorded");
        assertEq(verifier.getEvidence(impostorId).amount, 0, "and must have left no storage behind");
    }

    // ------------------------------------------------------------------
    // ordering
    // ------------------------------------------------------------------

    /// @notice `verify` runs before `calculateTxIndex`.
    /// @dev Both are armed to fail with distinguishable messages. The message
    ///      that comes back names the call that ran first. A `view` function
    ///      cannot record its own invocation, so this is the honest way to check
    ///      an ordering the whole design depends on.
    function test_verifyRunsBeforeCalculateTxIndex() public {
        _prover().setVerifyReverts(true);
        _prover().setTxIndexReverts(true);

        vm.expectRevert(bytes(_prover().verifyFailureMessage()));
        verifier.submitEvidence(HEIGHT, _fundingBlob(), proof, continuity);
    }

    /// @notice A failed proof stops everything, and records nothing.
    function test_failedProofRecordsNothing() public {
        _prover().setVerifyReverts(true);
        vm.expectRevert(bytes(_prover().verifyFailureMessage()));
        verifier.submitEvidence(HEIGHT, _fundingBlob(), proof, continuity);

        bytes32 id = verifier.evidenceIdOf(HEIGHT, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, 0);
        assertFalse(verifier.seen(id), "nothing may survive a failed verification");
    }

    // ------------------------------------------------------------------
    // status, which the precompile does not check
    // ------------------------------------------------------------------

    /// @notice A proof of a reverted transaction is rejected.
    /// @dev The blob is a real one, captured from Sepolia, of a transaction that
    ///      actually failed. Its proof was valid; the transaction was not.
    function test_rejectsProofOfRevertedTransaction() public {
        bytes memory blob = _fixtureBlob("reverted");
        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXVerifier.SourceTransactionFailed.selector, HEIGHT, TX_INDEX)
        );
        verifier.submitEvidence(HEIGHT, blob, proof, continuity);
    }

    /// @notice A failed transaction carrying our events is still rejected.
    /// @dev The realistic danger is not an empty failed transaction, it is one
    ///      whose logs look exactly right. Logs do not survive a revert on chain,
    ///      but nothing stops a hand-built blob from claiming they did.
    function test_rejectsFailedTransactionEvenWithOurEvents() public {
        ProvenLog[] memory logs = new ProvenLog[](1);
        logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
        bytes memory blob = BlobBuilder.build(2, 2, 0, logs);

        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXVerifier.SourceTransactionFailed.selector, HEIGHT, TX_INDEX)
        );
        verifier.submitEvidence(HEIGHT, blob, proof, continuity);
    }

    // ------------------------------------------------------------------
    // nothing to record
    // ------------------------------------------------------------------

    /// @notice A valid proof of a transaction with no logs is a failed submission.
    function test_rejectsTransactionWithNoLogs() public {
        vm.expectRevert(Cr3dXVerifier.NoRelevantEvidence.selector);
        verifier.submitEvidence(HEIGHT, _fixtureBlob("eip1559-no-logs"), proof, continuity);
    }

    /// @notice A busy transaction with none of our events is a failed submission.
    /// @dev Real blob, forty-three logs, none of them ours.
    function test_rejectsTransactionWithLogsButNoneOfOurs() public {
        vm.expectRevert(Cr3dXVerifier.NoRelevantEvidence.selector);
        verifier.submitEvidence(HEIGHT, _fixtureBlob("many-logs"), proof, continuity);
    }

    // ------------------------------------------------------------------
    // the emitter is the defence
    // ------------------------------------------------------------------

    /// @notice An identical event from another contract is ignored, not accepted.
    function test_ignoresIdenticalEventFromAnotherEmitter() public {
        ProvenLog[] memory logs = new ProvenLog[](1);
        logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
        logs[0].emitter = makeAddr("lookalike");

        vm.expectRevert(Cr3dXVerifier.NoRelevantEvidence.selector);
        verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);
    }

    /// @notice An unrelated event from our own gateway address is ignored.
    /// @dev Skipped in silence rather than reverted: a gateway that emitted
    ///      anything else, ever, would otherwise brick every submission.
    function test_ignoresUnrelatedTopicFromOurGateway() public {
        ProvenLog[] memory logs = new ProvenLog[](2);
        logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
        logs[1] = _fundingLog(DEAL, investor, borrower, FUNDING, 1);
        logs[1].topics[0] = keccak256("SomethingElse(uint256)");

        bytes32[] memory ids =
            verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);
        assertEq(ids.length, 1, "only the recognised event counts");
    }

    /// @notice A log with no topics at all does not break the walk.
    function test_toleratesLogWithoutTopics() public {
        ProvenLog[] memory logs = new ProvenLog[](2);
        logs[0] = ProvenLog({emitter: address(gateway), topics: new bytes32[](0), data: ""});
        logs[1] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);

        bytes32[] memory ids =
            verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);
        assertEq(ids.length, 1, "the untopiced log is skipped, the real one is kept");
    }

    // ------------------------------------------------------------------
    // replay
    // ------------------------------------------------------------------

    function test_rejectsReplayOfTheSameEvidence() public {
        bytes memory blob = _fundingBlob();
        bytes32[] memory ids = verifier.submitEvidence(HEIGHT, blob, proof, continuity);

        vm.expectRevert(abi.encodeWithSelector(Cr3dXVerifier.EvidenceAlreadyRecorded.selector, ids[0]));
        verifier.submitEvidence(HEIGHT, blob, proof, continuity);
    }

    /// @notice The same event proven at a different height is a different fact.
    /// @dev Height is part of the identifier, so this cannot be used to smuggle a
    ///      duplicate past the replay check. It is here to pin the identifier's
    ///      inputs, not to bless the behaviour.
    function test_identifierDependsOnHeightIndexKindAndNonce() public view {
        bytes32 base = verifier.evidenceIdOf(HEIGHT, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, 0);
        assertTrue(
            base != verifier.evidenceIdOf(HEIGHT + 1, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, 0),
            "height"
        );
        assertTrue(
            base != verifier.evidenceIdOf(HEIGHT, TX_INDEX + 1, Cr3dXVerifier.EvidenceKind.FUNDING, 0),
            "tx index"
        );
        assertTrue(
            base != verifier.evidenceIdOf(HEIGHT, TX_INDEX, Cr3dXVerifier.EvidenceKind.REPAYMENT, 0), "kind"
        );
        assertTrue(
            base != verifier.evidenceIdOf(HEIGHT, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, 1), "nonce"
        );
    }

    /// @notice A funding and a repayment sharing one nonce are still distinct.
    /// @dev They cannot share a nonce in practice, since the gateway's counter is
    ///      shared. The identifier does not rely on that being true.
    function test_fundingAndRepaymentWithTheSameNonceDoNotCollide() public {
        ProvenLog[] memory logs = new ProvenLog[](2);
        logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
        logs[1] = _repaymentLog(DEAL, borrower, investor, FACE_VALUE, 0);

        bytes32[] memory ids =
            verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);
        assertEq(ids.length, 2, "both recorded");
        assertTrue(ids[0] != ids[1], "kind separates them even at the same nonce");
        assertEq(
            uint8(verifier.getEvidence(ids[1]).kind), uint8(Cr3dXVerifier.EvidenceKind.REPAYMENT), "kind read"
        );
    }

    // ------------------------------------------------------------------
    // field decoding
    // ------------------------------------------------------------------

    /// @notice A repayment decodes into the right roles.
    /// @dev The second indexed parameter is the payer and the third is the
    ///      investor, which is the mirror image of a funding. Getting these the
    ///      wrong way round would settle money against the wrong party.
    function test_repaymentRolesAreNotMirrored() public {
        _fundGatewayApproval(borrower, FACE_VALUE);

        vm.recordLogs();
        vm.prank(borrower);
        gateway.repay(DEAL, investor, FACE_VALUE);
        ProvenLog[] memory logs = BlobBuilder.fromRecorded(vm.getRecordedLogs());

        bytes32[] memory ids =
            verifier.submitEvidence(HEIGHT, BlobBuilder.buildSuccessful(logs), proof, continuity);
        Cr3dXVerifier.VerifiedEvidence memory e = verifier.getEvidence(ids[0]);

        assertEq(uint8(e.kind), uint8(Cr3dXVerifier.EvidenceKind.REPAYMENT), "kind");
        assertEq(e.counterparty, borrower, "the payer is the counterparty");
        assertEq(e.recipient, investor, "the investor is the recipient");
        assertEq(e.amount, FACE_VALUE, "amount");
    }

    /// @notice The transaction type is irrelevant to the outcome.
    function test_transactionTypeDoesNotChangeTheResult() public {
        uint8[4] memory types = [0, 1, 2, 3];
        for (uint256 i = 0; i < types.length; i++) {
            Cr3dXVerifier fresh = new Cr3dXVerifier(CHAIN_KEY, address(gateway));
            ProvenLog[] memory logs = new ProvenLog[](1);
            logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
            uint256 leading = types[i] >= 3 ? 3 : 2;

            bytes32[] memory ids = fresh.submitEvidence(
                HEIGHT, BlobBuilder.build(types[i], leading, 1, logs), proof, continuity
            );
            assertEq(ids.length, 1, "one fact whatever the transaction type");
            assertEq(fresh.getEvidence(ids[0]).amount, FUNDING, "and the same fields");
        }
    }

    // ------------------------------------------------------------------
    // batch
    // ------------------------------------------------------------------

    function test_batchVerifiesOnceAndRecordsEachTransaction() public {
        uint256 n = 3;
        (uint64[] memory heights, bytes[] memory blobs, IBlockProver.MerkleProof[] memory proofs) =
            _batch(n, true);

        // One continuity proof for the whole range: that is the point of a batch.
        vm.expectCall(address(Attestcoin.BLOCK_PROVER), abi.encodeWithSelector(0x1b5f6f88), 1);

        bytes32[] memory ids = verifier.submitEvidenceBatch(heights, blobs, proofs, continuity);
        assertEq(ids.length, n, "one fact per transaction");
        for (uint256 i = 0; i < n; i++) {
            assertTrue(verifier.seen(ids[i]), "each recorded");
        }
    }

    /// @notice A batch may contain transactions with none of our events.
    /// @dev The empty-result rule applies to the call, not to each transaction.
    ///      Failing a whole batch because one of its members was uninteresting
    ///      would be gratuitous.
    function test_batchToleratesTransactionsWithoutOurEvents() public {
        uint64[] memory heights = new uint64[](2);
        bytes[] memory blobs = new bytes[](2);
        IBlockProver.MerkleProof[] memory proofs = new IBlockProver.MerkleProof[](2);

        heights[0] = HEIGHT;
        blobs[0] = _fixtureBlob("many-logs");
        proofs[0] = proof;
        heights[1] = HEIGHT + 1;
        blobs[1] = _fundingBlob();
        proofs[1] = proof;

        bytes32[] memory ids = verifier.submitEvidenceBatch(heights, blobs, proofs, continuity);
        assertEq(ids.length, 1, "the uninteresting transaction is tolerated, the other is recorded");
    }

    /// @notice A batch where nothing at all matches is still a failed submission.
    function test_batchWithNothingRelevantReverts() public {
        uint64[] memory heights = new uint64[](2);
        bytes[] memory blobs = new bytes[](2);
        IBlockProver.MerkleProof[] memory proofs = new IBlockProver.MerkleProof[](2);
        for (uint256 i = 0; i < 2; i++) {
            // casting to 'uint64' is safe because i is at most 1
            // forge-lint: disable-next-line(unsafe-typecast)
            heights[i] = HEIGHT + uint64(i);
            blobs[i] = _fixtureBlob("many-logs");
            proofs[i] = proof;
        }

        vm.expectRevert(Cr3dXVerifier.NoRelevantEvidence.selector);
        verifier.submitEvidenceBatch(heights, blobs, proofs, continuity);
    }

    function test_batchRejectsElevenHeights() public {
        (uint64[] memory heights, bytes[] memory blobs, IBlockProver.MerkleProof[] memory proofs) =
            _batch(11, true);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXVerifier.BatchSizeOutOfRange.selector, 11));
        verifier.submitEvidenceBatch(heights, blobs, proofs, continuity);
    }

    function test_batchRejectsEmpty() public {
        vm.expectRevert(abi.encodeWithSelector(Cr3dXVerifier.BatchSizeOutOfRange.selector, 0));
        verifier.submitEvidenceBatch(
            new uint64[](0), new bytes[](0), new IBlockProver.MerkleProof[](0), continuity
        );
    }

    function test_batchRejectsMismatchedLengths() public {
        (uint64[] memory heights, bytes[] memory blobs,) = _batch(3, true);
        vm.expectRevert(Cr3dXVerifier.BatchLengthMismatch.selector);
        verifier.submitEvidenceBatch(heights, blobs, new IBlockProver.MerkleProof[](2), continuity);
    }

    /// @notice A batch is all or nothing.
    /// @dev A duplicate in the tenth transaction undoes the first nine.
    function test_batchIsAtomic() public {
        bytes memory blob = _fundingBlob();
        bytes32[] memory first = verifier.submitEvidence(HEIGHT, blob, proof, continuity);

        uint64[] memory heights = new uint64[](2);
        bytes[] memory blobs = new bytes[](2);
        IBlockProver.MerkleProof[] memory proofs = new IBlockProver.MerkleProof[](2);
        heights[0] = HEIGHT + 1;
        blobs[0] = _fundingBlobWithNonce(99);
        proofs[0] = proof;
        heights[1] = HEIGHT;
        blobs[1] = blob;
        proofs[1] = proof;

        vm.expectRevert(abi.encodeWithSelector(Cr3dXVerifier.EvidenceAlreadyRecorded.selector, first[0]));
        verifier.submitEvidenceBatch(heights, blobs, proofs, continuity);

        bytes32 wouldHaveBeen =
            verifier.evidenceIdOf(HEIGHT + 1, TX_INDEX, Cr3dXVerifier.EvidenceKind.FUNDING, 99);
        assertFalse(
            verifier.seen(wouldHaveBeen), "the earlier transaction in the batch must not have survived"
        );
    }

    // ------------------------------------------------------------------
    // no privileged surface
    // ------------------------------------------------------------------

    /// @notice Nothing can alter a recorded fact, including the deployer.
    function test_verifierHasNoPrivilegedFunctions() public {
        string[8] memory forbidden = [
            "owner()",
            "transferOwnership(address)",
            "pause()",
            "setGateway(address)",
            "setChainKey(uint64)",
            "deleteEvidence(bytes32)",
            "overrideEvidence(bytes32,uint256)",
            "upgradeTo(address)"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) =
                address(verifier).call(abi.encodeWithSignature(forbidden[i], address(this), uint256(1)));
            assertFalse(ok, string.concat("verifier must not expose ", forbidden[i]));
        }
    }

    // ------------------------------------------------------------------
    // cost
    // ------------------------------------------------------------------

    /// @notice Records what a submission costs, for the gas budget.
    /// @dev Excludes the real precompile's own metering and the calldata, both of
    ///      which were measured against the live network: about 47,000 gas for a
    ///      gate-shaped transaction. What this measures is everything Cr3dX adds
    ///      on top.
    function test_submissionCost() public {
        ProvenLog[] memory one = new ProvenLog[](1);
        one[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 0);
        bytes memory blobOne = BlobBuilder.buildSuccessful(one);

        uint256 before = gasleft();
        verifier.submitEvidence(HEIGHT, blobOne, proof, continuity);
        console2.log("submitEvidence, 1 log, 1 fact:", before - gasleft());

        ProvenLog[] memory three = new ProvenLog[](3);
        three[0] = _fundingLog(DEAL, investor, borrower, FUNDING, 10);
        three[1] = _fundingLog(DEAL, investor, borrower, FUNDING, 11);
        three[2] = _repaymentLog(DEAL, borrower, investor, FACE_VALUE, 12);
        bytes memory blobThree = BlobBuilder.buildSuccessful(three);

        before = gasleft();
        verifier.submitEvidence(HEIGHT + 1, blobThree, proof, continuity);
        console2.log("submitEvidence, 3 logs, 3 facts:", before - gasleft());
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _prover() internal pure returns (MockBlockProver) {
        return MockBlockProver(address(Attestcoin.BLOCK_PROVER));
    }

    function _fundGatewayApproval(address who, uint256 amount) internal {
        vm.prank(who);
        token.approve(address(gateway), amount);
    }

    function _fundingLog(bytes32 dealId, address from, address to, uint256 amount, uint256 eventNonce)
        internal
        view
        returns (ProvenLog memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = ICr3dXGatewayEvents.FundingMade.selector;
        topics[1] = dealId;
        topics[2] = bytes32(uint256(uint160(from)));
        topics[3] = bytes32(uint256(uint160(to)));
        log = ProvenLog({emitter: address(gateway), topics: topics, data: abi.encode(amount, eventNonce)});
    }

    function _repaymentLog(bytes32 dealId, address from, address to, uint256 amount, uint256 eventNonce)
        internal
        view
        returns (ProvenLog memory log)
    {
        log = _fundingLog(dealId, from, to, amount, eventNonce);
        log.topics[0] = ICr3dXGatewayEvents.RepaymentMade.selector;
    }

    function _fundingBlob() internal view returns (bytes memory) {
        return _fundingBlobWithNonce(0);
    }

    function _fundingBlobWithNonce(uint256 eventNonce) internal view returns (bytes memory) {
        ProvenLog[] memory logs = new ProvenLog[](1);
        logs[0] = _fundingLog(DEAL, investor, borrower, FUNDING, eventNonce);
        return BlobBuilder.buildSuccessful(logs);
    }

    /// @notice A blob captured verbatim from live Sepolia.
    function _fixtureBlob(string memory name) internal view returns (bytes memory) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name, ".json"));
        return vm.parseJsonBytes(json, ".encodedTx");
    }

    function _countTopic(ProvenLog[] memory logs, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) n++;
        }
    }

    function _batch(uint256 n, bool withEvents)
        internal
        view
        returns (uint64[] memory heights, bytes[] memory blobs, IBlockProver.MerkleProof[] memory proofs)
    {
        heights = new uint64[](n);
        blobs = new bytes[](n);
        proofs = new IBlockProver.MerkleProof[](n);
        for (uint256 i = 0; i < n; i++) {
            // casting to 'uint64' is safe because n is at most 11 in every caller
            // forge-lint: disable-next-line(unsafe-typecast)
            heights[i] = HEIGHT + uint64(i);
            blobs[i] = withEvents ? _fundingBlobWithNonce(i) : _fixtureBlob("eip1559-no-logs");
            proofs[i] = proof;
        }
    }
}
