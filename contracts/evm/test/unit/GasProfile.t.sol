// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../helpers/BaseTest.sol";
import {console} from "forge-std/Test.sol";

/// @notice Happy-path gas per transition, logged (run with -vv) and bounded as a regression guard.
///         Numbers are `forge test` measurements (EVM, cancun), not mainnet quotes; see README.
contract GasProfileTest is BaseTest {
    function test_Gas_HappyPath() public {
        Args memory a = _args();

        uint256 g = gasleft();
        vm.prank(proposer);
        bytes32 id = reg.propose(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash);
        uint256 proposeGas = g - gasleft();

        g = gasleft();
        vm.prank(owner);
        reg.approve(id);
        uint256 approveGas = g - gasleft();

        g = gasleft();
        vm.prank(owner);
        reg.markExecuted(id, 1 ether, bytes("eip155:1/tx:0x0123456789abcdef0123456789abcdef"));
        uint256 executeGas = g - gasleft();

        bytes32 id2 = _propose();
        g = gasleft();
        vm.prank(proposer);
        reg.cancel(id2);
        uint256 cancelGas = g - gasleft();

        console.log("propose (first, 1 proposal)", proposeGas);
        console.log("approve                    ", approveGas);
        console.log("markExecuted (45B receipt) ", executeGas);
        console.log("cancel (Pending)           ", cancelGas);

        assertLt(proposeGas, 200_000);
        assertLt(approveGas, 70_000);
        assertLt(executeGas, 140_000);
        assertLt(cancelGas, 50_000);
    }
}
