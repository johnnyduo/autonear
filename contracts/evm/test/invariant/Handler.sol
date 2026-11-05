// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IProposalRegistry} from "../../src/IProposalRegistry.sol";
import {ProposalRegistry} from "../../src/ProposalRegistry.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Random-walk driver for the invariant suite. Calls are bounded so most succeed; failing calls
///         are swallowed (the invariants are about what the registry does, not what it rejects).
contract Handler is CommonBase, StdCheats, StdUtils {
    ProposalRegistry public immutable REG;

    address[4] public actors; // owner, proposer, two outsiders (owner/proposer rotate via transfer/setProposer)
    address[3] public targets;
    bytes4[2] public selectors = [bytes4(0xa9059cbb), bytes4(0x095ea7b3)];

    // ghosts
    bytes32[] public created;
    mapping(bytes32 => IProposalRegistry.Status) public terminalStatus;
    mapping(bytes32 => uint256) public terminalSpent;
    mapping(bytes32 => bytes32) public terminalReceiptHash;
    bytes32[] public terminalIds;
    uint64 public lastNextNonce;
    bool public nonceWentBackwards;
    bool public duplicateIdSeen;
    mapping(bytes32 => bool) public seen;
    uint256 public ethSendAttempts;
    uint256 public ethSendSucceeded;
    uint256 public calls;
    uint256 public nApproved;
    uint256 public nExecuted;
    uint256 public nCancelled;
    uint256 public nExpiredObserved;

    constructor(ProposalRegistry r, address owner_, address proposer_) {
        REG = r;
        actors = [owner_, proposer_, address(0xA11CE), address(0xB0B)];
        targets = [address(0x1001), address(0x1002), address(0x1003)];
        // allowlist is seeded by the invariant test's setUp (owner pranks) plus handler toggles.
    }

    /// @dev Biased towards the CURRENT owner / proposer so most calls are authorised and the walk
    ///      reaches deep states; the remainder are arbitrary actors (negative paths).
    function _actor(uint256 seed) internal view returns (address) {
        uint256 k = seed % 8;
        if (k < 3) return REG.config().owner;
        if (k < 5) return REG.config().proposer;
        return actors[(seed / 8) % actors.length];
    }

    function _sync() internal {
        calls++;
        IProposalRegistry.Config memory c = REG.config();
        if (c.nextNonce < lastNextNonce) nonceWentBackwards = true;
        lastNextNonce = c.nextNonce;
        // snapshot new terminal states
        uint256 n = created.length;
        for (uint256 i; i < n; ++i) {
            bytes32 id = created[i];
            if (terminalStatus[id] != IProposalRegistry.Status.None) continue;
            IProposalRegistry.Status s = REG.statusOf(id);
            if (s == IProposalRegistry.Status.Expired) nExpiredObserved++;
            if (s == IProposalRegistry.Status.Executed || s == IProposalRegistry.Status.Cancelled) {
                terminalStatus[id] = s;
                IProposalRegistry.Proposal memory p = REG.getProposal(id);
                terminalSpent[id] = p.spent;
                terminalReceiptHash[id] = keccak256(p.receiptRef);
                terminalIds.push(id);
            }
        }
    }

    function propose(uint256 who, uint256 t, uint256 s, uint256 maxSpend, uint256 ttl, uint256 badNonce)
        external
    {
        address caller = _actor(who);
        address tgt = targets[t % targets.length];
        bytes4 sel = selectors[s % selectors.length];
        uint256 cap = REG.config().maxSpendCap;
        maxSpend = bound(maxSpend, 1, cap);
        uint64 expiry = uint64(block.timestamp + bound(ttl, 1, 12 days));
        uint64 nonce = REG.config().nextNonce;
        if (badNonce % 7 == 0) nonce = uint64(bound(badNonce, 0, nonce + 3)); // sometimes wrong/replayed
        bytes32 artifact = keccak256(abi.encode(calls, maxSpend));
        vm.prank(caller);
        try REG.propose(tgt, sel, maxSpend, expiry, nonce, artifact) returns (bytes32 id) {
            if (seen[id]) duplicateIdSeen = true;
            seen[id] = true;
            created.push(id);
        } catch {}
        _sync();
    }

    function approve(uint256 who, uint256 idx) external {
        if (created.length == 0) return _sync();
        vm.prank(_actor(who));
        try REG.approve(created[idx % created.length]) {
            nApproved++;
        } catch {}
        _sync();
    }

    function markExecuted(uint256 who, uint256 idx, uint256 spent, bytes calldata ref) external {
        if (created.length == 0) return _sync();
        bytes32 id = created[idx % created.length];
        spent = bound(spent, 0, REG.getProposal(id).maxSpend + (spent % 5 == 0 ? 1 : 0)); // sometimes over
        vm.prank(_actor(who));
        try REG.markExecuted(id, spent, ref) {
            nExecuted++;
        } catch {}
        _sync();
    }

    function cancel(uint256 who, uint256 idx) external {
        if (created.length == 0) return _sync();
        vm.prank(_actor(who));
        try REG.cancel(created[idx % created.length]) {
            nCancelled++;
        } catch {}
        _sync();
    }

    function pauseToggle(uint256 who, bool on) external {
        vm.prank(_actor(who));
        if (on) {
            try REG.pause() {} catch {}
        } else {
            try REG.unpause() {} catch {}
        }
        _sync();
    }

    function toggleAllow(uint256 who, uint256 t, uint256 s, bool on) external {
        vm.prank(_actor(who));
        if (on) {
            try REG.addAllowed(targets[t % targets.length], selectors[s % selectors.length]) {} catch {}
        } else {
            try REG.removeAllowed(targets[t % targets.length], selectors[s % selectors.length]) {} catch {}
        }
        _sync();
    }

    function setCap(uint256 who, uint256 cap) external {
        vm.prank(_actor(who));
        try REG.setMaxSpendCap(bound(cap, 1, 5000 ether)) {} catch {}
        _sync();
    }

    function setProposer(uint256 who, uint256 newP) external {
        vm.prank(_actor(who));
        try REG.setProposer(_actor(newP)) {} catch {}
        _sync();
    }

    function transferOwnership(uint256 who, uint256 to) external {
        vm.prank(_actor(who));
        try REG.transferOwnership(_actor(to)) {} catch {}
        _sync();
    }

    function acceptOwnership(uint256 who) external {
        vm.prank(_actor(who));
        try REG.acceptOwnership() {} catch {}
        _sync();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
        _sync();
    }

    /// @dev Try every way of pushing ETH into the registry. All must fail.
    function sendEth(uint256 who, uint256 kind, uint256 amount) external {
        address caller = _actor(who);
        amount = bound(amount, 1, 10 ether);
        vm.deal(caller, amount);
        ethSendAttempts++;
        bool ok;
        vm.prank(caller);
        if (kind % 4 == 0) {
            (ok,) = address(REG).call{value: amount}("");
        } else if (kind % 4 == 1) {
            (ok,) = address(REG).call{value: amount}(hex"deadbeef");
        } else if (kind % 4 == 2) {
            (ok,) = address(REG).call{value: amount}(abi.encodeCall(REG.pause, ()));
        } else {
            (ok,) = address(REG).call{value: amount}(abi.encodeCall(REG.approve, (keccak256("x"))));
        }
        if (ok) ethSendSucceeded++;
        _sync();
    }

    function createdLength() external view returns (uint256) {
        return created.length;
    }

    function terminalLength() external view returns (uint256) {
        return terminalIds.length;
    }
}
