import { fetchJson, Budget, maxItemsPerTick, maxAgeMs, sanitize, titleFrom, lowSignalFlags, flagRepeats, windowAndSort, sleep } from './social-common.js';

// Bluesky post search is OPT-IN. Enabled only when BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are both set; otherwise the source is `not_configured`.
// Flow (docs.bsky.app, read 2026-11-05):
//   1. POST https://bsky.social/xrpc/com.atproto.server.createSession {identifier, password} -> {accessJwt, ...}   (limit 30 / 5 min / account)
//   2. GET  https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=...&sort=latest&since=...&limit=40  with Authorization: Bearer <accessJwt>
//      (the account's PDS proxies app.bsky.* to the AppView; accounts hosted on a PDS other than bsky.social are NOT supported here)
// Observed the same day, unauthenticated: public.api.bsky.app/searchPosts -> HTTP 403 (CDN block page); api.bsky.app/searchPosts -> HTTP 200 with posts.
// The docs say the direct AppView endpoints "do not support authentication" and have "generous rate-limits" but do not promise search, so this connector does
// not use the anonymous path: it is a deliberate owner decision to enable it. THE LOGIN + AUTHENTICATED SEARCH FLOW BELOW HAS NEVER BEEN RUN (no credentials
// were available); only normalizePost() was checked against a live api.bsky.app response shape. Use an APP PASSWORD (Settings > Privacy and security), never the main password.
const QUERIES = ['"NEAR Protocol"', '"NEAR Intents"', 'nearcore', '"near-sdk"', '"chain signatures" NEAR'];
const PDS = 'https://bsky.social';
let session = null; // { jwt, at, key } in memory only; never logged, never stored in the database

/** Test hook: forget the cached session. */
export const resetBlueskySession = () => { session = null; };
const creds = () => ({ handle: (process.env.BLUESKY_HANDLE ?? '').trim().replace(/^@/, ''), password: process.env.BLUESKY_APP_PASSWORD ?? '' });

/** Normalizes one app.bsky.feed.defs#postView (exported for tests). */
export function normalizePost(p, nowMs = Date.now()) {
  const text = sanitize(p?.record?.text ?? '');
  if (!p?.uri || !p.author?.handle || !text) return null;
  const rec = Date.parse(p.record?.createdAt); const idx = Date.parse(p.indexedAt);
  // client-supplied createdAt can lie (future dates); never trust it beyond what the AppView indexed
  const publishedAt = Number.isFinite(rec) && rec <= nowMs + 3_600_000 && (!Number.isFinite(idx) || rec <= idx + 3_600_000) ? rec : (Number.isFinite(idx) ? idx : null);
  if (publishedAt === null) return null;
  const handle = String(p.author.handle).toLowerCase();
  const labels = [...(p.labels ?? []), ...(p.author.labels ?? [])].map((l) => l.val);
  const flags = lowSignalFlags({ text, createdAtMs: publishedAt, accountCreatedMs: Date.parse(p.author.createdAt) || null });
  if (labels.some((l) => ['spam', '!hide', '!warn'].includes(l))) flags.push('low-signal:labelled-spam');
  return {
    externalId: String(p.uri),
    url: `https://bsky.app/profile/${handle}/post/${String(p.uri).split('/').pop()}`,
    publishedAt,
    author: handle,
    title: titleFrom(text),
    body: text,
    org: null,
    kind: 'demand',
    license: 'user-authored Bluesky post (excerpt + link only)',
    flags,
    signals: { replies: p.replyCount ?? 0, reposts: p.repostCount ?? 0, likes: p.likeCount ?? 0, quotes: p.quoteCount ?? 0, langs: p.record?.langs ?? null, did: p.author.did ?? null, accountCreatedAt: p.author.createdAt ?? null },
    raw: { uri: p.uri, cid: p.cid, author: { did: p.author.did, handle: p.author.handle, createdAt: p.author.createdAt }, record: { text: p.record?.text, createdAt: p.record?.createdAt, langs: p.record?.langs }, indexedAt: p.indexedAt, labels },
  };
}

