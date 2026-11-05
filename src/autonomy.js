// Autonomy loop: the agent executes pending deploy_testnet decisions THROUGH an owner-granted Mandate Vault, inside its budget.
// Node runtime only (it needs the agent keystore). Called from the scheduler tick (src/server.js) and `npm run agent:loop`; never from the Worker.
//
// HARD RULES, all enforced here in code (named tests in tests/autonomy.test.js):
//  (a) AUTONOMY_ENABLED defaults off; no action when the kill switch is on, the loop is paused/blocked, the chain is mainnet/unknown,
//      signing is unsupported, or the vault's runtime code != the attested AgentVault build.
//  (b) the loop is activated only by src/vault/index.js activateVault (on-chain mandate == approved grant_mandate payload, field by field);
//      every tick re-verifies it, and a drifted mandate stops the vault.
//  (c) before EVERY action the JS VaultModel (rebuilt from chain state) and the chain's own preview_* must agree; any mismatch => ledger
//      `anomaly` + loop `blocked` (operator resume required).
//  (d) templateId is recomputed LOCALLY from the attested artifact + the approved payload; it must equal an approved AND allowlisted template,
//      otherwise the decision is left for a human (never auto-approved).
//  (e) one agent execution per decision (mandate_runs PK), one deploy in flight per vault (partial unique index), per-day limit.
//  (g) draws only what is needed for 3x the estimated fee of the deploy (never more), single draw, inside the per-draw cap.
//  (h) every step appends to the hash-chained vault_ledger; a failure releases the decision to the humans, never leaving it `executing`.
//  (i) errors are redacted by the keystore before they reach the ledger/audit/logs; key material never reaches this module.
import { now, parse, getBlob } from './db.js';
import { autonomyEnabled, autonomyMaxPerDay } from './config.js';
import { findNetwork } from './protocols.js';
import { PolicyError } from './policy.js';
import { approveUnderMandate, recordDeployment, releaseToHuman } from './decisions.js';
import {
  adapterFor, adapterProblems, VAULT_REQUIRED_LOOP, readVault, modelFromState, verifyMandate, verifyLedgerChain, appendLedger, appendLedgerOnce,
  getLoop, blockLoop, noteTick, previewCode, getPinnedEpoch, EPOCH_CHANGED, setLoopRunning, usedToday, listVaults, setVaultStatus, activateVault, agentAddressFor, runtimeSupportsSigning,
} from './vault/index.js';

/** Compiled-in ceiling on the worst-case fee of ONE agent transaction (base units). The signer enforces the per-call limit under it. */
export const HARD_MAX_FEE_PER_TX = Object.freeze({ evm: 50_000_000_000_000_000n, near: 1_000_000_000_000_000_000_000_000n });
export const FEE_HEADROOM = 3n;
const CLAIM_STALE_MS = 5 * 60_000; const SUBMIT_STALE_MS = 30 * 60_000; const EXEC_STALE_MS = 2 * 60_000;
const low = (s) => String(s ?? '').toLowerCase();
const killSwitch = async (db) => (await db.get("SELECT v FROM kv WHERE k='kill_switch'"))?.v === '1';

let ticking = null;

function makeCtx(db, deps) {
  const ks = deps.keystore;
  const redact = (m) => { const t = ks?.redactText ? ks.redactText(String(m?.message ?? m)) : String(m?.message ?? m); return t.replace(/\s+/g, ' ').slice(0, 300); };
  return { db, deps, ks, redact, fetchImpl: deps.fetchImpl, env: deps.env ?? process.env, report: { ran: true, vaults: [] }, errors: [] };
}

/** One autonomy pass. Returns a report; throws nothing (every failure is ledgered and returned). Re-entrancy safe within a process. */
export async function autonomyTick(db, deps = {}) {
  if (ticking) return { ran: false, skipped: 'a tick is already running' };
  ticking = (async () => {
    const env = deps.env ?? process.env;
    if (!autonomyEnabled(env)) return { ran: false, skipped: 'AUTONOMY_ENABLED is off (default)' };
    const ctx = makeCtx(db, deps);
    try { return await tickInner(ctx); } catch (e) {
      const msg = ctx.redact(e);
      console.error('[autonomy] tick failed:', msg);
      await noteTick(db, { lastError: msg }).catch(() => {});
      return { ran: false, error: msg };
    }
  })();
  try { return await ticking; } finally { ticking = null; }
}

