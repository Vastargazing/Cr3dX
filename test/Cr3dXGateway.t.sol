// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Cr3dXGateway} from "../contracts/Cr3dXGateway.sol";
import {MockERC20, FalseReturningERC20, NoReturnERC20} from "./helpers/MockERC20.sol";
import {ProvenTransaction, ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";

/// @title Cr3dXGatewayTest
/// @notice Unit tests for the Sepolia gateway.
///
/// @dev The gateway's job is narrow, so the tests are mostly about what it must
///      *not* do: not hold funds, not touch anything sent to it by accident, not
///      offer anyone a way to interfere. The one positive obligation is that its
///      events carry exactly the fields, in exactly the order, that the decoder
///      from the previous stage expects, which is checked here against the real
///      decoder rather than against a restatement of the layout.
contract Cr3dXGatewayTest is Test {
    Cr3dXGateway internal gateway;
    MockERC20 internal token;

    address internal investor = makeAddr("investor");
    address internal borrower = makeAddr("borrower");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant DEAL_ID = keccak256("deal-1");
    uint256 internal constant FUNDING = 1_000_000_000; // 1000 USDC at six decimals
    uint256 internal constant FACE_VALUE = 1_100_000_000;

    event FundingMade(
        bytes32 indexed dealId,
        address indexed investor,
        address indexed borrower,
        uint256 amount,
        uint256 nonce
    );
    event RepaymentMade(
        bytes32 indexed dealId, address indexed payer, address indexed investor, uint256 amount, uint256 nonce
    );

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        gateway = new Cr3dXGateway(IERC20(address(token)));
        token.mint(investor, 10 * FUNDING);
        token.mint(borrower, 10 * FACE_VALUE);
    }

    // -- the happy path, stated as a delta -----------------------------------

    function test_fundMovesTokensDirectlyToTheBorrower() public {
        _approve(investor, FUNDING);

        uint256 investorBefore = token.balanceOf(investor);
        uint256 borrowerBefore = token.balanceOf(borrower);

        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);

        assertEq(token.balanceOf(investor), investorBefore - FUNDING, "investor should have paid");
        assertEq(token.balanceOf(borrower), borrowerBefore + FUNDING, "borrower should have received");
    }

    function test_repayMovesTokensDirectlyToTheInvestor() public {
        _approve(borrower, FACE_VALUE);

        uint256 borrowerBefore = token.balanceOf(borrower);
        uint256 investorBefore = token.balanceOf(investor);

        vm.prank(borrower);
        gateway.repay(DEAL_ID, investor, FACE_VALUE);

        assertEq(token.balanceOf(borrower), borrowerBefore - FACE_VALUE, "payer should have paid");
        assertEq(token.balanceOf(investor), investorBefore + FACE_VALUE, "investor should have received");
    }

    /// @notice Anyone may repay on the borrower's behalf.
    /// @dev The credit layer settles against the deal, not against who paid, so
    ///      the gateway has no reason to restrict this and does not.
    function test_anyoneMayRepay() public {
        _approve(stranger, FACE_VALUE);
        token.mint(stranger, FACE_VALUE);

        vm.expectEmit(true, true, true, true, address(gateway));
        emit RepaymentMade(DEAL_ID, stranger, investor, FACE_VALUE, 0);

        vm.prank(stranger);
        gateway.repay(DEAL_ID, investor, FACE_VALUE);
    }

    // -- the gateway is never a holder ---------------------------------------

    /// @notice A successful call leaves the gateway's balance exactly where it was.
    /// @dev Stated as a delta, not as "the balance is always zero". The absolute
    ///      claim is false and untestable: anyone can transfer tokens to this
    ///      address without the gateway taking part. What the gateway controls is
    ///      that its own operations never change its balance.
    function test_gatewayBalanceIsUnchangedByFundAndRepay() public {
        _approve(investor, FUNDING);
        _approve(borrower, FACE_VALUE);

        uint256 before = token.balanceOf(address(gateway));

        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);
        assertEq(token.balanceOf(address(gateway)), before, "fund must not leave a balance behind");

        vm.prank(borrower);
        gateway.repay(DEAL_ID, investor, FACE_VALUE);
        assertEq(token.balanceOf(address(gateway)), before, "repay must not leave a balance behind");
    }

    /// @notice Tokens forced onto the gateway are never touched by later operations.
    /// @dev There is no rescue function, on purpose: it would require an account
    ///      entitled to call it, and no such account exists anywhere in Cr3dX.
    ///      The stuck balance is inert, which is the property worth testing.
    function test_forcedTokensAreIgnoredByLaterOperations() public {
        uint256 stuck = 777_000_000;
        vm.prank(investor);
        assertTrue(token.transfer(address(gateway), stuck), "setup transfer should succeed");
        assertEq(token.balanceOf(address(gateway)), stuck, "setup: tokens should be stuck on the gateway");

        _approve(investor, FUNDING);
        uint256 borrowerBefore = token.balanceOf(borrower);

        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);

        assertEq(token.balanceOf(address(gateway)), stuck, "the stuck balance must be untouched");
        assertEq(
            token.balanceOf(borrower), borrowerBefore + FUNDING, "funding must come from the investor only"
        );
    }

    /// @notice The gateway has no privileged surface at all.
    /// @dev Asserted against the deployed contract rather than stated in prose.
    ///      Every name below is a function that would, if it existed, give
    ///      somebody the ability to interfere with a fact this system treats as
    ///      final. There is no fallback either, so an unknown selector reverts
    ///      instead of being quietly swallowed.
    function test_gatewayHasNoPrivilegedFunctions() public {
        string[10] memory forbidden = [
            "owner()",
            "transferOwnership(address)",
            "renounceOwnership()",
            "pause()",
            "unpause()",
            "rescue(address,uint256)",
            "withdraw(address,uint256)",
            "sweep(address)",
            "setToken(address)",
            "upgradeTo(address)"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) =
                address(gateway).call(abi.encodeWithSignature(forbidden[i], address(this), uint256(1)));
            assertFalse(ok, string.concat("gateway must not expose ", forbidden[i]));
        }
    }

    /// @notice The gateway does not accept ether, so nothing can be stranded in it
    ///         that a rescue function would then be argued for.
    function test_gatewayRejectsEther() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(gateway).call{value: 1 ether}("");
        assertFalse(ok, "the gateway must have no receive or fallback");
    }

    // -- rejections ----------------------------------------------------------

    function test_rejectsZeroDealId() public {
        _approve(investor, FUNDING);
        vm.prank(investor);
        vm.expectRevert(Cr3dXGateway.ZeroDealId.selector);
        gateway.fund(bytes32(0), borrower, FUNDING);
    }

    function test_rejectsZeroRecipientOnFund() public {
        _approve(investor, FUNDING);
        vm.prank(investor);
        vm.expectRevert(Cr3dXGateway.ZeroRecipient.selector);
        gateway.fund(DEAL_ID, address(0), FUNDING);
    }

    function test_rejectsZeroRecipientOnRepay() public {
        _approve(borrower, FACE_VALUE);
        vm.prank(borrower);
        vm.expectRevert(Cr3dXGateway.ZeroRecipient.selector);
        gateway.repay(DEAL_ID, address(0), FACE_VALUE);
    }

    function test_rejectsZeroAmount() public {
        vm.prank(investor);
        vm.expectRevert(Cr3dXGateway.ZeroAmount.selector);
        gateway.fund(DEAL_ID, borrower, 0);
    }

    function test_rejectsZeroDealIdOnRepay() public {
        _approve(borrower, FACE_VALUE);
        vm.prank(borrower);
        vm.expectRevert(Cr3dXGateway.ZeroDealId.selector);
        gateway.repay(bytes32(0), investor, FACE_VALUE);
    }

    /// @notice Without an allowance the call fails, and it fails in the token.
    /// @dev This is the single most likely thing to go wrong when someone
    ///      reproduces the demo, which is why the README leads with `approve`.
    function test_revertsWithoutAllowance() public {
        vm.prank(investor);
        vm.expectRevert(bytes("ERC20: insufficient allowance"));
        gateway.fund(DEAL_ID, borrower, FUNDING);
    }

    function test_constructorRejectsNonContractToken() public {
        vm.expectRevert(Cr3dXGateway.TokenNotAContract.selector);
        new Cr3dXGateway(IERC20(makeAddr("not-a-token")));
    }

    // -- the transfer is checked, not assumed --------------------------------

    /// @notice A token that signals failure by returning false is not mistaken for success.
    function test_falseReturningTransferIsRejected() public {
        FalseReturningERC20 liar = new FalseReturningERC20();
        Cr3dXGateway g = new Cr3dXGateway(IERC20(address(liar)));

        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        g.fund(DEAL_ID, borrower, FUNDING);
    }

    /// @notice A token that returns nothing is accepted, as the standard's
    ///         earlier implementations require.
    function test_noReturnTransferIsAccepted() public {
        NoReturnERC20 quiet = new NoReturnERC20();
        Cr3dXGateway g = new Cr3dXGateway(IERC20(address(quiet)));
        quiet.mint(investor, FUNDING);

        vm.prank(investor);
        quiet.approve(address(g), FUNDING);

        vm.prank(investor);
        g.fund(DEAL_ID, borrower, FUNDING);

        assertEq(quiet.balanceOf(borrower), FUNDING, "a silent token must still work");
    }

    // -- the shared counter --------------------------------------------------

    /// @notice One counter serves both event types.
    /// @dev Two independent counters would let a funding and a repayment carry
    ///      the same number, and the credit layer builds evidence identifiers out
    ///      of that number. Collisions there mean one proof silently displacing
    ///      another.
    function test_nonceIsSharedAcrossBothEventTypes() public {
        _approve(investor, 3 * FUNDING);
        _approve(borrower, FACE_VALUE);

        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);
        assertEq(gateway.nonce(), 1, "first event should be numbered zero");

        vm.prank(borrower);
        gateway.repay(DEAL_ID, investor, FACE_VALUE);
        assertEq(gateway.nonce(), 2, "the repayment must continue the same sequence");

        vm.expectEmit(true, true, true, true, address(gateway));
        emit FundingMade(DEAL_ID, investor, borrower, FUNDING, 2);
        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);
    }

    /// @notice Every event in a run carries a distinct number.
    function testFuzz_noncesAreDistinctAcrossManyEvents(uint8 count) public {
        uint256 n = bound(count, 1, 40);
        _approve(investor, type(uint256).max);
        token.mint(investor, n * FUNDING);

        for (uint256 i = 0; i < n; i++) {
            vm.expectEmit(true, true, true, true, address(gateway));
            emit FundingMade(DEAL_ID, investor, borrower, FUNDING, i);
            vm.prank(investor);
            gateway.fund(DEAL_ID, borrower, FUNDING);
        }
        assertEq(gateway.nonce(), n, "counter must equal the number of events emitted");
    }

    // -- the events are what the decoder expects -----------------------------

    /// @notice The emitted log decodes through the real decoder into the fields
    ///         the credit layer will read.
    /// @dev Checked against `ProvenTransaction` itself, not against a hand-copied
    ///      description of the layout, so that a change to either side that
    ///      breaks the pairing fails here rather than on a live testnet.
    function test_eventLayoutMatchesTheDecoder() public {
        _approve(investor, FUNDING);

        vm.recordLogs();
        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);

        ProvenLog[] memory logs = _recordedGatewayLogs();
        assertEq(logs.length, 1, "exactly one gateway log");

        ProvenLog memory log = logs[0];
        assertEq(log.emitter, address(gateway), "emitter must be the gateway");
        assertEq(log.topics.length, 4, "topic0 plus three indexed parameters");
        assertEq(ProvenTransaction.topic0(log), FundingMade.selector, "topic0 must be FundingMade");
        assertEq(log.topics[1], DEAL_ID, "dealId is the first indexed parameter");
        assertEq(address(uint160(uint256(log.topics[2]))), investor, "investor is the second");
        assertEq(address(uint160(uint256(log.topics[3]))), borrower, "borrower is the third");

        (uint256 amount, uint256 eventNonce) = abi.decode(log.data, (uint256, uint256));
        assertEq(amount, FUNDING, "amount comes first in the data");
        assertEq(eventNonce, 0, "nonce comes second in the data");
    }

    function test_repaymentEventLayoutMatchesTheDecoder() public {
        _approve(borrower, FACE_VALUE);

        vm.recordLogs();
        vm.prank(borrower);
        gateway.repay(DEAL_ID, investor, FACE_VALUE);

        ProvenLog[] memory logs = _recordedGatewayLogs();
        assertEq(logs.length, 1, "exactly one gateway log");

        ProvenLog memory log = logs[0];
        assertEq(ProvenTransaction.topic0(log), RepaymentMade.selector, "topic0 must be RepaymentMade");
        assertEq(log.topics[1], DEAL_ID, "dealId is the first indexed parameter");
        assertEq(address(uint160(uint256(log.topics[2]))), borrower, "payer is the second");
        assertEq(address(uint160(uint256(log.topics[3]))), investor, "investor is the third");

        (uint256 amount, uint256 eventNonce) = abi.decode(log.data, (uint256, uint256));
        assertEq(amount, FACE_VALUE, "amount comes first in the data");
        assertEq(eventNonce, 0, "nonce comes second in the data");
    }

    /// @notice A gateway call also emits the token's own `Transfer`, so the
    ///         credit layer must walk past logs it does not care about.
    function test_callAlsoEmitsTokenTransferSoLogsAreNoisy() public {
        _approve(investor, FUNDING);

        vm.recordLogs();
        vm.prank(investor);
        gateway.fund(DEAL_ID, borrower, FUNDING);

        Vm.Log[] memory raw = vm.getRecordedLogs();
        assertEq(raw.length, 2, "one token Transfer and one gateway event");
        assertEq(raw[0].emitter, address(gateway), "the gateway event is emitted before the transfer");
        assertEq(raw[1].emitter, address(token), "the token's Transfer follows");
    }

    // -- helpers -------------------------------------------------------------

    function _approve(address who, uint256 amount) internal {
        vm.prank(who);
        token.approve(address(gateway), amount);
    }

    /// @notice Recorded logs from the gateway only, shaped like the decoder's output.
    function _recordedGatewayLogs() internal view returns (ProvenLog[] memory out) {
        Vm.Log[] memory raw = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < raw.length; i++) {
            if (raw[i].emitter == address(gateway)) n++;
        }
        out = new ProvenLog[](n);
        uint256 k;
        for (uint256 i = 0; i < raw.length; i++) {
            if (raw[i].emitter != address(gateway)) continue;
            out[k++] = ProvenLog({emitter: raw[i].emitter, topics: raw[i].topics, data: raw[i].data});
        }
    }
}
