import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { SCHEMA_V2 } from '../src/db.js';
import { memDb } from './helpers.js';

async function withEvidence(n = 150) {
  const db = await memDb();
  for (let i = 0; i < n; i++) {
    await db.run('INSERT INTO evidence(id,source_id,external_id,canonical_url,observed_at,published_at,title,content_hash,raw_ref) VALUES(?,?,?,?,?,?,?,?,?)', [`ev${i}`, 'github-near', `x${i}`, 'u', 1000 + i, 1000 + i, `t${i}`, 'h', 'r']);
  }
  return db;
}
const call = (app, path, init = {}) => app(new Request('http://x' + path, init)).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) }));

test('API: evidence limit/cursor are clamped integers (never negative, fractional or unbounded)', async () => {
  const app = createApp({ db: await withEvidence(), operatorToken: 't', defer: () => {} });
  for (const [q, expected] of [['limit=-5', 40], ['limit=0', 40], ['limit=1.5', 40], ['limit=abc', 40], ['limit=', 40], ['limit=7', 7], ['limit=100', 100], ['limit=100000', 100], ['limit=1e3', 100]]) {
    const r = await call(app, `/api/evidence?${q}`);
    assert.equal(r.status, 200, q);
    assert.equal(r.body.items.length, expected, q);
  }
  const bad = await call(app, '/api/evidence?cursor=-1&limit=3');
  assert.equal(bad.status, 200); assert.equal(bad.body.items.length, 3);
  // paging walks the whole set exactly once, newest first
  const seen = []; let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call(app, `/api/evidence?limit=40${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...r.body.items.map((e) => e.id)); cursor = r.body.nextCursor; if (!cursor) break;
  }
  assert.equal(seen.length, 150); assert.equal(new Set(seen).size, 150); assert.equal(seen[0], 'ev149');
});

test('API: wrong method on a known route is 405 with Allow; unknown route is 404; HEAD works without a body', async () => {
  const app = createApp({ db: await memDb(), operatorToken: 't', defer: () => {} });
  for (const [m, p, allow] of [['DELETE', '/api/health', 'GET'], ['POST', '/api/status', 'GET'], ['PUT', '/api/runs', 'POST'], ['GET', '/api/runs/run_abc/cancel', 'POST'], ['GET', '/api/ingest', 'POST'], ['POST', '/api/protocols', 'GET'], ['DELETE', '/api/decisions/dec_x', 'GET']]) {
    const r = await call(app, p, { method: m });
    assert.equal(r.status, 405, `${m} ${p}`);
    assert.ok(r.headers.get('allow').includes(allow), `${m} ${p} allow=${r.headers.get('allow')}`);
  }
  assert.equal((await call(app, '/api/nope')).status, 404);
  assert.equal((await call(app, '/api/runs/xyz')).status, 404);
  const head = await app(new Request('http://x/api/health', { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('API: unknown run events are 404, not an empty "terminal" run', async () => {
  const app = createApp({ db: await memDb(), operatorToken: 't', defer: () => {} });
  assert.equal((await call(app, '/api/runs/run_doesnotexist/events')).status, 404);
});

test('API: deploy-data for an approved decision with no attested build is a 404, not a 500', async () => {
  const db = await memDb();
  await db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES('dec_a','r','h','deploy_testnet','near-testnet','t','deploy','0',?, 'n','{}','ph','approved',1)", [Date.now() + 1e6]);
  const app = createApp({ db, operatorToken: 't', defer: () => {} });
  const r = await call(app, '/api/decisions/dec_a/deploy-data', { headers: { authorization: 'Bearer t' } });
  assert.equal(r.status, 404); assert.match(r.body.error, /attested artifact/);
});

test('db: list/lookup queries use indexes, and the v2 index script is idempotent', async () => {
  const db = await memDb();
  const plan = async (sql) => (await db.all('EXPLAIN QUERY PLAN ' + sql)).map((x) => x.detail).join(' | ');
  assert.match(await plan('SELECT * FROM evidence ORDER BY COALESCE(published_at,observed_at) DESC LIMIT 41'), /evidence_sortkey/);
  assert.match(await plan("SELECT * FROM evidence WHERE source_id='a' ORDER BY COALESCE(published_at,observed_at) DESC LIMIT 41"), /evidence_source_sortkey/);
  assert.match(await plan("SELECT * FROM evidence_links WHERE evidence_id='e'"), /evidence_links_by_evidence/);
  assert.match(await plan("SELECT * FROM artifacts WHERE hash='h'"), /artifacts_by_hash/);
  await db.exec(SCHEMA_V2); await db.exec(SCHEMA_V2);
});

test('status endpoint reports the latest ingest run per source in one pass', async () => {
  const db = await memDb();
  await db.run("INSERT INTO ingest_runs(source_id,trigger,started_at,status) VALUES('github-near','t',1,'ok'),('github-near','t',2,'error'),('hn-algolia','t',3,'ok')");
  const app = createApp({ db, operatorToken: 't', defer: () => {} });
  const r = await call(app, '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.find((s) => s.id === 'github-near').lastRun.status, 'error');
  assert.equal(r.body.sources.find((s) => s.id === 'hn-algolia').lastRun.started_at, 3);
});

test('rate limit key: spoofed forwarding headers are ignored unless a trusted proxy is declared', async () => {
  const hit = (app, headers) => app(new Request('http://x/api/health', { headers })).then((r) => r.status);
  const burn = async (app, mk) => { let limited = 0; for (let i = 0; i < 200; i++) if (await hit(app, mk(i)) === 429) limited++; return limited; };
  // Node default: a client rotating cf-connecting-ip / x-forwarded-for cannot dodge the limit.
  const node = createApp({ db: await memDb(), operatorToken: 't', defer: () => {} });
  assert.ok(await burn(node, (i) => ({ 'x-peer-ip': '203.0.113.5', 'cf-connecting-ip': `198.51.100.${i}`, 'x-forwarded-for': `192.0.2.${i}` })) > 0, 'spoofed headers must not give each request its own bucket');
  // Different real peers get different buckets.
  assert.equal(await hit(node, { 'x-peer-ip': '203.0.113.99' }), 200);
  // Workers: Cloudflare sets cf-connecting-ip, so distinct clients are distinct.
  const cf = createApp({ db: await memDb(), operatorToken: 't', defer: () => {}, trustCfIp: true });
  assert.equal(await burn(cf, (i) => ({ 'cf-connecting-ip': `198.51.100.${i}` })), 0);
});
