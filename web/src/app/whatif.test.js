import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { RULES, SEATS, verdictOf, canon as serverCanon, sha as serverSha, seatId } from '../../../src/council.js';
import { whatIf, normalize, canon, verifyEntry } from './whatif.js';

const mk = (s, over = {}) => SEATS.map(([role]) => ({ role, support: over[role] ?? s, weight: RULES.weights[role], reason: `r ${role}` }));

test('whatIf with the published rules gives exactly the server verdict (grid of supports, confidence, vetoes, buildable)', () => {
  for (const s of [0.1, 0.3, 0.45, 0.5, 0.6, 0.7, 0.9]) for (const conf of [0.2, 0.5, 0.9]) for (const buildable of [true, false]) for (const over of [{}, { skeptic: 0.1 }, { security_reviewer: 0.2 }]) {
    const votes = mk(s, over); const S = votes.reduce((a, v) => a + v.weight * v.support, 0);
    const real = verdictOf(S, conf, votes, buildable); const mine = whatIf({ votes, confidence: conf, buildable, rules: RULES, weights: RULES.weights });
    assert.equal(mine.verdict, real.verdict); assert.deepEqual(mine.vetoes, real.vetoes); assert.ok(Math.abs(mine.S - S) < 1e-9);
  }
});
test('changing a weight or a threshold changes the answer, and weights are rescaled to sum to 1', () => {
  const votes = mk(0.8, { skeptic: 0.3 });
  const base = whatIf({ votes, confidence: 0.9, buildable: true, rules: RULES, weights: RULES.weights });
  const heavy = whatIf({ votes, confidence: 0.9, buildable: true, rules: RULES, weights: { ...RULES.weights, skeptic: 0.9 } });
  assert.ok(heavy.S < base.S);
  assert.equal(whatIf({ votes, confidence: 0.9, buildable: true, rules: RULES, weights: RULES.weights, goAt: 0.95 }).verdict, 'watch');
  const n = normalize({ a: 2, b: 2 }, { a: 1 }); assert.deepEqual(n, { a: 0.5, b: 0.5 });
  assert.deepEqual(normalize({ a: 0, b: 0 }, { a: 0.25, b: 0.75 }), { a: 0.25, b: 0.75 });
});
test('canon matches the server canonical JSON and verifyEntry accepts a real entry and rejects a tampered one', async () => {
  const sample = { z: 1, a: { y: [3, { b: 1, a: 2 }], x: 'é' } }; assert.equal(canon(sample), serverCanon(sample));
  const votes = mk(0.7).map((v) => ({ ...v, digest: serverSha(serverCanon({ seat: seatId(v.role), opp: 'o1', weight: v.weight, support: v.support, reason: v.reason })) }));
  const entry = { oppId: 'o1', support: 0.7, verdict: 'go', vetoes: [], votes }; entry.digest = serverSha(serverCanon({ opp: 'o1', support: 0.7, verdict: 'go', vetoes: [], votes: votes.map((v) => v.digest) }));
  const ok = await verifyEntry(entry, webcrypto.subtle); assert.equal(ok.all, true);
  const bad = await verifyEntry({ ...entry, votes: votes.map((v, i) => (i === 2 ? { ...v, support: 0.99 } : v)) }, webcrypto.subtle);
  assert.equal(bad.all, false); assert.equal(bad.seats[2].ok, false); assert.equal(bad.seats[0].ok, true);
});
