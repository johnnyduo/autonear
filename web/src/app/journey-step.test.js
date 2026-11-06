import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, pageIsLive, statusRows, writeBlock } from './journey-step.js';
import { T } from './copy.js';

const W = { ...T.journey, readOnly: T.readOnly, demo: T.demoNote, watchWarn: T.build.watchWarn };
const OWNER = { address: '0xabc', isOwner: true };
const GUEST = { address: '0xdef', isOwner: false };
const NONE = { address: null, isOwner: false };
const BUILT = { slug: 'treasury', hash: 'aaaaaaaaaa', published: false, publishedHash: null, built: true };
const LIVE = { ...BUILT, published: true, publishedHash: 'aaaaaaaaaa' };
const NEWER = { ...BUILT, hash: 'bbbbbbbbbb', published: true, publishedHash: 'aaaaaaaaaa' };
const step = (o) => nextStep({ verdict: 'go', owner: OWNER, canWrite: true, demo: false, page: null, building: false, ...o }, W);

test('go, owner session, no page: one approve button that builds without an override', () => {
  const s = step({});
  assert.equal(s.kind, 'approve'); assert.equal(s.actions.build.label, 'Approve and build the page'); assert.equal(s.actions.build.override, false); assert.equal(s.actions.build.warn, false);
  assert.equal(s.actions.watch, false); assert.equal(s.actions.publish, false); assert.equal(s.reason, ''); assert.equal(s.warn, '');
});

test('watch, owner session, no page: "Build on my call", override on, with the warning', () => {
  const s = step({ verdict: 'watch' });
  assert.equal(s.kind, 'approve'); assert.equal(s.actions.build.label, 'Build on my call'); assert.equal(s.actions.build.override, true); assert.equal(s.actions.build.warn, true);
  assert.equal(s.warn, T.build.watchWarn); assert.equal(s.head, T.journey.headWatch);
});

test('drop and unknown verdicts: no button, one honest line, even for the owner', () => {
  for (const verdict of ['drop', 'DROP', null, undefined, 'maybe']) {
    const s = step({ verdict });
    assert.equal(s.kind, 'drop'); assert.equal(s.actions.build, null); assert.equal(s.actions.publish, false); assert.equal(s.actions.watch, false); assert.equal(s.head, T.journey.headDrop);
  }
});

test('no page, not the owner: text with the reason, no button', () => {
  for (const verdict of ['go', 'watch']) {
    const none = step({ verdict, owner: NONE, canWrite: false }); const guest = step({ verdict, owner: GUEST, canWrite: false });
    assert.equal(none.kind, 'locked'); assert.equal(none.actions.build, null); assert.equal(none.reason, T.journey.connect);
    assert.equal(guest.kind, 'locked'); assert.equal(guest.actions.build, null); assert.equal(guest.reason, T.readOnly);
  }
  assert.equal(step({ verdict: 'watch', owner: GUEST, canWrite: false }).warn, T.build.watchWarn, 'the watch warning is still stated');
});

test('no page, demo or read-only session: no button, the demo wording', () => {
  assert.equal(step({ demo: true }).actions.build, null); assert.equal(step({ demo: true }).reason, T.demoNote);
  assert.equal(step({ canWrite: false }).actions.build, null); assert.equal(step({ canWrite: false }).reason, T.demoNote);
});

test('a build request is running: no button of any kind, whatever the verdict or role', () => {
  for (const verdict of ['go', 'watch', 'drop']) for (const owner of [OWNER, GUEST, NONE]) for (const page of [null, BUILT, LIVE]) {
    const s = step({ verdict, owner, page, building: true });
    assert.equal(s.kind, 'building'); assert.equal(s.actions.build, null); assert.equal(s.actions.publish, false); assert.equal(s.actions.watch, false);
  }
});

test('page built, not published: owner gets Watch again and Publish; everyone else only Watch with the reason', () => {
  const o = step({ page: BUILT });
  assert.equal(o.kind, 'built'); assert.equal(o.actions.watch, true); assert.equal(o.actions.publish, true); assert.equal(o.actions.build, null); assert.equal(o.link, null); assert.equal(o.head, T.journey.headBuilt);
  const g = step({ page: BUILT, owner: GUEST, canWrite: false });
  assert.equal(g.actions.watch, true); assert.equal(g.actions.publish, false); assert.equal(g.reason, T.readOnly);
  const n = step({ page: BUILT, owner: NONE, canWrite: false }); assert.equal(n.actions.publish, false); assert.equal(n.reason, T.journey.connect);
  assert.equal(step({ page: BUILT, demo: true }).actions.publish, false);
});

