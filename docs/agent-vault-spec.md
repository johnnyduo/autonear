# Mandate Vault v1: cross-protocol spec ("agent has its own gas, inside a leash")

One state machine, two native implementations (NEAR Rust, EVM Solidity), plus a JS reference model, all
checked against ONE shared conformance file: `contracts/vault-conformance.json`. That file is what makes the
two chains **interchangeable**: same ops, same limits, same error codes, same observable state.

Testnet only. Mainnet stays blocked in the backend (`DECISION_LIMITS`) and is not claimed anywhere.

## What it is
A vault that holds testnet gas money for an autonomous agent and lets the agent do exactly two things:

1. `draw(amount)`: pull gas money to **its own pre-bound address/account only**, inside a budget.
2. `deploy(template, salt|name, code)`: deploy an **owner-allowlisted template** (exact bytecode / exact wasm
   hash, with **init arguments fixed by the owner at allowlist time**), inside the same budget.

The agent can never: change config, widen its budget, send funds anywhere else, deploy unlisted code,
pick init arguments (so it cannot choose who owns a deployed registry), upgrade, or withdraw.
The owner can always: revoke, pause, withdraw (to the owner address only), replace the mandate. Owner funds are never trapped.

## Why this design (and what it replaces)
- ERC-8004 is an identity/reputation/validation registry (Draft), not a wallet or spending standard. It is used only
  as an optional EVM **identity** layer (`src/identity/erc8004.js`), clearly labelled Draft.
- ERC-4337/7579/7710/7715 give EVM-only session keys, need a bundler/EntryPoint or an experimental wallet, and have no
  NEAR equivalent. A native vault with a shared conformance suite is the most stable, chain-uniform option and the
  easiest to test end to end. (Account-abstraction adapters can be added behind the same `AgentWallet` interface later.)
- NEAR function-call access keys cannot deploy contracts (deploy needs a full-access key), so on NEAR the **vault
  contract itself** creates the sub-account and deploys the code via a promise batch. The sub-account gets **no keys**:
  nobody, including the agent, can ever redeploy it. (Therefore leftover deposit in it is unrecoverable: it is charged to the budget.)

## Roles
- `owner`: human (should be a multisig). Two-step transfer. Everything privileged.
- `agent`: bound inside the active mandate. Only `draw` and `deploy`.
- anyone: may `deposit` (EVM: plain transfer; NEAR: `deposit()` payable or plain transfer) — gifts only.

## State
```
Config   { owner, pending_owner?, paused, network_id, epoch }
Mandate  { agent, expires_at, per_draw_cap, period_secs, period_cap, total_cap, max_deploys, revoked, start }  // at most one
Usage    { total_spent, period_index, period_spent, deploys }     // reset to zero when a new mandate is set (epoch++)
Template { id, label, deposit }   // allowlisted by owner. deposit = value forwarded to the new contract (NEAR storage; EVM must be 0)
```
All amounts are unsigned integers in the chain's base unit (wei / yoctoNEAR), conformance uses abstract units. Time is **seconds**
(EVM `block.timestamp`; NEAR `block_timestamp / 1e9`).

`active(now)` = mandate exists && !revoked && now < expires_at.
`period_index(now)` = floor((now - start) / period_secs). When it differs from `Usage.period_index`, `period_spent` is treated as 0 and re-based on the next spend.
**Spend** = a draw amount, or a deploy's template `deposit`. Both consume the same budget (per_draw_cap applies to draws only).

## Operations and rules (all revert with the named error code; first failing rule in this order wins)
Owner ops (caller must be owner else `Unauthorized`):
- `set_mandate(agent, expires_at, per_draw_cap, period_secs, period_cap, total_cap, max_deploys)`:
  agent != zero/empty; `now < expires_at <= now + 30d` else `BadMandate`; `0 < per_draw_cap <= period_cap <= total_cap` else `BadMandate`;
  `60 <= period_secs <= 30d`; `0 <= max_deploys <= 1000` (0 = draw-only mandate), all else `BadMandate`. Replaces any mandate (also a revoked/expired one), `epoch += 1`, usage reset, `start = now`. Allowed while paused.
- `revoke()`: sets `revoked = true` (idempotent; no mandate => `NoMandate`).
- `pause()` / `unpause()`: blocks agent ops only (`Paused`). Owner ops still work.
- `allow_template(template_id, label, deposit, [init material])`: EVM: `template_id = keccak256(initcode)` (initcode includes constructor args, so args are fixed by the owner). NEAR: `template_id = sha256(wasm)` hex; `init_args` (JSON, ≤ 1 KiB) and `init_gas` stored with the template; `deposit` is the storage money forwarded. label ≤ 64 bytes. Re-allowing an existing id updates it. EVM: `deposit` must be 0 else `BadTemplate`.
- `disallow_template(template_id)`; unknown => `TemplateNotAllowed`.
- `withdraw(amount)`: sends to **owner only**; `0 < amount <= available` else `BadAmount`/`InsufficientBalance`. Works while paused/revoked/expired.
- `transfer_ownership(new)` (zero/self => `BadOwner`), `accept_ownership()` by `pending_owner` else `Unauthorized`.

