# autonear-registry (NEAR)

NEAR (Rust, `near-sdk` 5.6.0) implementation of **Proposal Registry v1**, the attestation registry specified in
[`docs/contracts-spec.md`](../../docs/contracts-spec.md). State machine: `propose -> approve -> executed | cancelled | expired`.

It never holds funds, never makes a cross-contract call and never creates a `Promise`/receipt (asserted by the test
`no_promises_or_receipts_are_ever_created`), so there is no reentrancy or callback surface. Execution happens out of band; the owner
only *records* it with `mark_executed`.

## Layout

| Path | Purpose |
|---|---|
| `src/lib.rs` | contract (state, transitions, views) |
| `src/id.rs` | canonical proposal-id encoding + hex helpers |
| `src/events.rs` | NEP-297 events |
| `src/tests.rs` | negative-case matrix, golden vectors, property test |
| `test-vectors.json` | golden id vectors, produced by the Rust code (for the TypeScript test) |
| `rust-toolchain.toml`, `Cargo.lock` | pinned toolchain / dependencies |
| `../../scripts/near-build.sh` | deterministic build + JSON build manifest |
| `../../scripts/near-deploy.sh` | prints (does not run) the `near` CLI deploy command |

## API (JSON; every u64/u128 is a decimal string)

Time is the NEAR **block timestamp in nanoseconds**. `expiry` is `U64` nanoseconds since the Unix epoch
(TypeScript: `BigInt(Date.now()) * 1_000_000n`). `max_spend` is a `U128` in the registry's own unit (yoctoNEAR by
convention; the contract only compares it, it never moves value).

Constants: `MAX_TTL` = 30 days = `2_592_000_000_000_000` ns; default `max_spend` cap = 100 NEAR = `100000000000000000000000000`
(owner-settable); `artifact_hash` = 64 lowercase hex chars (32 bytes); `method` = 1..128 chars of `[A-Za-z0-9_]`;
`receipt_ref` = 1..256 bytes.

Change methods (all revert on violation):

| Method | Caller | Notes |
|---|---|---|
| `new(owner_id, proposer_id, network_id, max_spend_cap?)` | init | rejects `system`, all-zero implicit account and the registry account itself as owner/proposer |
| `propose(target, method, max_spend, expiry, nonce, artifact_hash) -> id` | proposer or owner | not paused; (target,method) allowlisted; `now < expiry <= now+MAX_TTL`; `0 < max_spend <= cap`; `nonce == next_nonce`; id unseen |
| `approve(id)` | owner | not paused; Pending; not expired; **re-checks allowlist** |
| `mark_executed(id, spent, receipt_ref)` | owner | not paused; Approved; not expired; `spent <= max_spend` (0 allowed); non-empty bounded `receipt_ref` |
| `cancel(id)` | owner (Pending/Approved) or the *current* proposer for its own Pending proposals | works while paused; reverts on expired proposals |
| `pause()` / `unpause()` | owner | |
| `allowlist_add/remove(target, method)` | owner | |
| `set_proposer(id)`, `set_max_spend_cap(cap)` | owner | cap change only affects future proposals |
| `transfer_ownership(new)` / `accept_ownership()` | owner / pending owner | two-step; self, `system`, all-zero implicit account and the registry account are rejected |
| `migrate()` | contract account only (`#[private]`) | see Upgrade strategy |

