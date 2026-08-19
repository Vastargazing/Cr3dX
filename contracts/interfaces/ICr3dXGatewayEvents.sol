// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICr3dXGatewayEvents
/// @notice The two events that carry a Cr3dX fact across chains.
///
/// @dev Declared once and shared by both ends. `Cr3dXGateway` inherits this
///      interface and emits them on Sepolia; `Cr3dXVerifier` inherits it on
///      Creditcoin purely to obtain their topic hashes. That is the point of the
///      shared declaration: the emitter and the matcher cannot drift apart,
///      because there is only one place where the signature is written down.
///      A copied `bytes32 constant` would compile fine forever while silently
///      matching nothing.
interface ICr3dXGatewayEvents {
    /// @param dealId Identifier the credit layer will match this against.
    /// @param investor The account that paid, taken from `msg.sender` at the gateway.
    /// @param borrower The account that received.
    /// @param amount Native token units.
    /// @param nonce Sequence number within the gateway, shared with `RepaymentMade`.
    event FundingMade(
        bytes32 indexed dealId,
        address indexed investor,
        address indexed borrower,
        uint256 amount,
        uint256 nonce
    );

    /// @param payer The account that paid. Need not be the borrower.
    /// @param investor The account that received.
    event RepaymentMade(
        bytes32 indexed dealId, address indexed payer, address indexed investor, uint256 amount, uint256 nonce
    );
}
