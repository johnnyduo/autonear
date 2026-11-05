// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployVault} from "../../script/DeployVault.s.sol";
import {AgentVault} from "../../src/AgentVault.sol";
import {Test} from "forge-std/Test.sol";

contract VaultDeployScriptTest is Test {
    DeployVault internal script;

    function setUp() public {
        script = new DeployVault();
    }

    function test_deploysWithGivenOwner_onNonMainnet() public {
        vm.chainId(31_337);
        AgentVault v = script.deployWith(makeAddr("owner"));
        assertEq(v.config().owner, makeAddr("owner"));
        assertEq(v.available(), 0, "deploy sends no funds");
    }

    function test_refusesMissingOwner() public {
        vm.chainId(11_155_111);
        vm.expectRevert(abi.encodeWithSelector(DeployVault.MissingEnv.selector, "OWNER"));
        script.deployWith(address(0));
    }

    function test_refusesKnownMainnets() public {
        uint256[20] memory ids = [
            uint256(1),
            10,
            56,
            100,
            137,
            250,
            324,
            1101,
            5000,
            8453,
            34_443,
            42_161,
            42_170,
            42_220,
            43_114,
            59_144,
            81_457,
            534_352,
            7_777_777,
            1_313_161_554
        ];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployVault.MainnetRefused.selector, ids[i]));
            script.deployWith(makeAddr("owner"));
        }
    }
}
