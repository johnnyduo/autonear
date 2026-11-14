# Owner app redesign: one landing, four pages, a living scene

Status: draft for approval (2026-11-06). Deadline for the hackathon entry is 2026-11-14.

## Intent
Today the web app is an operator console: 9 menu items (Overview, Radar, Dossier, Runs, Studio, Approve, Vault, Security, Engines), source-health tables, rate limits, run ids, budget meters. It looks polished but a first-time visitor cannot tell what the product is for, where to start, or what needs them.

The product, in one sentence: **an AI agent watches NEAR hackathon and ecosystem signals, prepares actions, and spends from its own small gas vault only inside limits the owner set; the owner approves each action (Manual) or lets it run inside the limits (Auto).**

The user is a web2/web3 client, not an engineer. The hard parts (ingestion, scoring, circuit breakers, chain adapters, calldata) stay behind the scenes. The front must be understood in five seconds, and must also look like a winning entry: futuristic, animated, interactive, backed by real contracts.

## Goals
1. **Landing (1 page)**: what it is in one sentence, how it works in 3 steps, live proof strip (real numbers from `/api/status`), one button: Connect wallet.
2. **App (4 pages + 1 drawer)**, full-width, no sidebar of 9 items:
   - **Home**: one plain sentence of state ("Watching 9 sources. Nothing needs you." / "1 action waits for you"), the Manual/Auto switch, gas meter with "refills itself within your limit", the live scene.
   - **Approvals**: pending agent actions as plain cards: what it will do, why (one line of evidence), cost, Approve / Reject. History below.
   - **Watch**: what the agent hunts. Owner adds/removes keywords, topics, hackathon names, toggles sources; sees the latest findings per topic and can steer ("more of this", "ignore this").
   - **Vault**: balance, agent gas, limits (per action, per day, expiry), emergency stop, owner withdraw.
   - **Activity (drawer, not a page)**: human-language timeline; each row expands to technical detail (run, evidence, hashes, tx link). Source health, runs, security posture, engines live here, not in the menu.
3. **Auto/Manual is real**, not cosmetic: it maps to on-chain state and the autonomy loop (see Contract mapping).
4. **Gas refill is real**: when agent gas is below threshold, the autonomy loop draws from the vault (existing `draw`), shown as a visible refill in the scene and one line in Activity.
5. **Signature visual ("The Leash")**: the existing constellation scene (uncommitted WIP in `web/src/views/constellation/`) becomes the Home centrepiece: sources orbit and pulse inbound; the agent core sits inside a boundary ring that is the owner's limit; an action the agent proposes travels as a beam to the ring; inside limits in Auto it passes and lands, otherwise it stops at the gate and waits for a hold-to-approve. Gas is a ring meter around the core. Pause freezes and dims the scene. Hover any node for a plain sentence about what it contributed.
6. **Hold-to-approve**: Approve is a press-and-hold (about 0.8 s) ring fill, so a stray tap cannot approve; keyboard equivalent exists.
7. **Plain language everywhere**: a copy deck replaces jargon (mandate -> "limits", dossier -> "finding", run -> "check", circuit open -> "paused, retrying", decision -> "request"). Every screen answers: what is this, what should I do, what happens next.
8. **Wallet-first sign-in**: the owner proves ownership by signing a message with the connected wallet; no operator token paste for owners. The operator token path remains for the CLI/ops.

## Non-goals
- No new chain features, no mainnet, no new contracts. Testnet only, labelled as such in the UI.
- No claim of audit, independent verification, or live deployments that do not exist. Fixture or unavailable data is labelled as such (for example the 1Click quote is unavailable without a JWT).
- No redesign of the backend ingestion/scoring beyond the Watch settings it needs.
- Not rebuilding Studio/Run Theater/Dossier internals: they become deep links reachable from Activity and finding cards.

## Anti-goals (failure even if it technically works)
- More than 4 pages plus Activity, or any page whose first screen needs explaining.
- Spectacle that hides state: if the scene and the text disagree, the text is right and the scene is wrong.
- Jargon, hex strings, or ids on a primary surface.
- A WebGL-only experience: need 2D fallback (exists: `render-2d.js`), `prefers-reduced-motion`, mobile 360 px, keyboard and screen reader paths.
- Performance regression: initial bundle must not grow beyond a small budget; wallet and scene code are lazy.

