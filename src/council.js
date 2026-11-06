// Council: the decision layer between "we scored it" and "the agent may act". Seven seats (the same seven roles the research run uses) each cast a vote on every opportunity.
// A vote is computed from STORED data by the published rules below. It is not an LLM opinion, and nothing in a vote is invented: every reason string quotes the stored numbers it used.
//   support (0..1) per seat  ->  weighted support S = sum(weight x support)  ->  verdict: go | watch | drop
//   go     = S >= GO_AT and confidence >= MIN_CONFIDENCE and no veto and an attested build template exists for the topic
//   watch  = S >= WATCH_AT, or it would be a go but nothing can be built for the topic yet ("a trend we see and cannot ship yet")
//   drop   = anything else
// A veto (Skeptic or Security support below its floor) turns a go into watch. In Auto mode the vault loop executes a decision only when the council says go for its opportunity
// (src/autonomy.js); in Manual mode the council is advice shown next to the decision.
import { createHash } from 'node:crypto';
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
/** What each seat is: an off-chain rule in this file, with a stable AutoNEAR id. The id is ours, not an EIP, ERC or NEP number, and a seat is not a contract or an agent with a key. */
export const SEAT_INFO = Object.freeze({
  signal_collector: 'Is there real demand, from several independent sources?',
  evidence_analyst: 'What does the published scoring formula say, and how far can it be trusted?',
  skeptic: 'What argues against it: contradicting records and existing competitors?',
  product_architect: 'Does it fit what NEAR can do? (a hand-set estimate)',
  builder: 'Can it be built and checked with a contract template we already have?',
  security_reviewer: 'Are the supporting records clean, or flagged as bot, duplicate or injection?',
  launch_planner: 'Is interest speeding up or slowing down?',
});
const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
/** Hash of the published thresholds and of the code that turns stored numbers into votes and a verdict. Anyone with the source recomputes it; it changes when a rule changes. */
export const rulesHash = () => sha(canon({ rules: RULES, buildable: BUILDABLE_TOPICS, code: [votesFor.toString(), verdictOf.toString()] }));
export const seatId = (role) => `autonear:council-seat:${role}@1`;
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
  const n100 = (x) => Math.round(clamp(x ?? 0) * 100); const nEv = evidence.length;
  const v = {
    signal_collector: { support: clamp(c.independent_demand ?? 0), reason: `${counts.demand ?? 0} demand records from ${counts.sources ?? 0} different sources. Independent demand scores ${n100(c.independent_demand)} out of 100.` },
    evidence_analyst: { support: clamp((opp.score ?? 0) * (0.5 + 0.5 * (opp.confidence ?? 0))), reason: `The published scoring formula gives this product ${n100(opp.score)} out of 100 and trusts that score ${n100(opp.confidence)} out of 100.` },
    skeptic: { support: clamp(0.6 * (c.competition_gap ?? 0) + 0.4 * (1 - clamp((contradicts / Math.max(1, supports + contradicts)) * 2))), reason: `${contradicts} records argue against it and ${competitor} point to existing competitors, against ${supports} that support it. Room left in the market: ${n100(c.competition_gap)} out of 100.` },
    product_architect: { support: clamp(c.near_fit ?? 0), reason: `Fit with NEAR is ${n100(c.near_fit)} out of 100. This is a hand-set estimate, not a measurement.` },
    builder: { support: buildable ? clamp(c.feasibility ?? 0) : clamp((c.feasibility ?? 0) * 0.3), reason: buildable ? `A contract template exists that can be built and checked. Ease of building is ${n100(c.feasibility)} out of 100 (a hand-set estimate).` : 'No contract template exists for this topic yet, so nothing can be built and checked.' },
    security_reviewer: { support: clamp(1 - flaggedShare * 2 - (counts.usage ? 0 : 0.1)), reason: `${flagged} of ${nEv} linked records are flagged as bot, duplicate or injection${counts.usage ? '' : '. Nothing on-chain backs this up yet'}.` },
    launch_planner: { support: momentum, reason: `${recent} new records in the last ${RULES.trendWindowDays} days against ${prior} in the ${RULES.trendWindowDays} days before: ${recent > prior ? 'speeding up' : recent < prior ? 'slowing down' : 'flat'}.` },
  };
  return { votes: SEATS.map(([role, label]) => ({ role, label, weight: RULES.weights[role], support: Number(v[role].support.toFixed(3)), stance: stance(v[role].support), reason: v[role].reason })), momentum: Number(momentum.toFixed(3)), recent, prior, buildable };
}

