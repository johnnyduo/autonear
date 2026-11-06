import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPageReady, approveAction, approveBlock, buildingLine, councilEntry, currentStep, defaultSelection, elapsedText, goAtOf, hasSite, needsText, publishedIsCurrent, rankSites, score, seatBars, siteFromReply, siteLinks, stepState, swarmView, verdictLabel, verdictTone, visibleRows } from './build-model.js';

const S = (o) => ({ opp_id: o.id, slug: o.id, title: o.title ?? o.id, verdict: o.v ?? 'go', support: o.s, buildable: true, hash: o.h ?? null, published: o.p ?? false, ...o.x });
const sites = [S({ id: 'b', s: 0.55, v: 'watch' }), S({ id: 'a', s: 0.81 }), S({ id: 'c', s: 0.55, v: 'watch' }), S({ id: 'd', s: 0.7 }), S({ id: 'e', s: 0.5, v: 'watch' })];

test('score turns 0..1 into a whole number out of 100 and survives bad input', () => {
  assert.equal(score(0.724), 72); assert.equal(score(72), 72); assert.equal(score(1), 100); assert.equal(score(-3), 0); assert.equal(score('x'), 0); assert.equal(score(undefined), 0);
});
test('verdict label, tone and the needs-62 text', () => {
  assert.equal(verdictLabel('go'), 'GO'); assert.equal(verdictLabel('WATCH'), 'WATCH'); assert.equal(verdictLabel('drop'), 'DROP'); assert.equal(verdictLabel(undefined), 'DROP');
  assert.equal(verdictTone('go'), 'ok'); assert.equal(verdictTone('watch'), 'warn'); assert.equal(verdictTone('drop'), '');
  assert.equal(needsText({ verdict: 'watch' }), 'needs 62 to build');
  assert.equal(needsText({ verdict: 'watch' }, 0.7), 'needs 70 to build');
  assert.equal(needsText({ verdict: 'go' }), ''); assert.equal(needsText(null), '');
});
test('rankSites orders by support, then title, without changing the input', () => {
  const copy = [...sites];
  assert.deepEqual(rankSites(sites).map((s) => s.opp_id), ['a', 'd', 'b', 'c', 'e']);
  assert.deepEqual(sites, copy);
  assert.deepEqual(rankSites(null), []);
  assert.equal(rankSites({ items: sites }).length, 5, 'a wrapped list works too');
});
test('default selection is the top row and an existing pick is kept', () => {
  const r = rankSites(sites);
  assert.equal(defaultSelection(r, null), 'a'); assert.equal(defaultSelection(r, 'c'), 'c'); assert.equal(defaultSelection(r, 'gone'), 'a'); assert.equal(defaultSelection([], 'x'), null);
});
test('only the first 4 rows show until Show all', () => {
  const r = rankSites(sites);
  assert.equal(visibleRows(r, false).length, 4); assert.equal(visibleRows(r, true).length, 5); assert.equal(visibleRows(r.slice(0, 2), false).length, 2);
});
test('links are built from slug and hash, with encoding', () => {
  assert.equal(siteLinks(null), null);
  assert.deepEqual(siteLinks({ slug: 'ai-agents' }, 'https://x.test'), { publicPath: '/develop/ai-agents', publicUrl: 'https://x.test/develop/ai-agents' });
  const l = siteLinks({ slug: 'dex', hash: 'a1b2c3d4e5' }, 'https://x.test');
  assert.equal(l.exactUrl, 'https://x.test/develop/dex/a1b2c3d4e5'); assert.equal(l.previewPath, '/develop/dex/a1b2c3d4e5?preview=1'); assert.equal(l.exactPath, '/develop/dex/a1b2c3d4e5');
  assert.equal(siteLinks({ slug: 'a/b', hash: 'x y' }).previewPath, '/develop/a%2Fb/x%20y?preview=1');
});
test('council entry, threshold and seat bars', () => {
  const data = { council: { rules: { goAt: 0.62 }, opportunities: [{ oppId: 'a', votes: [{ role: 'skeptic', label: 'Skeptic', weight: 0.15, support: 0.4, stance: 'abstain' }, { role: 'builder', weight: 0.2, support: 0.9, stance: 'back' }] }] } };
  assert.equal(councilEntry(data, 'a').oppId, 'a'); assert.equal(councilEntry(data, 'zz'), null); assert.equal(councilEntry(null, 'a'), null);
  assert.equal(goAtOf(data), 0.62); assert.equal(goAtOf({}), 0.62);
  assert.deepEqual(seatBars(councilEntry(data, 'a')), [{ role: 'skeptic', label: 'Skeptic', weight: 15, pct: 40, stance: 'abstain' }, { role: 'builder', label: 'builder', weight: 20, pct: 90, stance: 'back' }]);
  assert.deepEqual(seatBars(null), []);
});
test('the owner button says Approve build, or Build on my call with a warning for WATCH', () => {
  assert.deepEqual(approveAction({ verdict: 'go' }), { label: 'Approve build', override: false, warn: false });
  assert.deepEqual(approveAction({ verdict: 'watch' }), { label: 'Build on my call', override: true, warn: true });
});
test('approveBlock gives a plain reason, or an empty string when the owner may build', () => {
  const words = { connect: 'connect', readOnly: 'readonly', demo: 'demo', pick: 'pick', building: 'busy' };
  const ok = { owner: { address: '0x1', isOwner: true }, canWrite: true, demo: false, site: { buildable: true }, building: false };
  assert.equal(approveBlock(ok, words), '');
  assert.equal(approveBlock({ ...ok, owner: {} }, words), 'connect');
  assert.equal(approveBlock({ ...ok, owner: { address: '0x1', isOwner: false } }, words), 'readonly');
  assert.equal(approveBlock({ ...ok, demo: true }, words), 'demo');
  assert.equal(approveBlock({ ...ok, canWrite: false }, words), 'demo');
  assert.equal(approveBlock({ ...ok, site: null }, words), 'pick');
  assert.equal(approveBlock({ ...ok, building: true }, words), 'busy');
});
test('steps: owner vote first, build while working, publish once a page exists', () => {
  assert.equal(currentStep({ site: S({ id: 'a', s: 1 }), building: false }), 2);
  assert.equal(currentStep({ site: S({ id: 'a', s: 1 }), building: true }), 3);
  const built = S({ id: 'a', s: 1, h: 'abc' });
  assert.equal(currentStep({ site: built, building: false }), 4);
  assert.deepEqual([1, 2, 3, 4].map((i) => stepState(i, 4, built)), ['done', 'done', 'done', 'now']);
  assert.deepEqual([1, 2, 3, 4].map((i) => stepState(i, 2, null)), ['done', 'now', 'todo', 'todo']);
  assert.equal(stepState(4, 4, { ...built, published: true, published_hash: 'abc' }), 'done');
  assert.equal(stepState(4, 4, { ...built, published: true, published_hash: 'old' }), 'now', 'a newer build is not published yet');
  assert.equal(hasSite(built), true); assert.equal(hasSite({}), false);
  assert.equal(publishedIsCurrent({ hash: 'a', published: true }), true); assert.equal(publishedIsCurrent({ hash: 'a', published: false }), false);
});
test('elapsed time and the progress line', () => {
  assert.equal(elapsedText(0), '0 s'); assert.equal(elapsedText(12999), '12 s'); assert.equal(elapsedText(-5), '0 s');
  assert.match(buildingLine(2000), /writing the page.*2 s/); assert.match(buildingLine(9000), /Still working.*9 s/);
});
test('the build reply may be the site or wrapped in { site }', () => {
  assert.equal(siteFromReply({ site: { slug: 'x' } }).slug, 'x'); assert.equal(siteFromReply({ slug: 'y' }).slug, 'y'); assert.equal(siteFromReply(null), null);
});
test('swarmView accepts only well-formed state and clamps it', () => {
  assert.equal(swarmView({ type: 'other' }), null); assert.equal(swarmView({ type: 'swarm-state', phase: 'bogus' }), null); assert.equal(swarmView(null), null);
  const v = swarmView({ type: 'swarm-state', phase: 'running', progress: 4, agents: [{ name: 'Copy', color: '#5fb8ff', doing: 'typing' }, { name: 'X', color: 'url(javascript:1)' }] });
  assert.equal(v.progress, 1); assert.equal(v.agents[0].color, '#5fb8ff'); assert.equal(v.agents[1].color, '#888888'); assert.equal(v.agents[1].doing, '');
  assert.equal(swarmView({ type: 'swarm-state', phase: 'done', progress: 'x' }).progress, 0);
});

test('a page-ready WATCH product is approved like a GO one, with no override and no "needs" text; plain WATCH keeps both', () => {
  assert.equal(isPageReady({ page_ready: true }), true); assert.equal(isPageReady({ pageReady: true }), true); assert.equal(isPageReady({ page_ready: false, pageReady: true }), false); assert.equal(isPageReady(null), false);
  assert.deepEqual(approveAction({ verdict: 'watch', page_ready: true }), { label: 'Approve build', override: false, warn: false });
  assert.deepEqual(approveAction({ verdict: 'watch', pageReady: true }), { label: 'Approve build', override: false, warn: false });
  assert.deepEqual(approveAction({ verdict: 'watch', page_ready: false }), { label: 'Build on my call', override: true, warn: true });
  assert.equal(needsText({ verdict: 'watch', page_ready: true }), ''); assert.equal(needsText({ verdict: 'watch', page_ready: false }), 'needs 62 to build');
});
