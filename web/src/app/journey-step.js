// Pure logic for the "Next step" block under the council score (no React, no DOM), so it runs in plain Node tests.
// Inputs are stored facts from GET /api/council: the verdict, journey.page ({ slug, hash, published, publishedHash } or null),
// journey.stages and journey.outcome. Nothing here starts a build; the owner's click does, through POST /api/sites/<opp>/build.
import { approveAction, GO_AT, score } from './build-model.js';

const lower = (v) => String(v ?? '').toLowerCase();

/** The stored page is the public one. */
export const pageIsLive = (page) => Boolean(page?.published && (!page.publishedHash || page.publishedHash === page.hash));

/** Why the owner buttons are off, or '' when the session may write. `words`: { connect, readOnly, demo }. */
export function writeBlock({ owner, canWrite, demo }, words) {
  if (!owner?.address) return words.connect;
  if (!owner.isOwner) return words.readOnly;
  if (demo || !canWrite) return words.demo;
  return '';
}

/**
 * What the block shows and which buttons it has.
 * `pageReady` (the score clears the build threshold, no veto) lets a WATCH product be built without the owner's override: only the page is built, no contract exists.
 * kind: building | approve | locked | drop | built | published
 * actions: build ({label, override, warn} or null), watch (the stored page can be replayed by anyone), publish (owner only)
 * `reason` explains a missing owner button in words, `link` is the public path once the page is public.
 */
export function nextStep({ verdict, pageReady = false, goAt = GO_AT, owner, canWrite, demo, page, building }, words) {
  const v = lower(verdict);
  const reason = writeBlock({ owner, canWrite, demo }, words);
  const may = !reason;
  const none = { build: null, watch: false, publish: false };
  if (building) return { kind: 'building', head: words.headBuilding, actions: none, reason: '', link: null, warn: '' };
  if (page) {
    const live = pageIsLive(page);
    const link = page.published ? `/develop/${encodeURIComponent(page.slug)}` : null;
    if (live) return { kind: 'published', head: words.headPublished, actions: { ...none, watch: true }, reason: '', link, warn: '' };
    return { kind: 'built', head: page.published ? words.headNewer : words.headBuilt, actions: { ...none, watch: true, publish: may }, reason: may ? '' : reason, link, warn: '' };
  }
  if (v !== 'go' && v !== 'watch') return { kind: 'drop', head: words.headDrop, actions: none, reason: '', link: null, warn: '' };
  const a = approveAction({ verdict: v, pageReady });
  const build = { label: a.warn ? a.label : words.approve, override: a.override, warn: a.warn };
  const head = a.warn ? words.headWatch : v === 'watch' ? words.headPageReady(score(goAt)) : may ? words.headApprove : words.headApproveLocked;
  if (!may) return { kind: 'locked', head, actions: none, reason, link: null, warn: a.warn ? words.watchWarn : '' };
  return { kind: 'approve', head, actions: { ...none, build }, reason: '', link: null, warn: a.warn ? words.watchWarn : '' };
}

const stageOf = (journey, id) => (journey?.stages ?? []).find((s) => s.id === id) ?? null;

/** The two plain status rows. Each row is { key, label, text, tone } with tone ok | warn | bad | idle. */
export function statusRows({ journey, page, building }, words) {
  const live = pageIsLive(page);
  const pageRow = building ? { text: words.pageBuilding, tone: 'warn' }
    : live ? { text: `Published at /develop/${page.slug}`, tone: 'ok' }
      : page ? { text: page.published ? words.pageNewer : words.pageBuilt, tone: 'warn' }
        : { text: words.pageNone, tone: 'idle' };
  const oc = journey?.outcome; const build = stageOf(journey, 'build');
  let contract;
  if (journey?.contractTemplate === false) contract = { text: words.contractNone, tone: 'idle' };
  else if (!oc) contract = { text: words.contractIdle, tone: 'idle' };
  else if (oc.state === 'held' && build?.state !== 'done') contract = { text: words.contractHost, tone: 'warn' };
  else if (oc.state === 'not_started' || oc.state === 'ready') contract = { text: words.contractIdle, tone: 'idle' };
  else if (oc.state === 'in_progress') contract = { text: words.contractResearch, tone: 'warn' };
  else contract = { text: oc.headline, tone: oc.state === 'failed' ? 'bad' : oc.state === 'shipped' || oc.state === 'live' ? 'ok' : 'warn' };
  return [{ key: 'page', label: words.rowPage, ...pageRow }, { key: 'contract', label: words.rowContract, ...contract }];
}
