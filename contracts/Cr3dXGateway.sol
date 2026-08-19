// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Cr3dXGateway
/// @notice The Sepolia end of Cr3dX. Moves tokens between two parties and leaves
///         behind a fact that can be proven on Creditcoin.
///
/// @dev This is the simplest contract in the system and is meant to stay that
///      way. It holds nothing, decides nothing, and knows nothing about deals.
///
///      **Where the responsibility line runs.** The gateway cannot tell whether
///      `dealId` names a real deal, whether `borrower` is the borrower of that
///      deal, or whether `amount` is the amount anyone agreed to. It has no view
///      of Creditcoin state, by construction: the whole point of Cr3dX is that
///      the payment network and the credit layer are separate, and a gateway
///      that could check credit state would be a bridge with extra steps. Meaning
///      is assigned later, on Creditcoin, by a contract that reads these events
///      out of an Attestcoin proof and matches them against a deal it does know
///      about. Payments that name the wrong deal or the wrong recipient are lost;
///      that limitation is stated openly rather than papered over with checks
///      this contract has no basis to make.
///
///      **No privileged roles of any kind.** No owner, no pause, no rescue, no
///      upgrade. The absence of a function to sweep tokens that were sent here by
///      mistake is deliberate: such a function needs someone entitled to call it,
///      and the moment that person exists, "nobody can interfere with a proven
///      fact" stops being true. Tokens sent directly to this address are lost,
///      and that is a smaller cost than an administrator.
///
///      **Both functions spend an allowance.** The caller must `approve` this
///      contract on the token first. There is no `permit` path; a second
///      transaction is easier to explain and to reproduce than a signature
///      scheme.
contract Cr3dXGateway {
    using SafeERC20 for IERC20;

    /// @notice The one asset this gateway moves. Fixed at deployment.
    /// @dev Immutable rather than configurable, so that a proof of a gateway
    ///      event is also a proof of which asset moved.
    IERC20 public immutable token;

    /// @notice Number of events this gateway has emitted.
    /// @dev One counter shared by both event types, not one per type. The credit
    ///      layer derives an evidence identifier from it, and two events that
    ///      differ only in kind would otherwise collide when a single transaction
    ///      carries both. Reading it is only meaningful as "the next event will
    ///      carry this number".
    uint256 public nonce;

    /// @notice Investor sent funding straight to the borrower.
    /// @param dealId Identifier the credit layer will match this against.
    /// @param investor The account that paid. Taken from `msg.sender`, and
    ///        recorded in the event rather than left to be inferred from the
    ///        transaction sender, because the transaction's `from` field is not
    ///        covered by Ethereum's canonical roots and must never carry meaning.
    /// @param borrower The account that received.
    /// @param nonce Sequence number of this event within the gateway.
    event FundingMade(
        bytes32 indexed dealId,
        address indexed investor,
        address indexed borrower,
        uint256 amount,
        uint256 nonce
    );

    /// @notice Payer sent repayment straight to the investor.
    /// @param payer The account that paid. Need not be the borrower: anyone may
    ///        repay on their behalf, and the credit layer settles against the
    ///        deal, not against who pushed the button.
    event RepaymentMade(
        bytes32 indexed dealId, address indexed payer, address indexed investor, uint256 amount, uint256 nonce
    );

    /// @notice The token address given at deployment is not a contract.
    error TokenNotAContract();
    /// @notice `dealId` was zero, which no real deal identifier ever is.
    error ZeroDealId();
    /// @notice The recipient address was zero.
    error ZeroRecipient();
    /// @notice The amount was zero, which would emit a fact about nothing.
    error ZeroAmount();

    /// @param token_ The single ERC-20 this gateway moves.
    /// @dev The check here is that the address is a contract at all. Whether it
    ///      is the *right* token is a deployment concern, verified by
    ///      `scripts/deploy-gateway.ts` against the expected symbol and decimals.
    ///      That check protects the operator from a typo; the security anchor is
    ///      this immutable address, which every proof is implicitly about.
    constructor(IERC20 token_) {
        if (address(token_).code.length == 0) revert TokenNotAContract();
        token = token_;
    }

    /// @notice Sends `amount` from the caller to `borrower` and records it as funding.
    /// @dev The caller is the investor. No check ties `borrower` to `dealId`,
    ///      because this contract cannot know the pairing; see the note on the
    ///      responsibility line above.
    function fund(bytes32 dealId, address borrower, uint256 amount) external {
        _emitAndTransfer(dealId, borrower, amount, true);
    }

    /// @notice Sends `amount` from the caller to `investor` and records it as repayment.
    /// @dev The caller is the payer, who need not be the borrower.
    function repay(bytes32 dealId, address investor, uint256 amount) external {
        _emitAndTransfer(dealId, investor, amount, false);
    }

    /// @dev Checks, then effects, then the external call. The counter advances
    ///      and the event is emitted before the transfer, which is the standard
    ///      ordering and also means a token that re-enters cannot be handed a
    ///      number that has already been used. A failed transfer reverts the
    ///      whole transaction, so an event can never outlive the payment it
    ///      describes.
    function _emitAndTransfer(bytes32 dealId, address recipient, uint256 amount, bool isFunding) private {
        if (dealId == bytes32(0)) revert ZeroDealId();
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();

        uint256 eventNonce = nonce;
        nonce = eventNonce + 1;

        if (isFunding) {
            emit FundingMade(dealId, msg.sender, recipient, amount, eventNonce);
        } else {
            emit RepaymentMade(dealId, msg.sender, recipient, amount, eventNonce);
        }

        // Straight from payer to recipient. The gateway is never a holder, so its
        // own balance is untouched by a successful call.
        token.safeTransferFrom(msg.sender, recipient, amount);
    }
}
