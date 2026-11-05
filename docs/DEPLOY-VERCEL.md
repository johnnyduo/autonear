# Deploy on Vercel + Turso

Status: **the build and the function bundle were produced with Vercel's own builder (`vercel build --prod`, Node 24.x) and the API handler
was exercised locally against a libSQL database. A live deployment is only proven once the deployment shows `Ready`** (see PROGRESS.md for
what has actually been observed). Cloudflare Workers + D1 ([DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)) remains the other supported target.

## What the repository contains for Vercel
* `vercel.json`: `framework: null`, `installCommand` (root deps + `web/` deps), `buildCommand` (`vite build` inside `web/`),
  `outputDirectory: web/dist`, a daily cron on `/api/cron/tick`, security headers (same CSP as the Node server), `maxDuration: 300`
  for the function, and the NEAR wasm files included in the bundle.
* `api/index.js`: Vercel Function (Node.js runtime) exposing the same Web-standard handler (`createApp`) as the Node server and the
  Cloudflare Worker. Storage is libSQL/Turso via `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (or the `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` names that
  the Vercel Marketplace integration injects). Without a database URL the API answers `503 database not configured` with a hint.
* Dependencies for this path: `@libsql/client`, `@vercel/functions` (regular `dependencies`; the Node server and the Worker do not use them).

**Why the first deployment failed ("vite: command not found"):** the Vercel project auto-detected the Vite preset at the repository root,
but Vite lives in `web/`. `vercel.json` now overrides the preset and builds `web/` explicitly. Keep the project's Root Directory at the repo root.

## Environment variables (Project Settings → Environment Variables; mark credentials Sensitive)
| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` + `DATABASE_AUTH_TOKEN` | yes | Turso (libSQL). Free plan figures were read from turso.tech/pricing on 2026-11-05; check them before relying on it. |
| `OPERATOR_TOKEN` | yes for any mutation | The filesystem is read-only on Vercel, so without it every mutation is disabled (reads still work). |
| `CRON_SECRET` | recommended | Vercel Cron sends it as `Authorization: Bearer …`; `/api/cron/tick` rejects everything else. |
| LLM / GitHub / NEAR values | optional | See `.env.example`. |

Never add wallet or agent private keys to Vercel: the autonomy loop (agent signing keys) does not run on Vercel
(`signingSupported: false`); run `npm run agent:loop` on a Node host you control.

## Limits to know (read from Vercel docs 2026-11-05, re-check before relying)
* **Cron:** `vercel.json` runs `/api/cron/tick` every 15 minutes (`*/15 * * * *`). That needs a **Pro** plan: on Hobby a cron expression that runs more than once a day fails the deployment (Vercel cron docs, read 2026-11-05). The owner confirmed the project is on Pro, and the deployment with the 15-minute cron reached `Ready`. If you are on Hobby, use `0 6 * * *` plus an external pinger calling `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`. Vercel Cron sends that header itself when `CRON_SECRET` is set.
* `defer()` uses `waitUntil` from `@vercel/functions`, so a background run continues after the 202 response within `maxDuration`.
* A full ingestion tick must finish inside `maxDuration` (300 s here). **Measured:** 64 s with the function in `hnd1`; >300 s (504) with it in `iad1` because the Turso database is far from Washington (~200 ms per query, ~1,300 queries per pass). `vercel.json` pins `functions["api/**/*.js"].regions` to `hnd1`: **change it to the region of your own Turso database** (the host name of `DATABASE_URL` shows it) and re-measure with `GET /api/cron/tick?wait=1`.
  With all 9 sources the local (sqlite) measurement was about 35 s cold / 37 s warm (1,814 / 434 queries; the reachable social sources are about 15-16 s of that, mostly network). The 64 s above was measured with the 4 original sources against Turso; re-measure after the social sources land. Tuning: `SOCIAL_MAX_ITEMS`, `SOCIAL_BUDGET_MS` (see `.env.example`).
* Optional social-source variables (`MASTODON_*`, `DEVTO_TAGS`, `FARCASTER_*`, `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`) go in the same place; mark the Bluesky app password Sensitive.
  Bluesky stays `not_configured` (no request, no error) until both are set.

## After deploying
Open `/api/status` (JSON), then the site root. Follow [INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md) for the kill switch and rotation; use
`vercel env` or the dashboard instead of `wrangler secret put`, and redeploy for new values to take effect.
