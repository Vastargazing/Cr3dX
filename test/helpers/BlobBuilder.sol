// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ProvenLog} from "../../contracts/libraries/ProvenTransaction.sol";

/// @notice Builds transaction blobs in the Attestcoin encoding, for tests.
///
/// @dev The layout is the one confirmed against the live network and against
///      `usc-abi-encoding` 0.5.0: `abi.encode(uint8 txType, bytes[] chunks)` with
///      the receipt chunk last, whatever the transaction type. Leading chunks
///      carry the transaction fields, which Cr3dX never reads, so tests fill them
///      with noise on purpose: if the verifier ever started depending on them,
///      these tests would break.
library BlobBuilder {
    /// @param txType Transaction type. Varied across tests to show it is ignored.
    /// @param leadingChunks How many chunks precede the receipt chunk. Real blobs
    ///        carry two or three depending on the transaction type.
    function build(uint8 txType, uint256 leadingChunks, uint8 status, ProvenLog[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory chunks = new bytes[](leadingChunks + 1);
        for (uint256 i = 0; i < leadingChunks; i++) {
            // Noise standing in for nonce, gasLimit, from, to, value, input and
            // the signature. `from` lives in here, and nothing in Cr3dX may read
            // it, so it is deliberately not a real address.
            chunks[i] = abi.encode(keccak256(abi.encode("chunk", i)), uint256(i));
        }
        // gasUsed and logsBloom are present in the real encoding and are decoded
        // positionally. gasUsed is not covered by Ethereum's canonical receipt
        // root, so Cr3dX drops it; it still has to be in the bytes.
        chunks[leadingChunks] = abi.encode(status, uint64(21_000), logs, new bytes(256));
        return abi.encode(txType, chunks);
    }

    /// @notice Convenience for the common shape: EIP-1559, three chunks, success.
    function buildSuccessful(ProvenLog[] memory logs) internal pure returns (bytes memory) {
        return build(2, 2, 1, logs);
    }

    /// @notice Converts recorded EVM logs into the decoder's log shape.
    /// @dev Lets a test drive the real gateway, capture what it really emitted,
    ///      and feed exactly that through the verifier. Nothing about the events
    ///      is restated by hand along the way.
    function fromRecorded(Vm.Log[] memory recorded) internal pure returns (ProvenLog[] memory out) {
        out = new ProvenLog[](recorded.length);
        for (uint256 i = 0; i < recorded.length; i++) {
            out[i] =
                ProvenLog({emitter: recorded[i].emitter, topics: recorded[i].topics, data: recorded[i].data});
        }
    }
}
