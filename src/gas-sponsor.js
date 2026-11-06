// Gas sponsor (loop rule m): a small, capped, allowlist-only NEAR TESTNET gas pool for OUR OWN agent(s). OFF by default.
//
// What it is: when the loop has real work waiting and the agent's own balance is below a low-water mark, ONE plain NEAR Transfer from a dedicated sponsor account to the
// agent's own address, so the agent can pay the gas of its transactions. It is a fallback AFTER the owner's own top-up (rule j, a bounded draw from the owner's vault).
// What it is NOT: it never touches a vault or the owner's funds, it has no HTTP endpoint (nobody can ask for gas from outside; only the loop decides), it never pays any
// address except the keystore agent, and that agent must be on an explicit allowlist (GAS_SPONSOR_AGENTS). It is testnet-only: a mainnet or unknown network is refused.
//
// All sponsor accounting lives in ONE kv row (`gassponsor:state`: the single in-flight claim, the spend reservations of the last 24h, a lifetime total per agent). It is written
// only by compare-and-swap, a reservation is written BEFORE the transfer is sent, and an unknown outcome stays reserved (it counts against every cap) until the chain says
// what happened to its tx hash or an operator clears it (clearSponsorClaim). A balance that rises for another reason never releases it.
// Every gate below is checked in order and each refusal is ledgered (hash-chained vault_ledger, kind 'refused'); each transfer is ledgered as kind 'loop' with
// detail 'gas sponsor: sent ...' and the amount. Gates: enabled + configured, testnet NEAR, agent is the keystore agent AND allowlisted, real work is pending
// (the caller only asks then), the vault passed its code/mandate checks (the caller is past them), balance under the low-water mark, no earlier sponsor transfer whose
// outcome is unknown, minimum interval since the last transfer, per-agent 24h cap, global 24h cap, per-agent lifetime cap, and the sponsor keeps a reserve.
// The amount is fixed by config and never above a compiled-in ceiling. Money moves only inside a durable claim (kv), so a crash cannot send twice.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendLedger, appendLedgerOnce } from './vault/index.js';
import { now } from './db.js';
import { createNearAdmin } from './agent/near-admin.js';
import { summarizeTxResult } from './agent/near-signer.js';
import { audit } from './db.js';

const NEAR = 10n ** 24n;
const MS_MIN = 60_000; const DAY = 86_400_000;
/** Compiled-in ceilings: no environment value can exceed these. */
export const SPONSOR_HARD = Object.freeze({ amount: NEAR / 2n, perAgentDay: 1n * NEAR, globalDay: 5n * NEAR, lifetime: 10n * NEAR, minIntervalMin: 5, maxAgents: 4 });
export const SPONSOR_DEFAULTS = Object.freeze({ low: NEAR / 20n, amount: NEAR / 10n, perAgentDay: (3n * NEAR) / 10n, globalDay: 1n * NEAR, lifetime: 3n * NEAR, minIntervalMin: 30, reserve: NEAR / 2n });
const CLAIM_STALE_MS = 15 * MS_MIN;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([._-][a-z0-9]+)*$/;

const nearStr = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;
const low = (s) => String(s ?? '').toLowerCase();
/** '0.1' -> yocto; anything else -> null. */
export function nearToYocto(v) {
  const m = /^(\d{1,6})(?:\.(\d{1,24}))?$/.exec(String(v ?? '').trim()); if (!m) return null;
  return BigInt(m[1]) * NEAR + BigInt((m[2] ?? '').padEnd(24, '0'));
}
const amt = (v, def, hard, floor = 1n) => { const n = nearToYocto(v); if (n === null || n < floor) return def; return n > hard ? hard : n; };

/**
 * Parses the environment. Returns { enabled:false } (off, nothing to say) or { enabled:false, misconfigured: 'why' } or the full config.
 * The secret key is read from GAS_SPONSOR_SECRET_KEY or from the ignored file GAS_SPONSOR_KEY_FILE (default data/gas-sponsor.keys.json: { accountId, near: { secretKey } }); it is never logged.
 */
