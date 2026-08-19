// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cr3dXCredit, Result} from "../../contracts/Cr3dXCredit.sol";
import {Cr3dXDeals} from "../../contracts/Cr3dXDeals.sol";
import {Cr3dXGateway} from "../../contracts/Cr3dXGateway.sol";
import {Cr3dXVerifier} from "../../contracts/Cr3dXVerifier.sol";
import {IBlockProver} from "../../contracts/interfaces/IBlockProver.sol";
import {Attestcoin} from "../../contracts/libraries/Attestcoin.sol";
import {ProvenLog} from "../../contracts/libraries/ProvenTransaction.sol";
import {BlobBuilder} from "./BlobBuilder.sol";
import {GateLog} from "./GateLog.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {MockChainInfo} from "./MockChainInfo.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice A complete Cr3dX deployment, wired the way the live one is, with the
///         two precompiles replaced by mocks.
///
/// @dev What is real: the gateway, the verifier, the registry and the credit
///      layer, all deployed in the production order, including the registry
///      constructing the credit layer so that the `onlyDeals` pairing is the one
///      that ships.
///
///      What is simulated: the two precompiles. The BlockProver mock answers
///      yes on proofs without checking them, because a local EVM has no
///      Attestcoin; proof validity is exercised against the real precompile by
///      `scripts/verify-live.ts` and by `scripts/deal-live.ts`, and no test
///      built on this harness should be read as evidence that a proof is valid.
///      The ChainInfo mock returns whatever attested source height a test set,
///      which is the only way to reach a deadline in a test at all.
///
///      Evidence is delivered in two steps on purpose: `_record*` puts a fact in
///      the verifier without applying it, and application is a separate call.
///      Order-of-delivery tests need exactly that separation, since the point is
///      to hold several verified facts and then apply them in a chosen order.
abstract contract Cr3dXHarness is Test {
    using BlobBuilder for ProvenLog[];

    uint64 internal constant CHAIN_KEY = 1;
    uint64 internal constant GRACE_PERIOD = 600;
    /// @dev 5,000 USDC at six decimals, the value the live deployment uses.
    uint256 internal constant BASE_LIMIT = 5_000_000_000;

    MockERC20 internal token;
    Cr3dXGateway internal gateway;
    Cr3dXVerifier internal verifier;
    Cr3dXDeals internal deals;
    Cr3dXCredit internal credit;

    IBlockProver.MerkleProof internal proof;
    IBlockProver.ContinuityProof internal continuity;

    /// @dev Mirrors the gateway's own counter: one sequence shared by both event
    ///      kinds, which is what keeps two events of one transaction apart.
    uint256 internal nextEventNonce;

    function _deployCr3dX() internal {
        token = new MockERC20("USD Coin", "USDC", 6);
        gateway = new Cr3dXGateway(IERC20(address(token)));
        verifier = new Cr3dXVerifier(CHAIN_KEY, address(gateway));
        deals = new Cr3dXDeals(verifier, GRACE_PERIOD, BASE_LIMIT);
        credit = deals.credit();

        vm.etch(address(Attestcoin.BLOCK_PROVER), address(new MockBlockProver()).code);
        vm.etch(address(Attestcoin.CHAIN_INFO), address(new MockChainInfo()).code);
        _prover().setTxIndex(1);
        _chainInfo().setAttestedHeight(CHAIN_KEY, 1);

        proof.root = keccak256("merkle-root");
        proof.siblings.push(IBlockProver.MerkleProofEntry({hash: keccak256("sibling"), isLeft: true}));
        continuity.lowerEndpointDigest = keccak256("lower");
        continuity.roots.push(keccak256("root"));
    }

    function _prover() internal pure returns (MockBlockProver) {
        return MockBlockProver(address(Attestcoin.BLOCK_PROVER));
    }

    function _chainInfo() internal pure returns (MockChainInfo) {
        return MockChainInfo(address(Attestcoin.CHAIN_INFO));
    }

    function _setAttestedHeight(uint64 height) internal {
        _chainInfo().setAttestedHeight(CHAIN_KEY, height);
    }

    // ------------------------------------------------------------------
    // evidence
    // ------------------------------------------------------------------

    /// @dev Records a proven funding without applying it.
    function _recordFunding(
        bytes32 dealId,
        address investor,
        address borrower,
        uint256 amount,
        uint64 height
    ) internal returns (bytes32 evidenceId) {
        ProvenLog[] memory logs =
            GateLog.only(GateLog.funding(address(gateway), dealId, investor, borrower, amount, nextEventNonce++));
        return _record(logs, height)[0];
    }

    /// @dev Records a proven repayment without applying it.
    function _recordRepayment(
        bytes32 dealId,
        address payer,
        address investor,
        uint256 amount,
        uint64 height
    ) internal returns (bytes32 evidenceId) {
        ProvenLog[] memory logs =
            GateLog.only(GateLog.repayment(address(gateway), dealId, payer, investor, amount, nextEventNonce++));
        return _record(logs, height)[0];
    }

    function _record(ProvenLog[] memory logs, uint64 height) internal returns (bytes32[] memory ids) {
        return verifier.submitEvidence(height, BlobBuilder.buildSuccessful(logs), proof, continuity);
    }

    /// @dev The production path: prove and apply in one transaction.
    function _submitAndApply(ProvenLog[] memory logs, uint64 height) internal returns (bytes32[] memory ids) {
        return deals.submitAndApply(height, BlobBuilder.buildSuccessful(logs), proof, continuity);
    }

    function _fundAndApply(bytes32 dealId, address investor, address borrower, uint256 amount, uint64 height)
        internal
        returns (bytes32 evidenceId)
    {
        ProvenLog[] memory logs =
            GateLog.only(GateLog.funding(address(gateway), dealId, investor, borrower, amount, nextEventNonce++));
        return _submitAndApply(logs, height)[0];
    }

    function _repayAndApply(bytes32 dealId, address payer, address investor, uint256 amount, uint64 height)
        internal
        returns (bytes32 evidenceId)
    {
        ProvenLog[] memory logs =
            GateLog.only(GateLog.repayment(address(gateway), dealId, payer, investor, amount, nextEventNonce++));
        return _submitAndApply(logs, height)[0];
    }

    // ------------------------------------------------------------------
    // convenience
    // ------------------------------------------------------------------

    function _createDeal(
        address borrower,
        address designatedInvestor,
        uint256 requiredFunding,
        uint256 faceValue,
        uint64 dueBlock
    ) internal returns (bytes32 dealId) {
        vm.prank(borrower);
        return deals.createDeal(designatedInvestor, requiredFunding, faceValue, dueBlock);
    }

    function _status(bytes32 dealId) internal view returns (Cr3dXDeals.DealStatus) {
        return deals.getDeal(dealId).status;
    }
}