async function tickInner(ctx) {
  const { db, deps } = ctx;
  const vaults = await listVaults(db);
  // gate (b)-prelude: attached-but-inactive vaults get an activation attempt (server-side bookkeeping, signs nothing)
  for (const v of vaults.filter((x) => ['attached', 'inactive', 'drift'].includes(x.status))) { try { await activateVault(db, v, { fetchImpl: ctx.fetchImpl, keystore: ctx.ks, redact: ctx.redact }); } catch (e) { ctx.errors.push(ctx.redact(e)); } }
  const active = (await listVaults(db)).filter((v) => v.status === 'active' || v.status === 'drift' || v.status === 'inactive');
  const gate = async (key, detail, vaultId = '*') => { await appendLedgerOnce(db, vaultId, `gate:${key}`, { kind: 'refused', status: 'refused', detail }, { redact: ctx.redact }); ctx.report.ran = false; ctx.report.skipped = detail; await noteTick(db, { lastError: detail }); return ctx.report; };
  const clearGate = async (key, vaultId = '*') => db.run('DELETE FROM kv WHERE k=?', [`vledger:${vaultId}:gate:${key}`]);

  if (await killSwitch(db)) return active.length ? gate('kill', 'kill switch engaged: the agent does nothing') : { ran: false, skipped: 'kill switch engaged' };
  await clearGate('kill');
  const loop = await getLoop(db);
  if (loop.state === 'paused' || loop.state === 'blocked') { ctx.report.ran = false; ctx.report.skipped = `loop ${loop.state}${loop.reason ? `: ${loop.reason}` : ''}`; await noteTick(db, {}); return ctx.report; }
  const signingOk = deps.signingSupported !== false && runtimeSupportsSigning() && Boolean(ctx.ks);
  if (!signingOk) return active.length ? gate('signing', 'signing is not supported on this runtime or no agent keystore is configured: read-only') : { ran: false, skipped: 'signing unsupported' };
  await clearGate('signing');
  if (!active.length) { await noteTick(db, {}); return { ran: true, vaults: [], note: 'no active vault' }; }

  await setLoopRunning(db, true);
  const ledgerOk = await verifyLedgerChain(db);
  if (!ledgerOk.ok) { await blockLoop(db, `vault_ledger hash chain is broken at row ${ledgerOk.brokenAt}`, { redact: ctx.redact }); ctx.report.ran = false; ctx.report.skipped = 'ledger chain broken'; return ctx.report; }

  let lastError = null;
  for (const vault of active) {
    if ((await getLoop(db)).state === 'blocked') break;
    const r = await processVault(ctx, vault);
    ctx.report.vaults.push({ id: vault.id, ...r });
    if (r.refused) lastError = r.refused;
    if (r.blocked) break;
  }
  const after = await getLoop(db);
  if (after.state === 'running') await setLoopRunning(db, false);
  await noteTick(db, { lastError: after.state === 'blocked' ? after.reason : (lastError ?? ctx.errors.at(-1) ?? null) });
  return ctx.report;
}

