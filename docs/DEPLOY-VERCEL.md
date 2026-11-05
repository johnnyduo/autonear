# Deploy on Vercel + Turso (secondary option, UNTESTED)

Status: **untested and incomplete in this repository.** Nothing here was run. The code has hooks for it, but the Vercel entry point
files do not exist yet. Use Cloudflare (docs/DEPLOY-CLOUDFLARE.md) unless you have a reason not to.

## Why Cloudflare is primary

| Concern | Cloudflare Workers + D1 | Vercel + Turso |
| --- | --- | --- |
| Scheduler | Cron Trigger every 15 minutes, 5 per account on Free | Hobby cron: **once per day only**, and timing is imprecise (a `0 1 * * *` job may fire any time between 1:00 and 1:59). Expressions that run more often **fail the deployment** on Hobby. Pro: once per minute. Source: https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Database | D1 bound to the Worker, no extra vendor | Filesystem is ephemeral, so `DATABASE_URL` (libSQL/Turso) is mandatory |
| Local proof | Worker run locally with `wrangler dev` (see Cloudflare doc) | none |
| Free-plan caveat | 10 ms CPU and 50 D1 queries per invocation (a full tick needs Workers Paid) | Function duration/usage limits apply to cron invocations (https://vercel.com/docs/limits); not reviewed here |

A 15-minute ingestion cadence is therefore impossible on Vercel Hobby. Realistic Hobby options: one daily cron plus an external
scheduler (for example a GitHub Actions `schedule` workflow or any uptime pinger) calling `GET/POST /api/cron/tick` with
`Authorization: Bearer $CRON_SECRET`. That endpoint already exists in `src/app.js` and accepts `CRON_SECRET` or the operator token.

## Turso (libSQL)

Free plan figures read from https://turso.tech/pricing on 2026-11-05: 100 databases, 5 GB storage, 500 million rows read and
10 million rows written per month. The page did not describe inactivity/sleep behaviour; check it before relying on it.

## What exists in the code

* `src/db.js` `openDb({ url, authToken })` dynamically imports `@libsql/client` when `DATABASE_URL` is set and applies `SCHEMA`
  (all `CREATE ... IF NOT EXISTS`). The package is **not** listed in any `package.json`; add it to the deployment.
* `src/config.js` refuses an operator token on Vercel unless `OPERATOR_TOKEN` is set (read-only FS), so all mutations stay
  disabled without it.
* `src/http-client.js` disables loopback targets when `VERCEL` is set.
* `src/app.js` `createApp({ db, operatorToken, cronSecret, defer })` is a web-standard `Request -> Response` handler, so it can
  be wrapped by a Vercel Function.

## What is missing (you would have to write and test it)

1. A function entry, for example `api/[...path].js`, that builds `db` with `openDb({ url: DATABASE_URL, authToken: DATABASE_AUTH_TOKEN })`
   once per instance, calls `registerSources`, and exports the handler from `createApp`.
2. `vercel.json` with `crons` (Hobby: a single daily expression) and rewrites so `/api/*` reaches the function and everything
   else serves `web/dist`.
3. `@libsql/client` as a dependency and a build command that runs `npm --prefix web ci && npm --prefix web run build`.
4. `defer()` semantics: on Workers it is `ctx.waitUntil`; on Vercel use the platform's `waitUntil` (or await the work), otherwise a
   background run (`POST /api/runs` returns 202 and keeps running) can be frozen when the response is sent.
5. libSQL transactions are real (`tx()` uses `c.transaction('write')`), unlike D1, so behaviour differs slightly; run `npm test`
   against a libSQL URL before trusting it.

## Environment variables (Project Settings, Environment Variables)

`DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `OPERATOR_TOKEN` (required), `CRON_SECRET`, plus the optional LLM/NEAR values in
`.env.example`. Mark every credential as Sensitive. Never add wallet private keys.

## After deploying

Follow docs/INCIDENT-RUNBOOK.md for the kill switch and rotation procedures; replace `wrangler secret put` with
`vercel env` / the dashboard and trigger a redeploy for new values to take effect.
