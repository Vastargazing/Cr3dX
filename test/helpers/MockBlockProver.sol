// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBlockProver} from "../../contracts/interfaces/IBlockProver.sol";

/// @notice Stand-in for the Attestcoin BlockProver precompile, etched at its real
///         address so unit tests exercise the real call path.
///
/// @dev Test infrastructure. It does **not** check proofs, and no test here should
///      be read as evidence that a proof is valid. Proof validity is exercised
///      against the real precompile by `scripts/verify-live.ts`; what these tests
///      cover is everything the verifier does around it.
///
///      Two behaviours are reproduced faithfully, because the verifier is written
///      against them:
///
///      1. `verify` returns true or **reverts**, never false. A test therefore
///         cannot pass by exercising a failure branch the real precompile does
///         not have, and the verifier is not tempted to write one.
///      2. `calculateTxIndex` is pure arithmetic over the Merkle siblings. It
///         answers on any input, proven or not, which is exactly why calling it
///         before `verify` would produce a confident position derived from bytes
///         nobody vouched for.
///
///      Ordering is asserted by arming both calls to fail with distinguishable
///      messages: whichever message comes back names the call that ran first.
///      A `view` function cannot record anything, so this indirect route is the
///      only honest one.
contract MockBlockProver is IBlockProver {
    string internal constant VERIFY_FAILURE = "MockBlockProver: verify ran";
    string internal constant TX_INDEX_FAILURE = "MockBlockProver: calculateTxIndex ran";

    bool public verifyReverts;
    bool public txIndexReverts;
    uint64 public txIndexToReturn;

    function setVerifyReverts(bool value) external {
        verifyReverts = value;
    }

    function setTxIndexReverts(bool value) external {
        txIndexReverts = value;
    }

    function setTxIndex(uint64 value) external {
        txIndexToReturn = value;
    }

    function verifyFailureMessage() external pure returns (string memory) {
        return VERIFY_FAILURE;
    }

    function txIndexFailureMessage() external pure returns (string memory) {
        return TX_INDEX_FAILURE;
    }

    function verify(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        if (verifyReverts) revert(VERIFY_FAILURE);
        return true;
    }

    function verify(
        uint64,
        uint64[] calldata heights,
        bytes[] calldata,
        MerkleProof[] calldata,
        ContinuityProof calldata
    ) external view returns (bool) {
        // The precompile's own ceiling and its own message, confirmed live.
        if (heights.length > 10) revert("heights: Value is too large for length");
        if (verifyReverts) revert(VERIFY_FAILURE);
        return true;
    }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        if (verifyReverts) revert(VERIFY_FAILURE);
        return true;
    }

    function verifyAndEmit(
        uint64,
        uint64[] calldata,
        bytes[] calldata,
        MerkleProof[] calldata,
        ContinuityProof calldata
    ) external view returns (bool) {
        if (verifyReverts) revert(VERIFY_FAILURE);
        return true;
    }

    function calculateTxIndex(MerkleProof calldata) external view returns (uint64) {
        if (txIndexReverts) revert(TX_INDEX_FAILURE);
        return txIndexToReturn;
    }
}
