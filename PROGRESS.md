# PROGRESS

Status vocabulary: **tested** = automated test or scripted run passes now · **working** = run by hand and observed, no automated test · **blocked** = needs something only the human can provide · **planned** = no code yet.
"Proof" is a command you can re-run. Nothing here is marked done without a run.

> Scope (2026-11-06): NEAR testnet only. Regular EVM chains are switched off by default (`ENABLE_EVM=1` re-enables them for development, and `npm test` sets it so the EVM tests keep running). Rows below that mention EVM describe code that is kept but not part of the product. Wallets are EVM-style (MetaMask) through NEAR's Ethereum-wallet standard.

## Gate A: foundation

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| ≥2 genuinely live public sources | tested | `npm run ingest` → GitHub `near` org, gov.near.org, Hacker News, NEAR mainnet RPC all `ok` (306 records on 2026-11-05) | Add a Discord/X source only with a real API key |
| Strict NEAR-Protocol vs "near" relevance | tested | `tests/ingest.test.js` (relevance cases); HN: 18 of 21 hits filtered | Tune with more labelled examples |
| Onchain usage source | working | `near-rpc-mainnet` records wNEAR/USDC held by `intents.near` | Add historical deltas (needs a day of snapshots) |
| Dedupe (provider+external id, content hash), revisions | tested | `tests/ingest.test.js` | |
| Circuit breaker, backoff, dead-letter | tested | circuit-open test; `recoverRuns` dead-letters stalled runs | |
| Scheduled ingestion with UI closed | working | in-process scheduler (`npm start`); Worker cron proven under `wrangler dev --local` (306 rows ingested via `/__scheduled`) | Deploy: human step |
| Provider docs + rate limits recorded | working | per-source `terms`, `rate_limit`, `docs_url` in `/api/status` | |
| Free-tier scheduler | **blocked** | Cloudflare **Free** plan: 10 ms CPU and 50 D1 queries per invocation (checked in docs by the infra agent). A full tick exceeds both; use Workers **Paid**, Vercel+Turso, or `npm start` on any small host. See `docs/DEPLOY-CLOUDFLARE.md` | Human choice of host |

## Gate A addendum: free social / news sources (checked live 2026-11-05)

X/Twitter (no free API tier; scraping violates ToS) and Reddit (not self-serve free) are deliberately not implemented. All five sources below are **low-weight, unverified demand evidence** (0.4x; never count toward the 3-independent-source rule; see README and `/api/scoring`). Every number is from one live run on 2026-11-05 and will drift.

