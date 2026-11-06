# Handoff, 2026-11-06

Read this, then `PROGRESS.md` (claims with proof) and the project memory (`token-economy`, `autonear-project-context`, `owner-app-redesign`). Start the next session from here instead of continuing the long one.

## Where things are
- Repo: `/Library/WebServer/Documents/autonear`, branch `feat/mandate-vault-core`. `origin/main` is the same commit (last: `d69f2e1`). Push with `git push origin feat/mandate-vault-core:main` (fast-forward) and `git push origin feat/mandate-vault-core`.
- Production: Vercel project `copycatfinance/autonear`, git-connected, deploys on push to `main`. URL `https://autonear-eight.vercel.app` (also `autonear.vercel.app`). Turso (libSQL) database, region `hnd1`, ingestion cron every 15 min. A tick takes about 70 s (limit 300 s).
- Secrets (gitignored, never print): `data/vercel-operator.token`, `data/vercel-cron.secret`, `data/agent.keys.json`, `data/demo-owner.keys.json`. Manual tick: `curl https://autonear-eight.vercel.app/api/cron/tick -H "authorization: Bearer $(cat data/vercel-cron.secret)"`.
- Deadline: 14 Nov 2026 23:59 UTC. Track: AI Security & Defense (also Autonomous Business, AI Swarms). Human-owned: demo video, X post, submission form.

## Scope decisions
- NEAR testnet only. Regular EVM chains are off by default (`ENABLE_EVM=1` re-enables them for development; `npm test` sets it). Mainnet stays blocked in code.
- Wallets are EVM-style (MetaMask) through NEAR's Ethereum-wallet standard (NEP-518): a `0x…` address is a NEAR implicit account; relayer `https://eth-rpc.testnet.near.org`, chain id 398. Verified reachable.
- `rpc.mainnet.near.org` and `rpc.testnet.near.org` are deprecated (HTTP 429 "STOP USING IT NOW"). Defaults are now `rpc.mainnet.fastnear.com` and `rpc.testnet.fastnear.com`.
- The constellation is the Home page after connecting a wallet. The owner is the human in the loop; non-owner wallets see the same real data read-only. How ordinary users take part is not designed yet.

## Accounts (NEAR testnet; balances as of this handoff)
| Role | Account | NEAR |
| --- | --- | --- |
| User's wallet, app owner, pending vault owner | `0x5ebaddf71482d40044391923be1fc42938129988` (ends 9988) | 33 |
| Demo owner (automated key on the agent machine, not a human) | `autonear-owner-1106.testnet` | ~9.9 |
| Agent funder | `autonear-agent-1106.testnet` | ~9.0 |
| Agent (keystore identity) | `d1f730e4a45f61c90789bfd953ec6f247c1e15c571320a93f62a7f41621fae34` | ~5.5 |
| Vault (locked, no keys) | `vault-v1.autonear-owner-1106.testnet` | ~8.8 |
| Registry deployed through the vault | `reg1.vault-v1.autonear-owner-1106.testnet` | 3.8 |
| EVM-format accounts of the agent and demo owner | `0xd64ec57d1b48ec638b04b5716c1e888b2ffaff67`, `0x4aef87e3001efb67114944bc2cf319ddf40cbc4b` | 8.1 and 9.7 |
| Spare funds (same key as the agent) | `autonear-fund-1106-d`, `-e`, `-f`, `-g` `.testnet` | 4.8, 6.5, 6.3, 2.0 |

The vault's `pending_owner` is the user's `0x…9988`. It becomes the owner only when that account calls `accept_ownership`. The mandate on the vault is revoked (end of the test run).

