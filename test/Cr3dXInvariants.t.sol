// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {Cr3dXCredit, Result} from "../contracts/Cr3dXCredit.sol";
import {Cr3dXDeals} from "../contracts/Cr3dXDeals.sol";
import {Cr3dXHandler} from "./helpers/Cr3dXHandler.sol";
import {Cr3dXHarness} from "./helpers/Cr3dXHarness.sol";

/// @title Cr3dXInvariantsTest
/// @notice The properties that have to hold after any sequence of anything the
///         system permits.
///
/// @dev These are the invariants of section 5 of the specification, restated as
///      things a fuzzer can break. They are stated over the whole deployment
///      rather than over one deal, because most of the ways the accounting can
///      go wrong show up as a borrower-level total that no longer matches the
///      deals it was built from.
///
///      The sequences come from `Cr3dXHandler`, which also carries an
///      independent tally of what every applied fact should have contributed.
///      Several invariants compare the registry to that tally rather than to
///      itself, which is what makes double counting visible.
contract Cr3dXInvariantsTest is Cr3dXHarness {
    Cr3dXHandler internal handler;

    function setUp() public {
        _deployCr3dX();
        _setAttestedHeight(11_500_000);
        handler = new Cr3dXHandler(deals, verifier, address(gateway));
        targetContract(address(handler));
    }

    /// @dev Runs once at the end of every campaign. Its job is to notice a
    ///      suite that has quietly become vacuous: invariants over a system
    ///      nothing ever reached would pass forever while checking nothing. The
    ///      counts are printed under `-vv` and the state distribution is
    ///      asserted to be non-trivial.
    function afterInvariant() public view {
        uint256 financed;
        uint256 defaulted;
        uint256 closed;
        for (uint256 i = 0; i < handler.dealCount(); i++) {
            Cr3dXDeals.DealStatus status = deals.getDeal(handler.dealIds(i)).status;
            if (status == Cr3dXDeals.DealStatus.FINANCED) {
                financed++;
            } else if (status == Cr3dXDeals.DealStatus.DEFAULTED) {
                defaulted++;
            } else if (
                status == Cr3dXDeals.DealStatus.PAID_LATE || status == Cr3dXDeals.DealStatus.PAID_ON_TIME
            ) {
                closed++;
            }
        }
        console2.log("deals", handler.dealCount());
        console2.log("applied", handler.appliedCount());
        console2.log("rejected", handler.rejectedCount());
        console2.log("financed / defaulted / closed", financed, defaulted, closed);
        assertGt(handler.appliedCount(), 0, "the campaign applied no evidence at all");
        assertGt(financed + defaulted + closed, 0, "the campaign never financed a deal");
    }

    /// @notice INV-9. Exposure is the outstanding debt of the deals that are
    ///         still carrying debt, and of no others.
    function invariant_exposureIsTheOutstandingDebtOfOpenDeals() public view {
        for (uint256 b = 0; b < 3; b++) {
            address borrower = handler.borrowers(b);
            uint256 expected;
            for (uint256 i = 0; i < handler.dealCount(); i++) {
                bytes32 dealId = handler.dealIds(i);
                Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
                if (deal.borrower != borrower) continue;
                if (
                    deal.status == Cr3dXDeals.DealStatus.FINANCED
                        || deal.status == Cr3dXDeals.DealStatus.DEFAULTED
                ) {
                    expected += deals.outstandingOf(dealId);
                }
            }
            assertEq(credit.exposureOf(borrower), expected, "exposure");
        }
    }

    /// @notice INV-13. The reserve is exactly the face value of the deals that
    ///         have not been financed, so one limit cannot secure two deals.
    function invariant_reserveIsTheFaceValueOfUnfinancedDeals() public view {
        for (uint256 b = 0; b < 3; b++) {
            address borrower = handler.borrowers(b);
            uint256 expected;
            for (uint256 i = 0; i < handler.dealCount(); i++) {
                bytes32 dealId = handler.dealIds(i);
                Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
                if (deal.borrower != borrower) continue;
                if (deal.status == Cr3dXDeals.DealStatus.CREATED) expected += deal.faceValue;
            }
            assertEq(credit.reservedOf(borrower), expected, "reserve");
        }
    }

    /// @notice INV-5. The counter cache and the canonical outcomes agree.
    function invariant_theScoreCacheMatchesTheCanonicalRecords() public view {
        for (uint256 b = 0; b < 3; b++) {
            address borrower = handler.borrowers(b);
            assertEq(credit.scoreOf(borrower), credit.scoreFromOutcomes(borrower), "score");
        }
    }

    /// @notice INV-4, INV-12, INV-21. The status, the credit outcome and the
    ///         accumulated totals always say the same thing.
    function invariant_statusOutcomeAndTotalsNeverDiverge() public view {
        for (uint256 i = 0; i < handler.dealCount(); i++) {
            bytes32 dealId = handler.dealIds(i);
            Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
            Result outcome = credit.outcomeOf(dealId);

            if (deal.status == Cr3dXDeals.DealStatus.CREATED) {
                assertLt(deal.fundedAmount, deal.requiredFunding, "created deal above its funding threshold");
                assertEq(deal.investor, address(0), "created deal with an investor");
                assertEq(uint8(outcome), uint8(Result.NONE), "created deal with an outcome");
            } else if (deal.status == Cr3dXDeals.DealStatus.FINANCED) {
                assertGe(deal.fundedAmount, deal.requiredFunding, "financed below the threshold");
                assertTrue(deal.investor != address(0), "financed without an investor");
                assertLt(deal.repaidAmount, deal.faceValue, "financed while fully repaid");
                assertEq(uint8(outcome), uint8(Result.NONE), "financed deal with an outcome");
            } else if (deal.status == Cr3dXDeals.DealStatus.DEFAULTED) {
                assertLt(deal.repaidAmount, deal.faceValue, "defaulted while fully repaid");
                assertEq(uint8(outcome), uint8(Result.DEFAULTED), "defaulted without the outcome");
            } else if (deal.status == Cr3dXDeals.DealStatus.PAID_LATE) {
                assertGe(deal.repaidAmount, deal.faceValue, "paid late without covering the face value");
                assertLt(deal.onTimeRepaid, deal.faceValue, "paid late while the on-time total covers it");
                assertEq(uint8(outcome), uint8(Result.PAID_LATE), "paid late without the outcome");
            } else {
                assertEq(uint8(deal.status), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME), "unknown status");
                assertGe(
                    deal.onTimeRepaid, deal.faceValue, "paid on time without an on-time total covering it"
                );
                assertEq(uint8(outcome), uint8(Result.PAID_ON_TIME), "paid on time without the outcome");
            }

            // INV-12 the other way round: an on-time total that covers the face
            // value is exactly what PAID_ON_TIME means.
            if (deal.onTimeRepaid >= deal.faceValue) {
                assertEq(
                    uint8(deal.status), uint8(Cr3dXDeals.DealStatus.PAID_ON_TIME), "on time but not closed"
                );
            }
            assertLe(deal.onTimeRepaid, deal.repaidAmount, "on-time total above the total");
        }
    }

    /// @notice INV-2 and INV-17. Every accumulated total is the sum of the facts
    ///         that were applied, each counted exactly once.
    function invariant_totalsMatchTheIndependentTally() public view {
        for (uint256 i = 0; i < handler.dealCount(); i++) {
            bytes32 dealId = handler.dealIds(i);
            Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
            assertEq(deal.fundedAmount, handler.ghostFunded(dealId), "funded total");
            assertEq(deal.repaidAmount, handler.ghostRepaid(dealId), "repaid total");
            assertEq(deal.onTimeRepaid, handler.ghostOnTime(dealId), "on-time total");
        }
    }

    /// @notice Outstanding debt is a saturating difference and never wraps.
    function invariant_outstandingNeverWraps() public view {
        for (uint256 i = 0; i < handler.dealCount(); i++) {
            bytes32 dealId = handler.dealIds(i);
            Cr3dXDeals.Deal memory deal = deals.getDeal(dealId);
            uint256 outstanding = deals.outstandingOf(dealId);
            assertLe(outstanding, deal.faceValue, "outstanding above the face value");
            if (deal.repaidAmount >= deal.faceValue) {
                assertEq(outstanding, 0, "overpayment left debt behind");
            }
        }
    }

    /// @notice INV-10, read from the other side: what a borrower may still
    ///         commit is the limit minus what they have committed, floored.
    function invariant_availableLimitIsTheSaturatedRemainder() public view {
        for (uint256 b = 0; b < 3; b++) {
            address borrower = handler.borrowers(b);
            uint256 limit = credit.limitOf(borrower);
            uint256 used = credit.usedLimitOf(borrower);
            uint256 expected = limit > used ? limit - used : 0;
            assertEq(credit.availableLimitOf(borrower), expected, "available limit");
            assertGe(credit.scoreOf(borrower), credit.MIN_SCORE(), "score below the floor");
            assertLe(credit.scoreOf(borrower), credit.MAX_SCORE(), "score above the ceiling");
        }
    }

    /// @notice INV-6. Paying in instalments never scores better than paying at
    ///         once, because the outcome is derived from the totals and the
    ///         totals do not care how many transfers carried them.
    /// @dev Stated here as a fuzz property rather than as a stateful invariant:
    ///      it compares two runs, which a single sequence cannot express.
    function testFuzz_splittingAPaymentDoesNotRaiseTheScore(uint8 pieces, uint64 heightSeed) public {
        uint256 parts = bound(pieces, 2, 8);
        uint64 height = uint64(bound(heightSeed, 11_400_000, 11_700_000));

        uint256 whole = _runOnePayment(1, height);
        uint256 split = _runOnePayment(parts, height);
        assertEq(split, whole, "instalments changed the score");
    }

    /// @dev Repays one deal in `parts` equal instalments and returns the score.
    function _runOnePayment(uint256 parts, uint64 height) private returns (uint256) {
        _deployCr3dX();
        address borrower = makeAddr("split-borrower");
        address investor = makeAddr("split-investor");
        uint64 dueBlock = 11_600_000;
        uint256 funding = 1_000_000_000;
        uint256 faceValue = 1_100_000_000;

        bytes32 dealId = _createDeal(borrower, investor, funding, faceValue, dueBlock);
        _fundAndApply(dealId, investor, borrower, funding, 11_500_000);

        // The last instalment carries the remainder, so the totals are equal
        // whatever `parts` is.
        uint256 each = faceValue / parts;
        for (uint256 i = 0; i < parts; i++) {
            uint256 amount = i + 1 == parts ? faceValue - each * (parts - 1) : each;
            _repayAndApply(dealId, borrower, investor, amount, height);
        }

        assertEq(deals.getDeal(dealId).repaidAmount, faceValue, "the instalments did not add up");
        return credit.scoreOf(borrower);
    }
}
