# autonear-vault (NEAR)

NEAR (Rust, `near-sdk` 5.6.0) implementation of **Mandate Vault v1**, specified in
[`docs/agent-vault-spec.md`](../../docs/agent-vault-spec.md) and checked against the shared
[`contracts/vault-conformance.json`](../vault-conformance.json). Testnet only: there is no mainnet path.

A vault holds testnet NEAR for one autonomous agent and lets that agent do exactly two things, inside one budget:

1. `draw(amount)`: pull NEAR to **its own bound account** (never anywhere else).
2. `deploy(template, name, code)`: create the sub-account `{name}.{vault}` and deploy an **owner-allowlisted wasm** with
   **owner-fixed init arguments**. The sub-account gets **no access key** and is therefore immutable.

The agent can never change config, widen its budget, send funds elsewhere, deploy unlisted code, pick init arguments (so it
cannot choose who owns a deployed registry), upgrade, or withdraw. The owner can always revoke, pause, replace the mandate and
`withdraw` to the owner account. There is no upgrade method and no method that calls anything the agent names.

## Layout

| Path | Purpose |
|---|---|
| `src/lib.rs` | contract: state, rules, promise batches, views |
| `src/errors.rs` | the 17 spec error codes and `E_<Code>: detail` panics |
| `src/events.rs` | NEP-297 events |
| `src/conformance.rs` | harness: runs every `near`/untagged scenario of `vault-conformance.json` |
| `src/tests.rs`, `src/testkit.rs` | named unit / negative tests + shared helpers |
| `integration/` | **real nearcore sandbox** tests (separate crate, own toolchain): deploys the registry wasm through the vault |
| `rust-toolchain.toml`, `Cargo.lock` | pinned toolchain (rustc 1.81.0) / dependencies |
| `../../scripts/near-vault-build.sh` | deterministic build + JSON build manifest |
| `../../scripts/near-vault-deploy.sh` | prints (does not run) the testnet deploy + owner-setup commands |

## Behaviour

Time is **seconds** (`block_timestamp / 1e9`). Amounts are `U128` yoctoNEAR (decimal strings in JSON); `expires_at`,
`period_secs`, `init_gas` are `U64` strings. `active(now)` = a mandate exists, is not revoked and `now < expires_at`
(expiry is exclusive). `period_index(now) = floor((now - start) / period_secs)`; when it differs from the stored one the period spend
reads as 0 and is re-based on the next spend. A **spend** is a draw amount or a deploy's template `deposit`; both consume the same
period/total budget (`per_draw_cap` applies to draws only).

| Method | Caller | Rules (first failing rule wins, in this order) |
|---|---|---|
| `new(owner, network_id)` | init | not already initialised; `network_id` 1..32 bytes; owner not `system`/all-zero implicit/the vault itself (`BadOwner`) |
| `set_mandate(agent, expires_at, per_draw_cap, period_secs, period_cap, total_cap, max_deploys)` | owner | agent parses, not zero/`system`/vault; `now < expires_at <= now+30d`; `0 < per_draw_cap <= period_cap <= total_cap`; `60 <= period_secs <= 30d`; `max_deploys <= 1000` (else `BadMandate`). Replaces any mandate, `epoch += 1`, usage reset, `start = now`. Works while paused. `agent` is a *string* so `""` yields `E_BadMandate`, not a decode error |
| `revoke()` | owner | `NoMandate` if none; idempotent (event only on change) |
| `pause()` / `unpause()` | owner | block agent ops only; idempotent (event only on change) |
| `allow_template(template_id, label, deposit, init_args?, init_gas?)` | owner | `template_id` = 64 lowercase hex of `sha256(wasm)`; `label <= 64` bytes; `init_args` a JSON **object**, stored compact (sorted keys), **<= 1024 bytes** (default `{}`); `init_gas` 5..=200 Tgas (default 30); else `BadTemplate`. Re-allowing an id updates it |
| `disallow_template(template_id)` | owner | unknown => `TemplateNotAllowed` |
| `withdraw(amount)` | owner | `0 < amount <= available` (`BadAmount` / `InsufficientBalance`); pays the **owner only**; works while paused / revoked / expired / template-less |
| `transfer_ownership(to)` / `accept_ownership()` | owner / pending owner | two-step; `to` empty, invalid, zero, self or the vault => `BadOwner`; wrong acceptor => `Unauthorized` |
| `deposit()` | anyone, payable | gift; must attach > 0 (`BadAmount`). A plain transfer also works but emits no event |
| `draw(amount)` | agent | `NoMandate`, `Unauthorized`, `Paused`, `MandateInactive`, then `BadAmount`, `PerDrawCap`, `PeriodCap`, `TotalCap`, `InsufficientBalance`. Counters change first, then one `Transfer` to `mandate.agent` followed by the `on_drawn` callback (5 Tgas) |
| `deploy(template, name, code)` | agent | the four agent gates, then `TemplateNotAllowed`, `CodeMismatch` (`sha256(code) != template`), `DeployLimit`, `PeriodCap`, `TotalCap`, `InsufficientBalance` (all with `template.deposit`), `AddressTaken`, `BadName` |
| `on_deployed(...)`, `on_drawn(...)` | the vault itself (`#[private]`) | callbacks, see below |

