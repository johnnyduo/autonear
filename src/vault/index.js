// Mandate Vault core: chain-agnostic. Vault records, cached on-chain reads, verifyMandate (activation proof), budget summary,
// the hash-chained vault ledger, loop state, grant_mandate proposals, the human plan, and the status report behind /api/vault.
// Chain specifics live behind an adapter (src/vault/evm.js, src/vault/near.js). NOTHING in this file signs or holds a key; it is safe to
// import from the Cloudflare Worker bundle (the autonomy loop, src/autonomy.js, is Node-only and is never imported from here).
//
// ADAPTER INTERFACE = docs/agent-vault-spec.md "Chain adapter interface" PLUS these extensions the core needs (an adapter missing one is
// reported as "incomplete" and the loop refuses to act on that chain; read-only API still works with readState/verifyVaultCode):
//   attested                      { deployedBytecode|codeHash, sha256, ... }  the attested AgentVault build (passed to verifyVaultCode)
//   preview(kind, {net, vault, amount|template+nameOrSalt, block, fetchImpl}) -> Promise<'' | ErrorCode>   previewDraw / previewDeploy
//   estimateFee({net, vault, agent, call, fetchImpl}) -> Promise<{worstCaseFee: bigint, ...}>               worst-case fee of one call
//   signerOptions({net, fetchImpl}) -> options for keystore.signer(chain, opts)
//   deployTarget({decision, vault, expected}) -> {nameOrSalt, predicted}                                     per-decision salt/name + predicted address
//   planSteps({net, payload, vault}) -> [{who:'human', title, note, tx?, cli?}]                              exact human steps (optional)
// readState() amounts may be bigint | number | decimal string; times are seconds. mandate MUST include `start`. See normalizeState.
import { sha256, now, j, parse, audit, getBlob } from '../db.js';
import { PolicyError, assertDecisionAllowed } from '../policy.js';
import { findNetwork } from '../protocols.js';
import { VaultModel, describeBudget } from '../vault-model.js';
import { UNITS, jsonSafe, formatUnits } from './units.js';
import { adapter as evmAdapter } from './evm.js';
import { completeAdapter } from './compat.js';
import { autonomyEnabled, autonomyMaxPerDay } from '../config.js';
import { buildRegistrationFile, validateRegistrationFile, SPEC as ERC8004_SPEC, WELL_KNOWN_PATH } from '../identity/erc8004.js';

export const VAULT_REQUIRED_READ = ['readState', 'verifyVaultCode'];
export const VAULT_REQUIRED_LOOP = ['readState', 'verifyVaultCode', 'expectedTemplate', 'buildCall', 'verifyDeploy', 'explorerTx', 'explorerAddress', 'preview', 'estimateFee', 'signerOptions', 'deployTarget'];

// ------------------------------------------------------------------ adapters
const registry = new Map([['evm', evmAdapter]]);
const failures = new Map();
export function registerAdapter(protocol, adapter) { registry.set(protocol, completeAdapter(protocol, adapter)); failures.delete(protocol); }
export function unregisterAdapter(protocol) { registry.delete(protocol); }
/** Resolve the adapter for a protocol. NEAR is imported lazily so the core works (read-only, "not available") before/without src/vault/near.js. */
export async function adapterFor(protocol) {
  if (registry.has(protocol)) return { adapter: registry.get(protocol), reason: null };
  if (protocol === 'near' && !failures.has('near')) {
    try {
      const spec = './near.js'; // variable specifier: the bundler must not require the file to exist
      const mod = await import(/* @vite-ignore */ spec);
      const a = mod.adapter ?? mod.default;
      if (!a || typeof a.readState !== 'function') throw new Error('src/vault/near.js does not export an adapter');
      registry.set('near', completeAdapter('near', a));
      return { adapter: registry.get('near'), reason: null };
    } catch (e) { failures.set('near', `NEAR adapter not available: ${String(e.code === 'ERR_MODULE_NOT_FOUND' ? 'src/vault/near.js is not present in this build' : e.message).slice(0, 160)}`); }
  }
  return { adapter: null, reason: failures.get(protocol) ?? `no vault adapter for protocol "${protocol}"` };
}
export const adapterProblems = (adapter, needs = VAULT_REQUIRED_LOOP) => needs.filter((m) => typeof adapter?.[m] !== 'function');
export function netFor(chainId) {
  const net = findNetwork(chainId);
  if (!net) throw new PolicyError(`unknown network "${String(chainId).slice(0, 40)}"`, 'network_blocked');
  if (net.mainnet) throw new PolicyError('mainnet is blocked: the Mandate Vault is testnet-only', 'network_blocked');
  return net;
}

// ------------------------------------------------------------------ state normalization / model
const big = (v, what) => {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  } catch { /* fallthrough */ }
  throw new Error(`adapter state: ${what} is not an integer`);
};
const low = (s) => String(s ?? '').toLowerCase();
/** Canonical in-memory state: every amount/time a BigInt. Throws when the adapter's output is missing a field the model needs. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.config) throw new Error('adapter state: missing config');
  const c = raw.config; const m = raw.mandate; const u = raw.usage ?? {};
  return {
    config: { owner: String(c.owner), pendingOwner: c.pendingOwner ? String(c.pendingOwner) : null, paused: Boolean(c.paused), networkId: String(c.networkId ?? ''), epoch: big(c.epoch ?? 0, 'config.epoch') },
    mandate: m ? {
      agent: String(m.agent), expiresAt: big(m.expiresAt, 'mandate.expiresAt'), perDrawCap: big(m.perDrawCap, 'mandate.perDrawCap'), periodSecs: big(m.periodSecs, 'mandate.periodSecs'),
      periodCap: big(m.periodCap, 'mandate.periodCap'), totalCap: big(m.totalCap, 'mandate.totalCap'), maxDeploys: big(m.maxDeploys, 'mandate.maxDeploys'), revoked: Boolean(m.revoked), start: big(m.start, 'mandate.start (required to rebuild the model)'),
    } : null,
    usage: { totalSpent: big(u.totalSpent ?? 0, 'usage.totalSpent'), periodSpent: big(u.periodSpent ?? 0, 'usage.periodSpent'), deploys: big(u.deploys ?? 0, 'usage.deploys'), periodIndex: big(u.periodIndex ?? 0, 'usage.periodIndex') },
    available: big(raw.available ?? 0, 'available'), agentBalance: big(raw.agentBalance ?? 0, 'agentBalance'), blockTime: big(raw.blockTime, 'blockTime'),
    ...(raw.agentExists !== undefined && raw.agentExists !== null ? { agentExists: Boolean(raw.agentExists) } : {}),
    ...(raw.blockNumber !== undefined ? { blockNumber: big(raw.blockNumber, 'blockNumber') } : {}), ...(raw.blockTag !== undefined ? { blockTag: raw.blockTag } : {}),
    // initArgs / initGas are KEPT (NEAR: the template id is sha256(wasm) only, so the owner-stored init args must be compared separately; see verifyMandate)
    templates: (raw.templates ?? []).map((t) => ({ id: low(t.id), label: String(t.label ?? ''), deposit: big(t.deposit ?? 0, 'template.deposit'), ...(t.initArgs !== undefined ? { initArgs: t.initArgs } : {}), ...(t.initGas !== undefined ? { initGas: String(t.initGas) } : {}) })),
  };
}
export const stateToJSON = (s) => jsonSafe(s);

/** Rebuild the JS reference model from chain state (what the spec calls "the JS VaultModel is rebuilt from chain state"). */
export function modelFromState(state, chain) {
  const model = new VaultModel({ chain, owner: state.config.owner, balance: state.available, networkId: state.config.networkId });
  model.config.paused = state.config.paused; model.config.epoch = state.config.epoch; model.config.pendingOwner = state.config.pendingOwner;
  model.mandate = state.mandate ? { ...state.mandate } : null;
  model.usage = { ...state.usage };
  for (const t of state.templates) model.templates.set(t.id, { id: t.id, label: t.label, deposit: t.deposit });
  return model;
}

