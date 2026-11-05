// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {Handler} from "./Handler.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test, console} from "forge-std/Test.sol";

/// @notice Stateful invariants of the registry under a random walk of every public method.
contract ProposalRegistryInvariantTest is StdInvariant, Test {
    ProposalRegistry internal reg;
    Handler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        address proposer = makeAddr("proposer");
        reg = new ProposalRegistry(owner, proposer, 1000 ether);
        handler = new Handler(reg, owner, proposer);
        for (uint256 t; t < 3; ++t) {
            for (uint256 s; s < 2; ++s) {
                if (t == 2 && s == 1) continue; // leave one pair un-allowlisted so the toggles have work
                address tgt = handler.targets(t);
                bytes4 sel = handler.selectors(s);
                vm.prank(owner);
                reg.addAllowed(tgt, sel);
            }
        }
        targetContract(address(handler));
    }

    /// @dev Executed and Cancelled never change status, spent, or receipt after being reached.
    function invariant_terminalStatesNeverLeave() public view {
        uint256 n = handler.terminalLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.terminalIds(i);
            IProposalRegistry.Proposal memory p = reg.getProposal(id);
            assertEq(uint8(p.status), uint8(handler.terminalStatus(id)), "terminal status changed");
            assertEq(p.spent, handler.terminalSpent(id), "terminal spent changed");
            assertEq(keccak256(p.receiptRef), handler.terminalReceiptHash(id), "terminal receipt changed");
        }
    }

    /// @dev Ids are unique, and each id recomputes from its stored fields.
    function invariant_idsUnique_andRecomputable() public view {
        assertFalse(handler.duplicateIdSeen(), "propose returned an existing id");
        uint256 total = reg.proposalCount();
        bytes32[] memory ids = reg.list(0, 100);
        assertEq(ids.length, total > 100 ? 100 : total);
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 j; j < i; ++j) {
                assertTrue(ids[i] != ids[j], "duplicate id in list");
            }
            IProposalRegistry.Proposal memory p = reg.getProposal(ids[i]);
            assertEq(
                reg.computeId(p.target, p.selector, p.maxSpend, p.expiry, p.nonce, p.artifactHash),
                ids[i],
                "id does not recompute from stored fields"
            );
        }
    }

    /// @dev spent <= maxSpend, and spent is zero unless Executed.
    function invariant_spentNeverExceedsMaxSpend() public view {
        bytes32[] memory ids = reg.list(0, 100);
        for (uint256 i; i < ids.length; ++i) {
            IProposalRegistry.Proposal memory p = reg.getProposal(ids[i]);
            assertLe(p.spent, p.maxSpend, "spent > maxSpend");
            if (p.status != IProposalRegistry.Status.Executed) {
                assertEq(p.spent, 0, "spent set before execution");
            }
        }
    }

    /// @dev nextNonce never decreases, and equals the number of proposals (one nonce per proposal, no gaps).
    function invariant_nonceMonotonic_andDense() public view {
        assertFalse(handler.nonceWentBackwards(), "nonce decreased");
        assertEq(uint256(reg.config().nextNonce), reg.proposalCount(), "nonce != proposal count");
        assertEq(handler.createdLength(), reg.proposalCount(), "ghost/registry count mismatch");
    }

    /// @dev Timestamps are consistent with the status that was reached.
    function invariant_timestampsMatchStatus() public view {
        bytes32[] memory ids = reg.list(0, 100);
        for (uint256 i; i < ids.length; ++i) {
            IProposalRegistry.Proposal memory p = reg.getProposal(ids[i]);
            if (p.status == IProposalRegistry.Status.Executed) {
                assertTrue(p.approvedAt != 0 && p.executedAt >= p.approvedAt, "executed without approval");
                assertGt(p.receiptRef.length, 0, "executed without receipt");
            } else {
                assertEq(p.executedAt, 0, "executedAt set while not executed");
            }
            assertLe(p.expiry, p.createdAt + 30 days, "ttl above max");
            assertGt(p.expiry, p.createdAt, "expiry not after creation");
        }
    }

    /// @dev The registry never holds ETH: every send the handler tried was rejected.
    function invariant_noEthBalanceEver() public view {
        assertEq(address(reg).balance, 0, "registry holds ETH");
        assertEq(handler.ethSendSucceeded(), 0, "an ETH send succeeded");
    }

    /// @dev Roles stay well-formed through arbitrary ownership/proposer rotation.
    function invariant_rolesNeverZero() public view {
        IProposalRegistry.Config memory c = reg.config();
        assertTrue(c.owner != address(0), "owner is zero");
        assertTrue(c.proposer != address(0), "proposer is zero");
        assertGt(c.maxSpendCap, 0, "cap is zero");
    }

    /// @dev Reachability report: proves the walk actually reaches Approved/Executed/Cancelled/Expired.
    function afterInvariant() public view {
        console.log("created", handler.createdLength());
        console.log("approved", handler.nApproved());
        console.log("executed", handler.nExecuted());
        console.log("cancelled", handler.nCancelled());
        console.log("expired-observed", handler.nExpiredObserved());
    }
}