export function verdictOf(S, confidence, votes, buildable) {
  const sk = votes.find((x) => x.role === 'skeptic').support; const sec = votes.find((x) => x.role === 'security_reviewer').support;
  const vetoes = []; if (sk < RULES.vetoSkeptic) vetoes.push('Skeptic'); if (sec < RULES.vetoSecurity) vetoes.push('Security');
  const goGrade = S >= RULES.goAt && confidence >= RULES.minConfidence && !vetoes.length; const q = (x) => Math.round(x * 100);
  if (goGrade && buildable) return { verdict: 'go', vetoes, reason: `The score of ${q(S)} out of 100 is above the ${q(RULES.goAt)} needed, confidence of ${q(confidence)} is above ${q(RULES.minConfidence)}, nobody vetoed, and it can be built and checked.` };
  if (goGrade) return { verdict: 'watch', vetoes, reason: `Strong enough (${q(S)} out of 100), but nothing can be built for this topic yet: a trend we see and cannot ship.` };
  if (S >= RULES.watchAt || (S >= RULES.goAt && vetoes.length)) return { verdict: 'watch', vetoes, reason: vetoes.length ? `${vetoes.join(' and ')} vetoed it, so a score of ${q(S)} out of 100 is not enough on its own.` : `The score of ${q(S)} out of 100 is between ${q(RULES.watchAt)} and ${q(RULES.goAt)}, or confidence of ${q(confidence)} is under ${q(RULES.minConfidence)}: keep watching.` };
  return { verdict: 'drop', vetoes, reason: `The score of ${q(S)} out of 100 is under the ${q(RULES.watchAt)} needed to keep watching.` };
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
    for (const x of votes) x.digest = sha(canon({ seat: seatId(x.role), opp: o.id, weight: x.weight, support: x.support, reason: x.reason }));
    const entry = { oppId: o.id, topic: o.topic, title: o.title, score: o.score, confidence: o.confidence, support: Number(S.toFixed(3)), momentum, recent, prior, buildable, ...v, votes };
    entry.digest = sha(canon({ opp: o.id, support: entry.support, verdict: entry.verdict, vetoes: entry.vetoes, votes: votes.map((x) => x.digest) }));
    out.push(entry);
  }
  const rank = { go: 0, watch: 1, drop: 2 };
  out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.support - a.support || b.momentum - a.momentum);
  const winner = out.find((x) => x.verdict === 'go')?.oppId ?? null;
  return { at: nowMs, rules: RULES, rulesHash: rulesHash(), seats: SEATS.map(([role, label]) => ({ role, label, id: seatId(role), question: SEAT_INFO[role], weight: RULES.weights[role], kind: 'off-chain rule' })), buildableTopics: BUILDABLE_TOPICS, opportunities: out, winner };
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