/** Budget block of /api/vault (decimal strings). `now` = the block time the state was read at. */
export function budgetSummary(state, chain) {
  const model = modelFromState(state, chain);
  const b = describeBudget(model, state.blockTime);
  const s = (v) => (v === null || v === undefined ? '0' : v.toString());
  return {
    maxDraw: s(b.maxDraw), remainingPeriod: s(b.period?.remaining), remainingTotal: s(b.total?.remaining), remainingDeploys: s(b.deploys?.remaining), blocked: b.blocked || '',
    periodResetsAt: b.period ? Number(b.period.resetsAt) : null,
  };
}

// ------------------------------------------------------------------ verifyMandate: on-chain state == approved grant_mandate payload, field by field
/** The mandate epoch the server activated under. A later on-chain epoch (even with identical fields; usage resets) needs a NEW approved grant. */
const epochKey = (vid) => `vault:epoch:${vid}`;
export async function getPinnedEpoch(db, vid) { const v = (await db.get('SELECT v FROM kv WHERE k=?', [epochKey(vid)]))?.v; return v === undefined ? null : BigInt(v); }
export async function setPinnedEpoch(db, vid, epoch) { await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [epochKey(vid), String(epoch)]); }
export const EPOCH_CHANGED = 'epoch changed: new approval required';

const MANDATE_FIELDS = ['expiresAt', 'perDrawCap', 'periodSecs', 'periodCap', 'totalCap', 'maxDeploys'];
const NEAR_DEFAULT_INIT_GAS = '30000000000000';
/** Error-code normalisation for previews: 'E_PerDrawCap: ...' / 'PerDrawCap' -> 'PerDrawCap'; '' stays ''. */
export const previewCode = (x) => String(x ?? '').replace(/^E_/, '').split(/[:\s]/)[0];
/**
 * On-chain state == approved grant_mandate payload, FIELD BY FIELD. Each check is {name, ok, detail, expected, actual}.
 * `adapter.checkTemplate({state, expected})` (when the adapter has it) additionally compares the owner-stored init args and deposit: on NEAR the template id
 * is sha256(wasm) only and does NOT bind the init args, so id equality alone would not prove the registry gets the approved owner.
 */
export function verifyMandate(state, payload, { protocol = 'evm', adapter = null, activatedEpoch } = {}) {
  if (!state || !state.config) return { ok: false, fieldsOk: false, live: false, epochOk: false, checks: [{ name: 'vault state readable', ok: false, detail: 'no state available: nothing can be verified', expected: 'a successful chain read', actual: 'none' }] };
  const checks = []; const add = (name, ok, detail = '', expected, actual) => checks.push({ name, ok: Boolean(ok), detail: String(detail), ...(expected !== undefined ? { expected: String(expected), actual: String(actual) } : {}) });
  const m = state.mandate;
  add('vault owner on-chain == approved owner', low(state.config.owner) === low(payload.vault?.owner), `${state.config.owner} vs ${payload.vault?.owner}`, payload.vault?.owner, state.config.owner);
  if (!m) { add('a mandate is installed on-chain', false, 'none', 'a mandate', 'none'); return { ok: false, fieldsOk: false, live: false, checks }; }
  const agent = protocol === 'near' ? payload.agent?.account : payload.agent?.address;
  add('mandate.agent == approved agent', low(m.agent) === low(agent), `${m.agent} vs ${agent}`, agent, m.agent);
  for (const k of MANDATE_FIELDS) add(`mandate.${k} == approved`, m[k] === BigInt(payload.mandate[k]), `${m[k]} vs ${payload.mandate[k]}`, payload.mandate[k], m[k]);
  const approved = new Map((payload.templates ?? []).map((t) => [low(t.templateId), t]));
  const onChain = new Map(state.templates.map((t) => [t.id, t]));
  for (const [id, t] of approved) {
    const o = onChain.get(id);
    add(`template ${id.slice(0, 12)}… allowlisted on-chain`, Boolean(o), o ? o.label : 'missing', 'allowlisted', o ? 'allowlisted' : 'missing');
    if (o) {
      add(`template ${id.slice(0, 12)}… label == approved`, o.label === t.label, `${o.label} vs ${t.label}`, t.label, o.label);
      add(`template ${id.slice(0, 12)}… deposit == approved`, o.deposit === BigInt(t.deposit), `${o.deposit} vs ${t.deposit}`, t.deposit, o.deposit);
      if (typeof adapter?.checkTemplate === 'function') {
        const r = adapter.checkTemplate({ state, expected: { templateId: id, initMaterial: t.initMaterial ?? {}, deposit: String(t.deposit), initGas: protocol === 'near' ? NEAR_DEFAULT_INIT_GAS : undefined } });
        for (const c of r.checks ?? []) if (!/allowlisted on-chain$/.test(c.name)) add(`template ${id.slice(0, 12)}…: ${c.name}`, c.ok, c.detail);
      }
    }
  }
  const extra = [...onChain.keys()].filter((id) => !approved.has(id));
  add('no template allowlisted that this decision did not approve', extra.length === 0, extra.length ? `unapproved: ${extra.map((x) => x.slice(0, 12)).join(', ')}` : 'none', 'none', extra.length ? extra.map((x) => x.slice(0, 12)).join(', ') : 'none');
  const fieldsOk = checks.every((c) => c.ok);
  const live = !m.revoked && state.blockTime < m.expiresAt;
  let epochOk = true;
  if (activatedEpoch !== undefined) { // only for an already-activated grant: the chain epoch must still be the one that was approved/activated
    epochOk = activatedEpoch !== null && BigInt(activatedEpoch) === state.config.epoch;
    add(epochOk ? 'mandate epoch == the epoch this grant was activated at' : `mandate epoch == the epoch this grant was activated at: ${EPOCH_CHANGED}`, epochOk, epochOk ? `epoch ${state.config.epoch}` : `${EPOCH_CHANGED} (activated at ${activatedEpoch ?? 'unknown'}, chain now ${state.config.epoch})`, activatedEpoch === null ? 'unknown' : activatedEpoch, state.config.epoch);
  }
  add('mandate not revoked', !m.revoked, m.revoked ? 'revoked' : 'active', 'not revoked', m.revoked ? 'revoked' : 'not revoked');
  add('mandate not expired', state.blockTime < m.expiresAt, `block time ${state.blockTime} / expiresAt ${m.expiresAt}`, `block time < ${m.expiresAt}`, `block time ${state.blockTime}`);
  return { ok: fieldsOk && live && epochOk, fieldsOk, live, epochOk, checks };
}

