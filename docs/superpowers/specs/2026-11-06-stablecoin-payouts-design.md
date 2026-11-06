# Stablecoin payouts for the agent (USDC first), design

Status: DRAFT for the owner's approval. Nothing here is built yet. Date: 2026-11-06. Deadline for the whole project: 2026-11-14 23:59 UTC.

## Why
The vault today holds and moves only native NEAR (`draw`, `deploy`, `withdraw`; no `ft_*` anywhere in `contracts/near-vault/src/lib.rs`). NEAR is fine for gas and storage, but an agent that pays people or services needs a budget the owner can reason about in dollars. NEAR's price moves, so a NEAR cap is a poor spending limit for a payment.

## What the owner decided (2026-11-06)
- Stage 1: money flows **out only**: the owner funds the vault with a stablecoin, the agent pays allowlisted payees inside limits.
- Stage 2 (added the same day): the agent can also **seed liquidity into the pool of a product it built** (a DEX or perp product needs starting liquidity), and later that one product can be **handed over**: to the owner, or to whoever stakes more NEAR on it through a vote. Only that proposal's product, never the vault. Agent-to-agent swarm payments remain later work.
- **USDC first**, other NEP-141 tokens (USDT) later through the same allowlist, no contract change.
- On testnet: **our own mock token that anyone on testnet can mint without limit**, so circulation and end-to-end runs do not depend on a rate-limited faucet.

