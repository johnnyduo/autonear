import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { RULES, SEATS, evaluate, convene, currentCouncil, councilGate, journeyFor, verdictOf, votesFor } from '../src/council.js';
import { createApp } from '../src/app.js';
import { memDb, fakeConnector, gh } from './helpers.js';

async function seeded() {
  const db = await memDb();
  const mk = (id, n) => fakeConnector(id, Array.from({ length: n }, (_, i) => gh(i + 1, { externalId: `${id}${i}`, author: `${id}-u${i}`, title: `Treasury multisig payout fails (${id}-${i})`, body: `We cannot rebalance DAO treasury ${id}${i}: multisig approval missing policy`, url: `https://example.org/${id}/${i}` })));
  const usage = fakeConnector('u1', [gh(99, { externalId: 'u99', kind: 'usage', forceTags: ['treasury'], org: 'near', title: 'On-chain: escrow holdings', body: 'fixture usage observation', author: 'rpc', url: 'https://example.org/usage' })]);
  const conns = [mk('s1', 8), mk('s2', 8), mk('s3', 8), usage];
  await registerSources(db, conns);
  for (const c of conns) await ingestSource(db, c);
  await refreshOpportunities(db);
  return db;
}

test('seven seats, weights sum to 1, every vote quotes stored numbers', async () => {
  assert.equal(SEATS.length, 7);
  assert.ok(Math.abs(Object.values(RULES.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const db = await seeded(); const c = await evaluate(db);
  assert.ok(c.opportunities.length >= 1);
  for (const o of c.opportunities) {
    assert.equal(o.votes.length, 7);
    assert.ok(o.support >= 0 && o.support <= 1);
    for (const v of o.votes) { assert.ok(v.support >= 0 && v.support <= 1); assert.match(v.reason, /\d/); assert.ok(['back', 'abstain', 'object'].includes(v.stance)); }
    assert.ok(['go', 'watch', 'drop'].includes(o.verdict));
  }
});

test('verdict rules: go needs support, confidence, no veto and a buildable topic; vetoes and missing templates downgrade to watch', () => {
  const votes = (sk = 0.8, sec = 0.8) => SEATS.map(([role]) => ({ role, support: role === 'skeptic' ? sk : role === 'security_reviewer' ? sec : 0.8 }));
  assert.equal(verdictOf(0.7, 0.6, votes(), true).verdict, 'go');
  assert.equal(verdictOf(0.7, 0.6, votes(), false).verdict, 'watch'); // a trend we see and cannot ship
  assert.equal(verdictOf(0.7, 0.3, votes(), true).verdict, 'watch'); // low confidence
  const v = verdictOf(0.7, 0.6, votes(0.1), true); assert.equal(v.verdict, 'watch'); assert.deepEqual(v.vetoes, ['Skeptic']);
  assert.equal(verdictOf(0.7, 0.6, votes(0.8, 0.1), true).vetoes[0], 'Security');
  assert.equal(verdictOf(0.3, 0.9, votes(), true).verdict, 'drop');
});

test('momentum: more records in the recent window than before the window reads as speeding up', () => {
  const now = Date.now(); const day = 864e5; const opp = { id: 'o', topic: 'treasury', score: 0.7, confidence: 0.6, score_breakdown: '{}' };
  const ev = (d) => ({ id: `e${d}${Math.random()}`, observed_at: now - d * day, published_at: null, flags: '[]' });
  const up = votesFor(opp, [...Array(8)].map(() => ev(2)).concat([ev(20)]), [], { nowMs: now });
  const down = votesFor(opp, [...Array(8)].map(() => ev(20)).concat([ev(2)]), [], { nowMs: now });
  assert.ok(up.momentum > 0.6 && down.momentum < 0.4);
  assert.match(up.votes.find((x) => x.role === 'launch_planner').reason, /speeding up/);
});

test('convene stores the session, audits only changes, and currentCouncil reuses a fresh one', async () => {
  const db = await seeded(); const a = await convene(db, { trigger: 'test' });
  const n1 = (await db.all("SELECT * FROM audit WHERE action='council.convened'")).length; assert.equal(n1, 1);
  await convene(db, { trigger: 'test' }); assert.equal((await db.all("SELECT * FROM audit WHERE action='council.convened'")).length, 1);
  const cur = await currentCouncil(db); assert.equal(cur.at, (await currentCouncil(db)).at); assert.equal(cur.winner, a.winner);
});

test('gate fails closed with no run, follows the verdict, and can be switched off only by the operator env', async () => {
  const db = await seeded(); const c = await currentCouncil(db); const top = c.opportunities[0];
  assert.equal((await councilGate(db, { run_id: null })).ok, false);
  await db.run("INSERT INTO runs(id,opportunity_id,trigger,state,budget,started_at) VALUES('run_t1',?,'operator','awaiting_approval','{}',?)", [top.oppId, Date.now()]);
  assert.equal((await councilGate(db, { run_id: 'run_t1' })).ok, top.verdict === 'go');
  assert.equal((await councilGate(db, { run_id: null }, { COUNCIL_GATE: '0' })).ok, true);
  // force a drop verdict: the gate must refuse
  await db.run("INSERT INTO kv(k,v) VALUES('council:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [JSON.stringify({ at: Date.now(), opportunities: [{ oppId: top.oppId, verdict: 'drop', reason: 'forced' }] })]);
  const g = await councilGate(db, { run_id: 'run_t1' }); assert.equal(g.ok, false); assert.match(g.reason, /drop/);
});

test('journey reads real run / decision / deployment state and API serves it publicly (read only)', async () => {
  const db = await seeded(); const c = await currentCouncil(db); const oid = c.opportunities[0].oppId;
  let j0 = await journeyFor(db, oid); assert.equal(j0.run, null); assert.equal(j0.stages[0].state, 'todo');
  await db.run("INSERT INTO runs(id,opportunity_id,trigger,state,budget,started_at) VALUES('run_t2',?,'operator','running','{}',?)", [oid, Date.now()]);
  j0 = await journeyFor(db, oid); assert.equal(j0.stages[0].state, 'active');
  const app = createApp({ db, fetchImpl: async () => { throw new Error('offline'); } });
  const res = await app.handle?.(new Request('http://x/api/council')) ?? await app(new Request('http://x/api/council'));
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.council.opportunities[0].votes.length, 7); assert.ok(body.journey.stages.length >= 5);
  const post = await (app.handle?.bind(app) ?? app)(new Request('http://x/api/council', { method: 'POST' })); assert.equal(post.status, 405);
});