Views: `get_proposal(id)`, `status_of(id)` (adds derived `"Expired"`), `list(from_index?, limit?)` (creation order, default 50, max 100),
`proposals_count()`, `is_allowed(target, method)`, `config()`, `compute_proposal_id(...)` (same fields as `propose`, uses the
contract's network id and account). "Expired" = `block_timestamp > expiry` while Pending/Approved; it is never stored. Every
mutating path rejects expired proposals (including `cancel`: an expired proposal is inert).

### Behaviour choices (where the spec leaves room)

* **Allowlist removal after creation:** `approve` re-checks the allowlist, so removal blocks approval of Pending proposals
  (they can still be cancelled). `mark_executed` does **not** re-check: an owner who wants to revoke an already Approved proposal must `cancel` it.
* `cancel` by the proposer requires the caller to be both the proposal's recorded proposer and the *current* `proposer_id`
  (a rotated-out proposer loses access).
* Failed `propose` calls do not consume the nonce (the whole call reverts).
* Owner and proposer administrative calls (allowlist, cap, proposer, ownership) work while paused so that `unpause` can never be blocked.
* Plain NEAR `Transfer` actions to an account cannot be rejected by its contract on NEAR. No method is `#[payable]` (a call with an attached deposit is rejected by the generated wrapper) and there is no withdrawal method, so NEAR sent by transfer is not recoverable except through a redeploy. Do not send funds to the registry beyond what storage staking needs.

## Proposal id (exact encoding)

```
id = sha256(preimage)                      -> 32 bytes, exposed as 64 lowercase hex chars
preimage = F(domain) || F(network_id) || F(registry) || F(target) || F(method)
        || F(max_spend) || F(expiry) || F(nonce) || F(artifact_hash)
F(x) = u32_big_endian(len(x)) || x
```

| # | field | bytes of `x` |
|---|---|---|
| 1 | `domain` | ASCII `autonear.registry.proposal.v1` (29 bytes) |
| 2 | `network_id` | UTF-8, e.g. `testnet` (the `network_id` given to `new`) |
| 3 | `registry` | UTF-8 NEAR account id of the registry contract (`current_account_id`) |
| 4 | `target` | UTF-8 NEAR account id |
| 5 | `method` | UTF-8 method name |
| 6 | `max_spend` | **16 bytes**, u128 big-endian |
| 7 | `expiry` | **8 bytes**, u64 big-endian, nanoseconds |
| 8 | `nonce` | **8 bytes**, u64 big-endian |
| 9 | `artifact_hash` | **32 raw bytes** (decoded from the 64-hex argument) |

Every field is length-prefixed (including fixed-width ones, so fields 6-9 are prefixed with 16, 8, 8, 32), so field boundaries cannot
shift (`"ab"+"c"` != `"a"+"bc"`). The id is computed on-chain; callers never supply it. Changing any field, the network id or the
registry account changes the id. Reference TypeScript:

```ts
const f = (b: Uint8Array) => concat(u32be(b.length), b);
const pre = concat(f(utf8("autonear.registry.proposal.v1")), f(utf8(networkId)), f(utf8(registry)), f(utf8(target)),
  f(utf8(method)), f(u128be(maxSpend)), f(u64be(expiryNs)), f(u64be(nonce)), f(hexToBytes(artifactHash)));
const id = hex(sha256(pre));
```

`test-vectors.json` contains 4 vectors (inputs as strings, `preimage_hex`, expected `id`), generated by the Rust code
(`UPDATE_VECTORS=1 cargo test --locked golden`) and re-checked on every `cargo test` (a stale file fails the test). They
were also independently reproduced with a 10-line Python implementation of the table above.

## Events (NEP-297)

`EVENT_JSON:{"standard":"autonear_registry","version":"1.0.0","event":"<name>","data":{...}}` (`data` is an object; u64/u128 are strings).
Events: `initialized`, `proposed`, `approved`, `executed`, `cancelled`, `paused`, `unpaused`, `allowlist_added`, `allowlist_removed`,
`proposer_set`, `max_spend_cap_set`, `ownership_transfer_started`, `ownership_transferred`, `migrated`. Exactly one event per mutation
(test `events_are_nep297_json_for_every_mutation`); reverted calls emit nothing.

## Toolchain pin and NEAR wasm compatibility

NEAR's runtime rejects newer wasm features. From `near-vm-runner` (`src/features.rs`, prepare V2) the accepted set is: MVP + mutable-global +
**sign-extension**; reference-types, multi-value, bulk-memory, simd, saturating-float-to-int, etc. are all **off**.

* Pinned: `rust-toolchain.toml` -> **1.81.0** (+`wasm32-unknown-unknown`, rustfmt, clippy). Rust >= 1.82 (LLVM 19) enables multi-value/reference-types by default for wasm32 and later bulk-memory; 1.81 emits only MVP + sign-extension.
* Verified (see "What was verified"): the 1.81.0 artifact passes `wasm-tools validate --features mvp,sign-extension`; as a negative control the same crate built with rustc 1.86.0 and default flags **fails** that validation (`zero byte expected`, i.e. reference-types encoding).
* Dependency pinning: `near-sdk = "=5.6.0"`. Latest 5.x (5.30) needs a much newer rustc. 5.7.0 builds the wasm on 1.81, but its `unit-testing` dependency `near-vm-runner 0.28` uses `&raw mut` and needs rustc >= 1.82; 5.6.0 is the newest tried that satisfies both. The lockfile was generated with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo +1.86.0 generate-lockfile` (MSRV-aware) so transitive crates stay compatible with 1.81; always build with `--locked`. Do not run `cargo update` without re-running the build and tests.
* Release profile: `opt-level="z"`, `lto`, `codegen-units=1`, `panic="abort"`, `strip`, `overflow-checks=true`. `wee_alloc` is disabled (unmaintained); the default allocator is used.

## Build

```
scripts/near-build.sh
# -> contracts/near-registry/dist/autonear_registry.wasm
# stdout: {"sha256","bytes","rustc","nearSdk","cargoLockSha256","sourceSha256"}
```
`sourceSha256` = sha256 over, in C-locale sorted relative-path order, `"<path>\0<content>\0"` for `Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml` and every file under `src/` (paths relative to `contracts/near-registry`, `/`-separated). Absolute paths
are remapped (`--remap-path-prefix`) so the wasm hash does not depend on the checkout location or user (a clean build from a copy in a
different directory produced the identical sha256). If `wasm-tools` is on `PATH` (or `WASM_TOOLS=`) the script also validates the wasm and fails on a feature violation;
otherwise it prints a "SKIPPED" notice to stderr.

Tests: `cargo test --locked`, `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` (run inside this directory).

## Deploy

`scripts/near-deploy.sh` holds no keys. It validates inputs and **prints** the command for a human to run:

```
NEAR_DEPLOY_ACCOUNT=registry.you.testnet OWNER_ID=owner.testnet PROPOSER_ID=agent.testnet scripts/near-deploy.sh
# near contract deploy 'registry.you.testnet' use-file '<...>/autonear_registry.wasm' with-init-call new json-args
#   '{"owner_id":"owner.testnet","proposer_id":"agent.testnet","network_id":"testnet"}' prepaid-gas '30 Tgas'
#   attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```
`NEAR_NETWORK=mainnet` is refused unless `I_UNDERSTAND_MAINNET=yes`. The syntax follows the near-cli-rs source
(`src/js_command_match/contract/deploy.rs`, v0.26.x: `contract deploy <account> use-file <wasm> with-init-call <fn> json-args <json> prepaid-gas '<n> Tgas' attached-deposit '<n> NEAR' network-config <net> sign-with-keychain send`)
and docs.near.org examples; the command was **not** executed against a network (no `near` CLI run). `init` and deploy happen in one
atomic batch, so the initializer cannot be front-run. The `network_id` passed to `new` is part of every proposal id: the backend must use the same string.
Use a multisig as `OWNER_ID` on any real network.

## Gas

* View calls are free. For change calls attach **30 Tgas** (the script's init default; unused gas is refunded); typical simple calls need a small fraction of that.
* Measured (unit-test mocks, `env::used_gas()`): host-side cost only, a **lower bound** because wasm instruction cost and the storage flush done by the generated wrapper are not counted: `propose` 0.29 Tgas, `approve` 0.13, `mark_executed` 0.09 (test `host_side_gas_is_far_below_the_default_30_tgas_budget`, asserts < 30 Tgas). Not measured on a real network; no cost is data-dependent beyond constant-size reads/writes (`list` is bounded by `MAX_PAGE=100`, and is a view).

## Storage and deposits

Storage staking is paid from the **contract account's balance** (1 byte = 10^19 yoctoNEAR); methods are non-payable, callers deposit nothing.
Measured with the mock storage accounting (test `storage_bytes_per_proposal_is_small_and_bounded`): **~203 bytes** per Pending
proposal and **~305 bytes** once executed with a 66-byte receipt ref (~0.002-0.003 NEAR each, kept forever). The wasm itself is
~210 KB, i.e. ~2.1 NEAR locked on the contract account. Fund the contract account with several NEAR, and keep an eye on its balance:
if it dropped below the staking requirement, writes would fail. Proposals are never deleted in v1 (they are the audit trail); a v2 may add pruning of old terminal proposals.

## Upgrade strategy

* **Who can upgrade:** whoever holds a full-access key on the *contract account* (distinct from `owner_id`, which only governs registry state). Put that key under the same multisig as `owner_id`, or delete all keys once finalized to make the contract immutable. Decide this before mainnet.
* **How:** `scripts/near-build.sh`, compare the manifest (sha256/sourceSha256) with what reviewers approved, then redeploy with `with-init-call migrate json-args '{}'` in the same batch. `migrate()` is `#[private]` + `#[init(ignore_state)]`; the redeploy batch is signed by the contract account so it passes the private check. Pause the registry before and unpause after for a clean cut-over.
* **State versioning:** `state_version` (currently 1) is stored. v1's `migrate()` just reloads and validates v1 state and emits `migrated`. A v2 keeps the old struct as `RegistryV1`, reads it with `env::state_read::<RegistryV1>()` in `migrate()`, converts, and bumps `STATE_VERSION`. Collections use stable storage prefixes (`StorageKey`), so new fields must be added through the migration, never by reordering the existing ones.
* Why not proxy/immutable by default: NEAR contracts are upgradeable by redeploy, and the migration hook keeps state-layout changes explicit and reviewable.

## What was verified (and what was not)

Ran locally on macOS with rustc 1.81.0 (see the project report for the exact outputs): `cargo test --locked` (unit, negative matrix, golden-vector, a 20,000-step
deterministic LCG state-machine run asserting terminal states never change, ids unique, nonce contiguous, `spent <= max_spend`, expired proposals never mutate and reverted calls never change state), `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`scripts/near-build.sh` (twice, plus a clean copy in another directory: identical sha256), `wasm-tools validate --features mvp,sign-extension`.

**Not verified:** execution on the NEAR sandbox or testnet (near-workspaces was not attempted; unit tests use the near-sdk mocked blockchain only),
the actual near-cli-rs deploy command, real gas numbers, the `#[private]` guard on `migrate` and the non-payable deposit rejection (both are generated into the wasm export wrapper and cannot be exercised by direct-call unit tests), and wasm acceptance by a real NEAR node (validated with `wasm-tools` against the feature set read from the nearcore source instead).
