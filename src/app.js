// Web-standard request handler. Runs unchanged under node:http (src/server.js) and Cloudflare Workers (src/worker.js).
import { timingSafeEqual } from 'node:crypto';
import { parse, j, now, verifyAuditChain, getBlob, audit } from './db.js';
import { config } from './config.js';
import { CONNECTORS } from './connectors/index.js';
import { ingestAll } from './ingest.js';
import { refreshOpportunities, FORMULA, WEIGHTS, SCORING_NOTES } from './scoring.js';
import { createRun, executeRun, emit, verifyRunChain, isPaused, setPaused, pipelineTick } from './orchestrator/coordinator.js';
import { oppEvidence, getOpp, hydrateEvidence } from './store.js';
import { approveDecision, rejectDecision, recordDeployment, getDecision, listDecisions } from './decisions.js';
import { recordAttestation } from './attest.js';
import { engineRegistry } from './orchestrator/adapters/index.js';
import { llmStatus } from './orchestrator/llm.js';
import { PROTOCOLS, findNetwork } from './protocols.js';
import { ROLE_POLICY, DECISION_LIMITS, PolicyError, validate, vaultLimits } from './policy.js';
import { ALLOWED_HOSTS } from './http-client.js';
import { vaultReport, listLedger, pauseLoop, resumeLoop, attachVault, proposeGrant, buildPlan, vaultStatusSummary, agentRegistrationFile, getLoop, verifyGrant, activateVault, getVault } from './vault/index.js';
import { createPayment, listPayments, recordPayment } from './payments.js';
import { getMode, setMode, topUpConfig } from './autonomy-mode.js';
import { currentCouncil, journeyFor, pickFocus, queueFor } from './council.js';
import { getWatch, setWatch } from './watch.js';
import { WELL_KNOWN_PATH } from './identity/erc8004.js';
import { buildSite, listView, view as siteView, pageResponse } from './sites/service.js';
import { publish as publishSite, unpublish as unpublishSite } from './sites/store.js';
import { buildChallenge, checkSignedChallenge, consumeNonce, deriveSecret, issueSession, readSession, resolveOwner, SESSION_TTL_MS } from './owner-session.js';

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
  [/^\/api\/vault(\/ledger|\/plan|\/verify)?$/, 'GET, HEAD'],
  [/^\/api\/payments$/, 'GET, HEAD, POST'],
  [/^\/api\/vault\/(loop\/(pause|resume)|mandates\/propose|attach|activate)$/, 'POST'],
  [/^\/api\/auth\/(challenge|session)$/, 'POST'],
  [/^\/api\/auth\/me$/, 'GET, HEAD'],
  [/^\/api\/autonomy$/, 'GET, HEAD'],
  [/^\/api\/council$/, 'GET, HEAD'],
  [/^\/api\/watch$/, 'GET, HEAD, PUT'],
  [/^\/api\/sites$/, 'GET, HEAD'],
  [/^\/api\/sites\/[\w-]+\/(build|publish|unpublish)$/, 'POST'],
  [/^\/api\/autonomy\/mode$/, 'PUT'],
];
const safeEq = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const bearer = (req) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

