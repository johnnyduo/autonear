# Deploy on Cloudflare Workers + D1 (primary target)

Human-run. Nothing in this repository deploys itself, and no step below was executed against a real Cloudflare account while
writing this document (no credentials were available). Local behaviour was exercised with `wrangler dev --local`; see
"What was and was not verified".

Why Cloudflare is primary: a Worker with a Cron Trigger runs the ingestion/scoring/recovery pipeline with every browser tab closed,
D1 is SQLite (same SQL as local `node:sqlite`), and the static console is served from the same Worker through Workers Static
Assets. One account, no separate scheduler, no separate database vendor.

## Read this first: Free plan limits vs this pipeline

Verified against the current docs on 2026-11-05:

| Limit | Workers Free | Workers Paid | Source |
| --- | --- | --- | --- |
| CPU time per Cron invocation | 10 ms | 30 s (interval under 1 hour) | https://developers.cloudflare.com/workers/platform/limits/ |
| CPU time per HTTP request | 10 ms | 30 s default, up to 5 min | same |
| External subrequests per invocation | 50 | 10,000 | same |
| Daily requests | 100,000 | no limit | same |
| Cron Triggers per account | 5 | 250 | same |
| Wall duration for a Cron invocation | 15 min | 15 min | same |
| D1 queries per Worker invocation | 50 | 1,000 | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 rows read / written per day | 5,000,000 / 100,000 | see pricing | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 storage | 500 MB per database, 5 GB per account | 10 GB per database | limits + pricing pages above |
| D1 max bound parameters / statement | 100 / 100 KB | same | d1 limits page |

Consequences for AutoNEAR (this is a design finding, not a guess):

* Ingestion issues roughly 4 to 6 D1 queries per kept evidence item. One real tick locally fetched about 300 items. That is
  more than 1,000 D1 queries and far more than 10 ms of CPU. On Workers Free a full tick will hit the 50-query limit
  and/or the 10 ms CPU limit. The page does not say what happens at the limit for D1 (error vs throttle), so treat the failure
  mode as unverified.
* Two knobs exist in `src/worker.js` (cron path only, unset = full ingestion):
  * `INGEST_SOURCES_PER_TICK=N`: ingest only N of the 4 sources per tick, round-robin (cursor stored in `kv` row `ingest:rr`).
  * `INGEST_MAX_ITEMS=M`: keep at most M items per source per tick.
  Set them as plain vars (`"vars"` in `wrangler.jsonc` or `--var`). Even `1` and `5` cannot be proven to fit the Free budget
  without a real account, because the scoring and auto-proposal steps of the same tick also run queries.