export function sponsorConfig(env = process.env, { root = '.' } = {}) {
  if (!(env.GAS_SPONSOR_ENABLED === '1' || env.GAS_SPONSOR_ENABLED === 'true')) return { enabled: false };
  const bad = (why) => ({ enabled: false, misconfigured: why });
  const agents = [...new Set(String(env.GAS_SPONSOR_AGENTS ?? '').split(',').map((s) => low(s.trim())).filter(Boolean))];
  if (!agents.length) return bad('GAS_SPONSOR_AGENTS is empty: the sponsor serves only agents named in this allowlist');
  if (agents.length > SPONSOR_HARD.maxAgents) return bad(`GAS_SPONSOR_AGENTS lists ${agents.length} agents; at most ${SPONSOR_HARD.maxAgents}`);
  if (agents.some((a) => !ACCOUNT.test(a))) return bad('GAS_SPONSOR_AGENTS holds something that is not a NEAR account id');
  let accountId = low(env.GAS_SPONSOR_ACCOUNT ?? ''); let secretKey = env.GAS_SPONSOR_SECRET_KEY ?? '';
  const file = resolve(root, env.GAS_SPONSOR_KEY_FILE ?? 'data/gas-sponsor.keys.json');
  if ((!secretKey || !accountId) && existsSync(file)) {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); accountId = accountId || low(j.accountId); secretKey = secretKey || j.near?.secretKey || ''; } catch { return bad('the sponsor key file is not valid JSON'); }
  }
  if (!ACCOUNT.test(accountId)) return bad('no sponsor account (GAS_SPONSOR_ACCOUNT or the key file accountId)');
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(secretKey)) return bad('no usable sponsor secret key (GAS_SPONSOR_SECRET_KEY or the key file)');
  if (agents.includes(accountId)) return bad('the sponsor account cannot also be a sponsored agent');
  const D = SPONSOR_DEFAULTS; const H = SPONSOR_HARD;
  const mi = Number(env.GAS_SPONSOR_MIN_INTERVAL_MIN);
  const amount = amt(env.GAS_SPONSOR_AMOUNT_NEAR, D.amount, H.amount);
  return { enabled: true, accountId, secretKey, agents,
    low: amt(env.GAS_SPONSOR_LOW_NEAR, D.low, NEAR), amount,
    perAgentDay: amt(env.GAS_SPONSOR_PER_AGENT_DAY_NEAR, D.perAgentDay, H.perAgentDay), globalDay: amt(env.GAS_SPONSOR_GLOBAL_DAY_NEAR, D.globalDay, H.globalDay),
    lifetime: amt(env.GAS_SPONSOR_LIFETIME_NEAR, D.lifetime, H.lifetime), reserve: amt(env.GAS_SPONSOR_RESERVE_NEAR, D.reserve, 100n * NEAR),
    minIntervalMs: (Number.isInteger(mi) && mi >= H.minIntervalMin ? Math.min(mi, 1440) : D.minIntervalMin) * MS_MIN };
}

/** The default sender: a plain Transfer signed by the sponsor key, on the testnet RPC of the vault's network. Tests inject ctx.deps.gasSponsor instead. */
function defaultSender(cfg, net) {
  let admin = null;
  const get = () => (admin ??= createNearAdmin({ rpcUrl: net.rpc, accountId: cfg.accountId, secretKey: cfg.secretKey, networkId: net.networkId ?? 'testnet', timeoutMs: 60_000, pollMs: 1500 }));
  return {
    balance: async () => BigInt((await get().account(cfg.accountId)).amount),
    transfer: async (to, amount) => { const r = await get().transfer(to, amount, { allowFail: true, waitUntil: 'FINAL' }); return { ok: r.ok, status: r.status, txHash: r.txHash, failure: r.failure }; },
    /** 'success' | 'failed' | 'unknown' for a tx this account signed. */
    txStatus: async (hash) => { try { const x = summarizeTxResult(await get().rpc.txStatus(hash, cfg.accountId, 'FINAL')); return x.status === 'success' ? 'success' : x.status === 'pending' ? 'unknown' : 'failed'; } catch { return 'unknown'; } },
  };
}

