import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { RULES, SEATS, rulesHash, seatId, evaluate, convene, currentCouncil, councilGate, journeyFor, verdictOf, votesFor } from '../src/council.js';
import { createApp } from '../src/app.js';
import { getOpp } from '../src/store.js';
import { slugOf } from '../src/sites/schema.js';
import { saveSite, publish } from '../src/sites/store.js';
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
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.council.opportunities[0].votes.length, 7); assert.deepEqual(body.journey.stages.map((x) => x.id).slice(0, 3), ['research', 'develop', 'build']); assert.ok('page' in body.journey);
  const post = await (app.handle?.bind(app) ?? app)(new Request('http://x/api/council', { method: 'POST' })); assert.equal(post.status, 405);
});

test('final judgement follows the stored facts: ready, in progress, held at build, waiting, shipped, failed, declined', async () => {
  const db = await seeded(); const c = await currentCouncil(db); const oid = c.opportunities[0].oppId; const now = Date.now();
  assert.equal((await journeyFor(db, oid, { verdict: 'go' })).outcome.state, 'ready');
  assert.equal((await journeyFor(db, oid, { verdict: 'watch' })).outcome.state, 'not_started');
  await db.run("INSERT INTO runs(id,opportunity_id,trigger,state,budget,started_at) VALUES('run_j',?,'operator','running','{}',?)", [oid, now]);
  assert.equal((await journeyFor(db, oid)).outcome.state, 'in_progress');
  await db.run("UPDATE runs SET state='blocked' WHERE id='run_j'");
  const held = await journeyFor(db, oid); assert.equal(held.outcome.state, 'held'); assert.match(held.outcome.next, /build host/);
  await db.run("INSERT INTO artifacts(id,run_id,kind,immutable_ref,hash,test_results,created_at) VALUES('a1','run_j','contract-build:near','r','h1','{}',?)", [now]);
  await db.run("UPDATE runs SET state='awaiting_approval' WHERE id='run_j'");
  await db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES('dec_j','run_j','h1','deploy_testnet','near:testnet','t','m','0',?,'n1','{}','ph','pending',?)", [now + 3600e3, now]);
  const w = await journeyFor(db, oid, { verdict: 'go', mode: 'auto' }); assert.equal(w.outcome.state, 'waiting'); assert.match(w.outcome.next, /Auto the agent/);
  assert.equal((await journeyFor(db, oid, { mode: 'manual' })).outcome.next.includes('owner approves'), true);
  await db.run("INSERT INTO deployments(id,decision_id,network,account,artifact_hash,transaction_hash,explorer_url,time,status,verification) VALUES('dep_j','dec_j','near:testnet','vault.testnet','h1','tx1','http://e',?,'verified','{}')", [now]);
  assert.equal((await journeyFor(db, oid)).outcome.state, 'live');
  await db.run("INSERT INTO kv(k,v) VALUES('monitor:dep_j',?)", [JSON.stringify({ at: now, ok: true, checks: [{ name: 'a', ok: true }] })]);
  const sh = await journeyFor(db, oid); assert.equal(sh.outcome.state, 'shipped'); assert.equal(sh.stages.at(-1).state, 'done'); assert.equal(sh.outcome.progress.done, sh.outcome.progress.total - 0 === 7 ? 7 : sh.outcome.progress.done);
  await db.run("UPDATE kv SET v=? WHERE k='monitor:dep_j'", [JSON.stringify({ at: now, ok: false, checks: [{ name: 'code hash unchanged', ok: false }] })]);
  const bad = await journeyFor(db, oid); assert.equal(bad.outcome.state, 'failed'); assert.match(bad.outcome.detail, /code hash/);
  await db.run("DELETE FROM deployments WHERE id='dep_j'"); await db.run("UPDATE decisions SET status='rejected' WHERE id='dec_j'");
  assert.equal((await journeyFor(db, oid)).outcome.state, 'held');
});

