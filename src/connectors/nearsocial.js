import { fetchJson, Budget, maxItemsPerTick, maxAgeMs, titleFrom, sanitize, flagRepeats, lowSignalFlags, windowAndSort } from './social-common.js';
import { rpc } from './nearrpc.js';

// NEAR Social = the SocialDB contract `social.near` (on-chain). Verified live 2026-11-05:
//  * `index` is NOT a contract view method (RPC returns MethodNotFound). The feed index (action/key -> [{accountId, blockHeight}]) is served by the
//    API server that the official near-social-js SDK uses by default (DEFAULT_API_SERVER = https://api.near.social, POST /index and POST /get).
//  * A post body lives at `<account>/post/main` and only the LATEST one is in contract state. Older posts are addressed by block height, and the public
//    NEAR RPC is not archival (UNKNOWN_BLOCK beyond ~5 epochs), so bodies are read with POST /get {keys, blockHeight} on that same API server.
//  * Block timestamps of old blocks are not available from the public RPC either, so publishedAt is ESTIMATED from the tip block and a measured
//    seconds-per-block (two RPC `block` calls). Every record carries signals.timeEstimated = true.
const API = 'https://api.near.social';
const ACCOUNT_RE = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*|[0-9a-f]{64})$/; // validated BEFORE it is put into a key pattern: no wildcards reach the contract
const FALLBACK_SEC_PER_BLOCK = 0.58; // measured 2026-11-05 (0.576-0.587 over 1k..100k blocks); only used if calibration fails
const bodyCache = new Map(); // `${key}@${height}` -> main string. A value at a block height is immutable, so this cache can never go stale.
let calCache = null;
/** Test hook: forget cached bodies and block-time calibration. */
export const resetNearSocialCache = () => { bodyCache.clear(); calCache = null; };

async function calibrate(ctx) {
  if (calCache && Date.now() - calCache.at < 30 * 60_000 && !ctx.fetchImpl) return calCache;
  const tipBlock = (await rpc('block', { finality: 'final' }, ctx)).header;
  const nsOf = (h) => BigInt(h.timestamp_nanosec ?? h.timestamp); // `timestamp` can exceed 2^53 as a JSON number: precision loss is ~100 ns, irrelevant here
  const tipHeight = Number(tipBlock.height); const tipMs = Number(nsOf(tipBlock) / 1_000_000n);
  let secPerBlock = FALLBACK_SEC_PER_BLOCK; let measured = false;
  try {
    const back = 40_000; // ~6.4 h: well inside the ~2.5 day window a non-archival node keeps
    const old = (await rpc('block', { block_id: tipHeight - back }, ctx)).header;
    const s = (tipMs - Number(nsOf(old) / 1_000_000n)) / 1000 / back;
    if (s > 0.2 && s < 3) { secPerBlock = s; measured = true; }
  } catch { /* keep the labelled fallback */ }
  calCache = { at: Date.now(), tipHeight, tipMs, secPerBlock, measured };
  return calCache;
}

const postUrl = (acct, h) => `https://near.social/mob.near/widget/MainPage.N.Post.Page?accountId=${encodeURIComponent(acct)}&blockHeight=${h}`;

function parseMain(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return typeof o.text === 'string' ? { text: o.text, type: String(o.type ?? ''), parent: typeof o.item?.path === 'string' ? `${o.item.path}@${o.item.blockHeight ?? ''}` : null } : null;
    return { text: String(o), type: '' };
  } catch { return { text: raw, type: 'plain' }; } // some clients store plain text
}

