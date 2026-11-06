# Owner App Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 9-item operator console with one landing page plus a 4-page owner app (Home, Approvals, Watch, Vault) and an Activity drawer, with a live "Leash" scene, real Manual/Auto and gas top-up, wallet-signed owner sessions.

**Architecture:** Backend gets three small additions (kv-backed `autonomy.mode`, kv-backed `watch.config`, stateless HMAC owner-session tokens from a wallet signature) plus loop rule (j) gas top-up; the Vite/React app gets a new shell and pages that reuse existing API, `ui.jsx` primitives and the wallet layer. The scene is a new compact Canvas 2D component; the existing WebGL constellation stays untouched as a deep link.

**Tech Stack:** Node 20 `node --test`, sqlite/D1 via `db`, viem (already a dependency), React 19 + Vite, wagmi (lazy), Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-11-06-owner-app-redesign-design.md`

## Global Constraints
- Testnet only; no mainnet claim, no "audit" claim; fixture data always under a visible "Demo data" badge.
- Max 4 app pages + Activity drawer; no hex/ids/jargon on primary surfaces. Copy deck in `web/src/app/copy.js` is the only source of user-facing strings for the new pages.
- Mutations need operator token OR owner session; owner session only for: decision approve/reject, loop pause/resume, kill switch pause/resume, `PUT /api/watch`, `PUT /api/autonomy/mode`, `POST /api/vault/mandates/propose` (it only creates a pending decision). Everything else (attach, ingest, receipt, artifacts, runs) stays operator-only. Contract-wallet/multisig owners cannot sign in (EOA only): the sign-in screen says so and points them to the operator token.
- Wallet and scene code stay lazy; initial JS gzip must not grow more than 25 kB over current build.
- `prefers-reduced-motion`, keyboard operation, 360/768/1440 widths.
- Existing deep routes (`#/run/:id`, `#/opportunity/:id`, `#/radar`, `#/approval`, `#/vault`, `#/security`, `#/engines`, `#/studio`) keep rendering (reachable from Activity), just not in a menu.
- Tests: `node --test tests/` must stay green; web must `npm run web:build`.

## Review Focus
- Connected wallet is not the vault owner: all write controls disabled with a plain reason, reads still work.
- Session token tampering, expiry, wrong-address signature, replayed challenge nonce: all rejected 401.
- Mode flipped to Manual mid-tick: loop must not start a new action; in-flight reconcile still completes.
- Top-up must never exceed per-draw cap/remaining budget, never run while paused/blocked/Manual, never run twice for one low reading.
- Watch config with hostile input (huge list, HTML, empty strings, duplicate keywords): bounded and sanitized.
- No live vault reachable: Home shows Demo data badge, never "live".
- Reduced motion / no WebGL / 360 px: scene and hold-to-approve still usable.

---

