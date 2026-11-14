// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAgentVault
/// @notice Types, events, custom errors and external API of AutoNEAR Mandate Vault v1 (EVM).
/// @dev Semantics are specified in the Mandate Vault spec and MUST match the NEAR implementation and the JS model;
///      all three are checked against contracts/vault-conformance.json.
///      Error names are the spec's error codes, byte for byte. Preview views return the 4-byte selector of the
///      error the matching call would revert with (`bytes4(0)` = ok), so `selector == IAgentVault.X.selector`.
interface IAgentVault {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Vault configuration snapshot. `networkId` is `block.chainid`.
    struct Config {
        address owner;
        address pendingOwner;
        bool paused;
        uint256 networkId;
        uint64 epoch;
    }

    /// @notice The (at most one) mandate. `agent == address(0)` means "no mandate". Times are unix seconds.
    struct Mandate {
        address agent;
        uint64 expiresAt;
        uint32 maxDeploys;
        uint64 start;
        uint64 periodSecs;
        bool revoked;
        uint256 perDrawCap;
        uint256 periodCap;
        uint256 totalCap;
    }

    /// @notice Raw usage counters of the current epoch. `periodSpent` belongs to `periodIndex`; read
    ///         `periodState(ts)` for the effective value at a given time.
    struct Usage {
        uint256 totalSpent;
        uint256 periodSpent;
        uint64 periodIndex;
        uint32 deploys;
    }

    /// @notice Effective period accounting at a timestamp.
    struct PeriodState {
        uint64 index;
        uint256 spent;
        uint256 startsAt;
        uint256 endsAt;
    }

    /// @notice An allowlisted template. `id == bytes32(0)` means "not allowlisted". `deposit` is always 0 on EVM.
    struct Template {
        bytes32 id;
        string label;
        uint256 deposit;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice ETH was received through the plain `receive()` entry point.
    event Deposited(address indexed from, uint256 amount);
    /// @notice The owner installed a new mandate (replacing any previous one); usage was reset.
    event MandateSet(
        uint64 indexed epoch,
        address indexed agent,
        uint64 expiresAt,
        uint256 perDrawCap,
        uint64 periodSecs,
        uint256 periodCap,
        uint256 totalCap,
        uint32 maxDeploys,
        uint64 start
    );
    /// @notice The owner revoked the current mandate.
    event MandateRevoked(uint64 indexed epoch, address indexed by);
    /// @notice Agent operations were blocked.
    event VaultPaused(address indexed by);
    /// @notice Agent operations were unblocked.
    event VaultUnpaused(address indexed by);
    /// @notice A template was allowlisted (or its label updated).
    event TemplateAllowed(bytes32 indexed id, string label, uint256 deposit);
    /// @notice A template was removed from the allowlist.
    event TemplateDisallowed(bytes32 indexed id);
    /// @notice The agent drew `amount` to its own address.
    event Drawn(
        uint64 indexed epoch, address indexed agent, uint256 amount, uint256 totalSpent, uint256 periodSpent
    );
    /// @notice The agent deployed an allowlisted template via CREATE2.
    event Deployed(
        uint64 indexed epoch,
        bytes32 indexed templateId,
        address indexed target,
        bytes32 salt,
        uint256 deploys
    );
    /// @notice The owner withdrew `amount` to itself.
    event Withdrawn(address indexed owner, uint256 amount);
    /// @notice Two-step ownership: a transfer was proposed.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    /// @notice Two-step ownership: the transfer was accepted (also emitted by the constructor from address(0)).
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /*//////////////////////////////////////////////////////////////
                  ERRORS (spec error codes, exact names)
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error Paused();
    error NoMandate();
    error MandateInactive();
    error BadMandate();
    error BadAmount();
    error PerDrawCap();
    error PeriodCap();
    error TotalCap();
    error InsufficientBalance();
    error DeployLimit();
    error TemplateNotAllowed();
    error CodeMismatch();
    error AddressTaken();
    error BadName();
    error BadTemplate();
    error BadOwner();

    /*//////////////////////////////////////////////////////////////
          EVM-ONLY ERRORS (not spec codes; cannot occur in the JS model)
    //////////////////////////////////////////////////////////////*/