| Source | Status | What was observed (re-run: `npm run ingest`, then `/api/status`) | Caveats |
| --- | --- | --- | --- |
| NEAR Social (`near-social`) | working | `social.near` has no `index` view method (RPC: MethodNotFound). Feed index + bodies come from `api.near.social` (default server of the official near-social-js SDK, HTTP 200, ~0.27 s). 31 fetched, 13 stored, 18 filtered by the relevance rule; newest post 2026-10-31. Mostly two accounts (`jollydragonroger.near` long documents, `devhub.near` templated proposal notices), flagged `low-signal:repeated-text` | api.near.social has **no published rate limit or ToS** (docs.near.org/primitives/social does not mention it). Public RPC is not archival, so post times are **estimated** from the tip block + measured 0.577 s/block (`signals.timeEstimated`). `with_timestamp` on the API returns a server error, not used. Comment index is 6 months stale |
| Mastodon (`mastodon`) | working | `GET /api/v1/timelines/tag/:tag` answered 200 unauthenticated on mastodon.social, .online, fosstodon.org, hachyderm.io, techhub.social, mas.to, sigmoid.social; 422 "requires an authenticated user" on infosec.exchange and mstdn.social. Limit 300 req / 5 min, `X-RateLimit-*` returned. Run: 9 requests, 58 fetched, 25 stored, 33 filtered (68 cross-instance duplicates collapsed by `uri`). #nearprotocol / #nearintents are NEAR; #near is mostly the English word; #nearcon was empty | Content is mostly **price/ETF news** (flagged `low-signal:market-ticker`), few builder complaints. Instance robots.txt allows `/api` but states the content may not be used for LLM **training**; we do not train, but excerpts can enter analysis prompts if an LLM is enabled: owner decision |
| Farcaster (`farcaster`) | working, returns nothing recent | Official docs describe the HTTP API of a node you run and list **no free public hub**. hub.pinata.cloud does not resolve; hoyt/nemes.farcaster.xyz:2281 unreachable; hub-api.neynar.com and snapchain-api.neynar.com return **402**. One community hub, `haatz.quilibrium.com`, answers anonymously (200, no rate-limit headers). Channel `/near` has 165 casts, newest **2026-02-24**: 0 inside the 90-day window, so the connector stores 0 (`meta.newestSeen` shows why). Fnames `near` (FID 235167) and `nearprotocol` (FID 346344) exist but have 0 casts | Third-party hub, unknown operator/terms/SLA. `FARCASTER_FIDS` watchlist is empty by default: no verified active official NEAR account was found. Watchlist path is tested only against fixtures + one manual `castsByFid` call |
| Dev.to (`devto`) | working | `GET /api/articles?tag=` 200, no key. `nearprotocol`: 14 articles (7 NEAR); `near`: English word, 1 of 40 passes; other tags return 0. Run: 41 fetched, 2 stored, 39 filtered. Measured **429 + `retry-after: 1`** after ~2 quick requests, so requests are spaced 1.3 s | Only title + summary are stored. Last relevant article 2026-10-16 |
| Bluesky (`bluesky`) | opt-in, **not_configured by default; login + search verified live once with a real account on 2026-11-06 (79 posts, 0 errors) and running on production ticks** | Needs `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`. Flow per docs.bsky.app: `bsky.social createSession` then `searchPosts` with a Bearer token (createSession limit 30 / 5 min / account). Unauthenticated: `public.api.bsky.app` searchPosts = 403, `api.bsky.app` searchPosts = **200 with posts** (docs call these endpoints unauthenticated with generous limits but do not promise search) | Unit tests use a fake server + a recorded response **shape**; the live run used one real app password (not stored in the repo). Anonymous path deliberately not used: owner decision. Only accounts hosted on bsky.social |

Hardening after the second model review (tests: `tests/social-hardening.test.js`): all social records of a topic together are capped at 0.25x the core weight in the weighted means, breadth and confidence (0 without core records); social free text is excluded from LLM prompts unless `LLM_INCLUDE_SOCIAL=1`, and an LLM claim must cite at least one non-social record. Not done: checking that a claim actually matches the cited text, and a constrained extraction step; both remain open.

Cost of the five sources (one tick, local sqlite file, queries counted by wrapping `db.all/get/run`): cold DB 240 queries for 40 stored records (about 6 per stored record including ~10 fixed per source); warm DB (nothing new) 80 (plus 6 bookkeeping queries for the `not_configured` Bluesky source). For comparison the four older sources: 1,568 cold / 348 warm. Wall clock for all 9 sources: about 35 s cold and 37 s warm from a laptop (social part about 15 to 16 s, mostly NEAR RPC and api.near.social). Per-source item cap: `SOCIAL_MAX_ITEMS` (default 40). `vercel.json` sets `maxDuration: 60`: a cold full tick is inside it but not by a wide margin; measured only locally, not on Vercel.

## Gate A addendum 2: on-chain usage and official sources (checked live 2026-11-06)

Every row below was verified with a live request on 2026-11-06 and re-checked by a real ingest into a copy of the dev database (`near-rpc-mainnet`, `defillama-near`, `nearblocks`, `sputnik-dao`, `near-official` all `ok`). Fixtures in `tests/fixtures/onchain/` are trimmed recordings of those responses; tests are in `tests/onchain-connectors.test.js`. On-chain rows are kind `usage`: they corroborate a topic only where the number measures that topic. `scoring.js` still counts a topic as corroborated when it has at least one usage record, so each tagged topic gains the 0.12 corroboration weight (and 0.15 in confidence). On the dev database that moves `signing` by +0.12 score and +0.15 confidence (0.583 to 0.703). The network-wide daily account and contract counts are kept as context records with no topic tag, so they do not corroborate `wallet_ux` or `dev_tooling`: a chain-wide number says nothing about those two products. `data_indexing` and `ai_agents` stay uncorroborated: no free number measures them.

