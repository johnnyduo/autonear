// Council: the decision layer between "we scored it" and "the agent may act". Seven seats (the same seven roles the research run uses) each cast a vote on every opportunity.
// A vote is computed from STORED data by the published rules below. It is not an LLM opinion, and nothing in a vote is invented: every reason string quotes the stored numbers it used.
//   support (0..1) per seat  ->  weighted support S = sum(weight x support)  ->  verdict: go | watch | drop
//   go     = S >= GO_AT and confidence >= MIN_CONFIDENCE and no veto and an attested build template exists for the topic
//   watch  = S >= WATCH_AT, or it would be a go but nothing can be built for the topic yet ("a trend we see and cannot ship yet")
//   drop   = anything else
// A veto (Skeptic or Security support below its floor) turns a go into watch. In Auto mode the vault loop executes a decision only when the council says go for its opportunity
// (src/autonomy.js); in Manual mode the council is advice shown next to the decision.
import { now, j, parse, audit } from './db.js';

export const RULES = Object.freeze({
  weights: { signal_collector: 0.16, evidence_analyst: 0.22, skeptic: 0.18, product_architect: 0.10, builder: 0.12, security_reviewer: 0.10, launch_planner: 0.12 },
  goAt: 0.62, watchAt: 0.48, minConfidence: 0.45, vetoSkeptic: 0.25, vetoSecurity: 0.3, trendWindowDays: 14, freshMs: 6 * 3600e3,
});
/** Topics for which an attested contract-build template exists (the research run's Builder can produce a verifiable artifact). Same scope as autoPropose. */
export const BUILDABLE_TOPICS = Object.freeze(['treasury']);
export const SEATS = Object.freeze([
  ['signal_collector', 'Collector'], ['evidence_analyst', 'Analyst'], ['skeptic', 'Skeptic'], ['product_architect', 'Architect'], ['builder', 'Builder'], ['security_reviewer', 'Security'], ['launch_planner', 'Planner'],
]);
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const pct = (v) => `${Math.round(v * 100)}%`;
const stance = (s) => (s >= 0.6 ? 'back' : s >= 0.4 ? 'abstain' : 'object');

/** Pure: votes for one opportunity from its stored row, its linked evidence and its links. */
export function votesFor(opp, evidence, links, { nowMs = Date.now() } = {}) {
  const bd = parse(opp.score_breakdown, {}); const c = bd.components ?? {}; const counts = bd.counts ?? {};
  const rel = (k) => links.filter((l) => l.relation === k).length; const supports = rel('supports'); const contradicts = rel('contradicts'); const competitor = rel('competitor');
  const buildable = BUILDABLE_TOPICS.includes(opp.topic);
  const flagged = evidence.filter((e) => parse(e.flags, []).length > 0).length; const flaggedShare = evidence.length ? flagged / evidence.length : 0;
  const day = 864e5; const W = RULES.trendWindowDays * day; const t = (e) => e.published_at ?? e.observed_at;
  const recent = evidence.filter((e) => nowMs - t(e) <= W).length; const prior = evidence.filter((e) => nowMs - t(e) > W && nowMs - t(e) <= 2 * W).length;
  const momentum = evidence.length ? clamp(0.5 + 0.5 * Math.tanh((recent - prior) / Math.max(3, prior))) : 0.5;
  const v = {
    signal_collector: { support: clamp(c.independent_demand ?? 0), reason: `${counts.demand ?? 0} demand records from ${counts.sources ?? 0} sources; independent demand ${pct(c.independent_demand ?? 0)}` },
    evidence_analyst: { support: clamp((opp.score ?? 0) * (0.5 + 0.5 * (opp.confidence ?? 0))), reason: `score ${(opp.score ?? 0).toFixed(2)} at confidence ${(opp.confidence ?? 0).toFixed(2)}` },
    skeptic: { support: clamp(0.6 * (c.competition_gap ?? 0) + 0.4 * (1 - clamp((contradicts / Math.max(1, supports + contradicts)) * 2))), reason: `${contradicts} contradicting and ${competitor} competitor links against ${supports} supporting; competition gap ${pct(c.competition_gap ?? 0)}` },
    product_architect: { support: clamp(c.near_fit ?? 0), reason: `fit with NEAR ${pct(c.near_fit ?? 0)} (a curated prior, not measured)` },
    builder: { support: buildable ? clamp(c.feasibility ?? 0) : clamp((c.feasibility ?? 0) * 0.3), reason: buildable ? `an attested build template exists; feasibility ${pct(c.feasibility ?? 0)} (a curated prior)` : 'no attested build template for this topic yet, so nothing can be built and verified' },
    security_reviewer: { support: clamp(1 - flaggedShare * 2 - (counts.usage ? 0 : 0.1)), reason: `${flagged} of ${evidence.length} linked records carry a bot, duplicate or injection flag${counts.usage ? '' : '; no on-chain usage corroboration'}` },
    launch_planner: { support: momentum, reason: `${recent} records in the last ${RULES.trendWindowDays} days against ${prior} in the ${RULES.trendWindowDays} before: ${recent > prior ? 'speeding up' : recent < prior ? 'slowing down' : 'flat'}` },
  };
  return { votes: SEATS.map(([role, label]) => ({ role, label, weight: RULES.weights[role], support: Number(v[role].support.toFixed(3)), stance: stance(v[role].support), reason: v[role].reason })), momentum: Number(momentum.toFixed(3)), recent, prior, buildable };
}

