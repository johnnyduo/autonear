// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @dev Force-feeds ETH the only way a contract cannot refuse: self-destruct (EIP-6780 keeps value transfer).
contract ForceSender {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// @notice Reject-all-ETH, no external calls, and runtime-code == artifact (no immutables).
contract NoFundsNoCallsTest is BaseTest {
    function test_Eth_PlainTransferReverts() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok,) = address(reg).call{value: 1 wei}("");
        assertFalse(ok, "receive must not exist");
        assertEq(address(reg).balance, 0);
    }

    function test_Eth_UnknownCalldataWithValueReverts() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok,) = address(reg).call{value: 1 wei}(hex"deadbeef");
        assertFalse(ok, "fallback must not exist");
        vm.prank(outsider);
        (ok,) = address(reg).call(hex"deadbeef");
        assertFalse(ok, "no fallback even without value");
        assertEq(address(reg).balance, 0);
    }

    function test_Eth_ValueToEveryMutatorReverts() public {
        vm.deal(owner, 10 ether);
        vm.deal(proposer, 10 ether);
        bytes32 id = _propose();
        bytes[] memory calls = new bytes[](11);
        calls[0] = abi.encodeCall(reg.propose, (target, SEL, 1, T0_64 + 10, 1, ARTIFACT));
        calls[1] = abi.encodeCall(reg.approve, (id));
        calls[2] = abi.encodeCall(reg.markExecuted, (id, 1, hex"01"));
        calls[3] = abi.encodeCall(reg.cancel, (id));
        calls[4] = abi.encodeCall(reg.pause, ());
        calls[5] = abi.encodeCall(reg.unpause, ());
        calls[6] = abi.encodeCall(reg.addAllowed, (target2, SEL));
        calls[7] = abi.encodeCall(reg.removeAllowed, (target, SEL));
        calls[8] = abi.encodeCall(reg.setProposer, (outsider));
        calls[9] = abi.encodeCall(reg.setMaxSpendCap, (5));
        calls[10] = abi.encodeCall(reg.transferOwnership, (newOwner));
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(owner);
            (bool ok,) = address(reg).call{value: 1 wei}(calls[i]);
            assertFalse(ok, "non-payable function accepted value");
        }
        vm.prank(newOwner);
        vm.deal(newOwner, 1 ether);
        (bool ok2,) = address(reg).call{value: 1 wei}(abi.encodeCall(reg.acceptOwnership, ()));
        assertFalse(ok2);
        assertEq(address(reg).balance, 0);
    }

    function test_Eth_ForcedSelfdestructEthIsStrandedAndHarmless() public {
        // ETH can be force-sent by SELFDESTRUCT; the contract has no way to read, move or depend on it.
        new ForceSender{value: 1 ether}(payable(address(reg)));
        assertEq(address(reg).balance, 1 ether, "documented limitation: forced ETH cannot be refused");
        // Behaviour is unchanged and there is no function that could send it out.
        bytes32 id = _proposeApproved();
        vm.prank(owner);
        reg.markExecuted(id, 1, hex"01");
        assertEq(address(reg).balance, 1 ether, "still stranded: no code path moves value");
    }

    function test_NoExternalCalls_SourceContainsNoCallPrimitives() public view {
        string memory src = vm.readFile("src/ProposalRegistry.sol");
        string[9] memory banned = [
            ".call(",
            ".call{",
            ".delegatecall(",
            ".staticcall(",
            ".transfer(",
            ".send(",
            "selfdestruct",
            "receive()",
            "fallback()"
        ];
        for (uint256 i; i < banned.length; ++i) {
            assertEq(vm.indexOf(src, banned[i]), type(uint256).max, banned[i]);
        }
        assertEq(vm.indexOf(src, "payable"), type(uint256).max, "payable");
        assertEq(vm.indexOf(src, "immutable"), type(uint256).max, "immutable");
        assertEq(vm.indexOf(src, "assembly"), type(uint256).max, "assembly");
    }

    function test_NoImmutables_RuntimeCodeEqualsArtifactDeployedBytecode() public {
        bytes memory expected = vm.getDeployedCode("ProposalRegistry.sol:ProposalRegistry");
        assertGt(expected.length, 0);
        assertEq(
            keccak256(address(reg).code), keccak256(expected), "eth_getCode == artifact deployedBytecode"
        );

        // Different constructor args, different address: identical runtime code.
        ProposalRegistry other = new ProposalRegistry(makeAddr("o2"), makeAddr("p2"), 12_345);
        assertEq(keccak256(address(other).code), keccak256(expected));
    }

    function test_Reentrancy_NoCallbackSurface_OwnerContractCannotBeCalledBack() public {
        // Every mutator completes with no call out: a hostile owner contract receives no callback.
        CallbackOwner hostile = new CallbackOwner();
        ProposalRegistry r = new ProposalRegistry(address(hostile), proposer, CAP);
        hostile.run(r, target, SEL, proposer);
        assertEq(hostile.callbacks(), 0);
    }
}

/// @dev An owner that would record any inbound call; the registry never makes one.
contract CallbackOwner {
    uint256 public callbacks;

    receive() external payable {
        ++callbacks;
    }

    fallback() external payable {
        ++callbacks;
    }

    function run(ProposalRegistry r, address target, bytes4 sel, address proposer) external {
        r.addAllowed(target, sel);
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 id = r.computeId(target, sel, 1, expiry, 0, bytes32(0));
        (bool ok,) = address(r).call(abi.encodeCall(r.propose, (target, sel, 1, expiry, 0, bytes32(0))));
        require(ok);
        r.approve(id);
        r.markExecuted(id, 1, hex"01");
        r.setProposer(proposer);
        r.pause();
        r.unpause();
        r.transferOwnership(address(0xBEEF));
    }
}