| Source | Status | What was observed | Caveats |
| --- | --- | --- | --- |
| NEAR mainnet RPC (`near-rpc-mainnet`, `near-social`) | **fixed** | `rpc.mainnet.near.org` now answers HTTP 429 `THIS ENDPOINT IS DEPRECATED` to every request, so both sources failed. Default is now `https://rpc.mainnet.fastnear.com` (200, about 0.4 s, no key). | Public and rate limited (it returned `-429 Rate limits exceeded` after about 2,000 calls in one minute during discovery). `rpc.testnet.near.org` is on the same deprecation path; `rpc.testnet.fastnear.com` answers 200 and is allowlisted but not yet used for the vault code. |
| DefiLlama (`defillama-near`) | working | `/v2/chains` (58 KB), `/tvl/near-intents` (a number), `/overview/dexs/near` (about 0.2 MB). NEAR Intents TVL 191.66M USD (all chains it supports), NEAR chain TVL 174.9M USD, NEAR DEX volume 153M USD per 24h. | No key, no published limit; at most one run per hour. `/protocols` (9.5 MB) and `/protocol/<slug>` (4 MB) exceed our 4 MB response cap and are not used, so the NEAR-only share of a multi-chain protocol is not shown. Tagged `intents`. |
| NearBlocks (`nearblocks`) | working | `/v1/charts` (1.5 MB, daily rows to the last completed UTC day): 9,988 new and 78,560 active accounts and 47 new contracts on 2026-11-05. `/v1/account/v1.signer/txns/count` 26.4 million; `/v1/account/intents.near/txns/count` 156.9 million. | Free tier: 6 calls/min, about 10,000/month, attribution required; we send 4 calls per run, at most one run per 6 hours, and keep a partial result on HTTP 429 (seen once after repeated test runs). Date-filtered counts returned `Server Error`, so there are no 24-hour deltas. Tags: `wallet_ux` (new accounts), `dev_tooling` (new contracts), `signing` (v1.signer), `intents`. Network-wide numbers show the area is active, not that a gap exists. |
| Sputnik DAO treasuries (`sputnik-dao`) | working | RPC view calls on 5 DAOs picked from the factory `sputnik-dao.near` (2,074 DAOs) by proposal count: 1,202 NEAR held in total, 9,954 proposals filed. | Native balances only (tokens held are not read). At most one run per 2 hours, 10 view calls; a DAO that fails is skipped, fewer than 2 readable DAOs is an error. Tagged `treasury`. |
| near.org blog feed (`near-official`) | working | `https://near.org/feed.xml`, RSS 2.0, 50 items, 14 within 150 days. | NEAR Foundation announcements about what NEAR ships. Stored as kind `news`: never demand, never usage; linked to the topics they mention as competitor context (for example "NEAR Business: the confidential multisig treasury" under `treasury`, "Chain Signatures now run inside TEEs" under `signing`). A topic with such items gets one extra warning. |

Rejected after checking: Stack Overflow (`api.stackexchange.com`, no key): the tag `near-protocol` returns 0 questions and the 300/day quota is per shared IP. Reddit `r/nearprotocol` JSON: HTTP 403. Sputnik DAO proposal texts as demand: of the 25 newest proposals in each of 7 busy DAOs only 7 passed the NEAR relevance rule, and those were payout notes, so it was dropped. NEAR Data (`mainnet.neardata.xyz`): answers a redirect we do not follow, not needed. FastNEAR API (`api.fastnear.com/v1/health`): 404. GitHub releases: would share the unauthenticated GitHub quota with the existing connector. `near.lava.build` RPC: HTTP 410 discontinued.

**Confidence warnings:** none of the new sources is a demand source, so the warning `LOW CONFIDENCE: only 2 independent non-social demand sources` is unchanged on all 7 opportunities of the dev database (6 carry it; `dev_tooling` never did). No free, key-free, non-social demand source was found today.

