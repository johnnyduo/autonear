// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {Actor, ReentrantDeployee} from "./Mocks.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice A malicious agent / owner / template that tries to re-enter the vault while it is being paid or deployed.
contract VaultReentrancyTest is VaultBase {
    Actor internal evil;

    function setUp() public override {
        super.setUp();
        evil = new Actor();
        vm.prank(owner);
        vault.setMandate(address(evil), T0 + TTL, PER_DRAW, PERIOD_SECS, PERIOD_CAP, TOTAL_CAP, MAX_DEPLOYS);
    }

    function _evilDraw(uint256 amount) internal returns (bool ok, bytes memory ret) {
        return evil.exec(address(vault), abi.encodeCall(vault.draw, (amount)));
    }

    function test_maliciousAgent_reenterDraw_isBlocked_budgetNeverDoubleSpent() public {
        evil.arm(address(vault), abi.encodeCall(vault.draw, (1 ether)));
        (bool ok,) = _evilDraw(1 ether);
        assertTrue(ok, "outer draw succeeds");
        assertEq(evil.reentries(), 1, "receive() ran and tried to re-enter");
        assertFalse(evil.reOk(), "re-entrant draw must fail");
        assertEq(bytes4(evil.reRet()), IAgentVault.Reentrancy.selector);
        assertEq(vault.usage().totalSpent, 1 ether, "charged exactly once");
        assertEq(address(evil).balance, 1 ether);
        assertEq(address(vault).balance, 99 ether);
    }

    function test_maliciousAgent_reenterDeploy_isBlocked() public {
        bytes32 id = _allow(T1_INIT);
        evil.arm(address(vault), abi.encodeCall(vault.deploy, (id, bytes32(0), T1_INIT)));
        (bool ok,) = _evilDraw(1 ether);
        assertTrue(ok);
        assertFalse(evil.reOk());
        assertEq(bytes4(evil.reRet()), IAgentVault.Reentrancy.selector);
        assertEq(vault.usage().deploys, 0);
    }

    function test_maliciousAgent_reenterOwnerOps_isBlockedOrUnauthorized() public {
        bytes[3] memory attacks = [
            abi.encodeCall(vault.withdraw, (1 ether)),
            abi.encodeCall(
                vault.setMandate, (address(evil), T0 + 100, 100 ether, 60, 100 ether, 100 ether, 1000)
            ),
            abi.encodeCall(vault.transferOwnership, (address(evil)))
        ];
        for (uint256 i; i < attacks.length; ++i) {
            evil.arm(address(vault), attacks[i]);
            (bool ok,) = _evilDraw(1 ether);
            assertTrue(ok);
            assertFalse(evil.reOk());
            assertEq(bytes4(evil.reRet()), IAgentVault.Unauthorized.selector, "agent is not the owner");
            vm.warp(block.timestamp + PERIOD_SECS); // fresh period for the next draw
        }
        assertEq(vault.config().owner, owner);
        assertEq(vault.config().epoch, 1);
        assertEq(owner.balance, 0);
    }

    function test_maliciousAgent_revertingReceiver_drawFailsAtomically() public {
        evil.setMode(Actor.Mode.Revert);
        bytes32 before = _fingerprint();
        (bool ok, bytes memory ret) = _evilDraw(1 ether);
        assertFalse(ok);
        assertEq(bytes4(ret), IAgentVault.TransferFailed.selector);
        assertEq(_fingerprint(), before, "failed draw must not consume budget");
        assertEq(address(evil).balance, 0);
    }

    function test_lockIsReleased_afterReentryAttempt_andAfterRevert() public {
        evil.arm(address(vault), abi.encodeCall(vault.draw, (1 ether)));
        _evilDraw(1 ether);
        evil.setMode(Actor.Mode.Accept);
        (bool ok,) = _evilDraw(1 ether); // would fail with Reentrancy if the lock were stuck
        assertTrue(ok);

        evil.setMode(Actor.Mode.Revert);
        (ok,) = _evilDraw(1 ether);
        assertFalse(ok);
        evil.setMode(Actor.Mode.Accept);
        (ok,) = _evilDraw(1 ether);
        assertTrue(ok, "lock released after a reverted call (transient storage rolls back)");
    }

    function test_ownerContract_reenterWithdraw_isBlocked() public {
        Actor ownerContract = new Actor();
        AgentVault v = new AgentVault(address(ownerContract));
        vm.deal(address(v), 10 ether);
        ownerContract.arm(address(v), abi.encodeCall(v.withdraw, (1 ether)));
        (bool ok,) = ownerContract.exec(address(v), abi.encodeCall(v.withdraw, (4 ether)));
        assertTrue(ok);
        assertFalse(ownerContract.reOk(), "nested withdraw must fail");
        assertEq(bytes4(ownerContract.reRet()), IAgentVault.Reentrancy.selector);
        assertEq(address(ownerContract).balance, 4 ether, "owner got exactly one payout");
        assertEq(address(v).balance, 6 ether);
    }

    function test_ownerContract_reenterDraw_isBlocked() public {
        Actor ownerContract = new Actor();
        AgentVault v = new AgentVault(address(ownerContract));
        vm.deal(address(v), 10 ether);
        // Owner also happens to be its own agent: the tightest re-entry for draw-from-withdraw.
        (bool ok,) = ownerContract.exec(
            address(v),
            abi.encodeCall(v.setMandate, (address(ownerContract), T0 + 100, 1 ether, 60, 5 ether, 5 ether, 0))
        );
        assertTrue(ok);
        ownerContract.arm(address(v), abi.encodeCall(v.draw, (1 ether)));
        (ok,) = ownerContract.exec(address(v), abi.encodeCall(v.withdraw, (2 ether)));
        assertTrue(ok);
        assertFalse(ownerContract.reOk());
        assertEq(bytes4(ownerContract.reRet()), IAgentVault.Reentrancy.selector);
        assertEq(v.usage().totalSpent, 0);
    }

    function test_ownerContract_revertingReceiver_withdrawFailsAtomically() public {
        Actor ownerContract = new Actor();
        AgentVault v = new AgentVault(address(ownerContract));
        vm.deal(address(v), 10 ether);
        ownerContract.setMode(Actor.Mode.Revert);
        (bool ok, bytes memory ret) = ownerContract.exec(address(v), abi.encodeCall(v.withdraw, (1 ether)));
        assertFalse(ok);
        assertEq(bytes4(ret), IAgentVault.TransferFailed.selector);
        assertEq(address(v).balance, 10 ether);
    }

    /// @dev A template whose constructor tries to re-enter draw and deploy deploys only if both were rejected.
    function test_maliciousTemplate_constructorReentry_isBlocked() public {
        bytes memory init = abi.encodePacked(type(ReentrantDeployee).creationCode, abi.encode(address(vault)));
        bytes32 id = _allow(init);
        // The agent is `evil`, the contract under attack is called by it.
        (bool ok, bytes memory ret) =
            evil.exec(address(vault), abi.encodeCall(vault.deploy, (id, bytes32(0), init)));
        assertTrue(ok, string(ret));
        assertEq(vault.usage().deploys, 1);
        assertEq(vault.usage().totalSpent, 0);
    }
}
