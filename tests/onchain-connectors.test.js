// Offline tests for the on-chain and official-feed connectors (DefiLlama, NearBlocks, Sputnik DAOs, near.org feed).
// Fixtures in tests/fixtures/onchain were recorded from the live endpoints on 2026-11-06 and trimmed (docs in each connector). Failure cases are built from them.
// Time is frozen with mock timers where a record depends on "today" or on an age window. No test touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { assessRelevance } from '../src/relevance.js';
import { ALLOWED_HOSTS, guardedFetch } from '../src/http-client.js';
import { config } from '../src/config.js';
import { CONNECTORS } from '../src/connectors/index.js';
import { defillamaConnector } from '../src/connectors/defillama.js';
import { nearblocksConnector } from '../src/connectors/nearblocks.js';
import { sputnikConnector } from '../src/connectors/sputnik.js';
import { nearFeedConnector } from '../src/connectors/nearfeed.js';
import { memDb } from './helpers.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const raw = (n) => readFileSync(new URL(`./fixtures/onchain/${n}`, import.meta.url), 'utf8');
const fx = (n) => JSON.parse(raw(n));
const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function router(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [prefix, h] of routes) if (String(url).startsWith(prefix)) return typeof h === 'function' ? h(String(url), init) : h;
    throw new Error(`unrouted request in test: ${url}`);
  };
  fn.calls = calls; return fn;
}
const llama = (over = {}) => router([
  ['https://api.llama.fi/v2/chains', over.chains ?? (() => res(fx('defillama-chains.json')))],
  ['https://api.llama.fi/tvl/near-intents', over.tvl ?? (() => res(raw('defillama-tvl-near-intents.json')))],
  ['https://api.llama.fi/overview/dexs/near', over.dex ?? (() => res(fx('defillama-dexs-near.json')))],
]);
const nb = (over = {}) => router([
  ['https://api.nearblocks.io/v1/charts', over.charts ?? (() => res(fx('nearblocks-charts.json')))],
  ['https://api.nearblocks.io/v1/account/v1.signer/txns/count', over.signerCount ?? (() => res(fx('nearblocks-count-v1signer.json')))],
  ['https://api.nearblocks.io/v1/account/v1.signer/txns?', over.signerLast ?? (() => res(fx('nearblocks-txns-v1signer-1.json')))],
  ['https://api.nearblocks.io/v1/account/intents.near/txns/count', over.intentsCount ?? (() => res(fx('nearblocks-count-intents.json')))],
]);
const sput = (ids = Object.keys(fx('sputnik-rpc.json'))) => {
  const f = fx('sputnik-rpc.json');
  return router([['https://rpc.mainnet.fastnear.com', (u, init) => {
    const p = JSON.parse(init.body).params; const d = f[p.account_id];
    if (!d || !ids.includes(p.account_id)) return res({ jsonrpc: '2.0', id: 1, error: { code: -429, message: 'Rate limits exceeded' } });
    return res(p.request_type === 'view_account' ? d.account : d.lastProposal);
  }]]);
};
const feed = (body = raw('near-feed.xml')) => router([['https://near.org/feed.xml', () => res(body)]]);

test('defillama: reads chain TVL, NEAR Intents TVL and DEX volume into ONE usage record tagged intents, with the real numbers', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = llama(); const { items, meta } = await defillamaConnector.fetch({ fetchImpl: f });
  assert.equal(items.length, 1); const it = items[0];
  assert.equal(it.kind, 'usage'); assert.deepEqual(it.forceTags, ['intents']); assert.equal(it.externalId, 'defillama:near:2026-11-06');
  const dex = fx('defillama-dexs-near.json'); const near = fx('defillama-chains.json').find((c) => c.name === 'Near');
  assert.equal(it.signals.intentsTvlUsd, Number(raw('defillama-tvl-near-intents.json'))); assert.equal(it.signals.nearChainTvlUsd, near.tvl);
  assert.equal(it.signals.nearDexVolume24hUsd, dex.total24h); assert.equal(it.signals.nearDexVolume7dUsd, dex.total7d);
  assert.match(it.title, /^On-chain: NEAR Intents TVL \$\d+\.\d\dM \(DefiLlama\), 2026-11-06$/);
  assert.match(it.body, /across the chains it supports/); assert.match(it.body, /Source: DefiLlama/);
  assert.equal(meta.partial, false); assert.equal(f.calls.length, 3); assert.ok(f.calls.every((c) => c.url.startsWith('https://api.llama.fi/')));
});

