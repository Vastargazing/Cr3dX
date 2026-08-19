// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Cr3dXReferenceModel} from "./Cr3dXReferenceModel.sol";
import {Cr3dXModelHandler} from "./Cr3dXModelHandler.sol";

/// @notice Stateful-проверки внутренней согласованности независимой модели фазы A.
contract Cr3dXReferenceInvariantTest is StdInvariant, Test {
    Cr3dXReferenceModel internal model;
    Cr3dXModelHandler internal handler;

    function setUp() public {
        model = new Cr3dXReferenceModel(10_000, 600);
        handler = new Cr3dXModelHandler(model);
        targetContract(address(handler));
    }

    function invariant_INV2_evidenceAppliedAtMostOnce() public view {
        uint256 count = model.evidenceCount();
        for (uint256 i = 0; i < count; i++) {
            Cr3dXReferenceModel.Evidence memory item = model.evidence(model.evidenceIdAt(i));
            assertLe(item.appliedCount, 1);
            if (item.state == Cr3dXReferenceModel.EvidenceState.APPLIED) {
                assertTrue(item.verifierAccepted);
                assertEq(item.appliedCount, 1);
            } else {
                assertEq(item.appliedCount, 0);
            }
        }
    }

    function invariant_INV4_INV12_INV21_outcomeIsCanonicalAndStatusMatches() public view {
        uint256 count = model.dealCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 dealId = model.dealIdAt(i);
            Cr3dXReferenceModel.Deal memory deal = model.getDeal(dealId);
            Cr3dXReferenceModel.CreditOutcome memory outcome = model.getOutcome(dealId);
            Cr3dXReferenceModel.Outcome canonical = model.canonicalOutcomeOf(dealId);

            assertLe(deal.onTimeRepaid, deal.repaidAmount);
            assertEq(uint256(outcome.result), uint256(canonical));
            assertEq(outcome.exists, canonical != Cr3dXReferenceModel.Outcome.NONE);

            if (canonical == Cr3dXReferenceModel.Outcome.PAID_ON_TIME) {
                assertEq(uint256(deal.status), uint256(Cr3dXReferenceModel.DealStatus.PAID_ON_TIME));
                assertGe(deal.onTimeRepaid, deal.faceValue);
            } else if (canonical == Cr3dXReferenceModel.Outcome.PAID_LATE) {
                assertEq(uint256(deal.status), uint256(Cr3dXReferenceModel.DealStatus.PAID_LATE));
                assertLt(deal.onTimeRepaid, deal.faceValue);
                assertGe(deal.repaidAmount, deal.faceValue);
            } else if (canonical == Cr3dXReferenceModel.Outcome.DEFAULTED) {
                assertEq(uint256(deal.status), uint256(Cr3dXReferenceModel.DealStatus.DEFAULTED));
            }
        }
    }

    function invariant_INV5_scoreCountersEqualFullRecalculation() public view {
        uint256 count = model.borrowerCount();
        for (uint256 i = 0; i < count; i++) {
            address borrower = model.borrowerAt(i);
            Cr3dXReferenceModel.BorrowerState memory cached = model.borrowerState(borrower);
            (uint64 onTime, uint64 late, uint64 defaults) = model.countersByFullRecalculation(borrower);
            assertEq(cached.paidOnTimeCount, onTime);
            assertEq(cached.paidLateCount, late);
            assertEq(cached.defaultedCount, defaults);
            assertEq(model.scoreOf(borrower), model.scoreByFullRecalculation(borrower));
        }
    }

    function invariant_INV9_INV10_INV13_accountingEqualsFullRecalculation() public view {
        uint256 borrowerCount = model.borrowerCount();
        for (uint256 i = 0; i < borrowerCount; i++) {
            address borrower = model.borrowerAt(i);
            Cr3dXReferenceModel.BorrowerState memory cached = model.borrowerState(borrower);
            assertEq(cached.exposure, model.exposureByFullRecalculation(borrower));
            assertEq(cached.reserved, model.reservedByFullRecalculation(borrower));

            uint256 used = cached.reserved + cached.exposure;
            uint256 limit = model.limitOf(borrower);
            uint256 expectedAvailable = used >= limit ? 0 : limit - used;
            assertEq(model.availableLimitOf(borrower), expectedAvailable);
        }

        uint256 dealCount = model.dealCount();
        for (uint256 i = 0; i < dealCount; i++) {
            bytes32 dealId = model.dealIdAt(i);
            Cr3dXReferenceModel.Deal memory deal = model.getDeal(dealId);
            assertLe(deal.fundingThresholdCrossings, 1);
            if (deal.repaidAmount >= deal.faceValue) assertEq(model.outstandingOf(dealId), 0);
            else assertEq(model.outstandingOf(dealId), deal.faceValue - deal.repaidAmount);

            if (
                deal.status == Cr3dXReferenceModel.DealStatus.FINANCED
                    || deal.status == Cr3dXReferenceModel.DealStatus.DEFAULTED
                    || deal.status == Cr3dXReferenceModel.DealStatus.PAID_LATE
                    || deal.status == Cr3dXReferenceModel.DealStatus.PAID_ON_TIME
            ) {
                assertEq(deal.fundingThresholdCrossings, 1);
                assertFalse(deal.reserveActive);
            }
        }
    }

    function invariant_INV19_rejectionReasonsAreClosedAndTypeCorrect() public view {
        uint256 count = model.evidenceCount();
        for (uint256 i = 0; i < count; i++) {
            Cr3dXReferenceModel.Evidence memory item = model.evidence(model.evidenceIdAt(i));
            if (item.state == Cr3dXReferenceModel.EvidenceState.REJECTED_PERMANENT) {
                assertTrue(item.rejectionReason != Cr3dXReferenceModel.RejectionReason.NONE);
                if (
                    item.rejectionReason == Cr3dXReferenceModel.RejectionReason.WRONG_INVESTOR
                        || item.rejectionReason == Cr3dXReferenceModel.RejectionReason.ALREADY_FUNDED
                ) {
                    assertEq(uint256(item.kind), uint256(Cr3dXReferenceModel.EvidenceKind.FUNDING));
                }
            } else {
                assertEq(uint256(item.rejectionReason), uint256(Cr3dXReferenceModel.RejectionReason.NONE));
            }
        }
    }
}

