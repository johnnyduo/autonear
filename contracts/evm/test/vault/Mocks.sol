// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A contract that can act as the vault's agent or owner and misbehave when it receives ETH.
contract Actor {
    enum Mode {
        Accept,
        Revert,
        Reenter
    }

    Mode public mode;
    address public reTarget;
    bytes public reData;
    uint256 public reentries;
    bool public reOk;
    bytes public reRet;

    function setMode(Mode m) external {
        mode = m;
    }

    function arm(address target, bytes calldata data) external {
        mode = Mode.Reenter;
        reTarget = target;
        reData = data;
    }

    function exec(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }

    receive() external payable {
        if (mode == Mode.Revert) revert("actor: no thanks");
        if (mode == Mode.Reenter) {
            ++reentries;
            (reOk, reRet) = reTarget.call(reData);
        }
    }
}

/// @notice Template whose constructor tries to re-enter `vault.deploy` / `vault.draw` and REQUIRES that both are
///         rejected: it only deploys if the reentrancy lock held.
contract ReentrantDeployee {
    error ReentryNotBlocked(bytes ret);

    constructor(address vault) {
        (bool ok, bytes memory ret) = vault.call(abi.encodeWithSignature("draw(uint256)", 1));
        if (ok || ret.length != 4 || bytes4(ret) != bytes4(keccak256("Reentrancy()"))) {
            revert ReentryNotBlocked(ret);
        }
        (ok, ret) =
            vault.call(abi.encodeWithSignature("deploy(bytes32,bytes32,bytes)", bytes32(0), bytes32(0), ""));
        if (ok || ret.length != 4 || bytes4(ret) != bytes4(keccak256("Reentrancy()"))) {
            revert ReentryNotBlocked(ret);
        }
    }
}

/// @notice Pushes ETH into an address by selfdestruct, bypassing `receive()`.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}