test('defillama: one failing endpoint gives a partial record that only states what was read; all failing is an error, never a made-up number', async () => {
  const part = await defillamaConnector.fetch({ fetchImpl: llama({ dex: () => res('nope', 502) }) });
  assert.equal(part.meta.partial, true); assert.match(part.meta.errors[0], /dex volume/); assert.doesNotMatch(part.items[0].body, /DEX volume/); assert.equal(part.items[0].signals.nearDexVolume24hUsd, null);
  const bad = llama({ chains: () => res([{ name: 'Ethereum', tvl: 1 }]), tvl: () => res('"x"'), dex: () => res({ total24h: 'a' }) });
  await assert.rejects(() => defillamaConnector.fetch({ fetchImpl: bad }), /no usable number/);
  await assert.rejects(() => defillamaConnector.fetch({ fetchImpl: llama({ tvl: () => res('<html>', 200), chains: () => res('<html>'), dex: () => res('<html>') }) }), /no usable number/);
});

test('nearblocks: a completed chart day becomes network context records without a topic tag; today\'s partial row is ignored; signer and intents counts become signing and intents records', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const charts = fx('nearblocks-charts.json'); const last = charts.charts.at(-1);
  const withToday = { charts: [...charts.charts, { ...last, date: '2026-11-06T00:00:00.000Z', new_accounts: '3', active_accounts: '4', new_contracts: '0', active_contracts: '1', txns: '5' }] };
  const f = nb({ charts: () => res(withToday) }); const { items, meta } = await nearblocksConnector.fetch({ fetchImpl: f });
  assert.equal(items.length, 4); assert.equal(meta.partial, false);
  const w = items.find((i) => i.externalId.startsWith('nearblocks:accounts:')); assert.equal(w.forceTags, undefined, 'network-wide chart numbers do not corroborate any single topic');
  assert.equal(w.signals.date, last.date.slice(0, 10)); assert.equal(w.signals.newAccounts, Number(last.new_accounts)); assert.equal(w.signals.activeAccounts, Number(last.active_accounts));
  assert.match(w.body, /Source: NearBlocks/); assert.notEqual(w.signals.newAccounts, 3);
  const d = items.find((i) => i.externalId.startsWith('nearblocks:contracts:')); assert.equal(d.forceTags, undefined);
  assert.equal(d.signals.newContracts, Number(last.new_contracts)); assert.equal(d.signals.newContracts30d, charts.charts.slice(-30).reduce((a, r) => a + Number(r.new_contracts), 0));
  const s = items.find((i) => i.forceTags?.[0] === 'signing'); assert.equal(s.signals.txnCount, Number(fx('nearblocks-count-v1signer.json').txns[0].count));
  assert.equal(s.signals.latestAt, Math.floor(fx('nearblocks-txns-v1signer-1.json').txns[0].receipt_block.block_timestamp / 1e6));
  const i = items.find((x) => x.forceTags?.[0] === 'intents'); assert.equal(i.signals.txnCount, Number(fx('nearblocks-count-intents.json').txns[0].count)); assert.equal(i.signals.account, 'intents.near');
  assert.equal(f.calls.length, 4); assert.ok(f.calls.every((c) => c.url.startsWith('https://api.nearblocks.io/v1/')));
});

test('nearblocks: HTTP 429 or junk on some calls leaves a partial result; nothing usable is an error', async () => {
  const p = await nearblocksConnector.fetch({ fetchImpl: nb({ signerCount: () => res('slow down', 429), intentsCount: () => res({ txns: [{ count: 'many' }] }) }) });
  assert.equal(p.items.length, 2); assert.equal(p.meta.partial, true); assert.equal(p.meta.errors.length, 2);
  const nonNumeric = fx('nearblocks-charts.json'); nonNumeric.charts.at(-1).new_accounts = 'n/a';
  const q = await nearblocksConnector.fetch({ fetchImpl: nb({ charts: () => res(nonNumeric) }) });
  assert.equal(q.items.length, 2, 'non-numeric chart fields drop both chart records instead of storing zeros'); assert.match(q.meta.errors[0], /charts: non-numeric/);
  const dead = nb({ charts: () => res('x', 503), signerCount: () => res('x', 503), intentsCount: () => res('x', 503) });
  await assert.rejects(() => nearblocksConnector.fetch({ fetchImpl: dead }), /no usable number/);
});