## Gate B: research

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| Analyst + skeptic roles, cited, validated | tested | `tests/pipeline.test.js` (full pipeline, citation + schema guards) | |
| Skeptic finds competitors, contradictions, gaps | tested | competitor aliases + contradiction links + missing-evidence list | Competitors are a **curated prior**, not live research |
| Published scoring formula + components | tested | `/api/scoring`; Dossier screen decomposes all 8 components | |
| Low-confidence warning when <3 sources | tested | scoring test; shown on Overview/Dossier | |
| LLM usage + model/version shown | working | `LLM_PROVIDER=codex-cli npm run bench` ran a real LLM arm (5 findings, all citations verified, 4829 tokens, 18 s) | Anthropic/Gateway paths are **implemented but untested** (no credentials) |
| Benchmark vs deterministic baseline | working | `npm run bench`: baseline covers 0.67 of sources vs LLM 0.33; both citation-valid. Baseline is not worse on the mechanical rubric | Larger sample; add human grading |
| Immutable dossier + hash-chained run events | tested | blobs reject UPDATE; run chain verified in API and e2e | |
| Treasury quote comparison with policy | working | live 1Click quote **unavailable** ("pair not available" for every pair tried); rehearsal uses **labelled synthetic fixtures**; only mid-price is live | Needs a 1Click JWT/pair from the human |

## Gate C: build

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| NEAR registry: source, lockfile, pinned toolchain, build cmd, tests | tested | `npm run contract:near:test` (84 pass), clippy/fmt clean; `npm run contract:near:build` → wasm sha256 `55b6f0da…93c0`, 210,822 B, reproducible across clean builds; wasm validated against NEAR-accepted feature set (`wasm-tools --features mvp,sign-extension`) | Run in near-workspaces sandbox (not done) |
| EVM registry: tests, fuzz, invariants, e2e | tested | `npm run contract:evm:test` (144 pass incl. 17 fuzz + 7 invariants); `npm run contract:evm:e2e` (74 asserts on **local anvil**); 100% line/branch on `ProposalRegistry.sol` (approx., via-ir) | Run deep invariant profile in CI (takes ~6 min) |
| Negative-case matrix (unauthorized, altered hash, wrong target/method, spend, expiry, replay, cancel, pause, recovery) | tested | named tests in both suites; Security Reviewer maps attested test names to the required cases | |
| Cross-language id vectors | tested | `tests/vectors.test.js` (viem recomputes EVM ids; Node recomputes NEAR sha256 ids) | |
| Build attestation recorded | tested | `npm run attest -- near|evm`; rejected unless tests pass, lint passes, names present | CI-posted attestations |
| Static analysis (slither/clippy) | partial | clippy `-D warnings` for Rust; **no Slither run for Solidity** | Add Slither/Aderyn |
| Testnet deploy + tx hash + explorer URL | **done for the Mandate Vault on NEAR testnet (demo owner, automated)**; the Approval-room human-signed path is still not exercised | 14 real testnet transactions, listed with explorer links in [docs/testnet/near-testnet-v1.json](docs/testnet/near-testnet-v1.json) (vault `vault-v1.autonear-owner-1106.testnet`, registry `reg1.vault-v1.autonear-owner-1106.testnet`). The OWNER-side transactions were signed by a demo owner key held on the same machine as the agent key: that is automation, **not a human signature**. | Human: a human-signed deployment through the Approval room / wallet is still open. EVM testnet: not run (agent/owner EVM wallets unfunded) |

## Gate D: decision

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| Exact scoped decision, nonce, expiry, payload hash | tested | `tests/pipeline.test.js` (wrong nonce / hash / phrase / expired / rejected / paused / twice) | |
| Approval ≠ execution; deployment recorded only after on-chain verification | tested | `npm run e2e:local`: approve → real deploy on local anvil → 11 on-chain checks → record; unknown tx not recorded | |
| Verifier hardening (signer/receiver binding, action allowlist, failed receipts, network id) | tested | `tests/pipeline.test.js`, `tests/evm-anvil.test.js` (real contract on anvil: wrong signer/owner/bytecode/chain all rejected) | Key-policy check for retained NEAR full-access keys is **INFO only** |
| Mainnet / upgrade / spend / liquidity / outreach blocked | tested | `assertDecisionAllowed`; mainnet decision test; no mainnet chain in wallet config | |
| Kill switch | tested | pause blocks runs, approvals, receipts (tests + Worker local run) | |
| Monitor panel for deployments | tested | `src/monitor.js` runs each tick, least-recently-checked first | Needs a real deployment to monitor |

