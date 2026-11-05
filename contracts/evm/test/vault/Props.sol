// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {VaultHandler} from "./Handler.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The vault's safety properties, shared by the stateful invariant suite and the stateless sequence fuzzer.
abstract contract VaultProps is Test {
    AgentVault internal vault;
    VaultHandler internal handler;
    bytes32 internal initialCodehash;

    uint256 internal constant INITIAL_FUNDING = 50 ether;

    function _deployWorld() internal {
        vm.warp(1_700_000_000);
        address[2] memory owners = [makeAddr("hOwner0"), makeAddr("hOwner1")];
        vault = new AgentVault(owners[0]);
        vm.deal(address(vault), INITIAL_FUNDING);
        initialCodehash = address(vault).codehash;
        handler = new VaultHandler(vault, owners, INITIAL_FUNDING);
    }

    function _checkAll() internal view {
        _budgetNeverExceeded();
        _ghostAccounting();
        _conservation();
        _deploysBounded();
        _agentNeverReceivesMoreThanTotalCap();
        _ownerCanAlwaysWithdraw();
        _noUnauthorizedOrInactiveSuccess();
        _templatesConsistent();
        _ownershipSane();
        _codeNeverChanges();
    }

    /// total_spent <= total_cap, and per-period <= period_cap, while the mandate epoch lives.
    function _budgetNeverExceeded() internal view {
        IAgentVault.Mandate memory m = vault.mandate();
        IAgentVault.Usage memory u = vault.usage();
        if (m.agent == address(0)) {
            assertEq(u.totalSpent, 0, "usage without mandate");
            return;
        }
        assertLe(u.totalSpent, m.totalCap, "total_spent > total_cap");
        assertLe(u.periodSpent, m.periodCap, "stored period_spent > period_cap");
        assertLe(vault.periodState(block.timestamp).spent, m.periodCap, "effective period_spent > period_cap");
        assertLe(u.deploys, m.maxDeploys, "deploys > max_deploys");
        assertLe(m.perDrawCap, m.periodCap);
        assertLe(m.periodCap, m.totalCap);
    }

    /// The contract's counters agree with an independent tally of what actually happened.
    function _ghostAccounting() internal view {
        assertEq(
            vault.usage().totalSpent, handler.ghostTotalSpent(), "total_spent != sum of successful draws"
        );
        assertEq(vault.usage().deploys, handler.ghostDeploys(), "deploys != successful deploys");
        assertEq(vault.config().epoch, handler.ghostEpoch(), "epoch != successful set_mandates");
        assertFalse(handler.periodCapViolated(), "a period received more than period_cap");
        assertFalse(handler.perDrawViolated(), "a draw exceeded per_draw_cap (or was 0)");
        assertFalse(handler.accountingMismatch(), "a transfer moved a different amount than requested");
    }

    /// contract balance + sum(sent to agents) + sum(sent to owners) == everything ever deposited.
    function _conservation() internal view {
        assertEq(
            address(vault).balance + handler.agentBalances() + handler.ownerBalances(),
            handler.totalFunded(),
            "ether created or destroyed"
        );
    }

    function _deploysBounded() internal view {
        IAgentVault.Mandate memory m = vault.mandate();
        assertLe(handler.ghostDeploys(), m.maxDeploys, "more deploys than max_deploys");
        assertFalse(handler.deployRuleViolated(), "a deploy/template rule was violated");
    }

    /// The agent never receives more than total_cap per epoch (measured from its real balance).
    function _agentNeverReceivesMoreThanTotalCap() internal view {
        IAgentVault.Mandate memory m = vault.mandate();
        if (m.agent == address(0)) return;
        assertLe(handler.epochAgentReceived(), m.totalCap, "agent received more than total_cap this epoch");
    }

    function _ownerCanAlwaysWithdraw() internal view {
        assertFalse(handler.withdrawAllFailed(), "owner could not withdraw the available balance");
    }

    function _noUnauthorizedOrInactiveSuccess() internal view {
        assertFalse(handler.unauthorizedSucceeded(), "an unauthorized call succeeded");
        assertFalse(handler.inactiveOpSucceeded(), "an agent op succeeded while paused/revoked/expired");
    }

    function _templatesConsistent() internal view {
        assertEq(vault.templateCount(), handler.allowedCount(), "template count");
        IAgentVault.Template[] memory page = vault.templates(0, 10);
        assertEq(page.length, handler.allowedCount());
        for (uint256 i; i < page.length; ++i) {
            assertEq(vault.template(page[i].id).id, page[i].id);
        }
        for (uint256 i; i < 3; ++i) {
            assertEq(
                vault.template(handler.ids(i)).id != bytes32(0),
                handler.allowedGhost(i),
                "template allowed state"
            );
        }
    }

    function _ownershipSane() internal view {
        address o = vault.config().owner;
        assertTrue(o == handler.owners(0) || o == handler.owners(1), "owner is one of the two actors");
        assertFalse(handler.ownershipViolated(), "ownership transfer rule violated");
        assertEq(vault.config().pendingOwner, handler.ghostPendingOwner(), "pending owner");
    }

    function _codeNeverChanges() internal view {
        assertEq(address(vault).codehash, initialCodehash, "vault code changed");
    }
}
