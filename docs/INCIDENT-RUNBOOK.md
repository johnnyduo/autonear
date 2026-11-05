# Incident runbook

Audience: the human operator. Commands use `$URL` (deployment base URL) and `$OPERATOR_TOKEN`. On Cloudflare, commands labelled
HUMAN need your logged-in `wrangler`. Nothing in the system holds wallet keys, so no incident here can spend funds by itself;
every consequential action still needs an explicit human approval in a wallet.

Evidence trail for every step: `GET $URL/api/security` returns the hash-chained audit log and `auditChain.ok`. Record the time
and the audit row ids in your incident notes.

## 0. Triage in two minutes

```sh
curl -s $URL/api/status   | jq '{paused, activeRun, sources: [.sources[] | {id,status,lastError,circuitOpenUntil}]}'
curl -s $URL/api/security | jq '{paused, auditChain, audit: .audit[:10]}'
curl -s $URL/api/decisions | jq '.items[] | select(.status=="pending")'
```

If anything looks wrong and you are unsure, engage the kill switch first (section 1); it is cheap and reversible.

## 1. Kill switch (pause everything)

```sh
curl -s -X POST $URL/api/security/pause -H "authorization: Bearer $OPERATOR_TOKEN"     # {"paused":true}
```

Effect (enforced in `src/orchestrator/coordinator.js`): new runs are refused with HTTP 423; a running run stops at its next
stage boundary and ends `cancelled`; the auto-proposal step is skipped. Ingestion still records evidence. Verify:

```sh
curl -s $URL/api/status | jq .paused                                    # true
curl -s -X POST $URL/api/runs -H "authorization: Bearer $OPERATOR_TOKEN" -H 'Idempotency-Key: probe' -d '{"opportunityId":"opp_treasury"}' -w '%{http_code}\n'   # 423
```

Resume only after the cause is fixed: `POST /api/security/resume`. Both actions are written to the audit chain.

If the operator token itself is suspected leaked, you cannot trust the pause endpoint alone: rotate the token (section 2) and
also disable the cron (section 7).

## 2. Operator token rotation

Rotate on a schedule and immediately after any suspected leak (shell history, screenshot, CI log, chat).

Cloudflare (HUMAN):
```sh
openssl rand -hex 32            # new value
npx wrangler secret put OPERATOR_TOKEN
```
`secret put` creates and deploys a new version immediately, so the old token stops working at once. Then:
```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/api/security/pause -H "authorization: Bearer OLDTOKEN"   # expect 401
```
Update the token wherever you store it, and revoke any cookie/localStorage copy in the operator console (log out, then enter the
new token). Do the same for `CRON_SECRET` if external schedulers call `/api/cron/tick`. Local dev: delete `data/operator.token` (a new one
is generated on the next start) and `.dev.vars`. Vercel: change the environment variable and redeploy.

After rotating, review `GET /api/security` audit rows between the suspected exposure time and now for unexpected `run.created`,
`decision.*`, `artifact.attested` entries; cancel anything unexpected (section 5).

## 3. Key rotation (provider and ingestion credentials)

Which key does what is listed in `GET /api/security` `keyScopes`:

| Key | Scope | Rotation |
| --- | --- | --- |
| `OPERATOR_TOKEN` | all mutations | section 2 |
| `CRON_SECRET` | `/api/cron/tick` only | `wrangler secret put CRON_SECRET`, update the external caller |
| `ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY` | server-side completions only | section 4 |
| `GITHUB_TOKEN` | read-only public GitHub search | revoke at GitHub, create a new fine-grained token with no scopes, `wrangler secret put GITHUB_TOKEN` |
| Wallet keys | none, never held by this system | not applicable; if a deployer wallet key was exposed elsewhere, move funds and stop using that account |

CI uses no secrets by design (`.github/workflows/ci.yml`), so there is nothing to rotate there.

## 4. Compromised or leaked LLM key

1. Pause (section 1). 2. Revoke the key in the provider console first (Anthropic Console or the Vercel AI Gateway dashboard);
that is what actually stops spend. 3. Check provider usage for the exposure window and set a hard spend limit there.
4. Set the provider to the deterministic baseline so the system keeps working without a key:
   put `"LLM_PROVIDER": "none"` in `vars` and redeploy (or `npx wrangler secret delete ANTHROPIC_API_KEY`, HUMAN).
   `GET /api/status` `llm.enabled` must be `false`. 5. Create a new key with its own budget, `wrangler secret put`, redeploy, resume.
