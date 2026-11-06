# AI-assisted code reviews (not an independent audit)

Four read-only reviews were run with the OpenAI Codex CLI (`codex exec --sandbox read-only`) against this repository on 2026-11-05. They are **automated reviews by an AI model**. They are not a human security audit, name no independent reviewer, and do not change the project's audit status, which remains **none**.

| Review | Scope | Raw output |
| --- | --- | --- |
| 1 · Backend | `src/**`, `tests/**`, `scripts/attest.mjs`, `wrangler.jsonc`, `migrations/` | [codex-backend-audit.raw.md](codex-backend-audit.raw.md) |
| 2 · Contracts + verification | `contracts/evm/src`, `contracts/near-registry/src`, chain verifiers, decision flow | [codex-contracts-audit.raw.md](codex-contracts-audit.raw.md) |
| 4 · Re-review of the review-3 fixes + social connectors + Vercel entry | `src/autonomy.js`, `src/vault/index.js`, `contracts/near-vault/src/lib.rs`, `contracts/evm/src/AgentVault.sol`, `src/connectors/*`, `src/scoring.js`, `src/policy.js`, `api/index.js` | [codex-vault-rereview.raw.md](codex-vault-rereview.raw.md) |
| 3 · Mandate Vault (agent wallet) | `contracts/evm/src/AgentVault.sol`, `contracts/near-vault/src/lib.rs`, `src/autonomy.js`, `src/vault/*`, `src/agent/*`, vault routes, vault path of `src/decisions.js` | [codex-vault-audit.raw.md](codex-vault-audit.raw.md) |

Each finding was checked against the code before acting. Resolution status below; regression tests are in `tests/`.

## Review 1: backend (10 findings: all addressed)

| ID | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| H-1 | High | NEAR verifier did not bind receiver to the approved target | Decision payload now carries `registry.contractAccount`; verifier requires `receiver_id` to match. Test: "deploy to a different account must be refused". |
| H-2 | High | EVM deployer check optional and request-supplied | Signer is **bound at approval** (`decisions.bound_signer`); receipt route ignores caller-supplied signer. EVM verifier fails if no bound deployer. Tests in `pipeline.test.js`, `evm-anvil.test.js`. |
| H-3 | High | `INSERT OR IGNORE` hid duplicate tx hash | Plain insert; unique violation reverts the claim and returns a conflict. |
| M-1 | Med | Reject overwrote concurrent transitions | Conditional `UPDATE … WHERE status IN (…)` with `changes` check. |
| M-2 | Med | Deployment insert and status update not atomic (D1) | Atomic claim (`approved→executing`), idempotent recovery when the deployment row already exists. |
| M-3 | Med | Skeptic LLM fields unvalidated | Bounded schema validation before copying fields. |
| M-4 | Med | Author counts gameable / blank authors | Blank authors excluded, names normalised, explicit "unverified breadth signal" warning. Remains a heuristic: one actor with many accounts is not detectable. |
| L-1 | Low | Response cap applied after buffering | Streaming reader aborts at the byte cap. Test added. |
| L-2 | Low | Rate-limiter reset all buckets; trusted `X-Forwarded-For` | Bounded eviction; forwarded IP trusted only with `TRUST_PROXY=1`. In-memory limiter is still best-effort. |
| L-3 | Low | LIKE escaping | Explicit `ESCAPE`. Test added. |

## Review 2: contracts + verification (7 findings)

| ID | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| N-01 | High | A deploy tx could carry extra actions (e.g. `AddKey`) | Verifier allowlists actions (`CreateAccount`, `Transfer`, `AddKey`, `DeployContract`, `FunctionCall`), requires exactly one `DeployContract`, permits only the `new` initializer call. *Remaining human step:* `AddKey` is allowed because a fresh contract account normally gets its owner's key, so the verifier lists every full-access key as an **INFO check that the human must confirm is theirs**. Not automatically enforceable. |
| N-02 | High | Failed receipts inside the tx not inspected | Every `receipts_outcome` is checked for `Failure`. Test added. *(Codex appears to have read the file before this edit landed.)* |
| N-03 | Med | Retained full-access keys not checked | Listed as an INFO check (see N-01); policy comparison against a key set is **not implemented**. Open. |
| B-01 | Med | Failing/unlinted attestations accepted | Attestation rejected unless tests pass, lint passes, and test names are present. Test added. |
| B-02 | Med | Monitor only visited the 5 newest deployments | Least-recently-checked-first rotation. Test added. |
| C-01 | Low | Rotated-out proposer cannot cancel old proposals | **Accepted, documented.** Owner can always cancel; matches both contracts' READMEs. |
| B-03 | Low | NEAR `network_id` not verified | Verifier compares registry `network_id` with the decision network. |