## Contract mapping (what each control means on chain; verify against `docs/agent-vault-spec.md`)
- **Limits** = the vault mandate (`perDrawCap`, `periodCap`, `periodSecs`, `totalCap`, `maxDeploys`, `expiresAt`). Changing limits is an owner transaction (existing `mandates/propose` + `plan` flow), shown as "Update limits", never as calldata.
- **Auto** = the owner has granted an active mandate and the autonomy loop is running: the agent may draw/deploy allowlisted templates inside the limits without asking.
- **Manual** = the loop prepares requests and stops; each becomes an Approval the owner signs/approves.
- **Emergency stop** = vault pause (owner tx) plus loop pause and the kill switch.
- **Gas refill** = `draw` to the agent's pre-bound address, bounded by the limits.
- **Agent identity** = ERC-8004 registration (Draft) shown as a small "Agent ID" chip only when `AGENT_PUBLIC_URL` is set.

## Constraints
- Reuse the existing API and Vite/React 19 app, hash routing, design tokens in `web/src/styles.css`. Existing deep routes (`#/run/:id`, `#/opportunity/:id`, `#/approval`, `#/vault`) keep working or redirect.
- Wallet config today is EVM injected only (`web/src/wallet/config.js`). NEAR wallet support is an open decision (below).
- Read endpoints are public; every mutation needs an operator token today. The wallet-signature session is new server code and must be covered by tests and a review.

## Delivery stages (each ends with the app working and screenshots)
1. **Shell**: landing, 4-page shell, Activity drawer, copy deck, old routes redirected, menu reduced.
2. **Home + Approvals**: status sentence, Manual/Auto switch, gas meter, Leash scene wired to real data, hold-to-approve.
3. **Watch + Vault + wallet sign-in**: owner keyword/source settings (new small API + tests), limits editor, emergency stop, signature session.
4. **Polish and proof**: motion, reduced-motion, 360/768/1440 screenshots, accessibility pass, bundle check, model review and fixes, PROGRESS.md and README updated honestly.

## Decisions I made (say if you disagree)
- UI name for the mandate is **Limits**; the metaphor name "Leash" is used only in the scene and landing copy.
- Four pages: Home, Approvals, Watch, Vault. Activity is a drawer opened from the top bar.
- Owner sign-in is a wallet-signed challenge that yields a short-lived session; operator token stays as fallback.
- Hash routing stays.
- **Manual/Auto is a server-side autonomy mode, not a chain transaction.** Flipping it never needs a wallet popup and never changes the on-chain mandate. Auto: the loop acts (draw, allowlisted deploy) inside the on-chain limits without asking. Manual: the loop prepares requests and stops; each becomes an Approval. Correction found while reading `src/autonomy.js` (2026-11-06): today the loop only draws gas inside a deploy (rule g: exactly 3x the deploy fee, never more) and only acts on pending `deploy_testnet` decisions; Manual does not exist yet. So: Manual = the loop does nothing and leaves decisions to the owner (kv `autonomy.mode`, default `manual`). A standalone **gas top-up** is a NEW loop rule (j), Auto mode only: when the agent balance is below a low-water mark, one bounded `draw` (never above remaining period/total budget or per-draw cap), parity-checked and ledgered like any other draw. It is the one change to the audited loop and gets its own tests and Codex review.
- **Who signs what.** Approve/reject reuses the existing decision flow (server record, then the agent signer executes). The owner's wallet signs only owner transactions: update limits, emergency stop on chain, withdraw. These render the existing `plan` steps as plain-language steps with a send button where `TxSender` supports the chain; otherwise the CLI step is shown plainly. No new per-chain transaction builder.
- **Single owner per deployment.** The connected wallet gets write access only if it equals the vault owner (or is the configured owner address). Anyone else gets a read-only view. Watch settings are global to the deployment and owner-only. The wallet session covers approve, reject, loop pause/resume, kill switch and Watch edits; attaching a vault and proposing limits stay on the plan flow. The operator token remains for CLI/ops.
- **Honest demo mode.** The hosted site cannot run the autonomy loop (`signingSupported:false` on Workers/Vercel; only ingestion runs). When there is no live vault or loop, the scene and Approvals run on the existing labelled fixture (`web/src/mock/vaultFixture.js`) under a visible "Demo data" badge; real ingestion numbers stay real. Nothing says "live" that is not.

## Decisions by the owner (2026-11-06)
1. **Wallet and home chain: EVM first, NEAR as an add-on.** Sign-in and owner transactions use the existing EVM injected wallets; the default vault is an EVM testnet vault. NEAR vaults are shown read-only on Home/Vault. A NEAR wallet selector (NEP-413 sign-in) is a stretch item for stage 4 only if time remains.
2. **Live vault: yes.** The owner will fund a testnet vault and run the autonomy loop themselves (local machine or small host). The hosted/demo build still falls back to labelled "Demo data" when no live vault is reachable, so judges never see an empty or fake-live screen.

(Resolved above: the connected wallet writes only if it is the vault owner.)

## Left to the builder
Component structure, motion details and easing, exact copy within the deck rules, the Watch API shape, scene performance tuning, how existing CSS is pruned.