test('a page that exists is shown whatever the verdict says now', () => {
  for (const verdict of ['go', 'watch', 'drop']) assert.equal(step({ verdict, page: BUILT }).kind, 'built');
});

test('published: the link is shown, Publish is gone, Watch stays', () => {
  for (const owner of [OWNER, GUEST, NONE]) {
    const s = step({ page: LIVE, owner, canWrite: owner.isOwner });
    assert.equal(s.kind, 'published'); assert.equal(s.link, '/develop/treasury'); assert.equal(s.actions.publish, false); assert.equal(s.actions.watch, true); assert.equal(s.reason, '');
  }
});

test('a newer stored version than the public one can be published, and the public link stays visible', () => {
  const s = step({ page: NEWER });
  assert.equal(s.kind, 'built'); assert.equal(s.actions.publish, true); assert.equal(s.link, '/develop/treasury'); assert.equal(s.head, T.journey.headNewer);
});

test('pageIsLive and writeBlock', () => {
  assert.equal(pageIsLive(null), false); assert.equal(pageIsLive(BUILT), false); assert.equal(pageIsLive(LIVE), true); assert.equal(pageIsLive(NEWER), false);
  assert.equal(pageIsLive({ slug: 's', hash: 'x', published: true }), true, 'no publishedHash sent: treated as current');
  assert.equal(writeBlock({ owner: OWNER, canWrite: true, demo: false }, W), ''); assert.equal(writeBlock({ owner: null, canWrite: true }, W), T.journey.connect);
});

const J = (state, build = 'todo', headline = 'Held at the build step') => ({ outcome: { state, headline }, stages: [{ id: 'build', state: build }] });
const row = (rows, key) => rows.find((r) => r.key === key);

test('Page row: none, building, built, newer, published', () => {
  const rows = (o) => statusRows({ journey: J('ready'), page: null, building: false, ...o }, W);
  assert.equal(row(rows({}), 'page').text, T.journey.pageNone); assert.equal(row(rows({}), 'page').tone, 'idle');
  assert.equal(row(rows({ building: true }), 'page').text, T.journey.pageBuilding);
  assert.equal(row(rows({ page: BUILT }), 'page').text, T.journey.pageBuilt);
  assert.equal(row(rows({ page: NEWER }), 'page').text, T.journey.pageNewer);
  assert.equal(row(rows({ page: LIVE }), 'page').text, 'Published at /develop/treasury'); assert.equal(row(rows({ page: LIVE }), 'page').tone, 'ok');
});

test('Contract row says plainly that it waits for the agent host, and never implies it is running', () => {
  const held = row(statusRows({ journey: J('held', 'todo'), page: LIVE }, W), 'contract');
  assert.equal(held.text, 'Waiting for the agent host: it needs the Rust build host'); assert.equal(held.tone, 'warn');
  assert.equal(row(statusRows({ journey: J('ready'), page: null }, W), 'contract').text, T.journey.contractIdle);
  assert.equal(row(statusRows({ journey: J('not_started', 'todo', 'Council says drop'), page: null }, W), 'contract').text, T.journey.contractIdle);
  assert.equal(row(statusRows({ journey: null, page: null }, W), 'contract').text, T.journey.contractIdle);
  assert.equal(row(statusRows({ journey: J('in_progress'), page: null }, W), 'contract').text, T.journey.contractResearch);
});

test('Contract row for later states quotes the stored outcome; a declined request is not reported as waiting for the host', () => {
  assert.equal(row(statusRows({ journey: J('held', 'done', 'The owner declined') }, W), 'contract').text, 'The owner declined');
  assert.equal(row(statusRows({ journey: J('waiting', 'done', 'Waiting to be executed') }, W), 'contract').tone, 'warn');
  assert.equal(row(statusRows({ journey: J('failed', 'done', 'The deployment did not verify') }, W), 'contract').tone, 'bad');
  const ok = row(statusRows({ journey: J('shipped', 'done', 'Shipped and healthy') }, W), 'contract'); assert.equal(ok.text, 'Shipped and healthy'); assert.equal(ok.tone, 'ok');
});
