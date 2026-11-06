import test from 'node:test';
import assert from 'node:assert/strict';
import { STORIES, SEATS, scoreStory } from './landing-cards.js';

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