export const nearSocialConnector = {
  id: 'near-social',
  name: 'NEAR Social · social.near (on-chain)',
  kind: 'demand',
  endpoint: 'https://api.near.social/index',
  terms: 'On-chain public data in the SocialDB contract social.near; each post is owned by its author account. Read through api.near.social, the default API server of the official near-social-js SDK (open-source, Unlicense; no published ToS or rate limit found, so we issue <=2 index + <=40 get + 2 RPC calls per run, 6 in parallel, and never write). Stored as excerpts with signals pointing at account + block height. Social = low-weight, unverified authors.',
  rateLimit: 'Not published for api.near.social (checked docs.near.org/primitives/social and the SDK source 2026-11-05). We issue <= 2 index + <= NEAR_SOCIAL_MAX_ITEMS (default 40) get requests, 6 concurrent, immutable bodies cached in memory. Public RPC: 2 block calls.',
  docsUrl: 'https://docs.near.org/primitives/social',
  maxItems: () => maxItemsPerTick('NEAR_SOCIAL_MAX_ITEMS'),
  async fetch(ctx = {}) {
    const cap = this.maxItems();
    const budget = new Budget();
    const calP = calibrate(ctx); calP.catch(() => {}); // block-time calibration runs in parallel with the index reads
    const [posts, comments] = await Promise.all([
      fetchJson(`${API}/index`, ctx, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'post', key: 'main', options: { order: 'desc', limit: cap } }) }),
      fetchJson(`${API}/index`, ctx, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'comment', key: 'main', options: { order: 'desc', limit: Math.ceil(cap / 2) } }) }),
    ]);
    if (!Array.isArray(posts.json) || !Array.isArray(comments.json)) throw new Error('unexpected /index response shape from api.near.social');
    let malformed = 0;
    const entries = [];
    for (const [kind, arr] of [['post', posts.json], ['comment', comments.json]]) {
      for (const e of arr) {
        if (!e || typeof e.accountId !== 'string' || !ACCOUNT_RE.test(e.accountId) || !Number.isSafeInteger(e.blockHeight)) { malformed++; continue; }
        entries.push({ kind, acct: e.accountId, height: e.blockHeight });
      }
    }
    entries.sort((a, b) => b.height - a.height);
    const picked = entries.slice(0, cap);
    const cal = await calP.catch((e) => { throw new Error(`NEAR RPC calibration failed: ${e.message}`); });

    const items = []; let partial = false; let skippedEmpty = 0; let i = 0; const errors = [];
    const worker = async () => {
      for (;;) {
        if (budget.exhausted) { partial = true; return; }
        const e = picked[i++]; if (!e) return;
        const key = `${e.acct}/post/${e.kind === 'post' ? 'main' : 'comment'}`;
        const ck = `${key}@${e.height}`;
        let main = bodyCache.get(ck);
        if (main === undefined) {
          try {
            const { json } = await fetchJson(`${API}/get`, ctx, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [key], blockHeight: e.height }) });
            main = json?.[e.acct]?.post?.[e.kind === 'post' ? 'main' : 'comment'];
          } catch (err) { errors.push(String(err.message).slice(0, 120)); if (err.status === 429) { partial = true; return; } continue; }
          if (typeof main === 'string') { if (bodyCache.size > 1000) bodyCache.delete(bodyCache.keys().next().value); bodyCache.set(ck, main); }
        }
        const parsed = parseMain(main);
        if (!parsed || !sanitize(parsed.text)) { skippedEmpty++; continue; }
        const text = sanitize(parsed.text).slice(0, 4000);
        const publishedAt = Math.round(cal.tipMs - (cal.tipHeight - e.height) * cal.secPerBlock * 1000);
        items.push({
          externalId: `${e.acct}@${e.height}:${e.kind}`,
          url: postUrl(e.acct, e.height),
          relevanceUrl: '', // the account id inside our own link must not count as a NEAR marker
          publishedAt,
          author: e.acct,
          title: titleFrom(text),
          body: text,
          org: null,
          kind: 'demand',
          license: 'on-chain public data (social.near); author-owned (excerpt + link only)',
          flags: lowSignalFlags({ text, createdAtMs: publishedAt }),
          signals: { chain: 'near', contract: 'social.near', blockHeight: e.height, type: e.kind, parent: parsed.parent ?? null, timeEstimated: true, secPerBlock: Number(cal.secPerBlock.toFixed(4)), secPerBlockMeasured: cal.measured },
          raw: { index: { accountId: e.acct, blockHeight: e.height, kind: e.kind }, main },
        });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (!items.length && errors.length) throw new Error(`every body fetch failed: ${errors[0]}`);
    const w = windowAndSort(flagRepeats(items), maxAgeMs());
    return { items: w.items, meta: { partial, bodyErrors: errors.length, firstBodyError: errors[0] ?? null, malformed, skippedEmpty, outOfWindow: w.dropped, indexed: entries.length, fetchedBodies: items.length, timeEstimated: true, secPerBlock: Number(cal.secPerBlock.toFixed(4)), secPerBlockMeasured: cal.measured } };
  },
};
