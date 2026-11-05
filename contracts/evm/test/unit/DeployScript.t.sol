// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "../../script/Deploy.s.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The deploy script: env wiring, default cap, and the mainnet guard.
/// @dev Process env is global and tests run in parallel, so exactly ONE test touches env; the rest use the
///      env-free `deployWith` entry point.
contract DeployScriptTest is Test {
    Deploy internal script;
    address internal owner = makeAddr("owner");
    address internal proposer = makeAddr("proposer");

    function setUp() public {
        script = new Deploy();
    }

    function test_Deploy_EnvWiring_RunReadsOwnerProposerCapAndMainnetFlag() public {
        vm.chainId(31_337);
        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("PROPOSER", vm.toString(proposer));
        vm.setEnv("MAX_SPEND_CAP", "5000");
        ProposalRegistry r = script.run();
        assertEq(r.config().owner, owner);
        assertEq(r.config().proposer, proposer);
        assertEq(r.config().maxSpendCap, 5000);

        // Mainnet without the flag refuses, wrong value refuses, exact "yes" allows.
        vm.chainId(1);
        vm.setEnv("I_UNDERSTAND_MAINNET", "true");
        vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetRefused.selector, 1));
        script.run();
        vm.setEnv("I_UNDERSTAND_MAINNET", "yes");
        assertTrue(address(script.run()) != address(0));
        vm.setEnv("I_UNDERSTAND_MAINNET", "");
    }

    function test_Deploy_WiresArguments() public {
        vm.chainId(31_337);
        ProposalRegistry r = script.deployWith(owner, proposer, 5000, false);
        assertEq(r.config().owner, owner);
        assertEq(r.config().proposer, proposer);
        assertEq(r.config().maxSpendCap, 5000);
    }

    function test_Deploy_UnsetCapSelectsDefault() public {
        vm.chainId(31_337);
        ProposalRegistry r = script.deployWith(owner, proposer, 0, false);
        assertEq(r.config().maxSpendCap, r.DEFAULT_MAX_SPEND_CAP());
    }

    function test_Deploy_RefusesKnownMainnetsWithoutFlag() public {
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
            vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetRefused.selector, ids[i]));
            script.deployWith(owner, proposer, 0, false);
        }
    }

    function test_Deploy_AllowsMainnetWithExplicitFlag() public {
        vm.chainId(1);
        assertTrue(address(script.deployWith(owner, proposer, 0, true)) != address(0));
    }

    function test_Deploy_AllowsTestnetsAndLocal() public {
        uint256[5] memory ids = [uint256(31_337), 11_155_111, 84_532, 97, 1_313_161_555]; // incl. Aurora testnet
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            script.deployWith(owner, proposer, 0, false);
        }
    }

    function test_Deploy_RequiresOwnerAndProposer() public {
        vm.chainId(31_337);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "OWNER"));
        script.deployWith(address(0), proposer, 0, false);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "PROPOSER"));
        script.deployWith(owner, address(0), 0, false);
    }
}
