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

NEAR sub-account `name`: 1..=32 chars of `a-z 0-9 - _`, separators only between alphanumerics, no dots; else `BadName`.
Template `label` > 64 bytes, or NEAR `init_args` > 1 KiB => `BadTemplate`. The conformance state key for funds sent out is `received: {role: n}` (a role that never received reads 0).
Check order inside `deploy`: TemplateNotAllowed, CodeMismatch, DeployLimit, PeriodCap, TotalCap, InsufficientBalance, AddressTaken, BadName.

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
NEAR harness: abstract balance units are scaled (1 unit = 1e21 yocto) and the mocked account balance is `abstract + storage_cost + 1 NEAR reserve`, so `available` equals the abstract number. Scenarios tagged `"only":"near"|"evm"` run on that chain only.
Time `t` is absolute seconds, set before each step (EVM `vm.warp`; NEAR test context; model: argument).
A scenario passing on one chain but not another is a bug in the chain implementation, never an excuse to edit the scenario (change the spec first, then all three).

## Backend contract (phase 2)
`src/vault-model.js` (pure JS reference; used to pre-flight every agent transaction), `src/agent/*` (keys, signers, tx builders),
`src/vault.js` (on-chain readers/verifiers), `src/autonomy.js` (the loop). New decision action `grant_mandate`; deploy decisions may be
executed by the agent only under a verified, active mandate (see PROGRESS.md for status). Endpoints (read public, mutations operator-token):
`GET /api/vault` (per chain: address, on-chain mandate, usage, available, templates, ledger, loop state, last error), `GET /api/vault/ledger`,
`POST /api/vault/loop/{pause,resume}`, `POST /api/vault/mandates/propose` (creates a pending `grant_mandate` decision),
`POST /api/vault/attach` (records vault address after verifying code + config on-chain), `GET /.well-known/agent-registration.json`.

---

# Phase 2: backend service, autonomy loop, API, UI (binding interface for the agents building it)