/** Real state of the journey from verdict to a monitored deployment, and the FINAL JUDGEMENT of where that product stands. Every field is read from stored runs, decisions, deployments and monitor results. */
export async function journeyFor(db, oppId, { verdict = null, mode = 'manual' } = {}) {
  const run = await db.get('SELECT * FROM runs WHERE opportunity_id=? ORDER BY started_at DESC LIMIT 1', [oppId]);
  const roles = {}; let artifacts = [];
  if (run) {
    for (const e of await db.all('SELECT agent_role, status FROM run_events WHERE run_id=? ORDER BY id', [run.id])) roles[e.agent_role] = e.status;
    artifacts = (await db.all('SELECT kind FROM artifacts WHERE run_id=?', [run.id])).map((a) => a.kind);
  }
  const decision = run ? await db.get("SELECT id, artifact_hash, status, approver, decided_at, expiry FROM decisions WHERE run_id=? AND action='deploy_testnet' ORDER BY created_at DESC LIMIT 1", [run.id]) : null;
  const deployment = decision ? await db.get('SELECT id, network, account, status, verification, explorer_url, time FROM deployments WHERE decision_id=? ORDER BY time DESC LIMIT 1', [decision.id]) : null;
  const monitor = deployment ? parse((await db.get('SELECT v FROM kv WHERE k=?', [`monitor:${deployment.id}`]))?.v, null) : null;
  // the checked build can be recorded against the decision's artifact hash (not only against this run), so look at both
  const built = artifacts.some((k) => k.startsWith('contract-build')) || Boolean(decision && await db.get("SELECT 1 x FROM artifacts WHERE hash=? AND kind LIKE 'contract-build:%'", [decision.artifact_hash])); const byAgent = Boolean(decision?.approver && String(decision.approver).startsWith('mandate:'));
  const verified = Boolean(deployment && ['verified', 'verified_local'].includes(deployment.status)); const expired = Boolean(decision && decision.status === 'pending' && decision.expiry < now());
  const declined = Boolean(decision && ['rejected', 'expired', 'cancelled'].includes(decision.status)) || expired;
  const st = (done, active, blocked) => (blocked ? 'blocked' : done ? 'done' : active ? 'active' : 'todo');
  const researchDone = Boolean(run && ['awaiting_approval', 'succeeded', 'blocked'].includes(run.state));
  const failedRun = Boolean(run && ['failed', 'budget_exceeded', 'cancelled'].includes(run.state));
  const stages = [
    { id: 'research', label: 'Research', state: !run ? 'todo' : run.state === 'running' || run.state === 'queued' ? 'active' : failedRun ? 'blocked' : 'done', detail: run ? `run ${run.state}` : 'no run yet' },
    { id: 'build', label: 'Build and check', state: st(built, run && !built && run.state === 'running', researchDone && !built), detail: built ? 'checked contract build stored' : researchDone ? 'no checked build yet (needs a build host)' : 'waiting' },
    { id: 'decision', label: 'Decision', state: st(Boolean(decision) && !declined, built && !decision, declined), detail: decision ? `decision ${expired ? 'expired' : decision.status}` : 'not created yet' },
    { id: 'approve', label: byAgent ? 'Agent executes in the limits' : 'Owner approves and signs', state: st(Boolean(decision?.approver) || Boolean(deployment), decision?.status === 'pending' && !expired, declined), detail: decision?.approver ? `approved by ${byAgent ? 'the agent inside the owner limits' : 'the owner'}` : declined ? 'not approved' : 'waiting' },
    { id: 'deploy', label: 'Deploy', state: st(Boolean(deployment), Boolean(decision?.approver) && !deployment), detail: deployment ? `deployment ${deployment.status}` : 'not deployed' },
    { id: 'verify', label: 'Check on chain', state: st(verified, Boolean(deployment) && !verified && deployment.status !== 'failed', Boolean(deployment) && deployment.status === 'failed'), detail: verified ? 'receipt matches the checked build' : deployment ? (deployment.status === 'failed' ? 'the receipt did not match' : 'checking') : 'waiting' },
    { id: 'monitor', label: 'Monitor', state: monitor ? (monitor.ok ? 'done' : 'blocked') : verified ? 'active' : 'todo', detail: monitor ? (monitor.ok ? `all ${monitor.checks?.length ?? 0} checks pass` : `failing: ${(monitor.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(', ').slice(0, 60)}`) : verified ? 'first check pending' : 'waiting' },
  ];
  const done = stages.filter((x) => x.state === 'done').length;
  let outcome;
  if (verified && monitor?.ok) outcome = { state: 'shipped', headline: 'Shipped and healthy', detail: `Deployed on ${deployment.network} at ${deployment.account}, verified against the checked build and re-checked on chain.`, next: 'Nothing needed. It is monitored on every check.' };
  else if (verified && monitor && !monitor.ok) outcome = { state: 'failed', headline: 'Shipped, but a check is failing', detail: `The monitor reports: ${(monitor.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(', ')}.`, next: 'The owner should pause and look at it.' };
  else if (verified) outcome = { state: 'live', headline: 'Shipped, first check pending', detail: `Deployed on ${deployment.network} at ${deployment.account} and verified against the checked build.`, next: 'The first monitor check runs on the next scheduled check.' };
  else if (deployment) outcome = { state: 'failed', headline: 'The deployment did not verify', detail: `Deployment status is ${deployment.status}.`, next: 'The owner reviews the receipt.' };
  else if (declined) outcome = { state: 'held', headline: expired ? 'The request expired' : 'The owner declined', detail: 'No contract was deployed.', next: 'A new run can create a new request.' };
  else if (failedRun) outcome = { state: 'failed', headline: 'The research run did not finish', detail: `Run state: ${run.state}.`, next: 'Retry the run from the Runs page.' };
  else if (researchDone && !built && !decision) outcome = { state: 'held', headline: 'Held at the build step', detail: 'The research is done, but there is no checked contract build to deploy.', next: 'Needs a build host with the Rust toolchain. Build there, then the request can be created.' };
  else if (decision?.status === 'pending') outcome = { state: 'waiting', headline: 'Waiting to be executed', detail: 'The request is ready.', next: mode === 'auto' ? 'In Auto the agent executes it inside the owner limits, because the council backs it.' : 'The owner approves and signs in their own wallet.' };
  else if (run && ['running', 'queued'].includes(run.state)) outcome = { state: 'in_progress', headline: 'Research in progress', detail: `Run ${run.state}.`, next: 'The seven roles run one after another.' };
  else if (verdict === 'go') outcome = { state: 'ready', headline: 'Backed by the council', detail: 'No run has started for this product yet.', next: 'The next scheduled check starts the research.' };
  else outcome = { state: 'not_started', headline: verdict ? `Council says ${verdict}` : 'Not started', detail: 'Nothing is being built for this product.', next: 'The council votes again on the next check.' };
  return { oppId, run: run ? { id: run.id, state: run.state, startedAt: run.started_at, endedAt: run.ended_at, roles } : null, decision: decision ? { id: decision.id, status: expired ? 'expired' : decision.status, byAgent } : null, deployment: deployment ? { id: deployment.id, status: deployment.status, explorer: deployment.explorer_url, account: deployment.account, network: deployment.network } : null, stages, outcome: { ...outcome, progress: { done, total: stages.length } } };
}
