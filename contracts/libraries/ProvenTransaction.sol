// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice One log of a proven source transaction.
/// @dev Layout matches `tuple(address,bytes32[],bytes)` inside the receipt chunk.
struct ProvenLog {
    address emitter;
    bytes32[] topics;
    bytes data;
}

/// @title ProvenTransaction
/// @notice Decodes the encoded transaction blob that the Attestcoin BlockProver
///         precompile proves, down to the two things Cr3dX is allowed to trust:
///         the receipt status and the full list of logs.
///
/// @dev **Layout.** The blob is not RLP. It is
///
///          abi.encode(uint8 txType, bytes[] chunks)
///
///      where the chunk composition depends on the transaction type, but the
///      receipt chunk is **always the last one** and always has the same shape:
///
///          abi.encode(uint8 status, uint64 gasUsed, ProvenLog[] logs, bytes logsBloom)
///
///      So a consumer that only needs the status and the logs never branches on
///      the transaction type. Verified against live Sepolia blobs of types 0, 1,
///      2 and 3 in `test/ProvenTransaction.t.sol`.
///
/// @dev **Why this decoder never touches `from` or `gasUsed`.** Those two fields
///      are covered by the attestors' signature but *not* by the canonical
///      Ethereum transaction and receipt roots: `from` comes from the RPC
///      wrapper rather than the signed envelope, and the receipt root commits
///      `cumulativeGasUsed`, not the per-transaction `gasUsed`. Calling them
///      "proven" would overstate the guarantee, so Cr3dX never lets them reach
///      any decision. `from` lives in a chunk this decoder does not open, and
///      `gasUsed` is decoded only because ABI decoding is positional, then
///      dropped on the floor. The rule is enforced by the shape of this
///      function rather than by anyone remembering it.
///
/// @dev **Ordering.** This library is pure and will happily decode any bytes,
///      including bytes nobody proved. It must only ever be called on a blob
///      that `IBlockProver.verify` has already accepted. `verify` first, decode
///      second; there is no shortcut, and a decoded blob carries no authority of
///      its own.
library ProvenTransaction {
    /// @notice The blob is not a well-formed encoded transaction.
    error MalformedProvenTransaction();

    /// @notice Receipt status of a successful source transaction.
    uint8 internal constant STATUS_SUCCESS = 1;

    /// @notice Extracts the receipt status and every log of a proven transaction.
    /// @param encodedTx The blob passed to and accepted by `IBlockProver.verify`.
    /// @return status The receipt status. The precompile does not check it; the
    ///         caller must. A reverted source transaction produces a valid proof
    ///         with `status == 0`.
    /// @return logs Every log of the transaction, in emission order. Callers must
    ///         walk all of them: a single transaction can carry more than one
    ///         event of interest, and stopping at the first one silently drops
    ///         facts that were paid for and proven.
    function decodeReceipt(bytes memory encodedTx)
        internal
        pure
        returns (uint8 status, ProvenLog[] memory logs)
    {
        bytes[] memory chunks;
        // The whole blob is copied into memory here. That is the price of using
        // the compiler's decoder, which validates offsets and lengths, instead of
        // hand-rolled assembly that would not. The blob is bounded in practice by
        // what a caller can afford in calldata gas, so the copy is self-limiting.
        (, chunks) = abi.decode(encodedTx, (uint8, bytes[]));
        if (chunks.length == 0) revert MalformedProvenTransaction();

        // gasUsed is decoded because ABI decoding is positional, and discarded
        // because it is not covered by the canonical receipt root.
        (status,, logs,) = abi.decode(chunks[chunks.length - 1], (uint8, uint64, ProvenLog[], bytes));
    }

    /// @notice Transaction type of a proven transaction.
    /// @dev Not used in any Cr3dX decision. Exposed for diagnostics and to let
    ///      tests assert that decoding is genuinely type-independent.
    function transactionType(bytes memory encodedTx) internal pure returns (uint8 txType) {
        (txType,) = abi.decode(encodedTx, (uint8, bytes[]));
    }

    /// @notice First topic of a log, or zero if the log is unindexed.
    /// @dev Anonymous events and logs with no topics exist. Indexing `topics[0]`
    ///      directly would revert on them, turning a log Cr3dX does not care
    ///      about into a failure of the whole submission.
    function topic0(ProvenLog memory log) internal pure returns (bytes32) {
        if (log.topics.length == 0) return bytes32(0);
        return log.topics[0];
    }
}
