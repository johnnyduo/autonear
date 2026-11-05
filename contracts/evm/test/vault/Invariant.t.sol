// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultHandler} from "./Handler.sol";
import {VaultProps} from "./Props.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

/// @notice Stateful invariants under a random walk of every public method (see Handler.sol).
contract VaultInvariantTest is StdInvariant, VaultProps {
    function setUp() public {
        _deployWorld();
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](14);
        sels[0] = VaultHandler.advance.selector;
        sels[1] = VaultHandler.setMandate.selector;
        sels[2] = VaultHandler.revoke.selector;
        sels[3] = VaultHandler.pause.selector;
        sels[4] = VaultHandler.unpause.selector;
        sels[5] = VaultHandler.draw.selector;
        sels[6] = VaultHandler.deploy.selector;
        sels[7] = VaultHandler.allowTemplate.selector;
        sels[8] = VaultHandler.disallowTemplate.selector;
        sels[9] = VaultHandler.withdraw.selector;
        sels[10] = VaultHandler.withdrawAll.selector;
        sels[11] = VaultHandler.deposit.selector;
        sels[12] = VaultHandler.transferOwnership.selector;
        sels[13] = VaultHandler.acceptOwnership.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        bytes4[] memory more = new bytes4[](2);
        more[0] = VaultHandler.forceSend.selector;
        more[1] = VaultHandler.strangerCalls.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: more}));
    }

    function invariant_totalSpentLeTotalCap_periodSpentLePeriodCap() public view {
        _budgetNeverExceeded();
        _ghostAccounting();
    }

    function invariant_balanceConservation() public view {
        _conservation();
    }

    function invariant_deploysLeMaxDeploys() public view {
        _deploysBounded();
    }

    function invariant_agentNeverReceivesMoreThanTotalCapPerEpoch() public view {
        _agentNeverReceivesMoreThanTotalCap();
    }

    function invariant_ownerCanAlwaysWithdrawAvailable() public view {
        _ownerCanAlwaysWithdraw();
    }

    function invariant_noUnauthorizedOrInactiveSuccess() public view {
        _noUnauthorizedOrInactiveSuccess();
    }

    function invariant_templatesAndOwnershipConsistent() public view {
        _templatesConsistent();
        _ownershipSane();
    }

    function invariant_codeNeverChanges() public view {
        _codeNeverChanges();
    }
}
