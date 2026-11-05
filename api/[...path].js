// Vercel Function entry (Node.js runtime, Web-standard Request -> Response). Same app as the Node server and the Cloudflare Worker.
// Storage: libSQL / Turso (DATABASE_URL + DATABASE_AUTH_TOKEN, or the TURSO_* names the Vercel Marketplace integration injects).
// The autonomy loop (agent signing keys) NEVER runs here: signingSupported is false and no keystore is imported.
import { waitUntil } from '@vercel/functions';

process.env.TRUST_PROXY ??= '1'; // Vercel overwrites x-forwarded-for, so it is safe to key rate limits on it

let appPromise;
function getApp() {
  appPromise ??= (async () => {
    const url = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || '';
    if (!url) throw Object.assign(new Error('DATABASE_URL is not set'), { code: 'no_database' });
    const authToken = process.env.DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '';
    const [{ openDb }, { createApp }, { registerSources }] = await Promise.all([import('../src/db.js'), import('../src/app.js'), import('../src/ingest.js')]);
    const db = await openDb({ url, authToken });
    await registerSources(db);
    return createApp({
      db,
      signingSupported: false,
      agentPublicUrl: process.env.AGENT_PUBLIC_URL ?? '',
      operatorToken: process.env.OPERATOR_TOKEN ?? '',
      cronSecret: process.env.CRON_SECRET ?? '',
      defer: (p) => waitUntil(p.catch((e) => console.error('deferred', e))),
      schedulerMode: 'vercel-cron',
      schedulerNote: 'Vercel Cron (vercel.json crons). Hobby plan: once per day; use an external pinger on /api/cron/tick for a faster cadence.',
    });
  })();
  appPromise.catch(() => { appPromise = undefined; }); // retry on the next request instead of caching a failure
  return appPromise;
}

async function handle(request) {
  try {
    return await (await getApp())(request);
  } catch (e) {
    const missing = e.code === 'no_database';
    console.error('api init/handler failed:', e.message);
    return new Response(JSON.stringify({ error: missing ? 'database not configured' : 'internal error', hint: missing ? 'Set DATABASE_URL and DATABASE_AUTH_TOKEN (Turso) in Vercel project settings, then redeploy. See docs/DEPLOY-VERCEL.md.' : undefined }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
}

export default { fetch: handle };
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle, HEAD = handle, OPTIONS = handle;