// ---------------------------------------------------------------------------------------------------------------- per vault
async function processVault(ctx, vault) {
  const { db } = ctx;
  const refuse = async (key, detail, extra = {}) => { await appendLedgerOnce(db, vault.id, key, { kind: 'refused', status: 'refused', detail, ...extra }, { redact: ctx.redact }); return { refused: detail, ...(extra.decisionId ? { decisionId: extra.decisionId } : {}) }; };
  const net = findNetwork(vault.chain_id);
  if (!net || net.mainnet) return refuse('network', `chain ${vault.chain_id} is mainnet or unknown: the Mandate Vault is testnet-only`);
  const { adapter, reason } = await adapterFor(net.protocol);
  if (!adapter) return refuse('adapter', reason);
  const problems = adapterProblems(adapter, VAULT_REQUIRED_LOOP);
  if (problems.length) return refuse('adapter', `${net.protocol} vault adapter is incomplete (missing ${problems.join(', ')}): the loop cannot act on this chain`);
  const agent = agentAddressFor(ctx.ks, net.protocol);
  if (!agent) return refuse('agent-key', `no ${net.protocol} agent key configured (npm run agent:init)`);
  if (vault.agent && low(vault.agent) !== low(agent)) return refuse('agent-key', 'the mandate is bound to a different agent than this keystore holds');

  await reconcile(ctx, vault, adapter, net);
  if ((await getLoop(db)).state === 'blocked') return { blocked: true };

  const candidates = await db.all("SELECT * FROM decisions WHERE action='deploy_testnet' AND chain_id=? AND status='pending' AND expiry>? AND bound_signer IS NULL AND approver IS NULL AND id NOT IN (SELECT decision_id FROM mandate_runs) ORDER BY created_at", [vault.chain_id, now()]);
  if (!candidates.length) return { idle: true };
  if (await db.get("SELECT 1 x FROM mandate_runs WHERE vault_id=? AND status IN ('claimed','submitted')", [vault.id])) return { busy: true };

  // vault-level gates need chain state
  const read = await readVault(db, vault, { fetchImpl: ctx.fetchImpl, force: true, redact: ctx.redact });
  if (read.codeChecked && !read.codeOk) { await setVaultStatus(db, vault.id, 'drift'); await blockLoop(db, `vault runtime code does not equal the attested AgentVault build (${read.codeChecks.filter((c) => !c.ok).map((c) => c.detail || c.name).join('; ').slice(0, 160)})`, { vaultId: vault.id, redact: ctx.redact }); return { blocked: true }; }
  const grant = vault.mandate_decision_id ? parse((await db.get('SELECT payload FROM decisions WHERE id=?', [vault.mandate_decision_id]))?.payload, null) : null;
  if (!grant) return refuse('grant', 'no activated grant_mandate decision for this vault');
  const vm = verifyMandate(read.state, grant, { protocol: net.protocol, adapter });
  if (!vm.fieldsOk) {
    await setVaultStatus(db, vault.id, 'drift');
    await appendLedgerOnce(db, vault.id, 'drift', { kind: 'anomaly', status: 'failed', decisionId: vault.mandate_decision_id, detail: `on-chain mandate/templates differ from the approved grant: ${vm.checks.filter((c) => !c.ok).map((c) => c.name).join('; ').slice(0, 280)}` }, { redact: ctx.redact });
    return { refused: 'mandate drift', drift: true };
  }
  const pinned = await getPinnedEpoch(db, vault.id);
  if (pinned === null || pinned !== read.state.config.epoch) { // identical fields, new epoch: usage was reset on-chain, so the old approval must not grant a second full budget
    await setVaultStatus(db, vault.id, 'inactive');
    return refuse('epoch', `${EPOCH_CHANGED}: the grant was activated at epoch ${pinned ?? 'unknown'} but the chain is at epoch ${read.state.config.epoch}; a NEW approved grant_mandate decision and re-activation are required`);
  }
  if (!vm.live) {
    await setVaultStatus(db, vault.id, 'inactive');
    return refuse('inactive', read.state.mandate.revoked ? 'mandate is revoked on-chain' : 'mandate has expired on-chain');
  }
  if (vault.status !== 'active') await setVaultStatus(db, vault.id, 'active');
  if (read.state.config.paused) return refuse('paused', 'vault is paused by its owner');
  const maxPerDay = Math.min(Number(grant.loop?.maxPerDay ?? 1), autonomyMaxPerDay(ctx.env));
  const grantTemplates = new Map((grant.templates ?? []).map((t) => [low(t.templateId), t]));

  const out = { done: [], left: [] };
  for (const cand of candidates) {
    if ((await getLoop(db)).state !== 'running') break;
    if (await killSwitch(db)) { out.refused = 'kill switch engaged'; break; }
    if ((await usedToday(db, vault.id)) >= maxPerDay) { Object.assign(out, await refuse('daily-limit', `per-day limit reached (${maxPerDay} agent executions in 24h)`)); break; }
    let r;
    try { r = await runDecision(ctx, { vault, adapter, net, agent, cand, grantTemplates, epoch: Number((await freshState(ctx, vault)).config.epoch) }); } catch (e) {
      if (!(e instanceof ReadRefused)) throw e;
      // pre-claim: nothing was approved, drawn or signed. Fail closed, ledger the refusal (not an anomaly unless a mismatch was positively observed), stop this vault.
      Object.assign(out, await refuse('read', e.message)); break;
    }
    if (r.executed) out.done.push(cand.id);
    if (r.leftForHuman) out.left.push(cand.id);
    if (r.refused) out.refused = r.refused;
    if (r.blocked) { out.blocked = true; break; }
    if (r.stop) break;
  }
  return out;
}

