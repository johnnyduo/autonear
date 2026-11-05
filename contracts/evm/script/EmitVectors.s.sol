// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProposalRegistry} from "../src/ProposalRegistry.sol";
import {Script} from "forge-std/Script.sol";

/// @notice Writes test-vectors.json: golden proposal-id vectors produced BY THE SOLIDITY CODE, so the
///         TypeScript backend can check its encoding bit-for-bit.
/// @dev For every vector the real contract runtime code is placed at the vector's registry address
///      (`vm.etch`) and the chain id is set (`vm.chainId`), then `computeId` is called. This works because the
///      runtime code has no immutables. Run: `forge script script/EmitVectors.s.sol`.
contract EmitVectors is Script {
    struct V {
        string name;
        uint256 chainId;
        address registry;
        address target;
        bytes4 selector;
        uint256 maxSpend;
        uint64 expiry;
        uint64 nonce;
        bytes32 artifactHash;
    }

    function run() external {
        ProposalRegistry template = new ProposalRegistry(address(0xA11CE), address(0xB0B), 0);
        bytes memory runtime = address(template).code;

        V[] memory vs = new V[](6);
        vs[0] = V({
            name: "baseline-anvil",
            chainId: 31_337,
            registry: 0x5FbDB2315678afecb367f032d93F642f64180aa3,
            target: 0xdAC17F958D2ee523a2206206994597C13D831ec7,
            selector: 0xa9059cbb,
            maxSpend: 1_000_000,
            expiry: 1_900_000_000,
            nonce: 0,
            artifactHash: keccak256("autonear-artifact-0")
        });
        vs[1] = V({
            name: "mainnet-chain-id-same-fields",
            chainId: 1,
            registry: 0x5FbDB2315678afecb367f032d93F642f64180aa3,
            target: 0xdAC17F958D2ee523a2206206994597C13D831ec7,
            selector: 0xa9059cbb,
            maxSpend: 1_000_000,
            expiry: 1_900_000_000,
            nonce: 0,
            artifactHash: keccak256("autonear-artifact-0")
        });
        vs[2] = V({
            name: "sepolia-large-spend-nonce-7",
            chainId: 11_155_111,
            registry: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512,
            target: 0x1111111111111111111111111111111111111111,
            selector: 0x095ea7b3,
            maxSpend: 123_456_789_012_345_678_901_234,
            expiry: 1_893_456_000,
            nonce: 7,
            artifactHash: 0x00000000000000000000000000000000000000000000000000000000000000ff
        });
        vs[3] = V({
            name: "zero-address-target-zero-selector-min-fields",
            chainId: 8453,
            registry: 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0,
            target: address(0),
            selector: 0x00000000,
            maxSpend: 1,
            expiry: 1,
            nonce: 0,
            artifactHash: bytes32(0)
        });
        vs[4] = V({
            name: "max-values",
            chainId: 56,
            registry: 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF,
            target: 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF,
            selector: 0xffffffff,
            maxSpend: type(uint256).max,
            expiry: type(uint64).max,
            nonce: type(uint64).max,
            artifactHash: bytes32(type(uint256).max)
        });
        vs[5] = V({
            name: "selector-left-aligned-padding",
            chainId: 97,
            registry: 0x0000000000000000000000000000000000C0FFEE,
            target: 0x000000000000000000000000000000000000dEaD,
            selector: 0x12345678,
            maxSpend: 42,
            expiry: 1_750_000_000,
            nonce: 3,
            artifactHash: keccak256("0x12345678")
        });

        string memory arr = "[";
        for (uint256 i; i < vs.length; ++i) {
            vm.chainId(vs[i].chainId);
            vm.etch(vs[i].registry, runtime);
            ProposalRegistry r = ProposalRegistry(vs[i].registry);
            bytes32 id = r.computeId(
                vs[i].target, vs[i].selector, vs[i].maxSpend, vs[i].expiry, vs[i].nonce, vs[i].artifactHash
            );
            bytes memory preimage = abi.encode(
                r.PROPOSAL_TYPEHASH(),
                vs[i].chainId,
                vs[i].registry,
                vs[i].target,
                vs[i].selector,
                vs[i].maxSpend,
                vs[i].expiry,
                vs[i].nonce,
                vs[i].artifactHash
            );
            require(keccak256(preimage) == id, "preimage/id mismatch");

            string memory k = string.concat("vector", vm.toString(i));
            vm.serializeString(k, "name", vs[i].name);
            vm.serializeString(k, "chainId", vm.toString(vs[i].chainId));
            vm.serializeAddress(k, "registry", vs[i].registry);
            vm.serializeAddress(k, "target", vs[i].target);
            vm.serializeString(k, "selector", vm.toString(abi.encodePacked(vs[i].selector)));
            vm.serializeString(k, "maxSpend", vm.toString(vs[i].maxSpend));
            vm.serializeString(k, "expiry", vm.toString(vs[i].expiry));
            vm.serializeString(k, "nonce", vm.toString(vs[i].nonce));
            vm.serializeBytes32(k, "artifactHash", vs[i].artifactHash);
            vm.serializeBytes(k, "preimage", preimage);
            string memory obj = vm.serializeBytes32(k, "id", id);
            arr = string.concat(arr, i == 0 ? "" : ",", obj);
        }
        arr = string.concat(arr, "]");

        string memory json = string.concat(
            '{"description":"Golden proposal-id vectors computed by ProposalRegistry.computeId (Solidity). ',
            "id = keccak256(preimage); preimage = abi.encode(typehash, chainId, registry, target, ",
            "selector(bytes4), maxSpend, expiry(uint64), nonce(uint64), artifactHash). ",
            'uint256-valued fields are decimal strings.",',
            '"typeString":"',
            template.PROPOSAL_TYPE(),
            '","typehash":"',
            vm.toString(template.PROPOSAL_TYPEHASH()),
            '","vectors":',
            arr,
            "}"
        );
        // writeJson parses first, so malformed JSON can never be written.
        vm.writeJson(json, "test-vectors.json");
    }
}