test('sputnik: DAO balances and proposal counts from RPC views become one treasury usage record; a DAO that fails is skipped', async () => {
  const f = sput(); const { items, meta } = await sputnikConnector.fetch({ fetchImpl: f });
  assert.equal(items.length, 1); const it = items[0]; assert.deepEqual(it.forceTags, ['treasury']);
  assert.equal(it.signals.daos.length, 3); assert.equal(meta.partial, true, 'two of the five configured DAOs are not in the fixture and answer 429');
  const fixture = fx('sputnik-rpc.json'); const ref = it.signals.daos.find((d) => d.id === 'ref-finance.sputnik-dao.near');
  assert.equal(ref.yocto, fixture['ref-finance.sputnik-dao.near'].account.result.amount); assert.equal(ref.proposals, JSON.parse(Buffer.from(fixture['ref-finance.sputnik-dao.near'].lastProposal.result.result).toString()));
  assert.match(it.body, /native balance/); assert.ok(f.calls.every((c) => c.url === 'https://rpc.mainnet.fastnear.com'));
  await assert.rejects(() => sputnikConnector.fetch({ fetchImpl: sput(['ref-finance.sputnik-dao.near']) }), /only 1 of 5 DAOs/);
});

test('near-official: RSS items become kind news with org near-official; bad links, bad dates and old items are not stored', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { items } = await nearFeedConnector.fetch({ fetchImpl: feed() });
  assert.ok(items.length >= 5); assert.ok(items.every((i) => i.kind === 'news' && i.org === 'near-official' && /^https:\/\/www\.near\.org\//.test(i.url)));
  assert.ok(items.some((i) => /Chain Signatures Now Run Entirely Inside TEEs/.test(i.title)));
  const xml = raw('near-feed.xml');
  const evil = xml.replace('</channel>', '<item><title>x</title><link>https://evil.example/near</link><guid>g1</guid><pubDate>Tue, 03 Nov 2026 12:00:00 GMT</pubDate><description>d</description></item><item><title>y</title><link>https://www.near.org/blog/y</link><guid>g2</guid><pubDate>not a date</pubDate></item><item><title>old</title><link>https://www.near.org/blog/old</link><guid>g3</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel>');
  const r = await nearFeedConnector.fetch({ fetchImpl: feed(evil) });
  assert.equal(r.items.length, items.length); assert.equal(r.meta.skippedItems, 2, 'foreign host and unparsable date are counted; the 2024 item is simply outside the window');
  await assert.rejects(() => nearFeedConnector.fetch({ fetchImpl: feed('<html>not rss</html>') }), /not an RSS document/);
});

test('official feed items pass relevance as NEAR and get topic tags; the same text without the org is not NEAR on its own', () => {
  const text = { title: 'Introducing NEAR Business: The Confidential Multisig Treasury for Crypto-Native Teams', body: 'A multisig treasury with policies.' };
  const a = assessRelevance({ ...text, org: 'near-official' }); assert.ok(a.isNear); assert.ok(a.tags.includes('treasury')); assert.ok(a.reasons.some((r) => /official NEAR feed/.test(r)));
  const b = assessRelevance({ ...text, org: null }); assert.equal(b.isNear, false);
});

test('ingest: on-chain records are stored as usage, news as news; a scheduled tick inside minIntervalMs does not call the network, a manual run does', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = await memDb(); await registerSources(db, [defillamaConnector, nearFeedConnector]);
  const f = router([['https://api.llama.fi/v2/chains', () => res(fx('defillama-chains.json'))], ['https://api.llama.fi/tvl/near-intents', () => res(raw('defillama-tvl-near-intents.json'))], ['https://api.llama.fi/overview/dexs/near', () => res(fx('defillama-dexs-near.json'))], ['https://near.org/feed.xml', () => res(raw('near-feed.xml'))]]);
  assert.equal((await ingestSource(db, defillamaConnector, { fetchImpl: f, trigger: 'cron' })).status, 'ok');
  assert.equal((await ingestSource(db, nearFeedConnector, { fetchImpl: f, trigger: 'cron' })).status, 'ok');
  const kinds = await db.all('SELECT source_id, kind, COUNT(*) n FROM evidence GROUP BY source_id, kind'); const k = Object.fromEntries(kinds.map((r) => [r.source_id, r.kind]));
  assert.equal(k['defillama-near'], 'usage'); assert.equal(k['near-official'], 'news');
  const calls = f.calls.length; const runs = (await db.get('SELECT COUNT(*) n FROM ingest_runs')).n;
  const again = await ingestSource(db, defillamaConnector, { fetchImpl: f, trigger: 'cron' });
  assert.equal(again.status, 'fresh'); assert.ok(again.nextInMs > 0 && again.nextInMs <= defillamaConnector.minIntervalMs); assert.equal(f.calls.length, calls); assert.equal((await db.get('SELECT COUNT(*) n FROM ingest_runs')).n, runs, 'a skipped tick leaves no run row');
  t.mock.timers.tick(3_600_001);
  assert.equal((await ingestSource(db, defillamaConnector, { fetchImpl: f, trigger: 'cron' })).status, 'ok', 'after the interval it runs again');
  assert.equal((await ingestSource(db, defillamaConnector, { fetchImpl: f, trigger: 'manual' })).status, 'ok', 'a manual run is never skipped');
});

