// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cr3dXGateway} from "../contracts/Cr3dXGateway.sol";
import {ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";
import {GateLog} from "./helpers/GateLog.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

/// @title GateLogTest
/// @notice Pins the hand-built gateway logs to the ones the gateway really emits.
///
/// @dev `GateLog` restates an encoding rather than observing it, which is a
///      liability: a fuzz campaign built on a wrong encoding would exercise
///      events nobody emits and report success. These two tests are what makes
///      that liability safe. They drive the real gateway, take what it actually
///      logged, build the same log through the library, and compare every byte.
contract GateLogTest is Test {
    MockERC20 internal token;
    Cr3dXGateway internal gateway;

    address internal investor = makeAddr("investor");
    address internal borrower = makeAddr("borrower");
    bytes32 internal constant DEAL = keccak256("deal");

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        gateway = new Cr3dXGateway(IERC20(address(token)));
        token.mint(investor, 1e12);
        token.mint(borrower, 1e12);
        vm.prank(investor);
        token.approve(address(gateway), type(uint256).max);
        vm.prank(borrower);
        token.approve(address(gateway), type(uint256).max);
    }

    function test_fundingLogMatchesTheGateway() public {
        vm.recordLogs();
        vm.prank(investor);
        gateway.fund(DEAL, borrower, 1_000_000);

        ProvenLog memory emitted = _onlyGatewayLog();
        ProvenLog memory built = GateLog.funding(address(gateway), DEAL, investor, borrower, 1_000_000, 0);
        _assertSameLog(emitted, built);
    }

    function test_repaymentLogMatchesTheGateway() public {
        // One shared counter across both event kinds, so the repayment below
        // carries nonce 1, not nonce 0.
        vm.prank(investor);
        gateway.fund(DEAL, borrower, 1);

        vm.recordLogs();
        vm.prank(borrower);
        gateway.repay(DEAL, investor, 1_100_000);

        ProvenLog memory emitted = _onlyGatewayLog();
        ProvenLog memory built = GateLog.repayment(address(gateway), DEAL, borrower, investor, 1_100_000, 1);
        _assertSameLog(emitted, built);
    }

    function _onlyGatewayLog() private returns (ProvenLog memory log) {
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i = 0; i < recorded.length; i++) {
            if (recorded[i].emitter != address(gateway)) continue;
            log = ProvenLog({emitter: recorded[i].emitter, topics: recorded[i].topics, data: recorded[i].data});
            found++;
        }
        assertEq(found, 1, "expected exactly one gateway log");
    }

    function _assertSameLog(ProvenLog memory emitted, ProvenLog memory built) private pure {
        assertEq(built.emitter, emitted.emitter, "emitter");
        assertEq(built.topics.length, emitted.topics.length, "topic count");
        for (uint256 i = 0; i < emitted.topics.length; i++) {
            assertEq(built.topics[i], emitted.topics[i], "topic");
        }
        assertEq(built.data, emitted.data, "data");
    }
}
