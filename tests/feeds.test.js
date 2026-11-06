// subSources() lists what each connector requests per run. These tests run each fetch() against a recording fetch double and compare the
// requests it made with the list, so the list cannot drift from the code. /api/status exposes the totals (counts.feeds, counts.scores).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { CONNECTORS } from '../src/connectors/index.js';
import { SEATS } from '../src/council.js';
import { setWatch } from '../src/watch.js';
import { githubConnector } from '../src/connectors/github.js';
import { govNearConnector } from '../src/connectors/govnear.js';
import { hnConnector } from '../src/connectors/hn.js';
import { nearRpcConnector } from '../src/connectors/nearrpc.js';
import { defillamaConnector } from '../src/connectors/defillama.js';
import { nearblocksConnector } from '../src/connectors/nearblocks.js';
import { sputnikConnector } from '../src/connectors/sputnik.js';
import { nearFeedConnector } from '../src/connectors/nearfeed.js';
import { nearSocialConnector, resetNearSocialCache } from '../src/connectors/nearsocial.js';
import { mastodonConnector } from '../src/connectors/mastodon.js';
import { devtoConnector } from '../src/connectors/devto.js';
import { farcasterConnector } from '../src/connectors/farcaster.js';
import { blueskyConnector, resetBlueskySession } from '../src/connectors/bluesky.js';
import { memDb } from './helpers.js';

const json = (body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** Records every request (url, parsed JSON body) and answers with whatever `answer(url, body)` returns. */
function recorder(answer) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return answer(String(url), body);
  };
  fn.calls = calls;
  return fn;
}
const q = (url, name) => new URL(url).searchParams.get(name);
const run = async (c, fetchImpl) => { try { await c.fetch({ fetchImpl }); } catch { /* only the requests matter here */ } };

