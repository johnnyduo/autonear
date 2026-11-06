import { guardedFetch } from '../http-client.js';

const QUERIES = ['"NEAR Protocol"', '"NEAR Intents"', 'nearcore', 'near-sdk', '"chain signatures" NEAR'];
const stripHtml = (h = '') => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export const hnConnector = {
  id: 'hn-algolia',
  name: 'Hacker News · Algolia',
  kind: 'demand',
  endpoint: 'https://hn.algolia.com/api/v1/search_by_date',
  terms: 'HN content is user-authored; Algolia HN Search API is public. Stored as excerpts with link to the original item.',
  rateLimit: '10,000 req/hour per IP (Algolia HN API docs); we issue ≤5 per run',
  docsUrl: 'https://hn.algolia.com/api',
  subSources: () => QUERIES.map((q) => `query: ${q}`),
  async fetch(ctx = {}) {
    const since = Math.floor(Date.now() / 1000) - 120 * 86400;
    const items = [];
    for (const q of QUERIES) {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=40`;
      const res = await guardedFetch('collector', url, { fetchImpl: ctx.fetchImpl });
      for (const h of JSON.parse(res.text).hits ?? []) {
        const isComment = h._tags?.includes('comment');
        items.push({
          externalId: String(h.objectID),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          publishedAt: (h.created_at_i ?? 0) * 1000,
          author: h.author ?? '',
          title: stripHtml(h.title || h.story_title || `Comment on: ${h.story_title ?? ''}`),
          body: stripHtml(h.comment_text || h.story_text || ''),
          org: null,
          kind: 'demand',
          license: 'user-authored HN content (excerpt + link only)',
          signals: { points: h.points ?? 0, comments: h.num_comments ?? 0, type: isComment ? 'comment' : 'story' },
          raw: h,
        });
      }
    }
    return { items };
  },
};