const STATE_KEY = 'gassponsor:state';
const fresh = () => ({ v: 1, claim: null, spend: [], lifetime: {} });
async function loadState(db) {
  const row = await db.get('SELECT v FROM kv WHERE k=?', [STATE_KEY]);
  if (!row) return { raw: null, st: fresh() };
  try { const st = JSON.parse(row.v); if (st?.v === 1 && Array.isArray(st.spend) && st.lifetime && typeof st.lifetime === 'object') return { raw: row.v, st }; } catch { /* fall through */ }
  return { raw: row.v, st: { ...fresh(), claim: { status: 'submitted', at: now(), agent: '?', unreadable: true } } }; // an unreadable row is an unknown outcome, never a free pass
}
/** Compare-and-swap: writes only if the row still holds exactly what we read. Returns true when we won. */
async function casState(db, raw, st) {
  const v = JSON.stringify(st);
  if (raw === null) return (await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING', [STATE_KEY, v])).changes === 1;
  return (await db.run('UPDATE kv SET v=? WHERE k=? AND v=?', [v, STATE_KEY, raw])).changes === 1;
}
/** Operator tool: drop an unresolved claim after checking the sponsor account on the explorer. The reservation it made is counted for 24h from the clearing; the lifetime total is unchanged. */
export async function clearSponsorClaim(db, actor = 'operator') {
  const { raw, st } = await loadState(db); if (!st.claim) return false;
  const next = { ...st, claim: null, spend: st.spend.map((r) => (r.id === st.claim.id ? { ...r, state: 'unknown', t: now() } : r)) }; if (!(await casState(db, raw, next))) return false; // counted for 24h from now
  await audit(db, actor, 'gassponsor.claim.clear', { claim: st.claim }); return true;
}
const sumOf = (xs) => xs.reduce((n, r) => n + BigInt(r.amount), 0n);

/**
 * Called by the loop (rule m) only when the vault is verified and live AND real work is pending. `balance` is the agent's fresh balance (bigint).
 * Returns null (nothing to do or refused, the refusal is ledgered) or { sponsored: '<yocto>' } / { pending: true } / { held: true }. Never throws.
 */
export async function sponsorGas(ctx, { vault, net, agent, balance, killed = () => false }) {
  const { db } = ctx;
  let cfg = { enabled: false };
  const scrub = (m) => { let t = ctx.redact(m).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{70,}/g, '[redacted]'); const k = cfg.secretKey; if (k) { t = t.split(k).join('[redacted]'); const body = k.replace(/^ed25519:/, ''); if (body.length > 8) t = t.split(body).join('[redacted]'); } return t; };
  const refuse = (key, detail) => appendLedgerOnce(db, vault.id, `gassponsor:${key}`, { kind: 'refused', status: 'refused', detail: `gas sponsor: ${detail}` }, { redact: scrub }).then(() => null);
  try {
    cfg = ctx.deps.gasSponsorConfig ?? sponsorConfig(ctx.env);
    if (!cfg.enabled) { if (cfg.misconfigured) await refuse('config', `enabled but not usable: ${cfg.misconfigured}`); return null; }
    if (net.protocol !== 'near' || net.mainnet || net.id !== 'near-testnet') return await refuse('network', `only NEAR testnet is served (got ${net.id})`);
    const me = low(agent);
    if (!cfg.agents.includes(me)) return await refuse('allowlist', `${agent} is not on the sponsor allowlist`);
    const sender = ctx.deps.gasSponsor ?? defaultSender(cfg, net);
    const { raw, st } = await loadState(db);
    const t = now();
    st.spend = st.spend.filter((r) => r.state === 'reserved' || r.t > t - DAY); // a reservation backing an unresolved transfer never ages out; lifetime totals live in st.lifetime
    if (balance >= cfg.low) return null; // enough gas: nothing to decide (an unsettled claim is settled the next time gas is needed)
    // 1. an earlier claim: never overwritten blindly
    if (st.claim) {
      const c = st.claim;
      if (c.status === 'claimed') { // another attempt is in flight, or it died BEFORE marking itself submitted: nothing was sent, so its reservation is given back
        if (t - c.at < CLAIM_STALE_MS) return null;
        st.spend = st.spend.filter((r) => r.id !== c.id); st.lifetime[c.agent] = (BigInt(st.lifetime[c.agent] ?? 0) - BigInt(c.amount)).toString(); st.claim = null;
        if (!(await casState(db, raw, st))) return null;
        return sponsorGas(ctx, { vault, net, agent, balance, killed });
      }
      else {
        const verdict = c.txHash && typeof sender.txStatus === 'function' ? await sender.txStatus(c.txHash) : 'unknown';
        if (verdict === 'success') { st.spend = st.spend.map((r) => (r.id === c.id ? { ...r, state: 'sent', txHash: c.txHash } : r)); st.claim = null; await appendLedger(db, vault.id, { kind: 'loop', status: 'confirmed', txHash: c.txHash, amount: c.amount, detail: `gas sponsor: sent ${nearStr(c.amount)} to ${c.agent} from the testnet gas pool ${cfg.accountId} (settled later: the chain shows the transfer succeeded)` }, { redact: scrub }); }
        else if (verdict === 'failed') { st.spend = st.spend.filter((r) => r.id !== c.id); st.lifetime[c.agent] = (BigInt(st.lifetime[c.agent] ?? 0) - BigInt(c.amount)).toString(); st.claim = null; await appendLedger(db, vault.id, { kind: 'loop', status: 'failed', txHash: c.txHash, detail: `gas sponsor: the earlier transfer to ${c.agent} failed on chain; nothing moved` }, { redact: scrub }); }
        else { await refuse('unknown-outcome', `an earlier transfer ${c.txHash ? `(tx ${c.txHash}) ` : ''}has no known outcome; nothing is sent until the chain settles it or an operator clears it (it stays counted against every cap)`); return { held: true }; }
        if (!(await casState(db, raw, st))) return null;
        return sponsorGas(ctx, { vault, net, agent, balance, killed }); // state moved on: decide again from the fresh row
      }
    }
    // 2. caps, all from the one state row
    const mine = st.spend.filter((r) => r.agent === me);
    const last = st.spend.reduce((m, r) => Math.max(m, r.t), 0);
    const amount = cfg.amount;
    if (last && t - last < cfg.minIntervalMs) return await refuse('interval', `the last transfer was under ${Math.round(cfg.minIntervalMs / MS_MIN)} minutes ago`);
    if (sumOf(mine) + amount > cfg.perAgentDay) return await refuse('agent-day', `per-agent 24h cap reached (${nearStr(sumOf(mine))} of ${nearStr(cfg.perAgentDay)})`);
    if (sumOf(st.spend) + amount > cfg.globalDay) return await refuse('global-day', `global 24h cap reached (${nearStr(sumOf(st.spend))} of ${nearStr(cfg.globalDay)})`);
    if (BigInt(st.lifetime[me] ?? 0) + amount > cfg.lifetime) return await refuse('lifetime', `per-agent lifetime cap reached (${nearStr(st.lifetime[me] ?? 0)} of ${nearStr(cfg.lifetime)})`);
    const sponsorBal = await sender.balance();
    if (sponsorBal < amount + cfg.reserve) return await refuse('pool-empty', `the sponsor account holds ${nearStr(sponsorBal)}, under one grant plus its ${nearStr(cfg.reserve)} reserve; the pool needs a top-up`);
    if (await killed()) return null;
    // 3. reserve BEFORE sending: one claim for the whole system, the reservation counts from this instant. Losing the swap means someone else is deciding right now.
    const id = `gs_${t}_${Math.random().toString(36).slice(2, 8)}`;
    const claim = { id, agent: me, status: 'claimed', at: t, amount: amount.toString() };
    st.claim = claim; st.spend.push({ id, t, agent: me, amount: amount.toString(), state: 'reserved' }); st.lifetime[me] = (BigInt(st.lifetime[me] ?? 0) + amount).toString();
    if (!(await casState(db, raw, st))) return null;
    const mark = async (patch) => { const cur = await loadState(db); if (cur.st.claim?.id !== id) return false; Object.assign(cur.st.claim, patch); return casState(db, cur.raw, cur.st); };
    if (!(await mark({ status: 'submitted', at: now() }))) return null; // our claim was taken over while we stalled: we no longer hold the reservation, so we must not send
    let res;
    try { res = await sender.transfer(agent, amount); } catch (e) { // sent or not is unknown: the claim and the reservation stay
      await appendLedger(db, vault.id, { kind: 'loop', status: 'failed', detail: `gas sponsor: transfer to ${agent} has an unknown outcome (${scrub(e)}); held, counted against the caps` }, { redact: scrub });
      return { held: true };
    }
    if (res.status === 'pending') {
      await mark({ txHash: res.txHash ?? null });
      await appendLedger(db, vault.id, { kind: 'loop', status: 'failed', txHash: res.txHash, detail: `gas sponsor: transfer to ${agent} submitted, receipt not seen; held, counted against the caps` }, { redact: scrub });
      return { pending: true };
    }
    // the outcome is known. The ledger row is written FIRST; only then is the claim released, so a crash in between leaves a held claim (safe), never a silent gap.
    if (!res.ok) {
      await appendLedger(db, vault.id, { kind: 'loop', status: 'failed', txHash: res.txHash, detail: `gas sponsor: transfer to ${agent} failed (${scrub(JSON.stringify(res.failure ?? res.status).slice(0, 160))}); nothing moved` }, { redact: scrub });
      const cur = await loadState(db); if (cur.st.claim?.id === id) { cur.st.claim = null; cur.st.spend = cur.st.spend.filter((r) => r.id !== id); cur.st.lifetime[me] = (BigInt(cur.st.lifetime[me] ?? 0) - amount).toString(); await casState(db, cur.raw, cur.st); }
      return null;
    }
    await appendLedger(db, vault.id, { kind: 'loop', status: 'confirmed', txHash: res.txHash, amount: amount.toString(),
      detail: `gas sponsor: sent ${nearStr(amount)} to ${agent} from the testnet gas pool ${cfg.accountId} (agent held ${nearStr(balance)}, low-water ${nearStr(cfg.low)}); allowlisted agent, vault code and mandate verified, work pending` }, { redact: scrub });
    const cur = await loadState(db); if (cur.st.claim?.id === id) { cur.st.claim = null; cur.st.spend = cur.st.spend.map((r) => (r.id === id ? { ...r, state: 'sent', txHash: res.txHash } : r)); await casState(db, cur.raw, cur.st); }
    return { sponsored: amount.toString() };
  } catch (e) { await refuse('error', `failed: ${scrub(e)}`).catch(() => {}); return null; }
}