## Gate E: polish

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| 8 screens (Overview, Radar, Dossier, Runs, Studio, Approval, Security, Engines) | working | screenshots in `docs/screenshots/` at 360/768/1440 | |
| Keyboard, dialogs (focus trap/Esc/restore), reduced motion | working | verified by hand with Playwright (focus return, rAF = 0 under reduced motion / offscreen) | Automated a11y run (axe) |
| Performance budget (LCP < 2.5 s, INP < 200 ms, CLS < 0.1) | **partial** | Lighthouse 13 mobile profile (simulated slow 4G, 4× CPU) against the local server with gzip, 2026-11-05: Overview perf 99 / LCP 0.8 s / CLS 0.074; Radar 100 / 0.8 s / 0.019; Security 100 / 1.1 s / 0.013; **Opportunity 94 / LCP 3.0 s ✗; Approval 96 / LCP 2.7 s ✗** (headline waits on API data). Accessibility 100 on all. INP not measured (lab TBT ≈ 0 ms). Initial JS 116 kB gz; wallet chunk 110 kB gz lazy | Render headlines before data; trim the Opportunity payload; measure INP with real interaction |
| Wallet layer lazy-loaded | working | wagmi/viem only on the Approval route | |

## Gate F: submission

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| README matches behaviour; SECURITY; runbook; deploy docs; `.env.example` | working | `README.md`, `SECURITY.md`, `docs/` | |
| CI | not used | No GitHub Actions workflow in the repo (the one that was written never ran and was removed on 2026-11-06). Checks run on the developer machine: `npm test`, `npm run test:web`, the secret scan in `.githooks/`, and Vercel builds the site on every push to `main` | None |
| Model-assisted code reviews with every finding resolved or accepted | tested | `docs/audit/` (17 findings; regression tests) | Human audit before any non-test use |
| Vercel + Turso deployment | working | 2026-11-05: production `Ready` at `https://autonear-eight.vercel.app` (console + API, real Turso DB). Full cron tick (`GET /api/cron/tick?wait=1` with `CRON_SECRET`) returned **200 in 64 s**: 4 sources ingested (GitHub 125 fetched, gov.near 247, HN 4, RPC 1), 7 opportunities scored, one research run started and ended `blocked` (no Rust/Foundry toolchain on Vercel, so no attested build: by design). Before pinning the function to `hnd1` the same pass took >300 s (HTTP 504): each Turso query cost ~200 ms from `iad1`. Counted locally: ~1,276 queries for a dedupe-only ingest + rescore pass | Region `hnd1` is a measured fit for this database, not a general rule: set `regions` to your Turso region. Cron runs every 15 minutes (Pro plan confirmed by the owner; the deployment with the 15-minute cron reached Ready; whether the scheduled invocations actually fire and authenticate is still to be observed in the logs). A 504 can return if the DB region changes or the sources grow. Deployment Protection (Vercel Authentication) is on for the `autonear-copycatfinance.vercel.app` alias; `autonear-eight.vercel.app` is public | **Update (same day, 9 sources):** the second full tick on production after the social sources landed returned 200 in 69 s: near-social 13 stored, mastodon 25, dev.to 2, farcaster 0, bluesky `not_configured` (the first call after the deploy still hit the old instance and listed 4 sources).
| Public repo, demo video, X post, official form | **blocked** | human-owned publication steps | |

## Gate G: autonomous agent wallet ("Mandate Vault")