### Task 1: Owner session (wallet-signed, stateless)
**Files:** Create `src/owner-session.js`, `tests/owner-session.test.js`; Modify `src/app.js` (routes + `needOwner`), `src/config.js` (`OWNER_ADDRESS`, `SESSION_TTL_MS`).
**Interfaces:**
- Produces: `makeChallenge({address, now, secret}) -> {message, nonce, exp}`; `verifyOwnerSignature({address, message, signature}) -> Promise<boolean>` (viem `verifyMessage`, EOA only); `issueSession({address, now, secret, ttlMs}) -> token`; `readSession(token, {now, secret}) -> {address, exp}|null`. Token = base64url(JSON)+"."+HMAC-SHA256 (node:crypto, timingSafeEqual). Secret = HMAC(OPERATOR_TOKEN, "owner-session-v1"); no OPERATOR_TOKEN means sessions disabled. **Single authoritative owner** `resolveOwner(db) -> address|null`: `OWNER_ADDRESS` env if set, else the owner of the attached vaults when they all share one owner, else `null` (then only the operator token works). Ownership is re-resolved on EVERY request (not baked into the token), so an owner transfer or env change invalidates sessions. Challenge message (EIP-191 text) contains: app name, request host (domain), address, nonce, issuedAt, expiresAt (5 min) and the line "Sign-in only, no transaction, no cost"; the server verifies the host matches the request. Nonce consume is ONE atomic conditional write (`INSERT ... ON CONFLICT DO NOTHING` / `UPDATE ... WHERE v='fresh'` and check rows changed), never read-then-delete. `approve` with an owner session must have `signer` equal to the session address for non-mandate deploys (server enforced).
- Routes: `POST /api/auth/challenge {address}`, `POST /api/auth/session {address, message, signature}` -> `{token, exp, isOwner}`; `GET /api/auth/me` -> `{address|null, isOwner}`. `isOwner` = address equals `OWNER_ADDRESS` or the `owner` of any attached vault (case-insensitive). Non-owner sessions are issued but `needOwner` rejects them 403.
- `needOwner(req)`: passes for operator token or a valid owner-session bearer.
- [ ] Write failing tests (named): `challenge message binds address, nonce and expiry`; `rejects a signature from another key`; `rejects tampered token`; `rejects expired token`; `challenge nonce is single use`; `concurrent redemption of one nonce succeeds exactly once`; `challenge for another host is rejected`; `owner transfer invalidates an existing session`; `approve with signer != session address is rejected`; `non-owner session gets 403 on approve`; `operator token still works`. Use a viem `privateKeyToAccount` to sign.
- [ ] Run `node --test tests/owner-session.test.js`, expect FAIL.
- [ ] Implement module + routes; apply `needOwner` to the scoped routes in Global Constraints only (approve/reject at `src/app.js:205-208`, loop pause/resume `:240-241`, security pause/resume `:272-273`). Nonce store: kv table key `nonce:<n>` with expiry, deleted on use.
- [ ] Run `node --test tests/owner-session.test.js tests/api-hardening.test.js`, expect PASS.
- [ ] Commit `feat(auth): wallet-signed owner session`.

### Task 2: Autonomy mode + gas top-up rule (j)
**Files:** Modify `src/autonomy.js`, `src/app.js`, `src/config.js`, `docs/agent-vault-spec.md`; Test `tests/autonomy.test.js`.
**Interfaces:**
- Produces: `getMode(db) -> 'manual'|'auto'` (kv `autonomy.mode`, default `'manual'`), `setMode(db, mode, actor)` (audited); `GET /api/autonomy` -> `{mode, topup:{lowWater, target, lastAt}}`; `PUT /api/autonomy/mode {mode}` (needOwner). `GET /api/status` gains `autonomy:{mode}`.
- Placement: today `processVault` returns `{idle:true}` before reading chain state when there are no candidates. Restructure so the chain-state gates (read, code, mandate verify, epoch, live, paused) run BEFORE the idle return whenever mode is `auto`; mode is re-read immediately before each claim, draw and deploy (not only at tick start); `reconcile` always runs in both modes. Top-up uses a durable per-vault claim (kv `topup:<vaultId>` = {status:'claimed'|'submitted', txHash, at}) written with an atomic conditional insert, and no new top-up starts while a previous one is unreconciled; `reconcile` clears it from the receipt. The draw amount must leave the balance able to pay the next draw/deploy fee (fee estimate as in rule g); it reuses `parity` against a freshly pinned state.
- Rule (j) in `processVault`, after drift/epoch/paused gates and before candidates: if mode is `auto` and `read.agentBalance < lowWater` (default 4x `HARD_MAX_FEE_PER_TX` estimate for the protocol; override `AUTONOMY_TOPUP_LOW`), draw `min(target - balance, perDrawCap, remainingPeriod, remainingTotal)` through the existing `parity` + draw path, ledger kind `draw` detail `top-up`, at most once per vault per `AUTONOMY_TOPUP_COOLDOWN_MS` (default 10 min). Manual mode: `processVault` returns `{manual:true}` before candidates and top-up.
- [ ] Failing tests (named): `manual mode never executes a pending deploy`; `auto mode tops up when balance below low-water`; `top-up capped by per-draw cap and remaining budget`; `no top-up while paused, blocked, revoked or expired`; `top-up respects cooldown`; `no second top-up while the first is submitted and unreconciled`; `crash after claim does not repeat the draw`; `mode flipped to manual between claim and send aborts before signing`; `top-up parity mismatch blocks the loop`; `default mode is manual`.
- [ ] Run `npm run test:vault` filtered to autonomy, expect FAIL.
- [ ] Implement; keep rules (a)-(i) untouched; add rule (j) to the header comment and spec.
- [ ] Run `npm run test:vault`, expect PASS (note: needs cargo/foundry on PATH as in script).
- [ ] Commit `feat(autonomy): manual/auto mode and bounded gas top-up`.