/// @notice Целевые сценарии, замораживающие ожидаемую семантику и найденные конфликты спеки.
contract Cr3dXReferenceRegressionTest is Test {
    uint256 private constant BASE_LIMIT = 10_000;
    uint64 private constant GRACE = 600;
    address private constant BORROWER = address(0xB0);
    address private constant INVESTOR = address(0xA0);
    address private constant WRONG = address(0xBAD);

    struct Snapshot {
        uint256 fundedAmount;
        uint256 repaidAmount;
        uint256 onTimeRepaid;
        uint256 outstanding;
        uint256 exposure;
        uint16 score;
        Cr3dXReferenceModel.DealStatus status;
        Cr3dXReferenceModel.Outcome outcome;
    }

    function test_INV20_requiredLateThenOnTimeRegressionBothOrders() public {
        Cr3dXReferenceModel lateFirst = _fundedModel(1_000, 1_100, 100);
        Cr3dXReferenceModel onTimeFirst = _fundedModel(1_000, 1_100, 100);

        _repay(lateFirst, "late-a", 1_100, 110, INVESTOR);
        _repay(lateFirst, "on-time-b", 1_100, 90, INVESTOR);
        _repay(onTimeFirst, "on-time-b", 1_100, 90, INVESTOR);
        _repay(onTimeFirst, "late-a", 1_100, 110, INVESTOR);

        Snapshot memory left = _snapshot(lateFirst);
        Snapshot memory right = _snapshot(onTimeFirst);
        _assertSame(left, right);
        assertEq(left.repaidAmount, 2_200);
        assertEq(left.onTimeRepaid, 1_100);
        assertEq(left.outstanding, 0);
        assertEq(uint256(left.status), uint256(Cr3dXReferenceModel.DealStatus.PAID_ON_TIME));
        assertEq(uint256(left.outcome), uint256(Cr3dXReferenceModel.Outcome.PAID_ON_TIME));
    }

    function test_INV3_repaymentBeforeFundingConvergesAfterExplicitRetry() public {
        Cr3dXReferenceModel repaymentFirst = _newModel();
        Cr3dXReferenceModel fundingFirst = _newModel();
        _create(repaymentFirst, 1_000, 1_100, 100);
        _create(fundingFirst, 1_000, 1_100, 100);

        _repay(repaymentFirst, "repayment", 1_100, 90, INVESTOR);
        _fund(repaymentFirst, "funding", 1_000, INVESTOR, BORROWER);
        repaymentFirst.drainPending();

        _fund(fundingFirst, "funding", 1_000, INVESTOR, BORROWER);
        _repay(fundingFirst, "repayment", 1_100, 90, INVESTOR);

        _assertSame(_snapshot(repaymentFirst), _snapshot(fundingFirst));
    }

    function test_INV6_fragmentingRepaymentDoesNotIncreaseScore() public {
        Cr3dXReferenceModel whole = _fundedModel(1_000, 1_100, 100);
        Cr3dXReferenceModel split = _fundedModel(1_000, 1_100, 100);

        _repay(whole, "whole", 1_100, 90, INVESTOR);
        _repay(split, "part-1", 400, 90, INVESTOR);
        _repay(split, "part-2", 700, 91, INVESTOR);

        assertEq(whole.scoreOf(BORROWER), split.scoreOf(BORROWER));
        Cr3dXReferenceModel.BorrowerState memory wholeState = whole.borrowerState(BORROWER);
        Cr3dXReferenceModel.BorrowerState memory splitState = split.borrowerState(BORROWER);
        assertEq(wholeState.paidOnTimeCount, 1);
        assertEq(splitState.paidOnTimeCount, 1);
    }

    function test_INV9_overpaymentSaturatesOutstandingAndExposure() public {
        Cr3dXReferenceModel m = _fundedModel(100, 110, 100);
        _repay(m, "overpayment", 1_000, 90, INVESTOR);
        _repay(m, "after-close", 500, 120, INVESTOR);

        Cr3dXReferenceModel.Deal memory deal = m.getDeal(_dealId());
        assertEq(deal.repaidAmount, 1_500);
        assertEq(m.outstandingOf(_dealId()), 0);
        assertEq(m.exposureByFullRecalculation(BORROWER), 0);
        assertEq(m.borrowerState(BORROWER).exposure, 0);
    }

    function test_INV13_INV18_thresholdMovesReserveExactlyOnce() public {
        Cr3dXReferenceModel m = _newModel();
        _create(m, 100, 110, 100);
        _fund(m, "part-1", 40, INVESTOR, BORROWER);

        Cr3dXReferenceModel.BorrowerState memory afterPartial = m.borrowerState(BORROWER);
        assertEq(afterPartial.reserved, 110);
        assertEq(afterPartial.exposure, 0);

        _fund(m, "part-2", 60, INVESTOR, BORROWER);
        _fund(m, "after-threshold", 25, INVESTOR, BORROWER);

        Cr3dXReferenceModel.Deal memory deal = m.getDeal(_dealId());
        Cr3dXReferenceModel.Evidence memory rejected = m.evidence(keccak256("after-threshold"));
        Cr3dXReferenceModel.BorrowerState memory financed = m.borrowerState(BORROWER);
        assertEq(deal.fundingThresholdCrossings, 1);
        assertEq(financed.reserved, 0);
        assertEq(financed.exposure, 110);
        assertEq(
            uint256(rejected.rejectionReason), uint256(Cr3dXReferenceModel.RejectionReason.ALREADY_FUNDED)
        );
    }

    function test_INV14_INV22_defaultThenDelayedTimelyProofBecomesPaidOnTime() public {
        Cr3dXReferenceModel m = _fundedModel(100, 110, 100);
        m.advanceAttestedHeight(701);
        assertTrue(m.markDefaulted(_dealId()));
        assertEq(m.borrowerState(BORROWER).exposure, 110);

        _repay(m, "timely-arrived-late", 110, 100, INVESTOR);
        Cr3dXReferenceModel.Deal memory deal = m.getDeal(_dealId());
        Cr3dXReferenceModel.CreditOutcome memory outcome = m.getOutcome(_dealId());
        Cr3dXReferenceModel.BorrowerState memory borrower = m.borrowerState(BORROWER);
        assertEq(uint256(deal.status), uint256(Cr3dXReferenceModel.DealStatus.PAID_ON_TIME));
        assertEq(uint256(outcome.result), uint256(Cr3dXReferenceModel.Outcome.PAID_ON_TIME));
        assertEq(borrower.defaultedCount, 0);
        assertEq(borrower.paidOnTimeCount, 1);
        assertEq(borrower.exposure, 0);
    }

    function test_INV22_defaultRejectedOutsideFinanced() public {
        Cr3dXReferenceModel created = _newModel();
        _create(created, 100, 110, 100);
        created.advanceAttestedHeight(10_000);
        assertFalse(created.markDefaulted(_dealId()));

        Cr3dXReferenceModel paidLate = _fundedModel(100, 110, 100);
        _repay(paidLate, "late", 110, 101, INVESTOR);
        paidLate.advanceAttestedHeight(10_000);
        assertFalse(paidLate.markDefaulted(_dealId()));

        Cr3dXReferenceModel paidOnTime = _fundedModel(100, 110, 100);
        _repay(paidOnTime, "on-time", 110, 100, INVESTOR);
        paidOnTime.advanceAttestedHeight(10_000);
        assertFalse(paidOnTime.markDefaulted(_dealId()));
    }

    function test_INV20_partialRepaymentsAreOrderIndependent() public {
        Cr3dXReferenceModel first = _fundedModel(100, 110, 100);
        Cr3dXReferenceModel second = _fundedModel(100, 110, 100);

        _repay(first, "late-40", 40, 120, INVESTOR);
        _repay(first, "timely-50", 50, 90, INVESTOR);
        _repay(first, "timely-60", 60, 95, INVESTOR);

        _repay(second, "timely-60", 60, 95, INVESTOR);
        _repay(second, "timely-50", 50, 90, INVESTOR);
        _repay(second, "late-40", 40, 120, INVESTOR);

        Snapshot memory left = _snapshot(first);
        Snapshot memory right = _snapshot(second);
        _assertSame(left, right);
        assertEq(left.repaidAmount, 150);
        assertEq(left.onTimeRepaid, 110);
        assertEq(uint256(left.status), uint256(Cr3dXReferenceModel.DealStatus.PAID_ON_TIME));
    }

    function test_INV4_paidLateUpgradesAndPaidOnTimeNeverDowngrades() public {
        Cr3dXReferenceModel m = _fundedModel(100, 110, 100);
        _repay(m, "late-full", 110, 101, INVESTOR);
        assertEq(uint256(m.getOutcome(_dealId()).result), uint256(Cr3dXReferenceModel.Outcome.PAID_LATE));

        _repay(m, "timely-full", 110, 100, INVESTOR);
        assertEq(uint256(m.getOutcome(_dealId()).result), uint256(Cr3dXReferenceModel.Outcome.PAID_ON_TIME));

        _repay(m, "late-after-on-time", 1_000, 1_000, INVESTOR);
        assertEq(uint256(m.getOutcome(_dealId()).result), uint256(Cr3dXReferenceModel.Outcome.PAID_ON_TIME));
        Cr3dXReferenceModel.BorrowerState memory borrower = m.borrowerState(BORROWER);
        assertEq(borrower.paidOnTimeCount, 1);
        assertEq(borrower.paidLateCount, 0);
    }

    function test_INV10_reservedDealsExhaustLimitAtExactBoundary() public {
        Cr3dXReferenceModel m = new Cr3dXReferenceModel(100, GRACE);
        assertTrue(m.createDeal(keccak256("d1"), BORROWER, INVESTOR, 50, 60, 100));
        assertFalse(m.createDeal(keccak256("too-large"), BORROWER, INVESTOR, 40, 41, 100));
        assertTrue(m.createDeal(keccak256("d2"), BORROWER, INVESTOR, 40, 40, 100));
        assertEq(m.availableLimitOf(BORROWER), 0);
        assertFalse(m.createDeal(keccak256("d3"), BORROWER, INVESTOR, 1, 1, 100));
    }

    function test_INV10_defaultCanPutExposureAboveLimitWithoutRevert() public {
        Cr3dXReferenceModel m = new Cr3dXReferenceModel(100, GRACE);
        assertTrue(m.createDeal(_dealId(), BORROWER, INVESTOR, 100, 100, 0));
        _fund(m, "funding", 100, INVESTOR, BORROWER);
        m.advanceAttestedHeight(601);
        assertTrue(m.markDefaulted(_dealId()));

        assertEq(m.scoreOf(BORROWER), 300);
        assertEq(m.limitOf(BORROWER), 60);
        assertEq(m.borrowerState(BORROWER).exposure, 100);
        assertEq(m.availableLimitOf(BORROWER), 0);
    }

    function test_INV11_expiredDealStillAcceptsFunding() public {
        Cr3dXReferenceModel m = _newModel();
        _create(m, 100, 110, 10);
        m.advanceAttestedHeight(10_000);
        _fund(m, "funding-after-due", 100, INVESTOR, BORROWER);

        Cr3dXReferenceModel.Deal memory deal = m.getDeal(_dealId());
        assertEq(uint256(deal.status), uint256(Cr3dXReferenceModel.DealStatus.FINANCED));
        assertEq(deal.fundedAmount, 100);
    }

    function test_INV19_unknownEvidenceWaitsThenAppliesAfterDealCreation() public {
        Cr3dXReferenceModel m = _newModel();
        bytes32 futureDeal = keccak256("future-deal");
        bytes32 evidenceId = keccak256("future-funding");
        m.registerVerifiedEvidence(
            evidenceId, Cr3dXReferenceModel.EvidenceKind.FUNDING, futureDeal, INVESTOR, BORROWER, 100, 1
        );
        assertEq(
            uint256(m.evidence(evidenceId).state), uint256(Cr3dXReferenceModel.EvidenceState.VERIFIED_PENDING)
        );

        assertTrue(m.createDeal(futureDeal, BORROWER, INVESTOR, 100, 110, 100));
        m.retryEvidence(evidenceId);
        assertEq(uint256(m.evidence(evidenceId).state), uint256(Cr3dXReferenceModel.EvidenceState.APPLIED));
        assertEq(uint256(m.getDeal(futureDeal).status), uint256(Cr3dXReferenceModel.DealStatus.FINANCED));
    }

    function test_INV19_wrongFundingPartiesAndWrongRepaymentRecipientArePermanent() public {
        Cr3dXReferenceModel m = _newModel();
        _create(m, 100, 110, 100);
        _fund(m, "wrong-funding-recipient", 100, INVESTOR, WRONG);
        _fund(m, "wrong-investor", 100, WRONG, BORROWER);

        assertEq(
            uint256(m.evidence(keccak256("wrong-funding-recipient")).rejectionReason),
            uint256(Cr3dXReferenceModel.RejectionReason.WRONG_RECIPIENT)
        );
        assertEq(
            uint256(m.evidence(keccak256("wrong-investor")).rejectionReason),
            uint256(Cr3dXReferenceModel.RejectionReason.WRONG_INVESTOR)
        );

        _fund(m, "correct-funding", 100, INVESTOR, BORROWER);
        _repay(m, "wrong-repayment-recipient", 110, 90, WRONG);
        assertEq(
            uint256(m.evidence(keccak256("wrong-repayment-recipient")).rejectionReason),
            uint256(Cr3dXReferenceModel.RejectionReason.WRONG_RECIPIENT)
        );
    }

    function test_INV5_signedScoreRecoversFromFloorWithoutStickyClamp() public {
        Cr3dXReferenceModel m = _newModel();
        bytes32[3] memory ids = [keccak256("score-1"), keccak256("score-2"), keccak256("score-3")];

        for (uint256 i = 0; i < ids.length; i++) {
            assertTrue(m.createDeal(ids[i], BORROWER, INVESTOR, 100, 100, 0));
            m.registerVerifiedEvidence(
                keccak256(abi.encode("score-funding", i)),
                Cr3dXReferenceModel.EvidenceKind.FUNDING,
                ids[i],
                INVESTOR,
                BORROWER,
                100,
                0
            );
        }
        m.advanceAttestedHeight(601);
        for (uint256 i = 0; i < ids.length; i++) {
            assertTrue(m.markDefaulted(ids[i]));
        }
        assertEq(m.scoreOf(BORROWER), 300);

        for (uint256 i = 0; i < ids.length; i++) {
            m.registerVerifiedEvidence(
                keccak256(abi.encode("score-repayment", i)),
                Cr3dXReferenceModel.EvidenceKind.REPAYMENT,
                ids[i],
                BORROWER,
                INVESTOR,
                100,
                0
            );
        }
        assertEq(m.scoreOf(BORROWER), 575);
        assertEq(m.scoreOf(BORROWER), m.scoreByFullRecalculation(BORROWER));
    }

    /// @dev Исполняемый минимальный сценарий неоднозначности A-01. Он не выбирает норму,
    ///      а доказывает, что буквальные правила 4.3 не обеспечивают INV-3.
    function test_SPEC_AMBIGUITY_partialFundingPermutationsAreNotConfluent() public {
        uint256[] memory a = new uint256[](3);
        a[0] = 60;
        a[1] = 50;
        a[2] = 40;
        uint256[] memory b = new uint256[](3);
        b[0] = 60;
        b[1] = 40;
        b[2] = 50;
        uint256[] memory c = new uint256[](3);
        c[0] = 50;
        c[1] = 40;
        c[2] = 60;

        assertEq(_fundingTotalForOrder(a), 110);
        assertEq(_fundingTotalForOrder(b), 100);
        assertEq(_fundingTotalForOrder(c), 150);
    }

    /// @dev Исполняемый минимальный сценарий неоднозначности A-02.
    function test_SPEC_AMBIGUITY_wrongRecipientBeforeFundingConflictsWithGeneralPendingRule() public {
        Cr3dXReferenceModel m = _newModel();
        _create(m, 100, 110, 100);
        bytes32 evidenceId = keccak256("wrong-before-funding");
        m.registerVerifiedEvidence(
            evidenceId, Cr3dXReferenceModel.EvidenceKind.REPAYMENT, _dealId(), BORROWER, WRONG, 110, 90
        );

        Cr3dXReferenceModel.Evidence memory pending = m.evidence(evidenceId);
        assertEq(uint256(pending.state), uint256(Cr3dXReferenceModel.EvidenceState.VERIFIED_PENDING));
        assertFalse(m.canEverBecomeApplicable(evidenceId));

        _fund(m, "funding", 100, INVESTOR, BORROWER);
        m.retryEvidence(evidenceId);
        Cr3dXReferenceModel.Evidence memory rejected = m.evidence(evidenceId);
        assertEq(uint256(rejected.state), uint256(Cr3dXReferenceModel.EvidenceState.REJECTED_PERMANENT));
        assertEq(
            uint256(rejected.rejectionReason), uint256(Cr3dXReferenceModel.RejectionReason.WRONG_RECIPIENT)
        );
    }

    function _newModel() private returns (Cr3dXReferenceModel) {
        return new Cr3dXReferenceModel(BASE_LIMIT, GRACE);
    }

    function _fundedModel(uint256 requiredFunding, uint256 faceValue, uint64 dueBlock)
        private
        returns (Cr3dXReferenceModel m)
    {
        m = _newModel();
        _create(m, requiredFunding, faceValue, dueBlock);
        _fund(m, "initial-funding", requiredFunding, INVESTOR, BORROWER);
    }

    function _create(Cr3dXReferenceModel m, uint256 requiredFunding, uint256 faceValue, uint64 dueBlock)
        private
    {
        assertTrue(m.createDeal(_dealId(), BORROWER, INVESTOR, requiredFunding, faceValue, dueBlock));
    }

    function _fund(
        Cr3dXReferenceModel m,
        string memory label,
        uint256 amount,
        address counterparty,
        address recipient
    ) private {
        m.registerVerifiedEvidence(
            keccak256(bytes(label)),
            Cr3dXReferenceModel.EvidenceKind.FUNDING,
            _dealId(),
            counterparty,
            recipient,
            amount,
            1
        );
    }

    function _repay(
        Cr3dXReferenceModel m,
        string memory label,
        uint256 amount,
        uint64 blockHeight,
        address recipient
    ) private {
        m.registerVerifiedEvidence(
            keccak256(bytes(label)),
            Cr3dXReferenceModel.EvidenceKind.REPAYMENT,
            _dealId(),
            BORROWER,
            recipient,
            amount,
            blockHeight
        );
    }

    function _fundingTotalForOrder(uint256[] memory amounts) private returns (uint256) {
        Cr3dXReferenceModel m = _newModel();
        _create(m, 100, 110, 100);
        for (uint256 i = 0; i < amounts.length; i++) {
            _fund(m, string(abi.encodePacked("funding-", bytes1(uint8(i)))), amounts[i], INVESTOR, BORROWER);
        }
        return m.getDeal(_dealId()).fundedAmount;
    }

    function _snapshot(Cr3dXReferenceModel m) private view returns (Snapshot memory result) {
        Cr3dXReferenceModel.Deal memory deal = m.getDeal(_dealId());
        Cr3dXReferenceModel.CreditOutcome memory outcome = m.getOutcome(_dealId());
        result = Snapshot({
            fundedAmount: deal.fundedAmount,
            repaidAmount: deal.repaidAmount,
            onTimeRepaid: deal.onTimeRepaid,
            outstanding: m.outstandingOf(_dealId()),
            exposure: m.borrowerState(BORROWER).exposure,
            score: m.scoreOf(BORROWER),
            status: deal.status,
            outcome: outcome.result
        });
    }

    function _assertSame(Snapshot memory a, Snapshot memory b) private pure {
        assertEq(a.fundedAmount, b.fundedAmount);
        assertEq(a.repaidAmount, b.repaidAmount);
        assertEq(a.onTimeRepaid, b.onTimeRepaid);
        assertEq(a.outstanding, b.outstanding);
        assertEq(a.exposure, b.exposure);
        assertEq(a.score, b.score);
        assertEq(uint256(a.status), uint256(b.status));
        assertEq(uint256(a.outcome), uint256(b.outcome));
    }

    function _dealId() private pure returns (bytes32) {
        return keccak256("deal");
    }
}
