import { openDb } from '../src/db.js';
import { registerSources } from '../src/ingest.js';

export async function memDb() {
  const db = await openDb({ path: ':memory:' });
  await registerSources(db);
  return db;
}

/** A connector double that returns canned items. */
export function fakeConnector(id, items, { fail = false } = {}) {
  return {
    id, name: id, kind: 'demand', endpoint: 'https://example.invalid', terms: 't', rateLimit: 'r', docsUrl: 'https://example.invalid/docs',
    async fetch() { if (fail) throw new Error('boom'); return { items: typeof items === 'function' ? items() : items }; },
  };
}

export const gh = (n, over = {}) => ({
  externalId: String(n), url: `https://github.com/near/x/issues/${n}`, publishedAt: Date.now() - n * 864e5, author: `user${n}`, authorType: 'User',
  title: `Treasury multisig payout fails ${n}`, body: 'We cannot rebalance the DAO treasury: multisig approval is missing a policy.', org: 'near', kind: 'demand', license: 'x', signals: { repo: 'near/x' }, raw: { n }, ...over,
});
