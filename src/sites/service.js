// The server side of the Build show: build a stored page from the council result, list the pages, serve /develop/<slug>[/<hash>].
import { now, audit } from '../db.js';
import { PolicyError, Budget } from '../policy.js';
import { oppEvidence, getOpp } from '../store.js';
import { isSocialSource } from '../connectors/source-weights.js';
import { slugOf, validateContent } from './schema.js';
import { generateContent } from './content.js';
import { renderSite, shortHash, esc, SITE_CSP, TEMPLATE_VERSION } from './render.js';
import { saveSite, getSite, latestPublished, latestBuilt, listSites, tokensSince } from './store.js';

const DAY = 864e5;
const dailyTokenCap = () => Number(process.env.SITE_DAILY_TOKENS) || 40_000;
const httpUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

/** Stored evidence that supports the product, minus flagged and social records. Titles only (no body text goes to the model). */
export async function evidenceFor(db, oppId, max = 5) {
  const rows = (await oppEvidence(db, oppId)).filter((e) => (e.relation === 'supports' || e.relation === 'usage') && !e.flags.length && !isSocialSource(e.source_id));
  const seen = new Set(); const list = [];
  for (const e of rows) {
    const title = String(e.title ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const url = httpUrl(e.canonical_url);
    list.push(url ? { title, url } : { title });
    if (list.length >= max) break;
  }
  return list;
}

/** What the API shows for one stored version (no model text). */
export const view = (r) => r && ({
  opp_id: r.opp_id, slug: r.slug, hash: r.hash, url: `/develop/${r.slug}/${r.hash}`, built_at: r.created_at, published: r.published_at != null, published_at: r.published_at,
  verdict: r.meta.verdict ?? null, support: r.meta.support ?? null, override: Boolean(r.meta.override), model: r.meta.model ?? null, tokens: r.meta.tokens ?? 0, cost: r.meta.cost ?? 0,
  ...(r.content ? { content: r.content } : {}),
});

/** Public list: one row per council opportunity, with its newest stored version and the published one. */
export async function listView(db, council) {
  const all = await listSites(db); // newest first
  return council.opportunities.map((o) => {
    const slug = slugOf(o); const mine = all.filter((s) => s.slug === slug);
    const built = mine[0] ?? null; const pub = mine.find((s) => s.published_at != null) ?? null;
    return {
      opp_id: o.oppId, slug, title: o.title, verdict: o.verdict, support: o.support, buildable: o.verdict === 'go', can_override: o.verdict === 'watch',
      hash: built?.hash ?? null, built_at: built?.created_at ?? null, published: Boolean(pub), published_hash: pub?.hash ?? null,
      override: Boolean(built?.meta.override), model: built?.meta.model ?? null, tokens: built?.meta.tokens ?? 0, cost: built?.meta.cost ?? 0,
    };
  });
}

/** Build (or return) the stored page for one opportunity. `entry` is the council entry for it. Returns { site, created }. */
export async function buildSite(db, { oppId, entry, override = false, regenerate = false, actor }) {
  if (!entry) throw new PolicyError('the council has no entry for this product', 'not_found');
  if (entry.verdict === 'drop') throw new PolicyError('The council dropped this product. A page can be built only for GO, or for WATCH on the owner\'s call.', 'state');
  if (entry.verdict !== 'go' && override !== true) throw new PolicyError(`The council says ${String(entry.verdict).toUpperCase()}, not GO. Send override: true to build on the owner's call.`, 'state');
  const opp = await getOpp(db, oppId); if (!opp) throw new PolicyError('unknown product', 'not_found');
  const slug = slugOf(opp);
  if (!regenerate) { const have = await latestBuilt(db, slug); if (have) return { site: have, created: false }; }
  const used = await tokensSince(db, now() - DAY);
  if (used >= dailyTokenCap()) throw new PolicyError('The daily token budget for page text is used up. Try again tomorrow.', 'state');
  const evidence = await evidenceFor(db, oppId);
  const gen = await generateContent({ opportunity: opp, entry, evidenceTitles: evidence.map((e) => e.title), budget: new Budget({ tokens: Math.max(1, dailyTokenCap() - used) }) });
  const hash = shortHash(gen.content);
  const meta = { title: opp.title, verdict: entry.verdict, support: entry.support, override: entry.verdict !== 'go', model: gen.model, tokens: gen.tokens, cost: gen.cost, evidence, template: TEMPLATE_VERSION };
  const site = await saveSite(db, { slug, oppId, hash, content: gen.content, meta, createdAt: now() });
  await audit(db, actor, 'site.build', { opp: oppId, slug, hash, override: meta.override });
  return { site, created: true };
}

// ---- public pages -------------------------------------------------------------------------------------------------------------------------
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'content-security-policy': SITE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN',
};
const plain = (status, text) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(text)}</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0e11;color:#ece9e1;margin:0;padding:48px 20px;max-width:560px}</style></head><body><p>${esc(text)}</p></body></html>`, { status, headers: { ...PAGE_HEADERS, 'cache-control': 'no-store' } });

/** `rest` is the path after /develop/. GET /develop/<slug> (published version only) and /develop/<slug>/<hash> (any stored version, unlisted link). */
export async function pageResponse(db, rest) {
  const parts = String(rest).replace(/\/$/, '').split('/'); const slug = parts[0]; const hash = parts[1] ?? null;
  if (parts.length > 2 || !/^[a-z0-9-]{1,40}$/.test(slug) || (hash !== null && !/^[0-9a-f]{10}$/.test(hash))) return plain(404, 'This page does not exist.');
  const site = hash ? await getSite(db, slug, hash) : await latestPublished(db, slug);
  if (!site) return plain(404, hash ? 'This page does not exist.' : 'No page is published here.');
  const v = validateContent(site.content); // the stored text is checked again before it is rendered
  if (!v.ok) return plain(500, 'This stored page failed its check and is not shown.');
  const html = renderSite({ content: v.value, meta: { slug, title: site.meta.title, verdict: site.meta.verdict, support: site.meta.support, builtAt: site.created_at, hash: site.hash, override: Boolean(site.meta.override), model: site.meta.model, evidence: site.meta.evidence ?? [] } });
  return new Response(html, { status: 200, headers: { ...PAGE_HEADERS, 'cache-control': site.published_at != null ? 'public, max-age=60' : 'no-store' } });
}