An agent that holds its OWN testnet key and may only (1) draw gas and (2) deploy owner-allowlisted contract templates, inside a human-granted, revocable budget.
Design, rules and shared conformance suite: [docs/agent-vault-spec.md](docs/agent-vault-spec.md). Testnet only; mainnet stays blocked in code. **Public NEAR testnet run: done (see the row below); no EVM public-testnet transaction exists yet.**

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| One state machine, two native contracts, one shared conformance file | tested | `contracts/vault-conformance.json` (13 scenarios) runs in Foundry, Rust and the JS model (`npm run contract:evm:vault:test`, `npm run contract:near-vault:test`, `node --test tests/vault-model.test.js`) | Run on testnet after the human deploys |
| EVM `AgentVault.sol` | tested | 97 vault tests (fuzz, invariants, reentrancy, events), branch coverage 100% / line 96.4% (`forge coverage --ir-minimum`); `npm run contract:evm:vault:e2e`: 97 asserts on **local anvil** | Slither not installed; no independent audit |
| NEAR `autonear-vault` | tested | 43 unit + conformance tests; **real nearcore sandbox** run (`contracts/near-vault/integration`, 4 tests): registry deployed through the vault, keyless sub-account, callback reversal on a failed deploy batch and on a failed draw | Not run on NEAR testnet; `near` CLI commands in the plan never executed |
| Agent keys + signers (zero-dependency secp256k1/ed25519, keystore 0600, call limits) | tested | `tests/agent-crypto.test.js` (42): cross-checked with viem, nearcore-generated NEAR vectors, local anvil | secp256k1 is not constant-time (testnet keys only) |
| NEAR Mandate Vault on PUBLIC NEAR testnet | **run on testnet (demo owner, automated)** | `scripts/e2e-near-testnet.mjs` (+ `NEAR_RESUME=yes`): owner created and locked `vault-v1.autonear-owner-1106.testnet` (code hash = `contracts/near-vault/dist/autonear_vault.wasm`, verified on chain; no access keys), allowlisted the attested registry wasm with fixed init args, granted a 2 h / 6 NEAR / 1-deploy mandate; the agent (call-limited signer, implicit account of its own key) drew 0.5 NEAR and deployed `reg1.vault-v1...` THROUGH the vault (`verifyDeploy` passed 31 independent checks; the agent paid 0.0139 NEAR gas). The chain itself refused: draw over the per-draw cap (`E_PerDrawCap`), a second deploy (`E_DeployLimit`), a non-allowlisted wasm (`E_TemplateNotAllowed`) and a draw after revoke (`E_MandateInactive`); the owner withdrew while revoked. Evidence + all tx hashes: [docs/testnet/near-testnet-v1.json](docs/testnet/near-testnet-v1.json). | **Owner side is a DEMO key on the agent's machine, not a human signature.** Two checks of the resumed run were marked FAIL by the script itself (its error regex lacked `E_DeployLimit`; it asked for a 1 NEAR withdrawal the vault could not pay): both fixed and disclosed in the evidence file, original entries kept. The first run stopped because the vault was funded 0.47 NEAR short; the owner topped it up and the run was resumed. Public RPC returned HTTP 429 during the run (retried with backoff). Not an independent audit; testnet only |
| NEAR signer accepted by a real node | tested (sandbox) | `npm run e2e:near-sandbox`: 69 asserts on a local nearcore sandbox, our own signer for `draw`/`deploy` | Not testnet |
| Autonomy loop | tested (local anvil) | `tests/autonomy.test.js` + `tests/vault-service.test.js`: agent draws gas, deploys the registry through the vault, backend verifies and records; refusals ledgered for over budget, revoked, paused, wrong template/owner, kill switch, tampered state, expired, exhausted | Off by default (`AUTONOMY_ENABLED`); never on Workers/Vercel; NEAR path only against stubs + sandbox adapter tests |
| Grant flow | tested (API) / working (UI on fixtures) | `grant_mandate` decision, exact phrase, server activates only when on-chain state equals the approved payload field by field | UI live path never run against a real backend |
| ERC-8004 identity (optional) | tested (offline) | `tests/identity.test.js` (24, viem cross-checked); registry addresses taken from the official repo README, not confirmed on-chain by us | ERC is **Draft**; no registration tx is ever sent by this code |
| Vault console (`#/vault`) | working | Lighthouse a11y 100, axe 0 violations on fixtures; fixture mode is explicit and cannot send | LCP varied 0.8-3.2 s between runs on the fixture page |
| Model-assisted review of the vault | tested | Review 3: 4 findings (1 High, 2 Medium, 1 Low), all fixed with regression tests: docs/audit/README.md | Re-run after any change |
| Independent audit | **none** | model-assisted review only: see docs/audit/ | Human audit before any non-test use |

