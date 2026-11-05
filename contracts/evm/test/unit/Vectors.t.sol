// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {BaseTest} from "../helpers/BaseTest.sol";

/// @notice Re-derives every committed golden vector (test-vectors.json) from the current contract code, so the
///         file the TypeScript backend checks against can never drift from the Solidity implementation.
///         Regenerate with `forge script script/EmitVectors.s.sol`.
contract VectorsTest is BaseTest {
    function test_GoldenVectors_MatchCurrentContract() public {
        string memory json = vm.readFile("test-vectors.json");
        assertEq(vm.parseJsonString(json, ".typeString"), reg.PROPOSAL_TYPE());
        assertEq(vm.parseJsonBytes32(json, ".typehash"), reg.PROPOSAL_TYPEHASH());

        string[] memory names = abi.decode(vm.parseJson(json, ".vectors[*].name"), (string[]));
        assertGe(names.length, 3, "at least three vectors");

        bytes memory runtime = address(reg).code;
        for (uint256 i; i < names.length; ++i) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            uint256 chainId = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".chainId")));
            address registry = vm.parseJsonAddress(json, string.concat(p, ".registry"));
            Args memory a = Args({
                target: vm.parseJsonAddress(json, string.concat(p, ".target")),
                selector: bytes4(vm.parseJsonBytes(json, string.concat(p, ".selector"))),
                maxSpend: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".maxSpend"))),
                expiry: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(p, ".expiry")))),
                nonce: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(p, ".nonce")))),
                artifactHash: vm.parseJsonBytes32(json, string.concat(p, ".artifactHash"))
            });
            bytes32 expected = vm.parseJsonBytes32(json, string.concat(p, ".id"));

            vm.chainId(chainId);
            vm.etch(registry, runtime);
            assertEq(
                ProposalRegistry(registry)
                    .computeId(a.target, a.selector, a.maxSpend, a.expiry, a.nonce, a.artifactHash),
                expected,
                names[i]
            );
            // And the independent encoding in the test helper agrees.
            assertEq(_expectedId(registry, a), expected, names[i]);
            assertEq(keccak256(vm.parseJsonBytes(json, string.concat(p, ".preimage"))), expected, names[i]);
        }
    }
}