Spend is also bounded by the policy engine outside the model: `RUN_BUDGET_USD` and `RUN_BUDGET_TOKENS` per run; lower them while
investigating. Review run events for the window: `GET /api/runs`, `GET /api/runs/<id>/events` (each carries model, tokens, cost).

## 5. Poisoned or hostile source content

Symptoms: evidence with instructions aimed at the agents, absurd relevance spikes, a source suddenly returning large volumes of
near-identical items, `duplicate-content-of:` flags.

1. Pause (section 1). 2. Identify the source from `GET /api/evidence?source=<id>` and the ingest run history in `GET /api/status`.
3. Stop pulling it: remove or comment out the connector in `src/connectors/index.js` and redeploy (the source row remains for
audit). Evidence is append-only with immutable raw blobs; do not delete rows, mark and exclude them in the scoring code or add a
migration. 4. Cancel runs that consumed that evidence (`POST /api/runs/<id>/cancel`), reject pending decisions that cite it
(`POST /api/decisions/<id>/reject`). 5. The host allowlist (`ALLOWED_HOSTS` in `src/http-client.js`) limits where agents can
send data; confirm it has not been widened. 6. Resume after a test run on the cleaned data.
The circuit breaker already isolates a failing source (three consecutive failures); it does not detect malicious but well-formed content.

## 6. Bad deployment: pause, cancel, redeploy

1. Pause. 2. Cancel active runs: `curl -X POST $URL/api/runs/<run_id>/cancel -H "authorization: Bearer $OPERATOR_TOKEN"` for each
`queued`/`running` run in `GET /api/status` `activeRun` and `GET /api/runs`. Runs stuck for more than 10 minutes are moved to
`dead_letter` by the next tick. 3. Roll back the code (HUMAN):
```sh
npx wrangler deployments list
npx wrangler rollback <version-id>      # review rollback limits first
```
Rollback restores Worker code and config only; D1 data and secrets are not rolled back
(https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/). If the bad deploy included a schema change, you must
fix forward with a new migration. D1 Time Travel can restore the database in place (7 days of retention on Free, 30 on Paid):
`npx wrangler d1 time-travel restore autonear --timestamp=<unix>` (or `--bookmark=<id>`); it cancels in-flight queries and returns a
bookmark to undo the restore (https://developers.cloudflare.com/d1/reference/time-travel/). Restoring discards later audit rows, so
record the bookmark first. Secrets handling during rollback is not documented on the rollback page: re-check `OPERATOR_TOKEN` afterwards.
Alternatively `git checkout <good-commit> && npm --prefix web ci && npm run cf:deploy`. 4. Run the recovery checklist below, then resume.

## 7. Stop the cron entirely

Remove `triggers.crons` (set `"crons": []`) in `wrangler.jsonc`, redeploy; propagation can take up to 15 minutes
(https://developers.cloudflare.com/workers/configuration/cron-triggers/). To stop everything immediately, rotate `OPERATOR_TOKEN`
and `CRON_SECRET` and pause; as a last resort delete the Worker route in the dashboard (HUMAN).

## 8. Recovery tests checklist

Do not resume until each box is checked.

- [ ] `npm run check && npm test` pass on the commit being deployed (28 backend tests at the time of writing).
- [ ] `GET /api/health` 200; `GET /api/ready` has `storage:true`, `operatorConfigured:true`.
- [ ] `GET /api/security` shows `auditChain.ok: true`. If `false`, stop: the log was tampered with or a migration broke it; restore
      from backup before continuing.
- [ ] Unauthenticated mutation returns 401: `curl -X POST $URL/api/security/pause` (no header).
- [ ] The old operator token returns 401 (after rotation).
- [ ] One manual ingest succeeds: `POST /api/ingest`; every source shows `status: ok` and no open circuit.
- [ ] One cron tick completes: `scheduler.lastTick` advances at the next quarter hour; `workerFreshness:true`.
- [ ] A test run reaches a terminal state and its chain verifies: `GET /api/runs/<id>` `chain.ok: true`.
- [ ] `llm.enabled` and budgets match intent (`GET /api/status`).
- [ ] No pending decision you do not recognise (`GET /api/decisions`); no deployment record you did not make (`GET /api/deployments`).
- [ ] Contract artifacts: `npm run contract:near:test` and `npm run contract:evm:test` pass; attested hashes in `GET /api/artifacts`
      match the build you intend to deploy.
- [ ] Then `POST /api/security/resume` and watch one full cycle.

## 9. After the incident

Write down timeline, cause, what was exposed, and which audit rows prove it. Add a regression test where a code defect was
involved, and update this runbook if a step was missing or wrong.
