import test from 'node:test';
import assert from 'node:assert/strict';
import { typedCount, clock, countdown, tickNumbers, tickText, shortReason, eventMeta, eventLine, buildFeedLines, chipState, excerptOf } from './live-text.js';

const TICK = { at: 1793953889006, trigger: 'cron', ms: 54766, opportunities: 7, auto: { started: false, reason: 'no material change (cooldown active)' },
  sources: [{ id: 'a', status: 'error' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, status: 'ok' })), ...Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, status: 'fresh' }))] };

test('typedCount: grows with time, clamps, handles empty text', () => {
  assert.equal(typedCount(100, 0, 55), 0);
  assert.equal(typedCount(100, 1000, 55), 55);
  assert.equal(typedCount(10, 5000, 55), 10);
  assert.equal(typedCount(0, 5000, 55), 0);
  assert.equal(typedCount(10, -50, 55), 0);
});

test('countdown and clock format', () => {
  assert.equal(countdown(1000 + 61000, 1000), '01:01');
  assert.equal(countdown(1000, 5000), '00:00');
  assert.equal(countdown(undefined), '--:--');
  assert.equal(clock(new Date(2026, 0, 1, 13, 5, 9).getTime()), '13:05:09');
});

test('tick numbers come straight from the stored tick', () => {
  const n = tickNumbers(TICK);
  assert.deepEqual([n.total, n.ok, n.fresh, n.err, n.rescored, n.seconds, n.started], [13, 12, 4, 1, 7, 55, false]);
  assert.equal(tickText(TICK), 'tick (cron, 55 s): 13 sources, 12 ok (4 not refetched), 1 error, 7 ideas rescored');
  assert.equal(shortReason(TICK.auto.reason), 'held: cooldown');
  assert.equal(tickNumbers(null), null);
  assert.equal(tickNumbers({ at: 1 }), null);
});

test('event lines and meta', () => {
  const ev = { id: 5, agent_role: 'evidence_analyst', status: 'completed', detail: ' 7 ideas  scored ', model: null, tokens: 0, cost: 0, time: 1 };
  assert.equal(eventLine(ev, 'Analyst'), 'Analyst completed: 7 ideas scored');
  assert.equal(eventMeta(ev), 'completed · no model · 0 tokens · $0.0000');
  assert.equal(eventMeta({ ...ev, model: 'm1', tokens: 1200, cost: 0.012 }), 'completed · m1 · 1200 tokens · $0.0120');
  assert.equal(excerptOf({ body_excerpt: '  a\n\n b  ' }), 'a b');
  assert.equal(excerptOf({}), '');
});

test('feed lines: sorted oldest first, stable ids, real fields only', () => {
  const events = [{ id: 2, agent_role: 'skeptic', status: 'started', detail: '', time: 3000 }, { id: 1, agent_role: 'signal_collector', status: 'completed', detail: 'all fresh', time: 1000 }];
  const sources = [{ id: 'hn', lastSuccess: 2000, lastRun: { inserted: 3, duplicates: 4, fetched: 9 } }, { id: 'none', lastSuccess: null }];
  const a = buildFeedLines({ events, tick: { ...TICK, at: 2500 }, sources, roleLabel: (r) => r.toUpperCase() });
  assert.deepEqual(a.map((l) => l.ts), [1000, 2000, 2500, 3000]);
  assert.equal(a[1].text, 'hn ingest ok: 9 fetched, 3 new, 4 duplicate');
  assert.deepEqual(a.map((l) => l.id), ['ev:1', 'src:hn:2000', 'tick:2500', 'ev:2']);
  const b = buildFeedLines({ events, tick: { ...TICK, at: 2500 }, sources });
  assert.deepEqual(a.map((l) => l.id), b.map((l) => l.id), 'ids do not depend on labels');
  assert.deepEqual(buildFeedLines({}), []);
});

test('chipState: the later event wins; unknown roles stay idle', () => {
  const ev = [{ agent_role: 'builder', status: 'started' }, { agent_role: 'builder', status: 'completed' }, { agent_role: 'skeptic', status: 'started' }, { agent_role: 'security_reviewer', status: 'failed' }];
  assert.equal(chipState(ev, 'builder'), 'done'); assert.equal(chipState(ev, 'skeptic'), 'working');
  assert.equal(chipState(ev, 'security_reviewer'), 'halted'); assert.equal(chipState(ev, 'launch_planner'), 'idle'); assert.equal(chipState(null, 'builder'), 'idle');
});

test('feed lines: only the most recent sources are listed', () => {
  const sources = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, lastSuccess: n * 1000 }));
  const l = buildFeedLines({ sources });
  assert.deepEqual(l.map((x) => x.id), ['src:s3:3000', 'src:s4:4000', 'src:s5:5000', 'src:s6:6000']);
  assert.equal(buildFeedLines({ sources, maxSources: 2 }).length, 2);
});
