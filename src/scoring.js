// Published, inspectable scoring formula. score = Σ weight_i × component_i (each component in [0,1]).
// Components are computed from stored evidence only; curated priors are labelled as such and carry uncertainty.
import { now, j, parse } from './db.js';
import { TOPICS } from './relevance.js';
import { COMPETITORS } from './competitors.js';
import { SOCIAL_WEIGHT, SOCIAL_SOURCE_IDS, isSocialSource, sourceWeight } from './connectors/source-weights.js';

export const WEIGHTS = {
  independent_demand: 0.22, recency: 0.10, onchain_corroboration: 0.12, friction_severity: 0.12,
  competition_gap: 0.12, near_fit: 0.12, feasibility: 0.10, evidence_quality: 0.10,
};
export const FORMULA = 'score = ' + Object.entries(WEIGHTS).map(([k, w]) => `${w}×${k}`).join(' + ');

// Social / news evidence (NEAR Social, Mastodon, Farcaster, Dev.to, Bluesky) is demand evidence of LOWER quality. The formula above is unchanged; what changes is how
// the DEMAND components are computed: every record carries a source weight (1 for GitHub / gov forum / Hacker News, SOCIAL_WEIGHT for social), averages are weighted
// means, and the breadth that social can add to independent_demand is capped. 0.4 and the caps are judgements, not measurements; rationale in connectors/source-weights.js.
export const SOCIAL_BREADTH_CAP = { authors: 3, sources: 1 }; // max "effective" authors / sources social can add (of 10 / 3 needed for a full independent_demand)
export const SCORING_NOTES = {
  sourceClasses: {
    core: { weight: 1, note: 'GitHub issues (near org), gov.near.org, Hacker News, on-chain usage. Count toward the 3-independent-source rule.' },
    social: {
      weight: SOCIAL_WEIGHT, sources: SOCIAL_SOURCE_IDS, breadthCap: SOCIAL_BREADTH_CAP,
      note: `Social records are demand evidence at ${SOCIAL_WEIGHT}× the weight of a core record in every demand component (weighted means for recency, friction and evidence_quality), `
        + `can add at most ${SOCIAL_BREADTH_CAP.authors} effective authors and ${SOCIAL_BREADTH_CAP.sources} effective source to independent_demand, never count toward the 3-independent-source rule, `
        + 'and contribute nothing to the source term of confidence. Social posts are unverified, so no social record is shown as a fact.',
    },
  },
  rules: [
    'A demand record is "clean" unless it is flagged bot-author, duplicate-content, low-signal:* (new account, link-only, repeated text, market ticker, ...) or prompt-injection; non-clean records are kept and listed but de-weighted.',
    'LOW CONFIDENCE is raised when fewer than 3 independent NON-social demand sources contribute clean records. The warning also reports social sources and the distinct-author count.',
    'Distinct authors are an unverified breadth signal: one actor can run several accounts across sources.',
  ],
};

// Curated priors (human judgement, flagged as such in the UI).
const PRIORS = {
  treasury: { near_fit: 0.85, feasibility: 0.8 }, intents: { near_fit: 0.9, feasibility: 0.6 }, signing: { near_fit: 0.9, feasibility: 0.5 },
  wallet_ux: { near_fit: 0.6, feasibility: 0.6 }, dev_tooling: { near_fit: 0.7, feasibility: 0.7 }, data_indexing: { near_fit: 0.6, feasibility: 0.5 }, ai_agents: { near_fit: 0.8, feasibility: 0.4 },
};
const OPP_COPY = {
  treasury: {
    title: 'Policy-bound treasury rebalancing on NEAR',
    thesis: 'Teams that hold NEAR-ecosystem treasuries need rebalancing and payouts that follow a written spending policy, with a human authorizing each consequential action and an auditable record.',
    problem: 'Treasury operators coordinate multisig approvals, swap routing and payouts by hand; no NEAR-native tool binds a proposed action to an explicit policy (target, method, max spend, expiry) before a human signs.',
    audience: 'DAO and protocol treasury operators; grant-program administrators.',
  },
};
const FRICTION = /\b(bug|fail(s|ed|ure)?|cannot|can't|broken|missing|need|request|blocked|error|unable|doesn't work|regression|crash|slow|expensive|confus)/i;
const SOLVED = /\b(already (supported|implemented|available)|resolved|fixed in|now supports|shipped|launched|released|merged)\b/i;
const DAY = 864e5;
const clamp = (x) => Math.max(0, Math.min(1, x));

