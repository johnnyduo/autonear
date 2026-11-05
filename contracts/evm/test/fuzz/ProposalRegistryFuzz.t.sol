// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice Property tests over the whole input space.
contract ProposalRegistryFuzzTest is BaseTest {
    IProposalRegistry.Status internal constant PENDING = IProposalRegistry.Status.Pending;

    // ---------------------------------------------------------------- identity

    /// @dev The on-chain id always equals an independent keccak256(abi.encode(...)) of the EIP-712 struct.
    function testFuzz_Id_MatchesIndependentEncoding(Args memory a) public view {
        assertEq(_idOf(a), _expectedId(address(reg), a));
    }

    /// @dev Distinct field tuples yield distinct ids (collision-freedom over generated pairs).
    function testFuzz_Id_DistinctFieldsDistinctIds(Args memory a, Args memory b) public view {
        bool same = a.target == b.target && a.selector == b.selector && a.maxSpend == b.maxSpend
            && a.expiry == b.expiry && a.nonce == b.nonce && a.artifactHash == b.artifactHash;
        assertEq(_idOf(a) == _idOf(b), same);
    }

    /// @dev Flipping any single field changes the id.
    function testFuzz_Id_SingleFieldMutationChangesId(Args memory a, uint8 which) public view {
        bytes32 id = _idOf(a);
        Args memory m = Args(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash);
        which = which % 6;
        if (which == 0) m.target = address(uint160(a.target) ^ 1);
        else if (which == 1) m.selector = bytes4(uint32(a.selector) ^ 1);
        else if (which == 2) m.maxSpend = a.maxSpend ^ 1;
        else if (which == 3) m.expiry = a.expiry ^ 1;
        else if (which == 4) m.nonce = a.nonce ^ 1;
        else m.artifactHash = a.artifactHash ^ bytes32(uint256(1));
        assertTrue(_idOf(m) != id);
    }

    // ----------------------------------------------------------------- propose

    function testFuzz_Propose_ValidInputsRecordExactly(uint256 maxSpend, uint64 ttl, bytes32 artifact)
        public
    {
        maxSpend = bound(maxSpend, 1, CAP);
        ttl = uint64(bound(ttl, 1, 30 days));
        Args memory a = _args();
        a.maxSpend = maxSpend;
        a.expiry = uint64(block.timestamp) + ttl;
        a.artifactHash = artifact;
        bytes32 id = _proposeAs(proposer, a);
        IProposalRegistry.Proposal memory p = reg.getProposal(id);
        assertEq(id, _expectedId(address(reg), a));
        assertEq(p.maxSpend, maxSpend);
        assertEq(p.expiry, a.expiry);
        assertEq(p.artifactHash, artifact);
        assertEq(uint8(p.status), uint8(PENDING));
        assertEq(reg.config().nextNonce, 1);
    }

    function testFuzz_Propose_OverCapAlwaysReverts(uint256 maxSpend) public {
        maxSpend = bound(maxSpend, CAP + 1, type(uint256).max);
        Args memory a = _args();
        a.maxSpend = maxSpend;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.MaxSpendExceedsCap.selector, maxSpend, CAP));
        _proposeAs(proposer, a);
    }

    function testFuzz_Propose_ExpiryOutsideWindowReverts(uint64 expiry) public {
        vm.assume(expiry <= T0 || expiry > T0 + 30 days);
        Args memory a = _args();
        a.expiry = expiry;
        vm.expectRevert();
        _proposeAs(proposer, a);
    }

    function testFuzz_Propose_OnlyNextNonceAccepted(uint64 nonce) public {
        vm.assume(nonce != 0);
        Args memory a = _args();
        a.nonce = nonce;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.BadNonce.selector, 0, nonce));
        _proposeAs(proposer, a);
    }

    function testFuzz_Propose_NonAllowlistedPairReverts(address t, bytes4 s) public {
        vm.assume(!(t == target && s == SEL));
        Args memory a = _args();
        a.target = t;
        a.selector = s;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAllowlisted.selector, t, s));
        _proposeAs(proposer, a);
    }

    // ------------------------------------------------------------ execution

    function testFuzz_MarkExecuted_SpentBoundary(uint256 spent) public {
        bytes32 id = _proposeApproved();
        vm.prank(owner);
        if (spent > MAX_SPEND) {
            vm.expectRevert(
                abi.encodeWithSelector(IProposalRegistry.SpentExceedsMaxSpend.selector, spent, MAX_SPEND)
            );
            reg.markExecuted(id, spent, hex"01");
        } else {
            reg.markExecuted(id, spent, hex"01");
            assertEq(reg.getProposal(id).spent, spent);
            assertLe(reg.getProposal(id).spent, reg.getProposal(id).maxSpend);
        }
    }

    function testFuzz_MarkExecuted_ReceiptLengthBounds(uint16 len) public {
        bytes32 id = _proposeApproved();
        bytes memory ref = new bytes(len);
        vm.prank(owner);
        if (len == 0 || len > 256) {
            vm.expectRevert();
            reg.markExecuted(id, 1, ref);
        } else {
            reg.markExecuted(id, 1, ref);
            assertEq(reg.getProposal(id).receiptRef.length, len);
        }
    }

    // ---------------------------------------------------------------- expiry

    function testFuzz_Expiry_MutationsRevertOnlyAfterExpiry(uint64 dt) public {
        dt = uint64(bound(dt, 0, 60 days));
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.warp(T0 + dt);
        bool expired = block.timestamp > a.expiry;
        assertEq(uint8(_status(id)), uint8(expired ? IProposalRegistry.Status.Expired : PENDING));
        vm.prank(owner);
        if (expired) {
            vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalExpired.selector, id, a.expiry));
        }
        reg.approve(id);
    }

    // -------------------------------------------------------- access control

    function testFuzz_AdminMethods_RevertForAnyNonOwner(address caller) public {
        vm.assume(caller != owner);
        bytes32 id = _propose();
        bytes memory err = abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, caller);
        vm.startPrank(caller);
        vm.expectRevert(err);
        reg.approve(id);
        vm.expectRevert(err);
        reg.markExecuted(id, 1, hex"01");
        vm.expectRevert(err);
        reg.pause();
        vm.expectRevert(err);
        reg.unpause();
        vm.expectRevert(err);
        reg.addAllowed(target2, SEL);
        vm.expectRevert(err);
        reg.removeAllowed(target, SEL);
        vm.expectRevert(err);
        reg.setProposer(caller);
        vm.expectRevert(err);
        reg.setMaxSpendCap(1);
        vm.expectRevert(err);
        reg.transferOwnership(caller);
        vm.stopPrank();
    }

    function testFuzz_Propose_RevertsForAnyoneButProposerOrOwner(address caller) public {
        vm.assume(caller != owner && caller != proposer);
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotProposerOrOwner.selector, caller));
        _proposeAs(caller, a);
    }

    function testFuzz_Cancel_RevertsForAnyoneButOwnerAndProposer(address caller) public {
        vm.assume(caller != owner && caller != proposer);
        bytes32 id = _propose();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAuthorizedToCancel.selector, caller, id));
        reg.cancel(id);
    }

    function testFuzz_AcceptOwnership_OnlyPendingOwner(address candidate, address caller) public {
        vm.assume(candidate != address(0) && candidate != owner);
        vm.prank(owner);
        reg.transferOwnership(candidate);
        vm.prank(caller);
        if (caller != candidate) {
            vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, caller));
        }
        reg.acceptOwnership();
    }

    // ------------------------------------------------------ terminal states

    /// @dev Drive a random op sequence at one proposal; once Executed/Cancelled, nothing changes it.
    function testFuzz_TerminalStatesNeverLeave(uint8[12] memory ops, uint32[12] memory dts) public {
        bytes32 id = _propose();
        IProposalRegistry.Status terminal = IProposalRegistry.Status.None;
        uint256 spentAtTerminal;
        for (uint256 i; i < ops.length; ++i) {
            vm.warp(block.timestamp + (dts[i] % 3 days)); // may cross expiry (7 days) eventually
            uint8 op = ops[i] % 6;
            vm.startPrank(op == 5 ? proposer : owner);
            if (op == 0) {
                try reg.approve(id) {} catch {}
            } else if (op == 1) {
                try reg.markExecuted(id, 1 ether, hex"aa") {} catch {}
            } else if (op == 2) {
                try reg.cancel(id) {} catch {}
            } else if (op == 3) {
                try reg.pause() {} catch {}
            } else if (op == 4) {
                try reg.unpause() {} catch {}
            } else {
                try reg.cancel(id) {} catch {}
            }
            vm.stopPrank();

            IProposalRegistry.Status s = _status(id);
            if (terminal == IProposalRegistry.Status.None) {
                if (s == IProposalRegistry.Status.Executed || s == IProposalRegistry.Status.Cancelled) {
                    terminal = s;
                    spentAtTerminal = reg.getProposal(id).spent;
                }
            } else {
                assertEq(uint8(s), uint8(terminal), "left a terminal state");
                assertEq(reg.getProposal(id).spent, spentAtTerminal, "spent mutated after terminal");
            }
            assertLe(reg.getProposal(id).spent, MAX_SPEND);
        }
    }

    /// @dev Distinct (nonce-bound) proposals never collide, whatever the other fields are.
    function testFuzz_Ids_UniqueAcrossSequentialProposals(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 20));
        bytes32[] memory seen = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            Args memory a = _args();
            a.maxSpend = bound(uint256(keccak256(abi.encode(seed, i))), 1, CAP);
            a.artifactHash = keccak256(abi.encode(seed, i));
            seen[i] = _proposeAs(proposer, a);
            for (uint256 j; j < i; ++j) {
                assertTrue(seen[i] != seen[j]);
            }
        }
        assertEq(reg.proposalCount(), n);
        assertEq(reg.config().nextNonce, n);
    }
}