## Done and live
- Mandate Vault (NEAR Rust, plus the Solidity version kept but off), JS model, conformance suite, agent signers, autonomy loop (Node host only).
- Public NEAR testnet run with 14 transactions: `docs/testnet/near-testnet-v1.json` (owner side signed by the demo key, disclosed). The two script-side FAIL entries are kept and explained there.
- Owner app (landing, Home = constellation, Approvals, Watch, Vault, Activity), wallet-signed sessions, `OWNER_ADDRESSES` co-owners (set on Vercel to the 9988 address).
- Constellation: animated HUD, source-to-topic ribbons, provenance cards (a tour of stored records, not live events), full screen at `#/constellation`, technical overview at `#/dashboard`.
- Sources: GitHub, gov forum, Hacker News, NEAR RPC, NEAR Social, Mastodon, Farcaster, Dev.to, plus DefiLlama, NearBlocks, Sputnik DAO, near.org feed (all verified live 2026-11-06, in PROGRESS.md). Bluesky needs `BLUESKY_HANDLE` and an app password.
- NEAR vault attached to the production backend (`POST /api/vault/attach`), so Home shows a NEAR vault and fuel in NEAR.
- Tests: `npm test` 375 (372 pass, 3 skipped), `npm run test:web` 15, `npm run test:near-only`.

## Done since (2026-11-06, commit 4c19720, live)
- MetaMask signs NEAR owner transactions (NEP-518), implemented directly with viem in `web/src/wallet/nearEth.js` (the wallet-selector package needs wagmi 2; the app has 3). Vault page: Accept ownership (when the connected wallet is the pending owner), Pause/Un-pause, Switch the limits off, Take it back. Approvals: `NearSteps` lists the grant steps, one signature each.
- Proof: testnet run on scratch vaults with 9/9 checks (`web/src/wallet/e2e-near-eth.e2e1.evidence.json`) and a browser run on the real app. Both were signed by a TEST key through an injected provider, not by a human MetaMask. Not yet verified: MetaMask's own prompts (adding the network, 18-decimal fees), and `NearSteps` on a real `grant_mandate` decision.
- First real proof for the user: connect MetaMask (0x...9988), open Vault on `vault-v1.autonear-owner-1106.testnet`, click Accept ownership, approve the network add, the one-time setup tx, then the real tx.

