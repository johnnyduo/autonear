# AutoNEAR

**An evidence-to-product operating system for NEAR.** It watches public demand and on-chain usage, scores opportunities with a published formula, has a skeptic try to break the thesis, assembles a cited product brief, verifies an *attested* contract build, and then asks one human for one scoped decision at a time. After the human signs a testnet deployment in their own wallet, it verifies the receipt on-chain and monitors the result.

> Hackathon: NEAR Hackathon 2026 · Track: AI Security & Defense (also Autonomous Business, AI Swarms) · Status of every claim below is tracked, with proof, in [PROGRESS.md](PROGRESS.md).

## What is real, and what is not

| | |
| --- | --- |
| **Live sources** | GitHub issues in the `near` org, the NEAR governance forum (gov.near.org), Hacker News (strict NEAR-Protocol relevance filter), NEAR mainnet RPC (Intents escrow holdings). Plus five FREE social/news sources, all low-weight and unverified: NEAR Social (on-chain `social.near`), Mastodon public hashtag timelines, Farcaster (community hub, currently returns nothing recent), Dev.to articles, and Bluesky (opt-in, needs your app password, untested). X/Twitter and Reddit are intentionally absent (no free API tier / not self-serve). Source errors are shown, never papered over. |
| **Runs unattended** | An in-process scheduler (local) or Cloudflare Cron Trigger (deployed) ingests, dedupes, re-scores, recovers stalled runs, and may start a research run when something material changed. No browser needed. |
| **Agents** | Signal Collector · Evidence Analyst · Skeptic · Product Architect · Builder · Security Reviewer · Launch Planner (+ Monitor for deployments). Deterministic baseline by default; an LLM (Anthropic, Vercel AI Gateway, or local Codex CLI) can be enabled and its output is schema- and citation-checked or discarded. |
| **Network** | NEAR testnet only. Owners sign with an EVM wallet such as MetaMask through NEAR's Ethereum-wallet standard (NEP-518), so no separate EVM chain is used. The Solidity contracts and EVM adapter stay in the repo but are off by default (`ENABLE_EVM=1` for development). |
| **Contracts** | NEAR (Rust, near-sdk): the attestation registry (no funds, no external calls) and the Mandate Vault. |
| **Human gate** | One decision = one approval = exact scope, nonce, expiry. Approval is not execution; the human signs the deploy. The server records it only after verifying the chain receipt against the attested artifact and the signer bound at approval. |
| **Not done** | Mainnet, upgrades, treasury spend, liquidity, outreach (all blocked in code). No independent audit. No MiroFish/Kronos/Pythia runtime (adapters report `not_installed` and why). Live swap quotes were unavailable in our environment, so the treasury rehearsal uses **labelled synthetic fixtures**. Public-testnet deployment needs your funded wallet; until you sign one, the repo contains **no** public-testnet transaction. |

## Quick start (local, ~2 minutes)

Requires Node ≥ 24 (uses built-in `node:sqlite`). Optional: Rust (via rustup) and Foundry for the contract toolchains.

```bash
cp .env.example .env            # optional; defaults work
npm --prefix web ci && npm --prefix web run build
npm start                       # http://127.0.0.1:8787  (first tick ingests live data)
cat data/operator.token         # paste into "Sign in" to enable mutations
```

No credentials are required for the whole read path. Put keys in `.env` only when you want an LLM or a higher GitHub rate limit.

## Verify it yourself

```bash
npm run verify                  # syntax + 275 backend tests + 241 Foundry + 84 + 43 Rust tests + web build
npm run ingest                  # real network ingestion; prints per-source results
npm run bench                   # deterministic vs LLM analyst, mechanical rubric
npm run attest -- near          # real cargo build + tests → hashes recorded
npm run attest -- evm           # real forge build + tests → hashes recorded
npm run e2e:local               # full loop on a LOCAL anvil chain: ingest → run → approve → deploy → on-chain verify
npm run run:pipeline -- --chain=evm:84532 --owner=0x… --proposer=0x…   # full agent run
```

Then open **Overview → Dossier → Runs → Studio → Approve**. A fresh reviewer should be able to: inspect fresh source records with working original links (Radar), see supporting *and* contradicting evidence (Dossier), trigger an analyst/skeptic run and watch real events (Runs), read the brief and the automated-check results (Studio), and see that deploy is blocked until a scoped approval exists (Approve).

## Autonomous agent wallet (Mandate Vault)