/** Re-read until `pred(state)` holds (bounded). Needed where a read can lag our own just-confirmed tx (NEAR 'final' finality is ~1-3 blocks behind). The
 *  parity check itself never needs this (model and chain are compared at the SAME pinned block), only budget bookkeeping does. EVM: first read suffices. */
async function freshStateAfter(ctx, vault, adapter, pred) {
  const attempts = adapter.chain === 'near' ? (ctx.deps.catchUpAttempts ?? 10) : 1;
  const sleep = ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let st = await freshState(ctx, vault);
  for (let i = 1; i < attempts && !pred(st); i += 1) { await sleep(ctx.deps.catchUpMs ?? 1500); st = await freshState(ctx, vault); }
  if (!pred(st)) throw new Error('the vault state read does not yet reflect our own confirmed transaction (finality lag); try again next tick');
  return st;
}
/** Every read that can lead to an action must carry a SUCCESSFUL code check with codeOk=true. A check that could not run is a refusal; a positive mismatch is an anomaly. */
class ReadRefused extends Error {}
const freshState = async (ctx, vault) => {
  const r = await readVault(ctx.db, vault, { fetchImpl: ctx.fetchImpl, force: true, redact: ctx.redact });
  if (r.codeChecked && !r.codeOk) { await blockLoop(ctx.db, 'vault runtime code does not equal the attested AgentVault build', { vaultId: vault.id, redact: ctx.redact }); throw new ReadRefused('vault code does not equal the attested build'); }
  if (!r.state || r.stale) throw new ReadRefused(`vault unreadable: ${r.readError ?? 'no state'}`);
  if (!r.codeOk) throw new ReadRefused(`vault code check could not run: ${r.codeChecks.filter((c) => !c.ok).map((c) => c.detail || c.name).join('; ').slice(0, 160) || 'inconclusive'}`);
  return r.state;
};

// ---------------------------------------------------------------------------------------------------------------- parity (rule c)
/** Compare the JS model (rebuilt from the pinned chain state) with the chain's own preview. Returns {ok, code}; blocks the loop on mismatch. */
async function parity(ctx, { vault, adapter, net, state, kind, args, decisionId }) {
  const model = modelFromState(state, net.protocol);
  let chainCode;
  try { chainCode = previewCode(await adapter.preview(kind, { net, vault: vault.address, block: state.blockTag, fetchImpl: ctx.fetchImpl, ...args.chain })); } catch (e) { return { ok: false, refused: `preview unavailable: ${ctx.redact(e)}`, transient: true }; }
  if (kind === 'deploy' && chainCode === 'AddressTaken') model.taken.add(model._targetKey(args.model.template, args.model.nameOrSalt)); // the model cannot observe code at addresses
  const modelCode = kind === 'draw' ? model.previewDraw(args.model.amount, state.blockTime) : model.previewDeploy(args.model.template, args.model.nameOrSalt, state.blockTime);
  if (chainCode !== modelCode) {
    await blockLoop(ctx.db, `model/chain preview mismatch on ${kind}: model says "${modelCode || 'ok'}", chain says "${chainCode || 'ok'}" (block ${state.blockNumber ?? '?'})`, { vaultId: vault.id, decisionId, redact: ctx.redact });
    return { ok: false, blocked: true };
  }
  return { ok: true, code: chainCode };
}

