import { fetchJson, Budget, csv, maxItemsPerTick, maxAgeMs, sanitize, htmlToText, lowSignalFlags, flagRepeats, windowAndSort, sleep } from './social-common.js';

// Dev.to (Forem) public articles API: GET https://dev.to/api/articles?tag=<tag> (developers.forem.com/api/v1), no key for reads.
// Verified live 2026-11-05: HTTP 200 JSON array. The API has NO full-text search endpoint (/search is disallowed in robots.txt), only tag filters.
//  * tag "nearprotocol": 14 articles in total, 7 of them genuinely about NEAR Protocol.
//  * tag "near": the English word ("flats for sale near ..."): 1 of 40 fresh items passed the strict NEAR filter. Included on purpose: the filter is the point.
//  * tags nearintents / nearblockchain / nearsdk / nearai / nearcon / near-protocol returned 0 articles.
// Rate limit is not documented; we measured 429 with `retry-after: 1` after ~2 requests in quick succession, so requests are spaced 1.3 s apart.
const DEFAULT_TAGS = 'nearprotocol,near';
const TAG_RE = /^[a-z0-9]{2,30}$/;

const tagsOf = (env = process.env) => csv('DEVTO_TAGS', DEFAULT_TAGS, env).map((t) => t.toLowerCase().replace(/^#/, '')).filter((t) => TAG_RE.test(t));

/** Normalizes one Forem article (exported for tests). */
export function normalizeArticle(a) {
  if (!a || typeof a !== 'object' || !a.id || !a.title || !a.url || !a.published_at) return null;
  const publishedAt = Date.parse(a.published_at);
  if (!Number.isFinite(publishedAt)) return null;
  const title = sanitize(htmlToText(a.title)).slice(0, 300);
  const desc = sanitize(htmlToText(a.description ?? ''));
  const tags = Array.isArray(a.tag_list) ? a.tag_list : String(a.tag_list ?? '').split(',').map((t) => t.trim());
  const body = [desc, tags.length ? `Tags: ${tags.join(', ')}` : ''].filter(Boolean).join('\n');
  const flags = lowSignalFlags({ text: `${title} ${desc}`, createdAtMs: publishedAt });
  if (desc.length < 25) flags.push('low-signal:no-summary');
  return {
    externalId: String(a.id),
    url: String(a.url),
    publishedAt,
    author: String(a.user?.username ?? '').toLowerCase(),
    title,
    body,
    org: null,
    kind: 'demand',
    license: 'author-owned Dev.to article (title + summary excerpt and link only; full text is not fetched)',
    flags,
    signals: { reactions: a.public_reactions_count ?? 0, comments: a.comments_count ?? 0, readingMinutes: a.reading_time_minutes ?? null, tags, canonicalUrl: a.canonical_url ?? null, aiDisclosure: a.ai_disclosure_level ?? null },
    raw: { id: a.id, title: a.title, description: a.description, url: a.url, canonical_url: a.canonical_url, published_at: a.published_at, tag_list: a.tag_list, user: { username: a.user?.username }, public_reactions_count: a.public_reactions_count, comments_count: a.comments_count },
  };
}

export const devtoConnector = {
  id: 'devto',
  name: 'Dev.to · developer articles',
  kind: 'demand',
  endpoint: 'https://dev.to/api/articles',
  terms: 'Forem public API v1 (developers.forem.com/api/v1); read endpoints need no API key. Articles are author-owned; AutoNEAR stores the title and the API-supplied summary plus a link, never the article body. robots.txt does not disallow /api/articles. Promotional / SEO-spam posts are common: they are flagged, not trusted.',
  rateLimit: 'Not documented. Measured 2026-11-05: 429 with retry-after: 1 after about 2 quick requests. We issue <= 2 requests per run (one per tag), spaced 1.3 s, with one bounded retry on 429.',
  docsUrl: 'https://developers.forem.com/api/v1',
  maxItems: () => maxItemsPerTick('DEVTO_MAX_ITEMS'),
  subSources: (env = process.env) => tagsOf(env).map((t) => `tag: ${t}`),
  async fetch(ctx = {}) {
    const tags = tagsOf();
    const budget = new Budget();
    const items = []; const errors = []; let ok = 0; let partial = false;
    for (const [i, tag] of tags.entries()) {
      if (budget.exhausted) { partial = true; break; }
      if (i) await sleep(ctx.fetchImpl ? 0 : 1300);
      try {
        const { json } = await fetchJson(`https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=40&state=fresh`, ctx);
        if (!Array.isArray(json)) { errors.push(`#${tag}: unexpected response shape`); continue; }
        ok++;
        items.push(...json.map(normalizeArticle).filter(Boolean));
      } catch (e) { errors.push(`#${tag}: ${String(e.message).slice(0, 100)}`); if (e.status === 429) { partial = true; break; } }
    }
    if (!ok && errors.length) throw new Error(`every request failed: ${errors[0]}`);
    const seen = new Set(); const uniq = items.filter((a) => (seen.has(a.externalId) ? false : seen.add(a.externalId)));
    const w = windowAndSort(flagRepeats(uniq), maxAgeMs());
    return { items: w.items, meta: { partial, errors: errors.slice(0, 5), errorCount: errors.length, outOfWindow: w.dropped, tags } };
  },
};
