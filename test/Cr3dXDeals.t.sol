// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Cr3dXCredit, Result} from "../contracts/Cr3dXCredit.sol";
import {Cr3dXDeals} from "../contracts/Cr3dXDeals.sol";
import {Cr3dXVerifier} from "../contracts/Cr3dXVerifier.sol";
import {ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";
import {Cr3dXHarness} from "./helpers/Cr3dXHarness.sol";
import {GateLog} from "./helpers/GateLog.sol";

/// @title Cr3dXDealsTest
/// @notice The registry: what a proven fact means, and what it is not allowed to
///         mean.
///
/// @dev Every test here runs the production wiring - real gateway events, real
///      verifier, real registry, real credit layer - with the two precompiles
///      mocked, because a local EVM has no Attestcoin. See `Cr3dXHarness`.
///
///      The file is organised by the question each group answers rather than by
///      function name: what happens to funding, what happens to repayment, what
///      the deadline does, and what the system refuses to do at all.
contract Cr3dXDealsTest is Cr3dXHarness {
    address internal borrower = makeAddr("borrower");
    address internal investor = makeAddr("investor");
    address internal stranger = makeAddr("stranger");
    address internal payer = makeAddr("payer");

    uint256 internal constant FUNDING = 1_000_000_000;
    uint256 internal constant FACE_VALUE = 1_100_000_000;
    uint64 internal constant DUE_BLOCK = 11_600_000;
    uint64 internal constant ON_TIME_HEIGHT = 11_599_000;
    uint64 internal constant LATE_HEIGHT = 11_700_000;

    function setUp() public {
        _deployCr3dX();
    }

    function _deal() internal returns (bytes32) {
        return _createDeal(borrower, investor, FUNDING, FACE_VALUE, DUE_BLOCK);
    }

    // ------------------------------------------------------------------
    // creating a deal
    // ------------------------------------------------------------------

    function test_createDealReservesAgainstTheLimit() public {
        assertEq(credit.scoreOf(borrower), 500, "a borrower with no history starts at the base score");
        assertEq(credit.limitOf(borrower), BASE_LIMIT);
        assertEq(credit.availableLimitOf(borrower), BASE_LIMIT);

        bytes32 dealId = _deal();
        Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);

        assertEq(uint8(deal.status), uint8(Cr3dXDeals.DealStatus.CREATED));
        assertEq(deal.borrower, borrower);
        assertEq(deal.designatedInvestor, investor);
        assertEq(deal.investor, address(0), "the investor is fixed by funding, not by creation");
        assertEq(deal.requiredFunding, FUNDING);
        assertEq(deal.faceValue, FACE_VALUE);
        assertEq(deal.dueBlock, DUE_BLOCK);

        assertEq(credit.reservedOf(borrower), FACE_VALUE, "the face value is reserved, not the funding");
        assertEq(credit.exposureOf(borrower), 0);
        assertEq(credit.availableLimitOf(borrower), BASE_LIMIT - FACE_VALUE);
    }

    function test_dealIdIsReproducibleFromItsTerms() public {
        bytes32 dealId = _deal();
        assertEq(dealId, deals.dealIdOf(borrower, investor, FUNDING, FACE_VALUE, DUE_BLOCK, 0));
    }

    function test_createDealRejectsImpossibleTerms() public {
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXDeals.InvalidTerms.selector, 0, FACE_VALUE));
        deals.createDeal(investor, 0, FACE_VALUE, DUE_BLOCK);

        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXDeals.InvalidTerms.selector, FACE_VALUE + 1, FACE_VALUE));
        deals.createDeal(investor, FACE_VALUE + 1, FACE_VALUE, DUE_BLOCK);
    }

    /// @notice A run of unfunded deals exhausts the limit, and the next one fails.
    /// @dev Mandatory case from section 9. The reserve is what makes a limit
    ///      real: deals nobody funded still consume it, because the alternative
    ///      is a limit that only counts money that already moved.
    function test_unfundedDealsExhaustTheLimit() public {
        uint256 each = BASE_LIMIT / 5;
        for (uint256 i = 0; i < 5; i++) {
            _createDeal(borrower, investor, each / 2, each, DUE_BLOCK);
        }
        assertEq(credit.reservedOf(borrower), BASE_LIMIT);
        assertEq(credit.availableLimitOf(borrower), 0);

        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.ExceedsAvailableLimit.selector, borrower, 1, 0));
        deals.createDeal(investor, 1, 1, DUE_BLOCK);
    }

    // ------------------------------------------------------------------
    // funding
    // ------------------------------------------------------------------

    function test_fundingFinancesTheDealAndConvertsTheReserve() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
        assertEq(uint8(deal.status), uint8(Cr3dXDeals.DealStatus.FINANCED));
        assertEq(deal.investor, investor, "the investor comes from the proven log");
        assertEq(deal.fundedAmount, FUNDING);

        (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED));

        assertEq(credit.reservedOf(borrower), 0, "the reserve became exposure");
        assertEq(credit.exposureOf(borrower), FACE_VALUE, "exposure is the face value, not the funding");
        assertEq(credit.availableLimitOf(borrower), BASE_LIMIT - FACE_VALUE);
        assertEq(deals.outstandingOf(dealId), FACE_VALUE);
    }

    /// @notice Two short payments add up and finance the deal at the crossing.
    function test_partialFundingAccumulates() public {
        bytes32 dealId = _deal();

        _fundAndApply(dealId, investor, borrower, FUNDING / 4, ON_TIME_HEIGHT);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.CREATED), "still short of the threshold");
        assertEq(deals.getDeal(dealId).fundedAmount, FUNDING / 4);
        assertEq(credit.reservedOf(borrower), FACE_VALUE, "a partial payment does not touch the reserve");
        assertEq(credit.exposureOf(borrower), 0);

        _fundAndApply(dealId, investor, borrower, FUNDING - FUNDING / 4, ON_TIME_HEIGHT);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
        assertEq(credit.reservedOf(borrower), 0);
        assertEq(credit.exposureOf(borrower), FACE_VALUE);
    }

    /// @notice Funding a deal whose deadline has already passed is applied.
    /// @dev Mandatory case from section 9. It looks like a bug and is the whole
    ///      point: the money already moved on Sepolia, so refusing it here would
    ///      destroy it. The deal becomes an immediate default candidate instead.
    function test_fundingAnOverdueDealIsApplied() public {
        bytes32 dealId = _createDeal(borrower, investor, FUNDING, FACE_VALUE, 1_000);
        _setAttestedHeight(1_000 + GRACE_PERIOD + 1);

        _fundAndApply(dealId, investor, borrower, FUNDING, 2_000);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));

        deals.markDefaulted(dealId);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.DEFAULTED));
    }

    function test_overpaidFundingIsKeptAndTheDealIsFinancedOnce() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING * 3, ON_TIME_HEIGHT);

        assertEq(deals.getDeal(dealId).fundedAmount, FUNDING * 3, "overpayment is not refunded from here");
        assertEq(credit.exposureOf(borrower), FACE_VALUE, "exposure is the face value regardless");
    }

    function test_fundingFromAnotherAddressIsRejectedForever() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _fundAndApply(dealId, stranger, borrower, FUNDING, ON_TIME_HEIGHT);

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT));
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.WRONG_INVESTOR));
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.CREATED), "the deal is untouched");
        assertEq(deals.getDeal(dealId).fundedAmount, 0);
    }

    function test_fundingSentToTheWrongRecipientIsRejectedForever() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _fundAndApply(dealId, investor, stranger, FUNDING, ON_TIME_HEIGHT);

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT));
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.WRONG_RECIPIENT));
    }

    /// @notice Funding that arrives after the threshold is applied, not refused,
    ///         and does not finance the deal a second time.
    /// @dev The money moved on Sepolia. Refusing it here would destroy it, and
    ///      would make the funded total depend on delivery order; see the test
    ///      below. What must not happen twice is the crossing, and it does not.
    function test_fundingAFinancedDealIsStillApplied() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        bytes32 second = _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.evidenceStateOf(second);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED), "a surplus payment is still a payment");
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.NONE));

        assertEq(deals.getDeal(dealId).fundedAmount, FUNDING * 2, "the second funding is counted");
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
        assertEq(credit.exposureOf(borrower), FACE_VALUE, "and did not double the exposure");
        assertEq(credit.reservedOf(borrower), 0, "nor released the reserve twice");
    }

    /// @notice The funded total is the same whatever order the proofs arrive in.
    ///
    /// @dev The counterexample that removed `ALREADY_FUNDED`. Three payments of
    ///      60, 50 and 40 against a threshold of 100: refusing anything after the
    ///      crossing settles on 110, 150 or 100 depending only on which proof a
    ///      worker built first, and all three describe money that really moved.
    ///      Accumulating without a ceiling gives 150 every time. That is INV-3.
    function test_fundingIsIndependentOfDeliveryOrder() public {
        uint256[3] memory amounts = [uint256(60), 50, 40];
        uint256[6] memory orders = [uint256(12), 21, 102, 120, 201, 210];

        for (uint256 run = 0; run < orders.length; run++) {
            _deployCr3dX();
            bytes32 dealId = _createDeal(borrower, investor, 100, 200, DUE_BLOCK);

            bytes32[3] memory ids;
            for (uint256 i = 0; i < 3; i++) {
                ids[i] = _recordFunding(dealId, investor, borrower, amounts[i], ON_TIME_HEIGHT);
            }

            // Three digits, base 3, so every permutation is covered.
            uint256 order = orders[run];
            for (uint256 position = 0; position < 3; position++) {
                deals.applyEvidence(ids[(order / (10 ** (2 - position))) % 10]);
            }

            assertEq(deals.getDeal(dealId).fundedAmount, 150, "funded total");
            assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED), "status");
            assertEq(credit.exposureOf(borrower), 200, "exposure");
            assertEq(credit.reservedOf(borrower), 0, "reserve");
        }
    }

    /// @notice Funding for a deal that does not exist yet waits, and applies once
    ///         the deal is created.
    /// @dev The unknown deal is the case `VERIFIED_PENDING` exists for: the payer
    ///      can simply have been faster than the borrower, and nothing about the
    ///      future forbids the deal from appearing.
    function test_fundingForAnUnknownDealWaitsAndThenApplies() public {
        bytes32 dealId = deals.dealIdOf(borrower, investor, FUNDING, FACE_VALUE, DUE_BLOCK, 0);
        bytes32 evidenceId = _recordFunding(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        deals.applyEvidence(evidenceId);
        (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.VERIFIED_PENDING));

        assertEq(_deal(), dealId, "the deal the payer named");
        deals.applyEvidence(evidenceId);

        (state,) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED));
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
    }

    // ------------------------------------------------------------------
    // repayment
    // ------------------------------------------------------------------

    function test_onTimeRepaymentClosesTheDealAndRaisesTheScore() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_ON_TIME));
        assertEq(credit.exposureOf(borrower), 0, "a closed deal carries no exposure");
        assertEq(deals.outstandingOf(dealId), 0);
        assertEq(credit.scoreOf(borrower), 525);
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 525) / 500);
        assertEq(credit.availableLimitOf(borrower), (BASE_LIMIT * 525) / 500);
    }

    function test_lateRepaymentClosesTheDealAsPaidLate() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, LATE_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_LATE));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_LATE));
        assertEq(credit.scoreOf(borrower), 450);
    }

    /// @notice A payer who is not the borrower settles the debt just as well.
    function test_athirdPartyMayRepay() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, payer, investor, FACE_VALUE, ON_TIME_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
    }

    /// @notice A repayment to the right address that arrives before the funding
    ///         waits, because an unfinanced deal owes nobody anything.
    function test_repaymentBeforeFundingWaitsForTheDealToBeFinanced() public {
        bytes32 dealId = _deal();
        bytes32 repayment = _recordRepayment(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        deals.applyEvidence(repayment);
        (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(repayment);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.VERIFIED_PENDING), "the deal is not financed yet");
        assertEq(deals.getDeal(dealId).repaidAmount, 0, "and nothing was applied to it");
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.CREATED), "no closure without financing");

        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        deals.applyEvidence(repayment);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
    }

    /// @notice A repayment sent to the wrong address is refused straight away,
    ///         even before the deal is financed.
    ///
    /// @dev The recipient is checked against `designatedInvestor`, which the
    ///      deal has carried since it was created. Comparing against the
    ///      investor recorded by the funding instead would leave this payment
    ///      waiting for a fact that, when it finally arrived, would refuse it.
    ///      The two fields hold the same address once the deal is financed, so
    ///      this changes nothing after that point.
    function test_repaymentToTheWrongRecipientIsRefusedBeforeFundingToo() public {
        bytes32 dealId = _deal();
        bytes32 repayment = _recordRepayment(dealId, borrower, stranger, FACE_VALUE, ON_TIME_HEIGHT);

        deals.applyEvidence(repayment);
        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.evidenceStateOf(repayment);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT), "not left waiting");
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.WRONG_RECIPIENT));

        // Financing the deal does not revive it: the address it went to is not
        // the one the terms name, and the terms cannot change.
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        deals.applyEvidence(repayment);
        (state,) = deals.evidenceStateOf(repayment);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT));
        assertEq(deals.getDeal(dealId).repaidAmount, 0);
    }

    function test_repaymentToTheWrongRecipientIsRejectedForever() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 evidenceId = _repayAndApply(dealId, borrower, stranger, FACE_VALUE, ON_TIME_HEIGHT);

        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT));
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.WRONG_RECIPIENT));
        assertEq(deals.getDeal(dealId).repaidAmount, 0);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
    }

    /// @notice Overpayment does not drive the outstanding balance or the
    ///         exposure below zero, and does not release exposure twice.
    /// @dev Mandatory case from section 9, and the reason every subtraction in
    ///      the accounting saturates.
    function test_overpaymentDoesNotUnderflowOutstandingOrExposure() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        assertEq(credit.exposureOf(borrower), FACE_VALUE);

        _repayAndApply(dealId, borrower, investor, FACE_VALUE * 3, ON_TIME_HEIGHT);
        assertEq(deals.getDeal(dealId).repaidAmount, FACE_VALUE * 3, "the full proven amount is recorded");
        assertEq(deals.outstandingOf(dealId), 0);
        assertEq(credit.exposureOf(borrower), 0);

        // A second overpayment on an already closed deal must not release
        // anything a second time.
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);
        assertEq(credit.exposureOf(borrower), 0);
        assertEq(deals.outstandingOf(dealId), 0);
    }

    /// @notice A proven repayment applies to a deal that is already closed.
    /// @dev Mandatory case from section 9. A fact does not stop being a fact
    ///      because the outcome is written; the totals move, the reserve does not.
    function test_repaymentAppliesToAClosedDeal() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));

        uint256 reservedBefore = credit.reservedOf(borrower);
        bytes32 extra = _repayAndApply(dealId, borrower, investor, 7, LATE_HEIGHT);

        (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(extra);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED), "not ignored because the deal is closed");
        assertEq(deals.getDeal(dealId).repaidAmount, FACE_VALUE + 7);
        assertEq(credit.reservedOf(borrower), reservedBefore, "the reserve is untouched");
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME), "and the outcome does not move down");
    }

    // ------------------------------------------------------------------
    // order of delivery
    // ------------------------------------------------------------------

    /// @notice The regression scenario the specification names, in both orders.
    /// @dev This is the counterexample that exposed the contradiction between
    ///      INV-3 and INV-12: with the outcome latched by the first repayment to
    ///      cross the threshold, the two orders gave different answers. The
    ///      outcome is now derived from the accumulated totals, so they agree.
    function test_inv20LateThenOnTimeMatchesOnTimeThenLate() public {
        (uint256 repaidA, uint256 onTimeA, uint256 outstandingA, uint8 statusA, uint16 scoreA, uint256 exposureA) =
            _twoFullRepayments(true);
        (uint256 repaidB, uint256 onTimeB, uint256 outstandingB, uint8 statusB, uint16 scoreB, uint256 exposureB) =
            _twoFullRepayments(false);

        assertEq(repaidA, repaidB, "repaidAmount");
        assertEq(onTimeA, onTimeB, "onTimeRepaid");
        assertEq(outstandingA, outstandingB, "outstanding");
        assertEq(statusA, statusB, "status");
        assertEq(scoreA, scoreB, "score");
        assertEq(exposureA, exposureB, "exposure");

        assertEq(repaidA, FACE_VALUE * 2);
        assertEq(onTimeA, FACE_VALUE);
        assertEq(outstandingA, 0);
        assertEq(statusA, uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
        assertEq(exposureA, 0);
        assertEq(scoreA, 525);
    }

    /// @dev Runs the scenario on a completely fresh deployment each time, so the
    ///      two orders share no state at all.
    function _twoFullRepayments(bool lateFirst)
        private
        returns (uint256 repaid, uint256 onTime, uint256 outstanding, uint8 status, uint16 score, uint256 exposure)
    {
        _deployCr3dX();
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        bytes32 late = _recordRepayment(dealId, borrower, investor, FACE_VALUE, LATE_HEIGHT);
        bytes32 early = _recordRepayment(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        if (lateFirst) {
            deals.applyEvidence(late);
            deals.applyEvidence(early);
        } else {
            deals.applyEvidence(early);
            deals.applyEvidence(late);
        }

        Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
        return (
            deal.repaidAmount,
            deal.onTimeRepaid,
            deals.outstandingOf(dealId),
            uint8(deal.status),
            credit.scoreOf(borrower),
            credit.exposureOf(borrower)
        );
    }

    /// @notice The scenario of section 5, with the numbers the specification
    ///         writes down, in both orders.
    /// @dev The one above states the same property against the amounts this test
    ///      suite uses everywhere else. This one uses the literal figures from
    ///      the document so that the regression it names is recognisable at a
    ///      glance rather than by argument.
    function test_inv20RegressionScenarioWithTheSpecificationsOwnNumbers() public {
        uint256 faceValue = 1100;
        uint64 dueBlock = 100;

        for (uint256 run = 0; run < 2; run++) {
            _deployCr3dX();
            bytes32 dealId = _createDeal(borrower, investor, 1000, faceValue, dueBlock);
            _fundAndApply(dealId, investor, borrower, 1000, 50);

            bytes32 a = _recordRepayment(dealId, borrower, investor, faceValue, 110);
            bytes32 b = _recordRepayment(dealId, borrower, investor, faceValue, 90);
            if (run == 0) {
                deals.applyEvidence(a);
                deals.applyEvidence(b);
            } else {
                deals.applyEvidence(b);
                deals.applyEvidence(a);
            }

            Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
            assertEq(deal.repaidAmount, 2200, "repaidAmount");
            assertEq(deal.onTimeRepaid, 1100, "onTimeRepaid");
            assertEq(deals.outstandingOf(dealId), 0, "outstanding");
            assertEq(uint8(deal.status), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME), "status");
            assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_ON_TIME), "outcome");
            assertEq(credit.scoreOf(borrower), 525, "score");
            assertEq(credit.exposureOf(borrower), 0, "exposure");
            assertEq(credit.countersOf(borrower).paidOnTime, 1, "counters");
        }
    }

    /// @notice Two partial repayments delivered against the order of their block
    ///         heights land on the same state.
    /// @dev Mandatory case from section 9.
    function test_partialRepaymentsAreOrderIndependent() public {
        uint256 half = FACE_VALUE / 2;

        _deployCr3dX();
        bytes32 dealA = _deal();
        _fundAndApply(dealA, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 e1 = _recordRepayment(dealA, borrower, investor, half, ON_TIME_HEIGHT);
        bytes32 e2 = _recordRepayment(dealA, borrower, investor, FACE_VALUE - half, LATE_HEIGHT);
        deals.applyEvidence(e1);
        deals.applyEvidence(e2);
        Cr3dXDeals.Deal memory forward = deals.getDeal(dealA);
        uint16 scoreForward = credit.scoreOf(borrower);

        _deployCr3dX();
        bytes32 dealB = _deal();
        _fundAndApply(dealB, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 e3 = _recordRepayment(dealB, borrower, investor, half, ON_TIME_HEIGHT);
        bytes32 e4 = _recordRepayment(dealB, borrower, investor, FACE_VALUE - half, LATE_HEIGHT);
        deals.applyEvidence(e4);
        deals.applyEvidence(e3);
        Cr3dXDeals.Deal memory reversed = deals.getDeal(dealB);

        // The two identifiers differ, and must: `dealId` commits to the
        // registry's address so that a proof aimed at one deployment cannot be
        // replayed against another. What has to match is the resulting state.
        assertEq(forward.repaidAmount, reversed.repaidAmount);
        assertEq(forward.onTimeRepaid, reversed.onTimeRepaid);
        assertEq(uint8(forward.status), uint8(reversed.status));
        assertEq(uint8(forward.status), uint8(Cr3dXDeals.DealStatus.PAID_LATE), "half of it arrived late");
        assertEq(scoreForward, credit.scoreOf(borrower));
    }

    /// @notice A late partial payment plus a full on-time one gives PAID_ON_TIME
    ///         whichever way round they are applied.
    /// @dev Mandatory case from section 9.
    function test_latePartialAndOnTimeFullGivePaidOnTimeEitherWay() public {
        _deployCr3dX();
        bytes32 dealA = _deal();
        _fundAndApply(dealA, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 latePartial = _recordRepayment(dealA, borrower, investor, FACE_VALUE / 3, LATE_HEIGHT);
        bytes32 onTimeFull = _recordRepayment(dealA, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);
        deals.applyEvidence(latePartial);
        assertEq(uint8(_status(dealA)), uint8(Cr3dXDeals.DealStatus.FINANCED), "a third of it is not a closure");
        deals.applyEvidence(onTimeFull);
        assertEq(uint8(_status(dealA)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));

        _deployCr3dX();
        bytes32 dealB = _deal();
        _fundAndApply(dealB, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 latePartial2 = _recordRepayment(dealB, borrower, investor, FACE_VALUE / 3, LATE_HEIGHT);
        bytes32 onTimeFull2 = _recordRepayment(dealB, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);
        deals.applyEvidence(onTimeFull2);
        assertEq(uint8(_status(dealB)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
        deals.applyEvidence(latePartial2);
        assertEq(uint8(_status(dealB)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME), "and it is not refined downward");
    }

    /// @notice PAID_LATE is refined to PAID_ON_TIME, and the status moves with it.
    /// @dev Mandatory case from section 9, and the visible half of INV-21.
    function test_paidLateIsRefinedUpwardToPaidOnTime() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, LATE_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_LATE));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_LATE));
        assertEq(credit.scoreOf(borrower), 450);

        _repayAndApply(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_ON_TIME), "status and outcome move together");
        assertEq(credit.scoreOf(borrower), 525, "the late count is decremented, not merely offset");
        Cr3dXCredit.Counters memory counters = credit.countersOf(borrower);
        assertEq(counters.paidLate, 0);
        assertEq(counters.paidOnTime, 1);
    }

    /// @notice No later late payment turns PAID_ON_TIME back into PAID_LATE.
    /// @dev Mandatory case from section 9.
    function test_paidOnTimeIsNeverRefinedDownward() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        for (uint256 i = 0; i < 3; i++) {
            _repayAndApply(dealId, borrower, investor, FACE_VALUE, LATE_HEIGHT);
            assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
            assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_ON_TIME));
        }
        assertEq(credit.scoreOf(borrower), 525);
    }

    // ------------------------------------------------------------------
    // the deadline
    // ------------------------------------------------------------------

    function test_markDefaultedNeedsTheAttestedHeightPastDueBlockPlusGrace() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD);
        vm.expectRevert(
            abi.encodeWithSelector(
                Cr3dXDeals.DefaultTooEarly.selector,
                dealId,
                DUE_BLOCK + GRACE_PERIOD,
                uint256(DUE_BLOCK) + GRACE_PERIOD
            )
        );
        deals.markDefaulted(dealId);

        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);
        deals.markDefaulted(dealId);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.DEFAULTED));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.DEFAULTED));
        assertEq(credit.scoreOf(borrower), 300, "500 - 200");
        assertEq(credit.exposureOf(borrower), FACE_VALUE, "default does not release the debt");
    }

    /// @notice Default is possible from FINANCED and from nowhere else.
    /// @dev Mandatory case from section 9, and INV-22.
    function test_markDefaultedIsRejectedFromEveryOtherStatus() public {
        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);

        bytes32 created = _deal();
        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXDeals.NotDefaultable.selector, created, Cr3dXDeals.DealStatus.CREATED)
        );
        deals.markDefaulted(created);

        bytes32 onTime = _createDeal(borrower, investor, FUNDING, FACE_VALUE, DUE_BLOCK);
        _fundAndApply(onTime, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(onTime, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);
        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXDeals.NotDefaultable.selector, onTime, Cr3dXDeals.DealStatus.PAID_ON_TIME)
        );
        deals.markDefaulted(onTime);

        bytes32 late = _createDeal(borrower, investor, FUNDING, FACE_VALUE, DUE_BLOCK);
        _fundAndApply(late, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _repayAndApply(late, borrower, investor, FACE_VALUE, LATE_HEIGHT);
        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXDeals.NotDefaultable.selector, late, Cr3dXDeals.DealStatus.PAID_LATE)
        );
        deals.markDefaulted(late);

        bytes32 unknown = keccak256("no such deal");
        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXDeals.NotDefaultable.selector, unknown, Cr3dXDeals.DealStatus.NONE)
        );
        deals.markDefaulted(unknown);
    }

    function test_markDefaultedTwiceIsRefused() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);
        deals.markDefaulted(dealId);

        vm.expectRevert(
            abi.encodeWithSelector(Cr3dXDeals.NotDefaultable.selector, dealId, Cr3dXDeals.DealStatus.DEFAULTED)
        );
        deals.markDefaulted(dealId);
        assertEq(credit.scoreOf(borrower), 300, "and the penalty is not applied twice");
    }

    /// @notice A defaulted deal that is repaid late becomes PAID_LATE.
    /// @dev Tested but never demonstrated: section 9 keeps this out of the demo.
    function test_defaultedIsRefinedToPaidLate() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);
        deals.markDefaulted(dealId);
        assertEq(credit.scoreOf(borrower), 300);

        _repayAndApply(dealId, borrower, investor, FACE_VALUE, LATE_HEIGHT);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_LATE));
        assertEq(uint8(credit.outcomeOf(dealId)), uint8(Result.PAID_LATE));
        assertEq(credit.scoreOf(borrower), 450, "the default is withdrawn, not offset");
        Cr3dXCredit.Counters memory counters = credit.countersOf(borrower);
        assertEq(counters.defaulted, 0);
        assertEq(counters.paidLate, 1);
        assertEq(credit.exposureOf(borrower), 0);
    }

    /// @notice A defaulted deal whose on-time payment surfaces later becomes
    ///         PAID_ON_TIME.
    /// @dev This is what makes the grace period a cosmetic guard rather than a
    ///      correctness one: even a deal that already defaulted is corrected by
    ///      a proof that the money arrived in time.
    function test_defaultedIsRefinedToPaidOnTime() public {
        bytes32 dealId = _deal();
        _fundAndApply(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);
        bytes32 repayment = _recordRepayment(dealId, borrower, investor, FACE_VALUE, ON_TIME_HEIGHT);

        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);
        deals.markDefaulted(dealId);
        assertEq(credit.scoreOf(borrower), 300);

        deals.applyEvidence(repayment);

        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME));
        assertEq(credit.scoreOf(borrower), 525);
    }

    /// @notice Exposure above the limit does not overflow anything.
    /// @dev Mandatory case from section 9. A default cuts the limit while the
    ///      debt stays, so used credit legitimately exceeds it.
    function test_exposureAboveTheLimitSaturates() public {
        uint256 half = BASE_LIMIT / 2;
        bytes32 first = _createDeal(borrower, investor, half / 2, half, DUE_BLOCK);
        bytes32 second = _createDeal(borrower, investor, half / 2, half, DUE_BLOCK);
        _fundAndApply(first, investor, borrower, half / 2, ON_TIME_HEIGHT);
        _fundAndApply(second, investor, borrower, half / 2, ON_TIME_HEIGHT);
        assertEq(credit.exposureOf(borrower), BASE_LIMIT);

        _setAttestedHeight(DUE_BLOCK + GRACE_PERIOD + 1);
        deals.markDefaulted(first);

        assertEq(credit.scoreOf(borrower), 300);
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 300) / 500);
        assertLt(credit.limitOf(borrower), credit.usedLimitOf(borrower), "used credit is above the limit");
        assertEq(credit.availableLimitOf(borrower), 0, "and that is zero available, not a revert");
    }

    // ------------------------------------------------------------------
    // evidence handling
    // ------------------------------------------------------------------

    /// @notice One transaction carrying two gateway events produces two facts,
    ///         and both are applied.
    /// @dev Mandatory case from section 9, and the reason the evidence identifier
    ///      carries the gateway's own event counter.
    function test_oneTransactionWithTwoEventsProducesTwoApplications() public {
        bytes32 dealId = _deal();

        ProvenLog[] memory logs = new ProvenLog[](2);
        logs[0] = GateLog.funding(address(gateway), dealId, investor, borrower, FUNDING / 2, nextEventNonce++);
        logs[1] = GateLog.funding(address(gateway), dealId, investor, borrower, FUNDING / 2, nextEventNonce++);

        bytes32[] memory ids = _submitAndApply(logs, ON_TIME_HEIGHT);

        assertEq(ids.length, 2, "two events, two facts");
        assertTrue(ids[0] != ids[1], "and two distinct identifiers");
        for (uint256 i = 0; i < ids.length; i++) {
            (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(ids[i]);
            assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.APPLIED));
        }
        assertEq(deals.getDeal(dealId).fundedAmount, FUNDING);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
    }

    function test_applyingTheSameEvidenceTwiceChangesNothing() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _fundAndApply(dealId, investor, borrower, FUNDING / 2, ON_TIME_HEIGHT);

        uint256 fundedOnce = deals.getDeal(dealId).fundedAmount;
        deals.applyEvidence(evidenceId);
        deals.applyEvidence(evidenceId);
        assertEq(deals.getDeal(dealId).fundedAmount, fundedOnce, "the amount is counted once");
    }

    function test_applyingEvidenceTheVerifierNeverSawReverts() public {
        bytes32 unknown = keccak256("never proven");
        vm.expectRevert(abi.encodeWithSelector(Cr3dXDeals.UnknownEvidence.selector, unknown));
        deals.applyEvidence(unknown);
    }

    function test_evidenceStateOfAnUnknownIdentifierIsUnseen() public view {
        (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) =
            deals.evidenceStateOf(keccak256("nothing"));
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.UNSEEN));
        assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.NONE));
    }

    /// @notice A fact submitted straight to the verifier reaches the registry
    ///         through `applyEvidence`, with the same result.
    function test_theTwoSubmissionPathsAgree() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _recordFunding(dealId, investor, borrower, FUNDING, ON_TIME_HEIGHT);

        assertTrue(verifier.seen(evidenceId), "the verifier has the fact");
        (Cr3dXDeals.EvidenceState state,) = deals.evidenceStateOf(evidenceId);
        assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.VERIFIED_PENDING), "the registry has not seen it yet");

        deals.applyEvidence(evidenceId);
        assertEq(uint8(_status(dealId)), uint8(Cr3dXDeals.DealStatus.FINANCED));
    }

    /// @notice A rejected fact stays rejected however often it is retried.
    function test_aPermanentRejectionIsNeverRevisited() public {
        bytes32 dealId = _deal();
        bytes32 evidenceId = _fundAndApply(dealId, stranger, borrower, FUNDING, ON_TIME_HEIGHT);

        for (uint256 i = 0; i < 3; i++) {
            (Cr3dXDeals.EvidenceState state, Cr3dXDeals.RejectionReason reason) = deals.applyEvidence(evidenceId);
            assertEq(uint8(state), uint8(Cr3dXDeals.EvidenceState.REJECTED_PERMANENT));
            assertEq(uint8(reason), uint8(Cr3dXDeals.RejectionReason.WRONG_INVESTOR));
        }
        assertEq(deals.getDeal(dealId).fundedAmount, 0);
    }

    // ------------------------------------------------------------------
    // what the system refuses to be
    // ------------------------------------------------------------------

    /// @notice Nobody can write to the credit layer except the registry.
    /// @dev INV-7. The registry deployed the credit layer, so `deals` was fixed
    ///      at construction and there is no setter to point it elsewhere.
    function test_onlyTheRegistryMayWriteToTheCreditLayer() public {
        bytes32 dealId = _deal();

        address[2] memory callers = [address(this), stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.NotDeals.selector, callers[i]));
            credit.openDeal(keccak256("mine"), borrower, 1);
            vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.NotDeals.selector, callers[i]));
            credit.markFinanced(dealId);
            vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.NotDeals.selector, callers[i]));
            credit.reduceExposure(dealId, 1);
            vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.NotDeals.selector, callers[i]));
            credit.recordOutcome(dealId, Result.PAID_ON_TIME);
            vm.stopPrank();
        }
    }

    /// @notice There are exactly two permanent reasons, and no third.
    /// @dev INV-19. The specification says a third may not be added quietly:
    ///      first the gap in the document is recorded, then the reason. This
    ///      test is what makes "quietly" impossible. It also pins the numbering,
    ///      which the removal of `ALREADY_FUNDED` shifted: anything decoding the
    ///      reason off chain has to move with it.
    function test_thereAreExactlyTwoPermanentReasons() public pure {
        assertEq(uint8(type(Cr3dXDeals.RejectionReason).max), 2, "a reason was added or removed");
        assertEq(uint8(Cr3dXDeals.RejectionReason.NONE), 0);
        assertEq(uint8(Cr3dXDeals.RejectionReason.WRONG_INVESTOR), 1);
        assertEq(uint8(Cr3dXDeals.RejectionReason.WRONG_RECIPIENT), 2);
    }

    /// @notice The credit layer belongs to the registry that deployed it.
    function test_theCreditLayerIsPairedAtDeployment() public view {
        assertEq(credit.deals(), address(deals));
        assertEq(credit.chainKey(), CHAIN_KEY);
        assertEq(credit.baseLimit(), BASE_LIMIT);
        assertEq(deals.chainKey(), verifier.chainKey(), "the source chain is read from the verifier");
    }
}