### Task 3: Watch config (backend)
**Files:** Create `src/watch.js`, `tests/watch.test.js`; Modify `src/relevance.js` (read include/exclude), `src/ingest.js` (disable sources), `src/app.js`.
**Interfaces:**
- Produces: `getWatch(db) -> {keywords:string[], excludes:string[], sources:Record<string,boolean>, hackathons:string[]}`; `setWatch(db, cfg, actor) -> cfg` sanitizing: trim, lowercase, dedupe, max 40 items per list, each max 60 chars, strip control chars/markup; `GET /api/watch` (public), `PUT /api/watch` (needOwner). Keywords add a small ranking boost and a `watch:<kw>` tag but NEVER make a record `isNear` or lift injection/low-signal flags; excludes match on word boundaries and filter; `sources` keys must be registered connector ids (others rejected); `sources[id]===false` skips that source (status shows `disabled_by_owner`). Applied in the common path (`ingestSource`), so direct callers get it too.
- [ ] Failing tests: `sanitizes and bounds lists`; `keyword match boosts relevance and tags the record`; `exclude filters a record`; `disabled source is skipped and reported`; `non-owner PUT is 403`; `keyword cannot make a non-NEAR record near`; `unknown source id rejected`.
- [ ] Run `node --test tests/watch.test.js`, expect FAIL; implement; run `node --test tests/watch.test.js tests/ingest.test.js tests/social-hardening.test.js`, expect PASS.
- [ ] Commit `feat(watch): owner-editable keywords, excludes, source toggles`.

### Task 4: Shell, routing, copy deck, session client (frontend foundation)
**Files:** Create `web/src/app/copy.js`, `web/src/app/session.js`, `web/src/app/Shell.jsx`, `web/src/app/shell.css`; Modify `web/src/App.jsx`, `web/src/api.js` (bearer = owner session token or operator token), `web/src/main.jsx`.
**Interfaces:**
- Produces: `useOwner() -> {address, isOwner, connected, signIn(), signOut(), demo}`; `session.js` lazy-loads wagmi, signs the challenge, stores token in sessionStorage; routes `#/` (Landing when not connected, Home when connected), `#/approvals`, `#/watch`, `#/vault`; `#/activity` opens the drawer over the current page. Legacy names stay in the route table without a nav item. `copy.js` exports the jargon map and every string for new pages.
- [ ] Failing test `web/src/app/copy.test.js` via node: `no banned jargon in copy.js` (mandate, dossier, circuit, hash, epoch, calldata, ledger) and `every route has a title`.
- [ ] Implement shell: top bar = brand, 4 tabs, Activity button, wallet chip. Mobile: bottom tab bar.
- [ ] Verify: `npm run web:build` passes; manual: legacy `#/radar` and `#/run/x` still render.
- [ ] Commit `feat(web): 4-page shell, copy deck, owner session client`.

### Task 5: Landing
**Files:** Create `web/src/app/Landing.jsx`, `landing.css`.
- One sentence promise, 3 steps, live proof strip (`/api/status`: sources ok, last tick, records) with real numbers only, **two buttons: Connect wallet and Explore the demo** (demo = read-only app on labelled Demo data, no wallet needed), a concrete proof line from the real vault ledger (latest confirmed action, its limit, explorer link) when one exists, a compact autoplaying Leash scene preview (Task 6 component, `demo` prop). "Testnet" badge. No menu.
- [ ] Verify with screenshots at 360/768/1440 (Playwright/`run` skill) saved to `docs/screenshots/redesign-*.png`; no console errors.
- [ ] Commit `feat(web): landing page`.