// ------------------------------------------------------------------ vault records
export const vaultId = (chainId, address) => 'vlt_' + sha256(`${chainId}|${String(address).toLowerCase()}`).slice(0, 12);
const killSwitch = async (db) => (await db.get("SELECT v FROM kv WHERE k='kill_switch'"))?.v === '1';
const sameAddr = (a, b) => low(a) === low(b);
const hydrateVaultRow = (r) => r && ({ ...r, cache: parse(r.last_state, null) });
export const listVaults = async (db) => (await db.all('SELECT * FROM vaults ORDER BY created_at, id')).map(hydrateVaultRow);
export const getVault = async (db, id) => hydrateVaultRow(await db.get('SELECT * FROM vaults WHERE id=?', [id]));
export const findVault = async (db, chainId, address) => hydrateVaultRow(await db.get('SELECT * FROM vaults WHERE chain_id=? AND lower(address)=?', [chainId, low(address)]));
export async function setVaultStatus(db, id, status) { await db.run('UPDATE vaults SET status=? WHERE id=?', [status, id]); }
const safeMsg = (e, redact) => { const t = String(redact ? redact(e?.message ?? e) : (e?.message ?? e)); return (typeof t === 'string' ? t : String(t?.message ?? t)).replace(/\s+/g, ' ').slice(0, 240); };

/** 'ok' | 'mismatch' | 'unknown'. Only a check that RAN and positively found the code different is a mismatch; a check that threw, timed out or could not read the
 *  code is 'unknown' (fail closed for acting, but not an anomaly). */
export function codeVerdict(settled) {
  if (!settled || settled.status !== 'fulfilled') return 'unknown';
  const r = settled.value;
  if (r?.ok === true && (r.checks ?? []).length > 0) return 'ok';
  const positive = (r?.checks ?? []).some((c) => !c.ok && /(runtime code|code hash)\s*(==|equal)/i.test(c.name) && !/readable|callable|available/i.test(c.name));
  return positive ? 'mismatch' : 'unknown';
}

/** Fresh-or-cached on-chain read + code check, stored on the vault row. A failed read keeps the previous state FOR DISPLAY and records the error, but the
 *  returned object then has `stale: true`: callers that act (autonomy, activation) must treat a stale or missing state as "unreadable". The code check runs
 *  independently of the state read, so swapped code is detected even when config() can no longer be decoded. */
export async function readVault(db, vault, { fetchImpl, maxAgeMs = 15_000, force = false, redact } = {}) {
  const cache = vault.cache;
  if (!force && cache?.state && vault.last_read_at && now() - vault.last_read_at < maxAgeMs) return { ...cache, state: normalizeState(cache.state), fresh: false, stale: Boolean(cache.readError) };
  const { adapter, reason } = await adapterFor(findNetwork(vault.chain_id)?.protocol);
  const net = findNetwork(vault.chain_id);
  const t = now();
  let next;
  if (!adapter || adapterProblems(adapter, VAULT_REQUIRED_READ).length) {
    next = { state: cache?.state ?? null, codeOk: false, codeChecked: false, codeChecks: [], readError: safeMsg(adapter ? `adapter incomplete: missing ${adapterProblems(adapter, VAULT_REQUIRED_READ).join(', ')}` : reason, redact), readAt: cache?.readAt ?? null, errorAt: t };
  } else {
    const [st, cd] = await Promise.allSettled([
      adapter.readState({ net, vault: vault.address, now: Math.floor(t / 1000), agent: vault.agent ?? undefined, fetchImpl }).then(normalizeState),
      adapter.verifyVaultCode({ net, vault: vault.address, attested: adapter.attested, fetchImpl }),
    ]);
    const verdict = codeVerdict(cd);
    const codeChecked = verdict !== 'unknown';
    const codeOk = verdict === 'ok';
    const codeChecks = cd.status === 'fulfilled' ? (cd.value.checks ?? []) : [{ name: 'vault code readable', ok: false, detail: safeMsg(cd.reason, redact) }];
    if (st.status === 'fulfilled') next = { state: stateToJSON(st.value), codeOk, codeChecked, codeChecks, readError: null, readAt: t };
    else next = { state: cache?.state ?? null, codeOk, codeChecked, codeChecks, readError: safeMsg(st.reason, redact), readAt: cache?.readAt ?? null, errorAt: t };
  }
  await db.run('UPDATE vaults SET last_state=?, last_read_at=? WHERE id=?', [j(next), t, vault.id]);
  vault.cache = next; vault.last_read_at = t;
  return { ...next, state: next.state ? normalizeState(next.state) : null, fresh: true, stale: Boolean(next.readError) };
}