## Chain adapter interface (`src/vault/evm.js`, `src/vault/near.js`; same shape, selected by `findNetwork(chainId).protocol`)
```js
export const adapter = {
  chain: 'evm' | 'near',
  unit: { symbol: 'ETH'|'NEAR', base: 'wei'|'yoctoNEAR', decimals: 18|24 },
  // read-only, via src/chains/common.js jsonRpc, fetchImpl injectable
  async readState({ net, vault, now }),   // -> { config:{owner,pendingOwner,paused,networkId,epoch}, mandate|null, usage:{totalSpent,periodSpent,deploys,periodIndex}, available, templates:[{id,label,deposit}], agentBalance, blockTime }
  async verifyVaultCode({ net, vault, attested }), // -> { ok, checks:[{name,ok,detail}] }  runtime code / code hash == attested AgentVault build
  expectedTemplate({ manifest, payload, vault }),   // -> { templateId, code(Uint8Array), label, deposit, initMaterial } computed LOCALLY from the attested registry artifact + approved decision payload
  buildCall(kind /* 'draw'|'deploy' */, { vault, amount, template, code, nameOrSalt }), // -> callSpec for src/agent signer { method, target, args }
  async verifyDeploy({ net, txHash, vault, agent, decision, manifest, expected }), // -> { ok, account, checks }  receipt-level proof the VAULT deployed exactly the attested code at the right place with the approved owner/proposer
  explorerTx(net, txHash), explorerAddress(net, addr),
};
```
## Schema v3 (new tables only; `SCHEMA_V3` in src/db.js + generated `migrations/0003_vault.sql`; never alter existing tables)
`vaults(id, chain_id, address, owner, agent, attested_ref, status, mandate_decision_id, created_at, last_state TEXT, last_read_at)`;
`vault_ledger(id INTEGER PK, vault_id, time, kind, decision_id, tx_hash, amount, status, detail, prev_hash UNIQUE, hash)` (hash-chained like `audit`);
`mandate_runs(decision_id PK, vault_id, epoch, tx_hash, status, created_at)` (one agent execution per decision).
## Decisions
New action `grant_mandate` (testnet only, human approval flow identical to `deploy_testnet`: nonce, payloadHash, typed phrase, bound signer = the human owner). Payload:
`{ kind:'grant_mandate', vault:{chainId,address,owner}, agent:{address|account}, mandate:{expiresAt,perDrawCap,periodSecs,periodCap,totalCap,maxDeploys}, templates:[{artifactHash,templateId,label,deposit,initMaterial}], fund:{amount}, loop:{maxPerDay} }`.
`DECISION_LIMITS` gets a per-action spend ceiling (grant_mandate: total cap <= env `VAULT_MAX_TOTAL_CAP`, hard default 0.5 ETH-testnet / 20 NEAR, never above a compiled-in maximum) — checked in code, not by prompt.
Approval of a `grant_mandate` is NOT activation: the human then signs the on-chain `setMandate/allowTemplate/deposit` (or NEAR CLI equivalents); the server activates the loop for that vault ONLY after `readState` equals the approved payload field by field (`verifyMandate`).
## Autonomy loop (`src/autonomy.js`; Node runtime only, called from the scheduler tick and `npm run agent:loop`)
Per tick, for each active vault: (1) kill switch / loop paused / mainnet => stop. (2) `readState` + `verifyVaultCode`; the JS `VaultModel` is rebuilt from chain state and its `preview_*` must equal the chain's `preview_*`, else anomaly => loop `blocked` (operator must resume). (3) Select pending `deploy_testnet` decisions for this chain whose attested artifact maps to an on-chain allowlisted template (templateId recomputed locally via `expectedTemplate`; mismatch => leave the decision for a human, never auto-approve), not expired, `bound_signer` unset, under `loop.maxPerDay`, one deploy in flight at most. (4) `approveUnderMandate(db, id, {vault})`: re-runs every `approveDecision` check except the human-only ones, sets approver `mandate:<vaultId>:<epoch>`, bound_signer = vault address, audits it, inserts `mandate_runs`. (5) If the agent balance < 3x estimated fee: `draw` the minimum needed (model + chain preview ok) and wait for the receipt. (6) `deploy` via the signer with `limits`; wait for receipt/finality. (7) `recordDeployment` through the vault path: `adapter.verifyDeploy`, then the same atomic claim as today. (8) Every step appends to `vault_ledger`. Any failed check, RPC error, or mismatch refuses, ledgers `refused`, and (for integrity mismatches) sets loop `blocked`.
The loop never: changes config, requests a larger budget, touches mainnet, runs when paused, runs on the Worker runtime (`signingSupported:false`), or logs key material.
## HTTP API (reads public; mutations need operator token; amounts are decimal strings in base units)
- `GET /api/vault` -> `{ enabled, signingSupported, loop:{state:'running'|'paused'|'blocked'|'idle', lastTickAt, lastError, usedToday, maxPerDay}, agent:{evm:{address}|null, near:{account,publicKey}|null}, vaults:[{ id, chainId, network, address, owner, paused, codeOk, mandate:{agent,expiresAt,perDrawCap,periodSecs,periodCap,totalCap,maxDeploys,revoked,epoch}|null, usage:{totalSpent,periodSpent,deploys,periodResetsAt}, budget:{maxDraw,remainingPeriod,remainingTotal,remainingDeploys,blocked}, available, agentBalance, unit:{symbol,base,decimals}, templates:[{id,label,deposit,artifactHash|null,matches}], readAt, readError|null, mandateDecisionId|null }], health:[{name,ok,detail}] }`
- `GET /api/vault/ledger?limit=` -> `{ items:[{id,time,vaultId,kind:'draw'|'deploy'|'pay'|'refused'|'anomaly'|'activate'|'loop',decisionId,txHash,explorerUrl,amount,status:'confirmed'|'failed'|'refused',detail,hash,prevHash}], chainOk }`
- `POST /api/vault/loop/pause|resume`; `POST /api/vault/mandates/propose` (creates the pending `grant_mandate` decision, returns it); `POST /api/vault/attach` ({chainId,address}: verifies code + config on-chain, stores the vault); `GET /api/vault/plan?decisionId=` -> `{ steps:[{who:'human'|'agent'|'server', title, note, tx?:{to,data,value,chainId}, cli?:string}] }` (exact calldata/CLI for the human to sign; EVM calldata built with the ABI from contracts/evm/dist/AgentVault.json); `GET /.well-known/agent-registration.json` (ERC-8004 registration file from src/identity, only when `AGENT_PUBLIC_URL` is set).
- `GET /api/status` gains `vault:{loop, vaults:n, activeMandates:n}`.


