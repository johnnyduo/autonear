// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {ForceSend} from "./Mocks.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Bounded random walk over EVERY public method of the vault (owner, agent, strangers, time, deposits,
///         forced ether, ownership). Every action is wrapped in try/catch so it never reverts the run; ghost
///         variables record what the walk observed so the invariants do not just trust the contract's own counters.
contract VaultHandler is Test {
    AgentVault public vault;

    address[2] public owners;
    address[3] public agents;
    address[2] public depositors;
    address public stranger;

    bytes[3] internal initcodes; // 0: t1, 1: t2, 2: constructor that reverts
    bytes32[3] public ids;
    bool[3] public allowedGhost;

    // Ghosts.
    uint256 public totalFunded; // every wei ever put into the system (initial + deposits + forced)
    uint64 public ghostEpoch;
    uint256 public ghostTotalSpent; // sum of successful draws in the current epoch
    uint256 public epochAgentReceived; // measured from the agent's real balance, current epoch
    uint256 public ghostDeploys;
    uint256 public maxAgentReceivedInOneEpoch;
    mapping(bytes32 epochPeriod => uint256) internal ghostPeriodSpent;
    address public ghostPendingOwner;

    bool public periodCapViolated;
    bool public perDrawViolated;
    bool public accountingMismatch;
    bool public inactiveOpSucceeded;
    bool public unauthorizedSucceeded;
    bool public withdrawAllFailed;
    bool public deployRuleViolated;
    bool public ownershipViolated;

    // Visibility counters (so a run can prove the walk reached the interesting paths).
    uint256 public nDraw;
    uint256 public nDeploy;
    uint256 public nWithdraw;
    uint256 public nSetMandate;
    uint256 public nRevert;

    constructor(AgentVault v, address[2] memory owners_, uint256 initialFunding) {
        vault = v;
        owners = owners_;
        agents = [makeAddr("hAgent0"), makeAddr("hAgent1"), makeAddr("hAgent2")];
        depositors = [makeAddr("hDep0"), makeAddr("hDep1")];
        stranger = makeAddr("hStranger");
        initcodes[0] = hex"600160005360016000f3";
        initcodes[1] = hex"600260005360016000f3";
        initcodes[2] = hex"60006000fd";
        for (uint256 i; i < 3; ++i) {
            ids[i] = keccak256(initcodes[i]);
        }
        totalFunded = initialFunding;
    }

    /*//////////////////////////////////////////////////////////////
                               DISPATCH
    //////////////////////////////////////////////////////////////*/

    /// @dev One random action chosen from `s`; used by the stateless fuzz test.
    function act(uint256 s) external {
        uint256 op = s % 16;
        uint256 a = uint256(keccak256(abi.encode(s, 1)));
        uint256 b = uint256(keccak256(abi.encode(s, 2)));
        if (op < 3) draw(a, b);
        else if (op == 3) deploy(a, b);
        else if (op == 4) setMandate(a, b);
        else if (op == 5) revoke(a);
        else if (op == 6) pause(a);
        else if (op == 7) unpause(a);
        else if (op == 8) allowTemplate(a);
        else if (op == 9) disallowTemplate(a);
        else if (op == 10) withdraw(a);
        else if (op == 11) withdrawAll();
        else if (op == 12) deposit(a, b);
        else if (op == 13) forceSend(a);
        else if (op == 14) transferOwnership(a);
        else if (op == 15) acceptOwnership(a);
        if (a % 3 == 0) advance(b);
        if (a % 7 == 0) strangerCalls(a);
    }

    /*//////////////////////////////////////////////////////////////
                               ACTIONS
    //////////////////////////////////////////////////////////////*/

    function advance(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }

    function setMandate(uint256 s1, uint256 s2) public {
        address o = vault.config().owner;
        address ag = agents[s1 % 3];
        uint256 ttl = bound(s2, 1, 30 days);
        uint256 perDraw = bound(s1 >> 8, 1, 5 ether);
        uint256 periodCap = bound(s2 >> 8, perDraw, 10 ether);
        uint256 totalCap = bound(s1 >> 16, periodCap, 30 ether);
        uint256 periodSecs = bound(s2 >> 16, 60, 3 days);
        uint256 maxDeploys = bound(s1 >> 24, 0, 6);
        vm.prank(o);
        try vault.setMandate(
            ag, block.timestamp + ttl, perDraw, periodSecs, periodCap, totalCap, maxDeploys
        ) {
            ++nSetMandate;
            ++ghostEpoch;
            ghostTotalSpent = 0;
            epochAgentReceived = 0;
            ghostDeploys = 0;
        } catch {
            ++nRevert;
        }
    }

    function revoke(uint256 s) public {
        if (s % 4 != 0) return; // revoking is permanent for the epoch: keep it rare so draws/deploys are reached
        vm.prank(vault.config().owner);
        try vault.revoke() {} catch {}
    }

    function pause(uint256 s) public {
        if (s % 3 != 0) return; // rare, for the same reason
        vm.prank(vault.config().owner);
        vault.pause();
    }

    function unpause(uint256 s) public {
        s;
        vm.prank(vault.config().owner);
        vault.unpause();
    }

    function draw(uint256 s1, uint256 s2) public {
        IAgentVault.Mandate memory m0 = vault.mandate();
        // 75%: the bound agent; 25%: any of the three agents (usually the wrong one).
        address caller = (s1 % 4 != 0 && m0.agent != address(0)) ? m0.agent : agents[s1 % 3];
        uint256 amount = bound(s2, 0, m0.perDrawCap * 2 + 1);
        uint256 before = caller.balance;
        bool paused = vault.config().paused;

        vm.prank(caller);
        try vault.draw(amount) {
            ++nDraw;
            IAgentVault.Mandate memory m = vault.mandate();
            if (caller.balance - before != amount) accountingMismatch = true;
            if (caller != m.agent) unauthorizedSucceeded = true;
            if (amount == 0 || amount > m.perDrawCap) perDrawViolated = true;
            if (paused || m.revoked || block.timestamp >= m.expiresAt) inactiveOpSucceeded = true;
            epochAgentReceived += caller.balance - before;
            if (epochAgentReceived > maxAgentReceivedInOneEpoch) {
                maxAgentReceivedInOneEpoch = epochAgentReceived;
            }
            ghostTotalSpent += amount;
            bytes32 key = keccak256(abi.encode(ghostEpoch, (block.timestamp - m.start) / m.periodSecs));
            ghostPeriodSpent[key] += amount;
            if (ghostPeriodSpent[key] > m.periodCap) periodCapViolated = true;
        } catch {
            ++nRevert;
        }
    }

    function deploy(uint256 s1, uint256 s2) public {
        IAgentVault.Mandate memory m0 = vault.mandate();
        address caller = (s1 % 4 != 0 && m0.agent != address(0)) ? m0.agent : agents[s1 % 3];
        uint256 t = s1 % 3;
        // 1 in 5: submit a different template's code under this id (must be CodeMismatch).
        uint256 codeIdx = (s2 % 5 == 0) ? (t + 1) % 3 : t;
        bytes32 salt = bytes32(bound(s2 >> 8, 0, 6)); // small salt space so AddressTaken is reachable
        bool paused = vault.config().paused;

        vm.prank(caller);
        try vault.deploy(ids[t], salt, initcodes[codeIdx]) returns (address target) {
            ++nDeploy;
            ++ghostDeploys;
            IAgentVault.Mandate memory m = vault.mandate();
            if (codeIdx != t || !allowedGhost[t] || t == 2) deployRuleViolated = true;
            if (caller != m.agent) unauthorizedSucceeded = true;
            if (paused || m.revoked || block.timestamp >= m.expiresAt) inactiveOpSucceeded = true;
            if (ghostDeploys > m.maxDeploys) deployRuleViolated = true;
            if (target != vault.predictAddress(ids[t], salt) || target.code.length != 1) {
                deployRuleViolated = true;
            }
        } catch {
            ++nRevert;
        }
    }

    function allowTemplate(uint256 s) public {
        uint256 t = s % 3;
        vm.prank(vault.config().owner);
        try vault.allowTemplate(ids[t], "tpl", 0) {
            allowedGhost[t] = true;
        } catch {}
    }

    function disallowTemplate(uint256 s) public {
        uint256 t = s % 3;
        vm.prank(vault.config().owner);
        try vault.disallowTemplate(ids[t]) {
            if (!allowedGhost[t]) deployRuleViolated = true; // removed something that was never there
            allowedGhost[t] = false;
        } catch {
            if (allowedGhost[t]) deployRuleViolated = true; // failed to remove an allowlisted template
        }
    }

    function withdraw(uint256 s) public {
        address o = vault.config().owner;
        uint256 amount = bound(s, 0, address(vault).balance / 3 + 1);
        uint256 before = o.balance;
        vm.prank(o);
        try vault.withdraw(amount) {
            ++nWithdraw;
            if (o.balance - before != amount) accountingMismatch = true;
        } catch {
            ++nRevert;
        }
    }

    /// @dev The owner can ALWAYS pull the whole available balance, in any state.
    function withdrawAll() public {
        if (uint256(keccak256(abi.encode(block.timestamp, nDraw, nWithdraw))) % 6 != 0) return; // keep it occasional
        address o = vault.config().owner;
        uint256 bal = vault.available();
        if (bal == 0) return;
        vm.prank(o);
        try vault.withdraw(bal) {
            ++nWithdraw;
        } catch {
            withdrawAllFailed = true;
        }
    }

    function deposit(uint256 s1, uint256 s2) public {
        address d = depositors[s1 % 2];
        uint256 amount = bound(s2, 0, 20 ether);
        vm.deal(d, amount);
        vm.prank(d);
        (bool ok,) = address(vault).call{value: amount}("");
        if (!ok) accountingMismatch = true;
        totalFunded += amount;
    }

    function forceSend(uint256 s) public {
        uint256 amount = bound(s, 0, 5 ether);
        vm.deal(address(this), amount);
        new ForceSend{value: amount}(payable(address(vault)));
        totalFunded += amount;
    }

    function transferOwnership(uint256 s) public {
        address o = vault.config().owner;
        address to = s % 5 == 0 ? address(0) : s % 5 == 1 ? o : owners[s % 2];
        vm.prank(o);
        try vault.transferOwnership(to) {
            ghostPendingOwner = to;
            if (to == address(0) || to == o) ownershipViolated = true;
        } catch {}
    }

    function acceptOwnership(uint256 s) public {
        address caller = s % 4 == 0 ? stranger : owners[s % 2];
        address previous = vault.config().owner;
        vm.prank(caller);
        try vault.acceptOwnership() {
            if (caller != ghostPendingOwner || ghostPendingOwner == address(0)) ownershipViolated = true;
            if (vault.config().owner != caller || vault.config().pendingOwner != address(0)) {
                ownershipViolated = true;
            }
            ghostPendingOwner = address(0);
            previous;
        } catch {}
    }

    /// @dev Calls nobody but the owner/agent may make must always fail.
    function strangerCalls(uint256 s) public {
        s;
        vm.startPrank(stranger);
        try vault.pause() {
            unauthorizedSucceeded = true;
        } catch {}
        try vault.withdraw(1) {
            unauthorizedSucceeded = true;
        } catch {}
        try vault.draw(1) {
            unauthorizedSucceeded = true;
        } catch {}
        try vault.setMandate(stranger, block.timestamp + 100, 1, 60, 1, 1, 0) {
            unauthorizedSucceeded = true;
        } catch {}
        try vault.allowTemplate(bytes32(uint256(7)), "x", 0) {
            unauthorizedSucceeded = true;
        } catch {}
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              TEST HELPERS
    //////////////////////////////////////////////////////////////*/

    function ownerBalances() external view returns (uint256 sum) {
        for (uint256 i; i < 2; ++i) {
            sum += owners[i].balance;
        }
    }

    function agentBalances() external view returns (uint256 sum) {
        for (uint256 i; i < 3; ++i) {
            sum += agents[i].balance;
        }
    }

    function allowedCount() external view returns (uint256 n) {
        for (uint256 i; i < 3; ++i) {
            if (allowedGhost[i]) ++n;
        }
    }
}
