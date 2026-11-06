import { guardedFetch } from '../http-client.js';
import { config } from '../config.js';

// Each query is one Search API request. Unauthenticated search is limited to 10 req/min (docs: docs.github.com/rest/search#rate-limit).
const QUERIES = [
  'treasury OR multisig OR payroll OR rebalance',
  'intents OR solver OR swap OR slippage',
  '"chain signatures" OR "key custody" OR "access key"',
  'wallet OR onboarding OR "account creation"',
  'rpc OR indexer OR "rate limit" OR archival',
  'sdk OR cli OR sandbox OR workspaces',
];

export const githubConnector = {
  id: 'github-near',
  name: 'GitHub issues · near org',
  kind: 'demand',
  endpoint: 'https://api.github.com/search/issues',
  terms: 'GitHub ToS / REST API terms; issue text is user-authored public content, stored as excerpts with source link.',
  rateLimit: '10 search req/min unauthenticated, 30/min with token; we issue ≤6 per run',
  docsUrl: 'https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests',
  subSources: () => QUERIES.map((q) => `query: ${q}`),
  async fetch(ctx = {}) {
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const items = [];
    let remaining = null;
    for (const q of QUERIES) {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(`org:near is:issue is:open updated:>=${since} (${q})`)}&sort=updated&order=desc&per_page=30`;
      const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
      if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
      const res = await guardedFetch('collector', url, { headers, fetchImpl: ctx.fetchImpl });
      remaining = res.headers.get('x-ratelimit-remaining');
      const data = JSON.parse(res.text);
      for (const it of data.items ?? []) {
        items.push({
          externalId: String(it.id),
          url: it.html_url,
          publishedAt: Date.parse(it.created_at),
          author: it.user?.login ?? '',
          authorType: it.user?.type ?? '',
          title: it.title,
          body: it.body ?? '',
          org: 'near',
          kind: 'demand',
          license: 'repo license / GitHub ToS (excerpt + link only)',
          signals: { comments: it.comments, reactions: it.reactions?.total_count ?? 0, repo: it.repository_url?.split('/').slice(-2).join('/') },
          raw: it,
        });
      }
      if (remaining !== null && Number(remaining) <= 1) break; // stay under the limit
    }
    return { items, meta: { rateLimitRemaining: remaining } };
  },
};