export function scoreTopic(topic, evidence, competitorHits) {
  const demand = evidence.filter((e) => e.kind === 'demand');
  const usage = evidence.filter((e) => e.kind === 'usage');
  const isClean = (e) => !e.flags.includes('bot-author') && !e.flags.some((f) => f.startsWith('duplicate-content-of') || f.startsWith('prompt-injection') || f.startsWith('low-signal:'));
  const clean = demand.filter(isClean);
  const core = clean.filter((e) => !isSocialSource(e.source_id));
  const social = clean.filter((e) => isSocialSource(e.source_id));
  const authorKeys = (list) => new Set(list.filter((e) => (e.author ?? '').trim()).map((e) => `${e.source_id}:${e.author.trim().toLowerCase()}`));
  const coreAuthors = authorKeys(core); const socialAuthors = authorKeys(social);
  const authors = new Set([...coreAuthors, ...socialAuthors]);
  const coreSources = new Set(core.map((e) => e.source_id)); const socialSources = new Set(social.map((e) => e.source_id));
  const sources = new Set([...coreSources, ...socialSources]);
  // effective breadth: core counts fully, social is down-weighted AND capped
  const authEff = coreAuthors.size + Math.min(socialAuthors.size * SOCIAL_WEIGHT, SOCIAL_BREADTH_CAP.authors);
  const srcEff = coreSources.size + Math.min(socialSources.size * SOCIAL_WEIGHT, SOCIAL_BREADTH_CAP.sources);
  const w = (e) => sourceWeight(e.source_id);
  const sumW = (list) => list.reduce((a, e) => a + w(e), 0);
  const t = now();
  const ageDays = (e) => Math.max(0, (t - (e.published_at ?? e.observed_at)) / DAY);
  const fric = clean.filter((e) => FRICTION.test(`${e.title} ${e.body_excerpt}`));
  const prior = PRIORS[topic] ?? { near_fit: 0.5, feasibility: 0.5 };
  const comp = COMPETITORS[topic] ?? [];
  const coverage = comp.length ? Math.max(...comp.map((c) => c.coverage)) : 0;
  const c = {
    independent_demand: clamp((authEff / 10) * 0.6 + (srcEff / 3) * 0.4),
    recency: clean.length ? clamp(clean.reduce((a, e) => a + w(e) * Math.exp(-ageDays(e) / 45), 0) / sumW(clean)) : 0,
    onchain_corroboration: usage.length ? 1 : 0,
    friction_severity: clean.length ? clamp((sumW(fric) / sumW(clean)) * 1.5) : 0,
    competition_gap: clamp(1 - coverage - 0.05 * competitorHits),
    near_fit: prior.near_fit,
    feasibility: prior.feasibility,
    evidence_quality: demand.length ? clamp((demand.reduce((a, e) => a + w(e) * e.relevance, 0) / sumW(demand)) * (sumW(clean) / sumW(demand))) : 0,
  };
  const score = Object.entries(WEIGHTS).reduce((a, [k, wt]) => a + wt * c[k], 0);
  const warnings = [];
  if (coreSources.size < 3) {
    warnings.push(`LOW CONFIDENCE: only ${coreSources.size} independent non-social demand source(s)${socialSources.size ? ` (plus ${socialSources.size} social source(s), which are corroboration only)` : ''} and ${authors.size} distinct author(s) in total; at least 3 non-social sources are required.`);
  }
  if (!usage.length) warnings.push('No on-chain usage corroboration for this topic.');
  if (clean.length < demand.length) warnings.push(`${demand.length - clean.length} of ${demand.length} demand records de-weighted (bot, duplicate content, low-signal or injection-flagged).`);
  if (social.length) warnings.push(`${social.length} clean social record(s) from ${socialSources.size} source(s) are weighted ${SOCIAL_WEIGHT}× and capped; social posts are unverified and are never presented as fact.`);
  if (authEff < 5) warnings.push(`Only ${authors.size} distinct authors (${coreAuthors.size} non-social, ${socialAuthors.size} social; effective ${authEff.toFixed(1)}): single-voice campaigns cannot be ruled out.`);
  warnings.push('Author counts are an unverified breadth signal: one actor can use several accounts across sources.');
  warnings.push('near_fit and feasibility are curated priors, not measured.');
  // Confidence is NOT the score: it measures how much to trust the score. The source term counts NON-social sources only.
  const confidence = clamp(0.35 * clamp(coreSources.size / 3) + 0.25 * clamp(authEff / 8) + 0.15 * (usage.length ? 1 : 0) + 0.25 * c.evidence_quality);
  return {
    components: c, score: Number(score.toFixed(3)), confidence: Number(confidence.toFixed(3)), warnings,
    counts: {
      demand: demand.length, clean: clean.length, usage: usage.length, authors: authors.size, sources: sources.size, friction: fric.length,
      sourcesNonSocial: coreSources.size, authorsEffective: Number(authEff.toFixed(2)), sourcesSocial: socialSources.size, authorsNonSocial: coreAuthors.size, authorsSocial: socialAuthors.size, socialRecords: social.length,
    },
    formula: FORMULA, weights: WEIGHTS, priors: ['near_fit', 'feasibility'], sourceWeights: { social: SOCIAL_WEIGHT, socialBreadthCap: SOCIAL_BREADTH_CAP },
  };
}