// ------------------------------------------------------------------ hash-chained ledger
export const LEDGER_KINDS = ['draw', 'deploy', 'refused', 'anomaly', 'activate', 'loop'];
export const LEDGER_STATUS = ['confirmed', 'failed', 'refused'];
export async function appendLedger(db, vaultId_, e, { redact } = {}) {
  if (!LEDGER_KINDS.includes(e.kind)) throw new Error(`ledger: bad kind ${e.kind}`);
  if (!LEDGER_STATUS.includes(e.status)) throw new Error(`ledger: bad status ${e.status}`);
  const detail = String(redact ? redact(String(e.detail ?? '')) : (e.detail ?? '')).replace(/\s+/g, ' ').slice(0, 500);
  const row = [vaultId_, e.kind, e.decisionId ?? '', e.txHash ?? '', e.amount === undefined || e.amount === null ? '' : String(e.amount), e.status, detail];
  for (let attempt = 0; attempt < 8; attempt++) {
    const prev = (await db.get('SELECT hash FROM vault_ledger ORDER BY id DESC LIMIT 1'))?.hash ?? '0'.repeat(64);
    const time = now();
    const hash = sha256(`${prev}|${time}|${row.join('|')}`);
    try {
      await db.run('INSERT INTO vault_ledger(vault_id,time,kind,decision_id,tx_hash,amount,status,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [vaultId_, time, e.kind, e.decisionId ?? null, e.txHash ?? null, row[4] === '' ? null : row[4], e.status, detail, prev, hash]);
      return hash;
    } catch (err) { if (!/UNIQUE|constraint/i.test(String(err.message))) throw err; }
  }
  throw new Error('vault_ledger: could not append after retries');
}
/** Append only when this (vault, key) last recorded a different detail: a persistent refusal is ledgered once, not every tick. */
export async function appendLedgerOnce(db, vaultId_, key, e, opts) {
  const k = `vledger:${vaultId_}:${key}`;
  const sig = sha256(`${e.kind}|${e.status}|${e.detail}`);
  if ((await db.get('SELECT v FROM kv WHERE k=?', [k]))?.v === sig) return null;
  const h = await appendLedger(db, vaultId_, e, opts);
  await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, sig]);
  return h;
}
export async function verifyLedgerChain(db) {
  let prev = '0'.repeat(64);
  for (const r of await db.all('SELECT * FROM vault_ledger ORDER BY id')) {
    const row = [r.vault_id, r.kind, r.decision_id ?? '', r.tx_hash ?? '', r.amount ?? '', r.status, r.detail];
    if (r.prev_hash !== prev || sha256(`${prev}|${r.time}|${row.join('|')}`) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}
export async function listLedger(db, { limit = 50, vaultId: vid } = {}) {
  const rows = vid ? await db.all('SELECT * FROM vault_ledger WHERE vault_id=? ORDER BY id DESC LIMIT ?', [vid, limit]) : await db.all('SELECT * FROM vault_ledger ORDER BY id DESC LIMIT ?', [limit]);
  const cache = new Map();
  const items = [];
  for (const r of rows) {
    let explorerUrl = '';
    if (r.tx_hash) {
      let v = cache.get(r.vault_id);
      if (v === undefined) { v = await getVault(db, r.vault_id); cache.set(r.vault_id, v ?? null); }
      const net = v ? findNetwork(v.chain_id) : null;
      const a = net ? registry.get(net.protocol) : null;
      explorerUrl = net && a ? a.explorerTx(net, r.tx_hash) : '';
    }
    items.push({ id: r.id, time: Math.floor(r.time / 1000), vaultId: r.vault_id, kind: r.kind, decisionId: r.decision_id, txHash: r.tx_hash, explorerUrl, amount: r.amount, status: r.status, detail: r.detail, hash: r.hash, prevHash: r.prev_hash });
  }
  return { items, chainOk: (await verifyLedgerChain(db)).ok };
}

// ------------------------------------------------------------------ loop state (kv). 'blocked' needs an operator resume.
const LOOP_KEY = 'vault:loop';
export async function getLoop(db) {
  const v = parse((await db.get('SELECT v FROM kv WHERE k=?', [LOOP_KEY]))?.v, null) ?? {};
  return { state: v.state ?? 'idle', since: v.since ?? null, lastTickAt: v.lastTickAt ?? null, lastError: v.lastError ?? null, reason: v.reason ?? null };
}
async function putLoop(db, patch) {
  const cur = await getLoop(db);
  await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [LOOP_KEY, j({ ...cur, ...patch })]);
}
export const noteTick = (db, patch = {}) => putLoop(db, { lastTickAt: now(), ...patch });
export async function setLoopRunning(db, running) { const l = await getLoop(db); if (l.state === 'running' || l.state === 'idle') await putLoop(db, { state: running ? 'running' : 'idle', since: l.state === (running ? 'running' : 'idle') ? l.since : now() }); }
export async function pauseLoop(db, actor = 'operator') {
  const l = await getLoop(db);
  if (l.state === 'blocked') return l; // a blocked loop stays blocked until resume: pause must not hide an anomaly
  await putLoop(db, { state: 'paused', since: now(), reason: `paused by ${actor}` });
  await appendLedger(db, '*', { kind: 'loop', status: 'confirmed', detail: `loop paused by ${actor}` });
  await audit(db, actor, 'vault.loop.paused', {});
  return getLoop(db);
}
export async function resumeLoop(db, actor = 'operator') {
  const l = await getLoop(db);
  await putLoop(db, { state: 'idle', since: now(), reason: null, lastError: null });
  await appendLedger(db, '*', { kind: 'loop', status: 'confirmed', detail: `loop resumed by ${actor} (was ${l.state})` });
  await audit(db, actor, 'vault.loop.resumed', { was: l.state });
  return getLoop(db);
}
/** Integrity failure: ledger an `anomaly`, audit it, and put the loop in `blocked`. Only an operator resume clears it. */
export async function blockLoop(db, reason, { vaultId: vid = '*', decisionId, redact } = {}) {
  const msg = String(redact ? redact(reason) : reason).replace(/\s+/g, ' ').slice(0, 300);
  const cur = await getLoop(db);
  if (cur.state === 'blocked' && cur.reason === msg) return; // already blocked for exactly this reason: do not repeat the anomaly every tick
  await appendLedger(db, vid, { kind: 'anomaly', status: 'failed', decisionId, detail: `loop BLOCKED: ${msg}` });
  await putLoop(db, { state: 'blocked', since: now(), reason: msg, lastError: msg });
  await audit(db, 'vault', 'vault.loop.blocked', { vaultId: vid, decisionId: decisionId ?? null, reason: msg });
}
export async function usedToday(db, vid) {
  const cutoff = now() - 864e5;
  const r = vid ? await db.get('SELECT COUNT(*) n FROM mandate_runs WHERE vault_id=? AND created_at>?', [vid, cutoff]) : await db.get('SELECT COUNT(*) n FROM mandate_runs WHERE created_at>?', [cutoff]);
  return Number(r.n);
}

// ------------------------------------------------------------------ keys (public view only)
export function agentIdentity(keystore, protocol) {
  const v = keystore?.publicView?.() ?? { evm: null, near: null };
  return protocol === 'near' ? (v.near ? { account: v.near.account, publicKey: v.near.publicKey } : null) : (v.evm ? { address: v.evm.address } : null);
}
export const agentAddressFor = (keystore, protocol) => { const a = agentIdentity(keystore, protocol); return a ? (a.address ?? a.account) : null; };
/** The Worker (and anything without Node) cannot run the signing loop. */
export const runtimeSupportsSigning = () => typeof process !== 'undefined' && Boolean(process.versions?.node) && globalThis.navigator?.userAgent !== 'Cloudflare-Workers';

// ------------------------------------------------------------------ attach / activate
const attestedRef = (adapter) => adapter?.attested?.sha256 ?? adapter?.attested?.codeHash ?? null;

export async function attachVault(db, { chainId, address, fetchImpl, keystore, actor = 'operator' }) {
  const net = netFor(chainId);
  const { adapter, reason } = await adapterFor(net.protocol);
  if (!adapter) throw new PolicyError(reason, 'unavailable');
  const missing = adapterProblems(adapter, VAULT_REQUIRED_READ); if (missing.length) throw new PolicyError(`vault adapter for ${net.protocol} is incomplete: missing ${missing.join(', ')}`, 'unavailable');
  if (net.protocol === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new PolicyError('address must be an EVM address', 'input');
  const code = await adapter.verifyVaultCode({ net, vault: address, attested: adapter.attested, fetchImpl }).catch((e) => ({ ok: false, checks: [{ name: 'vault code readable', ok: false, detail: String(e.message).slice(0, 200) }] }));
  if (!code.ok) throw new PolicyError(`vault code does not equal the attested AgentVault build: ${code.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`, 'vault_code');
  const state = normalizeState(await adapter.readState({ net, vault: address, now: Math.floor(now() / 1000), agent: agentAddressFor(keystore, net.protocol) ?? undefined, fetchImpl }));
  const wantNetwork = net.protocol === 'evm' ? String(net.chainId) : (net.id === 'near-testnet' ? 'testnet' : null);
  if (wantNetwork && state.config.networkId !== wantNetwork) throw new PolicyError(`vault config().networkId "${state.config.networkId}" != "${wantNetwork}"`, 'vault_config');
  const id = vaultId(chainId, address);
  const existing = await getVault(db, id);
  const t = now();
  if (!existing) {
    await db.run('INSERT INTO vaults(id,chain_id,address,owner,agent,attested_ref,status,created_at,last_state,last_read_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [id, chainId, address, state.config.owner, null, attestedRef(adapter), 'attached', t, j({ state: stateToJSON(state), codeOk: true, codeChecks: code.checks, readError: null, readAt: t }), t]);
    await audit(db, actor, 'vault.attached', { id, chainId, address, owner: state.config.owner });
    await appendLedger(db, id, { kind: 'loop', status: 'confirmed', detail: `vault attached (${net.id}); code == attested build` });
  } else {
    await db.run('UPDATE vaults SET owner=?, last_state=?, last_read_at=? WHERE id=?', [state.config.owner, j({ state: stateToJSON(state), codeOk: true, codeChecks: code.checks, readError: null, readAt: t }), t, id]);
  }
  const vault = await getVault(db, id);
  const activation = await activateVault(db, vault, { fetchImpl, keystore });
  return { vault: await getVault(db, id), created: !existing, activation };
}

export async function grantDecisions(db, vault, statuses = ['approved']) {
  const ph = statuses.map(() => '?').join(',');
  return (await db.all(`SELECT * FROM decisions WHERE action='grant_mandate' AND chain_id=? AND lower(target)=? AND status IN (${ph}) ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 10`, [vault.chain_id, low(vault.address), ...statuses]))
    .map((d) => ({ ...d, payload: parse(d.payload, {}) }));
}

/** Activate the loop for a vault ONLY if an approved grant_mandate decision exists whose payload equals the on-chain state field by field. */
export async function activateVault(db, vault, { fetchImpl, keystore, redact } = {}) {
  if (await killSwitch(db)) return { activated: false, reason: 'kill switch engaged' };
  const net = findNetwork(vault.chain_id);
  if (!net || net.mainnet) return { activated: false, reason: 'mainnet/unknown network' };
  const cands = await grantDecisions(db, vault, ['approved']);
  if (!cands.length) return { activated: false, reason: 'no approved grant_mandate decision for this vault' };
  const read = await readVault(db, vault, { fetchImpl, force: true, redact });
  if (!read.state || read.stale) return { activated: false, reason: `vault unreadable: ${read.readError}` };
  if (!read.codeOk) return { activated: false, reason: 'vault code does not equal the attested AgentVault build', checks: read.codeChecks };
  let best = null;
  for (const d of cands) {
    const checks = [];
    try { assertDecisionAllowed(d); checks.push({ name: 'decision passes policy (testnet, spend ceiling)', ok: true, detail: '' }); } catch (e) { checks.push({ name: 'decision passes policy (testnet, spend ceiling)', ok: false, detail: e.message }); }
    checks.push({ name: 'approved by the vault owner (bound signer == owner)', ok: low(d.bound_signer) === low(read.state.config.owner), detail: `${d.bound_signer} vs ${read.state.config.owner}` });
    checks.push({ name: 'payload names this vault', ok: low(d.payload.vault?.address) === low(vault.address), detail: String(d.payload.vault?.address) });
    const vm = verifyMandate(read.state, d.payload, { protocol: net.protocol, adapter: (await adapterFor(net.protocol)).adapter });
    checks.push(...vm.checks);
    const ok = checks.every((c) => c.ok);
    best = best ?? { decisionId: d.id, checks, ok };
    if (!ok) continue;
    const claim = await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status='approved'", [d.id]);
    if (!claim.changes) continue;
    const agent = net.protocol === 'near' ? d.payload.agent.account : d.payload.agent.address;
    await db.run("UPDATE vaults SET status='active', agent=?, mandate_decision_id=?, owner=?, attested_ref=? WHERE id=?", [agent, d.id, read.state.config.owner, attestedRef((await adapterFor(net.protocol)).adapter), vault.id]);
    await setPinnedEpoch(db, vault.id, read.state.config.epoch);
    await appendLedger(db, vault.id, { kind: 'activate', status: 'confirmed', decisionId: d.id, detail: `loop activated: on-chain mandate == approved ${d.id} (epoch ${read.state.config.epoch})` });
    await audit(db, 'vault', 'vault.activated', { vaultId: vault.id, decisionId: d.id, epoch: String(read.state.config.epoch), agent });
    return { activated: true, decisionId: d.id, epoch: String(read.state.config.epoch), checks };
  }
  return { activated: false, reason: 'on-chain state does not (yet) equal the approved grant_mandate payload', decisionId: best?.decisionId, checks: best?.checks ?? [] };
}

// ------------------------------------------------------------------ propose a grant_mandate
const DAY = 86_400;
export async function proposeGrant(db, input, { keystore, fetchImpl, actor = 'operator' } = {}) {
  const net = netFor(input.chainId);
  const { adapter, reason } = await adapterFor(net.protocol);
  if (!adapter) throw new PolicyError(reason, 'unavailable');
  const missing = adapterProblems(adapter, ['expectedTemplate']); if (missing.length) throw new PolicyError(`vault adapter for ${net.protocol} is incomplete: missing ${missing.join(', ')}`, 'unavailable');
  // accepted shapes: vault = "0x.." | { address, owner? }; agent = "0x.." | { address } | { account }
  const vaultAddr = typeof input.vault === 'string' ? input.vault : input.vault?.address;
  const vault = await findVault(db, input.chainId, String(vaultAddr ?? ''));
  if (!vault) throw new PolicyError('attach the vault first (POST /api/vault/attach): its code and config must be verified on-chain before a mandate is proposed', 'state');
  const chainOwner = vault.cache?.state?.config?.owner ?? vault.owner;
  if (input.vault?.owner && low(input.vault.owner) !== low(chainOwner)) throw new PolicyError(`vault.owner ${input.vault.owner} is not the on-chain owner ${chainOwner}`, 'input');
  const agentAddr = (typeof input.agent === 'string' ? input.agent : (input.agent?.address ?? input.agent?.account)) ?? agentAddressFor(keystore, net.protocol);
  if (!agentAddr) throw new PolicyError(`no agent key for ${net.protocol}: run "npm run agent:init" or pass "agent"`, 'input');
  const t = Math.floor(now() / 1000);
  const m = input.mandate ?? {};
  const exp = m.expiresAt !== undefined ? BigInt(m.expiresAt) : BigInt(t + Math.min(Number(m.expiresInSecs ?? 7 * DAY), 29 * DAY));
  if (!(exp > BigInt(t) && exp <= BigInt(t + 30 * DAY))) throw new PolicyError('mandate.expiresAt must be in the future and at most 30 days away', 'input');
  const templates = [];
  for (const spec of input.templates ?? []) {
    const att = await db.get('SELECT * FROM artifacts WHERE hash=? AND kind=?', [String(spec.artifactHash ?? ''), `contract-build:${net.protocol}`]);
    if (!att) throw new PolicyError(`no attested ${net.protocol} build with hash ${String(spec.artifactHash).slice(0, 16)}…`, 'artifact');
    const manifest = parse(await getBlob(db, att.immutable_ref), {});
    // The server NEVER trusts a client-supplied templateId: it recomputes it from the attested artifact + owner/proposer, and a supplied id must match.
    const im = spec.initMaterial ?? {};
    // defaults when the caller names neither: the registry is owned by the vault OWNER (the human) and the AGENT is its proposer
    const owner = spec.owner ?? im.owner ?? im.owner_id ?? chainOwner; const proposer = spec.proposer ?? im.proposer ?? im.proposer_id ?? agentAddr; const cap = spec.maxSpendCap ?? im.maxSpendCap ?? im.max_spend_cap ?? '0';
    const wantDep = spec.deposit !== undefined && spec.deposit !== '' && String(spec.deposit) !== '0' ? String(spec.deposit) : undefined; // '0'/blank = use the adapter's computed default
    let exp_;
    try { exp_ = adapter.expectedTemplate({ manifest, payload: { registry: { owner, proposer, maxSpendCap: cap, contractAccount: spec.contractAccount } }, vault: vault.address, label: spec.label, deposit: wantDep }); } catch (e) { throw new PolicyError(`template cannot be computed: ${e.message}`, 'input'); }
    const templateId = low(exp_.templateId); const deposit = String(exp_.deposit ?? 0n);
    if (spec.templateId !== undefined && low(spec.templateId) !== templateId) throw new PolicyError(`template_mismatch: the supplied templateId ${String(spec.templateId).slice(0, 18)}… is not what the attested artifact + owner/proposer produce (${templateId.slice(0, 18)}…)`, 'input');
    if (wantDep !== undefined && wantDep !== deposit) throw new PolicyError(`template_mismatch: deposit ${spec.deposit} differs from the computed ${deposit}`, 'input');
    templates.push({ artifactHash: att.hash, templateId, label: String(spec.label ?? exp_.label).slice(0, 64), deposit, initMaterial: jsonSafe(exp_.initMaterial ?? null) });
  }
  const payload = {
    kind: 'grant_mandate',
    vault: { chainId: net.id, address: vault.address, owner: chainOwner },
    agent: net.protocol === 'near' ? { account: agentAddr } : { address: agentAddr },
    mandate: { expiresAt: exp.toString(), perDrawCap: String(m.perDrawCap), periodSecs: String(m.periodSecs), periodCap: String(m.periodCap), totalCap: String(m.totalCap), maxDeploys: String(m.maxDeploys ?? 0) },
    templates,
    fund: { amount: String(input.fund?.amount ?? '0') },
    loop: { maxPerDay: Number(input.loop?.maxPerDay ?? Math.min(autonomyMaxPerDay(), 5)) },
  };
  const d = { action: 'grant_mandate', chain_id: net.id, target: vault.address, method: 'grant_mandate', max_spend: payload.mandate.totalCap, expiry: now() + 24 * 36e5 };
  assertDecisionAllowed({ ...d, payload: j(payload) });
  const payloadJson = j(payload); const payloadHash = sha256(payloadJson);
  const dec = await import('../decisions.js');
  const dup = await db.get("SELECT id FROM decisions WHERE action='grant_mandate' AND payload_hash=? AND status='pending' AND expiry>?", [payloadHash, now()]);
  if (dup) return { ...(await dec.getDecision(db, dup.id)), created: false };
  const id = 'dec_' + sha256(`grant|${vault.id}|${payloadHash}|${now()}`).slice(0, 14);
  const nonce = sha256(`${id}|${now()}|${Math.random()}`).slice(0, 24);
  await db.run(`INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    [id, null, templates[0].artifactHash, d.action, d.chain_id, d.target, d.method, d.max_spend, d.expiry, nonce, payloadJson, payloadHash, now()]);
  await audit(db, actor, 'decision.proposed', { id, action: 'grant_mandate', vaultId: vault.id, payloadHash, totalCap: payload.mandate.totalCap });
  return { ...(await dec.getDecision(db, id)), created: true };
}

/** GET /api/vault/verify: fresh read of the decision's vault, then the per-field verdict against that decision. */
export async function verifyGrant(db, decisionId, { fetchImpl } = {}) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [decisionId]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (d.action !== 'grant_mandate') throw new PolicyError('only grant_mandate decisions can be verified against a vault', 'state');
  const vault = await findVault(db, d.chain_id, d.target);
  if (!vault) return { decisionId, vaultId: null, attached: false, ok: false, fields: [], note: 'the vault is not attached yet: POST /api/vault/attach' };
  const net = findNetwork(d.chain_id);
  const { adapter } = await adapterFor(net.protocol);
  const read = await readVault(db, vault, { fetchImpl, force: true });
  const v = await verificationFor(db, vault, read.stale ? null : read.state, adapter, net.protocol, decisionId);
  return { decisionId, vaultId: vault.id, attached: true, readAt: read.readAt ? Math.floor(read.readAt / 1000) : null, readError: read.readError ?? null, ...(v ?? { ok: false, fieldsOk: false, live: false, fields: [] }) };
}

// ------------------------------------------------------------------ human plan
export async function buildPlan(db, decisionId, { fetchImpl } = {}) {
  void fetchImpl;
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [decisionId]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (d.action !== 'grant_mandate') throw new PolicyError('a plan exists only for grant_mandate decisions', 'state');
  if (['rejected'].includes(d.status)) throw new PolicyError(`decision is ${d.status}`, 'state');
  const payload = parse(d.payload, {});
  const net = netFor(d.chain_id);
  const { adapter, reason } = await adapterFor(net.protocol);
  const steps = [];
  if (d.status === 'pending') steps.push({ who: 'human', title: 'Approve this decision in the Approval Room', note: `Type the exact phrase "approve ${d.id}" and name the vault OWNER (${payload.vault?.owner}) as the signer. Approval is NOT activation and moves no funds.` });
  if (!adapter) steps.push({ who: 'human', title: `${net.protocol} steps not available`, note: reason });
  else if (typeof adapter.planSteps !== 'function') steps.push({ who: 'human', title: `${net.protocol} steps not available`, note: 'this adapter has no planSteps()' });
  else steps.push(...await adapter.planSteps({ net, payload, vault: payload.vault.address, decision: d }));
  steps.push({ who: 'server', title: 'Activation check', note: 'After your transactions confirm, POST /api/vault/attach (or wait for the next autonomy tick) re-reads the vault. The loop is activated ONLY if the on-chain mandate and the allowlisted templates equal this decision field by field; anything else leaves it inactive.' });
  steps.push({ who: 'agent', title: 'Autonomous operation (off unless AUTONOMY_ENABLED=1)', note: `Draws only the gas it needs (3x fee headroom) and deploys only allowlisted templates, at most ${payload.loop?.maxPerDay ?? '?'} per day, never when paused/blocked/revoked/expired. You can revoke, pause or withdraw at any time.` });
  return { decisionId: d.id, status: d.status, chainId: net.id, network: net.label, ...(net.chainId ? { evmChainId: net.chainId } : {}), steps };
}

// ------------------------------------------------------------------ status report (GET /api/vault)
/** Server-side per-field verdict: the vault's last chain read vs the grant_mandate decision that is (or would be) active for it. */
export async function verificationFor(db, vault, state, adapter, protocol, decisionId = null) {
  if (!state) return null;
  let payload = null; let id = decisionId ?? vault.mandate_decision_id ?? null;
  if (id) payload = parse((await db.get('SELECT payload FROM decisions WHERE id=?', [id]))?.payload, null);
  else { const c = (await grantDecisions(db, vault, ['approved', 'pending']))[0]; if (c) { id = c.id; payload = c.payload; } }
  if (!payload) return null;
  const pinned = id && id === vault.mandate_decision_id ? await getPinnedEpoch(db, vault.id) : undefined;
  const vm = verifyMandate(state, payload, { protocol, adapter, activatedEpoch: pinned });
  return { decisionId: id, ok: vm.ok, fieldsOk: vm.fieldsOk, live: vm.live, fields: vm.checks.map((c) => ({ name: c.name, expected: c.expected ?? '', actual: c.actual ?? c.detail, ok: c.ok })) };
}

const strOrNull = (v) => (v === null || v === undefined ? null : v.toString());
async function vaultView(db, vault, deps) {
  const net = findNetwork(vault.chain_id);
  const { adapter } = await adapterFor(net?.protocol);
  const read = await readVault(db, vault, { fetchImpl: deps.fetchImpl, maxAgeMs: deps.maxAgeMs ?? 15_000, redact: deps.redact });
  const grant = vault.mandate_decision_id ? parse((await db.get('SELECT payload FROM decisions WHERE id=?', [vault.mandate_decision_id]))?.payload, null) : null;
  const approvedIds = new Set((grant?.templates ?? []).map((t) => low(t.templateId)));
  const artifactOf = new Map((grant?.templates ?? []).map((t) => [low(t.templateId), t.artifactHash]));
  const s = read.state;
  const unit = adapter?.unit ?? UNITS[net?.protocol] ?? UNITS.evm;
  const chain = net?.protocol ?? 'evm';
  return {
    id: vault.id, chainId: vault.chain_id, network: net?.label ?? vault.chain_id, address: vault.address, owner: s?.config.owner ?? vault.owner, status: vault.status,
    paused: s?.config.paused ?? false, codeOk: Boolean(read.codeOk),
    mandate: s?.mandate ? { agent: s.mandate.agent, expiresAt: Number(s.mandate.expiresAt), perDrawCap: s.mandate.perDrawCap.toString(), periodSecs: Number(s.mandate.periodSecs), periodCap: s.mandate.periodCap.toString(), totalCap: s.mandate.totalCap.toString(), maxDeploys: Number(s.mandate.maxDeploys), revoked: s.mandate.revoked, epoch: Number(s.config.epoch) } : null,
    usage: s ? { totalSpent: s.usage.totalSpent.toString(), periodSpent: (s.mandate ? modelFromState(s, chain).periodState(s.blockTime).spent : s.usage.periodSpent).toString(), deploys: Number(s.usage.deploys), periodResetsAt: s.mandate ? Number(modelFromState(s, chain).periodState(s.blockTime).endsAt) : null } : null,
    budget: s ? budgetSummary(s, chain) : null,
    available: strOrNull(s?.available), agentBalance: strOrNull(s?.agentBalance), unit,
    templates: (s?.templates ?? []).map((t) => ({ id: t.id, label: t.label, deposit: t.deposit.toString(), artifactHash: artifactOf.get(t.id) ?? null, matches: approvedIds.has(t.id) })),
    readAt: read.readAt ? Math.floor(read.readAt / 1000) : null, readError: read.readError ?? null, mandateDecisionId: vault.mandate_decision_id ?? null,
    agentExists: s?.agentExists ?? null,
    explorer: { vault: net && adapter ? adapter.explorerAddress(net, vault.address) : '', agent: net && adapter && vault.agent ? adapter.explorerAddress(net, vault.agent) : '', owner: net && adapter && s ? adapter.explorerAddress(net, s.config.owner) : '' },
    verification: await verificationFor(db, vault, read.stale ? null : s, adapter, chain),
  };
}

export async function vaultReport(db, deps = {}) {
  const { keystore, signingSupported = false, env = process.env } = deps;
  const loop = await getLoop(db);
  const vaults = [];
  for (const v of await listVaults(db)) vaults.push(await vaultView(db, v, deps));
  const pk = keystore?.publicView?.() ?? { evm: null, near: null };
  const maxPerDay = autonomyMaxPerDay(env);
  const health = [];
  const h = (name, ok, detail) => health.push({ name, ok: Boolean(ok), detail });
  const enabled = autonomyEnabled(env);
  h('autonomy enabled', enabled, enabled ? 'AUTONOMY_ENABLED=1' : 'off (default): set AUTONOMY_ENABLED=1 to let the loop act');
  h('kill switch released', !(await killSwitch(db)), (await killSwitch(db)) ? 'ENGAGED: the loop will not act' : 'released');
  h('signing supported on this runtime', signingSupported, signingSupported ? 'Node runtime with an agent key' : 'not supported here (Cloudflare Worker or no agent key): read-only');
  h('agent key (EVM)', Boolean(pk.evm), pk.evm ? pk.evm.address : 'none: npm run agent:init');
  h('agent key (NEAR)', Boolean(pk.near), pk.near ? pk.near.account : 'none: npm run agent:init');
  h('loop not paused/blocked', loop.state !== 'paused' && loop.state !== 'blocked', loop.state === 'blocked' ? `BLOCKED: ${loop.reason}` : loop.state);
  h('ledger hash chain intact', (await verifyLedgerChain(db)).ok, 'recomputed on read');
  const near = await adapterFor('near'); h('NEAR vault adapter', Boolean(near.adapter), near.adapter ? 'loaded' : near.reason);
  for (const v of vaults) {
    h(`vault ${v.id} code == attested build`, v.codeOk, v.readError ?? (v.codeOk ? 'ok' : 'mismatch or unread'));
    if (v.agentBalance !== null) {
      const needs = v.agentExists === false || BigInt(v.agentBalance) === 0n;
      h(`agent needs seed funding (${v.id})`, !needs, needs ? `the agent account ${v.mandate?.agent ?? ''} ${v.agentExists === false ? 'does not exist on-chain yet and ' : ''}holds 0: it pays gas for its OWN first draw, so send it a small seed balance (see GET /api/vault/plan)` : `agent balance ${v.agentBalance} ${v.unit.base}`);
    }
  }
  return {
    enabled, signingSupported,
    loop: { state: loop.state, lastTickAt: loop.lastTickAt ? Math.floor(loop.lastTickAt / 1000) : null, lastError: loop.lastError, usedToday: await usedToday(db), maxPerDay },
    agent: { evm: pk.evm ? { address: pk.evm.address } : null, near: pk.near ? { account: pk.near.account, publicKey: pk.near.publicKey } : null },
    vaults, health,
  };
}

export async function vaultStatusSummary(db) {
  const loop = await getLoop(db);
  const r = await db.get("SELECT COUNT(*) n, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) a FROM vaults");
  return { loop: loop.state, vaults: Number(r.n), activeMandates: Number(r.a ?? 0) };
}

// ------------------------------------------------------------------ ERC-8004 registration file (DRAFT standard; nothing is registered or sent)
export function agentRegistrationFile({ publicUrl, keystore }) {
  if (!publicUrl) return null;
  const file = buildRegistrationFile({
    name: 'AutoNEAR agent (testnet)',
    description: 'DRAFT ERC-8004 registration file served by an AutoNEAR instance. The agent acts only through an owner-set Mandate Vault (budget-bounded, allowlisted deploys, testnet only). This file is not an on-chain registration; ERC-8004 is a Draft standard and is an identity layer, not a spending permission.',
    services: [{ name: 'web', endpoint: publicUrl, version: '0.1.0' }],
    active: true, x402Support: false, registrations: [],
  });
  const v = validateRegistrationFile(file);
  return { file, validation: v, spec: { eip: ERC8004_SPEC.eip, status: ERC8004_SPEC.status }, wellKnown: WELL_KNOWN_PATH, agentAddress: keystore?.publicView?.().evm?.address ?? null };
}

export { formatUnits, UNITS };
