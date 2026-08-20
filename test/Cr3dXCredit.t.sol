// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Cr3dXCredit, Result} from "../contracts/Cr3dXCredit.sol";
import {Attestcoin} from "../contracts/libraries/Attestcoin.sol";
import {MockChainInfo} from "./helpers/MockChainInfo.sol";

/// @title Cr3dXCreditTest
/// @notice The credit arithmetic on its own: score, limit, reserve, exposure.
///
/// @dev **This test contract is the registry.** `Cr3dXCredit` takes `msg.sender`
///      as the only address allowed to write to it, so a test that deploys it
///      directly holds that role and can drive the accounting without going
///      through a deal. That is the point of testing it here: the arithmetic is
///      worth exercising at every awkward value, and reaching those values
///      through proven Sepolia events would take hundreds of transactions to
///      say something that is not about proofs at all.
///
///      The end-to-end pairing, where the registry deploys this contract and
///      nobody else can write to it, is covered in `Cr3dXDeals.t.sol`.
contract Cr3dXCreditTest is Test {
    uint64 internal constant CHAIN_KEY = 1;
    uint256 internal constant BASE_LIMIT = 5_000_000_000;
    uint64 internal constant HEIGHT = 11_500_000;

    Cr3dXCredit internal credit;
    address internal borrower = makeAddr("borrower");
    address internal other = makeAddr("other");

    function setUp() public {
        vm.etch(address(Attestcoin.CHAIN_INFO), address(new MockChainInfo()).code);
        _chainInfo().setAttestedHeight(CHAIN_KEY, HEIGHT);
        credit = new Cr3dXCredit(BASE_LIMIT, CHAIN_KEY);
    }

    function _chainInfo() internal pure returns (MockChainInfo) {
        return MockChainInfo(address(Attestcoin.CHAIN_INFO));
    }

    /// @dev Opens `count` deals of one unit each and closes them with `result`.
    function _outcomes(Result result, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            bytes32 dealId = keccak256(abi.encode(result, i, block.number));
            credit.openDeal(dealId, borrower, 1);
            credit.recordOutcome(dealId, result);
        }
    }

    // ------------------------------------------------------------------
    // score
    // ------------------------------------------------------------------

    function test_aBorrowerWithNoHistoryStartsAtTheBaseScore() public view {
        assertEq(credit.scoreOf(borrower), 500);
        assertEq(credit.scoreFromOutcomes(borrower), 500);
        assertEq(credit.limitOf(borrower), BASE_LIMIT);
        assertEq(credit.availableLimitOf(borrower), BASE_LIMIT);
        assertEq(credit.reservedOf(borrower), 0);
        assertEq(credit.exposureOf(borrower), 0);
    }

    function test_eachOutcomeMovesTheScoreByItsWeight() public {
        _outcomes(Result.PAID_ON_TIME, 1);
        assertEq(credit.scoreOf(borrower), 525);
        _outcomes(Result.PAID_LATE, 1);
        assertEq(credit.scoreOf(borrower), 475);
        _outcomes(Result.DEFAULTED, 1);
        assertEq(credit.scoreOf(borrower), 300, "500 + 25 - 50 - 200 = 275, floored at 300");
    }

    function test_theScoreIsCappedAtTheCeiling() public {
        _outcomes(Result.PAID_ON_TIME, 20);
        assertEq(credit.scoreOf(borrower), 850, "500 + 500 = 1000, capped at 850");
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 850) / 500);
    }

    /// @notice The clamp is applied once, to the finished sum.
    ///
    /// @dev The test that distinguishes the two implementations. Three defaults
    ///      and eight on-time repayments sum to 500 - 600 + 200 = 100, which the
    ///      floor lifts to 300. An implementation that clamped after every
    ///      outcome would have parked at 300 after the defaults and then climbed
    ///      to 500, so the same eleven outcomes would produce two different
    ///      scores depending on the order they arrived in. That is INV-5.
    function test_theClampIsAppliedOnceToTheFinishedSum() public {
        _outcomes(Result.DEFAULTED, 3);
        assertEq(credit.scoreOf(borrower), 300);
        _outcomes(Result.PAID_ON_TIME, 8);
        assertEq(credit.scoreOf(borrower), 300, "stepwise clamping would have said 500 here");
    }

    /// @notice The score does not depend on the order the outcomes arrived in.
    function testFuzz_theScoreIsIndependentOfOutcomeOrder(uint8[16] calldata raw) public {
        Result[16] memory outcomes;
        for (uint256 i = 0; i < raw.length; i++) {
            outcomes[i] = Result(uint8(1 + (raw[i] % 3)));
        }

        for (uint256 i = 0; i < outcomes.length; i++) {
            bytes32 dealId = keccak256(abi.encode("forward", i));
            credit.openDeal(dealId, borrower, 1);
            credit.recordOutcome(dealId, outcomes[i]);
        }
        uint16 forward = credit.scoreOf(borrower);

        for (uint256 i = outcomes.length; i > 0; i--) {
            bytes32 dealId = keccak256(abi.encode("reverse", i));
            credit.openDeal(dealId, other, 1);
            credit.recordOutcome(dealId, outcomes[i - 1]);
        }
        uint16 reverse = credit.scoreOf(other);

        assertEq(forward, reverse);
        assertEq(forward, credit.scoreFromOutcomes(borrower), "counters agree with the canonical records");
        assertEq(reverse, credit.scoreFromOutcomes(other));
    }

    /// @notice The cached counters always agree with a full recomputation.
    /// @dev INV-5, including after refinements, which are where a cache is most
    ///      likely to drift.
    function test_countersAgreeWithTheCanonicalRecordsAfterRefinement() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        credit.openDeal(a, borrower, 1);
        credit.openDeal(b, borrower, 1);

        credit.recordOutcome(a, Result.DEFAULTED);
        credit.recordOutcome(b, Result.PAID_LATE);
        assertEq(credit.scoreOf(borrower), credit.scoreFromOutcomes(borrower));

        credit.recordOutcome(a, Result.PAID_ON_TIME);
        credit.recordOutcome(b, Result.PAID_ON_TIME);

        Cr3dXCredit.Counters memory counters = credit.countersOf(borrower);
        assertEq(counters.paidOnTime, 2);
        assertEq(counters.paidLate, 0);
        assertEq(counters.defaulted, 0);
        assertEq(credit.scoreOf(borrower), 550);
        assertEq(credit.scoreOf(borrower), credit.scoreFromOutcomes(borrower));
    }

    function test_recordingTheSameOutcomeTwiceChangesNothing() public {
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1);
        credit.recordOutcome(dealId, Result.PAID_ON_TIME);
        uint64 firstStamp = credit.recordOf(dealId).closedAtBlock;

        _chainInfo().setAttestedHeight(CHAIN_KEY, HEIGHT + 5_000);
        credit.recordOutcome(dealId, Result.PAID_ON_TIME);

        assertEq(credit.countersOf(borrower).paidOnTime, 1);
        assertEq(credit.scoreOf(borrower), 525);
        assertEq(
            credit.recordOf(dealId).closedAtBlock,
            firstStamp,
            "an unchanged outcome must not move its audit stamp"
        );
    }

    function test_anOutcomeIsStampedWithTheAttestedSourceHeight() public {
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1);
        credit.recordOutcome(dealId, Result.DEFAULTED);
        assertEq(credit.recordOf(dealId).closedAtBlock, HEIGHT);

        // A refinement happened later, and the stamp says so.
        _chainInfo().setAttestedHeight(CHAIN_KEY, HEIGHT + 5_000);
        credit.recordOutcome(dealId, Result.PAID_LATE);
        assertEq(credit.recordOf(dealId).closedAtBlock, HEIGHT + 5_000);
    }

    function test_anOutcomeCannotBeCleared() public {
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.OutcomeCannotBeCleared.selector, dealId));
        credit.recordOutcome(dealId, Result.NONE);
    }

    /// @notice A source chain with no attested height yet stops an outcome
    ///         rather than stamping it with zero.
    function test_anOutcomeNeedsAnAttestedHeight() public {
        _chainInfo().clearAttestedHeight(CHAIN_KEY);
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.NoAttestedHeight.selector, CHAIN_KEY));
        credit.recordOutcome(dealId, Result.PAID_ON_TIME);
    }

    // ------------------------------------------------------------------
    // reserve, exposure and the limit
    // ------------------------------------------------------------------

    function test_theReserveBecomesExposureExactlyOnce() public {
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1_000);
        assertEq(credit.reservedOf(borrower), 1_000);
        assertEq(credit.usedLimitOf(borrower), 1_000);

        credit.markFinanced(dealId);
        assertEq(credit.reservedOf(borrower), 0);
        assertEq(credit.exposureOf(borrower), 1_000);
        assertEq(credit.usedLimitOf(borrower), 1_000, "conversion, not release");

        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.DealAlreadyFinanced.selector, dealId));
        credit.markFinanced(dealId);
    }

    function test_exposureReductionSaturates() public {
        bytes32 dealId = keccak256("a");
        credit.openDeal(dealId, borrower, 1_000);
        credit.markFinanced(dealId);

        credit.reduceExposure(dealId, 400);
        assertEq(credit.exposureOf(borrower), 600);
        credit.reduceExposure(dealId, type(uint256).max);
        assertEq(credit.exposureOf(borrower), 0, "floored, not reverted");
    }

    function test_theLimitTracksTheScore() public {
        _outcomes(Result.PAID_ON_TIME, 2);
        assertEq(credit.scoreOf(borrower), 550);
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 550) / 500);

        _outcomes(Result.DEFAULTED, 2);
        assertEq(credit.scoreOf(borrower), 300);
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 300) / 500);
    }

    function test_availableLimitSaturatesWhenExposureExceedsTheLimit() public {
        // Everything is opened while the score is still the base one, because a
        // default cuts the limit and would block the opening otherwise. That
        // ordering is the realistic one: the debt is taken on first and the
        // score falls afterwards.
        bytes32 big = keccak256("big");
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");
        credit.openDeal(big, borrower, 4_000_000_000);
        credit.openDeal(first, borrower, 1);
        credit.openDeal(second, borrower, 1);
        credit.markFinanced(big);
        credit.markFinanced(first);
        credit.markFinanced(second);

        credit.recordOutcome(first, Result.DEFAULTED);
        credit.recordOutcome(second, Result.DEFAULTED);

        assertEq(credit.scoreOf(borrower), 300);
        assertEq(credit.limitOf(borrower), (BASE_LIMIT * 300) / 500);
        assertGt(credit.usedLimitOf(borrower), credit.limitOf(borrower), "the debt outlived the limit");
        assertEq(credit.availableLimitOf(borrower), 0, "and that is zero available, not a revert");
    }

    function test_openingBeyondTheAvailableLimitIsRefused() public {
        credit.openDeal(keccak256("a"), borrower, BASE_LIMIT);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.ExceedsAvailableLimit.selector, borrower, 1, 0));
        credit.openDeal(keccak256("b"), borrower, 1);
    }

    function test_openingTheSameDealTwiceIsRefused() public {
        credit.openDeal(keccak256("a"), borrower, 1);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.DealAlreadyOpen.selector, keccak256("a")));
        credit.openDeal(keccak256("a"), borrower, 1);
    }

    function test_unknownDealsAreRefusedEverywhere() public {
        bytes32 unknown = keccak256("nothing");
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.UnknownDeal.selector, unknown));
        credit.markFinanced(unknown);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.UnknownDeal.selector, unknown));
        credit.reduceExposure(unknown, 1);
        vm.expectRevert(abi.encodeWithSelector(Cr3dXCredit.UnknownDeal.selector, unknown));
        credit.recordOutcome(unknown, Result.PAID_ON_TIME);
    }

    function test_theDealListIsTheAuditTrail() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        credit.openDeal(a, borrower, 1);
        credit.openDeal(b, borrower, 1);

        bytes32[] memory list = credit.dealsOf(borrower);
        assertEq(list.length, 2);
        assertEq(list[0], a, "creation order is preserved");
        assertEq(list[1], b);
        assertEq(credit.dealCountOf(borrower), 2);
        assertEq(credit.recordOf(a).borrower, borrower);
        assertEq(credit.recordOf(a).faceValue, 1);
    }
}