## Gate H: owner app redesign (2026-11-06; design in `docs/design/`)

One landing page, then four pages (Home, Approvals, Watch, Vault) and an Activity drawer; the old 9-screen console is kept only as deep links reachable from Activity. Screenshots: `docs/screenshots/redesign-*.png` (1440 / 768 / 360 px).

| Requirement | Status | Proof | Caveat |
| --- | --- | --- | --- |
| Wallet-signed owner session (EOA), scoped routes (receipt/deploy-data only for requests bound to the signer), `PUBLIC_HOSTS` domain allowlist, owner re-resolved per request, atomic single-use nonce | tested | `node --test tests/owner-session.test.js` (13 tests incl. concurrent redemption, tamper, expiry, owner transfer, host binding) | EOA only: smart-contract wallets / multisigs cannot sign in (they use the operator token). Not exercised with a real MetaMask: the browser E2E used a scripted EIP-1193 provider with real secp256k1 signatures |
| Manual / Auto mode (default Manual) | tested | `tests/autonomy.test.js` (manual never acts; mode re-checked after the claim and before signing) | Server state, not a transaction. Local anvil only |
| Gas top-up, rule (j), Auto only | tested | 9 named tests in `tests/autonomy.test.js` (low-water, per-draw/period/total caps, paused/killed/blocked, durable claim, crash, parity mismatch, mode flip) | Local anvil only; **never run on a public testnet or on NEAR**; the loop and agent key must run on a machine you control (Workers/Vercel cannot sign) |
| Owner-approved execution, rule (k): in Manual mode a deploy the owner approved is published by the agent through the vault (NEAR); activation after the last wallet step; hash-less submissions block instead of being handed back | state machine + EVM negative cases + reconcile free/taken tested | `tests/owner-approved-execution.test.js`, `tests/autonomy.test.js`, `tests/owner-session.test.js` | The NEAR loop (`autonomyTick`) is exercised end to end, Manual and Auto, by `npm run e2e:near-loop` (29 checks on a local nearcore sandbox, not part of `npm test`); it has not run on testnet. The vault's mandate on testnet is currently revoked. Model-assisted review, not an audit |
| Watch (keywords, excludes, hackathons, per-source switches) | tested | `tests/watch.test.js` | Keywords rank and tag only; they never make a record "NEAR" or clear an injection flag. Global to the deployment, owner-only |
| Hold-to-approve, plain-language copy, scene model | tested | `npm run test:web` (copy-deck jargon test, hold state machine, scene model) | |
| Sign-in -> mode flip -> Watch save -> approve by holding, stranger view-only | working | scripted browser run against a local server (sessions shown in `docs/screenshots/redesign-approved-owner-1440.png`, `redesign-view-only-1440.png`) | Scripted wallet, not a human with MetaMask |
| Owner on-chain pause / withdraw from the Vault page | working, untested end to end | `web/src/app/ownerTx.js` (wagmi `writeContract`, 4 fixed functions) | No browser run against a funded vault; no NEAR path (CLI steps are shown instead) |
| Demo data is always labelled | working | Demo badge + banner; example requests can never be approved; real requests always win over examples | |
| NEAR wallet sign-in (NEP-413) | **planned, not built** | | EVM wallet first by decision |

## Engines (honest)

Pythia, MiroFish, Kronos: adapters report `not_installed` with a reason. None is invoked. No simulation output is used anywhere. Craft Anything was not used.

## Other protocols

Solana, Sui, Aptos, Starknet, TON appear in the registry as **planned** with no code. Only NEAR and EVM are implemented.
