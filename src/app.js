// Web-standard request handler. Runs unchanged under node:http (src/server.js) and Cloudflare Workers (src/worker.js).
import { timingSafeEqual } from 'node:crypto';
import { parse, j, now, verifyAuditChain, getBlob, audit } from './db.js';
import { config } from './config.js';
import { CONNECTORS } from './connectors/index.js';
import { ingestAll } from './ingest.js';
import { refreshOpportunities, FORMULA, WEIGHTS } from './scoring.js';
import { createRun, executeRun, emit, verifyRunChain, isPaused, setPaused, pipelineTick } from './orchestrator/coordinator.js';
import { oppEvidence, getOpp, hydrateEvidence } from './store.js';
import { approveDecision, rejectDecision, recordDeployment, getDecision, listDecisions } from './decisions.js';
import { recordAttestation } from './attest.js';
import { engineRegistry } from './orchestrator/adapters/index.js';
import { llmStatus } from './orchestrator/llm.js';
import { PROTOCOLS, findNetwork } from './protocols.js';
import { ROLE_POLICY, DECISION_LIMITS, PolicyError, validate } from './policy.js';
import { ALLOWED_HOSTS } from './http-client.js';

const SEC_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const out = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...SEC_HEADERS, ...extra } });
const cached = (data, s = 5) => out(data, 200, { 'cache-control': `public, max-age=${s}, stale-while-revalidate=30` });

const buckets = new Map();
function limited(ip, kind) {
  const cap = kind === 'write' ? 20 : 180; const key = `${kind}:${ip}`; const t = Date.now();
  const b = buckets.get(key) ?? { n: cap, t };
  b.n = Math.min(cap, b.n + ((t - b.t) / 60_000) * cap); b.t = t;
  if (b.n < 1) { buckets.set(key, b); return true; }
  b.n -= 1; buckets.set(key, b);
  if (buckets.size > 5000) { let k = 0; for (const key of buckets.keys()) { buckets.delete(key); if (++k >= 1000) break; } }
  return false;
}
/** Query-string integer, clamped. Garbage, NaN, fractions and negatives fall back to the default instead of reaching SQL. */
const intParam = (v, def, min, max) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : (Number.isInteger(n) && n > max ? max : def); };
/** Every routed path with the methods it accepts: an unknown method on a known path is 405 + Allow, not 404. */
const ALLOW = [
  [/^\/api\/(health|ready|status|protocols|engines|scoring|evidence|opportunities|deployments|security|decisions)$/, 'GET, HEAD'],
  [/^\/api\/(evidence|opportunities)\/\w+$/, 'GET, HEAD'],
  [/^\/api\/runs$/, 'GET, HEAD, POST'],
  [/^\/api\/runs\/run_\w+(\/events)?$/, 'GET, HEAD'],
  [/^\/api\/runs\/run_\w+\/(cancel|retry)$/, 'POST'],
  [/^\/api\/artifacts$/, 'GET, HEAD, POST'],
  [/^\/api\/artifacts\/art_\w+$/, 'GET, HEAD'],
  [/^\/api\/decisions\/dec_\w+$/, 'GET, HEAD'],
  [/^\/api\/decisions\/dec_\w+\/(approve|reject|receipt)$/, 'POST'],
  [/^\/api\/decisions\/dec_\w+\/deploy-data$/, 'GET, HEAD'],
  [/^\/api\/security\/(pause|resume)$/, 'POST'],
  [/^\/api\/ingest$/, 'POST'],
];
const safeEq = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const bearer = (req) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

