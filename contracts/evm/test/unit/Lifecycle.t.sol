// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice The state machine and the propose-time validation matrix.
contract LifecycleTest is BaseTest {
    IProposalRegistry.Status internal constant PENDING = IProposalRegistry.Status.Pending;
    IProposalRegistry.Status internal constant APPROVED = IProposalRegistry.Status.Approved;
    IProposalRegistry.Status internal constant EXECUTED = IProposalRegistry.Status.Executed;
    IProposalRegistry.Status internal constant CANCELLED = IProposalRegistry.Status.Cancelled;
    IProposalRegistry.Status internal constant EXPIRED = IProposalRegistry.Status.Expired;

    // ------------------------------------------------------------- happy path

    function test_HappyPath_ProposeApproveExecute() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        assertEq(id, _expectedId(address(reg), a), "on-chain id equals independent encoding");
        assertEq(uint8(_status(id)), uint8(PENDING));

        vm.warp(T0 + 100);
        vm.prank(owner);
        reg.approve(id);
        assertEq(uint8(_status(id)), uint8(APPROVED));

        vm.warp(T0 + 200);
        vm.prank(owner);
        reg.markExecuted(id, 42 ether, bytes("0xabc:tx"));

        IProposalRegistry.Proposal memory p = reg.getProposal(id);
        assertEq(uint8(p.status), uint8(EXECUTED));
        assertEq(p.id, id);
        assertEq(p.proposer, proposer);
        assertEq(p.target, target);
        assertEq(p.selector, SEL);
        assertEq(p.maxSpend, MAX_SPEND);
        assertEq(p.expiry, a.expiry);
        assertEq(p.nonce, 0);
        assertEq(p.artifactHash, ARTIFACT);
        assertEq(p.createdAt, T0);
        assertEq(p.approvedAt, T0 + 100);
        assertEq(p.executedAt, T0 + 200);
        assertEq(p.spent, 42 ether);
        assertEq(p.receiptRef, bytes("0xabc:tx"));
    }

    function test_Propose_IncrementsNonceAndRecordsIds() public {
        bytes32 a = _propose();
        bytes32 b = _propose();
        assertEq(reg.config().nextNonce, 2);
        assertEq(reg.proposalCount(), 2);
        bytes32[] memory ids = reg.list(0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], a);
        assertEq(ids[1], b);
        assertTrue(a != b);
    }

    // --------------------------------------------------- altered field => id

    function test_AlteredField_EachFieldChangesTheId() public view {
        Args memory base = _args();
        bytes32 id = _idOf(base);

        Args memory x = _args();
        x.target = target2;
        assertTrue(_idOf(x) != id, "target");
        x = _args();
        x.selector = SEL2;
        assertTrue(_idOf(x) != id, "selector");
        x = _args();
        x.maxSpend += 1;
        assertTrue(_idOf(x) != id, "maxSpend");
        x = _args();
        x.expiry += 1;
        assertTrue(_idOf(x) != id, "expiry");
        x = _args();
        x.nonce += 1;
        assertTrue(_idOf(x) != id, "nonce");
        x = _args();
        x.artifactHash = keccak256("other");
        assertTrue(_idOf(x) != id, "artifactHash");
    }

    function test_AlteredField_ApprovalOfOriginalDoesNotApplyToAlteredId() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        Args memory altered = _args();
        altered.maxSpend = a.maxSpend + 1; // same nonce, one field changed
        bytes32 alteredId = _idOf(altered);
        assertTrue(alteredId != id);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.UnknownProposal.selector, alteredId));
        reg.approve(alteredId);

        vm.prank(owner);
        reg.approve(id);
        assertEq(uint8(_status(alteredId)), uint8(IProposalRegistry.Status.None), "altered id never approved");
    }

    function test_AlteredField_RegistryAddressAndChainAreBoundIntoTheId() public {
        Args memory a = _args();
        bytes32 id = _idOf(a);

        ProposalRegistry other = new ProposalRegistry(owner, proposer, CAP);
        assertTrue(address(other) != address(reg));
        assertEq(
            other.computeId(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash),
            _expectedId(address(other), a)
        );
        assertTrue(
            other.computeId(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash) != id,
            "registry address is part of the id"
        );

        vm.chainId(block.chainid + 1);
        assertTrue(_idOf(a) != id, "chain id is part of the id");
        assertEq(_idOf(a), _expectedId(address(reg), a));
    }

    function test_Approve_UnknownIdReverts() public {
        bytes32 bogus = keccak256("nope");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.UnknownProposal.selector, bogus));
        reg.approve(bogus);
    }

    function test_GetProposal_UnknownIdReverts() public {
        bytes32 bogus = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.UnknownProposal.selector, bogus));
        reg.getProposal(bogus);
        assertEq(uint8(reg.statusOf(bogus)), uint8(IProposalRegistry.Status.None));
    }

    // ----------------------------------------------- wrong target / wrong method

    function test_Propose_WrongTargetReverts() public {
        Args memory a = _args();
        a.target = target2; // allowlisted selector, wrong target
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAllowlisted.selector, target2, SEL));
        _proposeAs(proposer, a);
    }

    function test_Propose_WrongMethodReverts() public {
        Args memory a = _args();
        a.selector = SEL2; // allowlisted target, wrong method
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.NotAllowlisted.selector, target, SEL2));
        _proposeAs(proposer, a);
    }

    // ------------------------------------------------------------ spend limits

    function test_Propose_ExceedsCapReverts() public {
        Args memory a = _args();
        a.maxSpend = CAP + 1;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.MaxSpendExceedsCap.selector, CAP + 1, CAP));
        _proposeAs(proposer, a);
    }

    function test_Propose_ExactlyCapSucceeds() public {
        Args memory a = _args();
        a.maxSpend = CAP;
        _proposeAs(proposer, a);
    }

    function test_Propose_ZeroMaxSpendReverts() public {
        Args memory a = _args();
        a.maxSpend = 0;
        vm.expectRevert(IProposalRegistry.ZeroMaxSpend.selector);
        _proposeAs(proposer, a);
    }

    function test_MarkExecuted_SpentAboveMaxSpendReverts() public {
        bytes32 id = _proposeApproved();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.SpentExceedsMaxSpend.selector, MAX_SPEND + 1, MAX_SPEND)
        );
        reg.markExecuted(id, MAX_SPEND + 1, hex"01");
        assertEq(uint8(_status(id)), uint8(APPROVED), "still approved, may retry");
    }

    function test_MarkExecuted_SpentEqualToMaxAndZeroSucceed() public {
        bytes32 a = _proposeApproved();
        bytes32 b = _proposeApproved();
        vm.startPrank(owner);
        reg.markExecuted(a, MAX_SPEND, hex"01");
        reg.markExecuted(b, 0, hex"02");
        vm.stopPrank();
        assertEq(reg.getProposal(a).spent, MAX_SPEND);
        assertEq(reg.getProposal(b).spent, 0);
    }

    function test_MarkExecuted_EmptyReceiptRefReverts() public {
        bytes32 id = _proposeApproved();
        vm.prank(owner);
        vm.expectRevert(IProposalRegistry.EmptyReceiptRef.selector);
        reg.markExecuted(id, 1, "");
    }

    function test_MarkExecuted_ReceiptRefTooLongReverts() public {
        bytes32 id = _proposeApproved();
        bytes memory tooLong = new bytes(257);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ReceiptRefTooLong.selector, 257, 256));
        reg.markExecuted(id, 1, tooLong);
        bytes memory max = new bytes(256);
        max[0] = 0x01;
        vm.prank(owner);
        reg.markExecuted(id, 1, max);
    }

    function test_SetMaxSpendCap_LoweringDoesNotInvalidateExistingProposal() public {
        bytes32 id = _propose();
        vm.startPrank(owner);
        reg.setMaxSpendCap(1 ether);
        reg.approve(id);
        reg.markExecuted(id, MAX_SPEND, hex"01");
        vm.stopPrank();
        Args memory a = _args();
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.MaxSpendExceedsCap.selector, MAX_SPEND, 1 ether)
        );
        _proposeAs(proposer, a);
    }

    // ----------------------------------------------------------------- expiry

    function test_Propose_ExpiryInPastReverts() public {
        Args memory a = _args();
        a.expiry = T0_64 - 1;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ExpiryNotInFuture.selector, a.expiry, T0));
        _proposeAs(proposer, a);
    }

    function test_Propose_ExpiryEqualNowReverts() public {
        Args memory a = _args();
        a.expiry = T0_64;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ExpiryNotInFuture.selector, a.expiry, T0));
        _proposeAs(proposer, a);
    }

    function test_Propose_ExpiryBeyondMaxTtlReverts() public {
        Args memory a = _args();
        a.expiry = T0_64 + 30 days + 1;
        vm.expectRevert(
            abi.encodeWithSelector(IProposalRegistry.ExpiryTooFar.selector, a.expiry, T0 + 30 days)
        );
        _proposeAs(proposer, a);
    }

    function test_Propose_ExpiryExactlyMaxTtlAndOneSecondSucceed() public {
        Args memory a = _args();
        a.expiry = T0_64 + 30 days;
        _proposeAs(proposer, a);
        a = _args();
        a.expiry = T0_64 + 1;
        _proposeAs(proposer, a);
    }

    function test_Approve_ExpiredReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.warp(a.expiry + 1);
        assertEq(uint8(_status(id)), uint8(EXPIRED), "derived");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalExpired.selector, id, a.expiry));
        reg.approve(id);
    }

    function test_Approve_AtExactExpirySucceeds() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.warp(a.expiry); // now == expiry is not yet expired (expired iff now > expiry)
        vm.prank(owner);
        reg.approve(id);
    }

    function test_MarkExecuted_ExpiredReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.prank(owner);
        reg.approve(id);
        vm.warp(a.expiry + 1);
        assertEq(uint8(_status(id)), uint8(EXPIRED));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalExpired.selector, id, a.expiry));
        reg.markExecuted(id, 1, hex"01");
    }

    function test_Cancel_ExpiredReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.warp(a.expiry + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalExpired.selector, id, a.expiry));
        reg.cancel(id);
        assertEq(uint8(_status(id)), uint8(EXPIRED));
    }

    function test_Expired_ExecutedAndCancelledStayTerminalAfterExpiry() public {
        Args memory a = _args();
        bytes32 executed = _proposeAs(proposer, a);
        bytes32 cancelled = _propose();
        vm.startPrank(owner);
        reg.approve(executed);
        reg.markExecuted(executed, 1, hex"01");
        reg.cancel(cancelled);
        vm.stopPrank();
        vm.warp(a.expiry + 365 days);
        assertEq(uint8(_status(executed)), uint8(EXECUTED));
        assertEq(uint8(_status(cancelled)), uint8(CANCELLED));
    }

    // ------------------------------------------------------- replay and nonces

    function test_Propose_ReplayOfIdenticalProposalReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalAlreadyExists.selector, id));
        _proposeAs(proposer, a);
        assertEq(reg.proposalCount(), 1);
    }

    function test_Propose_ReplayAfterExecutionStillReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.startPrank(owner);
        reg.approve(id);
        reg.markExecuted(id, 1, hex"01");
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalAlreadyExists.selector, id));
        _proposeAs(proposer, a);
    }

    function test_Propose_ReplayAfterCancelStillReverts() public {
        Args memory a = _args();
        bytes32 id = _proposeAs(proposer, a);
        vm.prank(proposer);
        reg.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.ProposalAlreadyExists.selector, id));
        _proposeAs(proposer, a);
    }

    function test_Propose_NonceTooHighReverts() public {
        Args memory a = _args();
        a.nonce = 1;
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.BadNonce.selector, 0, 1));
        _proposeAs(proposer, a);
    }

    function test_Propose_NonceTooLowReverts() public {
        _propose(); // consumes nonce 0
        _propose(); // consumes nonce 1
        Args memory a = _args(); // next = 2
        a.nonce = 0;
        a.maxSpend = 7 ether; // different fields so the id is new and the nonce check is what fires
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.BadNonce.selector, 2, 0));
        _proposeAs(proposer, a);
    }

    function test_Propose_NonceReuseWithDifferentFieldsReverts() public {
        _propose(); // consumes nonce 0
        Args memory a = _args();
        a.nonce = 0;
        a.artifactHash = keccak256("different artifact");
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.BadNonce.selector, 1, 0));
        _proposeAs(proposer, a);
    }

    function test_Propose_FailedProposeDoesNotConsumeNonce() public {
        Args memory a = _args();
        a.maxSpend = CAP + 1;
        vm.expectRevert();
        _proposeAs(proposer, a);
        assertEq(reg.config().nextNonce, 0);
    }

    function test_Nonce_IsSingleGlobalCounterAcrossProposers() public {
        _proposeAs(proposer, _args());
        _proposeAs(owner, _args());
        assertEq(reg.config().nextNonce, 2);
    }

    // ---------------------------------------------------- illegal transitions

    function test_MarkExecuted_DoubleExecuteReverts() public {
        bytes32 id = _proposeApproved();
        vm.startPrank(owner);
        reg.markExecuted(id, 1, hex"01");
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, EXECUTED));
        reg.markExecuted(id, 1, hex"02");
        vm.stopPrank();
        assertEq(reg.getProposal(id).receiptRef, hex"01", "first receipt preserved");
    }

    function test_MarkExecuted_BeforeApproveReverts() public {
        bytes32 id = _propose();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, PENDING));
        reg.markExecuted(id, 1, hex"01");
    }

    function test_MarkExecuted_AfterCancelReverts() public {
        bytes32 id = _proposeApproved();
        vm.startPrank(owner);
        reg.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, CANCELLED));
        reg.markExecuted(id, 1, hex"01");
        vm.stopPrank();
    }

    function test_MarkExecuted_UnknownIdReverts() public {
        bytes32 bogus = keccak256("nope");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.UnknownProposal.selector, bogus));
        reg.markExecuted(bogus, 1, hex"01");
    }

    function test_Approve_AfterCancelReverts() public {
        bytes32 id = _propose();
        vm.prank(proposer);
        reg.cancel(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, CANCELLED));
        reg.approve(id);
    }

    function test_Approve_TwiceReverts() public {
        bytes32 id = _proposeApproved();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, APPROVED));
        reg.approve(id);
    }

    function test_Approve_AfterExecuteReverts() public {
        bytes32 id = _proposeApproved();
        vm.startPrank(owner);
        reg.markExecuted(id, 1, hex"01");
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, EXECUTED));
        reg.approve(id);
        vm.stopPrank();
    }

    function test_Cancel_AfterExecuteReverts() public {
        bytes32 id = _proposeApproved();
        vm.startPrank(owner);
        reg.markExecuted(id, 1, hex"01");
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, EXECUTED));
        reg.cancel(id);
        vm.stopPrank();
    }

    function test_Cancel_TwiceReverts() public {
        bytes32 id = _propose();
        vm.startPrank(owner);
        reg.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.InvalidStatus.selector, id, CANCELLED));
        reg.cancel(id);
        vm.stopPrank();
    }

    function test_Cancel_UnknownIdReverts() public {
        bytes32 bogus = keccak256("nope");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IProposalRegistry.UnknownProposal.selector, bogus));
        reg.cancel(bogus);
    }

    // ------------------------------------------------------------------ views

    function test_List_Pagination() public {
        bytes32[] memory made = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            made[i] = _propose();
        }
        assertEq(reg.list(0, 2).length, 2);
        assertEq(reg.list(0, 2)[1], made[1]);
        assertEq(reg.list(4, 10).length, 1);
        assertEq(reg.list(4, 10)[0], made[4]);
        assertEq(reg.list(5, 10).length, 0);
        assertEq(reg.list(99, 10).length, 0);
        assertEq(reg.list(0, 0).length, 0);
        assertEq(reg.list(0, type(uint256).max).length, 5, "limit is clamped, no overflow");
    }

    function test_Config_ReportsState() public view {
        IProposalRegistry.Config memory c = reg.config();
        assertEq(c.owner, owner);
        assertEq(c.pendingOwner, address(0));
        assertEq(c.proposer, proposer);
        assertFalse(c.paused);
        assertEq(c.networkId, block.chainid);
        assertEq(c.nextNonce, 0);
        assertEq(c.maxSpendCap, CAP);
    }
}
