// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {VaultBase} from "./VaultBase.sol";

/// @notice Static guarantees: the source has no delegatecall / selfdestruct / callcode / upgrade hooks and exactly
///         two value-sending calls, and the ABI exposes no function that could move funds or change code other than
///         the documented ones.
contract VaultSourceTest is VaultBase {
    function _code() internal view returns (string memory src) {
        string memory raw = vm.readFile("src/AgentVault.sol");
        // Drop comment lines so the NatSpec that says "no delegatecall" does not trip the scan.
        string[] memory lines = vm.split(raw, "\n");
        for (uint256 i; i < lines.length; ++i) {
            if (!_startsWith(vm.trim(lines[i]), "//")) src = string.concat(src, lines[i], "\n");
        }
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (a.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }

    function _count(string memory hay, string memory needle) internal pure returns (uint256 n) {
        bytes memory h = bytes(hay);
        bytes memory nd = bytes(needle);
        if (nd.length == 0 || h.length < nd.length) return 0;
        for (uint256 i; i <= h.length - nd.length; ++i) {
            bool hit = true;
            for (uint256 j; j < nd.length; ++j) {
                if (h[i + j] != nd[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) {
                ++n;
                i += nd.length - 1;
            }
        }
    }

    function test_source_noDelegatecallSelfdestructCallcodeOrProxyHooks() public view {
        string memory src = _code();
        assertEq(_count(src, "delegatecall"), 0, "delegatecall");
        assertEq(_count(src, "selfdestruct"), 0, "selfdestruct");
        assertEq(_count(src, "callcode"), 0, "callcode");
        assertEq(_count(src, "staticcall"), 0, "staticcall");
        assertEq(_count(src, "immutable"), 0, "immutable");
        assertEq(_count(src, "upgrade"), 0, "upgrade hooks");
        assertEq(_count(src, "create("), 0, "plain create");
        assertEq(_count(src, "tx.origin"), 0, "tx.origin");
    }

    function test_source_exactlyTwoValueSends_oneCreate2() public view {
        string memory src = _code();
        assertEq(_count(src, ".call{value:"), 2, "value sends: draw -> agent, withdraw -> owner");
        assertEq(_count(src, ".call("), 0, "no other low-level call");
        assertEq(_count(src, "create2("), 1, "one CREATE2");
        assertEq(_count(src, ".transfer("), 0);
        assertEq(_count(src, ".send("), 0);
    }

    /// @dev Value sends are addressed to `agent` (a local read from the mandate) and `msg.sender` (owner-gated).
    function test_source_sendTargets() public view {
        string memory src = _code();
        assertEq(_count(src, "agent.call{value: amount}"), 1, "draw pays the mandate's agent");
        assertEq(
            _count(src, "msg.sender.call{value: amount}"),
            1,
            "withdraw pays msg.sender (== owner via onlyOwner)"
        );
    }

    /// @dev Runtime code equals the build artifact, so the backend can verify a deployment by eth_getCode.
    function test_runtimeCode_equalsBuildArtifact_noImmutables() public view {
        string memory art = vm.readFile("out/AgentVault.sol/AgentVault.json");
        bytes memory expected = vm.parseJsonBytes(art, ".deployedBytecode.object");
        assertEq(address(vault).code, expected, "deployed runtime code == artifact deployedBytecode");
        assertEq(address(vault).code, type(AgentVault).runtimeCode);
        // forge omits the key entirely when there are no immutable references.
        assertFalse(vm.keyExistsJson(art, ".deployedBytecode.immutableReferences"), "no immutables");
    }

    function test_runtimeCode_isIndependentOfConstructorArg() public {
        AgentVault other1 = new AgentVault(address(0xBEEF));
        assertEq(address(other1).code, address(vault).code);
        assertEq(address(other1).codehash, address(vault).codehash);
    }
}