## Autonomy mode and gas top-up (rule j), added 2026-11-06
- `kv autonomy.mode` = `manual` (DEFAULT) or `auto`; `GET /api/autonomy`, `PUT /api/autonomy/mode` (operator token or owner session), also in `/api/status`.
  Manual: the loop still reconciles in-flight work and then does nothing; pending `deploy_testnet` decisions wait for the owner. Auto: the loop may act inside the on-chain mandate. Flipping the mode is server state only, never a transaction; the chain limits are the real bound.
- Rule (j), Auto only: when the agent balance is below the low-water mark (`AUTONOMY_TOPUP_LOW`, default 0.003 EVM native / 0.5 NEAR), one bounded `draw` to the agent's own address up to `AUTONOMY_TOPUP_TARGET` (default 0.01 / 2), never above the per-draw cap or remaining period/total/available, parity-checked against the pinned chain state like every draw, ledgered as `draw` with detail `top-up…`, at most 6 per 24h per vault, under a durable claim `kv topup:<vault>` (atomic insert-or-replace-if-stale, 30 min) so a crash or a pending receipt cannot repeat it. Mode is re-checked after the claim and before signing. Local-anvil tests only (`tests/autonomy.test.js`); not exercised on a public testnet or NEAR.

## Owner-approved execution (rule k), added 2026-11-06
- Manual means "nothing happens without the owner's yes", not "nothing happens". A `deploy_testnet` decision the owner approved (NEAR only) is claimed by the loop in BOTH modes and executed through the vault under the same checks and limits as any other (rules a-h; the council gate is replaced by the owner's approval). EVM stays owner-signed.
- Record: approver `mandate:<vaultId>:<epoch>+<owner approver>`, bound signer = the vault. `approvalInfo` reports `humanApproved: true, humanSigned: false`: the owner approved, the agent signed.
- A failed attempt returns the decision to pending and unbound; the owner must approve again. One execution per decision (`mandate_runs` PK).
- Reconcile: a submitted run with no saved tx hash is released only when the chain shows the target still free; a taken or unreadable target blocks the loop (an operator records the receipt and resumes).
- `POST /api/vault/activate {decisionId}` (owner session bound to that grant, or operator): runs `activateVault`, which signs nothing, so the owner's last wallet step switches the vault on without waiting for the loop host.
- Coverage: `tests/owner-approved-execution.test.js` (state machine), `tests/autonomy.test.js` (EVM untouched in both modes; hash-less reconcile free/taken). The NEAR loop itself runs end to end in `npm run e2e:near-loop` (local nearcore sandbox, 29 checks: Manual waits, owner approval publishes, Auto publishes by itself, top-up only in Auto, kill switch). It is not part of `npm test` and has not run on a public testnet.


## Token payouts (phase 2b), added 2026-11-06
Backend half of the stablecoin payouts design (`docs/superpowers/specs/2026-11-06-stablecoin-payouts-design.md`, sections 2 and 3). It needs the **payouts build** of the NEAR vault (`autonear_vault_pay.wasm`, `config().version` 1.1.0); the v1 build and every v1 behaviour are unchanged. Testnet only, mainnet stays blocked in code.

**Grant `payouts` section** (optional; `POST /api/vault/mandates/propose` body and the stored payload):
`payouts: { tokens: [{ token, symbol, decimals, perPayCap, periodCap, totalCap, mock? }], payees: [account...], fund?: { token, amount } }`. The request carries only `token`, the three caps and `fund`; the server reads `symbol` and `decimals` from the token's own `ft_metadata` (anything the client sends for them is ignored) and sets `mock: true` for a testnet "Mock ..." token. The vault must be the payouts build (checked live by code hash), else 409. `policy.assertGrantPayload` checks: 1..8 tokens, 1..64 payees, valid NEAR account ids, no duplicates, no token that is also a payee, never the vault / `system` / zero account, `0 < perPayCap <= periodCap <= totalCap`, and a per-token ceiling in the token's own base units: `totalCap` and `fund.amount` <= `VAULT_MAX_TOKEN_TOTAL_WHOLE` whole tokens x 10^decimals (default 1000, never above the compiled-in 100000).
**Activation** (`verifyMandate`, `activateVault`): with a `payouts` section the on-chain vault must be the payouts build and its tokens (with all three caps) and payees must equal the grant field by field, in both directions (an extra token or payee on chain is a mismatch). A v1 grant (no `payouts`) on a payouts-build vault activates only while nothing is configured; a token or payee the grant never named is a mismatch. Usage is not compared (it moves). The build of record is written to `vaults.attested_ref` (the sha256 of the attested build matched by the on-chain code hash; no schema change, `buildOfAttestedRef` maps it back). `GET /api/vault` shows `build` and, for a payouts vault, `payouts: { tokens: [{ token, symbol, decimals, perPayCap, periodCap, totalCap, usage:{totalSpent,periodSpent}, remaining:{period,total,maxPayment}, balance (ft_balance_of the vault), matches }], payees: [{ account, matches }] }`. `modelFromState(state, 'near', { vaultId })` rebuilds a `VaultModel` including tokens, payees and usage (stamped with `config.epoch`) for the loop's parity check.
**Plan** (`GET /api/vault/plan`): after `set_mandate` and the NEAR funding step the owner gets `storage_deposit` (vault and each payee on each token), `allow_token`, `allow_payee`, then the token funding: for a testnet mock token a `mint` to the owner (open faucet, at most 10,000 whole tokens per call, so large amounts are several steps; it must carry a storage deposit because the mock token requires one when the receiver is not registered, and refunds the excess) followed by the owner's `ft_transfer` of `fund.amount` to the vault (1 yoctoNEAR). Other tokens get only the `ft_transfer`.
**Decision `pay_testnet`**: payload `{ action:'pay_testnet', protocol:'near', network:'near-testnet', vault, token, symbol, decimals, payee, amount (base units), memo (<= 128 bytes, may be ''), reference? }`; decision `target` = the vault, `method` = `pay`, `max_spend` = `amount`. Policy: testnet only; `amount` <= min(`PAY_MAX_PER_PAYMENT_WHOLE` (default 100) whole tokens, the token total ceiling); published in `/api/security` (`vaultLimits.tokenPayouts`). `POST /api/payments` (operator token or owner session) creates it as a pending decision after checking the vault's cached chain state (token and payee on the on-chain allowlist, amount <= the on-chain `per_pay_cap`; the chain enforces again); an identical pending request returns the existing decision. `GET /api/payments` lists requests with the verified payment. Approve and reject use the normal decision routes. `approveUnderMandate(db, id, { vault, epoch, byOwner })` accepts `pay_testnet` with the same guards as deploys plus: the payload names this vault and its activated grant approved the token, the payee and the amount.
**Verification** (`adapter.verifyPay`, `recordPayment(db, decisionId, { txHash, fetchImpl })` in `src/payments.js`): the transaction is signed by the mandate-bound agent, is one `pay` call with 0 deposit and exactly the approved token / payee / amount (and memo); nothing failed anywhere in the receipt tree; the vault emitted exactly one `paid` for them and **no `pay_failed`**; the vault -> token receipt is one `ft_transfer` (1 yocto, approved receiver and amount) that succeeded on the token; `on_paid` ran for the same values. Only then is a row written to `payments(id, decision_id UNIQUE, vault_id, token, payee, amount, tx_hash UNIQUE, status, verification, created_at)` (`SCHEMA_V4`, `migrations/0004_payments.sql`) and the decision marked `executed`; idempotent and race-safe; a failed verification (`payFailed: true` when the transfer was reversed) records nothing.
**Signer**: `pay` is in `VAULT_METHODS` (the ceiling of what can be allowed) but not in the default `allowedMethods`: a caller lists it explicitly (`['draw','deploy','pay']`, NEAR only). Target must still be the vault; args exactly `{ token, to, amount, memo? }`; default gas 100 Tgas; owner methods (`allow_token`, `withdraw_token`, ...) are refused as before.
**Rule (l), the loop runs payments (phase 2b-2)**: `src/autonomy.js` `runPayment`. Candidates: `pay_testnet` decisions that name this vault. Owner-approved ones (approved by a human, bound signer, not expired, no `mandate_runs` row) run in **both** modes; pending unbound ones only in **Auto**; the council gate does not apply. The vault must be the attested payouts build (by code hash) and its activated grant must name the token and payee, else the decision is left for the owner (ledgered once). Then, all before anything is claimed (each refusal is ledgered once with a plain reason, nothing is signed, the decision stays for the owner, other candidates still run): model-vs-chain parity on `preview_pay` at the pinned block (mismatch = anomaly + loop `blocked`, like draw/deploy), the vault code from the rules (caps, allowlists), the vault's token balance (`ft_balance_of`) against the amount, the payee registered on the token (`storage_balance_of`), the fee estimate (100 Tgas) against the compiled-in ceiling, rule (g) (one bounded gas `draw` if the agent holds less than 3x the fee). Own rolling-24h limit `AUTONOMY_MAX_PAYMENTS_PER_DAY` (default 5, hard maximum 20) that neither uses up nor is bound by the deploy limit. Then claim (`approveUnderMandate`), re-check kill switch / loop / mode (mode only for non-owner-approved) right before signing with limits `{maxFeePerTx, allowedTargets:[vault], allowedMethods:['pay']}`, save the tx hash on the run at once, and `recordPayment`:
- recorded -> ledger kind `pay` `confirmed` (amount = decimal string in the token's base units; token and payee in the detail; the free-text memo is not copied);
- `payFailed` (the token refused, the vault gave the budget back) or the vault itself rejected the call (no `paid` event and no `ft_transfer` receipt at all, so nothing moved) -> ledger `pay` `failed`, `releaseToHuman`, the loop is **not** blocked;
- receipt not visible yet / signer timeout -> the run stays `submitted` with its hash; reconcile calls `recordPayment` (never `recordDeployment`, never a second send);
- landed but does not verify -> ledger `failed`, the loop **blocks**, and the decision is **not** released (a re-approval could pay twice).
A payment of unknown fate is never released. A `submitted` run with **no** saved hash older than 30 min blocks the loop with an operator message (a pay target cannot be probed like a deploy address); so does a saved hash the node cannot show after the window. The operator closes either by recording the transaction (`POST /api/decisions/:id/receipt {txHash}`, which now routes `pay_testnet` decisions to `recordPayment`) or by rejecting the decision (reconcile then closes the run), and resuming the loop. New ledger kind `pay`. Coverage: `tests/autonomy-pay.test.js` (fake NEAR testnet, real loop and adapter), and `npm run e2e:near-pay` (local nearcore sandbox, real compiled payouts vault and mock token, the production API and signer).
**Not done in this phase**: any UI (Vault page, Approvals wording, `src/copy.js` for the `pay` ledger kind, demo fixtures); a live run on public testnet (new vault, deployed mock token). Gas of the real pay tree was measured on the sandbox only (see the e2e output): about 6.3 Tgas burnt in total against 100 Tgas attached.