## Review 3: end-to-end pass (live browser + API probing, 2026-11-05)

Ran the real server on a copy of the seeded database; drove all 8 screens in Chromium at 360 / 768 / 1440 px, signed out and with the operator token (console errors, failed requests, layout shift, tap targets, labels, duplicate ids, keyboard flows); probed the API with hostile and malformed input; re-ran `npm test`, `wrangler deploy --dry-run` and `npm run e2e:local` (real contract on local anvil).

| ID | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| E-01 | Med | `/api/evidence?limit=-5` returned every row (SQLite treats a negative LIMIT as unbounded); `limit=1.5` was a 500 | `intParam` clamps every numeric query parameter to a valid integer range. Test added. |
| E-02 | Med | Rate-limit key trusted `cf-connecting-ip` on every runtime, so a Node client could dodge limits by spoofing it; without a proxy all clients shared one bucket | Forwarding headers are trusted only on Workers (`trustCfIp`) or with `TRUST_PROXY=1`; otherwise the socket address set by `server.js` is used. Test added. |
| E-03 | Low | `deploy-data` threw a 500 for an approved decision with no attested build | 404 with a clear message. Test added. |
| E-04 | Low | Wrong HTTP method on a known route was a 404 (and `/api/health` accepted any method); unknown run events returned 200 `terminal:true` | 405 + `Allow`, HEAD handled, unknown run is 404. Test added. |
| E-05 | Med (perf) | Evidence paging scanned and sorted the whole table (`COALESCE` order, no index); several lookups had no index | `migrations/0002_indexes.sql` (generated from `SCHEMA_V2`; 0001 unchanged). Query plans asserted in a test. `/api/status` now issues one query for last ingest runs instead of one per source. |
| E-06 | Med (UX) | Dialogs re-focused their first control on every parent render, so the 15 s status poll yanked focus out of the token field while typing | `onClose` kept in a ref; effect runs once per open. Verified in-browser across a poll. |
| E-07 | Low (UX) | Ctrl+K opened the palette with focus on the Close button, so typing did nothing | Initial focus goes to the first form control in the dialog body. Verified in-browser. |
| E-08 | Med | `Md` did not escape quotes and ran emphasis inside URLs (attribute injection; broken links containing `_`). The Node CSP blocked script execution, the Worker sends none | Quotes escaped, links cut out before emphasis. Payloads checked (`"onmouseover=`, `<img onerror>`, `javascript:`). |
| E-09 | Med (UX) | Overview layout shift 0.21 at 360 px: the 2-line loading headline became 1 line | Loading headline is one line; sub-text reserves 2 lines on narrow screens. CLS 0.008. |
| E-10 | Low (UX) | Top bar: the LED and its "LIVE" label stacked on two lines below 400 px | `flex-wrap: nowrap` inside the top bar. |
| E-11 | Low | The italic serif face used by every headline `<em>` was not preloaded; citation chips 18 px tall (WCAG 2.5.8 wants 24) | Italic face added to the existing font-preload plugin; chip padding raised. Workers traces enabled in `wrangler.jsonc`. |

Not changed, by decision: all views are in the main chunk (116 KB gzip) so first content needs one hop; only the wagmi/viem wallet layer (368 KB) is lazy. Remaining small inline text links ("open radar", "Upstream repository") are 18-19 px tall; they are inline links, which WCAG 2.5.8 exempts.

## What these reviews did not do