export function verdictOf(S, confidence, votes, buildable) {
  const sk = votes.find((x) => x.role === 'skeptic').support; const sec = votes.find((x) => x.role === 'security_reviewer').support;
  const vetoes = []; if (sk < RULES.vetoSkeptic) vetoes.push('Skeptic'); if (sec < RULES.vetoSecurity) vetoes.push('Security');
  const goGrade = S >= RULES.goAt && confidence >= RULES.minConfidence && !vetoes.length;
  if (goGrade && buildable) return { verdict: 'go', vetoes, reason: `support ${S.toFixed(2)} clears ${RULES.goAt}, confidence ${confidence.toFixed(2)} clears ${RULES.minConfidence}, no veto, and it can be built and verified` };
  if (goGrade) return { verdict: 'watch', vetoes, reason: `strong enough (${S.toFixed(2)}) but nothing can be built for this topic yet: a trend we see and cannot ship` };
  if (S >= RULES.watchAt || (S >= RULES.goAt && vetoes.length)) return { verdict: 'watch', vetoes, reason: vetoes.length ? `${vetoes.join(' and ')} veto: support ${S.toFixed(2)} is not enough on its own` : `support ${S.toFixed(2)} is between ${RULES.watchAt} and ${RULES.goAt}, or confidence ${confidence.toFixed(2)} is under ${RULES.minConfidence}` };
  return { verdict: 'drop', vetoes, reason: `support ${S.toFixed(2)} is under ${RULES.watchAt}` };
}

