// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICr3dXGatewayEvents} from "../../contracts/interfaces/ICr3dXGatewayEvents.sol";
import {ProvenLog} from "../../contracts/libraries/ProvenTransaction.sol";

/// @notice Builds the two gateway logs by hand, for tests that need thousands of
///         them.
///
/// @dev Driving the real gateway and recording what it emitted is the honest way
///      to get a log, and the verifier tests do exactly that. It is also too
///      expensive for a fuzz campaign, which needs a fresh log per call without
///      minting tokens, granting an allowance and paying for a transfer first.
///
///      So this library restates the encoding, and `test/GateLog.t.sol` pins it:
///      it drives the real gateway, records the real log, builds the same log
///      here and asserts the two are byte-identical. If the event signature ever
///      changes, that test fails rather than a fuzz campaign quietly exercising
///      an encoding nobody emits.
///
///      The topic hashes come from the shared event declaration, not from pasted
///      literals, for the same reason the verifier takes them from there.
library GateLog {
    function funding(
        address gateway,
        bytes32 dealId,
        address investor,
        address borrower,
        uint256 amount,
        uint256 nonce
    ) internal pure returns (ProvenLog memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = ICr3dXGatewayEvents.FundingMade.selector;
        topics[1] = dealId;
        topics[2] = bytes32(uint256(uint160(investor)));
        topics[3] = bytes32(uint256(uint160(borrower)));
        log = ProvenLog({emitter: gateway, topics: topics, data: abi.encode(amount, nonce)});
    }

    function repayment(
        address gateway,
        bytes32 dealId,
        address payer,
        address investor,
        uint256 amount,
        uint256 nonce
    ) internal pure returns (ProvenLog memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = ICr3dXGatewayEvents.RepaymentMade.selector;
        topics[1] = dealId;
        topics[2] = bytes32(uint256(uint160(payer)));
        topics[3] = bytes32(uint256(uint160(investor)));
        log = ProvenLog({emitter: gateway, topics: topics, data: abi.encode(amount, nonce)});
    }

    /// @notice Wraps one log as the only log of a transaction.
    function only(ProvenLog memory log) internal pure returns (ProvenLog[] memory logs) {
        logs = new ProvenLog[](1);
        logs[0] = log;
    }
}
