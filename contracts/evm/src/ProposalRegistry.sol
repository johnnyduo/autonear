// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "./IProposalRegistry.sol";

/// @title ProposalRegistry
/// @author AutoNEAR
/// @notice Attestation registry binding an off-chain, policy-bound action proposal to an owner-approved
///         on-chain record. State machine: Pending -> Approved -> Executed, or -> Cancelled, or derived Expired.
/// @dev Design constraints, all load-bearing:
///      - NO funds: no value-accepting function and no catch-all entry point. A plain ETH transfer reverts.
///      - NO external calls of any kind (no low-level calls, no delegation, no value transfers), so there is
///        no reentrancy surface and no callback. Enforced by a source-scan test.
///      - NO constructor-baked code variables, NO proxy, NO self-destruct: the runtime code at the deployed address equals the
///        build artifact's `deployedBytecode` byte-for-byte, which is how the backend verifies a deploy.
///        Constructor arguments only initialise storage, never code.
///      - The proposal id is computed on-chain as an EIP-712 style struct hash (see PROPOSAL_TYPEHASH).
///      - Ownership is two-step. The owner is expected to be a multisig on any real network.
///      Chosen behaviours where the spec leaves room:
///      - `approve` re-checks the allowlist (a removed pair can no longer be approved); `markExecuted` does
///        not, because execution happens out of band and an approval is an explicit owner decision. The owner
///        can `cancel` an Approved proposal instead.
///      - The cap is enforced at `propose` only; lowering it later does not retroactively invalidate proposals.
///      - Expired is terminal-for-mutation: approve, markExecuted AND cancel revert with ProposalExpired.
contract ProposalRegistry is IProposalRegistry {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-712 type string of the proposal id preimage.
    string public constant PROPOSAL_TYPE =
        "Proposal(uint256 chainId,address registry,address target,bytes4 selector,uint256 maxSpend,uint64 expiry,uint64 nonce,bytes32 artifactHash)";

    /// @notice keccak256(PROPOSAL_TYPE). Spelled as a literal so the constant stays inlined in the runtime code.
    bytes32 public constant PROPOSAL_TYPEHASH = keccak256(
        "Proposal(uint256 chainId,address registry,address target,bytes4 selector,uint256 maxSpend,uint64 expiry,uint64 nonce,bytes32 artifactHash)"
    );

    /// @notice Maximum proposal lifetime from the proposing block (30 days).
    uint256 public constant MAX_TTL = 30 days;

    /// @notice Maximum byte length of a receipt reference.
    uint256 public constant MAX_RECEIPT_REF_LEN = 256;

    /// @notice Maximum page size of `list`.
    uint256 public constant MAX_PAGE = 100;

    /// @notice Spend cap used when the constructor is given 0 (1,000,000 units of 18 decimals).
    uint256 public constant DEFAULT_MAX_SPEND_CAP = 1_000_000 ether;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Packed storage form of a proposal (the id is the mapping key and is not stored).
    struct Record {
        address proposer;
        Status status;
        uint64 createdAt;
        address target;
        bytes4 selector;
        uint64 expiry;
        uint64 nonce;
        uint64 approvedAt;
        uint64 executedAt;
        uint256 maxSpend;
        uint256 spent;
        bytes32 artifactHash;
        bytes receiptRef;
    }

    // slot 0
    address private _owner;
    bool private _paused;
    uint64 private _nextNonce;
    // slots 1..3
    address private _pendingOwner;
    address private _proposer;
    uint256 private _maxSpendCap;

    mapping(bytes32 id => Record) private _records;
    mapping(bytes32 key => bool) private _allowed;
    bytes32[] private _ids;

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (_paused) revert RegistryPaused();
        _;
    }

    /// @dev Proposer-or-owner gate then pause gate: authorisation is checked before pause state.
    modifier onlyProposerOrOwnerWhenNotPaused() {
        if (msg.sender != _proposer && msg.sender != _owner) revert NotProposerOrOwner(msg.sender);
        if (_paused) revert RegistryPaused();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param initialOwner Owner (multisig on real networks). Must be non-zero.
    /// @param initialProposer Proposer account (the AutoNEAR agent). Must be non-zero.
    /// @param initialMaxSpendCap Per-proposal cap; 0 selects DEFAULT_MAX_SPEND_CAP.
    constructor(address initialOwner, address initialProposer, uint256 initialMaxSpendCap) {
        if (initialOwner == address(0) || initialProposer == address(0)) revert ZeroAddress();
        _owner = initialOwner;
        _proposer = initialProposer;
        _maxSpendCap = initialMaxSpendCap == 0 ? DEFAULT_MAX_SPEND_CAP : initialMaxSpendCap;
        emit OwnershipTransferred(address(0), initialOwner);
        emit ProposerSet(address(0), initialProposer);
        emit MaxSpendCapSet(0, _maxSpendCap);
    }

    /*//////////////////////////////////////////////////////////////
                             STATE TRANSITIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProposalRegistry
    function propose(
        address target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    ) external onlyProposerOrOwnerWhenNotPaused returns (bytes32 id) {
        if (!_allowed[_key(target, selector)]) revert NotAllowlisted(target, selector);
        if (expiry <= block.timestamp) revert ExpiryNotInFuture(expiry, block.timestamp);
        if (expiry > block.timestamp + MAX_TTL) revert ExpiryTooFar(expiry, block.timestamp + MAX_TTL);
        if (maxSpend == 0) revert ZeroMaxSpend();
        if (maxSpend > _maxSpendCap) revert MaxSpendExceedsCap(maxSpend, _maxSpendCap);

        id = _computeId(target, selector, maxSpend, expiry, nonce, artifactHash);
        // Replay check first: an identical proposal reuses a consumed nonce, and this gives the clearer error.
        if (_records[id].status != Status.None) revert ProposalAlreadyExists(id);
        if (nonce != _nextNonce) revert BadNonce(_nextNonce, nonce);
        _nextNonce = nonce + 1;

        Record storage r = _records[id];
        r.proposer = msg.sender;
        r.status = Status.Pending;
        r.createdAt = uint64(block.timestamp);
        r.target = target;
        r.selector = selector;
        r.expiry = expiry;
        r.nonce = nonce;
        r.maxSpend = maxSpend;
        r.artifactHash = artifactHash;
        _ids.push(id);

        emit Proposed(id, msg.sender, target, selector, maxSpend, expiry, nonce, artifactHash);
    }

    /// @inheritdoc IProposalRegistry
    function approve(bytes32 id) external onlyOwner whenNotPaused {
        Record storage r = _load(id);
        if (r.status != Status.Pending) revert InvalidStatus(id, r.status);
        _requireNotExpired(id, r);
        if (!_allowed[_key(r.target, r.selector)]) revert NotAllowlisted(r.target, r.selector);

        r.status = Status.Approved;
        r.approvedAt = uint64(block.timestamp);
        emit Approved(id, msg.sender);
    }

    /// @inheritdoc IProposalRegistry
    function markExecuted(bytes32 id, uint256 spent, bytes calldata receiptRef)
        external
        onlyOwner
        whenNotPaused
    {
        Record storage r = _load(id);
        if (r.status != Status.Approved) revert InvalidStatus(id, r.status);
        _requireNotExpired(id, r);
        if (spent > r.maxSpend) revert SpentExceedsMaxSpend(spent, r.maxSpend);
        if (receiptRef.length == 0) revert EmptyReceiptRef();
        if (receiptRef.length > MAX_RECEIPT_REF_LEN) {
            revert ReceiptRefTooLong(receiptRef.length, MAX_RECEIPT_REF_LEN);
        }

        r.status = Status.Executed;
        r.executedAt = uint64(block.timestamp);
        r.spent = spent;
        r.receiptRef = receiptRef;
        emit Executed(id, msg.sender, spent, receiptRef);
    }

    /// @inheritdoc IProposalRegistry
    /// @dev Intentionally NOT gated by `whenNotPaused`, so pausing can never trap a proposal.
    function cancel(bytes32 id) external {
        Record storage r = _load(id);
        Status s = r.status;
        if (s != Status.Pending && s != Status.Approved) revert InvalidStatus(id, s);

        bool byOwner = msg.sender == _owner;
        bool byOwningProposer = msg.sender == _proposer && msg.sender == r.proposer && s == Status.Pending;
        if (!byOwner && !byOwningProposer) revert NotAuthorizedToCancel(msg.sender, id);
        _requireNotExpired(id, r);

        r.status = Status.Cancelled;
        emit Cancelled(id, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProposalRegistry
    function pause() external onlyOwner {
        if (_paused) revert AlreadyPaused();
        _paused = true;
        emit Paused(msg.sender);
    }

    /// @inheritdoc IProposalRegistry
    function unpause() external onlyOwner {
        if (!_paused) revert NotPaused();
        _paused = false;
        emit Unpaused(msg.sender);
    }

    /// @inheritdoc IProposalRegistry
    function addAllowed(address target, bytes4 selector) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        bytes32 k = _key(target, selector);
        if (_allowed[k]) revert AlreadyAllowlisted(target, selector);
        _allowed[k] = true;
        emit AllowlistUpdated(target, selector, true);
    }

    /// @inheritdoc IProposalRegistry
    function removeAllowed(address target, bytes4 selector) external onlyOwner {
        bytes32 k = _key(target, selector);
        if (!_allowed[k]) revert AllowlistEntryMissing(target, selector);
        _allowed[k] = false;
        emit AllowlistUpdated(target, selector, false);
    }

    /// @inheritdoc IProposalRegistry
    function setProposer(address newProposer) external onlyOwner {
        if (newProposer == address(0)) revert ZeroAddress();
        emit ProposerSet(_proposer, newProposer);
        _proposer = newProposer;
    }

    /// @inheritdoc IProposalRegistry
    function setMaxSpendCap(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroCap();
        emit MaxSpendCapSet(_maxSpendCap, newCap);
        _maxSpendCap = newCap;
    }

    /// @inheritdoc IProposalRegistry
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == _owner) revert SelfTransfer();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @inheritdoc IProposalRegistry
    function acceptOwnership() external {
        if (msg.sender != _pendingOwner || msg.sender == address(0)) revert NotPendingOwner(msg.sender);
        address previous = _owner;
        _owner = msg.sender;
        _pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProposalRegistry
    function computeId(
        address target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    ) external view returns (bytes32) {
        return _computeId(target, selector, maxSpend, expiry, nonce, artifactHash);
    }

    /// @inheritdoc IProposalRegistry
    function getProposal(bytes32 id) external view returns (Proposal memory p) {
        Record storage r = _load(id);
        p.id = id;
        p.proposer = r.proposer;
        p.target = r.target;
        p.selector = r.selector;
        p.maxSpend = r.maxSpend;
        p.expiry = r.expiry;
        p.nonce = r.nonce;
        p.artifactHash = r.artifactHash;
        p.status = _effectiveStatus(r);
        p.createdAt = r.createdAt;
        p.approvedAt = r.approvedAt;
        p.executedAt = r.executedAt;
        p.spent = r.spent;
        p.receiptRef = r.receiptRef;
    }

    /// @inheritdoc IProposalRegistry
    function statusOf(bytes32 id) external view returns (Status) {
        return _effectiveStatus(_records[id]);
    }

    /// @inheritdoc IProposalRegistry
    function list(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 total = _ids.length;
        if (limit > MAX_PAGE) limit = MAX_PAGE;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _ids[i];
        }
    }

    /// @inheritdoc IProposalRegistry
    function proposalCount() external view returns (uint256) {
        return _ids.length;
    }

    /// @inheritdoc IProposalRegistry
    function isAllowed(address target, bytes4 selector) external view returns (bool) {
        return _allowed[_key(target, selector)];
    }

    /// @inheritdoc IProposalRegistry
    function config() external view returns (Config memory c) {
        c.owner = _owner;
        c.pendingOwner = _pendingOwner;
        c.proposer = _proposer;
        c.paused = _paused;
        c.networkId = block.chainid;
        c.nextNonce = _nextNonce;
        c.maxSpendCap = _maxSpendCap;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _key(address target, bytes4 selector) private pure returns (bytes32) {
        return keccak256(abi.encode(target, selector));
    }

    function _computeId(
        address target,
        bytes4 selector,
        uint256 maxSpend,
        uint64 expiry,
        uint64 nonce,
        bytes32 artifactHash
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                PROPOSAL_TYPEHASH,
                block.chainid,
                address(this),
                target,
                selector,
                maxSpend,
                expiry,
                nonce,
                artifactHash
            )
        );
    }

    function _load(bytes32 id) private view returns (Record storage r) {
        r = _records[id];
        if (r.status == Status.None) revert UnknownProposal(id);
    }

    function _requireNotExpired(bytes32 id, Record storage r) private view {
        if (block.timestamp > r.expiry) revert ProposalExpired(id, r.expiry);
    }

    function _effectiveStatus(Record storage r) private view returns (Status s) {
        s = r.status;
        if ((s == Status.Pending || s == Status.Approved) && block.timestamp > r.expiry) {
            s = Status.Expired;
        }
    }
}