Beyond the one-decision-one-signature flow, a human can grant an agent a **mandate**: a revocable, capped budget in a vault contract (NEAR and EVM, same rules). The agent holds its own testnet key and can only draw gas to itself and deploy contract code the owner pre-approved by exact hash with init arguments fixed by the owner. It cannot widen its budget, send funds elsewhere, pick owners or upgrade; the owner can revoke, pause or withdraw at any time. The loop is **off by default** (`AUTONOMY_ENABLED=1`), runs only on a Node host you control, and every action lands in a hash-chained ledger visible at `#/vault`. Spec and limits: [docs/agent-vault-spec.md](docs/agent-vault-spec.md); proof table: Gate G in [PROGRESS.md](PROGRESS.md). Testnet only; ERC-8004 is used only as an optional, Draft identity file.

## Architecture

```text
Public sources / NEAR RPC ──► connectors (timeout, circuit breaker, backoff) ──► evidence (immutable blobs, hash, license)
                                                                                    │ relevance + dedupe + cluster
                                                                                    ▼
                                      opportunities + published score formula ──► typed run coordinator
                      Collector → Analyst → Skeptic → Architect → Builder → Security → Launch Planner
                                                                                    │ hash-chained run events
                                                                                    ▼
                         Decision (pending) ──► human approves ──► human signs in own wallet/CLI
                                                                                    ▼
                                         receipt verified on-chain vs attested artifact ──► Monitor
```

- `src/` backend with no runtime dependencies on the Node and Cloudflare paths (Node `node:sqlite` locally, Cloudflare D1 deployed; the Vercel path adds `@libsql/client` and `@vercel/functions`). One Web-standard handler serves both runtimes.
- `contracts/near-registry`, `contracts/evm`: the registries and their tests. Spec: [docs/contracts-spec.md](docs/contracts-spec.md).
- `web/`: React 19 + Vite console. wagmi/viem are lazy-loaded only on the approval screen (same wallet-layer approach as the cats.fund project, without ConnectKit).
- `design-system/autonear/`: ui-ux-pro-max design-system output; the chosen palette and type differ where noted in `web/src/styles.css`.

Scoring formula (published at `/api/scoring`): `score = Σ weight × component` over independent demand, recency, on-chain corroboration, friction severity, competition gap, NEAR fit, feasibility and evidence quality. NEAR fit and feasibility are **curated priors**, labelled as such in the UI.

**Social evidence in the score.** GitHub, gov.near.org, Hacker News and on-chain usage are *core* sources. NEAR Social, Mastodon, Farcaster, Dev.to and Bluesky are *social* sources: demand evidence at **0.4x** the weight of a core record in every demand component (recency, friction and evidence quality are weighted means), all social records of a topic *together* are capped at an aggregate **0.25x the core weight** in every weighted mean, in the breadth counts and in confidence (so 200 spam accounts change nothing beyond the cap, and social carries **zero** weight on a topic with no core records), at most **3 effective authors and 1 effective source** can come from social in `independent_demand`, and social sources **never count toward the 3-independent-source rule** and add nothing to the source term of confidence. The `LOW CONFIDENCE` warning therefore counts *non-social* sources, and also reports the social-source and distinct-author counts. Records flagged `bot-author`, `low-signal:*` (new account, link-only, repeated text, market ticker, ...), duplicate content or prompt-injection are kept and listed but de-weighted. The 0.4 and the caps are judgements, not measurements (rationale in `src/connectors/source-weights.js`); the live `/api/scoring` text states the same. No social record is presented as verified fact.

## Deploy

Primary target is Cloudflare Workers + D1: [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md). **Caveat:** the Workers *Free* plan (10 ms CPU, 50 D1 queries per invocation) cannot complete a full ingestion tick; use Workers Paid, or run `npm start` on any small host. The read API and UI fit the free tier. Vercel + Turso is supported through `vercel.json` and `api/index.js` (build verified with Vercel's builder; live status in PROGRESS.md): [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md). Contract deployment is always done by a human; see the Approval room and `scripts/near-deploy.sh` / `contracts/evm/script/Deploy.s.sol`.

## Security

See [SECURITY.md](SECURITY.md) and [docs/INCIDENT-RUNBOOK.md](docs/INCIDENT-RUNBOOK.md). Automated checks are never described as an audit. An AI-assisted code review is archived in [docs/audit/](docs/audit/) with every finding's resolution.

## License

MIT for this repository. Upstream engines named in the Engine Registry keep their own licenses (MiroFish is AGPL-3.0: isolate it as a separate service if ever enabled).
