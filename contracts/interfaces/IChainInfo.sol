// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IChainInfo
/// @notice The Attestcoin Protocol ChainInfo precompile.
/// @dev Transcribed from `precompiles/metadata/sol/chain_info.sol` on
///      gluwa/creditcoin3 at commit 06657e9. Function names are snake_case
///      upstream and are reproduced verbatim, because they determine the selectors.
///
///      This precompile is the only clock Cr3dX is allowed to read. Creditcoin's
///      own `block.number` and `block.timestamp` say nothing about the source
///      chain and must never be used to judge a source-chain deadline.
interface IChainInfo {
    /// @param chainKey Creditcoin's internal identifier for the source chain.
    /// @param chainId The source chain's own EIP-155 chain id.
    /// @dev The two are unrelated. `chainKey` is assigned in registration order
    ///      by the registry and must be resolved from it, never hard-coded from
    ///      a known EVM chain id.
    struct ChainInfo {
        uint64 chainKey;
        uint64 chainId;
        bytes chainName;
        uint8 chainEncoding;
    }

    struct ChainInfoResult {
        ChainInfo info;
        bool exists;
    }

    struct HeightResult {
        uint64 height;
        bool exists;
    }

    struct HashResult {
        bytes32 hash;
        bool exists;
    }

    /// @param hash The Attestcoin continuity digest, *not* the source block hash.
    /// @dev The field name is misleading. The source header hash is signed by the
    ///      attestors but is not exposed through this precompile.
    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    struct BoundsCheckResult {
        uint64 parentHeight;
        bytes32 parentHash;
        bool parentIsAttestation;
        uint64 childHeight;
        bytes32 childHash;
        bool childIsAttestation;
        bool isAttested;
    }

    function get_supported_chains() external view returns (ChainInfo[] memory chains);

    function get_chain_by_key(uint64 chainKey) external view returns (ChainInfoResult memory result);

    function get_attestation_genesis_height(uint64 chainKey) external view returns (uint64 genesisHeight);

    /// @notice Highest source height attested so far, read synchronously.
    /// @dev Trails the source chain head on purpose, so that the attestation
    ///      chain is never built on blocks that could still be reorganised. The
    ///      lag is not constant and can close in bulk; see `attestationGracePeriod`.
    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);

    function get_latest_checkpoint_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);

    function is_height_attested(uint64 chainKey, uint64 targetHeight) external view returns (bool isAttested);

    function get_attestation_bounds(uint64 chainKey, uint64 targetHeight)
        external
        view
        returns (BoundsCheckResult memory result);

    function get_attestation_height_for_digest(uint64 chainKey, bytes32 digest)
        external
        view
        returns (HeightResult memory);

    function get_checkpoint_for_height(uint64 chainKey, uint64 height)
        external
        view
        returns (HashResult memory);
}
