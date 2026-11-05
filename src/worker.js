// Cloudflare Workers entry: same handler, D1 storage, Cron Trigger drives ingestion + pipeline (no browser needed).
// The Worker NEVER signs: no keystore is loaded, signingSupported is false, and src/autonomy.js / src/agent/keystore.js are not imported here
// (the vault API is read-only on the Worker; the autonomy loop runs on the Node runtime only).
import { openDb } from './db.js';
import { createApp } from './app.js';
import { registerSources, ingestAll } from './ingest.js';
import { pipelineTick } from './orchestrator/coordinator.js';
import { config } from './config.js';
import { CONNECTORS } from './connectors/index.js';
import { WELL_KNOWN_PATH } from './identity/erc8004.js';

function applyEnv(env) { // Workers expose secrets via env, not process.env
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
}
let db;
async function getDb(env) {
  if (!db) { db = await openDb({ d1: env.DB }); await registerSources(db); }
  return db;
}

/** Per-invocation work limiter for the Cron handler (Workers Free: 50 D1 queries + 10 ms CPU per invocation; see docs/DEPLOY-CLOUDFLARE.md).
 *  INGEST_SOURCES_PER_TICK=N ingests N sources per tick, round-robin (cursor in kv); INGEST_MAX_ITEMS=M caps items kept per source.
 *  Both unset = full ingestion (suitable for Workers Paid). */
function limitedIngest(env) {
  const perTick = Number(env.INGEST_SOURCES_PER_TICK) || 0;
  const maxItems = Number(env.INGEST_MAX_ITEMS) || 0;
  return async (d, opts) => {
    let list = CONNECTORS;
    if (perTick > 0 && perTick < list.length) {
      const cur = Number((await d.get("SELECT v FROM kv WHERE k='ingest:rr'"))?.v ?? 0) || 0;
      list = Array.from({ length: perTick }, (_, i) => CONNECTORS[(cur + i) % CONNECTORS.length]);
      await d.run("INSERT INTO kv(k,v) VALUES('ingest:rr',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [String((cur + perTick) % CONNECTORS.length)]);
    }
    if (maxItems > 0) list = list.map((c) => ({ ...c, fetch: async (x) => { const r = await c.fetch(x); return { ...r, items: r.items.slice(0, maxItems) }; } }));
    return ingestAll(d, { ...opts, connectors: list });
  };
}

export default {
  async fetch(request, env, ctx) {
    applyEnv(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== WELL_KNOWN_PATH) return env.ASSETS.fetch(request);
    const d = await getDb(env);
    const app = createApp({ db: d, trustCfIp: true, signingSupported: false, agentPublicUrl: env.AGENT_PUBLIC_URL ?? '', operatorToken: env.OPERATOR_TOKEN ?? '', cronSecret: env.CRON_SECRET ?? '', defer: (p) => ctx.waitUntil(p.catch((e) => console.error('deferred', e))), schedulerMode: 'cloudflare-cron', schedulerNote: 'Workers Cron Trigger (wrangler.jsonc triggers.crons)' });
    return app(request);
  },
  async scheduled(event, env, ctx) {
    applyEnv(env);
    const d = await getDb(env);
    ctx.waitUntil(pipelineTick(d, { trigger: 'cron', ingest: limitedIngest(env) }).catch((e) => console.error('tick failed', e)));
  },
};
export { config };