const ENV_KEYS = ['SOCIAL_MAX_AGE_DAYS', 'MASTODON_INSTANCES', 'MASTODON_TAGS', 'DEVTO_TAGS', 'FARCASTER_FIDS', 'FARCASTER_CHANNELS', 'BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'];
let saved;
beforeEach(() => { resetBlueskySession(); resetNearSocialCache(); saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('every connector lists at least one sub-source by default, as non-empty strings without duplicates', () => {
  for (const c of CONNECTORS) {
    const feeds = c.subSources({});
    assert.ok(Array.isArray(feeds) && feeds.length > 0, `${c.id} lists none`);
    assert.ok(feeds.every((f) => typeof f === 'string' && f.trim() === f && f.length > 3), `${c.id} has a blank entry`);
    assert.equal(new Set(feeds).size, feeds.length, `${c.id} lists a feed twice`);
  }
});

test('search connectors: the list is the query list the fetch loop sends', async () => {
  const cases = [
    [hnConnector, () => json({ hits: [] }), (u) => q(u, 'query')],
    [govNearConnector, () => json({}), (u) => q(u, 'q').replace(/ order:latest$/, '')],
    [githubConnector, () => json({ items: [] }), (u) => q(u, 'q').match(/\((.*)\)$/)[1]],
  ];
  for (const [c, answer, queryOf] of cases) {
    const f = recorder(answer); await run(c, f);
    assert.deepEqual(f.calls.map((x) => `query: ${queryOf(x.url)}`), c.subSources(), c.id);
  }
  assert.ok(hnConnector.subSources().includes('query: "NEAR Protocol"'));
});

test('bluesky: the list is the search list, sent only once it is configured', async () => {
  process.env.BLUESKY_HANDLE = 'me.bsky.social'; process.env.BLUESKY_APP_PASSWORD = 'not-a-real-password';
  const f = recorder((url) => json(url.includes('createSession') ? { accessJwt: 'jwt' } : { posts: [] }));
  await run(blueskyConnector, f);
  const searches = f.calls.filter((x) => x.url.includes('searchPosts')).map((x) => `query: ${q(x.url, 'q')}`);
  assert.deepEqual(searches, blueskyConnector.subSources());
});

test('sputnik: one entry per DAO that is read', async () => {
  const f = recorder(() => json({ error: { message: 'down' } })); await run(sputnikConnector, f);
  const read = [...new Set(f.calls.map((x) => `dao: ${x.body.params.account_id}`))];
  assert.deepEqual(read, sputnikConnector.subSources());
  assert.ok(sputnikConnector.subSources().includes('dao: ref-finance.sputnik-dao.near'));
});

test('devto: DEVTO_TAGS changes the list and the requests, invalid tags are dropped from both', async () => {
  assert.deepEqual(devtoConnector.subSources({}), ['tag: nearprotocol', 'tag: near']);
  const env = { DEVTO_TAGS: '#DeFi, near, bad tag!, x' };
  assert.deepEqual(devtoConnector.subSources(env), ['tag: defi', 'tag: near']);
  process.env.DEVTO_TAGS = env.DEVTO_TAGS;
  const f = recorder(() => json([])); await run(devtoConnector, f);
  assert.deepEqual(f.calls.map((x) => `tag: ${q(x.url, 'tag')}`), devtoConnector.subSources());
});

test('farcaster: channels and the FID watchlist follow FARCASTER_CHANNELS and FARCASTER_FIDS', async () => {
  assert.deepEqual(farcasterConnector.subSources({}), ['channel: near']);
  const env = { FARCASTER_CHANNELS: '/near, base, Not Valid!', FARCASTER_FIDS: '3, 0, abc, 12' };
  assert.deepEqual(farcasterConnector.subSources(env), ['channel: near', 'channel: base', 'fid: 3', 'fid: 12']);
  Object.assign(process.env, env);
  const f = recorder(() => json({ messages: [] })); await run(farcasterConnector, f);
  assert.equal(f.calls.length, 4);
  const asked = f.calls.map((x) => (x.url.includes('castsByParent') ? `channel: ${decodeURIComponent(q(x.url, 'url')).split('/').pop()}` : `fid: ${q(x.url, 'fid')}`));
  assert.deepEqual(asked, farcasterConnector.subSources());
});

test('mastodon: one entry per tag on each instance, following MASTODON_INSTANCES and MASTODON_TAGS', async () => {
  assert.deepEqual(mastodonConnector.subSources({}), [
    'tag: nearprotocol on mastodon.social', 'tag: nearintents on mastodon.social', 'tag: near on mastodon.social',
    'tag: nearprotocol on mastodon.online', 'tag: nearintents on mastodon.online', 'tag: near on mastodon.online',
  ]);
  const env = { MASTODON_INSTANCES: 'mastodon.social', MASTODON_TAGS: '#nearcon,nearprotocol' };
  assert.deepEqual(mastodonConnector.subSources(env), ['tag: nearcon on mastodon.social', 'tag: nearprotocol on mastodon.social']);
  Object.assign(process.env, env);
  const f = recorder(() => json([])); await run(mastodonConnector, f);
  const asked = f.calls.map((x) => { const u = new URL(x.url); return `tag: ${u.pathname.split('/').pop()} on ${u.host}`; });
  assert.deepEqual(asked, mastodonConnector.subSources());
});

test('defillama: one entry per series requested', async () => {
  const f = recorder((url) => json(url.endsWith('/v2/chains') ? [] : url.includes('/tvl/') ? 5 : { total24h: 1, total7d: 2 })); await run(defillamaConnector, f);
  const feeds = defillamaConnector.subSources();
  assert.equal(f.calls.length, feeds.length);
  for (const x of f.calls) assert.ok(feeds.some((e) => e.endsWith(`(${new URL(x.url).pathname})`)), x.url);
});

test('nearblocks: one entry per request (the newest-transaction call follows a successful count)', async () => {
  const f = recorder((url) => json(url.includes('/count') ? { txns: [{ count: '5' }] } : {})); await run(nearblocksConnector, f);
  const feeds = nearblocksConnector.subSources();
  assert.equal(f.calls.length, feeds.length);
  for (const x of f.calls) { const u = new URL(x.url); assert.ok(feeds.some((e) => e.endsWith(`(${u.pathname.replace('/v1', '')}${u.search})`)), x.url); }
});

test('near rpc: one entry per view call', async () => {
  const bytes = [...Buffer.from('"1"')];
  const f = recorder((url, body) => json({ result: body.method === 'gas_price' ? { gas_price: '1' } : body.params.request_type === 'view_account' ? { amount: '1', storage_usage: 1, block_height: 1 } : { result: bytes, block_height: 1 } }));
  await nearRpcConnector.fetch({ fetchImpl: f });
  const feeds = nearRpcConnector.subSources();
  assert.equal(f.calls.length, feeds.length);
  const seen = f.calls.map((x) => x.body.params?.account_id ?? x.body.method).sort();
  assert.deepEqual(seen, ['17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'gas_price', 'intents.near', 'wrap.near']);
});

test('near social: one entry per index read', async () => {
  const f = recorder((url, body) => json(url.includes('/index') ? [] : { result: { header: { height: 100, timestamp_nanosec: '1700000000000000000' } } })); await run(nearSocialConnector, f);
  assert.deepEqual(f.calls.filter((x) => x.url.endsWith('/index')).map((x) => `index: social.near ${x.body.action}s`), nearSocialConnector.subSources());
});

test('near official feed: the single feed that is fetched', async () => {
  const f = recorder(() => new Response('<rss></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } })); await run(nearFeedConnector, f);
  assert.deepEqual(f.calls.map((x) => `feed: ${new URL(x.url).host}${new URL(x.url).pathname}`), nearFeedConnector.subSources());
});

test('/api/status: feeds counts the sub-sources of enabled sources, scores adds relevance scores, seat votes and council scores', async () => {
  const db = await memDb();
  for (let i = 0; i < 3; i++) await db.run('INSERT INTO opportunities(id,title,thesis,problem,audience,topic,score_breakdown,score,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [`opp_${i}`, `T${i}`, 'x', 'y', 'z', `t${i}`, '{}', 0.5, 0.5, 1, 1]);
  for (let i = 0; i < 5; i++) await db.run("INSERT INTO evidence(id,source_id,external_id,canonical_url,observed_at,title,body_excerpt,content_hash,raw_ref,relevance,tags,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [`ev_${i}`, 'github-near', `e${i}`, `https://github.com/near/x/issues/${i}`, 1, 't', 'b', `h${i}`, `r${i}`, 0.5, '[]', 'demand']);
  const app = createApp({ db, operatorToken: 't', defer: () => {} });
  const get = async () => (await app(new Request('http://x/api/status'))).json();
  const st = await get();
  const enabled = CONNECTORS.filter((c) => (c.availability?.().status ?? 'ready') === 'ready');
  assert.ok(!enabled.some((c) => c.id === 'bluesky'), 'bluesky is not configured in this test');
  assert.equal(st.counts.feeds, enabled.reduce((n, c) => n + c.subSources().length, 0));
  assert.equal(st.counts.seats, SEATS.length);
  assert.equal(st.counts.seatVotes, 3 * SEATS.length);
  assert.equal(st.counts.scores, 5 + 3 * SEATS.length + 3);
  assert.equal(st.counts.evidence, 5); assert.equal(st.counts.opportunities, 3);
  const gh = st.sources.find((s) => s.id === 'github-near');
  assert.deepEqual(gh.subSources, githubConnector.subSources()); assert.equal(gh.watched, true);
  const bs = st.sources.find((s) => s.id === 'bluesky');
  assert.ok(bs.subSources.length > 0 && bs.watched === false, 'listed, but not counted while it is not configured');

  await setWatch(db, { sources: { 'github-near': false } }, 'test');
  const off = await get();
  assert.equal(off.counts.feeds, st.counts.feeds - githubConnector.subSources().length, 'a source the owner switched off is not counted');
  assert.equal(off.sources.find((s) => s.id === 'github-near').watched, false);
});

test('/api/status: a source row without a connector reports no sub-sources', async () => {
  const db = await memDb();
  await db.run("INSERT INTO sources(id,name,kind,endpoint,terms,rate_limit,docs_url) VALUES('gone','Gone','demand','https://example.invalid','t','r','https://example.invalid')");
  const st = await (await createApp({ db, operatorToken: 't', defer: () => {} })(new Request('http://x/api/status'))).json();
  assert.deepEqual(st.sources.find((s) => s.id === 'gone').subSources, []);
});