They ran no tests or builds, queried no chain, and did not exercise deployed bytecode. Treat any residual risk as undetected, not absent. Before any use beyond a testnet demo: commission a human audit, put the owner behind a multisig, and run the deep fuzz/invariant profile in CI.

## Review 3: Mandate Vault (4 findings: all fixed, each with a regression test)

Run 2026-11-05 on the code as first delivered. The reviewer also listed what it checked and found OK (EVM roles/budget/reentrancy, template ids binding full initcode, no `AddKey` in NEAR deploy batches, signer call restrictions, operator-token auth on mutations). This is still an AI-assisted review, not an audit.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| V-1 | High | Vault code verification could fail open: if the code-check RPC failed while the state read succeeded, the loop continued toward signing | Fixed. A check that could not run is `unknown` and a ledgered refusal on every read that can lead to an action (no claim, no signing); a positively observed code mismatch still blocks the loop. Tests: code-check RPC throwing at the first tick and after a good read, zero `eth_sendRawTransaction`, decision executes once the check recovers (`tests/autonomy.test.js`) |
| V-2 | Medium | An approved grant stayed valid after the owner re-set an identical mandate (usage reset on-chain, another full cap under one approval) | Fixed. The activated epoch is pinned; a changed epoch is a refusal that requires a NEW approved `grant_mandate` and re-activation; the verification verdict names the epoch change. Test: identical `setMandate` re-sent, tick refused, new grant works |
| V-3 | Medium | NEAR `draw` stayed charged when the transfer failed (e.g. deleted agent account) | Fixed. `draw` now schedules a private `on_drawn` callback that reverses the charge with epoch/period safeguards and emits `draw_failed`. 6 unit tests + a real-sandbox test that deletes the agent account |
| V-4 | Low | EVM `previewDeploy` disagreed with `deploy` for a template whose runtime code is empty (preview ok, CREATE2 then failed) | Fixed. Deployed CREATE2 targets are recorded and both preview and call return `AddressTaken`; costs about 22k extra gas per deploy. Test with an empty-runtime fixture |

Residual gaps are listed in each component README and in PROGRESS.md Gate G (no Slither, NEAR not run on testnet, no independent audit).

## Review 4: re-review of the fixes, social connectors and the Vercel entry (3 new findings: all fixed)

Run 2026-11-06 on the code after the review-3 fixes. The reviewer confirmed V-1 to V-4 are fixed correctly (inconclusive code checks refuse, a changed epoch refuses reuse of a grant, NEAR `on_drawn` reverses only in the same epoch/period with saturating math, EVM preview and deploy share the `AddressTaken` check) and that connector requests use the host allowlist, manual redirects, size caps and timeouts. Still an AI-assisted review, not an audit.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R-1 | Medium | Social spam could dominate score components (0.4 weight per record in the recency, friction and quality means; only author/source breadth was capped) | Fixed. All social records of a topic together are capped at 0.25x the core weight (at most 20% of any weighted mean) and count for nothing when a topic has no core records; the cap also bounds the breadth and confidence terms. `/api/scoring` publishes the cap. Tests: 1 core + 200 spam records scores exactly like 1 core + 10 |
| R-2 | Medium | Instructions in social text that evade the literal injection patterns reached LLM prompts | Mitigated, not eliminated. By default social text is withheld from LLM prompts (metadata only); `LLM_INCLUDE_SOCIAL=1` adds it truncated, stripped of angle brackets and fenced as untrusted; an LLM finding must cite at least one non-social record or the whole output is rejected. **Still open:** no check that a claim matches the cited text, no constrained extraction step |
| R-3 | Low | One vault with an unreadable state aborted the whole autonomy tick (no refusal ledgered, later vaults skipped) | Fixed. Refuse-and-ledger before verification, per-vault isolation in the tick, `verifyMandate` fails closed on missing state. Live-anvil test with two vaults. The implementing engineer found its earlier guard edit had silently not applied; this review is what caught it |


## Added 2026-11-06

`codex-redesign-review.raw.md`: two read-only Codex passes (plan, then implementation) on the owner-app redesign, with the author's triage and fix status. Same caveat: an automated model review, not an audit.
