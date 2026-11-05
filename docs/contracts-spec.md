# Proposal Registry v1: cross-protocol contract spec

One state machine, implemented natively per protocol. The AutoNEAR backend treats every implementation uniformly
(propose -> approve -> executed | cancelled | expired), so semantics MUST match across chains.

## What it is / is not
An **attestation registry** for scoped, human-authorized actions. It binds an off-chain proposal (a policy-bound action:
target, method, max spend, expiry, nonce, artifact hash) to an on-chain, owner-approved record.
It **never holds funds and never calls the target**. Execution is performed by the owner/multisig out of band and
then *recorded* (`mark_executed`) with a receipt reference. No unrestricted agent key exists.

## Roles
- `owner` (should be a multisig on any real network): approve, mark executed, cancel, pause/unpause, manage allowlist, set proposer, transfer ownership (two-step).
- `proposer` (the AutoNEAR agent account/key): may only `propose` and cancel its own Pending proposals. Cannot approve, cannot execute, cannot change config.

## State
`Config`: owner, pending_owner, proposer, paused, network_id (chain id), next_nonce (single global monotonic counter, starts at 0).
`Allowlist`: (target, method) pairs, set by owner. A proposal whose (target, method) is not allowlisted is rejected at `propose`.
`Proposal`: id, proposer, target, method, max_spend, expiry, nonce, artifact_hash, status, created_at, approved_at?, executed_at?, spent?, receipt_ref?.
`status` in { Pending, Approved, Executed, Cancelled }. "Expired" is *derived* (now > expiry and status in {Pending, Approved}); it is never stored but every mutating path must treat it as terminal-for-mutation (revert) and views must report it.

## Identity (proposal id)
`id = H(domain, network_id, registry_address/account, target, method, max_spend, expiry, nonce, artifact_hash)` where H is the protocol's native
hash (NEAR: sha256 of a canonical length-prefixed encoding; EVM: EIP-712 struct hash (keccak256) with typehash constant). The id is computed ON-CHAIN from the
fields; callers do not supply it. An altered field => a different id => the approval for the original id does not apply.
Document the exact encoding in the contract README so the TypeScript backend can reproduce it bit-for-bit (the backend will have a test vector check).

## Transitions (all revert on violation)
- `propose(target, method, max_spend, expiry, nonce, artifact_hash)`: only proposer or owner; not paused; (target,method) allowlisted; expiry > now and expiry <= now + MAX_TTL (30 days);
  `nonce == next_nonce` then increment; max_spend > 0 and <= MAX_SPEND_CAP (config, owner-settable, default documented); id must be new (replay). Emits Proposed.
- `approve(id)`: only owner; not paused; status Pending; not expired. Emits Approved.
- `mark_executed(id, spent, receipt_ref)`: only owner; not paused; status Approved; not expired; spent <= max_spend; receipt_ref non-empty bounded length. Emits Executed. A second call reverts (no duplicate execution).
- `cancel(id)`: owner (Pending or Approved) or proposer (Pending only). Works while paused (so pause never traps state). Emits Cancelled.
- `pause()/unpause()`: owner. While paused: propose/approve/mark_executed revert; cancel and views still work.
- allowlist add/remove, set_proposer, set_max_spend_cap: owner only; each emits an event.
- Ownership: `transfer_ownership(new)` then `accept_ownership()` by new owner (two-step). Zero/self-transfer rejected.
- Views: get_proposal(id), status_of(id) (includes derived Expired), list (paginated), is_allowed(target, method), config.
- Events/logs for every mutation (EVM: indexed events; NEAR: NEP-297 JSON logs `EVENT_JSON:{"standard":"autonear_registry","version":"1.0.0",...}`).

## Required tests (negative-case matrix; each is a named test)
unauthorized signer on every owner/proposer-gated method; proposer attempts approve/execute; altered field => unknown id / wrong id;
wrong target; wrong method; exceeded spend at propose (cap) and at mark_executed; expired at approve and at mark_executed (time travel); replay of identical proposal;
bad nonce (too low / too high / reuse); double execute; execute before approve; approve after cancel; cancel by outsider; cancel Approved by proposer rejected;
pause blocks propose/approve/execute but not cancel; unpause restores; two-step ownership incl. wrong acceptor; zero-address/self owner; allowlist removal after proposal creation
(document the chosen behaviour: approval re-checks allowlist); property/fuzz tests that the state machine never leaves a terminal state and ids are unique and `spent <= max_spend` always;
(EVM) an invariant suite. Reentrancy/callback: there are NO external calls, assert and document that (and in EVM use no `call`/`transfer`; if any ETH is sent to the contract it must revert or be un-withdrawable by design: choose reject-all via no payable fallback).

## Deliverables per implementation
Source, lockfile, pinned toolchain, build command that is deterministic, tests (all passing), README with encoding + gas/storage notes + upgrade strategy
(NEAR: redeploy with state-migration function `migrate()`; EVM: immutable by default, no proxy; state the reasoning and what a v2 would do), deploy script, and a machine-readable
`BUILD_MANIFEST` producing script described in each agent's brief.
