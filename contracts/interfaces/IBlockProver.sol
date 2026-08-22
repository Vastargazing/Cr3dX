// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IBlockProver
/// @notice The Attestcoin Protocol BlockProver precompile.
/// @dev Transcribed from `precompiles/metadata/sol/block_prover.sol` on
///      gluwa/creditcoin3 at commit 06657e9, where the interface is named
///      `INativeQueryVerifier`. Signatures are reproduced exactly, because they
///      determine the selectors; only the interface name differs, to match what
///      the runtime and the protocol documentation call this precompile.
///
///      Two properties of this precompile shape every consumer:
///
///      1. `verify` returns `true` or reverts. It never returns `false`, so
///         there is no failure branch to write on the calling side.
///      2. `verify` proves that the encoded transaction and receipt pair was
///         included. It does **not** check the receipt status. A reverted
///         transaction carries a perfectly valid proof, and rejecting it is the
///         consumer's responsibility.
interface IBlockProver {
    /// @param hash The sibling hash at this level of the Merkle path.
    /// @param isLeft Whether the sibling sits on the left of the path.
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    /// @notice Inclusion proof of one transaction in one attested source block.
    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    /// @notice Chain of attested Merkle roots linking the queried height back to
    ///         a known attestation or checkpoint.
    /// @dev `roots[i]` belongs to block `queryHeight + i`. Digests are recomputed
    ///      on chain from the roots, which is why only the roots travel in calldata.
    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Emitted by the state-changing variants on every proven transaction.
    /// @dev Measured on the live testnet on 2026-08-19: emitting this event cost
    ///      nothing, because the inspected precompile path stored the log without
    ///      charging for it. That is a measurement, not a pricing rule. The
    ///      Creditcoin Team's preliminary position (2026-08-20) is that the LOG3
    ///      should be charged, roughly 1,756 gas per event, so a budget for
    ///      `verifyAndEmit` must tolerate that increase. Cr3dX itself calls
    ///      `verify`. See docs/ATTESTCOIN_INTEGRATION.md, finding F-1.
    event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);

    /// @notice Verifies one transaction. Returns `true` or reverts.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Verifies up to ten heights against one shared continuity proof.
    /// @dev The shared proof must span `[min(heights), max(heights)]`. Eleven
    ///      heights are rejected; the bound was confirmed on the live network.
    function verify(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata sharedContinuityProof
    ) external view returns (bool);

    /// @notice As `verify`, but emits `TransactionVerified` on success.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);

    /// @notice As the batch `verify`, but emits one event per proven transaction.
    function verifyAndEmit(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata sharedContinuityProof
    ) external returns (bool);

    /// @notice Reconstructs the transaction index from the Merkle path.
    /// @dev Pure arithmetic over the siblings. It reads no state and is not tied
    ///      to any previous `verify`, which is exactly why the result is only
    ///      meaningful after `verify` has succeeded on the *same* proof. Calling
    ///      it first yields an index derived from arbitrary input.
    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64);
}
