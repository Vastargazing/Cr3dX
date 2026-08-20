// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IChainInfo} from "../../contracts/interfaces/IChainInfo.sol";

/// @notice Stand-in for the Attestcoin ChainInfo precompile, etched at its real
///         address so that the contracts under test make exactly the call they
///         will make in production.
///
/// @dev Test infrastructure. It reproduces one behaviour faithfully and stubs
///      the rest: the attested source height is whatever a test set, and
///      `exists` is false until a test sets one. That second part matters. A
///      freshly registered source chain genuinely has no attested height, and a
///      contract that read the zero it returns would treat every deadline as
///      already passed.
///
///      Everything else answers with empty structures. Nothing in Cr3dX reads
///      them, and a mock that pretended to would invite somebody to start.
contract MockChainInfo is IChainInfo {
    mapping(uint64 => uint64) public heightOf;
    mapping(uint64 => bool) public hasHeightOf;

    function setAttestedHeight(uint64 chainKey, uint64 height) external {
        heightOf[chainKey] = height;
        hasHeightOf[chainKey] = true;
    }

    function clearAttestedHeight(uint64 chainKey) external {
        heightOf[chainKey] = 0;
        hasHeightOf[chainKey] = false;
    }

    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result)
    {
        result.height = heightOf[chainKey];
        result.hash = keccak256(abi.encode("attestation", chainKey, heightOf[chainKey]));
        result.isAttestation = true;
        result.exists = hasHeightOf[chainKey];
    }

    // ------------------------------------------------------------------
    // deliberately inert
    // ------------------------------------------------------------------

    function get_supported_chains() external pure returns (ChainInfo[] memory chains) {
        chains = new ChainInfo[](0);
    }

    function get_chain_by_key(uint64) external pure returns (ChainInfoResult memory result) {
        return result;
    }

    function get_attestation_genesis_height(uint64) external pure returns (uint64) {
        return 0;
    }

    function get_latest_checkpoint_height_and_hash(uint64)
        external
        pure
        returns (HeightHashResult memory result)
    {
        return result;
    }

    function is_height_attested(uint64 chainKey, uint64 targetHeight) external view returns (bool) {
        return hasHeightOf[chainKey] && targetHeight <= heightOf[chainKey];
    }

    function get_attestation_bounds(uint64, uint64) external pure returns (BoundsCheckResult memory result) {
        return result;
    }

    function get_attestation_height_for_digest(uint64, bytes32)
        external
        pure
        returns (HeightResult memory result)
    {
        return result;
    }

    function get_checkpoint_for_height(uint64, uint64) external pure returns (HashResult memory result) {
        return result;
    }
}