Agent ops, checked in this order: `NoMandate` (no mandate exists, for any caller) -> `Unauthorized` (caller != `mandate.agent`) ->
`Paused` -> `MandateInactive` (revoked or expired) -> op-specific:
- `draw(amount)`: `amount == 0` => `BadAmount`; `amount > per_draw_cap` => `PerDrawCap`; period: `period_spent' = (same period ? period_spent : 0) + amount > period_cap` => `PeriodCap`;
  `total_spent + amount > total_cap` => `TotalCap`; `amount > available` => `InsufficientBalance`. Effects before transfer; transfer goes to `mandate.agent` only. Emits `Drawn`.
- `deploy(template, salt|name, code)`: template not allowlisted => `TemplateNotAllowed`; code hash != template id => `CodeMismatch`; `deploys >= max_deploys` => `DeployLimit`;
  spend rules as above using `template.deposit` (PeriodCap/TotalCap/InsufficientBalance; no per-draw cap); target address/account already used => `AddressTaken`; invalid name => `BadName`.
  Effects first (counters), then create. Emits `Deployed(template, target, ...)`.
  NEAR only: the deploy is asynchronous; a callback `on_deployed` reverses the counters/spend if the batch failed (emits `DeployFailed`). Document the window in the README.
  EVM: `CREATE2(salt, initcode)` from the vault; if it fails the whole tx reverts.

`available` = EVM `address(this).balance`; NEAR `account_balance - storage_cost(storage_usage) - 1 NEAR reserve` (floored at 0).
Views: `config()`, `mandate()`, `usage()`, `template(id)`, `templates(from,limit)`, `available()`, `period_state(now)`, `preview_draw(amount)` and `preview_deploy(template, name_or_salt)` returning the error code the call would hit (empty = ok), so the backend and UI never guess. Previews assume the caller is the bound agent and the current time; they never mutate.
Events: every mutation (EVM indexed events; NEAR NEP-297 `{"standard":"autonear_vault","version":"1.0.0",...}`).

## Error codes (identical across all three implementations)
`Unauthorized Paused NoMandate MandateInactive BadMandate BadAmount PerDrawCap PeriodCap TotalCap InsufficientBalance DeployLimit TemplateNotAllowed CodeMismatch AddressTaken BadName BadTemplate BadOwner`
EVM: custom errors with exactly these names. NEAR: panic message starting `E_<Code>` (e.g. `E_PerDrawCap: ...`). JS model: `VaultError.code`.

## Non-negotiables
- No external calls except: EVM `draw`/`withdraw` value sends (nonReentrant, CEI) and `CREATE2`; NEAR promises to the agent/owner/sub-account only.
- No upgrade path, no delegatecall, no selfdestruct, no arbitrary call. State the upgrade strategy (redeploy + owner `withdraw`) in the README.
- Ownership of deployed registries comes from the template's fixed init material, never from the agent.
- Gas for the agent's own calls is paid by the agent address; `draw` is how it is funded.

## Conformance suite
`contracts/vault-conformance.json`: ordered scenarios. Each implementation ships a harness that executes every step and asserts
`expect` (`"ok"` or `{"err":"Code"}`) and optional `state` (a subset of: `available`, `total_spent`, `period_spent`, `deploys`, `epoch`, `paused`, `revoked`, `agent_received`).
Abstract names: roles `owner|agent|other|newOwner`; templates `t1..tN` are mapped by the harness to real artifacts (EVM: tiny initcode fixtures; NEAR: tiny wasm fixtures; deposit comes from the scenario); `salt`/`name` strings are mapped to bytes32 / valid account names.
Time `t` is absolute seconds, set before each step (EVM `vm.warp`; NEAR test context; model: argument).
A scenario passing on one chain but not another is a bug in the chain implementation, never an excuse to edit the scenario (change the spec first, then all three).

## Backend contract (phase 2)
`src/vault-model.js` (pure JS reference; used to pre-flight every agent transaction), `src/agent/*` (keys, signers, tx builders),
`src/vault.js` (on-chain readers/verifiers), `src/autonomy.js` (the loop). New decision action `grant_mandate`; deploy decisions may be
executed by the agent only under a verified, active mandate (see PROGRESS.md for status). Endpoints (read public, mutations operator-token):
`GET /api/vault` (per chain: address, on-chain mandate, usage, available, templates, ledger, loop state, last error), `GET /api/vault/ledger`,
`POST /api/vault/loop/{pause,resume}`, `POST /api/vault/mandates/propose` (creates a pending `grant_mandate` decision),
`POST /api/vault/attach` (records vault address after verifying code + config on-chain), `GET /.well-known/agent-registration.json`.