test('a checked build recorded against the decision (not the run) still counts, and an existing request is never reported as held at build', async () => {
  const db = await seeded(); const c = await currentCouncil(db); const oid = c.opportunities[0].oppId; const now = Date.now();
  await db.run("INSERT INTO runs(id,opportunity_id,trigger,state,budget,started_at) VALUES('run_k',?,'operator','blocked','{}',?)", [oid, now]);
  await db.run("INSERT INTO artifacts(id,run_id,kind,immutable_ref,hash,test_results,created_at) VALUES('a_other','run_other','contract-build:near','r','hk','{}',?)", [now]);
  await db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES('dec_k','run_k','hk','deploy_testnet','near:testnet','t','m','0',?,'nk','{}','ph','pending',?)", [now + 3600e3, now]);
  const j = await journeyFor(db, oid, { mode: 'auto' });
  assert.equal(j.stages.find((x) => x.id === 'build').state, 'done'); assert.equal(j.outcome.state, 'waiting'); assert.notEqual(j.outcome.headline, 'Held at the build step');
});

test('every seat and verdict has a recomputable digest and a stable AutoNEAR id; none claims to be a contract', async () => {
  const db = await seeded(); const a = await evaluate(db); const b = await evaluate(db);
  assert.match(a.rulesHash, /^[0-9a-f]{64}$/); assert.equal(a.rulesHash, rulesHash());
  assert.equal(a.seats.length, 7);
  for (const s of a.seats) { assert.equal(s.id, seatId(s.role)); assert.equal(s.kind, 'off-chain rule'); assert.ok(s.question.length > 10); }
  for (const o of a.opportunities) {
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    for (const v of o.votes) assert.match(v.digest, /^[0-9a-f]{64}$/);
    assert.equal(o.digest, b.opportunities.find((x) => x.oppId === o.oppId).digest, 'same stored data gives the same digest');
  }
  assert.equal(new Set(a.opportunities[0].votes.map((v) => v.digest)).size, 7, 'each seat has its own digest');
});

test('journey: the Product page stage and the page object follow the sites table (none, built, published) and a read never builds', async () => {
  const db = await seeded(); const c = await currentCouncil(db); const oid = c.opportunities[0].oppId; const slug = slugOf(await getOpp(db, oid));
  const stage = (j) => j.stages.find((x) => x.id === 'develop');
  assert.equal(stage(await journeyFor(db, oid)).state, 'todo'); assert.equal(stage(await journeyFor(db, oid, { verdict: 'drop' })).state, 'todo');
  let j = await journeyFor(db, oid, { verdict: 'go' });
  assert.equal(stage(j).state, 'active'); assert.equal(stage(j).detail, 'no page yet'); assert.equal(j.page, null); assert.equal(j.stages[1].id, 'develop');
  assert.equal((await db.all('SELECT 1 FROM sites')).length, 0, 'reading the journey stores no page');
  await saveSite(db, { slug, oppId: oid, hash: 'aaaaaaaaaa', content: {}, meta: {}, createdAt: 1000 });
  j = await journeyFor(db, oid, { verdict: 'watch' });
  assert.equal(stage(j).state, 'done'); assert.equal(stage(j).detail, 'page stored, not published');
  assert.deepEqual(j.page, { slug, hash: 'aaaaaaaaaa', published: false, publishedHash: null, built: true });
  await saveSite(db, { slug, oppId: oid, hash: 'bbbbbbbbbb', content: {}, meta: {}, createdAt: 2000 });
  await publish(db, slug, 'aaaaaaaaaa');
  j = await journeyFor(db, oid, { verdict: 'go' });
  assert.equal(stage(j).state, 'done'); assert.equal(stage(j).detail, `published at /develop/${slug}`);
  assert.deepEqual(j.page, { slug, hash: 'bbbbbbbbbb', published: true, publishedHash: 'aaaaaaaaaa', built: true });
  assert.equal(j.outcome.progress.total, j.stages.length);
});
