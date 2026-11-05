// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice Every mutation emits its event with exact topics and data; failed calls emit nothing.
contract VaultEventsTest is VaultBase {
    function test_constructor_emitsOwnershipTransferred() public {
        vm.expectEmit(true, true, false, true);
        emit IAgentVault.OwnershipTransferred(address(0), owner);
        new AgentVault(owner);
    }

    function test_receive_emitsDeposited() public {
        vm.deal(other, 3 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.Deposited(other, 3 ether);
        vm.prank(other);
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
    }

    function test_setMandate_emitsMandateSet() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.MandateSet(
            1,
            agent,
            uint64(T0 + TTL),
            PER_DRAW,
            uint64(PERIOD_SECS),
            PERIOD_CAP,
            TOTAL_CAP,
            uint32(MAX_DEPLOYS),
            uint64(T0)
        );
        _setDefaultMandate();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.MandateSet(2, other, uint64(T0 + 100), 1, 60, 2, 3, 0, uint64(T0));
        vm.prank(owner);
        vault.setMandate(other, T0 + 100, 1, 60, 2, 3, 0);
    }

    function test_revoke_pause_unpause_emit() public {
        _setDefaultMandate();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.MandateRevoked(1, owner);
        vm.prank(owner);
        vault.revoke();

        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.VaultPaused(owner);
        vm.prank(owner);
        vault.pause();

        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.VaultUnpaused(owner);
        vm.prank(owner);
        vault.unpause();
    }

    function test_templates_emit() public {
        bytes32 id = keccak256(T1_INIT);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.TemplateAllowed(id, "registry-v1", 0);
        vm.prank(owner);
        vault.allowTemplate(id, "registry-v1", 0);

        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.TemplateDisallowed(id);
        vm.prank(owner);
        vault.disallowTemplate(id);
    }

    function test_draw_emitsDrawn() public {
        _setDefaultMandate();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.Drawn(1, agent, 1 ether, 1 ether, 1 ether);
        vm.prank(agent);
        vault.draw(1 ether);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.Drawn(1, agent, 0.5 ether, 1.5 ether, 1.5 ether);
        vm.prank(agent);
        vault.draw(0.5 ether);
    }

    function test_deploy_emitsDeployed() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        bytes32 salt = keccak256("s");
        address target = vault.predictAddress(id, salt);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IAgentVault.Deployed(1, id, target, salt, 1);
        vm.prank(agent);
        vault.deploy(id, salt, T1_INIT);
    }

    function test_withdraw_emitsWithdrawn() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentVault.Withdrawn(owner, 2 ether);
        vm.prank(owner);
        vault.withdraw(2 ether);
    }

    function test_ownershipTransfer_emits() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentVault.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
    }

    function test_failedCalls_emitNothing() public {
        _setDefaultMandate();
        vm.recordLogs();
        vm.prank(agent);
        (bool ok,) = address(vault).call(abi.encodeCall(vault.draw, (0)));
        assertFalse(ok);
        vm.prank(other);
        (ok,) = address(vault).call(abi.encodeCall(vault.pause, ()));
        assertFalse(ok);
        assertEq(vm.getRecordedLogs().length, 0);
    }
}
