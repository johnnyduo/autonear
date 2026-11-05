// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProposalRegistry} from "../src/ProposalRegistry.sol";
import {Script, console} from "forge-std/Script.sol";

/// @notice Deploys ProposalRegistry v1.
/// @dev Environment:
///        OWNER              required. Registry owner; a multisig on any real network.
///        PROPOSER           required. The AutoNEAR agent account that may propose / cancel its own Pending proposals.
///        MAX_SPEND_CAP      optional. Per-proposal cap in the target asset's base units. Unset or 0 selects
///                           the contract default (1,000,000 * 1e18).
///        I_UNDERSTAND_MAINNET   must be exactly "yes" to deploy on a known mainnet chain id.
///
///      Signing: this script calls `vm.startBroadcast()` with NO key. The signer comes from the forge CLI
///      (`--private-key`, `--account <keystore>`, `--ledger`, `--trezor`, or `--sender` for a dry run). No key is
///      ever read from a file by this script, and none may be committed.
///
///        forge script script/Deploy.s.sol --rpc-url $RPC --account deployer --broadcast
contract Deploy is Script {
    error MainnetRefused(uint256 chainId);
    error MissingEnv(string name);

    function run() external returns (ProposalRegistry) {
        address owner = vm.envOr("OWNER", address(0));
        address proposer = vm.envOr("PROPOSER", address(0));
        uint256 cap = vm.envOr("MAX_SPEND_CAP", uint256(0));
        return deployWith(owner, proposer, cap, _confirmed());
    }

    /// @notice Env-free entry point (used by tests). `mainnetConfirmed` mirrors I_UNDERSTAND_MAINNET=yes.
    function deployWith(address owner, address proposer, uint256 cap, bool mainnetConfirmed)
        public
        returns (ProposalRegistry registry)
    {
        if (_isKnownMainnet(block.chainid) && !mainnetConfirmed) revert MainnetRefused(block.chainid);
        if (owner == address(0)) revert MissingEnv("OWNER");
        if (proposer == address(0)) revert MissingEnv("PROPOSER");

        vm.startBroadcast();
        registry = new ProposalRegistry(owner, proposer, cap);
        vm.stopBroadcast();

        console.log("ProposalRegistry deployed");
        console.log("  chainId   ", block.chainid);
        console.log("  address   ", address(registry));
        console.log("  owner     ", owner);
        console.log("  proposer  ", proposer);
        console.log("  maxSpendCap", registry.config().maxSpendCap);
        console.log("  codehash  ", vm.toString(address(registry).codehash));
    }

    function _confirmed() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("I_UNDERSTAND_MAINNET", string("")))) == keccak256("yes");
    }

    /// @dev Chain ids of production networks. Anything else (anvil 31337, testnets) deploys without the flag.
    function _isKnownMainnet(uint256 id) internal pure returns (bool) {
        return id == 1 // Ethereum
            || id == 10 // OP Mainnet
            || id == 56 // BNB Smart Chain
            || id == 100 // Gnosis
            || id == 137 // Polygon PoS
            || id == 250 // Fantom Opera
            || id == 324 // zkSync Era
            || id == 1101 // Polygon zkEVM
            || id == 5000 // Mantle
            || id == 8453 // Base
            || id == 34_443 // Mode
            || id == 42_161 // Arbitrum One
            || id == 42_170 // Arbitrum Nova
            || id == 42_220 // Celo
            || id == 43_114 // Avalanche C-Chain
            || id == 59_144 // Linea
            || id == 81_457 // Blast
            || id == 534_352 // Scroll
            || id == 7_777_777 // Zora
            || id == 1_313_161_554; // Aurora (NEAR EVM)
    }
}
