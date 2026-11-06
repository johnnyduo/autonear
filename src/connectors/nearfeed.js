import { guardedFetch } from '../http-client.js';
import { decodeEntities, htmlToText } from './social-common.js';

const FEED = 'https://near.org/feed.xml';
const HOSTS = new Set(['near.org', 'www.near.org']);
const unCdata = (s) => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decodeEntities(unCdata(m[1])).trim() : ''; };

/**
 * NEAR's own blog feed (near.org/feed.xml, RSS 2.0, 50 items, checked 2026-11-06). These are announcements by the NEAR Foundation about what NEAR ships, so they are stored as
 * kind "news": scoring ignores them as demand, and each one is linked to the topics it mentions as an existing product (a competitor link), because that is what they show.
 */
export const nearFeedConnector = {
  id: 'near-official',
  name: 'NEAR official blog (near.org)',
  kind: 'news',
  endpoint: FEED,
  terms: 'Public RSS feed of near.org/blog. Stored as excerpts with a link to the original post.',
  rateLimit: 'One request per run; the feed is a static file (about 32 KB)',
  docsUrl: 'https://www.near.org/blog',
  minIntervalMs: 3_600_000,
  async fetch(ctx = {}) {
    const res = await guardedFetch('collector', FEED, { fetchImpl: ctx.fetchImpl, headers: { accept: 'application/rss+xml, application/xml' } });
    if (!/<rss[\s>]/i.test(res.text)) throw new Error('near.org/feed.xml is not an RSS document');
    const since = Date.now() - 150 * 864e5; const items = []; let skipped = 0;
    for (const m of res.text.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const x = m[1]; const link = tag(x, 'link'); const title = tag(x, 'title'); const at = Date.parse(tag(x, 'pubDate'));
      let host = ''; try { const u = new URL(link); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* bad link */ }
      if (!title || !HOSTS.has(host) || !Number.isFinite(at)) { skipped++; continue; }
      if (at < since) continue;
      items.push({
        externalId: tag(x, 'guid') || link, url: link, publishedAt: at, author: 'near.org',
        title: title.slice(0, 300), body: htmlToText(tag(x, 'description')).slice(0, 1200), org: 'near-official', kind: 'news',
        license: 'NEAR blog RSS (excerpt + link only)', signals: { categories: [...x.matchAll(/<category>([\s\S]*?)<\/category>/gi)].map((c) => decodeEntities(unCdata(c[1])).trim()).slice(0, 6) }, raw: { title, link, pubDate: tag(x, 'pubDate') },
      });
    }
    return { items, meta: { skippedItems: skipped } };
  },
};
