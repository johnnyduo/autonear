// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentVault} from "./IAgentVault.sol";

/// @title AgentVault
/// @author AutoNEAR
/// @notice Mandate Vault v1 (EVM): holds testnet gas money for ONE autonomous agent and lets it do exactly two
///         things inside an owner-set budget: `draw` ETH to its own address, and `deploy` an owner-allowlisted
///         template via CREATE2 from the vault. Spec: docs/agent-vault-spec.md; shared conformance file:
///         contracts/vault-conformance.json.
/// @dev Design constraints, all load-bearing:
///      - The ONLY external interactions are the value sends in `draw` (to `mandate.agent`) and `withdraw` (to
///        `owner`), both `nonReentrant` with effects before interaction, and CREATE2 in `deploy` (also guarded,
///        counters first). No delegatecall, no selfdestruct, no upgrade path, no arbitrary call, no immutables.
///      - A template id is `keccak256(initcode)`. The initcode includes the constructor arguments, so the OWNER
///        fixes them at allowlist time: the agent can choose a salt, never an owner or any init argument.
///      - Because the id is the initcode hash, the CREATE2 address is a pure function of (vault, salt, id) and is
///        known before deploying (`predictAddress`).
///      - Spend rules for deploys are vacuous on EVM: the spec charges a deploy its template `deposit`, and EVM
///        templates must have `deposit == 0` (enforced in `allowTemplate`), so a deploy spends nothing and the
///        PeriodCap / TotalCap / InsufficientBalance checks cannot fire for it. They are therefore not executed in
///        `deploy`; deploys are bounded by `max_deploys` instead.
///      - Time is `block.timestamp` seconds. Reverts and previews share ONE check function per operation, so
///        `previewX` returns exactly the selector the real call would revert with (by construction, and tested).
///      - Preview return convention: the 4-byte selector of the custom error (`bytes4(0)` = ok).
///      - Funds sent by `selfdestruct` of another contract or as a coinbase reward are not `Deposited`-logged but
///        count toward `available()` (it is `address(this).balance`).
contract AgentVault is IAgentVault {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum mandate lifetime from the setting block, and maximum `periodSecs` (30 days).
    uint256 public constant MAX_DURATION = 30 days;

    /// @notice Minimum `periodSecs`.
    uint256 public constant MIN_PERIOD = 60;

    /// @notice Maximum `maxDeploys` of one mandate.
    uint256 public constant MAX_DEPLOYS = 1000;

    /// @notice Maximum byte length of a template label.
    uint256 public constant MAX_LABEL_LEN = 64;

    /// @dev Transient-storage slot of the reentrancy lock: keccak256("autonear.mandatevault.v1.reentrancy.lock").
    uint256 private constant _LOCK_SLOT = 0xe2717bc909539af3f9040166fd21e9570317276d13e22c209b7a6733e0986233;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    // slot 0
    address private _owner;
    bool private _paused;
    uint64 private _epoch;
    // slot 1
    address private _pendingOwner;

    Mandate private _mandate;
    Usage private _usage;

    mapping(bytes32 id => uint256 indexPlusOne) private _tplIndex;
    mapping(bytes32 id => string label) private _tplLabel;
    bytes32[] private _tplIds;

    /// @dev CREATE2 addresses this vault has successfully deployed to. Needed because a template may deploy EMPTY
    ///      runtime code: the account then has a nonce but `code.length == 0`, so a code check alone would
    ///      let preview say "ok" for an address CREATE2 can no longer use.
    mapping(address target => bool used) private _deployedAt;

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        uint256 slot = _LOCK_SLOT;
        uint256 locked;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
        if (locked != 0) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param initialOwner Owner (a multisig on any real network). Must be non-zero.
    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert BadOwner();
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /// @notice Plain ETH transfers are accepted (gifts). They do not change any budget.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /*//////////////////////////////////////////////////////////////
                              OWNER OPERATIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentVault
    function setMandate(
        address agent,
        uint256 expiresAt,
        uint256 perDrawCap,
        uint256 periodSecs,
        uint256 periodCap,
        uint256 totalCap,
        uint256 maxDeploys
    ) external onlyOwner {
        if (
            agent == address(0) || expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DURATION
                || perDrawCap == 0 || perDrawCap > periodCap || periodCap > totalCap
                || periodSecs < MIN_PERIOD || periodSecs > MAX_DURATION || maxDeploys > MAX_DEPLOYS
        ) revert BadMandate();

        // The bounds above make every narrowing cast below lossless.
        // forge-lint: disable-start(unsafe-typecast)
        uint64 expires = uint64(expiresAt);
        uint64 period = uint64(periodSecs);
        uint32 deploys = uint32(maxDeploys);
        uint64 start = uint64(block.timestamp);
        // forge-lint: disable-end(unsafe-typecast)

        uint64 epoch = ++_epoch;
        _mandate = Mandate({
            agent: agent,
            expiresAt: expires,
            maxDeploys: deploys,
            start: start,
            periodSecs: period,
            revoked: false,
            perDrawCap: perDrawCap,
            periodCap: periodCap,
            totalCap: totalCap
        });
        delete _usage;

        emit MandateSet(epoch, agent, expires, perDrawCap, period, periodCap, totalCap, deploys, start);
    }

    /// @inheritdoc IAgentVault
    function revoke() external onlyOwner {
        if (_mandate.agent == address(0)) revert NoMandate();
        _mandate.revoked = true;
        emit MandateRevoked(_epoch, msg.sender);
    }

    /// @inheritdoc IAgentVault
    function pause() external onlyOwner {
        _paused = true;
        emit VaultPaused(msg.sender);
    }

    /// @inheritdoc IAgentVault
    function unpause() external onlyOwner {
        _paused = false;
        emit VaultUnpaused(msg.sender);
    }

    /// @inheritdoc IAgentVault
    function allowTemplate(bytes32 templateId, string calldata label, uint256 deposit) external onlyOwner {
        if (templateId == bytes32(0) || deposit != 0 || bytes(label).length > MAX_LABEL_LEN) {
            revert BadTemplate();
        }
        if (_tplIndex[templateId] == 0) {
            _tplIds.push(templateId);
            _tplIndex[templateId] = _tplIds.length;
        }
        _tplLabel[templateId] = label;
        emit TemplateAllowed(templateId, label, deposit);
    }

    /// @inheritdoc IAgentVault
    function disallowTemplate(bytes32 templateId) external onlyOwner {
        uint256 idx = _tplIndex[templateId];
        if (idx == 0) revert TemplateNotAllowed();
        uint256 last = _tplIds.length;
        if (idx != last) {
            bytes32 moved = _tplIds[last - 1];
            _tplIds[idx - 1] = moved;
            _tplIndex[moved] = idx;
        }
        _tplIds.pop();
        delete _tplIndex[templateId];
        delete _tplLabel[templateId];
        emit TemplateDisallowed(templateId);
    }

    /// @inheritdoc IAgentVault
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert BadAmount();
        if (amount > address(this).balance) revert InsufficientBalance();
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @inheritdoc IAgentVault
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0) || newOwner == _owner) revert BadOwner();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @inheritdoc IAgentVault
    function acceptOwnership() external {
        // "No transfer pending" (pending == 0) is Unauthorized for everyone.
        address pending = _pendingOwner;
        if (pending == address(0) || msg.sender != pending) revert Unauthorized();
        address previous = _owner;
        _owner = msg.sender;
        delete _pendingOwner;
        emit OwnershipTransferred(previous, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                             AGENT OPERATIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentVault
    function draw(uint256 amount) external nonReentrant {
        bytes4 err = _gate(msg.sender);
        if (err == bytes4(0)) err = _checkDraw(amount);
        if (err != bytes4(0)) _revertWith(err);

        // Effects.
        Mandate storage m = _mandate;
        Usage storage u = _usage;
        uint64 periodIndex = _periodIndex(m);
        uint256 periodSpent = _effectivePeriodSpent(u, periodIndex) + amount;
        u.totalSpent += amount;
        u.periodIndex = periodIndex;
        u.periodSpent = periodSpent;
        address agent = m.agent;
        emit Drawn(_epoch, agent, amount, u.totalSpent, periodSpent);

        // Interaction: the ONLY recipient is the mandate's agent.
        (bool ok,) = agent.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @inheritdoc IAgentVault
    function deploy(bytes32 templateId, bytes32 salt, bytes calldata code)
        external
        nonReentrant
        returns (address target)
    {
        bytes4 err = _gate(msg.sender);
        if (err == bytes4(0)) err = _checkDeploy(templateId, salt, keccak256(code));
        if (err != bytes4(0)) _revertWith(err);

        // Effects (the deploy spends nothing on EVM, see contract NatSpec).
        uint256 deploys = ++_usage.deploys;

        // Interaction: CREATE2 of the exact bytes whose hash is the allowlisted template id, value 0.
        bytes memory initcode = code;
        assembly ("memory-safe") {
            target := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        if (target == address(0)) revert DeployFailed();
        _deployedAt[target] = true;

        emit Deployed(_epoch, templateId, target, salt, deploys);
    }

    /*//////////////////////////////////////////////////////////////
                                   VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentVault
    function config() external view returns (Config memory) {
        return Config({
            owner: _owner,
            pendingOwner: _pendingOwner,
            paused: _paused,
            networkId: block.chainid,
            epoch: _epoch
        });
    }

    /// @inheritdoc IAgentVault
    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    /// @inheritdoc IAgentVault
    function usage() external view returns (Usage memory) {
        return _usage;
    }

    /// @inheritdoc IAgentVault
    function template(bytes32 templateId) external view returns (Template memory) {
        return _templateOf(templateId);
    }

    /// @inheritdoc IAgentVault
    function templates(uint256 from, uint256 limit) external view returns (Template[] memory page) {
        uint256 n = _tplIds.length;
        if (from >= n) return page;
        if (limit > n - from) limit = n - from;
        page = new Template[](limit);
        for (uint256 i; i < limit; ++i) {
            page[i] = _templateOf(_tplIds[from + i]);
        }
    }

    /// @inheritdoc IAgentVault
    function templateCount() external view returns (uint256) {
        return _tplIds.length;
    }

    /// @inheritdoc IAgentVault
    function available() external view returns (uint256) {
        return address(this).balance;
    }

    /// @inheritdoc IAgentVault
    function periodState(uint256 ts) external view returns (PeriodState memory ps) {
        Mandate storage m = _mandate;
        if (m.agent == address(0) || ts < m.start) return ps;
        uint64 index = uint64((ts - m.start) / m.periodSecs);
        ps.index = index;
        ps.spent = _effectivePeriodSpent(_usage, index);
        ps.startsAt = uint256(m.start) + uint256(index) * m.periodSecs;
        ps.endsAt = ps.startsAt + m.periodSecs;
    }

    /// @inheritdoc IAgentVault
    function previewDraw(uint256 amount) external view returns (bytes4 err) {
        err = _gate(_mandate.agent);
        if (err == bytes4(0)) err = _checkDraw(amount);
    }

    /// @inheritdoc IAgentVault
    function previewDeploy(bytes32 templateId, bytes32 salt) external view returns (bytes4 err) {
        err = _gate(_mandate.agent);
        // The code is assumed to match: its hash IS the template id.
        if (err == bytes4(0)) err = _checkDeploy(templateId, salt, templateId);
    }

    /// @inheritdoc IAgentVault
    function predictAddress(bytes32 templateId, bytes32 salt) public view returns (address) {
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, templateId))))
            );
    }

    /// @inheritdoc IAgentVault
    function templateIdOf(bytes calldata initcode) external pure returns (bytes32) {
        return keccak256(initcode);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Agent gate, in spec order: NoMandate -> Unauthorized -> Paused -> MandateInactive. 0 = pass.
    function _gate(address caller) private view returns (bytes4) {
        Mandate storage m = _mandate;
        if (m.agent == address(0)) return NoMandate.selector;
        if (caller != m.agent) return Unauthorized.selector;
        if (_paused) return Paused.selector;
        if (m.revoked || block.timestamp >= m.expiresAt) return MandateInactive.selector;
        return bytes4(0);
    }

    /// @dev Draw rules after the gate, in spec order. Subtractions cannot underflow: usage never exceeds a cap.
    function _checkDraw(uint256 amount) private view returns (bytes4) {
        Mandate storage m = _mandate;
        Usage storage u = _usage;
        if (amount == 0) return BadAmount.selector;
        if (amount > m.perDrawCap) return PerDrawCap.selector;
        if (amount > m.periodCap - _effectivePeriodSpent(u, _periodIndex(m))) return PeriodCap.selector;
        if (amount > m.totalCap - u.totalSpent) return TotalCap.selector;
        if (amount > address(this).balance) return InsufficientBalance.selector;
        return bytes4(0);
    }

    /// @dev Deploy rules after the gate, in spec order. The spend rules are vacuous (deposit is always 0).
    function _checkDeploy(bytes32 templateId, bytes32 salt, bytes32 codeHash) private view returns (bytes4) {
        if (_tplIndex[templateId] == 0) return TemplateNotAllowed.selector;
        if (codeHash != templateId) return CodeMismatch.selector;
        if (_usage.deploys >= _mandate.maxDeploys) return DeployLimit.selector;
        address predicted = predictAddress(templateId, salt);
        if (_deployedAt[predicted] || predicted.code.length != 0) return AddressTaken.selector;
        return bytes4(0);
    }

    /// @dev floor((now - start) / periodSecs). Only called while a mandate is active, so `now >= start`.
    function _periodIndex(Mandate storage m) private view returns (uint64) {
        return uint64((block.timestamp - m.start) / m.periodSecs);
    }

    /// @dev `periodSpent` when `index` is the stored period, else 0 (treated as re-based on the next spend).
    function _effectivePeriodSpent(Usage storage u, uint64 index) private view returns (uint256) {
        return u.periodIndex == index ? u.periodSpent : 0;
    }

    function _templateOf(bytes32 templateId) private view returns (Template memory t) {
        if (_tplIndex[templateId] == 0) return t;
        t = Template({id: templateId, label: _tplLabel[templateId], deposit: 0});
    }

    /// @dev Revert with exactly the 4-byte custom-error selector `err` (identical to `revert X()`).
    function _revertWith(bytes4 err) private pure {
        assembly ("memory-safe") {
            mstore(0, err)
            revert(0, 4)
        }
    }
}
