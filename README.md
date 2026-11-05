# AutoNEAR

**An evidence-to-product operating system for NEAR and EVM.** It watches public demand and on-chain usage, scores opportunities with a published formula, has a skeptic try to break the thesis, assembles a cited product brief, verifies an *attested* contract build, and then asks one human for one scoped decision at a time. After the human signs a testnet deployment in their own wallet, it verifies the receipt on-chain and monitors the result.

> Hackathon: NEAR Hackathon 2026 · Track: AI Security & Defense (also Autonomous Business, AI Swarms) · Status of every claim below is tracked, with proof, in [PROGRESS.md](PROGRESS.md).

## What is real, and what is not

| | |
| --- | --- |
| **Live sources** | GitHub issues in the `near` org, the NEAR governance forum (gov.near.org), Hacker News (strict NEAR-Protocol relevance filter), NEAR mainnet RPC (Intents escrow holdings). Source errors are shown, never papered over. |
| **Runs unattended** | An in-process scheduler (local) or Cloudflare Cron Trigger (deployed) ingests, dedupes, re-scores, recovers stalled runs, and may start a research run when something material changed. No browser needed. |
| **Agents** | Signal Collector · Evidence Analyst · Skeptic · Product Architect · Builder · Security Reviewer · Launch Planner (+ Monitor for deployments). Deterministic baseline by default; an LLM (Anthropic, Vercel AI Gateway, or local Codex CLI) can be enabled and its output is schema- and citation-checked or discarded. |
| **Contracts** | One state machine, two native implementations: NEAR (Rust, near-sdk) and EVM (Solidity, Foundry). Attestation registries: no funds, no external calls. |
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
npm run verify                  # syntax + 33 backend tests + 144 Foundry + 84 Rust tests + web build
npm run ingest                  # real network ingestion; prints per-source results
npm run bench                   # deterministic vs LLM analyst, mechanical rubric
npm run attest -- near          # real cargo build + tests → hashes recorded
npm run attest -- evm           # real forge build + tests → hashes recorded
npm run e2e:local               # full loop on a LOCAL anvil chain: ingest → run → approve → deploy → on-chain verify
npm run run:pipeline -- --chain=evm:84532 --owner=0x… --proposer=0x…   # full agent run
```

Then open **Overview → Dossier → Runs → Studio → Approve**. A fresh reviewer should be able to: inspect fresh source records with working original links (Radar), see supporting *and* contradicting evidence (Dossier), trigger an analyst/skeptic run and watch real events (Runs), read the brief and the automated-check results (Studio), and see that deploy is blocked until a scoped approval exists (Approve).

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

- `src/` zero-dependency backend (Node `node:sqlite` locally, Cloudflare D1 deployed, libSQL optional). One Web-standard handler serves both runtimes.
- `contracts/near-registry`, `contracts/evm`: the registries and their tests. Spec: [docs/contracts-spec.md](docs/contracts-spec.md).
- `web/`: React 19 + Vite console. wagmi/viem are lazy-loaded only on the approval screen (same wallet-layer approach as the cats.fund project, without ConnectKit).
- `design-system/autonear/`: ui-ux-pro-max design-system output; the chosen palette and type differ where noted in `web/src/styles.css`.

Scoring formula (published at `/api/scoring`): `score = Σ weight × component` over independent demand, recency, on-chain corroboration, friction severity, competition gap, NEAR fit, feasibility and evidence quality. NEAR fit and feasibility are **curated priors**, labelled as such in the UI.

## Deploy

Primary target is Cloudflare Workers + D1: [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md). **Caveat:** the Workers *Free* plan (10 ms CPU, 50 D1 queries per invocation) cannot complete a full ingestion tick; use Workers Paid, or run `npm start` on any small host. The read API and UI fit the free tier. Vercel + Turso is documented as secondary and untested: [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md). Contract deployment is always done by a human; see the Approval room and `scripts/near-deploy.sh` / `contracts/evm/script/Deploy.s.sol`.

## Security

See [SECURITY.md](SECURITY.md) and [docs/INCIDENT-RUNBOOK.md](docs/INCIDENT-RUNBOOK.md). Automated checks are never described as an audit. An AI-assisted code review is archived in [docs/audit/](docs/audit/) with every finding's resolution.

## License

MIT for this repository. Upstream engines named in the Engine Registry keep their own licenses (MiroFish is AGPL-3.0: isolate it as a separate service if ever enabled).
