import { guardedFetch } from '../http-client.js';

const QUERIES = ['treasury', 'multisig', 'intents', 'chain signatures', 'wallet'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (h = '') => h.replace(/<[^>]+>/g, ' ').replace(/&hellip;/g, '…').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export const govNearConnector = {
  id: 'gov-near',
  name: 'NEAR Governance Forum',
  kind: 'demand',
  endpoint: 'https://gov.near.org/search.json',
  terms: 'Public Discourse forum; content is community-authored. Stored as excerpts with a link to the original post.',
  rateLimit: 'Discourse default anonymous API limits (~20 req/10s per IP); we issue ≤5 per run, 1.5s apart; stop early on HTTP 429',
  docsUrl: 'https://docs.discourse.org/#tag/Search',
  subSources: () => QUERIES.map((q) => `query: ${q}`),
  async fetch(ctx = {}) {
    const items = [];
    let partial = false;
    for (const [i, q] of QUERIES.entries()) {
      if (i) await sleep(ctx.fetchImpl ? 0 : 1500);
      let res;
      try { res = await guardedFetch('collector', `https://gov.near.org/search.json?q=${encodeURIComponent(q + ' order:latest')}`, { fetchImpl: ctx.fetchImpl }); }
      catch (e) { if (e.status === 429 && items.length) { partial = true; break; } throw e; }
      const d = JSON.parse(res.text);
      const titles = new Map((d.topics ?? []).map((t) => [t.id, t.title]));
      for (const p of d.posts ?? []) {
        items.push({
          externalId: String(p.id),
          url: `https://gov.near.org/t/${p.topic_id}/${p.post_number}`,
          publishedAt: Date.parse(p.created_at),
          author: p.username ?? '',
          title: titles.get(p.topic_id) ?? `Post in topic ${p.topic_id}`,
          body: clean(p.blurb),
          org: 'near-gov',
          kind: 'demand',
          license: 'community content on gov.near.org (excerpt + link only)',
          signals: { likes: p.like_count ?? 0, postNumber: p.post_number, topicId: p.topic_id },
          raw: p,
        });
      }
    }
    return { items, meta: { partial } };
  },
};
