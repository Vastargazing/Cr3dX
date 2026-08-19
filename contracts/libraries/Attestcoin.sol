// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBlockProver} from "../interfaces/IBlockProver.sol";
import {IChainInfo} from "../interfaces/IChainInfo.sol";

/// @title Attestcoin
/// @notice Addresses of the Attestcoin Protocol precompiles.
/// @dev Source: `runtime/src/precompiles.rs` on gluwa/creditcoin3. The addresses
///      are identical on testnet, devnet and mainnet.
///
///      Note what is deliberately absent: `chainKey`. It is runtime state of the
///      registry, differs from the source chain's EVM chain id, and is a
///      constructor argument of every Cr3dX contract that needs it.
library Attestcoin {
    IBlockProver internal constant BLOCK_PROVER = IBlockProver(0x0000000000000000000000000000000000000FD2);

    IChainInfo internal constant CHAIN_INFO = IChainInfo(0x0000000000000000000000000000000000000fD3);
}
