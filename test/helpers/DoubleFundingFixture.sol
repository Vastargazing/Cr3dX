// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Cr3dXGateway} from "../../contracts/Cr3dXGateway.sol";

/// @title DoubleFundingFixture
/// @notice Fixture infrastructure. **Not part of the Cr3dX system.**
///
/// @dev Deployed to Sepolia once, called once, and never again. Its only purpose
///      is to produce a single real, attested transaction that the verifier stage
///      cannot obtain any other way, because an externally owned account can only
///      make one gateway call per transaction.
///
///      That transaction has to contain three things at the same time:
///
///      1. **Two `FundingMade` events, both from the real gateway, both for the
///         same `dealId`.** Two events of *different* kinds would be a weaker
///         test: their evidence identifiers already differ by event kind, so the
///         test would pass even if the event nonce were ignored entirely. Two
///         events of the same kind for the same deal differ *only* by nonce,
///         which is exactly the thing the identifier scheme exists to
///         distinguish. The same fixture doubles as the accumulating-funding case
///         later on.
///      2. **A counterfeit event with the same `topic0` as `FundingMade`, emitted
///         by this contract rather than the gateway.** Checking the log emitter is
///         the only defence against a lookalike contract, and a defence that is
///         only ever exercised against hand-written test data is a defence nobody
///         has seen work. With this fixture the verifier faces a genuine attested
///         transaction carrying a real gateway event and an outwardly identical
///         impostor, and has to take the first and silently ignore the second.
///      3. **Incidental `Transfer` logs from the token itself**, which make the
///         log list noisy in the way real transactions are, so walking past
///         irrelevant logs gets exercised too.
///
///      **Read this before interpreting the fixture.** The investor recorded in
///      both `FundingMade` events is the address of *this contract*, not of any
///      externally owned account, because this contract is the one calling
///      `fund`. That is correct and expected: the gateway records `msg.sender`
///      deliberately, so that the credit layer reads the payer from a proven log
///      field rather than from the transaction's `from`, which Ethereum's
///      canonical roots do not cover. Anyone reading this fixture at the deals
///      stage should not mistake it for broken accounting.
contract DoubleFundingFixture {
    using SafeERC20 for IERC20;

    Cr3dXGateway public immutable gateway;
    IERC20 public immutable token;

    /// @notice Deliberately shaped to hash to the same `topic0` as
    ///         `Cr3dXGateway.FundingMade`, with the same indexed parameters.
    /// @dev A verifier that matches on `topic0` alone, without checking which
    ///      contract emitted the log, will accept this. That is the point.
    event FundingMade(
        bytes32 indexed dealId,
        address indexed investor,
        address indexed borrower,
        uint256 amount,
        uint256 nonce
    );

    constructor(Cr3dXGateway gateway_) {
        gateway = gateway_;
        token = gateway_.token();
    }

    /// @notice Emits two genuine gateway fundings and one counterfeit, in one transaction.
    /// @dev The caller must have approved this contract for `firstAmount + secondAmount`
    ///      on the token; this contract in turn approves the gateway.
    /// @param dealId The deal both fundings name. Same value on purpose.
    /// @param borrower Recipient of both transfers.
    /// @param firstAmount Amount of the first genuine funding.
    /// @param secondAmount Amount of the second genuine funding.
    function emitTwoFundingsAndOneImpostor(
        bytes32 dealId,
        address borrower,
        uint256 firstAmount,
        uint256 secondAmount
    ) external {
        token.safeTransferFrom(msg.sender, address(this), firstAmount + secondAmount);
        token.forceApprove(address(gateway), firstAmount + secondAmount);

        gateway.fund(dealId, borrower, firstAmount);

        // The impostor sits between the two genuine events on purpose, so that a
        // verifier which stops at the first match, or which takes the last one,
        // both end up wrong in a visible way.
        emit FundingMade(dealId, address(this), borrower, firstAmount + secondAmount, type(uint256).max);

        gateway.fund(dealId, borrower, secondAmount);
    }
}
