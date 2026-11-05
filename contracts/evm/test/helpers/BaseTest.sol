// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixture: a registry owned by `owner`, proposed to by `proposer`, with one allowlisted pair.
abstract contract BaseTest is Test {
    uint256 internal constant T0 = 1_700_000_000;
    uint64 internal constant T0_64 = 1_700_000_000;
    uint256 internal constant CAP = 1000 ether;
    uint256 internal constant MAX_SPEND = 100 ether;
    uint64 internal constant TTL = 7 days;
    bytes4 internal constant SEL = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 internal constant SEL2 = bytes4(keccak256("approve(address,uint256)"));
    bytes32 internal constant ARTIFACT = keccak256("artifact-v1");

    ProposalRegistry internal reg;

    address internal owner = makeAddr("owner");
    address internal proposer = makeAddr("proposer");
    address internal outsider = makeAddr("outsider");
    address internal newOwner = makeAddr("newOwner");
    address internal target = makeAddr("target");
    address internal target2 = makeAddr("target2");

    struct Args {
        address target;
        bytes4 selector;
        uint256 maxSpend;
        uint64 expiry;
        uint64 nonce;
        bytes32 artifactHash;
    }

    function setUp() public virtual {
        vm.warp(T0);
        reg = new ProposalRegistry(owner, proposer, CAP);
        vm.prank(owner);
        reg.addAllowed(target, SEL);
    }

    /// @dev Valid arguments for the next nonce.
    function _args() internal view returns (Args memory a) {
        a = Args({
            target: target,
            selector: SEL,
            maxSpend: MAX_SPEND,
            expiry: uint64(block.timestamp) + TTL,
            nonce: reg.config().nextNonce,
            artifactHash: ARTIFACT
        });
    }

    function _proposeAs(address who, Args memory a) internal returns (bytes32 id) {
        vm.prank(who);
        id = reg.propose(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash);
    }

    function _propose() internal returns (bytes32 id) {
        id = _proposeAs(proposer, _args());
    }

    function _proposeApproved() internal returns (bytes32 id) {
        id = _propose();
        vm.prank(owner);
        reg.approve(id);
    }

    function _idOf(Args memory a) internal view returns (bytes32) {
        return reg.computeId(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash);
    }

    /// @dev Independent re-implementation of the id, deliberately not sharing code with the contract.
    function _expectedId(address registry, Args memory a) internal view returns (bytes32) {
        bytes32 typehash = keccak256(
            "Proposal(uint256 chainId,address registry,address target,bytes4 selector,uint256 maxSpend,uint64 expiry,uint64 nonce,bytes32 artifactHash)"
        );
        return keccak256(
            abi.encode(
                typehash,
                block.chainid,
                registry,
                a.target,
                a.selector,
                a.maxSpend,
                a.expiry,
                a.nonce,
                a.artifactHash
            )
        );
    }

    function _status(bytes32 id) internal view returns (IProposalRegistry.Status) {
        return reg.statusOf(id);
    }
}
