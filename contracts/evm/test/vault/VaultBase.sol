// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixture for the vault suites: a vault owned by `owner`, funded with 100 ether, and two tiny
///         initcode fixtures (the conformance file's abstract templates t1 and t2).
abstract contract VaultBase is Test {
    uint256 internal constant T0 = 1_700_000_000;

    /// @dev Initcode returning 1 byte of runtime code (0x01). Deploys successfully; value 0.
    bytes internal constant T1_INIT = hex"600160005360016000f3";
    /// @dev Same shape, runtime 0x02: a distinct template id.
    bytes internal constant T2_INIT = hex"600260005360016000f3";
    /// @dev Initcode that reverts with empty data (PUSH0 PUSH0 REVERT as 6000 6000 fd).
    bytes internal constant REVERTING_INIT = hex"60006000fd";

    AgentVault internal vault;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal other = makeAddr("other");
    address internal newOwner = makeAddr("newOwner");

    // Default mandate parameters.
    uint256 internal constant PER_DRAW = 1 ether;
    uint256 internal constant PERIOD_SECS = 1 days;
    uint256 internal constant PERIOD_CAP = 3 ether;
    uint256 internal constant TOTAL_CAP = 10 ether;
    uint256 internal constant MAX_DEPLOYS = 5;
    uint256 internal constant TTL = 7 days;

    function setUp() public virtual {
        vm.warp(T0);
        vault = new AgentVault(owner);
        vm.deal(address(vault), 100 ether);
    }

    function _setDefaultMandate() internal {
        vm.prank(owner);
        vault.setMandate(agent, T0 + TTL, PER_DRAW, PERIOD_SECS, PERIOD_CAP, TOTAL_CAP, MAX_DEPLOYS);
    }

    function _allow(bytes memory initcode) internal returns (bytes32 id) {
        id = keccak256(initcode);
        vm.prank(owner);
        vault.allowTemplate(id, "tpl", 0);
    }

    function _sel(string memory name) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(string.concat(name, "()"))));
    }

    function _deployAs(address who, bytes memory initcode, bytes32 salt) internal returns (address) {
        vm.prank(who);
        return vault.deploy(keccak256(initcode), salt, initcode);
    }

    /// @dev Everything observable except per-actor balances.
    function _fingerprint() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                vault.config(), vault.mandate(), vault.usage(), address(vault).balance, vault.templateCount()
            )
        );
    }
}
