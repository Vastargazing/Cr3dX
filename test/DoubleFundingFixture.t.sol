// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cr3dXGateway} from "../contracts/Cr3dXGateway.sol";
import {DoubleFundingFixture} from "./helpers/DoubleFundingFixture.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

/// @title DoubleFundingFixtureTest
/// @notice Checks that the fixture contract produces the transaction shape the
///         verifier stage needs, before it is deployed to a live network.
///
/// @dev Deploying a helper to Sepolia and discovering afterwards that its
///      transaction does not contain what was wanted costs an attestation cycle
///      to find out. The shape is cheap to assert here.
contract DoubleFundingFixtureTest is Test {
    Cr3dXGateway internal gateway;
    DoubleFundingFixture internal fixture;
    MockERC20 internal token;

    address internal investor = makeAddr("investor");
    address internal borrower = makeAddr("borrower");

    bytes32 internal constant DEAL_ID = keccak256("deal-double");
    uint256 internal constant FIRST = 400_000_000;
    uint256 internal constant SECOND = 600_000_000;

    event FundingMade(
        bytes32 indexed dealId,
        address indexed investor,
        address indexed borrower,
        uint256 amount,
        uint256 nonce
    );

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        gateway = new Cr3dXGateway(IERC20(address(token)));
        fixture = new DoubleFundingFixture(gateway);
        token.mint(investor, FIRST + SECOND);
        vm.prank(investor);
        token.approve(address(fixture), FIRST + SECOND);
    }

    /// @notice One transaction carries two genuine gateway fundings and one impostor.
    function test_producesTwoGenuineFundingsAndOneImpostor() public {
        vm.recordLogs();
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL_ID, borrower, FIRST, SECOND);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 genuine;
        uint256 impostor;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != FundingMade.selector) continue;
            if (logs[i].emitter == address(gateway)) genuine++;
            else if (logs[i].emitter == address(fixture)) impostor++;
        }

        assertEq(genuine, 2, "two genuine gateway fundings");
        assertEq(impostor, 1, "one counterfeit from a lookalike contract");
    }

    /// @notice The counterfeit is indistinguishable from the real thing except by emitter.
    /// @dev If this ever stops holding, the fixture stops testing what it exists
    ///      to test, and the emitter check would pass for the wrong reason.
    function test_counterfeitIsIdenticalExceptForTheEmitter() public {
        vm.recordLogs();
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL_ID, borrower, FIRST, SECOND);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory real;
        Vm.Log memory fake;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != FundingMade.selector) continue;
            if (logs[i].emitter == address(gateway)) real = logs[i];
            else fake = logs[i];
        }

        assertEq(fake.topics[0], real.topics[0], "same topic0");
        assertEq(fake.topics.length, real.topics.length, "same number of indexed parameters");
        assertEq(fake.topics[1], real.topics[1], "same dealId");
        assertEq(fake.data.length, real.data.length, "same data layout");
        assertTrue(fake.emitter != real.emitter, "only the emitter separates them");
    }

    /// @notice Both genuine events name the same deal and differ only by nonce.
    /// @dev This is the property the evidence identifier scheme exists for. Two
    ///      events of different kinds would differ by kind as well, and the test
    ///      would pass even if the nonce were ignored.
    function test_bothFundingsShareTheDealAndDifferOnlyByNonce() public {
        vm.recordLogs();
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL_ID, borrower, FIRST, SECOND);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256[] memory nonces = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        uint256 k;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(gateway)) continue;
            if (logs[i].topics[0] != FundingMade.selector) continue;
            assertEq(logs[i].topics[1], DEAL_ID, "both fundings must name the same deal");
            assertEq(
                address(uint160(uint256(logs[i].topics[3]))), borrower, "both must pay the same borrower"
            );
            (amounts[k], nonces[k]) = abi.decode(logs[i].data, (uint256, uint256));
            k++;
        }
        assertEq(k, 2, "two gateway fundings");
        assertTrue(nonces[0] != nonces[1], "the nonces must differ");
        assertEq(amounts[0], FIRST, "first amount");
        assertEq(amounts[1], SECOND, "second amount");
    }

    /// @notice The investor in both events is the fixture contract, not the caller.
    /// @dev Recorded here so that nobody reading this fixture at the deals stage
    ///      concludes the accounting is broken. The gateway records `msg.sender`
    ///      on purpose, and for this transaction `msg.sender` is the helper.
    function test_investorInTheEventsIsTheFixtureContract() public {
        vm.recordLogs();
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL_ID, borrower, FIRST, SECOND);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(gateway)) continue;
            address loggedInvestor = address(uint160(uint256(logs[i].topics[2])));
            assertEq(loggedInvestor, address(fixture), "investor is the calling contract");
            assertTrue(loggedInvestor != investor, "and deliberately not the externally owned account");
        }
    }

    /// @notice The gateway keeps nothing, and neither does the helper.
    function test_allTokensReachTheBorrower() public {
        vm.prank(investor);
        fixture.emitTwoFundingsAndOneImpostor(DEAL_ID, borrower, FIRST, SECOND);

        assertEq(token.balanceOf(borrower), FIRST + SECOND, "borrower receives everything");
        assertEq(token.balanceOf(address(gateway)), 0, "gateway holds nothing");
        assertEq(token.balanceOf(address(fixture)), 0, "helper holds nothing");
    }
}
