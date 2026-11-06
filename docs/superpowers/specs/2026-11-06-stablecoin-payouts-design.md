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

## Stage 2: seed a product's pool, then hand the product over
**Seeding.** New vault method `fund_product(product, token, amount)`: `product` must be a sub-account this vault created in `deploy` (the vault records name -> template id), the token must be allowlisted, and the amount counts against the same token limits as `pay`. The vault sends `ft_transfer` to the product; what the product does with it is the behaviour of the template the owner approved. The agent never calls the product directly with the vault's money.

**Handover (only for that proposal).** A small per-proposal contract `proposal-claim` (new template, deployed by the vault like the registry) becomes the *owner* of the product at birth (the product's init arguments name the claim contract as owner; today's registry already takes `owner_id` as an init argument). The claim contract can do exactly one thing: move that product's ownership once.
- Owner path: the vault owner can hand the product to themselves at any time (`claim_to_owner`).
- Vote path: the owner opens a claim window for the proposal. Anyone may **lock NEAR** in the claim contract for the window plus a lock period. When the window ends, the highest lock above a minimum, from at least N distinct accounts, may call `finalize`. After a timelock in which the vault owner can veto, ownership moves to the winner. Locks are refunded after the lock period; nothing is slashed.
- Scope limits: the claim contract holds only locks, never the pool's money. The winner gets the product (and what is in it), never the vault, the mandate or other proposals.

**Why guards.** "Highest stake wins" taken literally lets one large holder take a funded product for the price of a refundable lock. So: a time-locked stake, a minimum number of distinct stakers, a cap per account, and the owner's veto during the timelock. The vote is on NEAR locked in this contract, not on delegation in a staking pool, because a contract cannot cheaply read a staking-pool balance. (Whether NEAR's own governance staking could be read instead was not checked.)

**What this adds.** Two new Rust contracts (`proposal-claim`, and a minimal seeded pool template to demonstrate it, which is the only part that needs product logic), two vault methods (`fund_product`, product registry), conformance and e2e for the handover, and UI for the claim window. It is the largest part and is built last.

## Phases and fit to the deadline
1. Mock token + vault v1.1 (`pay`, tokens, payees) + Rust tests + conformance.
2. Backend: model, adapter, policy, decisions, loop rule (l), sandbox e2e.
3. App changes, testnet deployment of the new vault and token, live run, docs.
4. Stage 2, only if phases 1 to 3 are verified and there is time: `fund_product`, owner handover, then the vote handover. Cut order if time runs out: vote handover first, then the demo pool, then `fund_product`.
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
