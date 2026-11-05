import { fetchJson, Budget, header, csv, maxItemsPerTick, maxAgeMs, htmlToText, sanitize, titleFrom, lowSignalFlags, flagRepeats, windowAndSort, sleep } from './social-common.js';

// Mastodon public hashtag timelines: GET /api/v1/timelines/tag/:hashtag (docs.joinmastodon.org/methods/timelines/#tag), no token.
// Verified live 2026-11-05: HTTP 200 unauthenticated on mastodon.social, mastodon.online, fosstodon.org, hachyderm.io, techhub.social, mas.to, sigmoid.social;
// HTTP 422 "This method requires an authenticated user" on infosec.exchange and mstdn.social (so instance choice matters).
// Only mastodon.social and mastodon.online are on the outbound allowlist; MASTODON_INSTANCES can only choose among allowlisted hosts (others fail closed).
// Tag content observed the same day: #nearprotocol and #nearintents are NEAR Protocol (mostly price/news posts), #near is mostly the English word
// ("near me", art, travel) which the relevance filter rejects, #intents is Apple/EU "intents" (not NEAR), #nearcon returned 0 / 1 stale item.
const DEFAULT_INSTANCES = 'mastodon.social,mastodon.online';
const DEFAULT_TAGS = 'nearprotocol,nearintents,near';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const TAG_RE = /^[\p{L}\p{N}_]{2,40}$/u;

/** Normalizes one Mastodon Status into a connector item (exported for tests). */
export function normalizeStatus(s, instance) {
  if (!s || typeof s !== 'object' || !s.uri || !s.created_at || typeof s.content !== 'string') return null;
  const createdAt = Date.parse(s.created_at);
  if (!Number.isFinite(createdAt)) return null;
  const acct = String(s.account?.acct ?? '');
  const handle = acct ? (acct.includes('@') ? acct : `${acct}@${instance}`) : '';
  const text = sanitize(htmlToText(s.content));
  const spoiler = sanitize(s.spoiler_text ?? '');
  const flags = lowSignalFlags({ text, createdAtMs: createdAt, accountCreatedMs: Date.parse(s.account?.created_at) || null });
  if ((s.account?.statuses_count ?? 99) < 3) flags.push('low-signal:few-posts');
  return {
    externalId: String(s.uri), // globally unique: the same federated status seen from two instances dedupes
    url: String(s.url || s.uri),
    publishedAt: createdAt,
    author: handle.toLowerCase(),
    authorType: s.account?.bot ? 'Bot' : 'User',
    title: spoiler || titleFrom(text),
    body: spoiler ? `${spoiler}\n${text}` : text,
    org: null,
    kind: 'demand',
    license: 'user-authored public Mastodon post (excerpt + link only)',
    flags,
    signals: { instance, replies: s.replies_count ?? 0, boosts: s.reblogs_count ?? 0, favourites: s.favourites_count ?? 0, lang: s.language ?? null, accountFollowers: s.account?.followers_count ?? null, accountCreatedAt: s.account?.created_at ?? null },
    raw: { uri: s.uri, url: s.url, created_at: s.created_at, content: s.content, spoiler_text: s.spoiler_text, language: s.language, account: { acct: s.account?.acct, created_at: s.account?.created_at, bot: s.account?.bot, followers_count: s.account?.followers_count, statuses_count: s.account?.statuses_count }, tags: (s.tags ?? []).map((t) => t.name) },
  };
}

/** `Link: <url>; rel="next"` -> url or null (exported for tests). */
export function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

