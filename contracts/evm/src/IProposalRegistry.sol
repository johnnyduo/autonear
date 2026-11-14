// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IProposalRegistry
/// @notice Interface, types, events and errors of AutoNEAR Proposal Registry v1 (EVM).
/// @dev Semantics are specified in the registry spec and MUST match the NEAR implementation.
///      The registry is an attestation registry: it never holds funds and never calls the target.
interface IProposalRegistry {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Lifecycle status. `None` means "no such proposal". `Expired` is DERIVED, never stored:
    ///         it is reported by views when `block.timestamp > expiry` and the stored status is
    ///         Pending or Approved.
    enum Status {
        None,
        Pending,
        Approved,
        Executed,
        Cancelled,
        Expired
    }

    /// @notice Read model of a proposal. `status` is the effective status (may be Expired).
    struct Proposal {
        bytes32 id;
        address proposer;
        address target;
        bytes4 selector;
        uint256 maxSpend;
        uint64 expiry;
        uint64 nonce;
        bytes32 artifactHash;
        Status status;
        uint64 createdAt;
        uint64 approvedAt;
        uint64 executedAt;
        uint256 spent;
        bytes receiptRef;
    }

    /// @notice Registry configuration snapshot.
    struct Config {
        address owner;
        address pendingOwner;
        address proposer;
        bool paused;
        uint256 networkId;
        uint64 nextNonce;
        uint256 maxSpendCap;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A proposal was recorded as Pending.
    event Proposed(
        bytes32 indexed id,
        address indexed proposer,
        address indexed target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    );
    /// @notice The owner approved a Pending proposal.
    event Approved(bytes32 indexed id, address indexed approver);
    /// @notice The owner recorded an out-of-band execution of an Approved proposal.
    event Executed(bytes32 indexed id, address indexed executor, uint256 spent, bytes receiptRef);
    /// @notice A Pending or Approved proposal was cancelled.
    event Cancelled(bytes32 indexed id, address indexed by);
    /// @notice The registry was paused.
    event Paused(address indexed by);
    /// @notice The registry was unpaused.
    event Unpaused(address indexed by);
    /// @notice A (target, selector) pair was added to or removed from the allowlist.
    event AllowlistUpdated(address indexed target, bytes4 indexed selector, bool allowed);
    /// @notice The proposer account changed.
    event ProposerSet(address indexed previousProposer, address indexed newProposer);
    /// @notice The maximum per-proposal spend cap changed.
    event MaxSpendCapSet(uint256 previousCap, uint256 newCap);
    /// @notice Ownership transfer was started; `newOwner` must call acceptOwnership.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    /// @notice Ownership transfer completed.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner(address caller);
    error NotProposerOrOwner(address caller);
    error NotPendingOwner(address caller);
    error NotAuthorizedToCancel(address caller, bytes32 id);
    error ZeroAddress();
    error SelfTransfer();
    error RegistryPaused();
    error AlreadyPaused();
    error NotPaused();
    error NotAllowlisted(address target, bytes4 selector);
    error AlreadyAllowlisted(address target, bytes4 selector);
    error AllowlistEntryMissing(address target, bytes4 selector);
    error ExpiryNotInFuture(uint64 expiry, uint256 nowTs);
    error ExpiryTooFar(uint64 expiry, uint256 maxExpiry);
    error ZeroMaxSpend();
    error MaxSpendExceedsCap(uint256 maxSpend, uint256 cap);
    error ZeroCap();
    error BadNonce(uint64 expected, uint64 given);
    error ProposalAlreadyExists(bytes32 id);
    error UnknownProposal(bytes32 id);
    error InvalidStatus(bytes32 id, Status current);
    error ProposalExpired(bytes32 id, uint64 expiry);
    error SpentExceedsMaxSpend(uint256 spent, uint256 maxSpend);
    error EmptyReceiptRef();
    error ReceiptRefTooLong(uint256 length, uint256 maxLength);

    /*//////////////////////////////////////////////////////////////
                              STATE-CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Record a scoped action proposal. Only the proposer or the owner.
    /// @return id The on-chain computed EIP-712 style struct hash identifying the proposal.
    function propose(
        address target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    ) external returns (bytes32 id);

    /// @notice Approve a Pending, unexpired proposal whose (target, selector) is still allowlisted.
    function approve(bytes32 id) external;

    /// @notice Record the out-of-band execution of an Approved, unexpired proposal.
    function markExecuted(bytes32 id, uint256 spent, bytes calldata receiptRef) external;

    /// @notice Cancel a proposal. Owner: Pending or Approved. Proposer: its own Pending proposals only.
    function cancel(bytes32 id) external;

    /// @notice Halt propose / approve / markExecuted. cancel and views keep working.
    function pause() external;

    /// @notice Resume operation.
    function unpause() external;

    /// @notice Allow proposals for (target, selector).
    function addAllowed(address target, bytes4 selector) external;

    /// @notice Disallow (target, selector) for new proposals and for approvals of existing ones.
    function removeAllowed(address target, bytes4 selector) external;

    /// @notice Replace the proposer account.
    function setProposer(address newProposer) external;

    /// @notice Set the per-proposal max spend cap applied at `propose`.
    function setMaxSpendCap(uint256 newCap) external;

    /// @notice Start a two-step ownership transfer.
    function transferOwnership(address newOwner) external;

    /// @notice Complete a two-step ownership transfer. Only the pending owner.
    function acceptOwnership() external;

    /*//////////////////////////////////////////////////////////////
                                   VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Compute the proposal id for the given fields at this registry on this chain.
    function computeId(
        address target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    ) external view returns (bytes32);

    /// @notice Full proposal record; status is the effective status. Reverts if unknown.
    function getProposal(bytes32 id) external view returns (Proposal memory);

    /// @notice Effective status (includes derived Expired). `None` if unknown.
    function statusOf(bytes32 id) external view returns (Status);

    /// @notice Paginated ids in creation order.
    function list(uint256 offset, uint256 limit) external view returns (bytes32[] memory);

    /// @notice Total number of proposals ever recorded.
    function proposalCount() external view returns (uint256);

    /// @notice Whether (target, selector) is allowlisted.
    function isAllowed(address target, bytes4 selector) external view returns (bool);

    /// @notice Configuration snapshot.
    function config() external view returns (Config memory);
}