### Task 6: Leash scene + Home
**Files:** Create `web/src/app/LeashScene.jsx`, `scene-model.js`, `Home.jsx`, `home.css`; Test `web/src/app/scene-model.test.js`.
**Interfaces:**
- `buildScene({sources, vaultReport, autonomy, pending, demo}) -> {nodes, core, ring:{fill}, gas:{pct, low}, beams}` pure function (testable): sources as orbit nodes (colour by health), ring radius from limits usage, gas from `agentBalance` vs low-water, one beam per pending request, `state: 'live'|'paused'|'demo'`.
- `<LeashScene model reducedMotion onNodeHover />`: Canvas 2D, requestAnimationFrame paused when tab hidden, static frame when reduced motion; a visually hidden text summary mirrors state.
- Home: status sentence with three distinct states ("Watching" = ingest only; "Ready to act" = vault live, loop idle; "Acting now") taken from `/api/status` + `/api/vault`, Manual/Auto switch (calls `PUT /api/autonomy/mode`, disabled with reason for non-owners), gas meter with "tops up by itself in Auto", pending card linking to Approvals, latest 3 findings.
- [ ] Failing tests: `ring fill follows usage`, `paused freezes beams`, `demo flag propagates`, `low gas flagged below low-water`, `one beam per pending request`.
- [ ] Implement; verify screenshots and a 30 s idle CPU sample is low (devtools or `performance` trace note).
- [ ] Commit `feat(web): Home with the Leash scene`.

### Task 7: Approvals with hold-to-approve
**Files:** Create `web/src/app/Approvals.jsx`, `HoldButton.jsx`, `approvals.css`; reuse `web/src/views/Approval.jsx` signing path for decisions that need the owner's wallet (lazy).
- Card: plain action sentence, one-line why, cost, expiry. `HoldButton` (pointer + Space/Enter hold 800 ms, `onComplete`, cancel on release, `aria-live` progress). Approve uses existing `POST /api/decisions/:id/approve`; decisions needing a wallet signature open the existing wallet step inline. Reject needs a click and optional reason. History list below.
- [ ] Failing test `HoldButton.test` (node + simulated timers): `does not fire before 800 ms`, `fires once at 800 ms`, `release cancels`, `keyboard hold works`.
- [ ] Verify screenshots; commit `feat(web): Approvals with hold-to-approve`.

### Task 8: Watch page
**Files:** Create `web/src/app/Watch.jsx`, `watch.css`.
- Add/remove chips for keywords, excludes, hackathons; source toggles; latest findings per topic with "more like this" (adds keyword) / "ignore" (adds exclude); saves via `PUT /api/watch`; optimistic with rollback; read-only for non-owners.
- [ ] Verify against local server; commit `feat(web): Watch page`.

### Task 9: Vault page
**Files:** Create `web/src/app/VaultPage.jsx`, `vault-page.css`; reuse `views/vault/*` helpers.
- Balance, agent gas, limits as plain sentences (per action, per day, total, expires), "Update limits" = `POST /api/vault/mandates/propose` then the existing `plan` steps rendered plainly, Emergency stop = loop pause + kill switch (owner session) plus an on-chain `pause()` wallet transaction, Owner withdraw = on-chain `withdraw` wallet transaction. On-chain owner txs for EVM use wagmi `writeContract` with the ABI in `contracts/evm/dist/AgentVault.json` (verify function names there first; add `web/src/wallet/OwnerTx.jsx`, lazy); NEAR vaults are read-only with the CLI step shown. Demo badge when fixture.
- [ ] Verify; commit `feat(web): Vault page`.

### Task 10: Activity drawer
**Files:** Create `web/src/app/Activity.jsx`; Modify `Shell.jsx`.
- `#/activity` is an overlay state (query `?activity=1` inside the hash) so Back closes it and the page underneath is preserved. Timeline from `/api/audit`-style data already used by Overview + `/api/vault/ledger` + runs, rewritten with `copy.js`; row expands to technical detail (ids, hashes, tx link); footer links to Radar, Runs, Security, Engines, Studio.
- [ ] Verify; commit `feat(web): Activity drawer`.

### Task 11: Polish and proof
- [ ] Remove dead nav code and unused Overview-only CSS; `npm run web:build`; compare bundle size to Global Constraint.
- [ ] Reduced-motion, keyboard-only walkthrough, 360/768/1440 screenshots into `docs/screenshots/`.
- [ ] `node --test tests/` green.
- [ ] Update `PROGRESS.md` (honestly: what is live vs demo) and `README.md` screenshots section.
- [ ] Commit `chore: polish, screenshots, docs`.

### Task 12: Codex deep audit
- [ ] Before Task 1: `codex exec --sandbox read-only` review of this plan and the spec; fold findings in.
- [ ] After Task 11: `codex exec --sandbox read-only` deep review of `git diff main...HEAD` focused on `owner-session`, rule (j), `watch`, auth scoping; save raw output to `docs/audit/codex-redesign-review.raw.md`, labelled AI-assisted, not an audit; fix confirmed findings, re-run tests, commit.
