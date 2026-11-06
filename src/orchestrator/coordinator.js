// Typed run coordinator. Every stage emits hash-chained run_events. Outputs are stored as immutable blobs.
import { sha256, now, j, parse, putBlob, getBlob, audit } from '../db.js';
import { Budget, PolicyError } from '../policy.js';
import { oppEvidence, getOpp } from '../store.js';
import { ROLES } from './agents.js';
import { refreshOpportunities } from '../scoring.js';
import { monitorDeployments } from '../monitor.js';
import { convene } from '../council.js';

const STAGE_LABEL = { signal_collector: 'collect', evidence_analyst: 'analyse', skeptic: 'challenge', product_architect: 'design', builder: 'build', security_reviewer: 'secure', launch_planner: 'plan' };

export async function isPaused(db) { return (await db.get("SELECT v FROM kv WHERE k='kill_switch'"))?.v === '1'; }
export async function setPaused(db, paused, actor) {
  await db.run("INSERT INTO kv(k,v) VALUES('kill_switch',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [paused ? '1' : '0']);
  await audit(db, actor, paused ? 'kill_switch.engage' : 'kill_switch.release', {});
}

export async function emit(db, runId, e) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const prev = (await db.get('SELECT hash FROM run_events WHERE run_id=? ORDER BY id DESC LIMIT 1', [runId]))?.hash ?? sha256(runId);
    const time = now();
    const row = { stage: e.stage, agent_role: e.role, time, input_refs: j(e.inputRefs ?? []), output_ref: e.outputRef ?? null, model: e.model ?? null, tokens: e.tokens ?? 0, cost: e.cost ?? 0, status: e.status, detail: String(e.detail ?? '').slice(0, 500) };
    const hash = sha256(`${prev}|${j(row)}`);
    try {
      await db.run('INSERT INTO run_events(run_id,stage,agent_role,time,input_refs,output_ref,model,tokens,cost,status,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [runId, row.stage, row.agent_role, time, row.input_refs, row.output_ref, row.model, row.tokens, row.cost, row.status, row.detail, prev, hash]);
      return hash;
    } catch (err) { if (!/UNIQUE|constraint/i.test(String(err.message))) throw err; }
  }
  throw new Error('run_events: could not append');
}

