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
| User's wallet, app owner, pending vault owner | `0x5ebaddf71482d40044391923be1fc42938129988` (ends 9988) | 28 |
| Demo owner (automated key on the agent machine, not a human) | `autonear-owner-1106.testnet` | ~9.9 |
| Agent funder | `autonear-agent-1106.testnet` | ~9.0 |
| Agent (keystore identity) | `d1f730e4a45f61c90789bfd953ec6f247c1e15c571320a93f62a7f41621fae34` | ~5.5 |
| Vault (locked, no keys) | `vault-v1.autonear-owner-1106.testnet` | ~8.8 |
| Registry deployed through the vault | `reg1.vault-v1.autonear-owner-1106.testnet` | 3.8 |
| EVM-format accounts of the agent and demo owner | `0xd64ec57d1b48ec638b04b5716c1e888b2ffaff67`, `0x4aef87e3001efb67114944bc2cf319ddf40cbc4b` | 4.1 each |
| Spare funds (same key as the agent) | `autonear-fund-1106-d`, `-e`, `-f`, `-g` `.testnet` | 10 each |

The vault's `pending_owner` is the user's `0x…9988`. It becomes the owner only when that account calls `accept_ownership`. The mandate on the vault is revoked (end of the test run).

## Done and live
- Mandate Vault (NEAR Rust, plus the Solidity version kept but off), JS model, conformance suite, agent signers, autonomy loop (Node host only).
- Public NEAR testnet run with 14 transactions: `docs/testnet/near-testnet-v1.json` (owner side signed by the demo key, disclosed). The two script-side FAIL entries are kept and explained there.
- Owner app (landing, Home = constellation, Approvals, Watch, Vault, Activity), wallet-signed sessions, `OWNER_ADDRESSES` co-owners (set on Vercel to the 9988 address).
- Constellation: animated HUD, source-to-topic ribbons, provenance cards (a tour of stored records, not live events), full screen at `#/constellation`, technical overview at `#/dashboard`.
- Sources: GitHub, gov forum, Hacker News, NEAR RPC, NEAR Social, Mastodon, Farcaster, Dev.to, plus DefiLlama, NearBlocks, Sputnik DAO, near.org feed (all verified live 2026-11-06, in PROGRESS.md). Bluesky needs `BLUESKY_HANDLE` and an app password.
- NEAR vault attached to the production backend (`POST /api/vault/attach`), so Home shows a NEAR vault and fuel in NEAR.
- Tests: `npm test` 375 (372 pass, 3 skipped), `npm run test:web` 15, `npm run test:near-only`.

## In progress (do not commit until verified)
- MetaMask signs NEAR owner transactions in the web app (NEP-518): files `web/src/wallet/nearEth.js`, `testProvider.js`, `e2e-near-eth.mjs`, `e2e-ui.mjs`, `web/src/app/NearSteps.jsx`, `nearEth.test.js`, edits in `Approvals.jsx`, `VaultPage.jsx`, `copy.js`, `ownerTx.js`. A fork was running this and had not reported at handoff time. Check `git status`, read the files, run `npm run test:web`, and re-run its e2e against testnet with a test key (budget at most 15 NEAR from the spare accounts). First real proof for the user: `accept_ownership` on the vault from MetaMask with the 9988 wallet (network "NEAR testnet (EVM wallet)", chain 398, RPC the relayer; first use may need an onboarding transaction; NEP-518 has no batching, so one signature per step).

## Open work, in order
1. Finish and verify the MetaMask item above, then commit and deploy.
2. A pending request the owner can really approve in Approvals: run a pipeline run that creates a `deploy_testnet` decision on `near-testnet` (needs an LLM key on the host that runs it; check whether production has one).
3. Put the real testnet deployment into the app's history (the 14 transactions are only in `docs/testnet`).
4. More independent non-social demand sources (every opportunity still says `LOW CONFIDENCE: only 2 independent non-social sources`); `data_indexing` and `ai_agents` have no on-chain corroboration.
5. Bluesky credentials; optional MiroFish (needs LLM and Zep keys).
6. 3D glyph sphere view (deferred on the user's request; a first attempt was stopped, no files left).
7. Demo video, X post, submission form (the user's).

## Rules that apply
- Honesty: no invented data; no "audited" for AI or automated checks; human signing is never simulated; label the demo-owner signatures as automated; testnet only.
- Git discipline: other sessions edit this repo at the same time. Run `git status` first and `git add` only the files you changed (never `git add web/src web/dist` wholesale: that once pushed someone else's half-finished app and a stale dist and blacked out production). Build `web/dist` from committed source plus your own files (for example `git archive HEAD web` into a temp dir, copy your files in, `vite build`, copy `dist` back), because `web/dist` is tracked and served.
- Before a push: `npm test`, `npm run test:web`, open the changed routes in a real browser (Playwright is at `/private/tmp/claude-501/pw`), then after the deploy re-check production. `#/home?fixture=1` is a good smoke route.
- Token economy (see memory `token-economy`): no `fork` agents; fresh agents with short briefs and an explicit model. Haiku (high) for audits, test runs, screenshots, docs and wording, deploy checks; Sonnet (high) for connectors, protocol or crypto work, stateful UI, security-sensitive code. The main session decides and verifies.
- Plain wording in user-facing text and comments. No hype words.

## Handy facts
- Dev servers used so far: API `DB_PATH=<scratch copy> PORT=8787 node src/server.js`, web `npx vite --host 127.0.0.1 --port 5191` in `web/`. Screenshot helper scripts lived in the old session's scratchpad and are gone; `window.__coTier = 0` pins the constellation quality tier in headless runs (software WebGL is about 2 fps).
- Vercel CLI: link a scratch directory with `vercel link --yes --project autonear --scope copycatfinance`; do not link inside the repo.
- npm cache under `~/.npm` is root-owned: use `npm_config_cache=<some temp dir>` for installs.
- CI is ignored by the user (billing blocked); keep the factual line in PROGRESS.md that it has never run.
