// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../src/AgentVault.sol";
import {Script, console} from "forge-std/Script.sol";

/// @notice Deploys AutoNEAR Mandate Vault v1 (AgentVault). TESTNET ONLY: there is no mainnet path.
/// @dev Environment:
///        OWNER   required. The vault owner; a multisig on any real network. It is the ONLY address that can
///                set mandates, allowlist templates, pause or withdraw.
///
///      Nothing is sent unless the human adds `--broadcast`: without it `forge script` only SIMULATES (the
///      `vm.startBroadcast()` below is a no-op for the chain). Signing comes from the forge CLI
///      (`--private-key`, `--account <keystore>`, `--ledger`, `--trezor`, or `--sender` for a dry run); this
///      script never reads a key from any file or from the environment.
///
///        # dry run (no transaction is sent)
///        OWNER=0x... forge script script/DeployVault.s.sol --rpc-url $RPC --sender 0x...
///        # real deploy, only when the human decides to
///        OWNER=0x... forge script script/DeployVault.s.sol --rpc-url $RPC --account deployer --broadcast
///
///      Known production chain ids are refused outright (no override flag exists).
contract DeployVault is Script {
    error MainnetRefused(uint256 chainId);
    error MissingEnv(string name);

    function run() external returns (AgentVault) {
        return deployWith(vm.envOr("OWNER", address(0)));
    }

    /// @notice Env-free entry point (used by tests).
    function deployWith(address owner) public returns (AgentVault vault) {
        if (_isKnownMainnet(block.chainid)) revert MainnetRefused(block.chainid);
        if (owner == address(0)) revert MissingEnv("OWNER");

        vm.startBroadcast();
        vault = new AgentVault(owner);
        vm.stopBroadcast();

        console.log("AgentVault (Mandate Vault v1) deployed - TESTNET ONLY");
        console.log("  chainId   ", block.chainid);
        console.log("  address   ", address(vault));
        console.log("  owner     ", owner);
        console.log("  codehash  ", vm.toString(address(vault).codehash));
        console.log(
            "Next (owner): setMandate(...), allowTemplate(keccak256(initcode), label, 0), fund by plain transfer."
        );
    }

    /// @dev Chain ids of production networks. Anything else (anvil 31337, testnets) is allowed.
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
