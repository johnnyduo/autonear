import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLandingDemo } from './landing-demo.js';

test('landing demo: example data only, internally consistent, different per seed', () => {
  const a = makeLandingDemo(1, 120); const b = makeLandingDemo(2, 120);
  assert.equal(a.evidence.length, 120);
  assert.ok(a.evidence.every((e) => e.id.startsWith('ev_demo_') && /^[0-9a-f]{64}$/.test(e.content_hash) && e.relevance > 0 && e.relevance < 1));
  assert.ok(a.evidence.every((e) => a.links.has(e.id)));
  assert.notEqual(a.evidence[0].content_hash, b.evidence[0].content_hash);
  assert.equal(makeLandingDemo(1, 120).evidence[5].title, a.evidence[5].title, 'same seed, same picture');
  assert.equal(Object.keys(a.labels).length, 8);
  assert.ok(a.opps.every((o) => o.id === `opp_${o.topic}` && a.labels[o.topic]));
  assert.ok(a.sources.every((s) => s.status === 'ok' && s.lastSuccess < Date.now()));
});
