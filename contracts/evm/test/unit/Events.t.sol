// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice Every mutation emits its event, with the exact indexed fields.
contract EventsTest is BaseTest {
    function test_Event_Constructor() public {
        vm.expectEmit(true, true, false, false);
        emit IProposalRegistry.OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, true, false, false);
        emit IProposalRegistry.ProposerSet(address(0), proposer);
        vm.expectEmit(false, false, false, true);
        emit IProposalRegistry.MaxSpendCapSet(0, CAP);
        new ProposalRegistry(owner, proposer, CAP);
    }

    function test_Event_Proposed() public {
        Args memory a = _args();
        bytes32 id = _idOf(a);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IProposalRegistry.Proposed(
            id, proposer, a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash
        );
        _proposeAs(proposer, a);
    }

    function test_Event_Approved() public {
        bytes32 id = _propose();
        vm.expectEmit(true, true, false, false, address(reg));
        emit IProposalRegistry.Approved(id, owner);
        vm.prank(owner);
        reg.approve(id);
    }

    function test_Event_Executed() public {
        bytes32 id = _proposeApproved();
        vm.expectEmit(true, true, false, true, address(reg));
        emit IProposalRegistry.Executed(id, owner, 5 ether, bytes("receipt"));
        vm.prank(owner);
        reg.markExecuted(id, 5 ether, bytes("receipt"));
    }

    function test_Event_Cancelled() public {
        bytes32 id = _propose();
        vm.expectEmit(true, true, false, false, address(reg));
        emit IProposalRegistry.Cancelled(id, proposer);
        vm.prank(proposer);
        reg.cancel(id);
    }

    function test_Event_PausedUnpaused() public {
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, false, address(reg));
        emit IProposalRegistry.Paused(owner);
        reg.pause();
        vm.expectEmit(true, false, false, false, address(reg));
        emit IProposalRegistry.Unpaused(owner);
        reg.unpause();
        vm.stopPrank();
    }

    function test_Event_AllowlistUpdated() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, true, address(reg));
        emit IProposalRegistry.AllowlistUpdated(target2, SEL2, true);
        reg.addAllowed(target2, SEL2);
        vm.expectEmit(true, true, false, true, address(reg));
        emit IProposalRegistry.AllowlistUpdated(target2, SEL2, false);
        reg.removeAllowed(target2, SEL2);
        vm.stopPrank();
    }

    function test_Event_ProposerSetAndCapSet() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, false, address(reg));
        emit IProposalRegistry.ProposerSet(proposer, outsider);
        reg.setProposer(outsider);
        vm.expectEmit(false, false, false, true, address(reg));
        emit IProposalRegistry.MaxSpendCapSet(CAP, 7);
        reg.setMaxSpendCap(7);
        vm.stopPrank();
    }

    function test_Event_Ownership() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit IProposalRegistry.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.expectEmit(true, true, false, false, address(reg));
        emit IProposalRegistry.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();
    }
}