// ---------------------------------------------------------------------------------------------------------------- one decision
async function runDecision(ctx, { vault, adapter, net, agent, cand, grantTemplates, epoch }) {
  const { db } = ctx;
  const leave = async (detail) => { await appendLedgerOnce(db, vault.id, `left:${cand.id}`, { kind: 'refused', status: 'refused', decisionId: cand.id, detail: `left for a human: ${detail}` }, { redact: ctx.redact }); return { leftForHuman: true, refused: detail }; };
  const payload = parse(cand.payload, {});
  const att = await db.get('SELECT * FROM artifacts WHERE hash=? AND kind=?', [cand.artifact_hash, `contract-build:${net.protocol}`]);
  if (!att) return leave('attested artifact for this decision not found');
  const manifest = parse(await getBlob(db, att.immutable_ref), {});
  let expected;
  try { expected = adapter.expectedTemplate({ manifest, payload, vault: vault.address }); } catch (e) { return leave(`template cannot be recomputed locally: ${ctx.redact(e)}`); }
  const tid = low(expected.templateId);
  const granted = grantTemplates.get(tid);
  if (!granted) return leave(`locally recomputed template ${tid.slice(0, 14)}… is not in the approved grant_mandate (owner/proposer/args differ from what the vault owner approved)`);
  if (granted.artifactHash !== cand.artifact_hash) return leave('decision artifact differs from the artifact the grant approved for this template');
  let state = await freshState(ctx, vault);
  if (!state.templates.some((t) => t.id === tid)) return leave('template is not allowlisted on-chain');
  if (typeof adapter.checkTemplate === 'function') { // NEAR: the template id (sha256 of the wasm) does not bind the init args, so compare the owner-stored ones
    const ct = adapter.checkTemplate({ state, expected });
    if (!ct.ok) return leave(`on-chain template differs from the approved init material: ${ct.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`);
  }
  let target;
  try { target = adapter.deployTarget({ decision: cand, vault: vault.address, expected }); } catch (e) { return leave(`no valid deploy target: ${ctx.redact(e)}`); }
  const deployArgs = { chain: { template: expected.templateId, nameOrSalt: target.nameOrSalt }, model: { template: tid, nameOrSalt: target.nameOrSalt } };

  // ---- pre-claim checks: nothing is consumed (no mandate_runs row) when the budget/limits refuse
  const pre = await parity(ctx, { vault, adapter, net, state, kind: 'deploy', args: deployArgs, decisionId: cand.id });
  if (pre.blocked) return { blocked: true, refused: 'preview mismatch' };
  if (!pre.ok) return { refused: pre.refused, stop: true };
  if (pre.code) { await appendLedgerOnce(db, vault.id, `deploy:${cand.id}`, { kind: 'refused', status: 'refused', decisionId: cand.id, detail: `deploy refused by vault rules: ${pre.code}` }, { redact: ctx.redact }); return { refused: pre.code, stop: true }; }

  const deployCall = adapter.buildCall('deploy', { vault: vault.address, template: expected.templateId, code: expected.code, nameOrSalt: target.nameOrSalt });
  let deployFee; let drawFee = 0n; let drawAmount = 0n;
  try { deployFee = (await adapter.estimateFee({ net, vault: vault.address, agent, call: deployCall, fetchImpl: ctx.fetchImpl })).worstCaseFee; } catch (e) { return { refused: await refusedMsg(ctx, vault, cand, 'deploy-fee', `deploy fee estimate failed: ${ctx.redact(e)}`), stop: true }; }
  const hardMax = HARD_MAX_FEE_PER_TX[net.protocol];
  if (deployFee > hardMax) return { refused: await refusedMsg(ctx, vault, cand, 'fee-ceiling', `worst-case deploy fee ${deployFee} exceeds the compiled-in ceiling ${hardMax}`), stop: true };
  const need = FEE_HEADROOM * deployFee;
  if (state.agentBalance < need) {
    const probe = adapter.buildCall('draw', { vault: vault.address, amount: 1n }); // gas does not depend on the amount; probing with `need` could itself revert on a cap
    try { drawFee = (await adapter.estimateFee({ net, vault: vault.address, agent, call: probe, fetchImpl: ctx.fetchImpl })).worstCaseFee; } catch (e) { return { refused: await refusedMsg(ctx, vault, cand, 'draw-fee', `draw fee estimate failed: ${ctx.redact(e)}`), stop: true }; }
    if (state.agentBalance < drawFee) return { refused: await refusedMsg(ctx, vault, cand, 'seed', `agent balance ${state.agentBalance} cannot pay the gas of its own draw (${drawFee}); send it a small seed balance`), stop: true };
    drawAmount = need + drawFee - state.agentBalance; // minimum: after paying the draw's own fee the agent holds exactly 3x the deploy fee
    const dp = await parity(ctx, { vault, adapter, net, state, kind: 'draw', args: { chain: { amount: drawAmount }, model: { amount: drawAmount } }, decisionId: cand.id });
    if (dp.blocked) return { blocked: true, refused: 'preview mismatch' };
    if (!dp.ok) return { refused: dp.refused, stop: true };
    if (dp.code) { await appendLedgerOnce(db, vault.id, `draw:${cand.id}`, { kind: 'refused', status: 'refused', decisionId: cand.id, amount: drawAmount, detail: `draw refused by vault rules: ${dp.code}` }, { redact: ctx.redact }); return { refused: dp.code, stop: true }; }
  }

  // ---- claim: approve under the mandate (re-runs every approveDecision check except the human-only ones) + mandate_runs row
  try { await approveUnderMandate(db, cand.id, { vault, epoch }); } catch (e) {
    if (e instanceof PolicyError) return { refused: await refusedMsg(ctx, vault, cand, 'claim', `not approved under mandate: ${e.message}`), stop: e.code === 'paused' || /in flight/.test(e.message) };
    throw e;
  }
  await appendLedger(db, vault.id, { kind: 'loop', status: 'confirmed', decisionId: cand.id, detail: `approved under mandate:${vault.id}:${epoch}; target ${target.predicted ?? target.nameOrSalt}; no human signs this deployment` }, { redact: ctx.redact });

  let submitted = false; let txHash = null;
  try {
    const signer = ctx.ks.signer(net.protocol, adapter.signerOptions({ net, fetchImpl: ctx.fetchImpl, extra: ctx.deps.signerOpts ?? {} }));
    const limitsFor = (fee) => ({ maxFeePerTx: (fee * 3n) / 2n + 1n > hardMax ? hardMax : (fee * 3n) / 2n + 1n, allowedTargets: [vault.address] });
    const stillOk = async (what) => {
      if (await killSwitch(db)) throw new Error(`kill switch engaged before ${what}`);
      const l = await getLoop(db); if (l.state !== 'running') throw new Error(`loop is ${l.state} before ${what}`);
      const d = await db.get('SELECT status, approver FROM decisions WHERE id=?', [cand.id]);
      if (d?.status !== 'approved' || !String(d.approver).startsWith('mandate:')) throw new Error(`decision is ${d?.status} before ${what}`);
    };
    if (drawAmount > 0n) {
      await stillOk('draw');
      const res = await signer.signAndSend(adapter.buildCall('draw', { vault: vault.address, amount: drawAmount }), limitsFor(drawFee));
      await appendLedger(db, vault.id, { kind: 'draw', status: res.ok ? 'confirmed' : 'failed', decisionId: cand.id, txHash: res.txHash, amount: drawAmount, detail: res.ok ? `drew ${drawAmount} for 3x fee headroom (deploy fee bound ${deployFee})` : `draw did not confirm (${res.status})` }, { redact: ctx.redact });
      if (!res.ok) { await releaseToHuman(db, cand.id, `draw ${res.status}`); return { refused: `draw ${res.status}`, stop: true }; }
      const spentBefore = state.usage.totalSpent;
      state = await freshStateAfter(ctx, vault, adapter, (st) => st.usage.totalSpent >= spentBefore + drawAmount);
      const p2 = await parity(ctx, { vault, adapter, net, state, kind: 'deploy', args: deployArgs, decisionId: cand.id });
      if (p2.blocked) { await releaseToHuman(db, cand.id, 'preview mismatch after draw'); return { blocked: true, refused: 'preview mismatch' }; }
      if (!p2.ok || p2.code) { await releaseToHuman(db, cand.id, p2.code || p2.refused); await appendLedger(db, vault.id, { kind: 'refused', status: 'refused', decisionId: cand.id, detail: `deploy refused after draw: ${p2.code || p2.refused}` }, { redact: ctx.redact }); return { refused: p2.code || p2.refused, stop: true }; }
    }
    await stillOk('deploy');
    await db.run("UPDATE mandate_runs SET status='submitted' WHERE decision_id=? AND status='claimed'", [cand.id]);
    submitted = true;
    const res = await signer.signAndSend(deployCall, limitsFor(deployFee));
    txHash = res.txHash ?? null;
    if (txHash) await db.run('UPDATE mandate_runs SET tx_hash=? WHERE decision_id=?', [txHash, cand.id]);
    if (res.status === 'pending') {
      await appendLedger(db, vault.id, { kind: 'loop', status: 'confirmed', decisionId: cand.id, txHash, detail: 'deploy submitted; receipt not seen before the timeout, the next tick reconciles it' }, { redact: ctx.redact });
      return { pending: true, stop: true };
    }
    if (!res.ok) {
      await appendLedger(db, vault.id, { kind: 'deploy', status: 'failed', decisionId: cand.id, txHash, detail: `deploy transaction ${res.status}` }, { redact: ctx.redact });
      await releaseToHuman(db, cand.id, `deploy ${res.status}`);
      return { refused: `deploy ${res.status}`, stop: true };
    }
    const deploysBefore = state.usage.deploys;
    const fin = await finalize(ctx, { vault, cand, txHash, net });
    if (fin.executed) await freshStateAfter(ctx, vault, adapter, (st) => st.usage.deploys >= deploysBefore + 1n).catch(() => {}); // next decision starts from caught-up state
    return fin;
  } catch (e) {
    const msg = ctx.redact(e);
    // outcome unknown? If the predicted address is now taken the deploy landed: do NOT hand it back as if nothing happened.
    let landed = false;
    if (submitted) { try { landed = (await adapter.preview('deploy', { net, vault: vault.address, template: expected.templateId, nameOrSalt: target.nameOrSalt, fetchImpl: ctx.fetchImpl })) === 'AddressTaken'; } catch { /* unknown */ } }
    await appendLedger(db, vault.id, { kind: 'deploy', status: 'failed', decisionId: cand.id, txHash, detail: `agent step failed: ${msg}${landed ? ' (the target address is taken: the deploy may have LANDED)' : ''}` }, { redact: ctx.redact });
    if (landed) { await blockLoop(ctx.db, `deploy of ${cand.id} may have landed but its receipt is unknown; record it with POST /api/decisions/${cand.id}/receipt then resume`, { vaultId: vault.id, decisionId: cand.id, redact: ctx.redact }); return { blocked: true, refused: msg }; }
    await releaseToHuman(db, cand.id, msg);
    return { refused: msg, stop: true };
  }
}

