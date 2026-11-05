# AI-assisted code reviews (not an independent audit)

Two read-only reviews were run with the OpenAI Codex CLI (`codex exec --sandbox read-only`) against this repository on 2026-11-05. They are **automated reviews by an AI model**. They are not a human security audit, name no independent reviewer, and do not change the project's audit status, which remains **none**.

| Review | Scope | Raw output |
| --- | --- | --- |
| 1 · Backend | `src/**`, `tests/**`, `scripts/attest.mjs`, `wrangler.jsonc`, `migrations/` | [codex-backend-audit.raw.md](codex-backend-audit.raw.md) |
| 2 · Contracts + verification | `contracts/evm/src`, `contracts/near-registry/src`, chain verifiers, decision flow | [codex-contracts-audit.raw.md](codex-contracts-audit.raw.md) |

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

## What these reviews did not do

They ran no tests or builds, queried no chain, and did not exercise deployed bytecode. Treat any residual risk as undetected, not absent. Before any use beyond a testnet demo: commission a human audit, put the owner behind a multisig, and run the deep fuzz/invariant profile in CI.
