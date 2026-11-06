import test from 'node:test';
import assert from 'node:assert/strict';
import { STORIES, SEATS, scoreStory, councilFrom } from './landing-cards.js';

test('landing cards: weights add to 1, every story scores 0-100 and agrees with its own verdict', () => {
  assert.ok(Math.abs(SEATS.reduce((a, [, w]) => a + w, 0) - 1) < 1e-9);
  for (const st of STORIES) for (let k = 0; k < 20; k++) {
    const r = scoreStory(st);
    assert.equal(r.seats.length, 7);
    assert.ok(r.seats.every((s) => s.score >= 0 && s.score <= 100));
    assert.equal(r.verdict, r.support >= 62 ? 'go' : r.support >= 48 ? 'watch' : 'drop');
    assert.ok(st.title.length < 56, 'titles stay short');
  }
});

test('landing cards: the council-shaped object has what the star reads (7 votes, rules, journey outcome)', () => {
  const c = councilFrom(scoreStory(STORIES[0]));
  const e = c.council.opportunities[0];
  assert.equal(e.votes.length, 7); assert.equal(c.council.winner, e.oppId); assert.equal(c.journey.oppId, e.oppId);
  assert.ok(e.votes.every((v) => ['back', 'abstain', 'object'].includes(v.stance) && v.support >= 0 && v.support <= 1));
  assert.equal(c.journey.stages.length, 7); assert.equal(c.journey.outcome.progress.total, 7);
  assert.ok(Math.abs(Object.values(c.council.rules.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});
