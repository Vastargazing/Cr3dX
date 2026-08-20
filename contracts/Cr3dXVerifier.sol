// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBlockProver} from "./interfaces/IBlockProver.sol";
import {ICr3dXGatewayEvents} from "./interfaces/ICr3dXGatewayEvents.sol";
import {Attestcoin} from "./libraries/Attestcoin.sol";
import {ProvenTransaction, ProvenLog} from "./libraries/ProvenTransaction.sol";

/// @title Cr3dXVerifier
/// @notice The only way an external fact enters Cr3dX.
///
/// @dev **What this contract is for, and what it refuses to do.**
///
///      It answers one question: *what happened on the source chain*. It records
///      immutable verified facts and stops there. It does not know what a deal
///      is, whether a fact is applicable to one, whether it is waiting for
///      something, or whether it was rejected. Those are questions about
///      *meaning*, and meaning is assigned by `Cr3dXDeals`.
///
///      That split is not tidiness. If this contract pushed evidence into the
///      registry, and the registry wrote application state back into this one,
///      the two would have to be introduced to each other after deployment,
///      through a setter that some address is entitled to call. The moment such
///      an address exists, "no role, including the deployer, can change a status,
///      a proof, an outcome or a reserve" stops being true, and that sentence is
///      the product. So the dependency runs one way only: the registry is
///      deployed second, takes this address in its constructor, and reads from
///      here. Nothing here ever calls it back.
///
///      **Why the submission functions return identifiers.** The specification
///      says submission immediately attempts application. The registry therefore
///      needs an entry point that submits and applies in one transaction, which
///      means it needs to know which identifiers this call just created. Handing
///      them back is what makes that possible without this contract knowing the
///      registry exists. Direct submission here stays open to anyone.
///
///      **Ordering is load bearing.** `verify` runs before `calculateTxIndex`,
///      always. The index is pure arithmetic over the Merkle siblings: run it
///      first and it returns a position derived from bytes nobody vouched for,
///      which would then be baked into an evidence identifier. There is no
///      failure branch after `verify`, because the precompile reverts rather than
///      returning false.
contract Cr3dXVerifier is ICr3dXGatewayEvents {
    /// @notice Which of the two gateway events a piece of evidence came from.
    enum EvidenceKind {
        FUNDING,
        REPAYMENT
    }

    /// @notice One proven gateway event. Written once, never modified.
    ///
    /// @dev **Field order is chosen for storage packing, not for reading.** The
    ///      fields below occupy five slots instead of the seven a declaration
    ///      order that read nicely would need, which is 40,000 gas per fact on
    ///      every submission. Read this through `getEvidence`, which returns the
    ///      struct with named fields, rather than through the generated `evidence`
    ///      getter whose tuple order follows the packing.
    ///
    /// @param dealId Deal named by the payer at the gateway. Unverified as a
    ///        reference: the gateway cannot know whether the deal exists, and
    ///        neither can this contract. The registry decides that.
    /// @param counterparty The account that paid, read from the proven log.
    /// @param blockHeight Source chain height the transaction was included at.
    ///        Every deadline decision in Cr3dX is made against source heights,
    ///        never against Creditcoin's own clock.
    /// @param kind Which gateway event this came from.
    /// @param recorded Whether this slot holds a fact. Packed into spare bytes
    ///        alongside the fields above, so the replay check costs nothing
    ///        beyond the write that was happening anyway.
    /// @param recipient The account that received, read from the proven log.
    /// @param txIndex Position within the source block, valid only because
    ///        `verify` succeeded on the same proof first.
    /// @param amount Native token units.
    /// @param eventNonce The gateway's own counter, shared across both event
    ///        types. It is what separates two otherwise identical events in one
    ///        transaction.
    struct VerifiedEvidence {
        // slot 0
        bytes32 dealId;
        // slot 1: 20 + 8 + 1 + 1 = 30 bytes
        address counterparty;
        uint64 blockHeight;
        EvidenceKind kind;
        bool recorded;
        // slot 2: 20 + 8 = 28 bytes
        address recipient;
        uint64 txIndex;
        // slots 3 and 4
        uint256 amount;
        uint256 eventNonce;
    }

    /// @notice Creditcoin's internal identifier for the source chain.
    /// @dev Not the source chain's EVM chain id. Resolved from the ChainInfo
    ///      registry at deployment time and fixed here.
    uint64 public immutable chainKey;

    /// @notice The one gateway whose events count as evidence.
    /// @dev Immutable. Matching on the event topic alone would accept an
    ///      identical event from any contract that cares to declare it, and
    ///      declaring it costs nothing.
    address public immutable gateway;

    /// @notice Topic hash of `FundingMade`, as this contract matches it.
    bytes32 public immutable fundingTopic;

    /// @notice Topic hash of `RepaymentMade`, as this contract matches it.
    bytes32 public immutable repaymentTopic;

    /// @notice Verified facts by identifier.
    mapping(bytes32 => VerifiedEvidence) public evidence;

    /// @notice Whether an identifier has already been recorded.
    /// @dev Same external signature as a `mapping(bytes32 => bool) public seen`,
    ///      but the flag lives in spare bytes of the evidence slot rather than in
    ///      a mapping of its own. A separate mapping would be a second cold
    ///      storage write, 20,000 gas, to record something the fact itself
    ///      already knows. Inferring it from a zero field instead would tie the
    ///      replay check to whatever the gateway happens to validate, which is a
    ///      coupling worth paying a byte to avoid.
    function seen(bytes32 evidenceId) external view returns (bool) {
        return evidence[evidenceId].recorded;
    }

    /// @notice The precompile accepted a proof of a transaction that failed.
    /// @dev The precompile proves inclusion, not success. A reverted transfer
    ///      carries a perfectly valid proof, and nothing stops someone from
    ///      submitting it as evidence that money moved.
    error SourceTransactionFailed(uint64 height, uint64 txIndex);

    /// @notice A verified source transaction produced no evidence.
    /// @dev Deliberately a revert, including for each transaction inside a
    ///      batch. A submission that succeeds while one of the transactions
    ///      records nothing is a lie by omission: the caller paid to submit that
    ///      transaction and got no fact for it.
    error NoRelevantEvidence();

    /// @notice This exact fact has already been recorded.
    error EvidenceAlreadyRecorded(bytes32 evidenceId);

    /// @notice No verified fact exists under this identifier.
    error UnknownEvidence(bytes32 evidenceId);

    /// @notice Batch size outside `1 ..= 10`.
    /// @dev Ten is the precompile's own limit, confirmed against the live
    ///      network: eleven heights are rejected there.
    error BatchSizeOutOfRange(uint256 size);

    /// @notice The batch arrays are not all the same length.
    error BatchLengthMismatch();

    /// @notice A log from our gateway carrying our topic, shaped wrongly.
    /// @dev Unreachable through the real gateway, whose address is immutable
    ///      here. Kept because failing loudly on the impossible is better than
    ///      decoding past the end of something.
    error MalformedGatewayLog(uint64 height, uint64 txIndex);

    /// @notice A verified fact was recorded.
    event EvidenceRecorded(
        bytes32 indexed evidenceId,
        bytes32 indexed dealId,
        EvidenceKind indexed kind,
        address counterparty,
        address recipient,
        uint256 amount,
        uint64 blockHeight,
        uint64 txIndex,
        uint256 eventNonce
    );

    /// @dev The precompile's own batch ceiling.
    uint256 private constant MAX_BATCH = 10;

    /// @dev Receipt status of a successful source transaction.
    uint8 private constant STATUS_SUCCESS = 1;

    /// @param chainKey_ Source chain key from the ChainInfo registry.
    /// @param gateway_ Address of the Cr3dX gateway on the source chain.
    constructor(uint64 chainKey_, address gateway_) {
        chainKey = chainKey_;
        gateway = gateway_;
        // Taken from the shared event declaration rather than pasted in as a
        // literal, so the matcher cannot drift from what the gateway emits. The
        // compiler will not fold an event selector into a `constant`, hence
        // `immutable`; they are exposed because the worker needs the same values.
        fundingTopic = ICr3dXGatewayEvents.FundingMade.selector;
        repaymentTopic = ICr3dXGatewayEvents.RepaymentMade.selector;
    }

    /// @notice Proves one source transaction and records every gateway event in it.
    /// @return ids Identifiers of the facts this call created, in log order.
    function submitEvidence(
        uint64 height,
        bytes calldata encodedTx,
        IBlockProver.MerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (bytes32[] memory ids) {
        // Step one, and it has to be first. The precompile reverts on a bad
        // proof, so there is no result to branch on and no else branch to write.
        Attestcoin.BLOCK_PROVER.verify(chainKey, height, encodedTx, merkleProof, continuityProof);

        ids = _recordTransaction(height, encodedTx, merkleProof);
    }

    /// @notice Proves up to ten source transactions against one continuity proof.
    /// @dev The batch exists for the shared continuity proof, which is the
    ///      expensive part of a submission. Verifying ten transactions one after
    ///      another would carry ten continuity chains and defeat the purpose, so
    ///      the batch verification happens once, up front, for all of them.
    ///
    ///      Atomic: anything this contract treats as an error fails the whole
    ///      call. There is no partial success to reason about later.
    /// @return ids Identifiers created across the whole batch, in transaction
    ///         order and then log order.
    function submitEvidenceBatch(
        uint64[] calldata heights,
        bytes[] calldata encodedTxs,
        IBlockProver.MerkleProof[] calldata merkleProofs,
        IBlockProver.ContinuityProof calldata sharedContinuityProof
    ) external returns (bytes32[] memory ids) {
        uint256 n = heights.length;
        if (n == 0 || n > MAX_BATCH) revert BatchSizeOutOfRange(n);
        if (encodedTxs.length != n || merkleProofs.length != n) revert BatchLengthMismatch();

        // Once, for the whole range. The shared proof must span from the lowest
        // to the highest height in the batch; the precompile enforces that.
        Attestcoin.BLOCK_PROVER.verify(chainKey, heights, encodedTxs, merkleProofs, sharedContinuityProof);

        bytes32[][] memory perTransaction = new bytes32[][](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            perTransaction[i] = _recordTransaction(heights[i], encodedTxs[i], merkleProofs[i]);
            total += perTransaction[i].length;
        }
        ids = new bytes32[](total);
        uint256 k;
        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory chunk = perTransaction[i];
            for (uint256 j = 0; j < chunk.length; j++) {
                ids[k++] = chunk[j];
            }
        }
    }

    /// @notice Reads a verified fact as a struct.
    /// @dev The public mapping getter flattens the struct into a tuple, which the
    ///      registry would then have to reassemble. This is the shape S4 wants.
    function getEvidence(bytes32 evidenceId) external view returns (VerifiedEvidence memory) {
        VerifiedEvidence memory result = evidence[evidenceId];
        if (!result.recorded) revert UnknownEvidence(evidenceId);
        return result;
    }

    /// @notice Identifier of a fact, computed the same way this contract computes it.
    /// @dev Exposed so the registry and the worker derive identifiers from one
    ///      implementation rather than three agreeing copies.
    function evidenceIdOf(uint64 height, uint64 txIndex, EvidenceKind kind, uint256 eventNonce)
        public
        view
        returns (bytes32)
    {
        // `abi.encode`, not `abi.encodePacked`. Every field here is fixed width,
        // so the two are equivalent and neither can be made ambiguous. The choice
        // is for the reader: a packed identifier invites the next person to add a
        // variable-width field to it without noticing what that does.
        return keccak256(abi.encode(chainKey, height, txIndex, uint8(kind), eventNonce));
    }

    /// @dev Everything after a successful verification, for one transaction.
    ///
    ///      **Only ever called after `verify` has succeeded on this proof.** Both
    ///      callers do that first and immediately. `calculateTxIndex` below is
    ///      trustworthy for exactly that reason and no other.
    function _recordTransaction(
        uint64 height,
        bytes calldata encodedTx,
        IBlockProver.MerkleProof calldata merkleProof
    ) private returns (bytes32[] memory ids) {
        uint64 txIndex = Attestcoin.BLOCK_PROVER.calculateTxIndex(merkleProof);

        // The precompile does not look at the status, and says so. If we do not
        // look either, a reverted transfer becomes proof that money moved.
        (uint8 status, ProvenLog[] memory logs) = ProvenTransaction.decodeReceipt(encodedTx);
        if (status != STATUS_SUCCESS) revert SourceTransactionFailed(height, txIndex);

        // Upper bound: at most one fact per log. Trimmed to the real count below.
        ids = new bytes32[](logs.length);
        uint256 found;

        // Hoisted out of the loop: immutable reads, but loop-invariant ones.
        bytes32 funding = fundingTopic;
        bytes32 repayment = repaymentTopic;

        // Every log, not the first match. A transaction can carry more than one
        // gateway event, and each is a fact that was paid for.
        for (uint256 i = 0; i < logs.length; i++) {
            (bool matched, bytes32 evidenceId) = _recordFromLog(logs[i], height, txIndex, funding, repayment);
            if (matched) ids[found++] = evidenceId;
        }

        if (found == 0) revert NoRelevantEvidence();

        // Shrink to what was actually found. The tail was allocated, never written.
        assembly ("memory-safe") {
            mstore(ids, found)
        }
    }

    /// @dev Turns one proven log into one fact, if it is one of ours.
    /// @return matched Whether this log produced a fact.
    /// @return evidenceId Identifier of that fact, meaningless when `matched` is false.
    function _recordFromLog(
        ProvenLog memory log,
        uint64 height,
        uint64 txIndex,
        bytes32 funding,
        bytes32 repayment
    ) private returns (bool matched, bytes32 evidenceId) {
        // Anything that is not ours is skipped in silence. Other contracts
        // emitting other events in the same transaction is ordinary, not an
        // attack, and reverting on it would make the gateway unusable from any
        // contract that does anything else in the same call.
        //
        // The emitter check is the whole defence against a lookalike. Declaring
        // an event with an identical signature costs nothing, so a matching topic
        // proves only that somebody wrote the same words.
        if (log.emitter != gateway) return (false, bytes32(0));
        bytes32 topic = ProvenTransaction.topic0(log);
        if (topic != funding && topic != repayment) return (false, bytes32(0));

        // Reaching here means the emitter is our immutable gateway, so the shape
        // is guaranteed by its source. Checked anyway, because the alternative is
        // decoding past the end of something.
        if (log.topics.length != 4 || log.data.length != 64) revert MalformedGatewayLog(height, txIndex);

        (uint256 amount, uint256 eventNonce) = abi.decode(log.data, (uint256, uint256));

        evidenceId = _record(
            VerifiedEvidence({
                dealId: log.topics[1],
                counterparty: _toAddress(log.topics[2]),
                blockHeight: height,
                kind: topic == funding ? EvidenceKind.FUNDING : EvidenceKind.REPAYMENT,
                recorded: false,
                recipient: _toAddress(log.topics[3]),
                txIndex: txIndex,
                amount: amount,
                eventNonce: eventNonce
            })
        );
        matched = true;
    }

    /// @dev Writes one fact, refusing to write it twice.
    function _record(VerifiedEvidence memory e) private returns (bytes32 evidenceId) {
        evidenceId = evidenceIdOf(e.blockHeight, e.txIndex, e.kind, e.eventNonce);
        if (evidence[evidenceId].recorded) revert EvidenceAlreadyRecorded(evidenceId);

        e.recorded = true;
        evidence[evidenceId] = e;

        emit EvidenceRecorded(
            evidenceId,
            e.dealId,
            e.kind,
            e.counterparty,
            e.recipient,
            e.amount,
            e.blockHeight,
            e.txIndex,
            e.eventNonce
        );
    }

    /// @dev An indexed `address` parameter occupies a full word in the topic.
    function _toAddress(bytes32 topic) private pure returns (address) {
        return address(uint160(uint256(topic)));
    }
}