    /// @notice A value send (draw to the agent / withdraw to the owner) failed.
    error TransferFailed();
    /// @notice A guarded function was re-entered.
    error Reentrancy();
    /// @notice CREATE2 returned zero (constructor reverted or ran out of gas). The whole transaction reverts.
    error DeployFailed();

    /*//////////////////////////////////////////////////////////////
                               OWNER OPERATIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Install a mandate (replaces any, even revoked/expired; epoch += 1; usage reset; allowed while paused).
    function setMandate(
        address agent,
        uint256 expiresAt,
        uint256 perDrawCap,
        uint256 periodSecs,
        uint256 periodCap,
        uint256 totalCap,
        uint256 maxDeploys
    ) external;

    /// @notice Revoke the current mandate (idempotent). Reverts `NoMandate` if none was ever set.
    function revoke() external;

    /// @notice Block agent operations. Owner operations keep working.
    function pause() external;

    /// @notice Unblock agent operations.
    function unpause() external;

    /// @notice Allowlist `templateId == keccak256(initcode)` (constructor args included). `deposit` must be 0.
    function allowTemplate(bytes32 templateId, string calldata label, uint256 deposit) external;

    /// @notice Remove a template. Reverts `TemplateNotAllowed` if unknown.
    function disallowTemplate(bytes32 templateId) external;

    /// @notice Send `amount` wei to the owner. Works while paused, revoked or expired.
    function withdraw(uint256 amount) external;

    /// @notice Propose a new owner (two-step).
    function transferOwnership(address newOwner) external;

    /// @notice Accept a pending ownership transfer. Caller must be the pending owner.
    function acceptOwnership() external;

    /*//////////////////////////////////////////////////////////////
                              AGENT OPERATIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Send `amount` wei to the mandate's agent, inside the budget.
    function draw(uint256 amount) external;

    /// @notice CREATE2-deploy an allowlisted template from the vault. `keccak256(code)` must equal `templateId`.
    /// @return target The address of the new contract (equals `predictAddress(templateId, salt)`).
    function deploy(bytes32 templateId, bytes32 salt, bytes calldata code) external returns (address target);

    /*//////////////////////////////////////////////////////////////
                                    VIEWS
    //////////////////////////////////////////////////////////////*/

    function config() external view returns (Config memory);
    function mandate() external view returns (Mandate memory);
    function usage() external view returns (Usage memory);
    function template(bytes32 templateId) external view returns (Template memory);
    function templates(uint256 from, uint256 limit) external view returns (Template[] memory page);
    function templateCount() external view returns (uint256);
    /// @notice The vault's spendable balance: `address(this).balance`.
    function available() external view returns (uint256);
    /// @notice Effective period accounting at `ts` (all zero when there is no mandate or `ts < start`).
    function periodState(uint256 ts) external view returns (PeriodState memory);
    /// @notice Error selector `draw(amount)` would revert with now, if called by the bound agent; 0 = ok.
    function previewDraw(uint256 amount) external view returns (bytes4);
    /// @notice Error selector `deploy(templateId, salt, <matching code>)` would revert with now, if called by the
    ///         bound agent; 0 = ok. The code is assumed to match, so `CodeMismatch` is never returned.
    function previewDeploy(bytes32 templateId, bytes32 salt) external view returns (bytes4);
    /// @notice CREATE2 address a deploy of (templateId, salt) lands on. Pure function of vault, salt, template.
    function predictAddress(bytes32 templateId, bytes32 salt) external view returns (address);
    /// @notice `keccak256(initcode)`: the template id for given initcode (constructor args appended).
    function templateIdOf(bytes calldata initcode) external pure returns (bytes32);
}
