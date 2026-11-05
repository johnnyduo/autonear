// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentVault} from "../../src/IAgentVault.sol";
import {VaultProps} from "./Props.sol";
import {console} from "forge-std/Test.sol";

/// @notice Stateless fuzzing: random operation sequences preserve every vault property after EVERY step, plus
///         targeted properties of single operations.
contract VaultFuzzTest is VaultProps {
    function setUp() public {
        _deployWorld();
    }

    /// @dev Random sequences of up to 120 actions. Properties are re-checked after each action.
    function testFuzz_randomSequence_preservesInvariants(uint256 seed, uint8 length) public {
        uint256 n = bound(length, 1, 120);
        for (uint256 i; i < n; ++i) {
            handler.act(uint256(keccak256(abi.encode(seed, i))));
            _checkAll();
        }
    }

    /// @dev Sequences that start from a live mandate and many deployed templates (so draws/deploys run, not just revert).
    function testFuzz_randomSequence_withLiveMandate(uint256 seed, uint8 length) public {
        handler.allowTemplate(0);
        handler.allowTemplate(1);
        handler.allowTemplate(2);
        handler.setMandate(seed, ~seed);
        uint256 n = bound(length, 1, 120);
        for (uint256 i; i < n; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, i, "live")));
            // Favour draws/deploys: remap 60% of picks onto op 0..3.
            handler.act(s % 5 < 3 ? s - (s % 16) + (s % 4) : s);
            _checkAll();
        }
    }

    /// @dev Prints reachability of the walk (draws/deploys/withdrawals executed) for one deterministic seed.
    function test_walkReachesRealOperations() public {
        handler.allowTemplate(0);
        handler.allowTemplate(1);
        for (uint256 e; e < 6; ++e) {
            handler.setMandate(e * 7919 + 1, e * 104_729 + 3);
            for (uint256 i; i < 150; ++i) {
                uint256 s = uint256(keccak256(abi.encode(e, i)));
                handler.act(s % 5 < 3 ? s - (s % 16) + (s % 4) : s);
            }
            _checkAll();
        }
        console.log("draws ok      :", handler.nDraw());
        console.log("deploys ok    :", handler.nDeploy());
        console.log("withdrawals ok:", handler.nWithdraw());
        console.log("setMandate ok :", handler.nSetMandate());
        console.log("reverted ops  :", handler.nRevert());
        assertGt(handler.nDraw(), 0, "walk never drew");
        assertGt(handler.nDeploy(), 0, "walk never deployed");
        assertGt(handler.nWithdraw(), 0, "walk never withdrew");
    }

    /// @dev Single draw: either exactly `amount` moves vault -> agent, or nothing moves.
    function testFuzz_draw_allOrNothing(uint256 amount, uint256 funding) public {
        funding = bound(funding, 0, 100 ether);
        address ag = makeAddr("fAgent");
        vm.deal(address(vault), funding);
        vm.prank(vault.config().owner);
        vault.setMandate(ag, block.timestamp + 1 days, 2 ether, 60, 5 ether, 7 ether, 0);
        uint256 vaultBefore = address(vault).balance;
        bytes4 pv = vault.previewDraw(amount);
        vm.prank(ag);
        try vault.draw(amount) {
            assertEq(pv, bytes4(0));
            assertEq(ag.balance, amount);
            assertEq(address(vault).balance, vaultBefore - amount);
            assertEq(vault.usage().totalSpent, amount);
        } catch (bytes memory ret) {
            assertEq(ret, abi.encodePacked(pv), "preview mismatch");
            assertEq(ag.balance, 0);
            assertEq(address(vault).balance, vaultBefore);
            assertEq(vault.usage().totalSpent, 0);
        }
    }

    uint256[64] internal perPeriod;
    uint256 internal windowTotal;

    /// @dev One draw at the current time; tallies it against its absolute period independently of the vault.
    function _windowDraw(address ag, uint64 start, uint256 periodSecs, uint256 amount) internal {
        vm.prank(ag);
        try vault.draw(amount) {
            uint256 idx = (block.timestamp - start) / periodSecs;
            if (idx < 64) {
                perPeriod[idx] += amount;
                assertLe(perPeriod[idx], 5 ether, "period cap broken");
            }
            windowTotal += amount;
        } catch {}
    }

    /// @dev Period bookkeeping: drawing at arbitrary times never lets one period exceed period_cap.
    function testFuzz_periodWindows(uint256 seed) public {
        address ag = makeAddr("pAgent");
        uint256 periodSecs = bound(seed, 60, 2 days);
        vm.prank(vault.config().owner);
        vault.setMandate(ag, block.timestamp + 30 days, 3 ether, periodSecs, 5 ether, 1000 ether, 0);
        uint64 start = vault.mandate().start;
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + bound(seed, 0, periodSecs));
            if (block.timestamp >= start + 30 days) break;
            _windowDraw(ag, start, periodSecs, bound(seed >> 8, 1, 3 ether));
        }
        assertEq(vault.usage().totalSpent, windowTotal);
        assertEq(ag.balance, windowTotal);
    }

    /// @dev Setting a mandate: accepted iff every spec bound holds.
    function testFuzz_setMandate_acceptsExactlyTheSpecBounds(
        uint256 expiresIn,
        uint256 perDraw,
        uint256 periodSecs,
        uint256 periodCap,
        uint256 totalCap,
        uint256 maxDeploys
    ) public {
        expiresIn = bound(expiresIn, 0, 40 days);
        periodSecs = bound(periodSecs, 0, 40 days);
        maxDeploys = bound(maxDeploys, 0, 2000);
        bool valid = expiresIn >= 1 && expiresIn <= 30 days && perDraw > 0 && perDraw <= periodCap
            && periodCap <= totalCap && periodSecs >= 60 && periodSecs <= 30 days && maxDeploys <= 1000;
        address ag = makeAddr("sAgent");
        vm.prank(vault.config().owner);
        try vault.setMandate(
            ag, block.timestamp + expiresIn, perDraw, periodSecs, periodCap, totalCap, maxDeploys
        ) {
            assertTrue(valid, "accepted an out-of-bounds mandate");
        } catch (bytes memory ret) {
            assertFalse(valid, "rejected an in-bounds mandate");
            assertEq(ret, abi.encodePacked(IAgentVault.BadMandate.selector));
        }
    }

    /// @dev Whoever calls an owner function, nothing changes unless the caller is the owner.
    function testFuzz_nonOwnerCanNeverChangeState(address caller, uint256 amount, address arg) public {
        vm.assume(caller != vault.config().owner);
        bytes32 before =
            keccak256(abi.encode(vault.config(), vault.mandate(), vault.usage(), address(vault).balance));
        vm.startPrank(caller);
        try vault.withdraw(amount) {
            fail("withdraw");
        } catch {}
        try vault.setMandate(arg, block.timestamp + 100, 1, 60, 1, 1, 0) {
            fail("setMandate");
        } catch {}
        try vault.transferOwnership(arg) {
            fail("transferOwnership");
        } catch {}
        try vault.pause() {
            fail("pause");
        } catch {}
        try vault.revoke() {
            fail("revoke");
        } catch {}
        vm.stopPrank();
        assertEq(
            keccak256(abi.encode(vault.config(), vault.mandate(), vault.usage(), address(vault).balance)),
            before
        );
    }
}
