// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {ForceSend} from "./Mocks.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice Rule-by-rule behavior: mandate validation, draw, deploy, templates, ownership, views, previews,
///         and "a revert leaves state untouched".
contract VaultBehaviorTest is VaultBase {
    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsOwner_rejectsZero() public {
        IAgentVault.Config memory c = vault.config();
        assertEq(c.owner, owner);
        assertEq(c.pendingOwner, address(0));
        assertFalse(c.paused);
        assertEq(c.networkId, block.chainid);
        assertEq(c.epoch, 0);
        vm.expectRevert(IAgentVault.BadOwner.selector);
        new AgentVault(address(0));
    }

    function test_noMandate_initialViews() public view {
        IAgentVault.Mandate memory m = vault.mandate();
        assertEq(m.agent, address(0));
        IAgentVault.PeriodState memory ps = vault.periodState(T0);
        assertEq(ps.index, 0);
        assertEq(ps.spent, 0);
        assertEq(ps.startsAt, 0);
        assertEq(ps.endsAt, 0);
        assertEq(vault.previewDraw(1), IAgentVault.NoMandate.selector);
        assertEq(vault.previewDeploy(bytes32(uint256(1)), 0), IAgentVault.NoMandate.selector);
    }

    /*//////////////////////////////////////////////////////////////
                               SET MANDATE
    //////////////////////////////////////////////////////////////*/

    function test_setMandate_storesEverything_andResetsUsage() public {
        _setDefaultMandate();
        IAgentVault.Mandate memory m = vault.mandate();
        assertEq(m.agent, agent);
        assertEq(m.expiresAt, T0 + TTL);
        assertEq(m.perDrawCap, PER_DRAW);
        assertEq(m.periodSecs, PERIOD_SECS);
        assertEq(m.periodCap, PERIOD_CAP);
        assertEq(m.totalCap, TOTAL_CAP);
        assertEq(m.maxDeploys, MAX_DEPLOYS);
        assertEq(m.start, T0);
        assertFalse(m.revoked);
        assertEq(vault.config().epoch, 1);

        vm.prank(agent);
        vault.draw(1 ether);
        assertEq(vault.usage().totalSpent, 1 ether);

        vm.warp(T0 + 10);
        vm.prank(owner);
        vault.setMandate(other, T0 + 1 days, 1, 60, 2, 3, 0);
        IAgentVault.Usage memory u = vault.usage();
        assertEq(u.totalSpent, 0);
        assertEq(u.periodSpent, 0);
        assertEq(u.periodIndex, 0);
        assertEq(u.deploys, 0);
        assertEq(vault.mandate().start, T0 + 10);
        assertEq(vault.config().epoch, 2);
    }

    function test_setMandate_allowedWhilePaused() public {
        vm.startPrank(owner);
        vault.pause();
        vault.setMandate(agent, T0 + 100, 1, 60, 1, 1, 0);
        vm.stopPrank();
        assertTrue(vault.config().paused);
        assertEq(vault.config().epoch, 1);
    }

    function _bad(
        address a,
        uint256 exp,
        uint256 perDraw,
        uint256 secs,
        uint256 periodCap,
        uint256 totalCap,
        uint256 deploys
    ) internal {
        vm.prank(owner);
        vm.expectRevert(IAgentVault.BadMandate.selector);
        vault.setMandate(a, exp, perDraw, secs, periodCap, totalCap, deploys);
    }

    function test_setMandate_everyBound() public {
        uint256 e = T0 + 1 days;
        _bad(address(0), e, 1, 60, 1, 1, 0); // zero agent
        _bad(agent, T0, 1, 60, 1, 1, 0); // expires == now
        _bad(agent, T0 - 1, 1, 60, 1, 1, 0); // in the past
        _bad(agent, T0 + 30 days + 1, 1, 60, 1, 1, 0); // too far
        _bad(agent, e, 0, 60, 1, 1, 0); // per_draw 0
        _bad(agent, e, 2, 60, 1, 5, 0); // per_draw > period_cap
        _bad(agent, e, 1, 60, 6, 5, 0); // period_cap > total_cap
        _bad(agent, e, 1, 59, 1, 1, 0); // period too short
        _bad(agent, e, 1, 30 days + 1, 1, 1, 0); // period too long
        _bad(agent, e, 1, 60, 1, 1, 1001); // too many deploys
        assertEq(vault.config().epoch, 0, "bad mandates must not bump epoch");

        // Exact edges are fine.
        vm.startPrank(owner);
        vault.setMandate(agent, T0 + 30 days, 1, 60, 1, 1, 1000);
        vault.setMandate(agent, T0 + 1, 5, 30 days, 5, 5, 0);
        vm.stopPrank();
        assertEq(vault.config().epoch, 2);
    }

    function test_setMandate_hugeCapsDoNotBreakAccounting() public {
        vm.prank(owner);
        vault.setMandate(agent, T0 + 100, type(uint256).max, 60, type(uint256).max, type(uint256).max, 0);
        vm.prank(agent);
        vault.draw(100 ether);
        assertEq(vault.usage().totalSpent, 100 ether);
        // Asking for an absurd amount is a clean cap error, not an arithmetic panic.
        vm.prank(agent);
        vm.expectRevert(IAgentVault.PeriodCap.selector);
        vault.draw(type(uint256).max);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.InsufficientBalance.selector);
        vault.draw(101 ether); // caps pass (huge), balance (0 left) does not
    }

    /*//////////////////////////////////////////////////////////////
                                 REVOKE
    //////////////////////////////////////////////////////////////*/

    function test_revoke_needsMandate_isIdempotent() public {
        vm.prank(owner);
        vm.expectRevert(IAgentVault.NoMandate.selector);
        vault.revoke();

        _setDefaultMandate();
        vm.startPrank(owner);
        vault.revoke();
        vault.revoke();
        vm.stopPrank();
        assertTrue(vault.mandate().revoked);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.MandateInactive.selector);
        vault.draw(1);
        assertEq(vault.previewDraw(1), IAgentVault.MandateInactive.selector);
    }

    function test_setMandate_afterRevokeOrExpiry_reactivates() public {
        _setDefaultMandate();
        vm.prank(owner);
        vault.revoke();
        _setDefaultMandate();
        assertFalse(vault.mandate().revoked);
        vm.prank(agent);
        vault.draw(1);

        vm.warp(T0 + TTL); // expired
        vm.prank(agent);
        vm.expectRevert(IAgentVault.MandateInactive.selector);
        vault.draw(1);
        vm.prank(owner);
        vault.setMandate(agent, block.timestamp + 1 days, 1, 60, 1, 1, 0);
        vm.prank(agent);
        vault.draw(1);
    }

    /*//////////////////////////////////////////////////////////////
                              PAUSE / UNPAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pause_blocksAgentOnly_unpauseRestores() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.pause(); // idempotent

        vm.startPrank(agent);
        vm.expectRevert(IAgentVault.Paused.selector);
        vault.draw(1);
        vm.expectRevert(IAgentVault.Paused.selector);
        vault.deploy(id, 0, T1_INIT);
        vm.stopPrank();
        assertEq(vault.previewDraw(1), IAgentVault.Paused.selector);
        assertEq(vault.previewDeploy(id, 0), IAgentVault.Paused.selector);

        // Strangers still see Unauthorized, never the pause state.
        vm.prank(other);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.draw(1);

        // Owner ops keep working.
        vm.startPrank(owner);
        vault.withdraw(1 ether);
        vault.revoke();
        vault.disallowTemplate(id);
        vm.stopPrank();

        vm.prank(owner);
        vault.unpause();
        vm.prank(owner);
        vault.unpause(); // idempotent
        assertFalse(vault.config().paused);
    }

    /*//////////////////////////////////////////////////////////////
                                   DRAW
    //////////////////////////////////////////////////////////////*/

    function test_draw_ruleOrder() public {
        _setDefaultMandate();
        // BadAmount before everything else.
        assertEq(vault.previewDraw(0), IAgentVault.BadAmount.selector);
        // PerDrawCap before PeriodCap / TotalCap / balance.
        assertEq(vault.previewDraw(PER_DRAW + 1), IAgentVault.PerDrawCap.selector);

        // PeriodCap beats TotalCap when both are exhausted: period_cap == total_cap == 2.
        vm.prank(owner);
        vault.setMandate(agent, T0 + 1 days, 1 ether, 60, 2 ether, 2 ether, 0);
        for (uint256 i; i < 2; ++i) {
            vm.prank(agent);
            vault.draw(1 ether);
        }
        assertEq(vault.previewDraw(1), IAgentVault.PeriodCap.selector);
        vm.warp(block.timestamp + 60); // new period: period rule passes, total rule now binds
        assertEq(vault.previewDraw(1), IAgentVault.TotalCap.selector);
    }

    function test_draw_totalCap_thenInsufficientBalance() public {
        // total 10, balance 2: InsufficientBalance only once other caps pass.
        AgentVault v = new AgentVault(owner);
        vm.deal(address(v), 2 ether);
        vm.prank(owner);
        v.setMandate(agent, T0 + 1 days, 2 ether, 60, 5 ether, 5 ether, 0);
        vm.prank(agent);
        v.draw(2 ether);
        assertEq(v.previewDraw(1), IAgentVault.InsufficientBalance.selector);
        vm.deal(address(v), 100 ether);
        // Now the TotalCap is the binding rule (2 of 5 spent; 3 left; asking 3 passes the cap, over fails it).
        vm.prank(agent);
        v.draw(2 ether);
        vm.warp(T0 + 61);
        vm.prank(agent);
        v.draw(1 ether);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.TotalCap.selector);
        v.draw(1);
    }

    function test_draw_periodRolloverRebases() public {
        _setDefaultMandate();
        vm.prank(agent);
        vault.draw(1 ether);
        IAgentVault.PeriodState memory ps = vault.periodState(T0 + 5);
        assertEq(ps.index, 0);
        assertEq(ps.spent, 1 ether);
        assertEq(ps.startsAt, T0);
        assertEq(ps.endsAt, T0 + PERIOD_SECS);

        // Raw storage keeps old period until the next spend; effective view reports 0 in the new period.
        ps = vault.periodState(T0 + PERIOD_SECS);
        assertEq(ps.index, 1);
        assertEq(ps.spent, 0);
        assertEq(vault.usage().periodSpent, 1 ether);

        vm.warp(T0 + PERIOD_SECS);
        vm.startPrank(agent);
        vault.draw(1 ether);
        vault.draw(1 ether);
        vm.stopPrank();
        assertEq(vault.usage().periodIndex, 1);
        assertEq(vault.usage().periodSpent, 2 ether);
        assertEq(vault.usage().totalSpent, 3 ether);
    }

    function test_periodState_beforeStartIsZero() public {
        _setDefaultMandate();
        IAgentVault.PeriodState memory ps = vault.periodState(T0 - 1);
        assertEq(ps.spent, 0);
        assertEq(ps.endsAt, 0);
    }

    function test_draw_sendsExactlyAmount_toAgent_andLeavesNoDust() public {
        _setDefaultMandate();
        uint256 before = address(vault).balance;
        vm.prank(agent);
        vault.draw(0.123 ether);
        assertEq(agent.balance, 0.123 ether);
        assertEq(address(vault).balance, before - 0.123 ether);
    }

    function test_draw_respectsBalanceNotJustBudget() public {
        AgentVault v = new AgentVault(owner);
        vm.prank(owner);
        v.setMandate(agent, T0 + 1 days, 1 ether, 60, 1 ether, 1 ether, 0);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.InsufficientBalance.selector);
        v.draw(1);
    }

    /*//////////////////////////////////////////////////////////////
                                 TEMPLATES
    //////////////////////////////////////////////////////////////*/

    function test_allowTemplate_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(IAgentVault.BadTemplate.selector);
        vault.allowTemplate(keccak256(T1_INIT), "x", 1); // deposit must be 0 on EVM
        vm.expectRevert(IAgentVault.BadTemplate.selector);
        vault.allowTemplate(bytes32(0), "x", 0);
        vm.expectRevert(IAgentVault.BadTemplate.selector);
        vault.allowTemplate(keccak256(T1_INIT), string(new bytes(65)), 0);
        vault.allowTemplate(keccak256(T1_INIT), string(new bytes(64)), 0); // exact edge ok
        vm.stopPrank();
        assertEq(vault.templateCount(), 1);
    }

    function test_template_reAllowUpdatesLabel_noDuplicate() public {
        bytes32 id = keccak256(T1_INIT);
        vm.startPrank(owner);
        vault.allowTemplate(id, "one", 0);
        vault.allowTemplate(id, "two", 0);
        vm.stopPrank();
        assertEq(vault.templateCount(), 1);
        IAgentVault.Template memory t = vault.template(id);
        assertEq(t.id, id);
        assertEq(t.label, "two");
        assertEq(t.deposit, 0);
        assertEq(vault.template(keccak256("nope")).id, bytes32(0));
    }

    function test_templates_paging_and_disallowSwapAndPop() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 c = keccak256("c");
        vm.startPrank(owner);
        vault.allowTemplate(a, "A", 0);
        vault.allowTemplate(b, "B", 0);
        vault.allowTemplate(c, "C", 0);
        vm.stopPrank();

        IAgentVault.Template[] memory page = vault.templates(0, 2);
        assertEq(page.length, 2);
        assertEq(page[0].id, a);
        assertEq(page[1].id, b);
        page = vault.templates(2, 100); // limit clamps
        assertEq(page.length, 1);
        assertEq(page[0].id, c);
        assertEq(vault.templates(3, 1).length, 0); // from == count
        assertEq(vault.templates(99, 1).length, 0);
        assertEq(vault.templates(0, type(uint256).max).length, 3, "no overflow on huge limit");

        // Remove the first: the last takes its slot (swap-and-pop); removed one is gone, others intact.
        vm.prank(owner);
        vault.disallowTemplate(a);
        page = vault.templates(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0].id, c);
        assertEq(page[1].id, b);
        assertEq(vault.template(a).id, bytes32(0));
        assertEq(vault.template(c).label, "C");

        // Remove the (now) last, then the only remaining others.
        vm.startPrank(owner);
        vault.disallowTemplate(b);
        vault.disallowTemplate(c);
        vm.expectRevert(IAgentVault.TemplateNotAllowed.selector);
        vault.disallowTemplate(c);
        vm.stopPrank();
        assertEq(vault.templateCount(), 0);
    }

    function test_templateIdOf_isKeccakOfInitcode() public view {
        assertEq(vault.templateIdOf(T1_INIT), keccak256(T1_INIT));
        assertTrue(vault.templateIdOf(T1_INIT) != vault.templateIdOf(T2_INIT));
    }

    /*//////////////////////////////////////////////////////////////
                                  DEPLOY
    //////////////////////////////////////////////////////////////*/

    function test_deploy_create2AddressMatchesPrecompute_andManualFormula() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        bytes32 salt = keccak256("registry-1");

        address predicted = vault.predictAddress(id, salt);
        address manual = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(vault), salt, keccak256(T1_INIT))))
            )
        );
        assertEq(predicted, manual, "predict == EIP-1014 formula");
        assertEq(
            predicted, vm.computeCreate2Address(salt, keccak256(T1_INIT), address(vault)), "predict == forge"
        );

        vm.prank(agent);
        address target = vault.deploy(id, salt, T1_INIT);
        assertEq(target, predicted);
        assertEq(target.code, hex"01", "runtime code of the fixture");
        assertEq(vault.usage().deploys, 1);
        assertEq(target.balance, 0, "no value forwarded");
        assertEq(address(vault).balance, 100 ether, "deploy spends nothing");
    }

    function test_deploy_sameSaltDifferentTemplates_differentAddresses() public {
        _setDefaultMandate();
        bytes32 id1 = _allow(T1_INIT);
        bytes32 id2 = _allow(T2_INIT);
        vm.startPrank(agent);
        address a = vault.deploy(id1, 0, T1_INIT);
        address b = vault.deploy(id2, 0, T2_INIT);
        vm.stopPrank();
        assertTrue(a != b);
        assertEq(a.code, hex"01");
        assertEq(b.code, hex"02");
    }

    function test_deploy_ruleOrder() public {
        _setDefaultMandate();
        bytes32 id1 = keccak256(T1_INIT);
        bytes32 id2 = keccak256(T2_INIT);

        // 1. TemplateNotAllowed beats CodeMismatch.
        vm.prank(agent);
        vm.expectRevert(IAgentVault.TemplateNotAllowed.selector);
        vault.deploy(id1, 0, T2_INIT);
        assertEq(vault.previewDeploy(id1, 0), IAgentVault.TemplateNotAllowed.selector);

        _allow(T1_INIT);
        // 2. CodeMismatch beats DeployLimit / AddressTaken.
        vm.prank(agent);
        vm.expectRevert(IAgentVault.CodeMismatch.selector);
        vault.deploy(id1, 0, T2_INIT);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.CodeMismatch.selector);
        vault.deploy(id1, 0, "");
        // A template with the same code but a flipped byte is a different hash: mismatch.
        bytes memory tweaked = bytes.concat(T1_INIT, hex"00");
        vm.prank(agent);
        vm.expectRevert(IAgentVault.CodeMismatch.selector);
        vault.deploy(id1, 0, tweaked);

        // 3. DeployLimit beats AddressTaken.
        vm.prank(agent);
        vault.deploy(id1, bytes32(uint256(1)), T1_INIT);
        vm.prank(owner);
        vault.setMandate(agent, T0 + 1 days, 1, 60, 1, 1, 1); // epoch 2, max 1 deploy, usage reset
        vm.prank(agent);
        vault.deploy(id1, bytes32(uint256(2)), T1_INIT);
        assertEq(vault.previewDeploy(id1, bytes32(uint256(1))), IAgentVault.DeployLimit.selector);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.DeployLimit.selector);
        vault.deploy(id1, bytes32(uint256(1)), T1_INIT); // also an occupied address: limit wins

        // 4. AddressTaken.
        vm.prank(owner);
        vault.setMandate(agent, T0 + 1 days, 1, 60, 1, 1, 10);
        assertEq(vault.previewDeploy(id1, bytes32(uint256(1))), IAgentVault.AddressTaken.selector);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.AddressTaken.selector);
        vault.deploy(id1, bytes32(uint256(1)), T1_INIT);
        assertEq(vault.previewDeploy(id1, bytes32(uint256(3))), bytes4(0));

        // id2 is not allowlisted.
        assertEq(vault.previewDeploy(id2, 0), IAgentVault.TemplateNotAllowed.selector);
    }

    function test_deploy_maxDeploysZero_isDrawOnly() public {
        vm.prank(owner);
        vault.setMandate(agent, T0 + 1 days, 1, 60, 1, 1, 0);
        bytes32 id = _allow(T1_INIT);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.DeployLimit.selector);
        vault.deploy(id, 0, T1_INIT);
        vm.prank(agent);
        vault.draw(1);
    }

    function test_deploy_inactiveMandate_andRevokedTemplate() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        vm.prank(owner);
        vault.disallowTemplate(id);
        vm.prank(agent);
        vm.expectRevert(IAgentVault.TemplateNotAllowed.selector);
        vault.deploy(id, 0, T1_INIT);

        _allow(T1_INIT);
        vm.prank(owner);
        vault.revoke();
        vm.prank(agent);
        vm.expectRevert(IAgentVault.MandateInactive.selector);
        vault.deploy(id, 0, T1_INIT);
    }

    function test_deploy_addressWithCodeIsAddressTaken_evenIfNotDeployedByVault() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        bytes32 salt = bytes32(uint256(42));
        address predicted = vault.predictAddress(id, salt);
        vm.etch(predicted, hex"00");
        vm.prank(agent);
        vm.expectRevert(IAgentVault.AddressTaken.selector);
        vault.deploy(id, salt, T1_INIT);
    }

    function test_deploy_failingConstructor_revertsWholeTx_countersUntouched() public {
        _setDefaultMandate();
        bytes32 id = _allow(REVERTING_INIT);
        bytes32 before = _fingerprint();
        vm.prank(agent);
        vm.expectRevert(IAgentVault.DeployFailed.selector);
        vault.deploy(id, 0, REVERTING_INIT);
        assertEq(_fingerprint(), before, "failed deploy must not count");
        assertEq(vault.usage().deploys, 0);
    }

    function test_deploy_valueIsNeverForwarded() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        vm.deal(agent, 5 ether);
        vm.prank(agent);
        (bool ok,) =
            address(vault).call{value: 1 ether}(abi.encodeCall(vault.deploy, (id, bytes32(0), T1_INIT)));
        assertFalse(ok, "deploy is not payable");
    }

    /*//////////////////////////////////////////////////////////////
                                  WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_withdraw_validation_andStates() public {
        vm.startPrank(owner);
        vm.expectRevert(IAgentVault.BadAmount.selector);
        vault.withdraw(0);
        vm.expectRevert(IAgentVault.InsufficientBalance.selector);
        vault.withdraw(100 ether + 1);
        vault.withdraw(100 ether); // everything, exactly
        vm.stopPrank();
        assertEq(owner.balance, 100 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_withdraw_worksWhenPausedRevokedExpired() public {
        _setDefaultMandate();
        vm.startPrank(owner);
        vault.pause();
        vault.revoke();
        vm.stopPrank();
        vm.warp(T0 + TTL + 1);
        vm.prank(owner);
        vault.withdraw(100 ether);
        assertEq(owner.balance, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                 OWNERSHIP
    //////////////////////////////////////////////////////////////*/

    function test_ownership_twoStep() public {
        vm.startPrank(owner);
        vm.expectRevert(IAgentVault.BadOwner.selector);
        vault.transferOwnership(address(0));
        vm.expectRevert(IAgentVault.BadOwner.selector);
        vault.transferOwnership(owner);
        vault.transferOwnership(newOwner);
        vm.stopPrank();
        assertEq(vault.config().owner, owner, "owner unchanged until accepted");
        assertEq(vault.config().pendingOwner, newOwner);

        // Owner can re-point the pending transfer.
        vm.prank(owner);
        vault.transferOwnership(other);
        vm.prank(newOwner);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();

        vm.prank(other);
        vault.acceptOwnership();
        assertEq(vault.config().owner, other);
        assertEq(vault.config().pendingOwner, address(0));
        vm.prank(other);
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();
    }

    /// @dev acceptOwnership from address(0) when nothing is pending must not succeed (unreachable on a real chain).
    function test_acceptOwnership_zeroCallerWithNothingPending() public {
        vm.prank(address(0));
        vm.expectRevert(IAgentVault.Unauthorized.selector);
        vault.acceptOwnership();
    }

    /*//////////////////////////////////////////////////////////////
                                   MISC
    //////////////////////////////////////////////////////////////*/

    function test_available_isBalance_includingForcedEther() public {
        assertEq(vault.available(), 100 ether);
        new ForceSend{value: 1 ether}(payable(address(vault)));
        assertEq(vault.available(), 101 ether, "selfdestruct-forced ether counts (and is withdrawable)");
        vm.prank(owner);
        vault.withdraw(101 ether);
    }

    function test_previews_neverMutate() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        bytes32 before = _fingerprint();
        vault.previewDraw(1 ether);
        vault.previewDeploy(id, 0);
        vault.periodState(T0 + 5);
        assertEq(_fingerprint(), before);
    }

    function test_preview_equalsRealOutcome_acrossStates() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        uint256[6] memory amounts = [uint256(0), 1, PER_DRAW, PER_DRAW + 1, 3 ether, 1000 ether];
        for (uint256 round; round < 6; ++round) {
            for (uint256 i; i < amounts.length; ++i) {
                bytes4 pv = vault.previewDraw(amounts[i]);
                uint256 snap = vm.snapshotState();
                vm.prank(agent);
                (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.draw, (amounts[i])));
                assertEq(ok, pv == bytes4(0), "preview ok flag");
                if (!ok) assertEq(ret, abi.encodePacked(pv), "preview selector");
                vm.revertToState(snap);
            }
            vm.prank(agent);
            try vault.draw(1 ether) {} catch {}
            bytes4 pd = vault.previewDeploy(id, bytes32(round));
            vm.prank(agent);
            (bool dok, bytes memory dret) =
                address(vault).call(abi.encodeCall(vault.deploy, (id, bytes32(round), T1_INIT)));
            assertEq(dok, pd == bytes4(0));
            if (!dok) assertEq(dret, abi.encodePacked(pd));
            vm.warp(block.timestamp + 12 hours);
        }
    }

    function test_revertsLeaveStateUntouched_acrossAllFailingOps() public {
        _setDefaultMandate();
        bytes32 id = _allow(T1_INIT);
        bytes32 before = _fingerprint();
        uint256 agentBal = agent.balance;

        vm.startPrank(agent);
        (bool ok,) = address(vault).call(abi.encodeCall(vault.draw, (0)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.draw, (PER_DRAW + 1)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.deploy, (id, bytes32(0), T2_INIT)));
        assertFalse(ok);
        vm.stopPrank();
        vm.startPrank(owner);
        (ok,) = address(vault).call(abi.encodeCall(vault.withdraw, (0)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.setMandate, (agent, 0, 1, 60, 1, 1, 0)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.allowTemplate, (id, "x", 1)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.disallowTemplate, (keccak256("none"))));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeCall(vault.transferOwnership, (address(0))));
        assertFalse(ok);
        vm.stopPrank();

        assertEq(_fingerprint(), before);
        assertEq(agent.balance, agentBal);
    }
}
