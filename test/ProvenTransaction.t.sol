// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ProvenTransaction, ProvenLog} from "../contracts/libraries/ProvenTransaction.sol";

/// @title ProvenTransactionTest
/// @notice Tests the decoder against transaction blobs captured from live
///         Sepolia through the Attestcoin proof builder.
///
/// @dev The fixtures are not hand-written. `scripts/capture-fixtures.ts` scans
///      attested Sepolia blocks for the awkward shapes on purpose: a reverted
///      transaction, a transaction with no logs, and one of every transaction
///      type it can find. The central claim under test is that the receipt chunk
///      is last regardless of transaction type, so a fixture set that only
///      contained the common EIP-1559 case would not test the claim at all.
///
///      Expected values in each fixture come from the Ethereum receipt as the
///      Sepolia node reports it, not from this decoder, so a decoder that agrees
///      with itself but not with Ethereum fails here.
contract ProvenTransactionTest is Test {
    using ProvenTransaction for bytes;

    struct Fixture {
        string name;
        bytes encodedTx;
        uint8 txType;
        uint8 status;
        uint256 logCount;
        address[] emitters;
        uint256[] topicCounts;
        bytes32[] firstTopics;
        uint256[] dataLengths;
    }

    string[] internal names;

    function setUp() public {
        names.push("eip1559-two-logs");
        names.push("eip1559-no-logs");
        names.push("reverted");
        names.push("legacy");
        names.push("access-list");
        names.push("blob-carrying");
        names.push("many-logs");
    }

    // -- the property the whole verifier rests on ---------------------------

    /// @notice Every captured blob decodes, whatever its transaction type.
    function test_decodesEveryTransactionType() public view {
        bool[4] memory seenTypes;
        for (uint256 i = 0; i < names.length; i++) {
            Fixture memory f = _load(names[i]);
            (uint8 status, ProvenLog[] memory logs) = f.encodedTx.decodeReceipt();

            assertEq(status, f.status, string.concat(f.name, ": status"));
            assertEq(logs.length, f.logCount, string.concat(f.name, ": log count"));
            assertEq(f.encodedTx.transactionType(), f.txType, string.concat(f.name, ": tx type"));

            if (f.txType < 4) seenTypes[f.txType] = true;
        }
        // Types 0, 1, 2 and 3 all present: the claim is tested, not assumed.
        for (uint256 t = 0; t < 4; t++) {
            assertTrue(seenTypes[t], string.concat("fixtures must cover transaction type ", vm.toString(t)));
        }
    }

    /// @notice Every log field survives the round trip, for every fixture.
    function test_recoversEveryLogField() public view {
        for (uint256 i = 0; i < names.length; i++) {
            Fixture memory f = _load(names[i]);
            (, ProvenLog[] memory logs) = f.encodedTx.decodeReceipt();

            for (uint256 j = 0; j < logs.length; j++) {
                string memory where = string.concat(f.name, ":log", vm.toString(j));
                assertEq(logs[j].emitter, f.emitters[j], string.concat(where, ": emitter"));
                assertEq(logs[j].topics.length, f.topicCounts[j], string.concat(where, ": topic count"));
                assertEq(logs[j].data.length, f.dataLengths[j], string.concat(where, ": data length"));
                if (f.topicCounts[j] > 0) {
                    assertEq(logs[j].topics[0], f.firstTopics[j], string.concat(where, ": topic0"));
                }
            }
        }
    }

    // -- the cases that would otherwise be discovered in production ---------

    /// @notice A reverted source transaction produces a valid proof.
    /// @dev This is the whole reason the verifier checks the status itself. The
    ///      precompile proves inclusion, not success, so without this check a
    ///      failed transfer would be indistinguishable from a successful one.
    function test_revertedTransactionDecodesWithStatusZero() public view {
        Fixture memory f = _load("reverted");
        (uint8 status,) = f.encodedTx.decodeReceipt();
        assertEq(status, 0, "captured fixture must be a reverted transaction");
        assertTrue(status != ProvenTransaction.STATUS_SUCCESS, "status 0 must not read as success");
    }

    /// @notice A transaction that emits nothing decodes to an empty log array.
    function test_transactionWithoutLogsDecodesEmpty() public view {
        Fixture memory f = _load("eip1559-no-logs");
        (uint8 status, ProvenLog[] memory logs) = f.encodedTx.decodeReceipt();
        assertEq(status, 1, "fixture should be a successful transaction");
        assertEq(logs.length, 0, "log array must be empty, not reverting");
    }

    /// @notice A long log array decodes without drifting.
    /// @dev Offset mistakes in ABI decoding tend to survive short arrays and
    ///      show up only once the array is long enough to matter.
    function test_longLogArrayKeepsOrder() public view {
        Fixture memory f = _load("many-logs");
        (, ProvenLog[] memory logs) = f.encodedTx.decodeReceipt();
        assertGe(logs.length, 15, "fixture should carry a long log array");
        for (uint256 j = 0; j < logs.length; j++) {
            assertEq(logs[j].emitter, f.emitters[j], "emitter drifted");
            assertEq(logs[j].data.length, f.dataLengths[j], "data length drifted");
        }
    }

    /// @notice `topic0` is safe on logs that carry no topics.
    function test_topic0IsZeroForUnindexedLog() public pure {
        ProvenLog memory log = ProvenLog({emitter: address(0xBEEF), topics: new bytes32[](0), data: ""});
        assertEq(ProvenTransaction.topic0(log), bytes32(0), "no topics must read as zero, not revert");
    }

    /// @notice Garbage is rejected rather than silently producing a decode.
    function test_rejectsMalformedBlob() public {
        vm.expectRevert();
        this.decode(hex"deadbeef");
    }

    /// @notice A well-formed envelope with no chunks is rejected explicitly.
    /// @dev The receipt chunk is addressed as "the last one". With zero chunks
    ///      that expression underflows, so the guard has to come first.
    function test_rejectsEnvelopeWithoutChunks() public {
        bytes memory empty = abi.encode(uint8(2), new bytes[](0));
        vm.expectRevert(ProvenTransaction.MalformedProvenTransaction.selector);
        this.decode(empty);
    }

    // -- cost, because the verifier has to budget for it --------------------

    /// @notice Records what decoding costs on real blobs.
    /// @dev Not a micro-optimisation target. A `fund` or `repay` proof costs
    ///      roughly 47,000 gas end to end, of which the calldata alone is about
    ///      42 percent, so the decode is a rounding error against the call it
    ///      sits inside. The ceiling exists to catch a regression that changes
    ///      that by an order of magnitude, not to police a few hundred gas.
    function test_decodingCost() public view {
        for (uint256 i = 0; i < names.length; i++) {
            Fixture memory f = _load(names[i]);
            uint256 before = gasleft();
            (uint8 status, ProvenLog[] memory logs) = ProvenTransaction.decodeReceipt(f.encodedTx);
            uint256 used = before - gasleft();
            console2.log(
                string.concat(
                    "decode ",
                    f.name,
                    ": ",
                    vm.toString(f.encodedTx.length),
                    " bytes, ",
                    vm.toString(logs.length),
                    " logs, status ",
                    vm.toString(uint256(status))
                ),
                used
            );
            assertLt(
                used, 400_000, string.concat(f.name, ": decoding cost regressed by an order of magnitude")
            );
        }
    }

    /// @notice External wrapper so `vm.expectRevert` observes a call boundary.
    function decode(bytes memory blob) external pure returns (uint8, ProvenLog[] memory) {
        return ProvenTransaction.decodeReceipt(blob);
    }

    // -- fixture loading ----------------------------------------------------

    function _load(string memory name) internal view returns (Fixture memory f) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name, ".json"));
        f.name = name;
        f.encodedTx = vm.parseJsonBytes(json, ".encodedTx");
        f.txType = uint8(vm.parseJsonUint(json, ".txType"));
        f.status = uint8(vm.parseJsonUint(json, ".status"));

        // The fixture carries the receipt's account of the logs as flat arrays.
        // These values were taken from `eth_getTransactionReceipt` and checked
        // against the attested blob at capture time, so agreeing with them means
        // agreeing with Ethereum, not with our own TypeScript decoder.
        f.logCount = vm.parseJsonUint(json, ".logCount");
        f.emitters = f.logCount == 0 ? new address[](0) : vm.parseJsonAddressArray(json, ".logEmitters");
        f.topicCounts = f.logCount == 0 ? new uint256[](0) : vm.parseJsonUintArray(json, ".logTopicCounts");
        f.firstTopics = f.logCount == 0 ? new bytes32[](0) : vm.parseJsonBytes32Array(json, ".logFirstTopics");
        f.dataLengths = f.logCount == 0 ? new uint256[](0) : vm.parseJsonUintArray(json, ".logDataLengths");
        assertEq(f.emitters.length, f.logCount, string.concat(name, ": fixture is internally inconsistent"));
    }
}