export function createApp(deps) {
  const { db, defer = (p) => p.catch((e) => console.error('deferred:', e)), fetchImpl } = deps;
  const operatorToken = deps.operatorToken ?? '';
  const cronSecret = deps.cronSecret ?? config.cronSecret;

  const isOperator = (req) => Boolean(operatorToken) && safeEq(bearer(req), operatorToken);
  const needOperator = (req) => { if (!isOperator(req)) throw new PolicyError(operatorToken ? 'operator token required' : 'mutations disabled: OPERATOR_TOKEN is not configured', 'auth'); };
  const body = async (req, schema) => {
    const text = await req.text();
    if (text.length > 64_000) throw new PolicyError('body too large', 'input');
    let v = {}; try { v = text ? JSON.parse(text) : {}; } catch { throw new PolicyError('invalid JSON', 'input'); }
    if (schema) validate(schema, v);
    return v;
  };

  async function status() {
    const sources = await db.all('SELECT * FROM sources ORDER BY id');
    const lastRuns = new Map((await db.all('SELECT r.* FROM ingest_runs r JOIN (SELECT MAX(id) id FROM ingest_runs GROUP BY source_id) m ON r.id=m.id')).map((r) => [r.source_id, r]));
    const tick = parse((await db.get("SELECT v FROM kv WHERE k='tick:last'"))?.v, null);
    const active = await db.get("SELECT * FROM runs WHERE state IN ('queued','running') ORDER BY started_at DESC LIMIT 1");
    const counts = await db.get('SELECT (SELECT COUNT(*) FROM evidence) evidence, (SELECT COUNT(*) FROM opportunities) opportunities, (SELECT COUNT(*) FROM runs) runs, (SELECT COUNT(*) FROM decisions WHERE status=\'pending\') pending_decisions');
    const t = now();
    const interval = config.ingestIntervalMs;
    return {
      now: t,
      paused: await isPaused(db),
      sources: sources.map((s) => ({
        id: s.id, name: s.name, kind: s.kind, endpoint: s.endpoint, status: s.status, docs: s.docs_url, terms: s.terms, rateLimit: s.rate_limit,
        lastSuccess: s.last_success, lastError: s.last_error, lastErrorAt: s.last_error_at, failures: s.consecutive_failures, circuitOpenUntil: s.circuit_open_until,
        stale: !s.last_success || t - s.last_success > 6 * 36e5, lastRun: lastRuns.get(s.id) ?? null,
      })),
      scheduler: { mode: deps.schedulerMode ?? 'external', intervalMs: interval, lastTick: tick, nextRunAt: tick ? tick.at + interval : null, note: deps.schedulerNote ?? '' },
      activeRun: active ?? null,
      counts,
      llm: llmStatus(),
      budget: { perRunUsd: config.budget.usd, perRunTokens: config.budget.tokens },
      engines: engineRegistry().map(({ id, status: st, enabled }) => ({ id, status: st, enabled })),
      version: '0.1.0',
    };
  }

  async function route(req, url, ip) {
    const p = url.pathname; const m = req.method === 'HEAD' ? 'GET' : req.method;
    let g;

    if (p === '/api/health' && m === 'GET') return out({ ok: true, time: now() });
    if (p === '/api/ready' && m === 'GET') {
      const checks = {};
      try { await db.get('SELECT 1 x'); checks.storage = true; } catch { checks.storage = false; }
      const tick = parse((await db.get("SELECT v FROM kv WHERE k='tick:last'").catch(() => null))?.v, null);
      checks.workerFreshness = tick ? now() - tick.at < config.ingestIntervalMs * 3 : false;
      checks.operatorConfigured = Boolean(operatorToken);
      const ok = checks.storage;
      return out({ ok, checks }, ok ? 200 : 503);
    }
    if (p === '/api/status' && m === 'GET') return out(await status());
    if (p === '/api/protocols' && m === 'GET') return cached({ protocols: PROTOCOLS });
    if (p === '/api/engines' && m === 'GET') return cached({ engines: engineRegistry(), llm: llmStatus() });
    if (p === '/api/scoring' && m === 'GET') return cached({ formula: FORMULA, weights: WEIGHTS });

    if (p === '/api/evidence' && m === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 100); const source = url.searchParams.get('source');
      const cursor = intParam(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER); const limit = intParam(url.searchParams.get('limit'), 40, 1, 100);
      const where = []; const args = [];
      if (source) { where.push('source_id=?'); args.push(source); }
      if (q) { const lit = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`; where.push("(title LIKE ? ESCAPE '\\' OR body_excerpt LIKE ? ESCAPE '\\')"); args.push(lit, lit); }
      if (cursor) { where.push('COALESCE(published_at,observed_at) < ?'); args.push(cursor); }
      const rows = await db.all(`SELECT *, COALESCE(published_at,observed_at) AS sortkey FROM evidence ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(published_at,observed_at) DESC LIMIT ?`, [...args, limit + 1]);
      const page = rows.slice(0, limit).map(hydrateEvidence);
      return cached({ items: page, nextCursor: rows.length > limit ? page.at(-1).sortkey : null });
    }
    if ((g = p.match(/^\/api\/evidence\/([\w]+)$/)) && m === 'GET') {
      const e = await db.get('SELECT * FROM evidence WHERE id=?', [g[1]]);
      if (!e) return out({ error: 'not found' }, 404);
      const links = await db.all('SELECT opportunity_id, relation, note FROM evidence_links WHERE evidence_id=?', [g[1]]);
      const revisions = await db.all('SELECT content_hash, observed_at FROM evidence_revisions WHERE evidence_id=? ORDER BY observed_at', [g[1]]);
      const res = { ...hydrateEvidence(e), links, revisions };
      if (url.searchParams.get('raw') === '1') { needOperator(req); res.raw = parse(await getBlob(db, e.raw_ref), null); }
      return out(res);
    }
    if (p === '/api/opportunities' && m === 'GET') {
      const rows = await db.all('SELECT * FROM opportunities ORDER BY score DESC');
      return cached({ items: rows.map((o) => ({ ...o, score_breakdown: parse(o.score_breakdown, {}), warnings: parse(o.warnings, []) })), formula: FORMULA });
    }
    if ((g = p.match(/^\/api\/opportunities\/([\w]+)$/)) && m === 'GET') {
      const o = await getOpp(db, g[1]); if (!o) return out({ error: 'not found' }, 404);
      const ev = await oppEvidence(db, g[1]);
      const runs = await db.all('SELECT id,state,trigger,started_at,ended_at FROM runs WHERE opportunity_id=? ORDER BY started_at DESC LIMIT 10', [g[1]]);
      return out({ ...o, evidence: ev.slice(0, 120), evidenceTotal: ev.length, runs });
    }
    if (p === '/api/runs' && m === 'GET') return out({ items: await db.all('SELECT * FROM runs ORDER BY started_at DESC LIMIT 30') });
    if (p === '/api/runs' && m === 'POST') {
      needOperator(req);
      const b = await body(req, { type: 'object', required: ['opportunityId'], properties: { opportunityId: { type: 'string', maxLength: 64 }, chain: { type: 'string', maxLength: 32 }, owner: { type: 'string', maxLength: 128 }, proposer: { type: 'string', maxLength: 128 }, contractAccount: { type: 'string', maxLength: 64 } } });
      const idem = req.headers.get('idempotency-key');
      if (!idem) throw new PolicyError('Idempotency-Key header required', 'input');
      const { run, created } = await createRun(db, { opportunityId: b.opportunityId, trigger: 'operator', idemKey: `op:${idem.slice(0, 80)}`, params: { chain: b.chain, owner: b.owner, proposer: b.proposer, contractAccount: b.contractAccount } });
      if (created) defer(executeRun(db, run.id, { fetchImpl }));
      return out({ run, created }, created ? 202 : 200);
    }
    if ((g = p.match(/^\/api\/runs\/(run_\w+)$/)) && m === 'GET') {
      const r = await db.get('SELECT * FROM runs WHERE id=?', [g[1]]); if (!r) return out({ error: 'not found' }, 404);
      const decisions = await db.all('SELECT id,status,action,chain_id FROM decisions WHERE run_id=?', [g[1]]);
      const artifacts = await db.all('SELECT id,kind,hash,immutable_ref,created_at FROM artifacts WHERE run_id=?', [g[1]]);
      return out({ run: { ...r, budget: parse(r.budget, {}) }, decisions, artifacts, chain: await verifyRunChain(db, g[1]) });
    }
    if ((g = p.match(/^\/api\/runs\/(run_\w+)\/events$/)) && m === 'GET') {
      const after = intParam(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const r = await db.get('SELECT state FROM runs WHERE id=?', [g[1]]);
      if (!r) return out({ error: 'not found' }, 404);
      const ev = await db.all('SELECT * FROM run_events WHERE run_id=? AND id>? ORDER BY id LIMIT 200', [g[1], after]);
      return out({ events: ev.map((e) => ({ ...e, input_refs: parse(e.input_refs, []) })), state: r.state, terminal: !['queued', 'running'].includes(r.state) });
    }
    if ((g = p.match(/^\/api\/runs\/(run_\w+)\/cancel$/)) && m === 'POST') {
      needOperator(req);
      await db.run('UPDATE runs SET cancel_requested=1 WHERE id=? AND state IN (\'queued\',\'running\')', [g[1]]);
      await audit(db, 'operator', 'run.cancel_requested', { id: g[1] });
      return out({ ok: true });
    }
    if ((g = p.match(/^\/api\/runs\/(run_\w+)\/retry$/)) && m === 'POST') {
      needOperator(req);
      const r = await db.get('SELECT * FROM runs WHERE id=?', [g[1]]); if (!r) return out({ error: 'not found' }, 404);
      if (['queued', 'running', 'succeeded', 'awaiting_approval'].includes(r.state)) throw new PolicyError(`run is ${r.state}`, 'state');
      const b = parse(r.budget, {});
      const { run } = await createRun(db, { opportunityId: r.opportunity_id, trigger: 'operator', idemKey: `retry:${r.id}:${Date.now()}`, params: b.params });
      defer(executeRun(db, run.id, { fetchImpl }));
      return out({ run }, 202);
    }
    if ((g = p.match(/^\/api\/artifacts\/(art_\w+)$/)) && m === 'GET') {
      const a = await db.get('SELECT * FROM artifacts WHERE id=?', [g[1]]); if (!a) return out({ error: 'not found' }, 404);
      const content = parse(await getBlob(db, a.immutable_ref), null);
      return out({ ...a, test_results: parse(a.test_results, {}), content: a.kind.startsWith('contract-build') ? { ...content, deployedBytecode: content?.deployedBytecode ? `${content.deployedBytecode.slice(0, 66)}… (${content.deployedBytecode.length / 2 - 1} bytes)` : undefined, bytecode: undefined } : content });
    }
    if (p === '/api/artifacts' && m === 'GET') return out({ items: await db.all('SELECT id,kind,hash,run_id,commit_sha,test_results,created_at FROM artifacts ORDER BY created_at DESC LIMIT 50').then((r) => r.map((a) => ({ ...a, test_results: parse(a.test_results, {}) }))) });
    if (p === '/api/artifacts' && m === 'POST') { needOperator(req); const att = await body(req); return out(await recordAttestation(db, att, 'ci'), 201); }
    if (p === '/api/decisions' && m === 'GET') return out({ items: await listDecisions(db) });
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)$/)) && m === 'GET') { const d = await getDecision(db, g[1]); return d ? out(d) : out({ error: 'not found' }, 404); }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/approve$/)) && m === 'POST') {
      needOperator(req);
      const b = await body(req, { type: 'object', required: ['nonce', 'payloadHash', 'confirm', 'signer'] });
      return out(await approveDecision(db, g[1], { ...b, actor: 'operator' }));
    }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/reject$/)) && m === 'POST') { needOperator(req); const b = await body(req); return out(await rejectDecision(db, g[1], { actor: 'operator', reason: b.reason })); }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/receipt$/)) && m === 'POST') {
      needOperator(req);
      const b = await body(req, { type: 'object', required: ['txHash'], properties: { txHash: { type: 'string', maxLength: 100 } } });
      return out(await recordDeployment(db, g[1], { txHash: b.txHash, fetchImpl }));
    }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/deploy-data$/)) && m === 'GET') {
      needOperator(req);
      const d = await db.get('SELECT * FROM decisions WHERE id=?', [g[1]]);
      if (!d) return out({ error: 'not found' }, 404);
      if (d.status !== 'approved') throw new PolicyError('deploy data is only released for an approved decision', 'state');
      const net = findNetwork(d.chain_id); const payload = parse(d.payload, {});
      if (!net) throw new PolicyError(`unknown network ${d.chain_id}`, 'not_found');
      const att = await db.get('SELECT * FROM artifacts WHERE hash=? AND kind LIKE ?', [d.artifact_hash, 'contract-build:%']);
      if (!att) throw new PolicyError('attested artifact for this decision not found', 'not_found');
      const manifest = parse(await getBlob(db, att.immutable_ref), {});
      return out({ protocol: net.protocol, network: d.chain_id, chainId: net.chainId ?? null, artifactHash: d.artifact_hash, registry: payload.registry, abi: manifest.abi ?? null, bytecode: manifest.bytecode ?? null, wasmSha256: manifest.sha256, expectedDeployedBytecodeSha256: manifest.deployedBytecodeSha256 ?? null });
    }
    if (p === '/api/deployments' && m === 'GET') {
      const rows = await db.all('SELECT * FROM deployments ORDER BY time DESC LIMIT 50');
      return out({ items: await Promise.all(rows.map(async (d) => ({ ...d, verification: parse(d.verification, {}), monitor: parse((await db.get('SELECT v FROM kv WHERE k=?', [`monitor:${d.id}`]))?.v, null) }))) });
    }
    if (p === '/api/security' && m === 'GET') {
      const audits = await db.all('SELECT id,time,actor,action,detail,hash FROM audit ORDER BY id DESC LIMIT 40');
      return out({
        paused: await isPaused(db), auditChain: await verifyAuditChain(db),
        rolePolicy: ROLE_POLICY, hostAllowlist: Object.fromEntries(Object.entries(ALLOWED_HOSTS).map(([k, v]) => [k, [...v]])),
        decisionLimits: DECISION_LIMITS, budget: config.budget, auth: { operatorConfigured: Boolean(operatorToken) },
        audit: audits.map((a) => ({ ...a, detail: parse(a.detail, {}) })),
        keyScopes: [{ key: 'OPERATOR_TOKEN', scope: 'all mutations', holder: 'human operator' }, { key: 'CRON_SECRET', scope: '/api/cron/tick only', holder: 'scheduler' }, { key: 'LLM provider key', scope: 'server-side completion calls only', holder: 'server secret' }, { key: 'wallet keys', scope: 'NONE: never held by this system', holder: 'human, in their own wallet' }],
        runbook: 'docs/INCIDENT-RUNBOOK.md',
      });
    }
    if (p === '/api/security/pause' && m === 'POST') { needOperator(req); await setPaused(db, true, 'operator'); return out({ paused: true }); }
    if (p === '/api/security/resume' && m === 'POST') { needOperator(req); await setPaused(db, false, 'operator'); return out({ paused: false }); }
    if (p === '/api/ingest' && m === 'POST') {
      needOperator(req);
      const res = await ingestAll(db, { trigger: 'manual', fetchImpl }); await refreshOpportunities(db);
      return out({ results: res });
    }
    if (p === '/api/cron/tick') {
      const authorized = (cronSecret && safeEq(bearer(req), cronSecret)) || isOperator(req);
      if (!authorized) return out({ error: 'unauthorized' }, 401);
      if (m !== 'POST' && m !== 'GET') return out({ error: 'method' }, 405);
      const run = pipelineTick(db, { trigger: 'cron', fetchImpl, ingest: ingestAll });
      if (url.searchParams.get('wait') === '1') return out(await run);
      defer(run);
      return out({ accepted: true }, 202);
    }
    const allowed = ALLOW.find(([re]) => re.test(p));
    if (allowed) return out({ error: 'method not allowed', allow: allowed[1] }, 405, { allow: allowed[1] });
    return out({ error: 'not found' }, 404);
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? (process.env.TRUST_PROXY === '1' ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : null) ?? 'local';
    try {
      if (!url.pathname.startsWith('/api/')) return out({ error: 'not found' }, 404);
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (limited(ip, write ? 'write' : 'read')) return out({ error: 'rate limited' }, 429, { 'retry-after': '30' });
      const res = await route(req, url, ip);
      return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (e) {
      if (e instanceof PolicyError) {
        const code = e.code; const st = code === 'auth' ? 401 : code === 'not_found' ? 404 : code === 'paused' ? 423 : ['state', 'nonce', 'payload_hash'].includes(code) ? 409 : 400;
        return out({ error: e.message, code }, st);
      }
      console.error('unhandled', e);
      return out({ error: 'internal error' }, 500);
    }
  };
}
export { emit };