export async function verifyRunChain(db, runId) {
  let prev = sha256(runId);
  for (const r of await db.all('SELECT * FROM run_events WHERE run_id=? ORDER BY id', [runId])) {
    const row = { stage: r.stage, agent_role: r.agent_role, time: r.time, input_refs: r.input_refs, output_ref: r.output_ref, model: r.model, tokens: r.tokens, cost: r.cost, status: r.status, detail: r.detail };
    if (r.prev_hash !== prev || sha256(`${prev}|${j(row)}`) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}

/** Create a run (idempotent on idemKey). Does not execute; call executeRun. */
export async function createRun(db, { opportunityId, trigger = 'operator', idemKey = null, params = {} }) {
  if (await isPaused(db)) throw new PolicyError('kill switch engaged: runs are disabled', 'paused');
  if (idemKey) { const ex = await db.get('SELECT * FROM runs WHERE idem_key=?', [idemKey]); if (ex) return { run: ex, created: false }; }
  const opp = await getOpp(db, opportunityId);
  if (!opp) throw new PolicyError(`unknown opportunity ${opportunityId}`, 'not_found');
  const b = new Budget();
  const id = 'run_' + sha256(`${opportunityId}|${now()}|${Math.random()}`).slice(0, 12);
  await db.run('INSERT INTO runs(id,idem_key,opportunity_id,trigger,state,budget,started_at) VALUES(?,?,?,?,?,?,?)', [id, idemKey, opportunityId, trigger, 'queued', j({ usd: b.usd, tokens: b.tokens, params }), now()]);
  await audit(db, trigger, 'run.created', { id, opportunityId });
  return { run: await db.get('SELECT * FROM runs WHERE id=?', [id]), created: true };
}

export async function executeRun(db, runId, { fetchImpl } = {}) {
  const run = await db.get('SELECT * FROM runs WHERE id=?', [runId]);
  if (!run || !['queued', 'failed_retryable'].includes(run.state)) return run;
  const claimed = await db.run("UPDATE runs SET state='running' WHERE id=? AND state IN ('queued','failed_retryable')", [runId]);
  if (!claimed.changes) return run;
  const bj = parse(run.budget, {});
  const budget = new Budget({ usd: bj.usd, tokens: bj.tokens });
  const opp = await getOpp(db, run.opportunity_id);
  const evidence = await oppEvidence(db, run.opportunity_id);
  const ctx = { db, run, opp, evidence, budget, fetchImpl, params: bj.params ?? {}, prior: {} };
  let final = 'succeeded'; let error = null;
  try {
    for (const [role, label, fn] of ROLES) {
      const cur = await db.get('SELECT cancel_requested FROM runs WHERE id=?', [runId]);
      if (cur.cancel_requested) { final = 'cancelled'; await emit(db, runId, { stage: STAGE_LABEL[role], role, status: 'cancelled', detail: 'cancelled by operator' }); break; }
      if (await isPaused(db)) { final = 'cancelled'; error = 'kill switch engaged'; await emit(db, runId, { stage: STAGE_LABEL[role], role, status: 'cancelled', detail: 'kill switch engaged' }); break; }
      await emit(db, runId, { stage: STAGE_LABEL[role], role, status: 'started', detail: label, inputRefs: Object.values(ctx.prior).map((p) => p.__ref).filter(Boolean) });
      let res;
      try { res = await fn(ctx); } catch (e) {
        await emit(db, runId, { stage: STAGE_LABEL[role], role, status: 'failed', detail: e.message });
        throw e;
      }
      const ref = await putBlob(db, j({ role, output: res.output, citations: res.citations }));
      ctx.prior[role] = { ...res.output, __ref: ref };
      budget.charge({ usd: res.cost ?? 0, tokens: res.tokens ?? 0 });
      await db.run('UPDATE runs SET spent_usd=?, spent_tokens=? WHERE id=?', [budget.spentUsd, budget.spentTokens, runId]);
      await emit(db, runId, { stage: STAGE_LABEL[role], role, status: res.failed || res.output?.status === 'blocked' ? 'blocked' : 'completed', detail: res.detail, outputRef: ref, model: res.model, tokens: res.tokens, cost: res.cost });
      if (role === 'product_architect') {
        const bref = await putBlob(db, j(res.output.brief));
        await db.run('INSERT OR IGNORE INTO artifacts(id,run_id,kind,immutable_ref,hash,test_results,created_at) VALUES(?,?,?,?,?,?,?)',
          ['art_' + res.output.briefHash.slice(0, 14), runId, 'brief', bref, res.output.briefHash, '{}', now()]);
      }
      if (role === 'security_reviewer') {
        const sref = ref; const h = sref.replace('sha256:', '');
        await db.run('INSERT OR IGNORE INTO artifacts(id,run_id,kind,immutable_ref,hash,test_results,created_at) VALUES(?,?,?,?,?,?,?)', ['art_' + h.slice(0, 14), runId, 'security-dossier', sref, h, j({ status: res.output.status }), now()]);
      }
    }
    const planner = ctx.prior.launch_planner;
    if (final === 'succeeded' && planner?.status === 'pending_human_approval') final = 'awaiting_approval';
    else if (final === 'succeeded' && ctx.prior.builder?.status === 'blocked') final = 'blocked';
  } catch (e) {
    final = e instanceof PolicyError && e.code.startsWith('budget') ? 'budget_exceeded' : 'failed'; error = e.message;
  }
  await db.run('UPDATE runs SET state=?, ended_at=?, error=? WHERE id=?', [final, now(), error, runId]);
  await audit(db, 'coordinator', 'run.finished', { id: runId, state: final, error });
  return db.get('SELECT * FROM runs WHERE id=?', [runId]);
}

/** Dead-letter handling: runs stuck in queued/running are failed so they never block the pipeline silently. */
export async function recoverRuns(db, { staleMs = 10 * 60_000 } = {}) {
  const cutoff = now() - staleMs;
  const stuck = await db.all("SELECT id FROM runs WHERE state IN ('queued','running') AND started_at < ?", [cutoff]);
  for (const r of stuck) {
    await db.run("UPDATE runs SET state='dead_letter', ended_at=?, error='stalled: no progress within window' WHERE id=?", [now(), r.id]);
    await emit(db, r.id, { stage: 'recover', role: 'coordinator', status: 'dead_letter', detail: 'run stalled; moved to dead-letter' });
  }
  return stuck.length;
}

/** Realtime monitoring → proposal: after ingestion, start a run for the best opportunity if something material changed. */
export async function autoPropose(db, { fetchImpl, force = false } = {}) {
  if (process.env.AUTO_RUN === '0' || (await isPaused(db))) return { started: false, reason: 'auto-run disabled or paused' };
  const opps = (await db.all('SELECT * FROM opportunities ORDER BY score DESC')).filter((o) => o.topic === 'treasury');
  const top = opps[0];
  if (!top) return { started: false, reason: 'no eligible opportunity' };
  const last = parse((await db.get("SELECT v FROM kv WHERE k='autorun:last'"))?.v, null);
  const evCount = (await db.get('SELECT COUNT(*) n FROM evidence_links WHERE opportunity_id=?', [top.id])).n;
  const material = !last || Math.abs(top.score - last.score) >= 0.03 || evCount >= last.evCount * 1.1;
  const cooled = !last || now() - last.at > 24 * 36e5;
  if (!force && !(material && cooled)) return { started: false, reason: `no material change (cooldown ${cooled ? 'ok' : 'active'})` };
  const { run } = await createRun(db, { opportunityId: top.id, trigger: 'scheduler', idemKey: `auto:${top.id}:${new Date().toISOString().slice(0, 13)}` });
  await db.run("INSERT INTO kv(k,v) VALUES('autorun:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [j({ at: now(), score: top.score, evCount })]);
  const done = await executeRun(db, run.id, { fetchImpl });
  return { started: true, runId: run.id, state: done.state };
}

/** One full scheduled tick: ingest → rescore → recover → (maybe) propose. */
export async function pipelineTick(db, { trigger = 'scheduler', fetchImpl, ingest } = {}) {
  const t0 = now();
  const ing = await ingest(db, { trigger, fetchImpl });
  const opps = await refreshOpportunities(db);
  const council = await convene(db, { trigger }).catch((e) => ({ error: e.message }));
  const recovered = await recoverRuns(db);
  const auto = await autoPropose(db, { fetchImpl });
  const monitored = await monitorDeployments(db, { fetchImpl }).catch((e) => [{ error: e.message }]);
  await db.run("INSERT INTO kv(k,v) VALUES('tick:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [j({ at: now(), trigger, ms: now() - t0, sources: ing.map((i) => ({ id: i.sourceId, status: i.status })), opportunities: opps.length, recovered, auto, monitored: monitored.length })]);
  return { ingest: ing, opportunities: opps.length, council: council.winner ?? null, recovered, auto, monitored };
}

export { getBlob };