## Facts checked today (not assumptions)
- NEAR mainnet has native USDC (Circle) `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` and USDt `usdt.tether-token.near`, both 6 decimals (`ft_metadata` read from mainnet RPC). Circle also lists the testnet token `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (exists, supply read from testnet RPC). Circle's faucet gives 10 USDC per 24 h, too little for circulation.
- Not checked: which of USDC or USDt has more use on NEAR; whether `usdc.fakes.testnet` lets anyone mint; whether a usable DEX pool exists on testnet.

## Goals
1. Owner can fund the vault with USDC and set, on chain, who may be paid and how much (per payment, per period, total).
2. The agent can only call `ft_transfer` on an owner-allowlisted token to an owner-allowlisted payee, inside those limits, and only while the NEAR mandate is live (same agent, expiry, revoke, pause, epoch).
3. The same Manual / Auto behaviour as deploys: Manual = a payment waits for the owner's yes, then the agent sends it; Auto = the agent sends a payment request by itself, still inside the on-chain limits.
4. A failed transfer reverses the charge, exactly like `draw` does today.
5. Everything is covered by Rust tests, the shared conformance file, the JS model, and a sandbox end-to-end like `npm run e2e:near-loop`.

## Non-goals and anti-goals
- No arbitrary contract call. In stage 1 the only outbound call is `ft_transfer` to an allowlisted payee. In stage 2 tokens may also go to a **product account the vault itself deployed from an owner-allowlisted template** (code hash known), never to a third-party contract. Third-party DEX pools (Ref and others) stay out until someone reviews them.
- No change to the behaviour or events of the existing methods. The existing vault stays as it is; payouts come in a new build with its own hash and a new attestation.
- Not a claim of an audit: tests plus AI-assisted review only.
- Mainnet stays blocked in code. The mock token refuses to initialise outside testnet / local sandbox.

## Design

### 1. Mock token `contracts/near-mock-token` (new, small)
NEP-141 built on `near-contract-standards` `FungibleToken` with metadata set at init (`name`, `symbol`, `decimals`), so one build serves "Mock USDC" and later "Mock USDT". `mint(account_id, amount)` is open to anyone, with a per-call ceiling of 10,000 whole tokens, and `new` aborts unless `network_id` is `testnet` or `localnet`. Metadata name says "Mock USDC (testnet, anyone can mint)". Tests: transfer, storage registration, mint ceiling, refuses a non-test network.

### 2. Vault build v1.1 (additive; `contracts/near-vault`)
New state, all reset by `set_mandate` (a new epoch):
- `tokens: token account -> Limits { per_pay_cap, period_cap, total_cap }` and `Usage { total, period_index, period }`, with the **same** `period_secs`, expiry, agent, revoke and pause as the NEAR mandate (no second clock).
- `payees: set<AccountId>`.

New owner methods: `allow_token(token, per_pay_cap, period_cap, total_cap)`, `disallow_token(token)`, `allow_payee(account)`, `disallow_payee(account)`, `withdraw_token(token, amount)` (owner only, works while paused or revoked, like `withdraw`).

New agent method: `pay(token, to, amount, memo)`.
Checks in order: caller is the mandate agent; not paused; mandate active; token allowed; payee allowed; `0 < amount <= per_pay_cap`; period and total remaining. Then: optimistic charge, event `paid`, promise `ft_transfer(to, amount, memo)` on the token with 1 yoctoNEAR attached and a fixed gas, then the callback `on_paid`, which reverses the charge and emits `pay_failed` if the transfer failed (same shape as `on_drawn`). The agent can pay only to a payee the owner listed; it cannot pay itself unless the owner lists it.

Views: `tokens`, `payees`, `token_usage(token)`, `preview_pay(token, to, amount)` (same error codes as the real call, used for the model/chain parity check).

The vault does not need to know its own token balance: the token contract rejects an over-balance transfer and the callback reverses. The UI and backend read the balance with `ft_balance_of`. The vault account must be registered on the token (`storage_deposit`), which is one of the owner's plan steps.

New error codes: `E_TokenNotAllowed`, `E_PayeeNotAllowed`, `E_PerPayCap`, plus the existing period/total codes reused. `version` becomes `1.1.0`.

### 3. Backend
- `src/vault-model.js` and `contracts/vault-conformance.json`: payout scenarios; the same file drives Rust and JS, as today.
- `src/vault/near.js`: `buildCall('pay')`, token state in `readState`, `preview_pay`, plan steps (`allow_token`, `allow_payee`, `storage_deposit` of the vault on the token, a mock mint to the owner and the transfer into the vault), `verifyMandate` compares tokens and payees field by field like it does templates.
- New decision action `pay_testnet` `{ token, payee, amount, memo }` in `src/policy.js` (own ceiling per payment, testnet only), created by `POST /api/payments` (operator or owner session). Approvals shows "Pay 25 USDC to <payee> for <memo>" in plain words; `src/copy.js` gets the strings.
- `src/autonomy.js`: rule (l), payment execution, reusing rules (a) to (h): Manual runs only owner-approved `pay_testnet`; Auto also runs pending ones; one execution per decision; parity check before signing; reconcile on a lost hash by reading the token transfer outcome, never by re-sending.
- `src/chains/near.js`: verify the transfer receipt (token contract, receiver, amount, vault as sender) before a payment is recorded as paid.

### 4. App
Vault page: USDC balance, payout limits, payee list, "Add test USDC" (mock mint) for testnet. NearSteps gets the new owner steps. Home meter for USDC remaining. Activity shows payments with explorer links. Demo mode gets fixture payments, clearly labelled.

### 5. Verification
`cargo test` for both contracts, conformance, `npm test`, `npm run e2e:near-loop` extended (Manual waits then pays after approval, Auto pays, over-cap and unlisted payee refused, failed transfer reverses, kill switch), then one real testnet run with a new vault `vault-v2…` and the mock token. Browser run of the changed pages before any deploy.

## Stage 2: an arena of competing products, seeded pools, and who owns each product
Owner's input (2026-11-06): there may be more than one platform. The council proposes DEX1; if the trend keeps rising it may propose DEX2 for the same trend; stakers choose which they back; a latecomer can enter and ask to own one. Only that arena's products are involved, never the vault.

**Two separate questions, two separate deciders** (this is the main guard against stakers draining the vault):
- *Who gets seed money* is decided by the council plus the vault owner's approval (Manual) or the on-chain limits (Auto). Each seeding is its own `fund_product` request with its own approval.
- *Who owns (administers) a product* is decided by stakers through locked NEAR. Stakers never move the vault's money. Their lock totals are also published as evidence the council can read.

**Arena.** One arena per trend/proposal topic with: at most K products (default 4), a per-token seed budget for the whole arena (inside the vault's token limits), and one `proposal-claim` contract per product. Adding a product is a normal owner-approved deploy decision; the arena rejects a fifth.

**Seeding without gifting.** The usual hole: if ownership of a funded pool can be won, the winner can take the seed. So the seed stays the vault's. A product that accepts seed must come from a template that keeps two roles apart: `seed_owner` (the vault, can `recall` its principal after a cooldown, can never be changed by the claim contract) and `admin` (fees, parameters, listing; this is what changes hands). The vault sends tokens with `ft_transfer` to a product it deployed itself (the vault records name -> template id), and the amount counts against the same token limits as `pay`. Templates that do not keep the roles apart cannot be seeded: the vault checks the template id against an owner-allowlist of seedable templates.

**Claiming a product.** Each product has a claim contract that is its `admin` from birth and can do one thing: move that admin role once.
- Anyone may lock NEAR on one product; a staker can back only one product per arena at a time (moving needs unlock and a cooldown), so one balance is not counted twice. A late entrant is allowed.
- Weight = locked amount x min(1, lock age / lock period), so a lock made at the last minute counts for little. Per-account cap on weight. To win, a product needs a leader above a minimum weight and at least N distinct accounts.
- Anti-sniping: if the lead changes in the last hours of the window, the window extends once, up to a maximum.
- `finalize` can be called by anyone and is deterministic (ties go to the earliest lock). The result takes effect after a timelock in which the vault owner may veto; a veto is an event, not a silent switch.
- Locks are refunded after the lock period. Nothing is slashed. The claim contract never holds the pool's money and cannot call anything but the one admin transfer on its own product.
- The owner can always take the admin role back to themselves before any window opens (`claim_to_owner`), and cannot after a finalized handover except by a new product.

**Candid list of the holes this design is meant to close, and the ones it does not.**
Closed on paper (each gets a test): stakers draining the vault; the winner stealing the seed; one whale or borrowed stake buying a product (age weighting, distinct accounts, cap, veto); last-second sniping; double-counting one stake across rivals; an arena flooded with products (cap K, each needs an owner-approved deploy); a claim contract acting beyond its one transfer; stale locks stuck after a product dies (refund always possible after the lock period).
Not closed: the owner's veto is a central power (it is visible and logged, not removable in this version); a product's admin can still harm the users who put their own money into that pool, which is a risk of the product itself, so every seedable template is testnet-only and labelled; stake-weighted choice is still plutocratic by nature, softened but not removed; whether NEAR's governance staking could be read instead of a lock was not checked.

**Blocking design items before any Stage 2 contract is written** (from the independent review of 2026-11-06, a threat table kept with this document):
1. *Seed accounting.* How the vault's principal is tracked when users also deposit in the same pool: pool shares, who bears a loss, and whether the vault's recall comes first or pro rata. Without this, "seed stays the vault's" is a slogan.
2. *Admin transfer as a state machine.* States, what happens if the cross-contract call fails or is retried, so the role can never be handed over twice or end up with nobody.
3. *Pull-based refunds.* A staker must be able to reclaim a lock on their own even if the product or claim contract is dead; no refund may depend on someone else's call succeeding.
4. *Exact window rules.* What counts as a lead change, which snapshot decides, the maximum total extension, and the finalization order, written as a table with worked examples.
5. *Trust model for the veto and for stake concentration.* State who can veto what and why (criteria and the remedy), and say plainly that stake voting can be bought; borrowed stake and many-account locks (per-account caps do not stop one person using many accounts) are accepted only for a labelled testnet demo whose pool holds no real user value.

**Before any of this is built:** the Stage 2 design gets its own independent review (Codex, AI-assisted, not an audit) and a written threat table, because it is the part that holds value and changes who controls it.

**What this adds.** Contracts: `proposal-claim`, a minimal seedable pool template (the only part with product logic), vault methods `fund_product`, a seedable-template allowlist and a product registry; conformance and e2e for seed, recall, claim, veto and sniping; arena and claim windows in the app. It is the largest part and is built last.

## Phases and fit to the deadline
1. Mock token + vault v1.1 (`pay`, tokens, payees) + Rust tests + conformance.
2. Backend: model, adapter, policy, decisions, loop rule (l), sandbox e2e.
3. App changes, testnet deployment of the new vault and token, live run, docs.
4. Stage 2, only if phases 1 to 3 are verified and there is time, and only after its design review: seedable template and `fund_product`, owner path, then the arena and vote handover. Cut order if time runs out: multi-product arena first, then the vote handover, then the demo pool, then `fund_product`.
Each phase ends with passing tests and its own commit on a branch; nothing reaches `main` until its phase is verified, so production keeps working if time runs out. The cut line if time is short: phases 1 and 2 plus a command-line payment, with the UI changes dropped.

## Risks
- Contract change = new hash, new attestation, new vault funded with testnet NEAR (we hold roughly 100 NEAR across the demo accounts).
- The existing testnet vault is not upgraded (no upgrade method by design); the demo moves to `vault-v2`. Its grant has to be done again by the owner wallet (9988), which is currently blocked on Accept ownership of `vault-v1`.
- Mock mint is open: acceptable only because the token is a labelled testnet mock and cannot initialise on mainnet.

## My calls (change any of them)
- Same clock and agent for NEAR and token limits, instead of a separate token mandate.
- Open mint capped per call, rather than owner-only mint.
- Payments are decisions (`pay_testnet`) so they reuse Approvals and Manual/Auto, rather than a separate payments screen.
- A new vault build instead of changing v1 in place.