Owner ops check `Unauthorized` before anything else, so non-owners learn nothing. Agent ops check `NoMandate` (for any caller)
before `Unauthorized`.

Views: `config()`, `mandate()`, `usage()`, `template(id)`, `templates(from_index?, limit?)` (default 50, max 100; order is
insertion order until a `disallow_template` moves the last entry into the freed slot), `available()`, `period_state(now?)`
(figures effective at `now`, default current time), `preview_draw(amount)` and `preview_deploy(template, name)`. Previews assume the
caller is the bound agent and the current time, never mutate, share the exact same rule code as the real calls, and return the
error code the call would hit (`""` = ok). Differences by design: previews never return `Unauthorized`, and `preview_deploy`
cannot return `CodeMismatch` because it does not see the wasm bytes.

`available = account_balance - storage_usage * storage_byte_cost - 1 NEAR`, floored at 0. The 1 NEAR reserve keeps the vault
above its storage-staking requirement while the name set and templates grow.

### Deploy (what actually happens)

`deploy` takes the template id (hex), the sub-account label `name` and the wasm bytes (`code`, base64 in JSON). The vault checks
`sha256(code) == template id`, then creates ONE promise batch to `{name}.{vault}`:

```
CreateAccount, Transfer(template.deposit), DeployContract(code), FunctionCall("new", <stored init_args>, 0, <stored init_gas>)
```
followed by a callback receipt `on_deployed` (10 Tgas). There is **no `AddKey` action**: the new account has no key of any kind.
The agent supplies only template, name and code; init arguments, init gas and deposit all come from the owner's template.
Names: `1..=32` bytes of `[a-z0-9_-]`, first/last character alphanumeric, no two separators in a row, **no dots**
(NEAR's account grammar minus dots); the full `{name}.{vault}` must also be a valid account id (<= 64 chars), else `BadName`.
(The coordinator's brief said 2..=32 first; it was corrected to 1..=32 because the conformance file deploys `a`, `b`, `c`, `z`.)
A name that was reserved stays used forever once its deploy is confirmed (`AddressTaken`), also across mandates.

### Optimistic charging and the callback window

Both `deploy` and `draw` are asynchronous and charge optimistically; both have a private callback that reverses the charge on failure (`draw` is described at the end of this section).

For `deploy`: `deploy` **charges the budget first** (total, period, deploys counter, name reservation) and emits
`deployed`; the deposit leaves the vault balance immediately. If the batch fails (e.g. the deposit cannot pay storage for the wasm,
`new` panics, the account id is invalid), the runtime refunds the deposit to the vault and the callback `on_deployed` then:

* releases the name and, **if the mandate epoch is unchanged**, subtracts the deposit from `total_spent`, decrements `deploys`
  and, if the stored period index is still the one charged, subtracts it from `period_spent`; emits `deploy_failed` with
  `reversed: true`;
* if the owner replaced the mandate in the meantime (`epoch` differs), the new mandate's counters are left alone and the event says
  `reversed: false` (the old counters no longer exist);
* on success it emits `deploy_confirmed` and changes nothing.

The window is the 1-3 blocks between the `deploy` transaction and the callback. During it: the budget is charged (conservative:
never under-counted), `available()` is lower, the name is reserved (a second deploy of the same name gets `AddressTaken`), and
`usage().deploys` includes the in-flight deploy. Consequences: a failed deploy cannot be retried with the same name until the
callback ran; the agent can briefly be blocked by its own failed attempt. If the callback itself could not run (it has static gas
reserved, so only an out-of-gas in the callback body, which does a handful of storage writes, would do this) the charge stays: the
failure direction is "agent has less budget", never "more".

**`draw`** works the same way: counters are charged before the `Transfer` to `mandate.agent`, and the callback `on_drawn(epoch, period_index, agent, amount)`
reverses the charge if the transfer failed (typically: the bound named agent account was deleted; the runtime refunds the amount to the vault).
Reversal is applied only inside the same mandate epoch, `period_spent` only if the stored period is still the one that was charged, with saturating
arithmetic (a replay cannot underflow); `deploys` and the deploy name set are never touched. A failure emits `draw_failed {agent, amount, epoch, reversed}`;
success emits nothing. Window: between the `draw` transaction and the callback (1-3 blocks) the draw counts against the budget and `available()` is lower.
If the callback cannot run (out of gas in its tiny body) the charge stays, i.e. again "less budget, never more". `withdraw` has no callback: a failed transfer
to a deleted owner account is refunded to the vault and nothing is charged.

### Keyless sub-account: consequences

* Nobody (agent, owner, anyone) can ever redeploy, upgrade or delete a deployed sub-account, and no one can withdraw its balance.
  Whatever deposit is left in it is **unrecoverable**; that is why the deposit counts against the budget the moment it is sent.
  The deployed contract's own logic is the only thing that can ever move its funds (the registry never does).
* A deployed registry's own `migrate()` upgrade path is therefore dead: to change a registry, deploy a new one under another name
  (this consumes `max_deploys` and budget) and point the backend to it.
* The template `deposit` must cover the code's storage (`bytes * 1e19` yocto, the 210 KB registry needs ~2.1 NEAR) plus its state; with
  too little the batch fails (`LackBalanceForState`) and the callback reverses everything. Measured on the sandbox: the registry wasm
  deployed with a 5 NEAR deposit; the sub-account then held ~5.01 NEAR (the extra ~0.01 NEAR is presumably the contract gas reward for `new`; not investigated).

## Events (NEP-297)

`EVENT_JSON:{"standard":"autonear_vault","version":"1.0.0","event":"<name>","data":{...}}`; `data` is an object, u64/u128 are decimal
strings, times are seconds. Exactly one event per state change (idempotent no-ops and reverted calls emit none).

| event | data |
|---|---|
| `initialized` | owner, network_id |
| `mandate_set` | agent, epoch, start, expires_at, per_draw_cap, period_secs, period_cap, total_cap, max_deploys, by |
| `mandate_revoked` | agent, epoch, by |
| `paused` / `unpaused` | by |
| `template_allowed` | template, label, deposit, init_gas, init_args, updated, by |
| `template_disallowed` | template, by |
| `draw_failed` | agent, amount, epoch, reversed |
| `drawn` | agent, amount, epoch, total_spent, period_spent |
| `deployed` | agent, template, name, target, deposit, epoch, deploys, total_spent, period_spent (batch **dispatched**, charge applied) |
| `deploy_confirmed` | template, name, target |
| `deploy_failed` | template, name, target, deposit, epoch, reversed |
| `withdrawn` | to, amount |
| `deposited` | from, amount |
| `ownership_transfer_started` | owner, pending |
| `ownership_transferred` | old, new |

`deploy_confirmed` and `draw_failed` are additions to the spec's event list (the spec names `Drawn`, `Deployed`, `DeployFailed`); `deployed` alone does
not prove the sub-account exists, `drawn` alone does not prove the agent was paid. Test: `events_are_nep297_json_for_every_mutation`.

## Errors

Every rule violation panics with a message **starting with `E_<Code>:`** followed by human text (`E_PerDrawCap: per-draw cap exceeded`).
Codes (exactly the spec's 17): `Unauthorized Paused NoMandate MandateInactive BadMandate BadAmount PerDrawCap PeriodCap TotalCap
InsufficientBalance DeployLimit TemplateNotAllowed CodeMismatch AddressTaken BadName BadTemplate BadOwner`.

| Code | Raised by |
|---|---|
| `Unauthorized` | non-owner on owner ops; non-agent on agent ops; wrong acceptor |
| `NoMandate` | agent op without a mandate (any caller); `revoke` without a mandate |
| `Paused` / `MandateInactive` | agent op while paused / mandate revoked or `now >= expires_at` |
| `BadMandate` | any `set_mandate` bound |
| `BadAmount` | draw 0, withdraw 0, `deposit()` without value |
| `PerDrawCap` `PeriodCap` `TotalCap` | budget rules (draw; PeriodCap/TotalCap also for a deploy's deposit) |
| `InsufficientBalance` | amount (or deposit) > `available` |
| `DeployLimit` | `deploys >= max_deploys` |
| `TemplateNotAllowed` | unknown/malformed template id on deploy or disallow |
| `CodeMismatch` | `sha256(code) != template id` |
| `AddressTaken` / `BadName` | name already reserved / invalid name or account id |
| `BadTemplate` | `allow_template`: bad id, label > 64 B, init_args not an object or > 1 KiB, init_gas out of range |
| `BadOwner` | `new` / `transfer_ownership` with empty, zero, self or vault account |

Not part of the table (plain messages): `new` called twice, invalid `network_id`, callback/private/non-payable guards generated by near-sdk
(`Method on_deployed is private`, deposit attached to a non-payable method).

## Storage and gas

* The vault wasm is ~250 KB, i.e. about 2.5 NEAR of storage staking on the vault account. Each template stores label + <= 1 KiB args + 3
  numbers, each used name a short string; none of these per-entry costs was measured, the 1 NEAR reserve is the cushion. `withdraw`
  can never take the vault below `storage + 1 NEAR`.
* Gas (measured **once**, on the local nearcore 2.13.4 sandbox, registry wasm 210,822 bytes through base64 JSON, 300 Tgas attached):
  the vault's `deploy` receipt burned **39.1 Tgas** (JSON/base64 decode, sha256, promise creation), the batch on the new account
  **22.6 Tgas**, the callback **1.5 Tgas**, whole receipt tree ~77 Tgas. The batch reserves the template's `init_gas`
  (default 30 Tgas) and 10 Tgas for the callback inside the caller's prepaid gas; attach 300 Tgas (unused gas is refunded to the agent). The
  gas of all of this is paid by the agent's transaction, not by the vault; only the deposit comes from the vault.
  Smaller or larger wasm will differ; the sandbox is not testnet pricing.
* The transaction must carry the whole wasm (`code`); how large a wasm still fits NEAR's transaction-size limit was not tried.

## Threat model

| Threat | Mitigation | Evidence |
|---|---|---|
| Compromised agent key drains the vault | per-draw / period / total caps, expiry <= 30 d, owner `pause`/`revoke`, draw pays only `mandate.agent` | conformance + `no_method_lets_the_agent_redirect_funds` |
| Agent deploys arbitrary code | only `sha256(code) == allowlisted id` | `CodeMismatch` scenarios; sandbox |
| Agent picks the owner of a deployed registry | init args, gas and deposit are stored by the owner | `agent_cannot_choose_init_args_gas_or_deposit`; sandbox `config().owner_id` |
| Agent re-uses the keyless account or takes keys | no `AddKey` in code, wasm does not import the add_key/delete_key/delete_account/stake host functions | `deploy_sends_stored_init_args...`, `vault_wasm_imports_no_key_...` (integration), sandbox access-key list is empty |
| Agent calls an owner method | every owner method starts with an owner check | `agent_cannot_reach_any_owner_method`, sandbox |
| Owner locked out / funds trapped | `withdraw` ignores pause, revocation, expiry and templates | `owner_can_still_withdraw_when_everything_else_is_blocked` |
| Replayed / forged callback | `on_deployed` and `on_drawn` are `#[private]`; stale epoch is not applied; saturating arithmetic | sandbox (`private` rejection), `double_callback_cannot_underflow`, `draw_callback_replay_cannot_underflow` |
| Arithmetic overflow | `saturating_*` on caller-controlled amounts, `overflow-checks = true` in release | `draw_never_overflows_on_huge_amounts` |
| **Holder of a full-access key on the vault account** | NOT mitigated by the contract: they can redeploy it or move its balance. Keep that key under the owner multisig, or delete it once you accept immutability (deploy script note) | out of scope of the code |
| Owner key compromise | owner is all-powerful by design; use a multisig and two-step transfer | n/a |
| Front-running of init | deploy + `new` in one batch | n/a |

## Payouts feature (v1.1.0, cargo feature `payouts`, stage 1)

**Off by default.** A normal `cargo build` / `scripts/near-vault-build.sh` is the attested v1 and its wasm hash does not change; all
payout code (`src/payouts.rs`, extra errors and events, tests in `src/tests_pay.rs`) is compiled only with `--features payouts`.
`scripts/near-vault-build.sh --payouts` builds `dist/autonear_vault_pay.wasm` (the JSON gets `"features":"payouts"`); `config().version`
is `1.1.0` in that build only. Design: `docs/superpowers/specs/2026-11-06-stablecoin-payouts-design.md` (stage 1 only: no `fund_product`,
no claim contract; money flows out only).

| Method | Who | Rule |
|---|---|---|
| `allow_token(token, per_pay_cap, period_cap, total_cap)` | owner | `0 < per_pay <= period <= total`; <= 8 tokens; not the vault / a zero account / an allowed payee, else `BadToken`. Re-allow updates the caps and **keeps the usage** |
| `disallow_token(token)` | owner | unknown => `TokenNotAllowed`; usage record is kept |
| `allow_payee(account)` / `disallow_payee(account)` | owner | <= 64 payees; not the vault / zero account / an allowed token, else `BadPayee`; allowing twice is a silent no-op; disallowing an unknown one => `PayeeNotAllowed` |
| `withdraw_token(token, amount)` | owner | `ft_transfer(owner, amount)` with 1 yocto; works while paused, revoked, expired and for any token account; a failed transfer only emits `token_withdraw_failed` |
| `pay(token, to, amount, memo?)` | the mandate agent | order: NoMandate, Unauthorized, Paused, MandateInactive, `TokenNotAllowed`, `PayeeNotAllowed`, `BadAmount` (0), `PerPayCap`, `PeriodCap`, `TotalCap`, `BadMemo` (> 128 bytes), `InsufficientBalance` (no spendable NEAR for the 1 yocto). Optimistic charge, event `paid`, `ft_transfer(to, amount, memo)` on `token` (1 yocto, 30 Tgas), then `on_paid` (10 Tgas) reverses the charge on failure (same epoch only, saturating) and emits `pay_failed`. Attach >= 100 Tgas |
| views | anyone | `tokens()`, `payees(from_index, limit)`, `token_usage(token)`, `token_period_state(token, now?)`, `preview_pay(token, to, amount)` (same error code as the real call, `""` = ok) |

Token limits use the NEAR mandate's clock, agent, expiry, revoke, pause and `epoch`. Token usage is stamped with the epoch of the charge, so
`set_mandate` (which bumps the epoch) resets it for every token while the allowlists and caps stay. The vault never calls anything on a token
except `ft_transfer` (never `ft_transfer_call`); the wasm imports the same host functions as v1 (no key / delete / stake) and has no
upgrade export. Payout state is stored under its own key (`p:state`), not in the `Vault` struct, so v1's state layout is untouched.
New error codes (`TokenNotAllowed`, `PayeeNotAllowed`, `PerPayCap`, `BadToken`, `BadPayee`, `BadMemo`) are not in `Code::ALL` (the shared
v1 list, compared with `contracts/vault-conformance.json`); they are in `Code::PAYOUTS`. New events use `version` `1.1.0`.

Limits to know: the token's own balance is not tracked (the token rejects an over-balance transfer and the callback reverses); the vault
account must be registered on the token (`storage_deposit`) before it can receive it; the first `pay` of a token stores ~100 bytes of usage
(staked from the vault balance); the payouts wasm is ~80 KB larger than v1 (more storage staking).

```
scripts/near-vault-build.sh --payouts
cd contracts/near-vault
cargo fmt --check && cargo clippy --locked --all-targets --features payouts -- -D warnings && cargo test --locked --features payouts
```

## Upgrade strategy

**None.** There is no upgrade, migrate or arbitrary-call method (the exported method list is asserted by the integration crate). To change
behaviour: build and review the new version, deploy it to a new account, `withdraw` the old vault's funds to the owner, fund the new
vault, grant a new mandate. Deployed sub-accounts are immutable (see above). State layout is not versioned for that reason.

## Build, test, deploy

```
scripts/near-vault-build.sh      # -> contracts/near-vault/dist/autonear_vault.wasm ; stdout: {"sha256","bytes","rustc","nearSdk","cargoLockSha256","sourceSha256"}
cd contracts/near-vault
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
cd integration && cargo test      # real sandbox; needs dist wasm of vault AND registry, network for the first sandbox download
```

The build script is the registry's (`scripts/near-build.sh`) with the paths changed: `--locked`, pinned rustc 1.81.0, path remapping,
optional `wasm-tools validate --features mvp,sign-extension` when `wasm-tools` is on PATH (`WASM_TOOLS=`). Toolchain pin and the reasons
for `near-sdk =5.6.0` are the registry's (see its README). `integration/` is its own crate pinned to 1.86.0 with `near-workspaces =0.22.1`
(newer releases need rustc >= 1.93), its `Cargo.lock` was generated with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`.

`scripts/near-vault-deploy.sh` holds no keys, refuses anything but testnet, validates input and **prints** the commands (deploy+init,
fund, `allow_template` with the registry hash and owner-fixed init args, `set_mandate`) for a human to review and run:

```
VAULT_ACCOUNT=vault.you.testnet OWNER_ID=you.testnet AGENT_ID=agent.testnet scripts/near-vault-deploy.sh
```

## What was verified, and what was not

Verified (see the project report for exact output): `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`
(unit/negative tests + the conformance harness over all 12 non-EVM scenarios / 131 steps, each also asserting preview parity and
"a failing step changes nothing"); mutation spot-checks (flipping five rules made the suite fail); two builds with identical sha256 and
`wasm-tools validate --features mvp,sign-extension`; and **a real nearcore sandbox run** (`integration/`, near-sandbox 2.13.4): the
registry wasm deployed through the vault has the exact code hash and **no access keys**, `config().owner_id` is the owner's, the
agent cannot `allowlist_add` on it while the owner can, real-runtime `E_*` errors, `#[private]` (both callbacks) and non-payable guards, the
callback reversal for both a too-small deposit and a failing `new` (no sub-account left, counters and `available` restored), and the `draw` reversal when the
bound agent account has been deleted (fixture `integration/fixtures/draw_then_self_delete.wat`: a contract agent that calls `draw` and deletes itself in one receipt).

**Not proven / not done:**

* Nothing was deployed to or run on **testnet**; the printed `near` CLI commands were not executed (no CLI installed) and their syntax follows
  the registry script's near-cli-rs form, unchecked here.
* The shared conformance file runs in the in-process mock (`near-sdk` unit-testing), **not** in the sandbox; the sandbox test covers deploy / callback /
  guards / errors, not every scenario.
* The optimistic window was exercised for failed and successful batches in the sandbox, but not under concurrency (two in-flight deploys, a mandate
  replaced between `deploy`/`draw` and its callback happen only in unit tests with a hand-driven callback), not with a callback running out of gas.
* Gas and storage figures are one sandbox data point; per-template / per-name storage and the maximum wasm size accepted by a transaction are unmeasured.
* No external audit, no formal verification, no fuzzing beyond the sweep tests. The vault account's full-access key is outside the contract's control.
* Mainnet is out of scope and unreviewed. `deploy_confirmed` and the 1..=32 name range are choices where the spec/brief left room.
