// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentVault} from "../../src/IAgentVault.sol";
import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice The headline use case: the agent deploys the REAL ProposalRegistry from the vault, with constructor
///         arguments (owner, proposer, cap) fixed by the owner at allowlist time.
contract VaultRegistryDeployTest is VaultBase {
    address internal registryOwner = makeAddr("registryOwner");
    address internal registryProposer = makeAddr("registryProposer");

    function _registryInit(address o, address p, uint256 cap) internal pure returns (bytes memory) {
        return abi.encodePacked(type(ProposalRegistry).creationCode, abi.encode(o, p, cap));
    }

    function test_agentDeploysRegistry_withOwnerFixedArgs() public {
        _setDefaultMandate();
        bytes memory init = _registryInit(registryOwner, registryProposer, 123 ether);
        bytes32 id = _allow(init);
        bytes32 salt = keccak256("registry-1");

        assertEq(vault.previewDeploy(id, salt), bytes4(0));
        address predicted = vault.predictAddress(id, salt);
        vm.prank(agent);
        address reg = vault.deploy(id, salt, init);
        assertEq(reg, predicted);

        // Same runtime bytes as the build artifact, owner/proposer/cap exactly as the OWNER fixed them.
        assertEq(reg.code, type(ProposalRegistry).runtimeCode, "runtime code == ProposalRegistry artifact");
        IProposalRegistry.Config memory c = ProposalRegistry(reg).config();
        assertEq(c.owner, registryOwner);
        assertEq(c.proposer, registryProposer);
        assertEq(c.maxSpendCap, 123 ether);
        assertTrue(c.owner != agent && c.proposer != agent, "the agent controls nothing it deployed");
        assertTrue(c.owner != address(vault), "the vault does not own it either");
    }

    function test_agent_cannotDeployRegistryWithItselfAsOwner() public {
        _setDefaultMandate();
        _allow(_registryInit(registryOwner, registryProposer, 123 ether));
        // Same code, different constructor args => different initcode hash => not allowlisted.
        bytes memory evil = _registryInit(agent, agent, 123 ether);
        bytes32 evilId = keccak256(evil);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.TemplateNotAllowed.selector);
        vault.deploy(evilId, 0, evil);

        // Claiming the allowlisted id while submitting different args is a code mismatch.
        bytes32 goodId = keccak256(_registryInit(registryOwner, registryProposer, 123 ether));
        vm.prank(agent);
        vm.expectRevert(IAgentVault.CodeMismatch.selector);
        vault.deploy(goodId, 0, evil);
        assertEq(vault.usage().deploys, 0);
    }
}
