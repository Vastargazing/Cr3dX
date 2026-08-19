// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Cr3dXCredit, Result} from "../../contracts/Cr3dXCredit.sol";
import {Cr3dXDeals} from "../../contracts/Cr3dXDeals.sol";
import {Cr3dXGateway} from "../../contracts/Cr3dXGateway.sol";
import {Cr3dXVerifier} from "../../contracts/Cr3dXVerifier.sol";
import {IBlockProver} from "../../contracts/interfaces/IBlockProver.sol";
import {Attestcoin} from "../../contracts/libraries/Attestcoin.sol";
import {ProvenLog} from "../../contracts/libraries/ProvenTransaction.sol";
import {BlobBuilder} from "./BlobBuilder.sol";
import {GateLog} from "./GateLog.sol";
import {MockChainInfo} from "./MockChainInfo.sol";

/// @notice Drives a deployed Cr3dX through arbitrary sequences of the things
///         that can actually happen to it, and keeps an independent tally of
///         what should have happened.
///
/// @dev **Why a handler rather than fuzzing the contracts directly.** An
///      unguided fuzzer spends its budget on calls that revert on the first
///      line - unknown deal identifiers, evidence nobody proved - and never
///      reaches the states worth checking. This handler only ever names deals
///      and evidence that exist, so every call lands somewhere interesting.
///
///      **The ghost tally is the point.** Every accumulator the registry keeps
///      is mirrored here from the outside, updated only when an application
///      genuinely reported `APPLIED`. An invariant that compared the registry
///      to itself would pass no matter what it did; comparing it to a tally
///      built from the return values is what makes INV-2 and INV-17 checkable.
///
///      Payments here are hand-built gateway logs rather than real gateway
///      calls, for the cost reason explained in `GateLog`, whose fidelity is
///      pinned by `test/GateLog.t.sol`.
contract Cr3dXHandler is Test {
    uint64 public constant CHAIN_KEY = 1;
    uint64 public constant START_HEIGHT = 11_500_000;

    Cr3dXDeals public immutable deals;
    Cr3dXCredit public immutable credit;
    Cr3dXVerifier public immutable verifier;
    address public immutable gateway;

    address[3] public borrowers;
    address[3] public investors;

    bytes32[] public dealIds;
    bytes32[] public evidenceIds;

    /// @dev What the registry should hold, tallied from outside.
    mapping(bytes32 => uint256) public ghostFunded;
    mapping(bytes32 => uint256) public ghostRepaid;
    mapping(bytes32 => uint256) public ghostOnTime;
    mapping(bytes32 => bool) public ghostApplied;

    uint256 public appliedCount;
    uint256 public rejectedCount;
    uint256 public defaultCount;

    uint64 public attestedHeight = START_HEIGHT;
    uint256 private _nonce;

    IBlockProver.MerkleProof internal proof;
    IBlockProver.ContinuityProof internal continuity;

    constructor(Cr3dXDeals deals_, Cr3dXVerifier verifier_, address gateway_) {
        deals = deals_;
        credit = deals_.credit();
        verifier = verifier_;
        gateway = gateway_;

        for (uint256 i = 0; i < 3; i++) {
            borrowers[i] = makeAddr(string.concat("borrower", vm.toString(i)));
            investors[i] = makeAddr(string.concat("investor", vm.toString(i)));
        }

        proof.root = keccak256("merkle-root");
        proof.siblings.push(IBlockProver.MerkleProofEntry({hash: keccak256("sibling"), isLeft: true}));
        continuity.lowerEndpointDigest = keccak256("lower");
        continuity.roots.push(keccak256("root"));
    }

    function dealCount() external view returns (uint256) {
        return dealIds.length;
    }

    function evidenceCount() external view returns (uint256) {
        return evidenceIds.length;
    }

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------

    function createDeal(uint256 borrowerSeed, uint256 investorSeed, uint256 fundingSeed, uint256 faceSeed, uint256 dueSeed)
        external
    {
        address borrower = borrowers[borrowerSeed % 3];
        address investor = investors[investorSeed % 3];
        uint256 faceValue = bound(faceSeed, 1, 2_000_000_000);
        uint256 requiredFunding = bound(fundingSeed, 1, faceValue);
        uint64 dueBlock = uint64(bound(dueSeed, START_HEIGHT, START_HEIGHT + 20_000));

        uint256 available = credit.availableLimitOf(borrower);
        vm.prank(borrower);
        try deals.createDeal(investor, requiredFunding, faceValue, dueBlock) returns (bytes32 dealId) {
            assertLe(faceValue, available, "a deal was opened beyond the available limit");
            dealIds.push(dealId);
        } catch {
            // INV-10: the only reason creation may fail is the limit.
            assertGt(faceValue, available, "creation failed while the limit still allowed it");
        }
    }

    function fund(uint256 dealSeed, uint256 investorSeed, uint256 amountSeed, uint256 heightSeed) external {
        if (dealIds.length == 0) return;
        bytes32 dealId = dealIds[dealSeed % dealIds.length];
        Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);

        // Mostly the designated investor, occasionally somebody else, so that
        // both the applicable and the permanently refused path get exercised.
        address payer = investorSeed % 4 == 0 ? investors[investorSeed % 3] : deal.designatedInvestor;
        address recipient = investorSeed % 7 == 0 ? borrowers[investorSeed % 3] : deal.borrower;
        uint256 amount = bound(amountSeed, 1, 3_000_000_000);
        uint64 height = uint64(bound(heightSeed, START_HEIGHT - 10_000, START_HEIGHT + 30_000));

        bytes32 evidenceId = _record(
            GateLog.only(GateLog.funding(gateway, dealId, payer, recipient, amount, _nonce++)), height
        );

        bool applicable = recipient == deal.borrower && payer == deal.designatedInvestor
            && deal.fundedAmount < deal.requiredFunding;

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.applyEvidence(evidenceId);

        if (applicable) {
            // INV-11: nothing may refuse funding that is applicable.
            assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED), "applicable funding was refused");
        }
        _account(evidenceId, dealId, state, reason, amount, 0, 0);
    }

    function repay(uint256 dealSeed, uint256 payerSeed, uint256 amountSeed, uint256 heightSeed) external {
        if (dealIds.length == 0) return;
        bytes32 dealId = dealIds[dealSeed % dealIds.length];
        Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);

        address payer = borrowers[payerSeed % 3];
        // Before funding fixes the investor there is nobody to pay but the
        // designated one, which is what a real payer would do, and what leaves
        // the evidence waiting rather than refused.
        address expected = deal.investor == address(0) ? deal.designatedInvestor : deal.investor;
        address recipient = payerSeed % 7 == 0 ? investors[payerSeed % 3] : expected;
        uint256 amount = bound(amountSeed, 1, 3_000_000_000);
        uint64 height = uint64(bound(heightSeed, START_HEIGHT - 10_000, START_HEIGHT + 30_000));

        bytes32 evidenceId =
            _record(GateLog.only(GateLog.repayment(gateway, dealId, payer, recipient, amount, _nonce++)), height);

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.applyEvidence(evidenceId);
        _account(evidenceId, dealId, state, reason, 0, amount, height <= deal.dueBlock ? amount : 0);
    }

    /// @dev Retries an arbitrary fact. Applying twice must change nothing, and
    ///      a fact that was waiting must be able to complete later.
    function retry(uint256 seed) external {
        if (evidenceIds.length == 0) return;
        bytes32 evidenceId = evidenceIds[seed % evidenceIds.length];
        Cr3dXVerifier.VerifiedEvidence memory evidence = verifier.getEvidence(evidenceId);

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.applyEvidence(evidenceId);
        _account(
            evidenceId,
            evidence.dealId,
            state,
            reason,
            evidence.kind == Cr3dXVerifier.EvidenceKind.FUNDING ? evidence.amount : 0,
            evidence.kind == Cr3dXVerifier.EvidenceKind.REPAYMENT ? evidence.amount : 0,
            evidence.kind == Cr3dXVerifier.EvidenceKind.REPAYMENT
                && evidence.blockHeight <= deals.getDeal(evidence.dealId).dueBlock ? evidence.amount : 0
        );
    }

    /// @dev The attested source height only ever moves forward, exactly as the
    ///      protocol's does.
    function advanceAttestedHeight(uint256 seed) external {
        attestedHeight += uint64(bound(seed, 1, 5_000));
        MockChainInfo(address(Attestcoin.CHAIN_INFO)).setAttestedHeight(CHAIN_KEY, attestedHeight);
    }

    function markDefaulted(uint256 dealSeed) external {
        if (dealIds.length == 0) return;
        bytes32 dealId = dealIds[dealSeed % dealIds.length];
        Cr3dXDeals.DealStatus before = deals.getDeal(dealId).status;

        try deals.markDefaulted(dealId) {
            // INV-22: a default can only come out of FINANCED.
            assertEq(uint8(before), uint8(Cr3dXDeals.DealStatus.FINANCED), "defaulted from the wrong status");
            defaultCount++;
        } catch {}
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    function _record(ProvenLog[] memory logs, uint64 height) private returns (bytes32 evidenceId) {
        bytes32[] memory ids = verifier.submitEvidence(height, BlobBuilder.buildSuccessful(logs), proof, continuity);
        evidenceIds.push(ids[0]);
        return ids[0];
    }

    /// @dev Mirrors an application into the ghost tally, once and only once.
    function _account(
        bytes32 evidenceId,
        bytes32 dealId,
        Cr3dXDeals.EvidenceState state,
        Cr3dXDeals.RejectionReason reason,
        uint256 funded,
        uint256 repaid,
        uint256 onTime
    ) private {
        if (state == Cr3dXDeals.EvidenceState.REJECTED_PERMANENT) {
            // INV-19: a permanent refusal always names one of the three reasons.
            assertTrue(reason != Cr3dXDeals.RejectionReason.NONE, "a rejection without a reason");
            rejectedCount++; // observations, not a quantity any invariant asserts on

            return;
        }
        if (state != Cr3dXDeals.EvidenceState.APPLIED) return;
        if (ghostApplied[evidenceId]) return;

        ghostApplied[evidenceId] = true;
        appliedCount++;
        ghostFunded[dealId] += funded;
        ghostRepaid[dealId] += repaid;
        ghostOnTime[dealId] += onTime;
    }
}
