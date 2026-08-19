// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProvenTransaction, ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";

/// @title ProvenTransactionFuzzTest
/// @notice Property tests for the decoder.
///
/// @dev The live fixtures prove the decoder works on the blobs the network
///      produced last Tuesday. These tests prove the two properties the verifier
///      actually depends on, across inputs no capture run would ever hit:
///
///      1. the receipt chunk is read from the end, so however many chunks
///         precede it and whatever they contain, the decoded status and logs are
///         unchanged;
///      2. nothing is lost or reordered on the way through, for any log shape.
///
///      Property 1 is the one worth stating loudly. It is what lets Cr3dX ignore
///      the transaction type entirely, and it is the assumption that would break
///      silently if the encoding ever gained a trailing chunk.
contract ProvenTransactionFuzzTest is Test {
    using ProvenTransaction for bytes;

    /// @notice Leading chunks are irrelevant, whatever they hold.
    function testFuzz_leadingChunksAreIgnored(
        uint8 txType,
        uint8 leadingChunks,
        bytes calldata noise,
        uint8 status,
        address emitter,
        bytes32 topic,
        bytes calldata logData
    ) public pure {
        uint256 leading = bound(leadingChunks, 0, 6);
        // Keep the blob small enough that the test stays about semantics rather
        // than about how much memory the fuzzer can talk us into allocating.
        bytes memory noiseBounded = noise.length > 512 ? noise[:512] : noise;
        bytes memory dataBounded = logData.length > 512 ? logData[:512] : logData;

        ProvenLog[] memory logs = new ProvenLog[](1);
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = topic;
        logs[0] = ProvenLog({emitter: emitter, topics: topics, data: dataBounded});

        bytes memory blob = _blob(txType, leading, noiseBounded, status, logs);

        (uint8 gotStatus, ProvenLog[] memory gotLogs) = blob.decodeReceipt();
        assertEq(gotStatus, status, "status must not depend on the leading chunks");
        assertEq(gotLogs.length, 1, "log count must not depend on the leading chunks");
        assertEq(gotLogs[0].emitter, emitter, "emitter must not depend on the leading chunks");
        assertEq(gotLogs[0].topics[0], topic, "topic must not depend on the leading chunks");
        assertEq(gotLogs[0].data, dataBounded, "data must not depend on the leading chunks");
    }

    /// @notice Every log survives, in order, for any number of logs.
    function testFuzz_logsRoundTrip(uint8 logCount, uint8 topicCount, bytes32 seed) public pure {
        uint256 n = bound(logCount, 0, 24);
        uint256 t = bound(topicCount, 0, 4);

        ProvenLog[] memory logs = new ProvenLog[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory topics = new bytes32[](t);
            for (uint256 j = 0; j < t; j++) {
                topics[j] = keccak256(abi.encode(seed, i, j));
            }
            logs[i] = ProvenLog({
                emitter: address(uint160(uint256(keccak256(abi.encode(seed, i))))),
                topics: topics,
                data: abi.encodePacked(seed, i)
            });
        }

        bytes memory blob = _blob(2, 2, hex"c0ffee", ProvenTransaction.STATUS_SUCCESS, logs);
        (, ProvenLog[] memory got) = blob.decodeReceipt();

        assertEq(got.length, n, "log count");
        for (uint256 i = 0; i < n; i++) {
            assertEq(got[i].emitter, logs[i].emitter, "emitter drifted");
            assertEq(got[i].topics.length, t, "topic count drifted");
            for (uint256 j = 0; j < t; j++) {
                assertEq(got[i].topics[j], logs[i].topics[j], "topic drifted");
            }
            assertEq(got[i].data, logs[i].data, "data drifted");
            assertEq(
                ProvenTransaction.topic0(got[i]),
                t == 0 ? bytes32(0) : logs[i].topics[0],
                "topic0 helper disagrees with the decoded topics"
            );
        }
    }

    /// @notice An envelope with no chunks is rejected rather than underflowing.
    function testFuzz_emptyChunkListAlwaysRejected(uint8 txType) public {
        bytes memory blob = abi.encode(txType, new bytes[](0));
        vm.expectRevert(ProvenTransaction.MalformedProvenTransaction.selector);
        this.decode(blob);
    }

    function decode(bytes memory blob) external pure returns (uint8, ProvenLog[] memory) {
        return ProvenTransaction.decodeReceipt(blob);
    }

    /// @notice Builds a blob in the protocol's layout: leading chunks of noise,
    ///         receipt chunk last.
    function _blob(
        uint8 txType,
        uint256 leadingChunks,
        bytes memory noise,
        uint8 status,
        ProvenLog[] memory logs
    ) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](leadingChunks + 1);
        for (uint256 i = 0; i < leadingChunks; i++) {
            chunks[i] = abi.encodePacked(noise, i);
        }
        // gasUsed and logsBloom are present in the real encoding and are decoded
        // positionally, so the fixture has to carry them even though Cr3dX drops
        // both on the floor.
        chunks[leadingChunks] = abi.encode(status, uint64(21000), logs, new bytes(256));
        return abi.encode(txType, chunks);
    }
}
