# Deploy on Vercel + Turso

Status: **the build and the function bundle were produced with Vercel's own builder (`vercel build --prod`, Node 24.x) and the API handler
was exercised locally against a libSQL database. A live deployment is only proven once the deployment shows `Ready`** (see PROGRESS.md for
what has actually been observed). Cloudflare Workers + D1 ([DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)) remains the other supported target.

## What the repository contains for Vercel
* `vercel.json`: `framework: null`, `installCommand` (root deps + `web/` deps), `buildCommand` (`vite build` inside `web/`),
  `outputDirectory: web/dist`, a daily cron on `/api/cron/tick`, security headers (same CSP as the Node server), `maxDuration: 60`
  for the function, and the NEAR wasm files included in the bundle.
* `api/[...path].js`: Vercel Function (Node.js runtime) exposing the same Web-standard handler (`createApp`) as the Node server and the
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
* **Hobby cron runs once per day** and expressions that run more often fail the deployment. For a 15-minute cadence use an external
  scheduler (GitHub Actions `schedule`, any uptime pinger) calling `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`, or Vercel Pro.
* `defer()` uses `waitUntil` from `@vercel/functions`, so a background run continues after the 202 response within `maxDuration`.
* A full ingestion tick must finish inside `maxDuration` (60 s here). Not yet measured on Vercel.

## After deploying
Open `/api/status` (JSON), then the site root. Follow [INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md) for the kill switch and rotation; use
`vercel env` or the dashboard instead of `wrangler secret put`, and redeploy for new values to take effect.
