import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_ROWS, hasToggle, queueHead, queueTag, visibleQueue } from './queue-model.js';
import { T } from './copy.js';

const J = T.journey;
const item = (oppId, over = {}) => ({ oppId, title: oppId, slug: oppId, support: 0.7, verdict: 'watch', pageReady: true, contractTemplate: false, page: 'none', ...over });
const SEVEN = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => item(id));

test('queueHead: the first page-ready product whose page is not published', () => {
  assert.equal(queueHead([item('a', { page: 'published' }), item('b', { page: 'built' }), item('c')]), 'b', 'a built page is not published yet, so it stays at the head');
  assert.equal(queueHead([item('a', { page: 'published' }), item('b', { pageReady: false }), item('c')]), 'c');
  assert.equal(queueHead([item('a', { page: 'published' })]), null); assert.equal(queueHead([]), null); assert.equal(queueHead(undefined), null);
});

test('queueTag: published, page built, page ready, needs 62 to qualify', () => {
  assert.deepEqual(queueTag(item('a', { page: 'published' }), J), { key: 'published', text: 'Published' });
  assert.deepEqual(queueTag(item('a', { page: 'built' }), J), { key: 'built', text: 'Page built' });
  assert.deepEqual(queueTag(item('a'), J), { key: 'ready', text: 'Page ready' });
  assert.deepEqual(queueTag(item('a', { pageReady: false, verdict: 'drop' }), J), { key: 'needs', text: 'Needs 62 to qualify' });
  assert.equal(queueTag(item('a', { pageReady: false }), J, 0.7).text, 'Needs 70 to qualify');
  assert.equal(queueTag(item('a', { page: 'published', pageReady: false }), J).key, 'published');
});

test('visibleQueue: four rows collapsed, all when expanded, and the focused row is never hidden', () => {
  assert.equal(FIRST_ROWS, 4);
  assert.deepEqual(visibleQueue(SEVEN).map((x) => x.oppId), ['a', 'b', 'c', 'd']);
  assert.equal(visibleQueue(SEVEN, { showAll: true }).length, 7);
  assert.deepEqual(visibleQueue(SEVEN, { focus: 'f' }).map((x) => x.oppId), ['a', 'b', 'c', 'd', 'f']);
  assert.deepEqual(visibleQueue(SEVEN, { focus: 'b' }).map((x) => x.oppId), ['a', 'b', 'c', 'd']);
  assert.equal(visibleQueue(SEVEN.slice(0, 4)).length, 4); assert.deepEqual(visibleQueue(null), []);
});

test('hasToggle only when more rows exist than the collapsed list shows', () => {
  assert.equal(hasToggle(SEVEN), true); assert.equal(hasToggle(SEVEN.slice(0, 4)), false); assert.equal(hasToggle(undefined), false);
  assert.equal(J.queueAll(7), 'Show all (7)');
});
