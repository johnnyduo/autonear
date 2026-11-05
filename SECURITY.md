# Security

AutoNEAR is a hackathon MVP. It has had **no independent security audit**. Where this document says "automated checks", it means exactly that: tests, linters, a mechanical review by the Security Reviewer role, and an AI-assisted code review (see `docs/audit/`). None of these is an audit.

## What the system can and cannot do

| Capability | Status |
| --- | --- |
| Hold or move user funds | **No.** The registry contracts hold no funds and make no external calls. EVM contract has no payable fallback/receive. |
| Hold a wallet or signing key | **By default no.** Deployments are signed by a human in their own wallet or CLI; the server only verifies the receipt on-chain. **Optional, off by default (`AUTONOMY_ENABLED=1`, Node host only):** the agent holds its OWN testnet key (`data/agent.keys.json`, mode 0600, git-ignored, or env) and can only call `draw` and `deploy` on a vault the owner funded and constrained (see the Mandate Vault section). Never on Cloudflare Workers or Vercel. Never a human's key. |
| Deploy to mainnet | **Blocked in code** (`src/policy.js` `DECISION_LIMITS`, `src/decisions.js`). No mainnet chain is configured in the web wallet layer. |
| Upgrade, spend treasury funds, provide liquidity, do outreach | **Disabled.** Each is a separate, not-yet-enabled decision type. |
| Act without a human | Ingest, score, research, build-attestation lookup, security checks and *proposing* a decision are automatic. Every consequential action needs one explicit human approval each, with exact scope, nonce and expiry. **Exception, only after a human signed a mandate on-chain:** with the loop enabled, a testnet registry deploy whose exact code hash and init arguments the owner pre-approved may be executed by the agent within the mandate's caps; these decisions are marked `mandate:<vault>:<epoch>` / `humanSigned:false` everywhere, and revoke, pause or the kill switch stop it. |

## Controls (enforced in code, outside the LLM)

- **Role tool allowlist** (`ROLE_POLICY`, `assertTool`): e.g. the Builder and Security Reviewer cannot call an LLM; only the Launch Planner can write a decision.
- **Outbound host allowlist** per role (`ALLOWED_HOSTS`, `guardedFetch`): HTTPS only, redirects refused, size and time caps.
- **Budgets** per run (USD and tokens), charged before the next stage runs.
- **Schema validation** of every agent output and **citation validation**: a cited evidence id that was not in the role's input set is rejected (hallucinated-citation guard).
- **Prompt-injection handling**: retrieved text is fenced as data; records matching injection patterns are quarantined from LLM prompts (heuristic, not a guarantee).
- **Decision gate**: approval needs the operator token, the decision `nonce`, the stored `payloadHash`, and the exact phrase `approve <decision-id>`. Approval is not execution. A deployment is recorded only after the chain confirms the transaction succeeded and the on-chain code equals the attested artifact.
- **Kill switch**: blocks runs, in-flight stages, approvals and receipts until released.
- **Audit log**: append-only, hash-chained (`UNIQUE(prev_hash)` prevents forks); run events are chained per run. Chain verification is exposed in the Security center.
- **Immutable stores**: `blobs` rejects updates at the database level.
- **Rate limiting**: in-memory token bucket per IP (best effort per isolate/process; use Cloudflare rules for real limits).

## Mandate Vault (agent wallet): what bounds it

- **On-chain, not in prompts:** per-draw, per-period and total caps, a deploy count, an expiry, a pause and a revoke live in the vault contract. The agent address can only reach `draw` (funds go to itself only) and `deploy` (owner-allowlisted code hash; init arguments fixed by the owner at allowlist time, so the agent cannot choose who owns what it deploys). On NEAR the deployed sub-account has no keys; on EVM there is no upgrade path.
- **Off-chain defense in depth:** the signer refuses any target or method except the vault's `draw`/`deploy` and any call above a fee ceiling; the loop re-reads the chain, checks the vault code against the attested build, compares the JS reference model with the chain's own previews before acting, and blocks itself on any mismatch until an operator resumes it.
- **Key custody:** testnet keys only, file mode 0600 and git-ignored (`data/agent*`, `*.key`), never returned by the API, logged, or placed in errors (tests grep for the key). The secp256k1 implementation is not constant-time. Keys sit in process memory; this is not an HSM. A full-access key on the vault *account* (NEAR) would bypass every rule and must not be added.
- **Residual risks (read before enabling):** the vault holds real testnet value; a compromised host that can run the agent can spend up to the mandate's caps; the owner should be a multisig; the contracts have tests and fuzzing but **no independent audit** (an AI-assisted review is in `docs/audit/`); nothing was run on a public testnet by us.

## Threat model (summary; full table in each generated brief)

Prompt injection in sources · source poisoning/astroturfing · hallucinated citations · vulnerable generated code · malicious dependencies · leaked provider/wallet keys · excessive agent spend · compromised quote/solver · MEV and slippage · oracle/data staleness · approval phishing · unsafe upgrades · model/provider outage · false confidence from simulated users. Mitigation status per item is in `src/orchestrator/agents.js` (`THREATS`) and labelled honestly, including items that are only partially mitigated or not addressed (MEV/slippage is a policy cap only; nothing executes).

## Known limitations

- The operator token is a single shared bearer secret. There is no per-user identity, no hardware-key step-up and no 2-person rule. For anything beyond a demo put the app behind Cloudflare Access.
- Heuristic injection detection and relevance filtering can be evaded.
- Public RPC endpoints are trusted for receipt verification; a malicious RPC could lie. Use two independent providers or a light client before relying on it.
- Skeptic competitor data is a human-curated prior (`src/competitors.js`), dated, not live research.
- Treasury quotes are synthetic fixtures unless the NEAR Intents quote API answers (it did not in our environment); the UI and briefs label which.
- Contracts have unit, negative-case, fuzz and (EVM) invariant tests but **no formal verification and no independent audit**. The owner must be a multisig for any non-test use.
- D1 has no interactive transactions; the code relies on unique constraints and idempotent writes instead.

## Reporting

Open a private security advisory on the repository, or email the maintainers listed in the README. Please do not file public issues for vulnerabilities.

## Incident response

See `docs/INCIDENT-RUNBOOK.md` (kill switch, token and key rotation, poisoned sources, bad deployment).
