// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "../../src/AgentVault.sol";
import {IAgentVault} from "../../src/IAgentVault.sol";
import {VaultBase} from "./VaultBase.sol";
import {console} from "forge-std/Test.sol";

/// @notice Executes EVERY scenario of contracts/vault-conformance.json (those with `only` absent or "evm") against
///         the real AgentVault and asserts each step's `expect` and every `state` key.
/// @dev The file is shared with the NEAR contract and the JS model and must never be edited to make this pass.
///      Mapping: abstract amounts are wei 1:1; t1/t2 are the fixtures in VaultBase; `name`/`salt` strings become
///      keccak256(bytes(name)); roles map to the four actors of VaultBase; "" maps to address(0).
///      On top of the file's assertions the harness checks, for every agent step made by the bound agent, that the
///      matching `preview*` view returned exactly the outcome the real call then had, and that a failed step left
///      every observable (config, mandate, usage, balance, template count) untouched.
contract ConformanceTest is VaultBase {
    string internal json;
    uint256[4] internal received; // owner, agent, other, newOwner: wei received through draw/withdraw only
    uint256 internal stepsRun;

    function test_conformance_allScenarios() public {
        json = vm.readFile("../vault-conformance.json");
        assertEq(vm.parseJsonUint(json, ".version"), 1, "conformance file version");

        uint256 ran;
        uint256 skipped;
        for (uint256 i; vm.keyExistsJson(json, string.concat(".scenarios[", vm.toString(i), "]")); ++i) {
            string memory base = string.concat(".scenarios[", vm.toString(i), "]");
            if (vm.keyExistsJson(json, string.concat(base, ".only"))) {
                string memory only = vm.parseJsonString(json, string.concat(base, ".only"));
                if (keccak256(bytes(only)) != keccak256("evm")) {
                    ++skipped;
                    continue;
                }
            }
            _runScenario(base);
            ++ran;
        }
        console.log("conformance scenarios run:", ran);
        console.log("conformance scenarios skipped (other chain):", skipped);
        console.log("conformance steps run:", stepsRun);
        assertGt(ran, 0, "no scenario ran");
    }

    /// @dev The file's error list is exactly the 17 spec codes and each maps to the interface's selector.
    function test_conformance_errorListMatchesInterface() public {
        json = vm.readFile("../vault-conformance.json");
        string[] memory names = vm.parseJsonStringArray(json, ".errors");
        assertEq(names.length, 17, "spec has 17 error codes");
        bytes4[17] memory want = [
            IAgentVault.Unauthorized.selector,
            IAgentVault.Paused.selector,
            IAgentVault.NoMandate.selector,
            IAgentVault.MandateInactive.selector,
            IAgentVault.BadMandate.selector,
            IAgentVault.BadAmount.selector,
            IAgentVault.PerDrawCap.selector,
            IAgentVault.PeriodCap.selector,
            IAgentVault.TotalCap.selector,
            IAgentVault.InsufficientBalance.selector,
            IAgentVault.DeployLimit.selector,
            IAgentVault.TemplateNotAllowed.selector,
            IAgentVault.CodeMismatch.selector,
            IAgentVault.AddressTaken.selector,
            IAgentVault.BadName.selector,
            IAgentVault.BadTemplate.selector,
            IAgentVault.BadOwner.selector
        ];
        for (uint256 i; i < 17; ++i) {
            assertEq(_sel(names[i]), want[i], names[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               HARNESS
    //////////////////////////////////////////////////////////////*/

    function _runScenario(string memory base) internal {
        string memory name = vm.parseJsonString(json, string.concat(base, ".name"));
        // Fresh world per scenario.
        vm.warp(T0);
        vault = new AgentVault(owner);
        delete received;
        address[4] memory actors = [owner, agent, other, newOwner];
        for (uint256 a; a < 4; ++a) {
            vm.deal(actors[a], 0);
        }
        vm.deal(address(vault), vm.parseJsonUint(json, string.concat(base, ".setup.balance")));

        for (uint256 s; vm.keyExistsJson(json, string.concat(base, ".steps[", vm.toString(s), "]")); ++s) {
            _runStep(name, s, string.concat(base, ".steps[", vm.toString(s), "]"));
            ++stepsRun;
        }
    }

    function _runStep(string memory scenario, uint256 idx, string memory b) internal {
        string memory label = string.concat(scenario, "#", vm.toString(idx));
        uint256 t = vm.parseJsonUint(json, string.concat(b, ".t"));
        address who = _role(vm.parseJsonString(json, string.concat(b, ".as")));
        string memory op = vm.parseJsonString(json, string.concat(b, ".op"));
        vm.warp(t);

        // Expected outcome: 0 = ok, otherwise the error selector.
        bytes4 want;
        bool expectErr = vm.keyExistsJson(json, string.concat(b, ".expect.err"));
        if (expectErr) want = _sel(vm.parseJsonString(json, string.concat(b, ".expect.err")));

        if (_isPreview(op)) {
            bytes4 got = _preview(op, string.concat(b, ".args"));
            assertEq(got, want, string.concat(label, " preview ", op));
        } else {
            _execute(label, op, string.concat(b, ".args"), who, expectErr, want);
        }
        _checkState(label, string.concat(b, ".state"), t);
    }

    function _isPreview(string memory op) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(op));
        return h == keccak256("preview_draw") || h == keccak256("preview_deploy");
    }

    function _preview(string memory op, string memory args) internal view returns (bytes4) {
        if (keccak256(bytes(op)) == keccak256("preview_draw")) {
            return vault.previewDraw(vm.parseJsonUint(json, string.concat(args, ".amount")));
        }
        (bytes32 id, bytes32 salt,) = _deployArgs(args);
        return vault.previewDeploy(id, salt);
    }

    function _execute(
        string memory label,
        string memory op,
        string memory args,
        address who,
        bool expectErr,
        bytes4 want
    ) internal {
        (bytes memory data, uint256 value) = _encode(op, args);
        bool isDraw = keccak256(bytes(op)) == keccak256("draw");
        bool isDeploy = keccak256(bytes(op)) == keccak256("deploy");

        // Preview-vs-real consistency for the bound agent (previews assume the caller is the bound agent).
        bytes4 previewed;
        bool checkPreview;
        if (who == vault.mandate().agent && who != address(0)) {
            if (isDraw) {
                previewed = vault.previewDraw(vm.parseJsonUint(json, string.concat(args, ".amount")));
                checkPreview = true;
            } else if (isDeploy && !vm.keyExistsJson(json, string.concat(args, ".code"))) {
                (bytes32 id, bytes32 salt,) = _deployArgs(args);
                previewed = vault.previewDeploy(id, salt);
                checkPreview = true;
            }
        }

        bytes32 before = _fingerprint();
        uint256[4] memory balBefore = _balances();
        if (value > 0) vm.deal(who, value);

        vm.prank(who);
        (bool ok, bytes memory ret) = address(vault).call{value: value}(data);

        if (expectErr) {
            assertFalse(ok, string.concat(label, " expected revert ", op));
            assertEq(ret, abi.encodePacked(want), string.concat(label, " wrong error for ", op));
            assertEq(_fingerprint(), before, string.concat(label, " failed op mutated state"));
        } else {
            assertTrue(ok, string.concat(label, " expected ok ", op));
            if (keccak256(bytes(op)) == keccak256("draw") || keccak256(bytes(op)) == keccak256("withdraw")) {
                uint256[4] memory balAfter = _balances();
                for (uint256 i; i < 4; ++i) {
                    received[i] += balAfter[i] - balBefore[i];
                }
            }
            if (isDeploy) {
                (bytes32 id, bytes32 salt,) = _deployArgs(args);
                address target = vault.predictAddress(id, salt);
                assertEq(abi.decode(ret, (address)), target, string.concat(label, " deploy address"));
                assertEq(target.code.length, 1, string.concat(label, " deployed code"));
            }
        }
        if (checkPreview) assertEq(previewed, want, string.concat(label, " preview != real outcome"));
    }

    function _encode(string memory op, string memory a)
        internal
        view
        returns (bytes memory data, uint256 value)
    {
        bytes32 h = keccak256(bytes(op));
        if (h == keccak256("set_mandate")) {
            data = abi.encodeCall(
                vault.setMandate,
                (
                    _role(vm.parseJsonString(json, string.concat(a, ".agent"))),
                    vm.parseJsonUint(json, string.concat(a, ".expires_at")),
                    vm.parseJsonUint(json, string.concat(a, ".per_draw_cap")),
                    vm.parseJsonUint(json, string.concat(a, ".period_secs")),
                    vm.parseJsonUint(json, string.concat(a, ".period_cap")),
                    vm.parseJsonUint(json, string.concat(a, ".total_cap")),
                    vm.parseJsonUint(json, string.concat(a, ".max_deploys"))
                )
            );
        } else if (h == keccak256("revoke")) {
            data = abi.encodeCall(vault.revoke, ());
        } else if (h == keccak256("pause")) {
            data = abi.encodeCall(vault.pause, ());
        } else if (h == keccak256("unpause")) {
            data = abi.encodeCall(vault.unpause, ());
        } else if (h == keccak256("allow_template")) {
            (bytes32 id,,) = _deployArgs(a);
            data = abi.encodeCall(
                vault.allowTemplate,
                (
                    id,
                    vm.parseJsonString(json, string.concat(a, ".label")),
                    vm.parseJsonUint(json, string.concat(a, ".deposit"))
                )
            );
        } else if (h == keccak256("disallow_template")) {
            (bytes32 id,,) = _deployArgs(a);
            data = abi.encodeCall(vault.disallowTemplate, (id));
        } else if (h == keccak256("withdraw")) {
            data = abi.encodeCall(vault.withdraw, (vm.parseJsonUint(json, string.concat(a, ".amount"))));
        } else if (h == keccak256("transfer_ownership")) {
            data = abi.encodeCall(
                vault.transferOwnership, (_role(vm.parseJsonString(json, string.concat(a, ".to"))))
            );
        } else if (h == keccak256("accept_ownership")) {
            data = abi.encodeCall(vault.acceptOwnership, ());
        } else if (h == keccak256("draw")) {
            data = abi.encodeCall(vault.draw, (vm.parseJsonUint(json, string.concat(a, ".amount"))));
        } else if (h == keccak256("deploy")) {
            (bytes32 id, bytes32 salt, bytes memory code) = _deployArgs(a);
            data = abi.encodeCall(vault.deploy, (id, salt, code));
        } else if (h == keccak256("deposit")) {
            value = vm.parseJsonUint(json, string.concat(a, ".amount")); // plain transfer, empty calldata
        } else {
            revert(string.concat("conformance harness: unknown op ", op));
        }
    }

    /// @dev template id, salt (keccak of `name`, if any) and the initcode to submit (`code` override, else the
    ///      template's own fixture).
    function _deployArgs(string memory a)
        internal
        view
        returns (bytes32 id, bytes32 salt, bytes memory code)
    {
        bytes memory own = _fixture(vm.parseJsonString(json, string.concat(a, ".template")));
        id = keccak256(own);
        code = vm.keyExistsJson(json, string.concat(a, ".code"))
            ? _fixture(vm.parseJsonString(json, string.concat(a, ".code")))
            : own;
        if (vm.keyExistsJson(json, string.concat(a, ".name"))) {
            salt = keccak256(bytes(vm.parseJsonString(json, string.concat(a, ".name"))));
        }
    }

    function _fixture(string memory tpl) internal pure returns (bytes memory) {
        if (keccak256(bytes(tpl)) == keccak256("t1")) return T1_INIT;
        if (keccak256(bytes(tpl)) == keccak256("t2")) return T2_INIT;
        revert(string.concat("conformance harness: no fixture for template ", tpl));
    }

    function _role(string memory r) internal view returns (address) {
        bytes32 h = keccak256(bytes(r));
        if (h == keccak256("owner")) return owner;
        if (h == keccak256("agent")) return agent;
        if (h == keccak256("other")) return other;
        if (h == keccak256("newOwner")) return newOwner;
        if (h == keccak256("")) return address(0);
        revert(string.concat("conformance harness: unknown role ", r));
    }

    function _roleIndex(string memory r) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(r));
        if (h == keccak256("owner")) return 0;
        if (h == keccak256("agent")) return 1;
        if (h == keccak256("other")) return 2;
        if (h == keccak256("newOwner")) return 3;
        revert(string.concat("conformance harness: unknown role ", r));
    }

    function _balances() internal view returns (uint256[4] memory b) {
        b = [owner.balance, agent.balance, other.balance, newOwner.balance];
    }

    function _checkState(string memory label, string memory sp, uint256 t) internal view {
        if (!vm.keyExistsJson(json, sp)) return;
        if (vm.keyExistsJson(json, string.concat(sp, ".available"))) {
            assertEq(
                vault.available(),
                vm.parseJsonUint(json, string.concat(sp, ".available")),
                _l(label, "available")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".total_spent"))) {
            assertEq(
                vault.usage().totalSpent,
                vm.parseJsonUint(json, string.concat(sp, ".total_spent")),
                _l(label, "total_spent")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".period_spent"))) {
            assertEq(
                vault.periodState(t).spent,
                vm.parseJsonUint(json, string.concat(sp, ".period_spent")),
                _l(label, "period_spent")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".deploys"))) {
            assertEq(
                vault.usage().deploys,
                vm.parseJsonUint(json, string.concat(sp, ".deploys")),
                _l(label, "deploys")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".epoch"))) {
            assertEq(
                vault.config().epoch, vm.parseJsonUint(json, string.concat(sp, ".epoch")), _l(label, "epoch")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".paused"))) {
            assertEq(
                vault.config().paused,
                vm.parseJsonBool(json, string.concat(sp, ".paused")),
                _l(label, "paused")
            );
        }
        if (vm.keyExistsJson(json, string.concat(sp, ".revoked"))) {
            assertEq(
                vault.mandate().revoked,
                vm.parseJsonBool(json, string.concat(sp, ".revoked")),
                _l(label, "revoked")
            );
        }
        string memory rp = string.concat(sp, ".received");
        if (vm.keyExistsJson(json, rp)) {
            string[] memory roles = vm.parseJsonKeys(json, rp);
            for (uint256 i; i < roles.length; ++i) {
                assertEq(
                    received[_roleIndex(roles[i])],
                    vm.parseJsonUint(json, string.concat(rp, ".", roles[i])),
                    _l(label, string.concat("received.", roles[i]))
                );
            }
        }
    }

    function _l(string memory label, string memory key) internal pure returns (string memory) {
        return string.concat(label, " state.", key);
    }
}
