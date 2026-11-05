// Real-data layer for the constellation: pagination of stored evidence, opportunity->evidence links, and the graph model.
// Nothing here invents a record. Positions are computed later (sim.js) from this model and from nothing else.
import { api } from '../../api.js';
import { TOPIC_ORDER, srcColor } from '../_evidence-parts.jsx';

export const WELLS = [...TOPIC_ORDER, 'untagged'];
export const WELL_SHORT = { treasury: 'Treasury', intents: 'Intents', signing: 'Signing', wallet_ux: 'Wallet UX', dev_tooling: 'Dev tools', data_indexing: 'Data/RPC', ai_agents: 'AI agents', untagged: 'Untagged' };
export const REL_STYLE = { supports: 'supports', contradicts: 'contradicts', competitor: 'competitor', usage: 'usage' };

export const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
export const hash32 = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const unit = (h) => (h >>> 0) / 4294967296;

/** All stored evidence, newest first, via the public cursor API. Capped at 8 pages (800 records). */
export async function loadAllEvidence(bust = '') {
  const out = new Map(); let cursor = 0;
  for (let i = 0; i < 8; i++) {
    const d = await api(`/api/evidence?limit=100${cursor ? `&cursor=${cursor}` : ''}${bust ? `&r=${bust}` : ''}`);
    for (const e of d.items ?? []) out.set(e.id, e);
    if (!d.nextCursor || !d.items?.length) break;
    cursor = d.nextCursor;
  }
  return [...out.values()];
}

/** evidence id -> [{opp, relation}] from GET /api/opportunities/:id (stored evidence_links). */
export async function loadLinks(oppIds, bust = '') {
  const res = await Promise.allSettled(oppIds.map((id) => api(`/api/opportunities/${id}${bust ? `?r=${bust}` : ''}`)));
  const links = new Map(); let failed = 0;
  res.forEach((r, k) => {
    if (r.status !== 'fulfilled') { failed++; return; }
    for (const e of r.value.evidence ?? []) { const a = links.get(e.id) ?? []; a.push({ opp: oppIds[k], relation: e.relation ?? 'supports' }); links.set(e.id, a); }
  });
  return { links, failed };
}

const wellOf = (oppId) => WELLS.indexOf(String(oppId).replace(/^opp_/, ''));

/**
 * Graph model. node.wells = indices of the opportunity wells the record is linked to (stored links), or its first topic tag, or Untagged.
 * node.src = index into `sources`. Pure function of its inputs.
 */
export function buildModel({ evidence, opps, links, sources }) {
  const srcIdx = new Map(sources.map((s, i) => [s.id, i]));
  const oppById = new Map((opps ?? []).map((o) => [o.id, o]));
  const wells = WELLS.map((id) => ({ id, label: WELL_SHORT[id], opp: oppById.get(`opp_${id}`) ?? null, n: 0, linked: 0 }));
  const extraSrc = [];
  const nodes = evidence.map((e) => {
    let si = srcIdx.get(e.source_id);
    if (si === undefined) { si = sources.length + extraSrc.length; extraSrc.push({ id: e.source_id, name: e.source_id }); srcIdx.set(e.source_id, si); }
    const lk = (links.get(e.id) ?? []).map((l) => ({ w: wellOf(l.opp), rel: l.relation })).filter((l) => l.w >= 0);
    const tagTopic = (e.tags ?? []).find((t) => TOPIC_ORDER.includes(t));
    let primary;
    if (lk.length) { const t = lk.find((l) => WELLS[l.w] === tagTopic) ?? lk.find((l) => l.rel === 'supports') ?? lk[0]; primary = t.w; }
    else primary = tagTopic ? WELLS.indexOf(tagTopic) : WELLS.length - 1;
    const wl = lk.length ? lk : [{ w: primary, rel: 'tag' }];
    wells[primary].n++; for (const l of wl) wells[l.w].linked = (wells[l.w].linked ?? 0) + 1;
    return { id: e.id, e, src: si, wells: wl, primary, rel: e.relevance ?? 0, flagged: Boolean(e.flags?.length), t: e.observed_at, p: e.published_at ?? e.observed_at, color: hex(srcColor(e.source_id)), h: hash32(e.id), linked: lk.length > 0 };
  });
  return { nodes, wells, sources: [...sources, ...extraSrc], linkCount: nodes.reduce((a, n) => a + (n.linked ? n.wells.length : 0), 0) };
}
