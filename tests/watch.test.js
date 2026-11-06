import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ingestSource } from '../src/ingest.js';
import { getWatch, setWatch, sanitizeWatch, applyWatch } from '../src/watch.js';
import { assessRelevance } from '../src/relevance.js';
import { memDb, fakeConnector, gh } from './helpers.js';

const ids = ['github-near', 'hn'];
const evTags = async (db) => (await db.all('SELECT id,tags,relevance,flags FROM evidence')).map((r) => ({ ...r, tags: JSON.parse(r.tags), flags: JSON.parse(r.flags) }));

test('sanitizes and bounds lists', async () => {
  const c = sanitizeWatch({ keywords: ['  Intents  ', 'intents', '<script>alert(1)</script>', 'x', 'a'.repeat(200), 5, null], excludes: ['Price\u0000 pump'], hackathons: ['NEAR\nAI'], sources: { 'github-near': false, hn: true } }, ids);
  assert.ok(c.keywords.includes('intents')); assert.equal(c.keywords.filter((k) => k === 'intents').length, 1);
  assert.ok(!c.keywords.some((k) => /[<>]/.test(k)), 'markup stripped');
  assert.ok(c.keywords.every((k) => k.length >= 2 && k.length <= 60), 'bounded');
  assert.equal(new Set(c.keywords).size, c.keywords.length, 'deduped');
  assert.deepEqual(c.excludes, ['price pump']); assert.deepEqual(c.hackathons, ['near ai']);
  assert.deepEqual(c.sources, { 'github-near': false }, 'only disabled sources are stored');
  assert.throws(() => sanitizeWatch({ keywords: Array.from({ length: 41 }, (_, i) => `kw${i}`) }, ids), /at most 40/);
  assert.throws(() => sanitizeWatch({ keywords: 'nope' }, ids), /must be a list/);
  assert.throws(() => sanitizeWatch([], ids), /object/);
});

test('unknown source id rejected', async () => {
  const db = await memDb();
  await assert.rejects(setWatch(db, { sources: { 'evil-source': false } }, 'test', { sourceIds: ids }), /unknown source/);
  await assert.rejects(setWatch(db, { sources: { hn: 'no' } }, 'test', { sourceIds: ids }), /true or false/);
});

test('keyword match tags and slightly boosts a NEAR record, and an exclude filters one', async () => {
  const db = await memDb();
  await setWatch(db, { keywords: ['multisig'], excludes: ['rebalance the dao'] }, 'test', { sourceIds: ids });
  await ingestSource(db, fakeConnector('github-near', [gh(1, { title: 'Multisig approval policy missing', body: 'near multisig issue' }), gh(2)]));
  const rows = await evTags(db);
  assert.equal(rows.length, 1, 'gh(2) contains "rebalance the DAO treasury" -> excluded');
  assert.ok(rows[0].tags.includes('watch:multisig'));
});

test('keyword cannot make a non-NEAR record near; flags survive', async () => {
  const rel = assessRelevance({ title: 'Treasury multisig for my bakery', body: 'we sit near the river and need a multisig', url: 'https://example.com/x', org: null, author: 'a', authorType: 'User' });
  assert.equal(rel.isNear, false);
  const w = applyWatch(rel, 'Treasury multisig for my bakery near the river', { keywords: ['multisig'], excludes: [], hackathons: [], sources: {} });
  assert.equal(w.rel.isNear, false); assert.equal(w.drop, false);
  const inj = { score: 0.9, isNear: true, reasons: [], tags: [], flags: ['prompt-injection:ignore'] };
  assert.deepEqual(applyWatch(inj, 'multisig', { keywords: ['multisig'], excludes: [], hackathons: [], sources: {} }).rel.flags, ['prompt-injection:ignore']);
});

test('excludes match on word boundaries, not substrings', () => {
  const rel = { score: 0.9, isNear: true, reasons: [], tags: [], flags: [] };
  assert.equal(applyWatch(rel, 'the nearly done project', { excludes: ['near'], keywords: [], hackathons: [] }).drop, false);
  assert.equal(applyWatch(rel, 'price pump incoming', { excludes: ['price pump'], keywords: [], hackathons: [] }).drop, true);
});

test('disabled source is skipped without touching the network, and reported', async () => {
  const db = await memDb();
  await setWatch(db, { sources: { 'github-near': false } }, 'test', { sourceIds: ids });
  let called = false;
  const c = fakeConnector('github-near', () => { called = true; return [gh(1)]; });
  const r = await ingestSource(db, c);
  assert.equal(r.status, 'disabled_by_owner'); assert.equal(called, false);
  assert.equal((await db.get("SELECT status FROM sources WHERE id='github-near'")).status, 'disabled_by_owner');
  await setWatch(db, { sources: {} }, 'test', { sourceIds: ids });
  assert.equal((await ingestSource(db, c)).status, 'ok');
});

test('API: public read, owner/operator write, non-owner 401', async () => {
  const db = await memDb();
  const app = createApp({ db, operatorToken: 'op', defer: () => {} });
  const call = (path, init = {}) => app(new Request('http://x' + path, { ...init, headers: { 'x-peer-ip': 'w1', ...(init.headers ?? {}) } })).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await call('/api/watch')).status, 200);
  assert.equal((await call('/api/watch', { method: 'PUT', body: JSON.stringify({ keywords: ['x1'] }) })).status, 401);
  const ok = await call('/api/watch', { method: 'PUT', headers: { authorization: 'Bearer op' }, body: JSON.stringify({ keywords: ['Intents'] }) });
  assert.equal(ok.status, 200); assert.deepEqual((await getWatch(db)).keywords, ['intents']);
  assert.equal((await call('/api/watch', { method: 'PUT', headers: { authorization: 'Bearer op' }, body: JSON.stringify({ sources: { nope: false } }) })).status, 400);
});
