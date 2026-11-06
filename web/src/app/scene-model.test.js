import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from './scene-model.js';

const vault = { mandate: { totalCap: '1000', periodCap: '400', revoked: false }, usage: { totalSpent: '250', periodSpent: '100' }, agentBalance: '2000000000000000' };
const srcs = [{ id: 'a', name: 'A', status: 'ok', lastSuccess: Date.now() }, { id: 'b', name: 'B', status: 'circuit_open' }, { id: 'c', name: 'C', status: 'disabled_by_owner' }];

test('ring fill follows usage (max of total and period)', () => {
  const s = buildScene({ sources: srcs, vault });
  assert.equal(s.ring.has, true); assert.equal(s.ring.fill, 0.25);
  assert.equal(buildScene({ sources: srcs, vault: { ...vault, usage: { totalSpent: '900', periodSpent: '0' } } }).ring.fill, 0.9);
  assert.equal(buildScene({ sources: srcs, vault: { ...vault, mandate: { ...vault.mandate, revoked: true } } }).ring.has, false);
});
test('paused freezes beams and sets state', () => {
  const s = buildScene({ sources: srcs, vault, pending: [{ id: 'd1' }], paused: true });
  assert.equal(s.beams.length, 0); assert.equal(s.state, 'paused');
});
test('demo flag propagates', () => { assert.equal(buildScene({ sources: srcs, vault, demo: true }).state, 'demo'); assert.equal(buildScene({ sources: srcs, vault }).state, 'live'); });
test('low gas flagged below low-water', () => {
  assert.equal(buildScene({ sources: srcs, vault }).gas.low, true);
  assert.equal(buildScene({ sources: srcs, vault: { ...vault, agentBalance: '9000000000000000' } }).gas.low, false);
  assert.equal(buildScene({ sources: srcs, vault: null }).gas, null);
});
test('one beam per pending request; waiting in manual, flowing in auto; capped at 5', () => {
  const pending = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}` }));
  const m = buildScene({ sources: srcs, vault, pending, autonomy: { mode: 'manual' } });
  assert.equal(m.beams.length, 5); assert.ok(m.beams.every((b) => b.waiting));
  const a = buildScene({ sources: srcs, vault, pending: pending.slice(0, 2), autonomy: { mode: 'auto' } });
  assert.equal(a.beams.length, 2); assert.ok(a.beams.every((b) => !b.waiting));
});
test('source tones and the text summary mirror the data', () => {
  const s = buildScene({ sources: srcs, vault });
  assert.deepEqual(s.nodes.map((n) => n.tone), ['ok', 'bad', 'off']);
  assert.match(s.summary, /1 of 3 sources healthy/); assert.match(s.summary, /Limits used: 25%/);
});
test('empty inputs do not throw', () => { assert.doesNotThrow(() => buildScene()); assert.equal(buildScene().nodes.length, 0); });
