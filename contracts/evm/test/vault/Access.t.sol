// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice Who may call what. Every owner function vs non-owner, agent and pending owner; every agent function vs
///         owner and strangers; the agent can neither redirect nor withdraw funds.
contract VaultAccessTest is VaultBase {
    bytes32 internal id1;

    function setUp() public override {
        super.setUp();
        _setDefaultMandate();
        id1 = _allow(T1_INIT);
    }

    function _ownerCalls() internal view returns (bytes[] memory c) {
        c = new bytes[](8);
        c[0] = abi.encodeCall(vault.setMandate, (agent, T0 + 100, 1, 60, 1, 1, 0));
        c[1] = abi.encodeCall(vault.revoke, ());
        c[2] = abi.encodeCall(vault.pause, ());
        c[3] = abi.encodeCall(vault.unpause, ());
        c[4] = abi.encodeCall(vault.allowTemplate, (id1, "x", 0));
        c[5] = abi.encodeCall(vault.disallowTemplate, (id1));
        c[6] = abi.encodeCall(vault.withdraw, (1));
        c[7] = abi.encodeCall(vault.transferOwnership, (newOwner));
    }

    function _assertAllOwnerCallsRejectedFor(address who) internal {
        bytes[] memory calls = _ownerCalls();
        bytes32 before = _fingerprint();
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(who);
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            assertFalse(ok, "owner op must reject");
            assertEq(ret, abi.encodePacked(IAgentVault.Unauthorized.selector), "owner op: wrong error");
        }
        assertEq(_fingerprint(), before, "rejected owner ops changed state");
    }

    function test_ownerOps_rejectStranger() public {
        _assertAllOwnerCallsRejectedFor(other);
    }

    function test_ownerOps_rejectAgent() public {
        _assertAllOwnerCallsRejectedFor(agent);
    }

    function test_ownerOps_rejectPendingOwnerUntilAccepted() public {
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        _assertAllOwnerCallsRejectedFor(newOwner);
    }

    function test_ownerOps_rejectOldOwnerAfterAcceptance() public {
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        _assertAllOwnerCallsRejectedFor(owner);
        // ...and the new owner can do them.
        vm.prank(newOwner);
        vault.pause();
        assertTrue(vault.config().paused);
    }

    function test_ownerOps_rejectVaultItself() public {
        _assertAllOwnerCallsRejectedFor(address(vault));
    }

    function test_ownerOps_ownerSucceeds() public {
        bytes[] memory calls = _ownerCalls();
        // withdraw first-class path etc: run each as owner; none may report Unauthorized.
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            if (!ok) assertTrue(bytes4(ret) != IAgentVault.Unauthorized.selector, "owner got Unauthorized");
        }
    }

    function test_acceptOwnership_onlyPendingOwner() public {
        // Nothing pending: everyone, owner included, is Unauthorized.
        vm.prank(owner);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();
        vm.prank(address(0));
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();

        vm.prank(owner);
        vault.transferOwnership(newOwner);
        vm.prank(other);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();
        vm.prank(agent);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();
    }

    function test_agentOps_rejectOwnerAndStrangers() public {
        address[3] memory who = [owner, other, newOwner];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(IAgentVault.Unauthorized.selector);
            vault.draw(1);
            vm.prank(who[i]);
            vm.expectRevert(IAgentVault.Unauthorized.selector);
            vault.deploy(id1, bytes32(0), T1_INIT);
        }
    }

    function test_agentOps_noMandateBeatsUnauthorized() public {
        AgentVault f = new AgentVault(owner);
        vm.expectRevert(IAgentVault.NoMandate.selector);
        f.draw(1);
        vm.prank(owner);
        vm.expectRevert(IAgentVault.NoMandate.selector);
        f.deploy(id1, bytes32(0), T1_INIT);
    }

    function test_agent_cannotWithdraw_orChangeAnything() public {
        bytes32 before = _fingerprint();
        vm.startPrank(agent);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.withdraw(1);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.setMandate(agent, T0 + 100, 1000 ether, 60, 1000 ether, 1000 ether, 1000);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.transferOwnership(agent);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.allowTemplate(keccak256("evil"), "evil", 0);
        vm.stopPrank();
        assertEq(_fingerprint(), before);
    }

    function test_agent_drawPaysOnlyAgent_noOneElseGains() public {
        uint256 ownerBal = owner.balance;
        uint256 otherBal = other.balance;
        vm.prank(agent);
        vault.draw(1 ether);
        assertEq(agent.balance, 1 ether, "agent");
        assertEq(owner.balance, ownerBal, "owner");
        assertEq(other.balance, otherBal, "other");
        assertEq(address(vault).balance, 99 ether, "vault");
    }

    /// @dev Whatever the amount the agent asks for (or is refused), nobody but the agent's own address is paid.
    function testFuzz_agent_cannotRedirect(uint256 amount) public {
        uint256 ownerBal = owner.balance;
        uint256 otherBal = other.balance;
        uint256 newOwnerBal = newOwner.balance;
        uint256 vaultBal = address(vault).balance;
        vm.prank(agent);
        try vault.draw(amount) {
            assertEq(agent.balance, amount);
            assertEq(address(vault).balance, vaultBal - amount);
        } catch {
            assertEq(agent.balance, 0);
            assertEq(address(vault).balance, vaultBal);
        }
        assertEq(owner.balance, ownerBal);
        assertEq(other.balance, otherBal);
        assertEq(newOwner.balance, newOwnerBal);
    }

    function test_withdraw_paysOnlyOwner() public {
        vm.prank(owner);
        vault.withdraw(7 ether);
        assertEq(owner.balance, 7 ether);
        assertEq(agent.balance, 0);
        assertEq(other.balance, 0);
    }

    function test_receive_acceptsFromAnyone_andDoesNotChangeBudget() public {
        bytes32 usageBefore = keccak256(abi.encode(vault.usage(), vault.mandate()));
        vm.deal(other, 5 ether);
        vm.prank(other);
        (bool ok,) = address(vault).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 105 ether);
        assertEq(keccak256(abi.encode(vault.usage(), vault.mandate())), usageBefore);
    }

    function test_unknownSelector_orDataWithValue_reverts() public {
        vm.deal(other, 1 ether);
        vm.prank(other);
        (bool ok,) = address(vault).call{value: 1}(hex"deadbeef");
        assertFalse(ok, "no fallback");
        vm.prank(other);
        (ok,) = address(vault).call(hex"deadbeef");
        assertFalse(ok, "no fallback");
    }
}
