// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice Role gating: every owner/proposer-gated method, from every wrong signer.
contract AccessTest is BaseTest {
    // ---------------------------------------------------------------- propose

    function test_Propose_RevertsForOutsider() public {
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotProposerOrOwner.selector, outsider));
        _proposeAs(outsider, a);
    }

    function test_Propose_RevertsForPendingOwnerBeforeAccept() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotProposerOrOwner.selector, newOwner));
        _proposeAs(newOwner, a);
    }

    function test_Propose_OwnerMayPropose() public {
        bytes32 id = _proposeAs(owner, _args());
        assertEq(reg.getProposal(id).proposer, owner);
    }

    function test_Propose_RevertsForReplacedProposer() public {
        address replacement = makeAddr("replacement");
        vm.prank(owner);
        reg.setProposer(replacement);
        Args memory a = _args();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotProposerOrOwner.selector, proposer));
        _proposeAs(proposer, a);
        _proposeAs(replacement, a);
    }

    // ---------------------------------------------------------------- approve

    function test_Approve_RevertsForOutsider() public {
        bytes32 id = _propose();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, outsider));
        reg.approve(id);
    }

    function test_Approve_RevertsForProposer() public {
        bytes32 id = _propose();
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, proposer));
        reg.approve(id);
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Pending));
    }

    // ----------------------------------------------------------- markExecuted

    function test_MarkExecuted_RevertsForOutsider() public {
        bytes32 id = _proposeApproved();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, outsider));
        reg.markExecuted(id, 1, hex"01");
    }

    function test_MarkExecuted_RevertsForProposer() public {
        bytes32 id = _proposeApproved();
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, proposer));
        reg.markExecuted(id, 1, hex"01");
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Approved));
    }

    // ----------------------------------------------------------------- cancel

    function test_Cancel_RevertsForOutsider() public {
        bytes32 id = _propose();
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.NotAuthorizedToCancel.selector, outsider, id)
        );
        reg.cancel(id);
    }

    function test_Cancel_ProposerCanCancelOwnPending() public {
        bytes32 id = _propose();
        vm.prank(proposer);
        reg.cancel(id);
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Cancelled));
    }

    function test_Cancel_ProposerCannotCancelApproved() public {
        bytes32 id = _proposeApproved();
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.NotAuthorizedToCancel.selector, proposer, id)
        );
        reg.cancel(id);
        assertEq(uint8(_status(id)), uint8(IProposalRegistry.Status.Approved));
    }

    function test_Cancel_ProposerCannotCancelOwnerCreatedProposal() public {
        bytes32 id = _proposeAs(owner, _args());
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.NotAuthorizedToCancel.selector, proposer, id)
        );
        reg.cancel(id);
    }

    function test_Cancel_ReplacedProposerLosesRightToCancel() public {
        bytes32 id = _propose();
        vm.prank(owner);
        reg.setProposer(makeAddr("replacement"));
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.NotAuthorizedToCancel.selector, proposer, id)
        );
        reg.cancel(id);
    }

    function test_Cancel_OwnerCanCancelPendingAndApproved() public {
        bytes32 a = _propose();
        bytes32 b = _proposeApproved();
        vm.startPrank(owner);
        reg.cancel(a);
        reg.cancel(b);
        vm.stopPrank();
        assertEq(uint8(_status(a)), uint8(IProposalRegistry.Status.Cancelled));
        assertEq(uint8(_status(b)), uint8(IProposalRegistry.Status.Cancelled));
    }

    // ------------------------------------------------------- owner-only admin

    function _expectNotOwner(address who) internal {
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotOwner.selector, who));
    }

    function test_Pause_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.pause();
        _expectNotOwner(proposer);
        reg.pause();
    }

    function test_Unpause_RevertsForOutsiderAndProposer() public {
        vm.prank(owner);
        reg.pause();
        _expectNotOwner(outsider);
        reg.unpause();
        _expectNotOwner(proposer);
        reg.unpause();
    }

    function test_AddAllowed_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.addAllowed(target2, SEL);
        _expectNotOwner(proposer);
        reg.addAllowed(target2, SEL);
    }

    function test_RemoveAllowed_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.removeAllowed(target, SEL);
        _expectNotOwner(proposer);
        reg.removeAllowed(target, SEL);
    }

    function test_SetProposer_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.setProposer(outsider);
        _expectNotOwner(proposer);
        reg.setProposer(proposer);
    }

    function test_SetMaxSpendCap_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.setMaxSpendCap(1);
        _expectNotOwner(proposer);
        reg.setMaxSpendCap(1);
    }

    function test_TransferOwnership_RevertsForOutsiderAndProposer() public {
        _expectNotOwner(outsider);
        reg.transferOwnership(outsider);
        _expectNotOwner(proposer);
        reg.transferOwnership(proposer);
    }

    function test_AcceptOwnership_RevertsWhenNothingPending() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, outsider));
        reg.acceptOwnership();
    }

    function test_AcceptOwnership_RevertsForZeroAddressWhenNothingPending() public {
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotPendingOwner.selector, address(0)));
        reg.acceptOwnership();
    }
}
