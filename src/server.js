// Local / self-hosted entry: node:http adapter, static web console, and an in-process scheduler (runs with the browser closed).
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { config, operatorToken, ROOT, autonomyEnabled } from './config.js';
import { openDb, audit } from './db.js';
import { createApp } from './app.js';
import { registerSources, ingestAll } from './ingest.js';
import { refreshOpportunities } from './scoring.js';
import { pipelineTick } from './orchestrator/coordinator.js';
import { loadKeystore } from './agent/keystore.js';
import { autonomyTick } from './autonomy.js';
import { WELL_KNOWN_PATH } from './identity/erc8004.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const WEB_DIRS = [resolve(ROOT, 'web/dist'), resolve(ROOT, 'web/public')];

/** Load the agent keystore WITHOUT creating keys (`npm run agent:init` does that). A bad/unsafe key file is reported (redacted) and means "no signing". */
function tryLoadKeystore() {
  try { const ks = loadKeystore({ create: false }); const v = ks.publicView(); return v.evm || v.near ? ks : null; } catch (e) { console.error('[agent] keystore not loaded:', String(e.message).replace(/\s+/g, ' ').slice(0, 200)); return null; }
}

export async function startServer({ dbPath = config.dbPath, port = config.port, host = config.host, scheduler = true, keystore, fetchImpl, autonomy = true, signerOpts } = {}) {
  const db = await openDb(config.databaseUrl ? { url: config.databaseUrl, authToken: config.databaseAuthToken } : { path: dbPath });
  await registerSources(db);
  const token = operatorToken();
  const ks = keystore === undefined ? tryLoadKeystore() : keystore;
  const signingSupported = Boolean(ks);
  const app = createApp({ db, operatorToken: token, keystore: ks, signingSupported, fetchImpl, schedulerMode: scheduler ? 'in-process' : 'disabled', schedulerNote: scheduler ? 'setInterval inside the server process; independent of any browser tab' : '' });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/') || url.pathname === WELL_KNOWN_PATH) {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 70_000) { res.writeHead(413).end(); return; } chunks.push(c); }
        const headers = { ...req.headers, 'x-peer-ip': req.socket.remoteAddress ?? 'local' }; // overwrites anything the client sent under this name
        const webReq = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
        const r = await app(webReq);
        let buf = Buffer.from(await r.arrayBuffer()); const h = Object.fromEntries(r.headers);
        if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) { buf = gzipSync(buf); h['content-encoding'] = 'gzip'; h.vary = 'accept-encoding'; }
        res.writeHead(r.status, h); res.end(buf); return;
      }
      await serveStatic(url.pathname, res, req.headers['accept-encoding'] ?? '');
    } catch (e) { console.error(e); res.writeHead(500).end('internal error'); }
  });
  await new Promise((r) => server.listen(port, host, r));

  let timer = null; let ticking = false;
  const tick = async (trigger) => {
    if (ticking) return; ticking = true;
    try { const r = await pipelineTick(db, { trigger, ingest: ingestAll }); console.log(`[tick:${trigger}]`, r.ingest.map((i) => `${i.sourceId}=${i.status}${i.inserted !== undefined ? `(+${i.inserted})` : ''}`).join(' '), '| opps', r.opportunities, '| auto', r.auto.started ? `run ${r.auto.runId} ${r.auto.state}` : r.auto.reason); }
    catch (e) { console.error('[tick] failed', e.message); } finally { ticking = false; }
    await runAutonomy(trigger);
  };
  // Autonomy loop (OFF unless AUTONOMY_ENABLED=1): after every pipeline tick, and on its own faster cadence so a pending decision does not wait 15 minutes.
  const runAutonomy = async (trigger) => {
    if (!autonomy || !autonomyEnabled()) return;
    try { const r = await autonomyTick(db, { keystore: ks, signingSupported, fetchImpl, signerOpts }); if (r.ran || r.skipped) console.log(`[autonomy:${trigger}]`, r.skipped ?? JSON.stringify(r.vaults ?? [])); }
    catch (e) { console.error('[autonomy] failed', ks ? ks.redactText(e.message) : 'error'); }
  };
  let autonomyTimer = null;
  if (scheduler && autonomy && autonomyEnabled()) { autonomyTimer = setInterval(() => runAutonomy('interval'), config.vault.autonomyIntervalMs); autonomyTimer.unref?.(); }
  if (scheduler) { setTimeout(() => tick('startup'), 500); timer = setInterval(() => tick('scheduler'), config.ingestIntervalMs); timer.unref?.(); }
  await audit(db, 'server', 'server.started', { port, scheduler });
  return { server, db, token, tick, app, runAutonomy, close: async () => { clearInterval(timer); clearInterval(autonomyTimer); server.close(); await db.close(); } };
}

async function serveStatic(pathname, res, accept = '') {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  for (const dir of WEB_DIRS) {
    for (const cand of [rel, join(rel, 'index.html')]) {
      const full = resolve(dir, cand);
      if (!full.startsWith(dir)) continue;
      try {
        const st = await stat(full); if (!st.isFile()) continue;
        let buf = await readFile(full);
        const gz = buf.length > 1024 && /\.(js|css|html|svg|json)$/.test(full) && /\bgzip\b/.test(accept);
        if (gz) buf = gzipSync(buf);
        res.writeHead(200, { ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': full.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self' https: http://127.0.0.1:* ; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
        res.end(buf); return;
      } catch { /* try next */ }
    }
  }
  // SPA fallback
  for (const dir of WEB_DIRS) { try { const buf = await readFile(join(dir, 'index.html')); res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }); res.end(buf); return; } catch { /* next */ } }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('web console not built: run `npm run web:build`');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer();
  console.log(`AutoNEAR listening on http://${config.host}:${config.port}`);
  console.log(`operator token file: data/operator.token (${s.token ? 'loaded' : 'MISSING: mutations disabled'})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await s.close(); process.exit(0); });
}