export function createApp(deps) {
  const { db, defer = (p) => p.catch((e) => console.error('deferred:', e)), fetchImpl } = deps;
  const operatorToken = deps.operatorToken ?? '';
  const cronSecret = deps.cronSecret ?? config.cronSecret;
  const keystore = deps.keystore ?? null;                       // public view only is ever read from it (agent addresses)
  const signingSupported = Boolean(deps.signingSupported);       // false on the Worker: the signing loop only exists on the Node runtime
  const agentPublicUrl = deps.agentPublicUrl ?? config.agent.publicUrl;

  const isOperator = (req) => Boolean(operatorToken) && safeEq(bearer(req), operatorToken);
  const needOperator = (req) => { if (!isOperator(req)) throw new PolicyError(operatorToken ? 'operator token required' : 'mutations disabled: OPERATOR_TOKEN is not configured', 'auth'); };
  // Owner sessions (wallet-signed). Valid only for the few routes that call needOwner; ownership is re-resolved on every request.
  const sessionSecret = deriveSecret(operatorToken);
  const extraOwners = deps.extraOwners ?? config.extraOwners ?? [];
  const primaryOwner = async () => (deps.resolveOwner ? String((await deps.resolveOwner()) ?? '').toLowerCase() || null : resolveOwner(db, deps.ownerAddress ?? config.ownerAddress));
  /** All current owners (primary + co-owners), re-resolved on every call. */
  const ownersOf = async () => { const p = await primaryOwner(); return [...new Set([...(p ? [p] : []), ...extraOwners.map((a) => String(a).toLowerCase())])]; };
  const sessionTtl = deps.sessionTtlMs ?? SESSION_TTL_MS;
  const publicHosts = deps.publicHosts ?? config.publicHosts;
  // The sign-in message is bound to a domain. Behind a proxy the Host header is client-influenced, so a configured allowlist (PUBLIC_HOSTS) decides which domains can be signed for.
  const signInHost = (url) => { const h = url.host.toLowerCase(); if (publicHosts.length && !publicHosts.includes(h)) throw new PolicyError('sign-in is not available on this domain', 'input'); return url.host; };
  /** For receipt/deploy-data: an owner session may touch only requests bound to its own wallet; the operator token may touch any. */
  const ownsDecision = async (who, id) => { if (!who.address) return; const d = await db.get('SELECT bound_signer, approver FROM decisions WHERE id=?', [id]); const mine = d && (String(d.bound_signer ?? '').toLowerCase() === who.address || String(d.approver ?? '').toLowerCase().endsWith(`+owner:${who.address}`)); if (!mine) throw new PolicyError('this request is bound to a different signer', 'signer'); }; // after the agent claims an owner-approved request the bound signer is the vault, so the approving owner is recognised by the approver record
  const sessionOf = async (req) => {
    const s = readSession(bearer(req), { secret: sessionSecret });
    if (!s) return null;
    return (await ownersOf()).includes(s.address) ? s : null;
  };
  /** Operator token OR a valid owner session. Returns { actor, address|null }. */
  const needOwner = async (req) => {
    if (isOperator(req)) return { actor: 'operator', address: null };
    const s = await sessionOf(req);
    if (!s) throw new PolicyError(operatorToken ? 'operator token or owner sign-in required' : 'mutations disabled: OPERATOR_TOKEN is not configured', 'auth');
    return { actor: `owner:${s.address}`, address: s.address };
  };
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
    const metas = new Map((await db.all("SELECT k,v FROM kv WHERE k LIKE 'meta:%'")).map((r) => [r.k.slice(5), parse(r.v, null)]));
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
        stale: !s.last_success || t - s.last_success > 6 * 36e5, lastRun: lastRuns.get(s.id) ?? null, meta: metas.get(s.id) ?? null,
      })),
      scheduler: { mode: deps.schedulerMode ?? 'external', intervalMs: interval, lastTick: tick, nextRunAt: tick ? tick.at + interval : null, note: deps.schedulerNote ?? '' },
      activeRun: active ?? null,
      counts,
      llm: llmStatus(),
      budget: { perRunUsd: config.budget.usd, perRunTokens: config.budget.tokens },
      engines: engineRegistry().map(({ id, status: st, enabled }) => ({ id, status: st, enabled })),
      vault: await vaultStatusSummary(db),
      autonomy: { mode: await getMode(db) },
      version: '0.1.0',
    };
  }

  async function route(req, url, ip) {
    const p = url.pathname; const m = req.method === 'HEAD' ? 'GET' : req.method;
    let g;

    if ((g = p.match(/^\/develop\/(.*)$/))) { // public example pages (strict CSP, see src/sites/service.js)
      if (m !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
      return pageResponse(db, g[1]);
    }
    if (p === '/api/health' && m === 'GET') return out({ ok: true, time: now() });
    if (p === '/api/watch' && m === 'GET') return out({ ...(await getWatch(db)), sourceIds: CONNECTORS.map((c) => c.id) });
    if (p === '/api/watch' && m === 'PUT') {
      const who = await needOwner(req);
      return out(await setWatch(db, await body(req), who.actor, { sourceIds: CONNECTORS.map((c) => c.id) }));
    }
    if (p === '/api/council' && m === 'GET') {
      const council = await currentCouncil(db); const queue = await queueFor(db, council);
      const focusId = pickFocus(council.opportunities, { focus: url.searchParams.get('focus'), published: new Set(queue.filter((x) => x.page === 'published').map((x) => x.oppId)) });
      const mode = await getMode(db); const fe = council.opportunities.find((o) => o.oppId === focusId);
      return out({ council, journey: focusId ? await journeyFor(db, focusId, { verdict: fe?.verdict, pageReady: fe?.pageReady, mode }) : null, queue, mode });
    }
    if (p === '/api/sites' && m === 'GET') return out({ items: await listView(db, await currentCouncil(db)), thresholds: { go: 62, watch: 48 } });
    if ((g = p.match(/^\/api\/sites\/([\w-]{1,64})\/build$/)) && m === 'POST') { // owner only: one model call per product, then the page is stored
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', properties: { override: { type: 'boolean' }, regenerate: { type: 'boolean' } } });
      const entry = (await currentCouncil(db)).opportunities.find((o) => o.oppId === g[1]);
      try {
        const r = await buildSite(db, { oppId: g[1], entry, override: b.override === true, regenerate: b.regenerate === true, actor: who.actor });
        return out({ site: siteView(r.site), created: r.created }, r.created ? 201 : 200);
      } catch (e) {
        if (e?.message === 'No LLM is configured') return out({ error: e.message, code: 'llm' }, 503);
        if (e instanceof PolicyError && e.code === 'llm_format') return out({ error: e.message, code: 'llm' }, 502);
        throw e;
      }
    }
    if ((g = p.match(/^\/api\/sites\/([a-z0-9-]{1,40})\/publish$/)) && m === 'POST') {
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', required: ['hash'], properties: { hash: { type: 'string', maxLength: 16 } } });
      if (!/^[0-9a-f]{10}$/.test(b.hash)) throw new PolicyError('hash must be 10 hex characters', 'input');
      const site = await publishSite(db, g[1], b.hash);
      await audit(db, who.actor, 'site.publish', { slug: g[1], hash: b.hash });
      return out({ site: siteView(site) });
    }
    if ((g = p.match(/^\/api\/sites\/([a-z0-9-]{1,40})\/unpublish$/)) && m === 'POST') {
      const who = await needOwner(req);
      const changed = await unpublishSite(db, g[1]);
      await audit(db, who.actor, 'site.unpublish', { slug: g[1], changed });
      return out({ slug: g[1], unpublished: changed });
    }
    if (p === '/api/autonomy' && m === 'GET') {
      const evm = topUpConfig(process.env, 'evm'); const near = topUpConfig(process.env, 'near');
      const str = (c) => ({ low: String(c.low), target: String(c.target) });
      return out({ mode: await getMode(db), topUp: { evm: str(evm), near: str(near) }, signingSupported });
    }
    if (p === '/api/autonomy/mode' && m === 'PUT') {
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', required: ['mode'], properties: { mode: { type: 'string', maxLength: 10 } } });
      return out({ mode: await setMode(db, b.mode, who.actor) });
    }
    if (p === '/api/auth/challenge' && m === 'POST') {
      if (!sessionSecret) throw new PolicyError('sign-in is disabled: OPERATOR_TOKEN is not configured', 'auth');
      const b = await body(req, { type: 'object', required: ['address'], properties: { address: { type: 'string', maxLength: 64 } } });
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.address)) throw new PolicyError('an EVM address is required', 'input');
      const { message, exp } = buildChallenge({ host: signInHost(url), address: b.address });
      return out({ message, exp });
    }
    if (p === '/api/auth/session' && m === 'POST') {
      if (!sessionSecret) throw new PolicyError('sign-in is disabled: OPERATOR_TOKEN is not configured', 'auth');
      const b = await body(req, { type: 'object', required: ['address', 'message', 'signature'], properties: { address: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 1000 }, signature: { type: 'string', maxLength: 400 } } });
      let c; try { c = await checkSignedChallenge({ ...b, host: signInHost(url) }); } catch (e) { throw new PolicyError(e.message, 'auth'); }
      if (!(await ownersOf()).includes(c.signer)) return out({ isOwner: false, address: c.signer, token: null, exp: null }); // read-only wallet: no token, no nonce row
      if (!(await consumeNonce(db, c.nonce, c.exp))) throw new PolicyError('this sign-in challenge was already used', 'auth');
      const t = now(); const exp = t + sessionTtl;
      await audit(db, `owner:${c.signer}`, 'owner.signed_in', {});
      return out({ isOwner: true, address: c.signer, token: issueSession({ address: c.signer, secret: sessionSecret, t, ttlMs: sessionTtl }), exp });
    }
    if (p === '/api/auth/me' && m === 'GET') {
      const s = await sessionOf(req); const o = await ownersOf();
      return out({ isOwner: Boolean(s), address: s?.address ?? null, ownerConfigured: o.length > 0, operator: isOperator(req) });
    }
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
    if (p === '/api/scoring' && m === 'GET') return cached({ formula: FORMULA, weights: WEIGHTS, ...SCORING_NOTES });

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
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', required: ['nonce', 'payloadHash', 'confirm', 'signer'] });
      if (who.address && String(b.signer ?? '').toLowerCase() !== who.address) throw new PolicyError('the signer must be the signed-in wallet', 'input');
      return out(await approveDecision(db, g[1], { ...b, actor: who.actor }));
    }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/reject$/)) && m === 'POST') { const who = await needOwner(req); const b = await body(req); return out(await rejectDecision(db, g[1], { actor: who.actor, reason: b.reason })); }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/receipt$/)) && m === 'POST') {
      await ownsDecision(await needOwner(req), g[1]);
      const b = await body(req, { type: 'object', required: ['txHash'], properties: { txHash: { type: 'string', maxLength: 100 } } });
      const isPayment = (await db.get('SELECT action FROM decisions WHERE id=?', [g[1]]))?.action === 'pay_testnet'; // a stuck payment is recorded (verified) the same way
      return out(isPayment ? await recordPayment(db, g[1], { txHash: b.txHash, fetchImpl }) : await recordDeployment(db, g[1], { txHash: b.txHash, fetchImpl }));
    }
    if ((g = p.match(/^\/api\/decisions\/(dec_\w+)\/deploy-data$/)) && m === 'GET') {
      await ownsDecision(await needOwner(req), g[1]);
      const d = await db.get('SELECT * FROM decisions WHERE id=?', [g[1]]);
      if (!d) return out({ error: 'not found' }, 404);
      if (d.action !== 'deploy_testnet') throw new PolicyError(`a ${d.action} decision has no deploy data`, 'state');
      if (d.status !== 'approved') throw new PolicyError('deploy data is only released for an approved decision', 'state');
      if (String(d.approver ?? '').startsWith('mandate:')) throw new PolicyError('this decision is executed by the agent under a mandate: no human signs it', 'state');
      const net = findNetwork(d.chain_id); const payload = parse(d.payload, {});
      if (!net) throw new PolicyError(`unknown network ${d.chain_id}`, 'not_found');
      const att = await db.get('SELECT * FROM artifacts WHERE hash=? AND kind LIKE ?', [d.artifact_hash, 'contract-build:%']);
      if (!att) throw new PolicyError('attested artifact for this decision not found', 'not_found');
      const manifest = parse(await getBlob(db, att.immutable_ref), {});
      return out({ protocol: net.protocol, network: d.chain_id, chainId: net.chainId ?? null, artifactHash: d.artifact_hash, registry: payload.registry, abi: manifest.abi ?? null, bytecode: manifest.bytecode ?? null, wasmSha256: manifest.sha256, expectedDeployedBytecodeSha256: manifest.deployedBytecodeSha256 ?? null });
    }
    if (p === '/api/vault' && m === 'GET') return out(await vaultReport(db, { keystore, signingSupported, fetchImpl }));
    if (p === '/api/vault/ledger' && m === 'GET') return out(await listLedger(db, { limit: intParam(url.searchParams.get('limit'), 50, 1, 200) }));
    if (p === '/api/vault/plan' && m === 'GET') {
      const id = url.searchParams.get('decisionId') ?? '';
      if (!/^dec_\w+$/.test(id)) throw new PolicyError('decisionId (dec_...) required', 'input');
      return out(await buildPlan(db, id, { fetchImpl }));
    }
    if (p === '/api/vault/verify' && m === 'GET') { // per-field server verdict: latest chain read of the vault vs a grant_mandate decision
      const id = url.searchParams.get('decisionId') ?? '';
      if (!/^dec_\w+$/.test(id)) throw new PolicyError('decisionId (dec_...) required', 'input');
      return out(await verifyGrant(db, id, { fetchImpl }));
    }
    if (p === '/api/vault/activate' && m === 'POST') { // after the owner's last wallet step: turn on the vault whose chain state now equals the approved grant. Signs nothing; the same check the loop runs every tick.
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', required: ['decisionId'], properties: { decisionId: { type: 'string', maxLength: 40 } } });
      if (!/^dec_\w+$/.test(b.decisionId)) throw new PolicyError('decisionId (dec_...) required', 'input');
      await ownsDecision(who, b.decisionId);
      const d = await db.get('SELECT * FROM decisions WHERE id=?', [b.decisionId]);
      if (!d || d.action !== 'grant_mandate') throw new PolicyError('not a grant_mandate decision', 'not_found');
      const v = await db.get('SELECT * FROM vaults WHERE chain_id=? AND lower(address)=?', [d.chain_id, String(d.target).toLowerCase()]);
      if (!v) throw new PolicyError('this vault is not attached to the backend yet: ask the operator to attach it', 'not_found');
      const r = await activateVault(db, await getVault(db, v.id), { fetchImpl, keystore });
      await audit(db, who.actor, 'vault.activate_requested', { decisionId: d.id, vaultId: v.id, activated: Boolean(r.activated) });
      return out({ activated: Boolean(r.activated), reason: r.reason ?? null, vaultId: v.id });
    }
    if (p === '/api/vault/loop/pause' && m === 'POST') { const who = await needOwner(req); await pauseLoop(db, who.actor); return out({ loop: await getLoop(db) }); }
    if (p === '/api/vault/loop/resume' && m === 'POST') { const who = await needOwner(req); await resumeLoop(db, who.actor); return out({ loop: await getLoop(db) }); }
    if (p === '/api/vault/attach' && m === 'POST') {
      needOperator(req);
      const b = await body(req, { type: 'object', required: ['chainId', 'address'], properties: { chainId: { type: 'string', maxLength: 32 }, address: { type: 'string', maxLength: 96 } } });
      const r = await attachVault(db, { chainId: b.chainId, address: b.address, fetchImpl, keystore });
      return out({ vaultId: r.vault.id, created: r.created, activation: r.activation }, r.created ? 201 : 200);
    }
    if (p === '/api/vault/mandates/propose' && m === 'POST') {
      await needOwner(req);
      const b = await body(req, {
        type: 'object', required: ['chainId', 'vault', 'mandate', 'templates', 'fund'],
        properties: { chainId: { type: 'string', maxLength: 32 }, mandate: { type: 'object' }, templates: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', required: ['artifactHash'] } }, fund: { type: 'object', required: ['amount'] }, loop: { type: 'object' } },
      });
      const d = await proposeGrant(db, b, { keystore, fetchImpl });
      return out({ ...d, decision: d }, d.created ? 201 : 200);
    }
    if (p === '/api/payments' && m === 'GET') return out(await listPayments(db, { limit: intParam(url.searchParams.get('limit'), 50, 1, 200) }));
    if (p === '/api/payments' && m === 'POST') { // a token payout request: becomes a pending pay_testnet decision (approve / reject with the normal decision routes)
      const who = await needOwner(req);
      const b = await body(req, { type: 'object', required: ['token', 'payee', 'amount'], properties: { token: { type: 'string', maxLength: 64 }, payee: { type: 'string', maxLength: 64 }, memo: { type: 'string', maxLength: 400 }, reference: { type: 'string', maxLength: 400 }, vault: { type: 'string', maxLength: 96 } } });
      const d = await createPayment(db, b, { fetchImpl, actor: who.actor });
      return out({ ...d, decision: d }, d.created ? 201 : 200);
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
        decisionLimits: DECISION_LIMITS, vaultLimits: vaultLimits(), budget: config.budget, auth: { operatorConfigured: Boolean(operatorToken) },
        audit: audits.map((a) => ({ ...a, detail: parse(a.detail, {}) })),
        keyScopes: [{ key: 'OPERATOR_TOKEN', scope: 'all mutations', holder: 'human operator' }, { key: 'CRON_SECRET', scope: '/api/cron/tick only', holder: 'scheduler' }, { key: 'LLM provider key', scope: 'server-side completion calls only', holder: 'server secret' }, { key: 'human wallet keys', scope: 'NONE: never held by this system', holder: 'human, in their own wallet' }, { key: 'AGENT_EVM_PRIVATE_KEY / AGENT_NEAR_PRIVATE_KEY / AGENT_KEYS_PATH file', scope: 'the AGENT testnet key only: the signer can sign nothing but vault draw/deploy to the configured vault, under a hard per-tx fee ceiling; the vault enforces the budget on-chain; Node runtime only, never on the Worker', holder: 'this server (disabled unless AUTONOMY_ENABLED=1)' }],
        runbook: 'docs/INCIDENT-RUNBOOK.md',
      });
    }
    if (p === '/api/security/pause' && m === 'POST') { const who = await needOwner(req); await setPaused(db, true, who.actor); return out({ paused: true }); }
    if (p === '/api/security/resume' && m === 'POST') { const who = await needOwner(req); await setPaused(db, false, who.actor); return out({ paused: false }); }
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
    // Rate-limit key. Client-supplied forwarding headers are spoofable, so they are only believed where something trusted sets them:
    // Cloudflare overwrites cf-connecting-ip on Workers (deps.trustCfIp), and TRUST_PROXY=1 declares a proxy that sets x-forwarded-for.
    // Otherwise the Node adapter's own socket address (x-peer-ip, always overwritten by src/server.js) is used, so clients do not share one bucket.
    const proxied = process.env.TRUST_PROXY === '1';
    const ip = (deps.trustCfIp || proxied ? req.headers.get('cf-connecting-ip') : null)
      ?? (proxied ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : null)
      ?? req.headers.get('x-peer-ip') ?? 'local';
    try {
      const wellKnown = url.pathname === WELL_KNOWN_PATH;
      if (!wellKnown && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/develop/')) return out({ error: 'not found' }, 404);
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (limited(ip, write ? 'write' : 'read')) return out({ error: 'rate limited' }, 429, { 'retry-after': '30' });
      if (wellKnown) { // ERC-8004 registration file (DRAFT standard), only when AGENT_PUBLIC_URL is set. Nothing is registered or sent by this server.
        const reg = (req.method === 'GET' || req.method === 'HEAD') ? agentRegistrationFile({ publicUrl: agentPublicUrl, keystore }) : null;
        if (!reg) return out({ error: 'not found' }, 404);
        const res = out(reg.file, 200, { 'x-erc8004-status': 'Draft', 'cache-control': 'public, max-age=60' });
        return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
      }
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