test('a failing on-chain source is an error with its message and stores nothing', async () => {
  const db = await memDb(); await registerSources(db, [nearblocksConnector]);
  const down = router([['https://api.nearblocks.io/', () => res('bad gateway', 502)]]);
  const r = await ingestSource(db, nearblocksConnector, { fetchImpl: down, trigger: 'manual' });
  assert.equal(r.status, 'error'); assert.match(r.error, /no usable number/);
  assert.equal((await db.get('SELECT COUNT(*) n FROM evidence')).n, 0); assert.equal((await db.get("SELECT status FROM sources WHERE id='nearblocks'")).status, 'error');
});

test('scoring: usage records corroborate only the topics they are tagged with; news adds competitor links and a warning and never counts as demand or usage', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = await memDb(); const demand = (id, topicWord) => db.run(`INSERT INTO evidence(id,source_id,external_id,canonical_url,observed_at,published_at,author,title,body_excerpt,content_hash,raw_ref,license,relevance,relevance_reasons,tags,kind,flags,signals) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, 'github-near', id, 'https://x', NOW, NOW - 864e5, `u${id}`, `${topicWord} is broken`, 'cannot do it', `h${id}`, 'r', '', 0.9, '[]', JSON.stringify(['signing', 'treasury']), 'demand', '[]', '{}']);
  await registerSources(db, CONNECTORS); await demand('d1', 'wallet'); await demand('d2', 'wallet');
  const before = await refreshOpportunities(db); const bw = before.find((o) => o.topic === 'signing'); const bt = before.find((o) => o.topic === 'treasury');
  assert.ok(bw.warnings.some((w) => /No on-chain usage corroboration/.test(w)));
  const f = router([
    ['https://api.nearblocks.io/v1/charts', () => res(fx('nearblocks-charts.json'))], ['https://api.nearblocks.io/v1/account/v1.signer/txns/count', () => res(fx('nearblocks-count-v1signer.json'))],
    ['https://api.nearblocks.io/v1/account/v1.signer/txns?', () => res(fx('nearblocks-txns-v1signer-1.json'))], ['https://api.nearblocks.io/v1/account/intents.near/txns/count', () => res(fx('nearblocks-count-intents.json'))],
    ['https://near.org/feed.xml', () => res(raw('near-feed.xml'))]]);
  await ingestSource(db, nearblocksConnector, { fetchImpl: f, trigger: 'manual' });
  const mid = await refreshOpportunities(db); const mw = mid.find((o) => o.topic === 'signing'); const mt = mid.find((o) => o.topic === 'treasury');
  assert.ok(!mw.warnings.some((w) => /No on-chain usage corroboration/.test(w)), 'chain signatures contract usage is a direct measure of signing');
  assert.ok(mt.warnings.some((w) => /No on-chain usage corroboration/.test(w)), 'treasury has no NearBlocks record, so it stays uncorroborated');
  assert.ok(mw.components.onchain_corroboration === 1 && mt.components.onchain_corroboration === 0);
  await ingestSource(db, nearFeedConnector, { fetchImpl: f, trigger: 'manual' });
  const after = await refreshOpportunities(db); const at = after.find((o) => o.topic === 'treasury'); const aw = after.find((o) => o.topic === 'signing');
  assert.equal(at.confidence, mt.confidence); assert.equal(aw.confidence, mw.confidence);
  // News never counts as demand or usage. If its text names an existing product it can add a competitor hit, which moves only the competition_gap component.
  for (const k of Object.keys(aw.components)) if (k !== 'competition_gap') assert.equal(aw.components[k], mw.components[k], k);
  assert.ok(at.warnings.some((w) => /official NEAR announcement/.test(w)), 'NEAR Business (confidential multisig treasury) is in the feed');
  const links = await db.all("SELECT l.relation, l.note FROM evidence_links l JOIN evidence e ON e.id=l.evidence_id WHERE l.opportunity_id='opp_treasury' AND e.kind='news'");
  assert.ok(links.length >= 1 && links.every((l) => l.relation === 'competitor' && /official NEAR announcement/.test(l.note)));
  assert.equal(at.counts.demand, bt.counts.demand); assert.equal(at.counts.sourcesNonSocial, bt.counts.sourcesNonSocial);
  void bw;
});

test('hardening: new hosts are allowlisted for the collector only; a lookalike host, an oversized body, a timeout and bad JSON are refused', async () => {
  for (const h of ['api.llama.fi', 'api.nearblocks.io', 'near.org', 'rpc.mainnet.fastnear.com']) assert.ok(ALLOWED_HOSTS.collector.has(h), h);
  for (const role of ['monitor', 'launch', 'llm', 'credentialed']) for (const h of ['api.llama.fi', 'api.nearblocks.io', 'near.org']) assert.ok(!ALLOWED_HOSTS[role].has(h), `${role} must not reach ${h}`);
  await assert.rejects(() => guardedFetch('collector', 'https://api.llama.fi.evil.example/tvl/near-intents', { fetchImpl: async () => res('1') }), /policy/);
  await assert.rejects(() => guardedFetch('collector', 'http://api.llama.fi/tvl/near-intents', { fetchImpl: async () => res('1') }), /policy/);
  const huge = async () => new Response('1'.repeat(4_100_000), { status: 200 });
  await assert.rejects(() => defillamaConnector.fetch({ fetchImpl: huge }), /no usable number/);
  const slow = async (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(() => guardedFetch('collector', 'https://api.llama.fi/v2/chains', { fetchImpl: slow, timeoutMs: 20 }), /timeout after 20ms/);
  await assert.rejects(() => nearFeedConnector.fetch({ fetchImpl: router([['https://near.org/feed.xml', () => new Response('x'.repeat(4_100_000))]]) }), /too large/);
});

test('mainnet RPC default is FastNEAR (rpc.mainnet.near.org answers 429 "deprecated" to every call) and every new connector has the registry fields', () => {
  assert.equal(config.near.mainnetRpc, 'https://rpc.mainnet.fastnear.com');
  for (const c of [defillamaConnector, nearblocksConnector, sputnikConnector, nearFeedConnector]) {
    for (const k of ['id', 'name', 'kind', 'endpoint', 'terms', 'rateLimit', 'docsUrl']) assert.ok(c[k], `${c.id}.${k}`);
    assert.ok(c.minIntervalMs >= 3_600_000, `${c.id} declares a minimum interval`); assert.ok(CONNECTORS.includes(c));
  }
  assert.equal(new Set(CONNECTORS.map((c) => c.id)).size, CONNECTORS.length);
});