const refusedMsg = async (ctx, vault, cand, key, detail) => { await appendLedgerOnce(ctx.db, vault.id, `${key}:${cand.id}`, { kind: 'refused', status: 'refused', decisionId: cand.id, detail }, { redact: ctx.redact }); return detail; };

/** The deploy tx confirmed: verify it against the attested artifact/approved payload (adapter.verifyDeploy via the vault path) and record it. */
async function finalize(ctx, { vault, cand, txHash, net }) {
  const { db } = ctx;
  const rec = await recordDeployment(db, cand.id, { txHash, fetchImpl: ctx.fetchImpl });
  if (rec.recorded) {
    await appendLedger(db, vault.id, { kind: 'deploy', status: 'confirmed', decisionId: cand.id, txHash, detail: `deployed ${rec.deployment.account} through the vault; verified against the attested artifact` }, { redact: ctx.redact });
    await readVault(db, vault, { fetchImpl: ctx.fetchImpl, force: true, redact: ctx.redact }).catch(() => {});
    return { executed: true, account: rec.deployment.account };
  }
  const failed = (rec.verification?.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join('; ');
  await appendLedger(db, vault.id, { kind: 'deploy', status: 'failed', decisionId: cand.id, txHash, detail: `deploy tx confirmed but verification FAILED: ${failed.slice(0, 280)}` }, { redact: ctx.redact });
  await releaseToHuman(db, cand.id, 'post-deploy verification failed');
  await blockLoop(db, `deploy ${cand.id} landed but did not verify (${failed.slice(0, 160)})`, { vaultId: vault.id, decisionId: cand.id, txHash, redact: ctx.redact });
  void net;
  return { blocked: true, refused: 'verification failed' };
}

// ---------------------------------------------------------------------------------------------------------------- reconcile (crash / timeout recovery)
async function reconcile(ctx, vault, adapter, net) {
  const { db } = ctx;
  // a decision stuck `executing` (process died inside recordDeployment) with no deployment row goes back to `approved`; it is then recorded or released below
  await db.run("UPDATE decisions SET status='approved' WHERE status='executing' AND approver LIKE 'mandate:%' AND decided_at<? AND id NOT IN (SELECT decision_id FROM deployments)", [now() - EXEC_STALE_MS]);
  const runs = await db.all("SELECT * FROM mandate_runs WHERE vault_id=? AND status IN ('claimed','submitted')", [vault.id]);
  for (const run of runs) {
    const age = now() - run.created_at;
    const d = await db.get('SELECT * FROM decisions WHERE id=?', [run.decision_id]);
    if (!d || d.status === 'executed') { await db.run("UPDATE mandate_runs SET status='confirmed' WHERE decision_id=?", [run.decision_id]); continue; }
    if (run.status === 'claimed') { if (age > CLAIM_STALE_MS) { await releaseToHuman(db, run.decision_id, 'claimed but never submitted'); await appendLedger(db, vault.id, { kind: 'refused', status: 'refused', decisionId: run.decision_id, detail: 'stale claim released to a human' }, { redact: ctx.redact }); } continue; }
    if (run.tx_hash) {
      try {
        const rec = await recordDeployment(db, run.decision_id, { txHash: run.tx_hash, fetchImpl: ctx.fetchImpl });
        if (rec.recorded) { await appendLedger(db, vault.id, { kind: 'deploy', status: 'confirmed', decisionId: run.decision_id, txHash: run.tx_hash, detail: `reconciled: deployed ${rec.deployment.account}` }, { redact: ctx.redact }); continue; }
        const noReceipt = (rec.verification?.checks ?? []).some((c) => /receipt found/.test(c.name) && !c.ok);
        if (noReceipt && age < SUBMIT_STALE_MS) continue;
        await appendLedger(db, vault.id, { kind: 'deploy', status: 'failed', decisionId: run.decision_id, txHash: run.tx_hash, detail: `reconcile: ${noReceipt ? 'no receipt after the window' : 'verification failed'}` }, { redact: ctx.redact });
        await releaseToHuman(db, run.decision_id, 'reconcile failed');
        if (!noReceipt) await blockLoop(db, `reconcile: tx ${run.tx_hash} did not verify`, { vaultId: vault.id, decisionId: run.decision_id, txHash: run.tx_hash, redact: ctx.redact });
      } catch (e) { ctx.errors.push(ctx.redact(e)); }
    } else if (age > SUBMIT_STALE_MS) {
      await appendLedger(db, vault.id, { kind: 'deploy', status: 'failed', decisionId: run.decision_id, detail: 'submitted without a recorded tx hash and no outcome after the window; released to a human' }, { redact: ctx.redact });
      await releaseToHuman(db, run.decision_id, 'no tx hash');
    }
  }
  void adapter; void net;
}

// ---------------------------------------------------------------------------------------------------------------- misc exports
/** Foreground loop for `npm run agent:loop`: tick, sleep, repeat until the signal aborts. */
export async function runLoop(db, deps, { intervalMs = 30_000, signal, once = false, onTick } = {}) {
  for (;;) {
    const r = await autonomyTick(db, deps);
    onTick?.(r);
    if (once || signal?.aborted) return r;
    await new Promise((res) => { const t = setTimeout(res, intervalMs); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    if (signal?.aborted) return r;
  }
}