## Open work, in order
1. The user clicks Accept ownership with the 9988 wallet and reports what MetaMask shows; fix whatever breaks. Then try a real `grant_mandate` through `NearSteps`.
2. DONE 2026-11-06: Gemini is live on production (`LLM_PROVIDER=gemini`, model `gemini-3.1-flash-lite`); Bluesky is configured. A real run (`run_2943ba6692ff`) went through all stages and created pending decision `dec_5128411b07596b` (`deploy_testnet`, owner and proposer `0x5eba…9988`, contract account `autonear-registry-1106.testnet`, estimate 2.108 NEAR). Contract build attested with `npm run attest -- near --post` (84 tests, commit marked `+dirty` because the tree had other edits). The skeptic's LLM challenge was rejected once for a schema violation (too-long field) and the deterministic skeptic was used; that is recorded in the run. Starting a run needs `OPERATOR_TOKEN`: the new value is in `data/operator.token` (same value set on Vercel). Pass `owner` and `contractAccount` in the POST body or no decision is created.
3. DONE 2026-11-06: the 14 recorded transactions are in Activity ("Recorded run on NEAR testnet", data in `web/src/app/testnetRun.json`, trimmed from `docs/testnet/near-testnet-v1.json`).
4. More independent non-social demand sources (every opportunity still says `LOW CONFIDENCE: only 2 independent non-social sources`); `data_indexing` and `ai_agents` have no on-chain corroboration.
5. Bluesky credentials; optional MiroFish (needs LLM and Zep keys).
6. 3D glyph sphere view (deferred on the user's request; a first attempt was stopped, no files left).
7. Demo video, X post, submission form (the user's).

- Landing (2026-11-06): the hero is an ILLUSTRATION (`web/src/app/landing-demo.js` makes ~300 made-up records on hype topics, `LandingCard.jsx` + `landing-cards.js` cycle made-up council scores with TV-static and streaming text). Labelled EXAMPLE; real data stays on Home and `#/constellation`. The logo links to `#/welcome` (landing, works when connected). A wallet choice opens as a modal on `document.body`.
- MetaMask warnings: hosts are not on MetaMask's phishing list, but `*.vercel.app` and `*.workers.dev` are heavily abused, so warnings are likely; the fix is a subdomain of an older domain the user owns plus a Blockaid false-positive report.
- Build show (2026-11-06, design in `docs/superpowers/specs/2026-11-06-build-show-design.md`): `#/build` page (reached from the Council header button and the command palette) and public example pages at `/develop/<slug>` (published version) and `/develop/<slug>/<hash>` (any built version, unlisted). Gemini writes a small JSON content object once per product (`src/sites/`), our renderer makes the HTML (escaped, one script: `/swarm.js`, strict CSP, header block in `vercel.json` excludes `/develop/` from the global CSP), the swarm script (`web/public/swarm.js`, own code, concept only from swarm-cursors which has no licence) replays the page with 5 named cursors in about 19 s. Built on production with the operator token: treasury `328940604d`, signing `54442e496f`, intents `cc517db4f6`, ai-agents `b7b9134cc3` (nothing is published yet; Publish is the owner's click on the Build page). Build needs an owner session or the operator token; WATCH needs `override:true`; DROP cannot be built; daily token cap `SITE_DAILY_TOKENS` (40000). The planner in `swarm.js` must stay identical to `web/src/app/swarm-plan.js` (a test checks it).

## Rules that apply
- Honesty: no invented data; no "audited" for AI or automated checks; human signing is never simulated; label the demo-owner signatures as automated; testnet only.
- Git discipline: other sessions edit this repo at the same time. Run `git status` first and `git add` only the files you changed (never `git add web/src web/dist` wholesale: that once pushed someone else's half-finished app and a stale dist and blacked out production). Build `web/dist` from committed source plus your own files (for example `git archive HEAD web` into a temp dir, copy your files in, `vite build`, copy `dist` back), because `web/dist` is tracked and served.
- Before a push: `npm test`, `npm run test:web`, open the changed routes in a real browser (Playwright is at `/private/tmp/claude-501/pw`), then after the deploy re-check production. `#/home?fixture=1` is a good smoke route.
- Token economy (see memory `token-economy`): no `fork` agents; fresh agents with short briefs and an explicit model. Haiku (high) for audits, test runs, screenshots, docs and wording, deploy checks; Sonnet (high) for connectors, protocol or crypto work, stateful UI, security-sensitive code. The main session decides and verifies.
- Plain wording in user-facing text and comments. No hype words.

## Handy facts
- Faucets (checked 2026-11-06): `helper.testnet.near.org/account` is rate limited per IP ("retry in 7 hours" after the earlier batch). `near-faucet.io` is a Next.js server action: POST to `/` with header `Next-Action: 6d7e3b6e9794a0361cd2decc8f2f1e1e88971970` (the id changes when the site is redeployed; read it from the page's JS chunk), body `[{"contractId":"near_faucet","receiverId":"<account>","amount":"<yocto>"}]`. Up to 0.4 NEAR per call worked; about 10 calls in a row, then HTTP 500 for several minutes (throttle). Total on the accounts above is about 103 NEAR.
- Dev servers used so far: API `DB_PATH=<scratch copy> PORT=8787 node src/server.js`, web `npx vite --host 127.0.0.1 --port 5191` in `web/`. Screenshot helper scripts lived in the old session's scratchpad and are gone; `window.__coTier = 0` pins the constellation quality tier in headless runs (software WebGL is about 2 fps).
- Vercel CLI: link a scratch directory with `vercel link --yes --project autonear --scope copycatfinance`; do not link inside the repo.
- npm cache under `~/.npm` is root-owned: use `npm_config_cache=<some temp dir>` for installs.
- There is no CI: the user does not use it and the workflow file was removed. Run `npm test` and `npm run test:web` locally before every push (the secret scan runs as a git hook).