* Recommendation: for continuous operation use Workers Paid (the minimum charge is $5 per month per account,
  https://developers.cloudflare.com/workers/platform/pricing/), or accept that Free serves the read API/console well but
  cannot be expected to complete a full pipeline tick. The `GET /api/ready` check `workerFreshness` tells you whether ticks are
  actually completing.
* Free-plan static asset requests do not count toward the daily request limit (same pricing page).
* `D1 tx()` is intentionally non-atomic (`atomicTx: false` in `src/db.js`). `grep -rn "\.tx(" src tests` finds no caller, so
  nothing in the code base relies on atomic transactions. Hash-chain integrity (audit, run events) relies on
  `UNIQUE(prev_hash)` plus retry, which works on D1.

## Prerequisites

* A Cloudflare account (Free is enough to deploy; see limits above).
* Node 24 or newer and npm.
* This repository checked out; `npm --prefix web ci` run once (the Worker serves `web/dist`).

Wrangler is not a dependency of this repo; `npx wrangler` downloads it (4.151.0 was used for local verification).

## Steps

Run from the repository root. Anything that touches your account is marked HUMAN.

1. Log in (HUMAN, opens a browser):

   ```sh
   npx wrangler login
   npx wrangler whoami            # confirm the right account
   ```

   If you have several accounts, set `account_id` in `wrangler.jsonc` or export `CLOUDFLARE_ACCOUNT_ID`.
   For CI or a narrower scope use an account-owned API token instead of OAuth, and do not paste it into chat.

2. Create the D1 database (HUMAN):

   ```sh
   npx wrangler d1 create autonear
   ```

   Copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`). It is an identifier, not a secret.
   Do not commit placeholders you have not replaced: the repo ships `00000000-0000-0000-0000-000000000000`, which only works
   locally.

3. Apply the schema to the remote database (HUMAN):

   ```sh
   npx wrangler d1 migrations apply autonear --remote
   ```

   `migrations/0001_init.sql` is generated from `src/db.js` `SCHEMA`. Regenerate with `node scripts/gen-migration.mjs`
   after any schema change and add a new numbered migration file for already deployed databases; do not edit an applied
   migration. The Worker never creates tables at request time.

4. Build the console and deploy (HUMAN):

   ```sh
   npm --prefix web ci && npm --prefix web run build
   npx wrangler deploy --dry-run     # optional: bundle check, touches nothing
   npx wrangler deploy
   ```

   `npm run cf:deploy` runs the build and the deploy. Note the printed `https://autonear.<subdomain>.workers.dev` URL.
   Changes to `triggers.crons` can take up to 15 minutes to propagate
   (https://developers.cloudflare.com/workers/configuration/cron-triggers/).

5. Set secrets (HUMAN). Until `OPERATOR_TOKEN` exists every mutation returns 401 ("mutations disabled"), which is the safe
   default. Generate a long random value, then paste it at the prompt (never on the command line):

   ```sh
   openssl rand -hex 32                       # copy this once, store it in your password manager
   npx wrangler secret put OPERATOR_TOKEN
   npx wrangler secret put CRON_SECRET        # only needed if you call /api/cron/tick externally
   # optional, only if you enable an LLM provider:
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put AI_GATEWAY_API_KEY
   npx wrangler secret put GITHUB_TOKEN       # read-only public scope; raises GitHub rate limits
   ```

   `wrangler secret put` creates and deploys a new version immediately
   (https://developers.cloudflare.com/workers/configuration/secrets/). Non-secret settings (`LLM_PROVIDER`,
   `RUN_BUDGET_USD`, `RUN_BUDGET_TOKENS`, `NEAR_NETWORK`, `INGEST_SOURCES_PER_TICK`, `INGEST_MAX_ITEMS`) go in a `"vars"` block
   in `wrangler.jsonc`. Never put private keys for any wallet in config or secrets: this system never holds them.

   Local secrets live in `.dev.vars` (gitignored), never in `wrangler.jsonc`.

6. Verify (replace `$URL`):

   ```sh
   curl -s $URL/api/health
   curl -s $URL/api/ready                      # storage:true; workerFreshness:false until the first tick
   curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/api/security/pause     # expect 401
   curl -s -X POST $URL/api/ingest -H "authorization: Bearer $OPERATOR_TOKEN"  # manual ingest once, expect results
   ```

7. Verify the cron fired. Wait for the next quarter-hour (UTC), then:

   * `curl -s $URL/api/status` shows `scheduler.lastTick` populated and per-source `status: "ok"`.
   * Dashboard: Workers & Pages, your Worker, Settings, Trigger Events, "View events" (stores the 100 most recent cron
     invocations; a new Worker can take up to 30 minutes to show events).
   * `npx wrangler tail` for live logs. Observability (Workers Logs) is enabled in `wrangler.jsonc`.
   * `npx wrangler d1 execute autonear --remote --command "SELECT COUNT(*) FROM evidence"`.

## Local development and testing (all proven on this machine)

```sh
npm --prefix web ci && npm --prefix web run build          # creates web/dist (the Worker serves it)
npm run d1:migrate:local                                    # applies migrations to .wrangler/state (gitignored)
printf 'OPERATOR_TOKEN=dev-operator-token\nCRON_SECRET=dev-cron-secret\n' > .dev.vars
npm run cf:dev                                              # wrangler dev --local --test-scheduled, http://localhost:8787
curl -s localhost:8787/api/health
curl -s "localhost:8787/__scheduled?cron=*/15+*+*+*+*"      # runs scheduled(); "/__scheduled" is in run_worker_first for this
curl -s "localhost:8787/cdn-cgi/local/scheduled?format=json"   # alternative documented endpoint
```

If you change the schema, delete `.wrangler/state` and re-apply migrations.

## What was and was not verified

Verified locally (wrangler 4.151.0, `wrangler dev --local`, Miniflare/workerd, local D1):

* the Worker bundles and boots under `nodejs_compat` with `compatibility_date` 2026-08-20; `wrangler deploy --dry-run` succeeds;
* `/api/health`, `/api/ready`, `/api/status` return 200; static console served at `/`;
* a scheduled invocation ingests real data from the four live sources into local D1 (300+ evidence rows) and then recomputes
  opportunities and auto-starts a run;
* `POST /api/runs` with the operator token returns 202 and the run reaches a terminal state (`blocked`: the builder stage
  cannot build contracts inside a Worker; this is by design, builds are attested from CI/local via `scripts/attest.mjs`);
* mutations without a token, with a wrong token, and `/api/cron/tick` without the cron secret return 401; pause returns 423 on
  a new run; `INGEST_SOURCES_PER_TICK` round-robin works; values from Worker vars reach `config` through `process.env`.

Not verified (needs your account or a paid runtime):

* anything on real Cloudflare infrastructure: remote D1, real cron delivery, secrets, `*.workers.dev` routing;
* whether a full or throttled tick fits the Free plan's 10 ms CPU and 50-query budgets. Local Miniflare does not enforce them;
* what exact error D1 returns at the 50-query limit;
* whether Cron invocations count toward the 100,000 daily request allowance (the pricing page is silent);
* wrangler versions newer than 4.151.0 (4.157.0 was available).

## Documentation relied on

* https://developers.cloudflare.com/workers/platform/limits/
* https://developers.cloudflare.com/workers/platform/pricing/
* https://developers.cloudflare.com/d1/platform/limits/
* https://developers.cloudflare.com/d1/platform/pricing/
* https://developers.cloudflare.com/workers/configuration/cron-triggers/
* https://developers.cloudflare.com/workers/configuration/secrets/
* https://developers.cloudflare.com/d1/best-practices/local-development/
