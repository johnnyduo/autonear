import { parse } from './db.js';

export const hydrateEvidence = (r) => ({
  ...r,
  tags: parse(r.tags, []),
  flags: parse(r.flags, []),
  signals: parse(r.signals, {}),
  reasons: parse(r.relevance_reasons, []),
});

export async function oppEvidence(db, oppId) {
  const rows = await db.all(
    `SELECT e.*, l.relation, l.note AS link_note FROM evidence_links l JOIN evidence e ON e.id=l.evidence_id
     WHERE l.opportunity_id=? ORDER BY COALESCE(e.published_at,e.observed_at) DESC`,
    [oppId],
  );
  return rows.map((r) => ({ ...hydrateEvidence(r), relation: r.relation, link_note: r.link_note }));
}

export async function getOpp(db, id) {
  const o = await db.get('SELECT * FROM opportunities WHERE id=?', [id]);
  return o ? { ...o, score_breakdown: parse(o.score_breakdown, {}), warnings: parse(o.warnings, []) } : null;
}