/** Pure over the database: every opportunity, ranked. Does not write. */
export async function evaluate(db, { nowMs = Date.now() } = {}) {
  const opps = await db.all('SELECT * FROM opportunities');
  const out = [];
  for (const o of opps) {
    const links = await db.all('SELECT evidence_id, relation FROM evidence_links WHERE opportunity_id=?', [o.id]);
    const ids = [...new Set(links.map((l) => l.evidence_id))];
    const evidence = ids.length ? await db.all(`SELECT id, observed_at, published_at, flags FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    const { votes, momentum, recent, prior, buildable } = votesFor(o, evidence, links, { nowMs });
    const S = votes.reduce((a, x) => a + x.weight * x.support, 0); const v = verdictOf(S, o.confidence ?? 0, votes, buildable);
    out.push({ oppId: o.id, topic: o.topic, title: o.title, score: o.score, confidence: o.confidence, support: Number(S.toFixed(3)), momentum, recent, prior, buildable, ...v, votes });
  }
  const rank = { go: 0, watch: 1, drop: 2 };
  out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.support - a.support || b.momentum - a.momentum);
  const winner = out.find((x) => x.verdict === 'go')?.oppId ?? null;
  return { at: nowMs, rules: RULES, buildableTopics: BUILDABLE_TOPICS, opportunities: out, winner };
}

/** Evaluate, remember the result, and write an audit line only when a verdict changed (so the log is not spammed every tick). */
export async function convene(db, { trigger = 'scheduler', nowMs = Date.now() } = {}) {
  const res = await evaluate(db, { nowMs }); const prev = parse((await db.get("SELECT v FROM kv WHERE k='council:last'"))?.v, null);
  const key = (r) => (r?.opportunities ?? []).map((o) => `${o.oppId}:${o.verdict}`).join('|');
  await db.run("INSERT INTO kv(k,v) VALUES('council:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [j({ ...res, trigger })]);
  if (key(prev) !== key(res)) await audit(db, trigger, 'council.convened', { winner: res.winner, verdicts: res.opportunities.map((o) => ({ opp: o.oppId, verdict: o.verdict, support: o.support })) });
  return { ...res, trigger };
}

/** The stored session if it is fresh, else a new one. */
export async function currentCouncil(db, { maxAgeMs = RULES.freshMs } = {}) {
  const last = parse((await db.get("SELECT v FROM kv WHERE k='council:last'"))?.v, null);
  if (last && Date.now() - last.at <= maxAgeMs) return last;
  return convene(db, { trigger: 'on-demand' });
}

/** Gate used by the autonomy loop: may the agent act on a decision? Looks up the opportunity through the decision's run. Fail closed when it cannot be found. */
export async function councilGate(db, decision, env = process.env) {
  if (env.COUNCIL_GATE === '0') return { ok: true, reason: 'council gate disabled by the operator (COUNCIL_GATE=0)' };
  const run = decision.run_id ? await db.get('SELECT opportunity_id FROM runs WHERE id=?', [decision.run_id]) : null;
  if (!run) return { ok: false, reason: 'the decision is not tied to a research run, so there is no council verdict for it' };
  const c = await currentCouncil(db); const e = c.opportunities.find((o) => o.oppId === run.opportunity_id);
  if (!e) return { ok: false, reason: 'the council has no verdict for this opportunity' };
  return { ok: e.verdict === 'go', reason: `council verdict is ${e.verdict}: ${e.reason}`, entry: e };
}

/** Real state of the journey from verdict to a monitored deployment, for one opportunity. Every field is read from stored runs, decisions and deployments. */
export async function journeyFor(db, oppId) {
  const run = await db.get('SELECT * FROM runs WHERE opportunity_id=? ORDER BY started_at DESC LIMIT 1', [oppId]);
  const roles = {}; let artifacts = [];
  if (run) {
    for (const e of await db.all('SELECT agent_role, status FROM run_events WHERE run_id=? ORDER BY id', [run.id])) roles[e.agent_role] = e.status;
    artifacts = (await db.all('SELECT kind FROM artifacts WHERE run_id=?', [run.id])).map((a) => a.kind);
  }
  const decision = run ? await db.get("SELECT id, status, approver, decided_at, expiry FROM decisions WHERE run_id=? AND action='deploy_testnet' ORDER BY created_at DESC LIMIT 1", [run.id]) : null;
  const deployment = decision ? await db.get('SELECT id, status, verification, explorer_url, time FROM deployments WHERE decision_id=? ORDER BY time DESC LIMIT 1', [decision.id]) : null;
  const built = artifacts.some((k) => k.startsWith('contract-build')); const byAgent = Boolean(decision?.approver && String(decision.approver).startsWith('mandate:'));
  const ver = deployment ? parse(deployment.verification, {}) : null;
  const st = (done, active, blocked) => (blocked ? 'blocked' : done ? 'done' : active ? 'active' : 'todo');
  const researchDone = run && ['awaiting_approval', 'succeeded', 'blocked'].includes(run.state);
  const stages = [
    { id: 'research', label: 'Research', state: !run ? 'todo' : run.state === 'running' || run.state === 'queued' ? 'active' : run.state === 'failed' || run.state === 'budget_exceeded' || run.state === 'cancelled' ? 'blocked' : 'done', detail: run ? `run ${run.state}` : 'no run yet' },
    { id: 'build', label: 'Build and attest', state: st(built, run && !built && run.state === 'running', researchDone && !built), detail: built ? 'attested contract build stored' : researchDone ? 'no attested build (needs a build host with the toolchain)' : 'waiting' },
    { id: 'decision', label: 'Decision', state: st(Boolean(decision), built && !decision), detail: decision ? `decision ${decision.status}` : 'not created yet' },
    { id: 'approve', label: byAgent ? 'Agent executes in the limits' : 'Owner approves and signs', state: st(Boolean(decision?.approver) || Boolean(deployment), decision?.status === 'pending'), detail: decision?.approver ? `approved by ${byAgent ? 'the agent inside the owner limits' : 'the owner'}` : decision ? 'waiting' : 'waiting' },
    { id: 'deploy', label: 'Deploy', state: st(Boolean(deployment), Boolean(decision?.approver) && !deployment), detail: deployment ? `deployment ${deployment.status}` : 'not deployed' },
    { id: 'verify', label: 'Verify on chain', state: st(Boolean(ver && (ver.ok === true || deployment?.status === 'confirmed')), Boolean(deployment) && !(ver && ver.ok === true)), detail: deployment ? (ver?.ok === true ? 'receipt matches the attested build' : 'checking') : 'waiting' },
  ];
  return { oppId, run: run ? { id: run.id, state: run.state, startedAt: run.started_at, endedAt: run.ended_at, roles } : null, decision: decision ? { id: decision.id, status: decision.status, byAgent } : null, deployment: deployment ? { id: deployment.id, status: deployment.status, explorer: deployment.explorer_url } : null, stages };
}