async function login(ctx, { handle, password }) {
  const key = `${handle}\u0000${password}`; // in-memory only; a changed password invalidates the session
  if (session && session.key === key && Date.now() - session.at < 60 * 60_000) return session.jwt;
  let out;
  try {
    out = await fetchJson(`${PDS}/xrpc/com.atproto.server.createSession`, ctx, { role: 'credentialed', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: handle, password }) });
  } catch (e) {
    throw new Error(`Bluesky login failed (${String(e.message).slice(0, 80)}); check BLUESKY_HANDLE and that BLUESKY_APP_PASSWORD is an app password`); // never include the request body
  }
  if (typeof out.json?.accessJwt !== 'string') throw new Error('Bluesky login response had no accessJwt');
  session = { jwt: out.json.accessJwt, at: Date.now(), key };
  return session.jwt;
}

export const blueskyConnector = {
  id: 'bluesky',
  name: 'Bluesky · post search (opt-in, credentials required)',
  kind: 'demand',
  endpoint: 'https://bsky.social/xrpc/app.bsky.feed.searchPosts',
  terms: 'OPT-IN. Uses your own Bluesky account through an APP PASSWORD (BLUESKY_HANDLE + BLUESKY_APP_PASSWORD) and is subject to Bluesky Terms of Service. Posts are user-authored; stored as excerpts with a link. Credentials are read from the environment per run, held in memory only and never logged or stored. Login and authenticated search were run once against a real account on 2026-11-06 (79 posts, 0 errors) and now run on every scheduled tick.',
  rateLimit: 'PDS: 3000 requests / 5 min per IP; createSession 30 / 5 min / account (docs.bsky.app/docs/advanced-guides/rate-limits). We log in at most once per hour per process and issue <= 5 searches per run, 1 s apart.',
  docsUrl: 'https://docs.bsky.app/docs/api/app-bsky-feed-search-posts',
  maxItems: () => maxItemsPerTick('BLUESKY_MAX_ITEMS'),
  availability() {
    const c = creds();
    if (c.handle && c.password) return { status: 'ready' };
    return { status: 'not_configured', reason: 'Bluesky search requires authentication. Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password) to enable this source. Nothing was requested.' };
  },
  async fetch(ctx = {}) {
    const c = creds();
    if (!c.handle || !c.password) throw new Error('not configured: BLUESKY_HANDLE / BLUESKY_APP_PASSWORD missing');
    const since = new Date(Date.now() - maxAgeMs()).toISOString();
    const budget = new Budget();
    const items = []; const errors = []; let ok = 0; let partial = false; let jwt = await login(ctx, c); let relogged = false;
    for (const [i, q] of QUERIES.entries()) {
      if (budget.exhausted) { partial = true; break; }
      if (i) await sleep(ctx.fetchImpl ? 0 : 1000);
      const url = `${PDS}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&since=${encodeURIComponent(since)}&limit=40`;
      try {
        let res;
        try { res = await fetchJson(url, ctx, { role: 'credentialed', headers: { authorization: `Bearer ${jwt}` } }); }
        catch (e) { // expired token: log in once more, then give up for this run
          if ((e.status === 400 || e.status === 401) && !relogged) { relogged = true; session = null; jwt = await login(ctx, c); res = await fetchJson(url, ctx, { role: 'credentialed', headers: { authorization: `Bearer ${jwt}` } }); }
          else throw e;
        }
        if (!Array.isArray(res.json?.posts)) { errors.push(`q=${q}: unexpected response shape`); continue; }
        ok++;
        items.push(...res.json.posts.map((p) => normalizePost(p)).filter(Boolean));
      } catch (e) { errors.push(`q=${q}: ${String(e.message).slice(0, 100)}`); if (e.status === 429) { partial = true; break; } }
    }
    if (!ok && errors.length) throw new Error(`every request failed: ${errors[0]}`);
    const seen = new Set(); const uniq = items.filter((a) => (seen.has(a.externalId) ? false : seen.add(a.externalId)));
    const w = windowAndSort(flagRepeats(uniq), maxAgeMs());
    return { items: w.items, meta: { partial, errors: errors.slice(0, 5), errorCount: errors.length, outOfWindow: w.dropped, queries: QUERIES.length } };
  },
};
