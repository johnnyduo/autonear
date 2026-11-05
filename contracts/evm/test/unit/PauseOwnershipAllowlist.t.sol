// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice Pause semantics, two-step ownership, allowlist behaviour and constructor guards.
contract PauseOwnershipAllowlistTest is BaseTest {
    // ------------------------------------------------------------------ pause

    function test_Pause_BlocksProposeApproveAndExecute() public {
        bytes32 pending = _propose();
        bytes32 approved = _proposeApproved();
        vm.prank(owner);
        reg.pause();
        assertTrue(reg.config().paused);

        Args memory a = _args();
        vm.expectRevert(IProposalRegistry.RegistryPaused.selector);
        _proposeAs(proposer, a);
        vm.expectRevert(IProposalRegistry.RegistryPaused.selector);
        _proposeAs(owner, a);

        vm.startPrank(owner);
        vm.expectRevert(IProposalRegistry.RegistryPaused.selector);
        reg.approve(pending);
        vm.expectRevert(IProposalRegistry.RegistryPaused.selector);
        reg.markExecuted(approved, 1, hex"01");
        vm.stopPrank();
    }

    function test_Pause_DoesNotBlockCancel() public {
        bytes32 pending = _propose();
        bytes32 approved = _proposeApproved();
        vm.prank(owner);
        reg.pause();

        vm.prank(proposer);
        reg.cancel(pending);
        vm.prank(owner);
        reg.cancel(approved);
        assertEq(uint8(_status(pending)), uint8(IProposalRegistry.Status.Cancelled));
        assertEq(uint8(_status(approved)), uint8(IProposalRegistry.Status.Cancelled));
    }

    function test_Pause_ViewsStillWork() public {
        bytes32 id = _propose();
        vm.prank(owner);
        reg.pause();
        assertEq(reg.getProposal(id).id, id);
        assertEq(reg.list(0, 10).length, 1);
        assertTrue(reg.isAllowed(target, SEL));
        assertEq(reg.proposalCount(), 1);
        reg.config();
        reg.computeId(target, SEL, 1, 1, 1, ARTIFACT);
    }

    function test_Pause_AdminStillWorksWhilePaused() public {
        vm.startPrank(owner);
        reg.pause();
        reg.addAllowed(target2, SEL);
        reg.setMaxSpendCap(5 ether);
        reg.setProposer(makeAddr("p2"));
        vm.stopPrank();
    }

    function test_Unpause_RestoresOperation() public {
        bytes32 id = _propose();
        vm.startPrank(owner);
        reg.pause();
        reg.unpause();
        reg.approve(id);
        vm.stopPrank();
        assertFalse(reg.config().paused);
        _proposeAs(proposer, _args());
    }

    function test_Pause_ProposeByOutsiderReportsAuthBeforePause() public {
        vm.prank(owner);
        reg.pause();
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotProposerOrOwner.selector, outsider));
        _proposeAs(outsider, a);
    }

    function test_Pause_TwiceAndUnpauseWhenNotPausedRevert() public {
        vm.startPrank(owner);
        vm.expectRevert(IProposalRegistry.NotPaused.selector);
        reg.unpause();
        reg.pause();
        vm.expectRevert(IProposalRegistry.AlreadyPaused.selector);
        reg.pause();
        vm.stopPrank();
    }

    // -------------------------------------------------------------- ownership

    function test_Ownership_TwoStepTransfer() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        assertEq(reg.config().owner, owner, "not transferred yet");
        assertEq(reg.config().pendingOwner, newOwner);

        // Old owner still has the powers; pending owner has none until it accepts.
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, newOwner));
        reg.pause();

        vm.prank(newOwner);
        reg.acceptOwnership();
        assertEq(reg.config().owner, newOwner);
        assertEq(reg.config().pendingOwner, address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, owner));
        reg.pause();
        vm.prank(newOwner);
        reg.pause();
    }

    function test_Ownership_WrongAcceptorReverts() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, outsider));
        reg.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, owner));
        reg.acceptOwnership();
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, proposer));
        reg.acceptOwnership();
        assertEq(reg.config().owner, owner);
    }

    function test_Ownership_AcceptTwiceReverts() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.startPrank(newOwner);
        reg.acceptOwnership();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, newOwner));
        reg.acceptOwnership();
        vm.stopPrank();
    }

    function test_Ownership_ZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.ZeroAddress.selector);
        reg.transferOwnership(address(0));
    }

    function test_Ownership_SelfTransferReverts() public {
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.SelfTransfer.selector);
        reg.transferOwnership(owner);
    }

    function test_Ownership_SecondTransferOverwritesPending() public {
        address other = makeAddr("other");
        vm.startPrank(owner);
        reg.transferOwnership(newOwner);
        reg.transferOwnership(other);
        vm.stopPrank();
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, newOwner));
        reg.acceptOwnership();
        vm.prank(other);
        reg.acceptOwnership();
        assertEq(reg.config().owner, other);
    }

    function test_Ownership_NewOwnerCanApproveOldProposals() public {
        bytes32 id = _propose();
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();
        vm.prank(newOwner);
        reg.approve(id);
    }

    // ---------------------------------------------------------------- allowlist

    function test_Allowlist_RemovalAfterCreationBlocksApproval() public {
        bytes32 id = _propose();
        vm.startPrank(owner);
        reg.removeAllowed(target, SEL);
        assertFalse(reg.isAllowed(target, SEL));
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAllowlisted.selector, target, SEL));
        reg.approve(id);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Pending), "left pending, not cancelled");
    }

    function test_Allowlist_ReAddingRestoresApproval() public {
        bytes32 id = _propose();
        vm.startPrank(owner);
        reg.removeAllowed(target, SEL);
        reg.addAllowed(target, SEL);
        reg.approve(id);
        vm.stopPrank();
    }

    function test_Allowlist_RemovalAfterApprovalDoesNotBlockExecutionRecord() public {
        // Documented choice: approval is the owner's explicit decision; only approve re-checks the allowlist.
        bytes32 id = _proposeApproved();
        vm.startPrank(owner);
        reg.removeAllowed(target, SEL);
        reg.markExecuted(id, 1, hex"01");
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Executed));
    }

    function test_Allowlist_RemovalBlocksNewProposals() public {
        vm.prank(owner);
        reg.removeAllowed(target, SEL);
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAllowlisted.selector, target, SEL));
        _proposeAs(proposer, a);
    }

    function test_Allowlist_DuplicateAddAndMissingRemoveRevert() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.AlreadyAllowlisted.selector, target, SEL));
        reg.addAllowed(target, SEL);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.AllowlistEntryMissing.selector, target2, SEL)
        );
        reg.removeAllowed(target2, SEL);
        vm.stopPrank();
    }

    function test_Allowlist_ZeroTargetRejected() public {
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.ZeroAddress.selector);
        reg.addAllowed(address(0), SEL);
    }

    function test_Allowlist_PairsAreIndependent() public {
        vm.prank(owner);
        reg.addAllowed(target2, SEL2);
        assertTrue(reg.isAllowed(target2, SEL2));
        assertFalse(reg.isAllowed(target2, SEL));
        assertFalse(reg.isAllowed(target, SEL2));
    }

    // --------------------------------------------------------- config setters

    function test_SetProposer_ZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.ZeroAddress.selector);
        reg.setProposer(address(0));
    }

    function test_SetMaxSpendCap_ZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.ZeroCap.selector);
        reg.setMaxSpendCap(0);
    }

    // ------------------------------------------------------------ constructor

    function test_Constructor_ZeroOwnerOrProposerReverts() public {
        vm.expectRevert(IProposalRegistry.ZeroAddress.selector);
        new ProposalRegistry(address(0), proposer, CAP);
        vm.expectRevert(IProposalRegistry.ZeroAddress.selector);
        new ProposalRegistry(owner, address(0), CAP);
    }

    function test_Constructor_ZeroCapSelectsDefault() public {
        ProposalRegistry r = new ProposalRegistry(owner, proposer, 0);
        assertEq(r.config().maxSpendCap, r.DEFAULT_MAX_SPEND_CAP());
        assertEq(r.DEFAULT_MAX_SPEND_CAP(), 1_000_000 ether);
    }

    function test_Constants() public view {
        assertEq(reg.MAX_TTL(), 30 days);
        assertEq(reg.MAX_RECEIPT_REF_LEN(), 256);
        assertEq(reg.PROPOSAL_TYPEHASH(), keccak256(bytes(reg.PROPOSAL_TYPE())));
    }
}
