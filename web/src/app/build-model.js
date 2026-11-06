// Pure helpers for the Build page (no React, no DOM), so they run in plain Node tests.
// Site rows come from GET /api/sites: { opp_id, slug, title, verdict, support, buildable, page_ready, contract_template, hash, built_at, published, published_hash, override, model, tokens, cost }.
// Council entries come from GET /api/council: council.opportunities[] = { oppId, title, support, verdict, votes: [{ role, label, weight, support, stance }] }.

export const GO_AT = 0.62; // the council's build threshold; the live value comes from /api/council rules when present
export const FIRST_ROWS = 4;
export const STEP_IDS = ['vote', 'owner', 'build', 'publish'];

/** A support value as a whole number out of 100. The API sends 0..1; a value above 1 is taken as already out of 100. */
export const score = (x) => { const n = Number(x); if (!Number.isFinite(n)) return 0; return Math.round(Math.min(100, Math.max(0, n > 1 ? n : n * 100))); };

export const verdictLabel = (v) => ({ go: 'GO', watch: 'WATCH' }[String(v ?? '').toLowerCase()] ?? 'DROP');
export const verdictTone = (v) => ({ go: 'ok', watch: 'warn' }[String(v ?? '').toLowerCase()] ?? '');
/** The score clears the build threshold and nobody vetoed. A /api/sites row says page_ready, a council entry says pageReady. */
export const isPageReady = (x) => Boolean(x?.page_ready ?? x?.pageReady);
export const needsText = (site, goAt = GO_AT) => (String(site?.verdict ?? '').toLowerCase() === 'watch' && !isPageReady(site) ? `needs ${score(goAt)} to build` : '');

/** Highest support first; ties keep alphabetical order so the list does not jump around between refreshes. */
export const rankSites = (sites) => [...(Array.isArray(sites) ? sites : Array.isArray(sites?.items) ? sites.items : [])].sort((a, b) => (Number(b.support) || 0) - (Number(a.support) || 0) || String(a.title).localeCompare(String(b.title)));
export const defaultSelection = (ranked, current) => (ranked.some((s) => s.opp_id === current) ? current : ranked[0]?.opp_id ?? null);
export const visibleRows = (ranked, showAll, limit = FIRST_ROWS) => (showAll ? ranked : ranked.slice(0, limit));
export const hasSite = (site) => Boolean(site?.hash);
export const isPublished = (site) => Boolean(site?.published);
/** The published page is the same version as the stored one. */
export const publishedIsCurrent = (site) => isPublished(site) && (!site.published_hash || site.published_hash === site.hash);

/** Links for a site. `origin` is passed in (location.origin in the browser) so the helper stays pure. */
export function siteLinks(site, origin = '') {
  if (!site?.slug) return null;
  const slug = encodeURIComponent(site.slug);
  const out = { publicPath: `/develop/${slug}`, publicUrl: `${origin}/develop/${slug}` };
  if (site.hash) {
    const h = encodeURIComponent(site.hash);
    Object.assign(out, { exactPath: `/develop/${slug}/${h}`, exactUrl: `${origin}/develop/${slug}/${h}`, previewPath: `/develop/${slug}/${h}?preview=1` });
  }
  return out;
}

export const councilEntry = (councilData, oppId) => (councilData?.council?.opportunities ?? []).find((o) => o.oppId === oppId) ?? null;
export const goAtOf = (councilData) => councilData?.council?.rules?.goAt ?? GO_AT;
export const seatBars = (entry) => (entry?.votes ?? []).map((v) => ({ role: v.role, label: v.label ?? String(v.role).replace(/_/g, ' '), weight: Math.round((v.weight ?? 0) * 100), pct: score(v.support), stance: v.stance }));

/** What the owner button says, and whether the council's verdict needs a warning. */
export const approveAction = (site) => (String(site?.verdict ?? '').toLowerCase() === 'watch' && !isPageReady(site) ? { label: 'Build on my call', override: true, warn: true } : { label: 'Approve build', override: false, warn: false });

/** Why the owner button is off, in plain words, or '' when it is on. `words` carries the shared texts. */
export function approveBlock({ owner, canWrite, demo, site, building }, words) {
  if (!owner?.address) return words.connect;
  if (!owner.isOwner) return words.readOnly;
  if (demo || !canWrite) return words.demo;
  if (!site) return words.pick;
  if (building) return words.building;
  return '';
}

/** The step the page is on: 2 owner vote (council votes are stored, so step 1 is done), 3 while building, 4 once a page exists. */
export const currentStep = ({ site, building }) => (building ? 3 : hasSite(site) ? 4 : 2);
export const stepState = (i, current, site) => (i < current ? 'done' : i === current ? (i === 4 && publishedIsCurrent(site) ? 'done' : 'now') : 'todo');

export const elapsedText = (ms) => `${Math.max(0, Math.floor(ms / 1000))} s`;
export const buildingLine = (ms) => (ms < 6000 ? `The agents are writing the page… ${elapsedText(ms)}` : `Still working… ${elapsedText(ms)}. This usually takes under 30 s.`);

/** The server may answer with the site row itself or wrap it as { site }. */
export const siteFromReply = (r) => (r && typeof r === 'object' ? r.site ?? r : null);

/** Fold a swarm-state message from the preview into what the page shows. Anything malformed is ignored (returns null). */
export function swarmView(msg) {
  if (!msg || msg.type !== 'swarm-state' || !['still', 'running', 'done'].includes(msg.phase)) return null;
  const p = Number(msg.progress);
  return { phase: msg.phase, progress: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0, agents: Array.isArray(msg.agents) ? msg.agents.slice(0, 8).map((a) => ({ name: String(a?.name ?? '').slice(0, 16), color: /^#[0-9a-f]{3,8}$/i.test(a?.color ?? '') ? a.color : '#888888', doing: String(a?.doing ?? '').slice(0, 60) })) : [] };
}
export const swarmWord = (v) => (!v ? 'Loading the page…' : v.phase === 'running' ? 'Replaying' : v.phase === 'done' ? 'Replay finished' : 'Showing the page as it is');