const hydrate = (r) => ({ ...r, tags: parse(r.tags, []), flags: parse(r.flags, []), signals: parse(r.signals, {}), reasons: parse(r.relevance_reasons, []) });

/** Recompute opportunities + evidence links from stored evidence. Idempotent. */
export async function refreshOpportunities(db) {
  const rows = (await db.all('SELECT * FROM evidence')).map(hydrate);
  const out = [];
  for (const topic of Object.keys(TOPICS)) {
    const ev = rows.filter((e) => e.tags.includes(topic));
    if (!ev.length) continue;
    const aliases = (COMPETITORS[topic] ?? []).map((c) => c.alias).filter(Boolean);
    const compHits = ev.filter((e) => aliases.some((re) => re.test(`${e.title} ${e.body_excerpt}`)));
    const s = scoreTopic(topic, ev, compHits.length);
    const copy = OPP_COPY[topic] ?? {
      title: TOPICS[topic].label, thesis: `Recurring public friction around ${TOPICS[topic].label.toLowerCase()} may justify a focused tool. This is a hypothesis generated from keyword clustering, not a validated need.`,
      problem: `Evidence tagged "${topic}" suggests friction; a human or the Analyst must still characterize it.`, audience: 'NEAR builders (to be refined by the Analyst).',
    };
    const id = 'opp_' + topic;
    const t = now();
    await db.run(`INSERT INTO opportunities(id,title,thesis,problem,audience,topic,score_breakdown,score,confidence,warnings,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,?) ON CONFLICT(id) DO UPDATE SET score_breakdown=excluded.score_breakdown,score=excluded.score,confidence=excluded.confidence,warnings=excluded.warnings,updated_at=excluded.updated_at`,
      [id, copy.title, copy.thesis, copy.problem, copy.audience, topic, j(s), s.score, s.confidence, j(s.warnings), t, t]);
    await db.run('DELETE FROM evidence_links WHERE opportunity_id=?', [id]);
    for (const e of ev) {
      let rel = e.kind === 'usage' ? 'usage' : SOLVED.test(`${e.title} ${e.body_excerpt}`) ? 'contradicts' : 'supports';
      let note = rel === 'contradicts' ? 'text suggests the need is already addressed' : rel === 'usage' ? 'on-chain observation' : 'friction/demand signal';
      if (compHits.includes(e)) { await db.run('INSERT OR IGNORE INTO evidence_links VALUES(?,?,?,?)', [id, e.id, 'competitor', 'mentions an existing product']); }
      if (e.flags.some((f) => f.startsWith('bot') || f.startsWith('duplicate') || f.startsWith('low-signal'))) note += ' (de-weighted)';
      if (isSocialSource(e.source_id)) note += ' (social, low weight, unverified)';
      await db.run('INSERT OR IGNORE INTO evidence_links VALUES(?,?,?,?)', [id, e.id, rel, note]);
    }
    out.push({ id, topic, ...s });
  }
  return out;
}