export const mastodonConnector = {
  id: 'mastodon',
  name: 'Mastodon · public hashtag timelines',
  kind: 'demand',
  endpoint: 'https://mastodon.social/api/v1/timelines/tag/nearprotocol',
  terms: 'Public, unauthenticated hashtag timelines (docs.joinmastodon.org/methods/timelines). robots.txt of mastodon.social / mastodon.online allows /api for generic agents (it disallows only /media_proxy/, /interact/, /api/v1/instance/domain_blocks) but states the content may not be used for LLM TRAINING and blocks named AI crawlers; AutoNEAR is not a crawler of the web, trains nothing, and stores short excerpts with a link, but if you enable an LLM provider the excerpts can appear in analysis prompts: review that against each instance policy. Posts are user-authored; deletions on the origin are not tracked here.',
  rateLimit: 'Mastodon default: 300 requests / 5 min per IP (docs.joinmastodon.org/api/rate-limits; X-RateLimit-* headers returned and checked). We issue <= 3 tags x 2 instances x (1 page, a 2nd only via the Link header) per run and stop below 5 remaining.',
  docsUrl: 'https://docs.joinmastodon.org/methods/timelines/#tag',
  maxItems: () => maxItemsPerTick('MASTODON_MAX_ITEMS'),
  async fetch(ctx = {}) {
    const instances = csv('MASTODON_INSTANCES', DEFAULT_INSTANCES).filter((h) => HOST_RE.test(h));
    const tags = csv('MASTODON_TAGS', DEFAULT_TAGS).map((t) => t.replace(/^#/, '')).filter((t) => TAG_RE.test(t));
    const maxPages = Math.min(3, Math.max(1, Number(process.env.MASTODON_MAX_PAGES) || 2));
    const cutoff = Date.now() - maxAgeMs();
    const budget = new Budget();
    const items = []; const errors = []; let requests = 0; let partial = false; let rlRemaining = null; let rlLimit = null; let ok = 0;
    // instances are different hosts with separate per-IP limits, so they run in parallel; tags/pages within one instance are sequential and spaced
    await Promise.all(instances.map(async (instance) => {
      let used = 0;
      for (const tag of tags) {
        let url = `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
        for (let page = 0; page < maxPages && url; page++) {
          if (budget.exhausted) { partial = true; return; }
          if (partial || (rlRemaining !== null && rlRemaining <= 5)) { partial = true; return; }
          if (used++) await sleep(ctx.fetchImpl ? 0 : 300);
          let res;
          try { requests++; res = await fetchJson(url, ctx); }
          catch (e) { errors.push(`${instance} #${tag}: ${String(e.message).slice(0, 100)}`); if (e.status === 429) { partial = true; return; } break; }
          ok++;
          { const r = header(res.headers, 'x-ratelimit-remaining'); if (r !== null && r !== '') rlRemaining = rlRemaining === null ? Number(r) : Math.min(rlRemaining, Number(r)); }
          rlLimit = header(res.headers, 'x-ratelimit-limit') ?? rlLimit;
          if (!Array.isArray(res.json)) { errors.push(`${instance} #${tag}: unexpected response shape`); break; }
          const got = res.json.map((s) => normalizeStatus(s, instance)).filter(Boolean);
          items.push(...got);
          const allFresh = got.length > 0 && got.every((g) => g.publishedAt >= cutoff);
          const next = allFresh ? nextLink(header(res.headers, 'link')) : null;
          url = next && new URL(next).hostname === instance ? next : null; // pagination never leaves the instance we asked
        }
      }
    }));
    if (!ok && errors.length) throw new Error(`every request failed: ${errors[0]}`);
    // cross-instance duplicates share the same `uri`; ingest dedupes, but keep the first (newest-seen) copy here so the cap counts distinct posts
    const seen = new Set(); const uniq = [];
    for (const it of items) if (!seen.has(it.externalId)) { seen.add(it.externalId); uniq.push(it); }
    const w = windowAndSort(flagRepeats(uniq), maxAgeMs());
    return { items: w.items, meta: { partial, requests, errors: errors.slice(0, 5), errorCount: errors.length, outOfWindow: w.dropped, crossInstanceDuplicates: items.length - uniq.length, rateLimitLimit: rlLimit, rateLimitRemaining: rlRemaining, instances, tags } };
  },
};
