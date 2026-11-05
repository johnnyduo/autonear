# PROGRESS

Status vocabulary: **tested** = automated test or scripted run passes now · **working** = run by hand and observed, no automated test · **blocked** = needs something only the human can provide · **planned** = no code yet.
"Proof" is a command you can re-run. Nothing here is marked done without a run.

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
| Testnet deploy + tx hash + explorer URL | **blocked** | needs a funded testnet account and the human's signature. **No public-testnet transaction exists in this repo.** | Human: sign via Approval room / `scripts/near-deploy.sh` |

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
| CI | planned | `.github/workflows/ci.yml` written, YAML parses, **never executed** (no GitHub run yet) | Push and watch |
| AI-assisted code reviews with every finding resolved or accepted | tested | `docs/audit/` (17 findings; regression tests) | Human audit before any non-test use |
| Public repo, demo video, X post, official form | **blocked** | human-owned publication steps | |

## Gate G: autonomous agent wallet ("Mandate Vault")

An agent that holds its OWN testnet key and may only (1) draw gas and (2) deploy owner-allowlisted contract templates, inside a human-granted, revocable budget.
Design, rules and shared conformance suite: [docs/agent-vault-spec.md](docs/agent-vault-spec.md). Testnet only; mainnet stays blocked in code. **No public-testnet transaction exists for any of this.**

| Requirement | Status | Proof | Next |
| --- | --- | --- | --- |
| One state machine, two native contracts, one shared conformance file | tested | `contracts/vault-conformance.json` (13 scenarios) runs in Foundry, Rust and the JS model (`npm run contract:evm:vault:test`, `npm run contract:near-vault:test`, `node --test tests/vault-model.test.js`) | Run on testnet after the human deploys |
| EVM `AgentVault.sol` | tested | 97 vault tests (fuzz, invariants, reentrancy, events), branch coverage 100% / line 96.4% (`forge coverage --ir-minimum`); `npm run contract:evm:vault:e2e`: 97 asserts on **local anvil** | Slither not installed; no independent audit |
| NEAR `autonear-vault` | tested | 43 unit + conformance tests; **real nearcore sandbox** run (`contracts/near-vault/integration`, 4 tests): registry deployed through the vault, keyless sub-account, callback reversal on a failed deploy batch and on a failed draw | Not run on NEAR testnet; `near` CLI commands in the plan never executed |
| Agent keys + signers (zero-dependency secp256k1/ed25519, keystore 0600, call limits) | tested | `tests/agent-crypto.test.js` (42): cross-checked with viem, nearcore-generated NEAR vectors, local anvil | secp256k1 is not constant-time (testnet keys only) |
| NEAR signer accepted by a real node | tested (sandbox) | `npm run e2e:near-sandbox`: 69 asserts on a local nearcore sandbox, our own signer for `draw`/`deploy` | Not testnet |
| Autonomy loop | tested (local anvil) | `tests/autonomy.test.js` + `tests/vault-service.test.js`: agent draws gas, deploys the registry through the vault, backend verifies and records; refusals ledgered for over budget, revoked, paused, wrong template/owner, kill switch, tampered state, expired, exhausted | Off by default (`AUTONOMY_ENABLED`); never on Workers/Vercel; NEAR path only against stubs + sandbox adapter tests |
| Grant flow | tested (API) / working (UI on fixtures) | `grant_mandate` decision, exact phrase, server activates only when on-chain state equals the approved payload field by field | UI live path never run against a real backend |
| ERC-8004 identity (optional) | tested (offline) | `tests/identity.test.js` (24, viem cross-checked); registry addresses taken from the official repo README, not confirmed on-chain by us | ERC is **Draft**; no registration tx is ever sent by this code |
| Vault console (`#/vault`) | working | Lighthouse a11y 100, axe 0 violations on fixtures; fixture mode is explicit and cannot send | LCP varied 0.8-3.2 s between runs on the fixture page |
| AI-assisted review of the vault | tested | Codex review 3: 4 findings (1 High, 2 Medium, 1 Low), all fixed with regression tests: docs/audit/README.md | Re-run after any change |
| Independent audit | **none** | AI-assisted review only: see docs/audit/ | Human audit before any non-test use |

## Engines (honest)

Pythia, MiroFish, Kronos: adapters report `not_installed` with a reason. None is invoked. No simulation output is used anywhere. Craft Anything was not used.

## Other protocols

Solana, Sui, Aptos, Starknet, TON appear in the registry as **planned** with no code. Only NEAR and EVM are implemented.
