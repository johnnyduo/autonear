// NEAR chain adapter for the Mandate Vault (binding interface: docs/agent-vault-spec.md, "Chain adapter interface").
// Read-only against the RPC (jsonRpc from src/chains/common.js, fetchImpl injectable); it never signs and never holds keys.
//
// Conventions of THIS adapter (the interface fixes the shape, not the number types):
//  - money (available, caps, deposits, balances) = decimal strings of yoctoNEAR; times = Number seconds; epoch / deploys = Number.
//    Every value can be fed to src/vault-model.js (toBig accepts both) and survives JSON.stringify.
//  - all views of one readState() are pinned to ONE block (block_id) so the pieces are mutually consistent.
//  - net = { rpc, explorer?, id?, mainnet? } (a src/protocols.js network; any object with those fields works).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { jsonRpc, base58, hexToBytes, check } from '../chains/common.js';

// Node-only conveniences (default artifact paths). Guarded: this module may be imported where import.meta.url / fs are unavailable.
let ROOT = '';
try { ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); } catch { /* not a file: URL (bundled) */ }
export const VAULT_WASM_PATH = resolve(ROOT, 'contracts/near-vault/dist/autonear_vault.wasm');
/** The payouts build (cargo feature `payouts`, config().version "1.1.0"): token `pay`, allowlisted tokens and payees. A SECOND attested build next to the v1 one. */
export const VAULT_PAY_WASM_PATH = resolve(ROOT, 'contracts/near-vault/dist/autonear_vault_pay.wasm');
export const REGISTRY_WASM_PATH = resolve(ROOT, 'contracts/near-registry/dist/autonear_registry.wasm');

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');
export const sha256Hex = (b) => hex(sha256(b));
const isHex32 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const big = (v) => { try { return BigInt(v); } catch { return null; } };
const TGAS = 10n ** 12n;

export const unit = Object.freeze({ symbol: 'NEAR', base: 'yoctoNEAR', decimals: 24 });

// ------------------------------------------------------------------ deposit sizing (documented, deterministic)
/** NEAR protocol storage price: 1e19 yoctoNEAR per byte staked (nearcore runtime config storage_amount_per_byte). */
export const STORAGE_BYTE_COST = 10n ** 19n;
/** Account record + the keyless account's own bookkeeping (nearcore charges 100 bytes per account, plus ~0 for no keys). */
export const ACCOUNT_OVERHEAD_BYTES = 100n;
/** Room for the deployed contract's own state (registry proposals, allowlists, ...): 1 NEAR = 100,000 bytes. */
export const STATE_ALLOWANCE = 10n ** 24n;
/** Safety factor on (code + overhead + state allowance): +20%, then rounded UP to 0.1 NEAR. */
export const SAFETY_PERCENT = 20n;
const ROUND = 10n ** 23n;
export const DEFAULT_INIT_GAS = 30n * TGAS;

/**
 * Deposit forwarded to a deployed sub-account.
 *  minimum = (wasmBytes + ACCOUNT_OVERHEAD_BYTES) * 1e19   (below this the batch fails with LackBalanceForState and is reversed)
 *  deposit = ceil_0.1NEAR( (minimum + 1 NEAR state allowance) * 1.20 )
 * The sub-account is KEYLESS: whatever is not needed for storage is unrecoverable, so the margin is a cost (it counts against the
 * budget the moment it is sent). Registry (210,822 bytes): minimum 2.109 NEAR, deposit 3.8 NEAR. The 5 NEAR in the deploy script
 * works too; this is the smaller derived figure, proven sufficient on the local sandbox by scripts/e2e-near-sandbox.mjs.
 */
export function depositForWasm(wasmBytes) {
  const minimum = (BigInt(wasmBytes) + ACCOUNT_OVERHEAD_BYTES) * STORAGE_BYTE_COST;
  const raw = ((minimum + STATE_ALLOWANCE) * (100n + SAFETY_PERCENT) + 99n) / 100n;
  const deposit = ((raw + ROUND - 1n) / ROUND) * ROUND;
  return { minimum, deposit };
}

// ------------------------------------------------------------------ small helpers
const NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** Mirrors contracts/near-vault valid_name: 1..=32 of [a-z0-9_-], alphanumeric ends, no double separator, no dots. */
export const validSubName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 32 && NAME_RE.test(n) && !/[-_]{2}/.test(n);
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validAccount = (a) => typeof a === 'string' && a.length >= 2 && a.length <= 64 && ACCOUNT_RE.test(a);
export const subAccountOf = (vault, name) => `${name}.${vault}`;

const parseMaybe = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v ?? null; };
const stable = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const deepEq = (a, b) => stable(a) === stable(b);

function ctx(opts) { return { fetchImpl: opts.fetchImpl, role: opts.role ?? 'monitor' }; }
const rpcCall = (net, c, method, params) => jsonRpc(c.role, net.rpc, method, params, { fetchImpl: c.fetchImpl });
async function query(net, c, params) {
  const r = await rpcCall(net, c, 'query', params);
  if (r?.error) throw new Error(`query ${params.request_type}${params.method_name ? ':' + params.method_name : ''}: ${String(r.error).slice(0, 200)}`);
  return r;
}
async function view(net, c, block, account, method, args = {}) {
  const r = await query(net, c, { request_type: 'call_function', ...block, account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
}
const viewAccount = (net, c, block, id) => query(net, c, { request_type: 'view_account', ...block, account_id: id });

// ------------------------------------------------------------------ readState
/**
 * -> { config:{owner,pendingOwner,paused,networkId,epoch,vaultId,version,reserve}, mandate|null, usage:{totalSpent,periodSpent,deploys,periodIndex},
 *      available, templates:[{id,label,deposit,initArgs,initGas}], agentBalance, blockTime, period|null, previews?, vaultBalance, codeHash, blockHeight, blockHash }
 * `now` (seconds) is passed to period_state; blockTime (seconds) is the block the views were pinned to.
 * Optional `previews: { draw: [amounts], deploy: [{ template, name }] }` additionally returns the chain's own preview_* error codes.
 * agentBalance: yocto string of the `agent` argument's account (default: mandate.agent; '0' when that account does not exist yet), null when neither is known.
 * blockTag / blockNumber = the block height every view was pinned to; pass it as `block` to preview() to compare at the very same block.
 * finality defaults to 'final' (the safe choice for authorisation decisions): a tx the signer saw at EXECUTED_OPTIMISTIC becomes visible ~1-3 blocks later.
 */
async function readState({ net, vault, now, agent, fetchImpl, role, finality = 'final', previews } = {}) {
  const c = ctx({ fetchImpl, role });
  const blk = await rpcCall(net, c, 'block', { finality });
  const block = { block_id: blk.header.height };
  const blockTime = Math.floor(Number(BigInt(blk.header.timestamp_nanosec ?? blk.header.timestamp) / 1_000_000_000n));
  const v = (m, a) => view(net, c, block, vault, m, a);
  const nowArg = now === undefined || now === null ? undefined : { now: String(Math.floor(Number(now))) };
  const [cfg, man, usage, avail, tpls, ps, acct] = await Promise.all([
    v('config'), v('mandate'), v('usage'), v('available'), allTemplates(v), v('period_state', nowArg ?? {}), viewAccount(net, c, block, vault),
  ]);
  let agentBalance = null; let agentExists = null;
  const who = agent || man?.agent;
  if (who) {
    try { agentBalance = String((await viewAccount(net, c, block, who)).amount); agentExists = true; } catch (e) {
      if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String(e.message))) { agentBalance = '0'; agentExists = false; } else throw e;
    }
  }
  const payBuild = hasPayouts(cfg.version);
  const out = {
    build: payBuild ? 'pay' : 'v1',
    config: { owner: cfg.owner, pendingOwner: cfg.pending_owner ?? null, paused: Boolean(cfg.paused), networkId: cfg.network_id, epoch: Number(cfg.epoch), vaultId: cfg.vault_id, version: cfg.version, reserve: String(cfg.reserve) },
    mandate: man ? { agent: man.agent, expiresAt: Number(man.expires_at), perDrawCap: String(man.per_draw_cap), periodSecs: Number(man.period_secs), periodCap: String(man.period_cap), totalCap: String(man.total_cap), maxDeploys: Number(man.max_deploys), revoked: Boolean(man.revoked), start: Number(man.start), active: Boolean(man.active) } : null,
    usage: { totalSpent: String(usage.total_spent), periodSpent: String(usage.period_spent), deploys: Number(usage.deploys), periodIndex: Number(usage.period_index) },
    available: String(avail),
    templates: tpls.map((t) => ({ id: t.id, label: t.label, deposit: String(t.deposit), initArgs: t.init_args, initGas: String(t.init_gas) })),
    agentBalance, agentExists,
    blockTime, blockHeight: blk.header.height, blockNumber: blk.header.height, blockTag: blk.header.height, blockHash: blk.header.hash,
    vaultBalance: String(acct.amount), codeHash: acct.code_hash,
    period: ps ? { index: Number(ps.period_index), start: Number(ps.period_start), end: Number(ps.period_end), spent: String(ps.period_spent), remaining: String(ps.period_remaining), totalSpent: String(ps.total_spent), totalRemaining: String(ps.total_remaining), deploys: Number(ps.deploys), deploysRemaining: Number(ps.deploys_remaining), active: Boolean(ps.active) } : null,
  };
  // Payout views exist ONLY in the payouts build: a v1 vault is never asked (and keeps its exact read shape, no `payouts` key).
  if (payBuild) out.payouts = await readPayouts(v);
  if (previews) {
    out.previews = { draw: {}, deploy: {} };
    for (const a of previews.draw ?? []) out.previews.draw[String(a)] = await v('preview_draw', { amount: String(a) });
    for (const d of previews.deploy ?? []) out.previews.deploy[`${d.template}:${d.name}`] = await v('preview_deploy', { template: d.template, name: d.name });
    if (payBuild && previews.pay) {
      out.previews.pay = {};
      for (const p of previews.pay) out.previews.pay[`${p.token}:${p.to}:${p.amount}`] = await v('preview_pay', { token: p.token, to: p.to, amount: String(p.amount) });
    }
  }
  return out;
}

/** config().version of a build that has the payout views (1.1.0 and later 1.x). */
const hasPayouts = (version) => { const m = /^(\d+)\.(\d+)\./.exec(String(version ?? '')); return Boolean(m) && Number(m[1]) === 1 && Number(m[2]) >= 1; };

/** tokens (caps + this epoch's stored usage) and payees, from views pinned to the caller's block. */
async function readPayouts(v) {
  const toks = await v('tokens');
  const tokens = [];
  for (const t of toks) {
    const u = await v('token_usage', { token: t.token });
    tokens.push({ token: t.token, perPayCap: String(t.per_pay_cap), periodCap: String(t.period_cap), totalCap: String(t.total_cap), usage: { total: String(u.total_spent), period: String(u.period_spent), periodIndex: Number(u.period_index) } });
  }
  const payees = [];
  const PAGE = 100;
  for (let from = 0; from < 1000; from += PAGE) {
    const page = await v('payees', { from_index: String(from), limit: String(PAGE) });
    payees.push(...page);
    if (page.length < PAGE) break;
  }
  return { tokens, payees };
}

async function allTemplates(v) {
  const out = []; const PAGE = 100;
  for (let from = 0; from < 1000; from += PAGE) {
    const page = await v('templates', { from_index: String(from), limit: String(PAGE) });
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** The chain's own preview of draw(amount) for the bound agent: '' = ok, else an E_ code name. */
async function previewDraw({ net, vault, amount, fetchImpl, role, block }) {
  return view(net, ctx({ fetchImpl, role }), blockRef(block), vault, 'preview_draw', { amount: String(amount) });
}
async function previewDeploy({ net, vault, template, name, fetchImpl, role, block }) {
  return view(net, ctx({ fetchImpl, role }), blockRef(block), vault, 'preview_deploy', { template: String(template).replace(/^0x/, ''), name });
}
/** payouts build only: the chain's own preview of pay(token, to, amount) (no memo) for the bound agent: '' = ok, else an E_ code name. */
async function previewPay({ net, vault, token, to, amount, fetchImpl, role, block }) {
  return view(net, ctx({ fetchImpl, role }), blockRef(block), vault, 'preview_pay', { token, to, amount: String(amount) });
}
const blockRef = (block) => (block === undefined || block === null || block === '' ? { finality: 'final' } : { block_id: /^\d+$/.test(String(block)) ? Number(block) : String(block) });
/** Core-facing preview (src/vault/index.js): '' = the call would pass, else the vault's error code name. `block` = readState().blockTag. */
async function preview(kind, { net, vault, amount, template, nameOrSalt, name, token, to, block, fetchImpl, role } = {}) {
  if (kind === 'draw') return previewDraw({ net, vault, amount, block, fetchImpl, role });
  if (kind === 'deploy') return previewDeploy({ net, vault, template, name: nameOrSalt ?? name, block, fetchImpl, role });
  if (kind === 'pay') return previewPay({ net, vault, token, to, amount, block, fetchImpl, role });
  throw new Error(`preview: unknown kind "${String(kind).slice(0, 20)}"`);
}

// ------------------------------------------------------------------ verifyVaultCode
function attestedHash(attested) {
  if (typeof attested === 'string') return attested.toLowerCase();
  if (attested instanceof Uint8Array) return sha256Hex(attested);
  const h = attested?.sha256 ?? attested?.wasmSha256 ?? attested?.codeSha256 ?? attested?.manifest?.sha256;
  if (typeof h === 'string') return h.toLowerCase();
  if (attested?.wasm instanceof Uint8Array) return sha256Hex(attested.wasm);
  return null;
}

/**
 * attested: the vault build's sha256 hex, a manifest { sha256 }, or the wasm bytes; omitted (or the adapter's own `attested`, which carries `builds`) =
 * EITHER attested build in contracts/near-vault/dist: the v1 vault (autonear_vault.wasm, config().version 1.0.0) or the payouts vault
 * (autonear_vault_pay.wasm, 1.1.0). An explicit `attested` is exactly that one hash (build 'pay' when it is the payouts hash, else 'v1').
 * Checks: on-chain code hash == base58(sha256(attested wasm)); config() is callable, names this very account and reports the version of the
 * build that matched; vault holds no function-call/other keys is NOT judged here (INFO only): a full-access key on the vault account can bypass
 * every rule and a human must own that decision.
 * -> { ok, checks, build: 'v1' | 'pay' | null (no attested build matched), version }
 */
async function verifyVaultCode({ net, vault, attested, fetchImpl, role } = {}) {
  const c = ctx({ fetchImpl, role });
  const checks = [];
  let cands; let source = 'attested';
  const explicit = attested === undefined || attested === null || attested.builds ? null : attestedHash(attested);
  if (explicit) cands = [{ build: explicit === ATTESTED_BUILDS.pay.sha256 ? 'pay' : 'v1', sha256: explicit }];
  else {
    cands = Object.values(ATTESTED_BUILDS).filter((b) => b.sha256).map((b) => ({ build: b.build, sha256: b.sha256 }));
    source = 'contracts/near-vault/dist';
    if (!cands.length) { checks.push(check('attested vault wasm hash available', false, `${VAULT_WASM_PATH}: ${ATTESTED_BUILDS.v1.error ?? 'not built'}`)); return { ok: false, checks, build: null, version: null }; }
  }
  const allHex = cands.every((x) => isHex32(x.sha256));
  checks.push(check('attested vault hash is 64 lowercase hex', allHex, `${source}: ${cands.map((x) => String(x.sha256).slice(0, 70)).join(', ')}`));
  if (!allHex) return { ok: false, checks, build: null, version: null };
  const wants = cands.map((x) => ({ ...x, b58: base58(hexToBytes(x.sha256)) }));
  let matched = null;
  try {
    const acct = await viewAccount(net, c, { finality: 'final' }, vault);
    matched = wants.find((x) => x.b58 === acct.code_hash) ?? null;
    checks.push(check('on-chain code hash == attested vault wasm sha256', Boolean(matched), `${acct.code_hash} vs ${wants.map((x) => x.b58).join(' | ')}${matched ? ` (${matched.build})` : ''}`));
  } catch (e) { checks.push(check('vault account readable', false, String(e.message).slice(0, 200))); return { ok: false, checks, build: null, version: null }; }
  let version = null;
  try {
    const cfg = await view(net, c, { finality: 'final' }, vault, 'config');
    version = cfg.version ?? null;
    checks.push(check('config() callable and vault_id == this account', cfg.vault_id === vault, `${cfg.vault_id} vs ${vault}`));
    const wantVersions = [...new Set((matched ? [matched] : wants).map((x) => BUILD_VERSION[x.build]))];
    checks.push(check(`config().version is ${wantVersions.join(' or ')}`, wantVersions.includes(cfg.version), String(cfg.version)));
  } catch (e) { checks.push(check('config() callable', false, String(e.message).slice(0, 200))); }
  try {
    const keys = await rpcCall(net, c, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: vault });
    const full = (keys.keys ?? []).filter((k) => k.access_key?.permission === 'FullAccess').map((k) => k.public_key);
    checks.push({ name: 'INFO: full-access keys on the vault account (whoever holds one can bypass the contract; a human must confirm each is theirs)', ok: true, detail: full.join(', ') || 'none (vault account is locked)', info: true });
  } catch (e) { checks.push({ name: 'INFO: vault access key list unavailable', ok: true, detail: String(e.message).slice(0, 160), info: true }); }
  const ok = checks.every((x) => x.ok);
  return { ok, checks, build: ok && matched ? matched.build : null, version };
}

// ------------------------------------------------------------------ expectedTemplate
const networkIdOf = (payload) => {
  const r = payload?.registry ?? {};
  if (typeof r.networkId === 'string' && r.networkId) return r.networkId;
  const n = payload?.network ?? payload?.chain ?? payload?.vault?.chainId;
  return n === 'near-testnet' ? 'testnet' : n === 'near-mainnet' ? 'mainnet' : typeof n === 'string' && /^[a-z0-9_-]{1,32}$/.test(n) ? n : 'testnet';
};

function loadAttestedWasm(manifest, opts) {
  const want = String(manifest?.sha256 ?? '').toLowerCase();
  if (!isHex32(want)) throw new Error('expectedTemplate: manifest.sha256 must be the 64-hex sha256 of the attested registry wasm');
  let code = null;
  const m = manifest.wasm ?? manifest.code;
  if (m instanceof Uint8Array) code = m;
  else if (typeof manifest.wasmBase64 === 'string') code = new Uint8Array(Buffer.from(manifest.wasmBase64, 'base64'));
  else code = new Uint8Array(readFileSync(opts.wasmPath ?? REGISTRY_WASM_PATH));
  if (sha256Hex(code) !== want) throw new Error(`expectedTemplate: registry wasm sha256 ${sha256Hex(code)} does not match the attestation ${want}; refusing`);
  return code;
}

/**
 * Computed LOCALLY from the attested wasm + the approved payload; nothing is read from chain.
 * payload: a deploy_testnet payload ({ registry:{owner,proposer,maxSpendCap?,networkId?}, network }) or a grant_mandate payload
 *   ({ templates:[{ templateId, label?, deposit?, initMaterial? }], registry? }).
 * -> { templateId (sha256 hex of the wasm), code, name (sub-account label from the approved contractAccount, or null), label, deposit (yocto string), initMaterial (the init_args object for registry `new`),
 *      initArgsJson, initGas (string), minDeposit, allowTemplateArgs (exact allow_template json args for the owner) }
 * init_args = { owner_id, proposer_id, network_id [, max_spend_cap if > 0] } = the registry's `new` signature. The agent never supplies them.
 */
function expectedTemplate({ manifest, payload, vault, wasmPath, label, deposit } = {}) {
  const code = loadAttestedWasm(manifest, { wasmPath });
  const templateId = sha256Hex(code);
  const p = parseMaybe(payload) ?? {};
  const entry = (p.templates ?? []).find((t) => t && (t.templateId === templateId || t.artifactHash === manifest.artifactHash)) ?? null;
  if (entry?.templateId && entry.templateId !== templateId) throw new Error('expectedTemplate: payload templateId does not match the attested wasm sha256');
  const reg = p.registry ?? {};
  let initMaterial;
  const fromReg = () => {
    const owner = reg.owner ?? reg.ownerId; const proposer = reg.proposer ?? reg.proposerId;
    if (!validAccount(owner) || !validAccount(proposer)) throw new Error('expectedTemplate: approved payload needs valid registry.owner and registry.proposer');
    const o = { owner_id: owner, proposer_id: proposer, network_id: networkIdOf(p) };
    const cap = big(reg.maxSpendCap);
    if (cap !== null && cap > 0n) o.max_spend_cap = cap.toString();
    return o;
  };
  if (entry?.initMaterial) {
    initMaterial = parseMaybe(entry.initMaterial);
    if (!initMaterial || typeof initMaterial !== 'object' || Array.isArray(initMaterial)) throw new Error('expectedTemplate: initMaterial must be a JSON object');
    if (reg.owner || reg.proposer) { if (!deepEq(initMaterial, fromReg())) throw new Error('expectedTemplate: payload initMaterial disagrees with payload.registry (owner/proposer/network)'); }
  } else initMaterial = fromReg();
  // The vault can only create `{name}.{vault}`. An approved payload naming any other account can never be satisfied through the vault: refuse here
  // (before anything is signed) instead of deploying somewhere the human did not approve.
  let name = null;
  const ca = reg.contractAccount;
  if (ca !== undefined && ca !== null && ca !== '') {
    if (vault && !(typeof ca === 'string' && ca.endsWith(`.${vault}`) && validSubName(ca.slice(0, -(vault.length + 1))))) throw new Error(`expectedTemplate: payload.registry.contractAccount "${String(ca).slice(0, 70)}" is not <name>.${vault}: the vault can only deploy to its own sub-accounts`);
    if (vault) name = ca.slice(0, -(vault.length + 1));
  }
  const initArgsJson = stable(initMaterial);
  if (new TextEncoder().encode(initArgsJson).length > 1024) throw new Error('expectedTemplate: init_args longer than the vault limit (1 KiB)');
  const sized = depositForWasm(code.length);
  let dep = sized.deposit;
  const wanted = deposit ?? entry?.deposit;
  if (wanted !== undefined && wanted !== null) {
    const w = big(wanted);
    if (w === null || w < sized.minimum) throw new Error(`expectedTemplate: deposit ${String(wanted).slice(0, 40)} is below the storage minimum ${sized.minimum} for ${code.length} bytes`);
    dep = w;
  }
  const lbl = String(label ?? entry?.label ?? `registry-${templateId.slice(0, 8)}`);
  if (new TextEncoder().encode(lbl).length > 64) throw new Error('expectedTemplate: label longer than 64 bytes');
  return {
    templateId, code, name, label: lbl, deposit: dep.toString(), initMaterial, initArgsJson, initGas: DEFAULT_INIT_GAS.toString(), minDeposit: sized.minimum.toString(),
    allowTemplateArgs: { template_id: templateId, label: lbl, deposit: dep.toString(), init_args: initMaterial, init_gas: DEFAULT_INIT_GAS.toString() },
  };
}

// ------------------------------------------------------------------ buildCall
const U128_MAX = (1n << 128n) - 1n;
const MAX_MEMO_BYTES = 128;
/** Gas the OWNER attaches to payout management calls (allow_*, disallow_*) and to withdraw_token (ft_transfer 30 + callback 5 + the call itself). */
export const OWNER_GAS = Object.freeze({ allow_token: 30n * TGAS, disallow_token: 30n * TGAS, allow_payee: 30n * TGAS, disallow_payee: 30n * TGAS, withdraw_token: 100n * TGAS });
const reservedAccount = (a, vault) => a === 'system' || /^0{64}$/.test(a) || a === vault;
const needAccount = (what, a, vault, { allowReserved = false } = {}) => {
  if (!validAccount(a)) throw new Error(`buildCall: ${what} must be a NEAR account id`);
  if (!allowReserved && reservedAccount(a, vault)) throw new Error(`buildCall: ${what} must not be the vault, "system" or the zero account (E_${what === 'payee' ? 'BadPayee' : 'BadToken'})`);
  return a;
};
const needAmount = (what, v) => { const a = big(v); if (a === null || a <= 0n || a > U128_MAX) throw new Error(`buildCall: ${what} must be a positive integer that fits u128`); return a; };
/** -> { method, target, args } exactly as src/agent/near-signer.js (enforceCall + defaultEncodeArgs) accepts and encodes it.
 *  Payouts build only: `pay` (the agent; same three keys, no gas/deposit: the vault takes the 1 yocto of each ft_transfer from its own balance, so the agent attaches
 *  0 deposit; attach ATTACHED_GAS.pay = 100 Tgas) and the owner calls allow_token / disallow_token / allow_payee / disallow_payee / withdraw_token, which carry
 *  `gas` and `deposit` (decimal strings, deposit '0') like planSteps' `call`. */
function buildCall(kind, { vault, amount, template, code, nameOrSalt, token, to, memo, account, perPayCap, periodCap, totalCap } = {}) {
  if (!validAccount(vault)) throw new Error('buildCall: vault must be a NEAR account id');
  if (kind === 'draw') {
    const a = big(amount);
    if (a === null || a <= 0n) throw new Error('buildCall: draw amount must be a positive integer (yoctoNEAR)');
    return { method: 'draw', target: vault, args: { amount: a.toString() } };
  }
  if (kind === 'deploy') {
    if (!isHex32(String(template ?? '').replace(/^0x/, ''))) throw new Error('buildCall: template must be the 64-hex sha256 of the wasm');
    if (!validSubName(nameOrSalt)) throw new Error('buildCall: name must be 1..32 of [a-z0-9_-] (no dots)');
    if (!(code instanceof Uint8Array) || code.length === 0) throw new Error('buildCall: deploy needs the wasm bytes');
    const t = String(template).replace(/^0x/, '');
    if (sha256Hex(code) !== t) throw new Error('buildCall: sha256(code) != template id (the vault would revert CodeMismatch)');
    return { method: 'deploy', target: vault, args: { template: t, name: nameOrSalt, code } };
  }
  if (kind === 'pay') {
    needAccount('token', token, vault, { allowReserved: true }); needAccount('payee', to, vault, { allowReserved: true });
    const a = needAmount('pay amount', amount);
    const args = { token, to, amount: a.toString() };
    if (memo !== undefined && memo !== null) {
      if (typeof memo !== 'string' || new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) throw new Error(`buildCall: memo must be a string of at most ${MAX_MEMO_BYTES} bytes (E_BadMemo)`);
      args.memo = memo;
    }
    return { method: 'pay', target: vault, args };
  }
  const owner = (method, args) => ({ method, target: vault, args, gas: OWNER_GAS[method].toString(), deposit: '0' });
  if (kind === 'allow_token') {
    needAccount('token', token, vault);
    const per = needAmount('perPayCap', perPayCap), period = needAmount('periodCap', periodCap), total = needAmount('totalCap', totalCap);
    if (!(per <= period && period <= total)) throw new Error('buildCall: caps must satisfy 0 < perPayCap <= periodCap <= totalCap (E_BadToken)');
    return owner('allow_token', { token, per_pay_cap: per.toString(), period_cap: period.toString(), total_cap: total.toString() });
  }
  if (kind === 'disallow_token') return owner('disallow_token', { token: needAccount('token', token, vault, { allowReserved: true }) });
  if (kind === 'allow_payee') return owner('allow_payee', { account: needAccount('payee', account ?? to, vault) });
  if (kind === 'disallow_payee') return owner('disallow_payee', { account: needAccount('payee', account ?? to, vault, { allowReserved: true }) });
  if (kind === 'withdraw_token') return owner('withdraw_token', { token: needAccount('token', token, vault), amount: needAmount('withdraw_token amount', amount).toString() });
  throw new Error(`buildCall: unknown kind "${String(kind).slice(0, 20)}"`);
}

// ------------------------------------------------------------------ NEP-141 / NEP-145 helpers (read-only views on the token contract)
/** ft_balance_of(account) on `token` -> decimal string (smallest unit). */
async function ftBalance({ net, token, account, fetchImpl, role, block } = {}) {
  if (!validAccount(token) || !validAccount(account)) throw new Error('ftBalance: token and account must be NEAR account ids');
  return String(await view(net, ctx({ fetchImpl, role }), blockRef(block), token, 'ft_balance_of', { account_id: account }));
}
/** storage_balance_of(account) on `token` -> { total, available } (decimal strings) or null when the account is not registered. */
async function storageBalanceOf({ net, token, account, fetchImpl, role, block } = {}) {
  if (!validAccount(token) || !validAccount(account)) throw new Error('storageBalanceOf: token and account must be NEAR account ids');
  const r = await view(net, ctx({ fetchImpl, role }), blockRef(block), token, 'storage_balance_of', { account_id: account });
  return r ? { total: String(r.total), available: String(r.available) } : null;
}
/** Is `account` registered on `token` (NEP-145)? An unregistered payee makes ft_transfer fail, so the vault reverses the charge: register before allow_payee. */
async function ftRegistered(o = {}) { return (await storageBalanceOf(o)) !== null; }
/** storage_balance_bounds() on `token` -> { min, max|null } (decimal strings). */
async function storageBalanceBounds({ net, token, fetchImpl, role, block } = {}) {
  if (!validAccount(token)) throw new Error('storageBalanceBounds: token must be a NEAR account id');
  const r = await view(net, ctx({ fetchImpl, role }), blockRef(block), token, 'storage_balance_bounds', {});
  return { min: String(r.min), max: r.max === null || r.max === undefined ? null : String(r.max) };
}
/** ft_metadata() on `token` -> { spec, name, symbol, decimals, ... } as the token reports it. */
async function ftMetadata({ net, token, fetchImpl, role, block } = {}) {
  if (!validAccount(token)) throw new Error('ftMetadata: token must be a NEAR account id');
  return view(net, ctx({ fetchImpl, role }), blockRef(block), token, 'ft_metadata', {});
}

// ------------------------------------------------------------------ verifyDeploy
const parseEvents = (outcome) => (outcome?.outcome?.logs ?? []).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => { try { return JSON.parse(l.slice(11)); } catch { return null; } }).filter((e) => e?.standard === 'autonear_vault');
const b64json = (s) => { try { return JSON.parse(Buffer.from(s, 'base64').toString()); } catch { return null; } };
const failureOf = (o) => o?.outcome?.status?.Failure;

// The stable `tx` method of nearcore 2.13 returns NO `receipts` array; EXPERIMENTAL_tx_status does (we need the receipt actions).
async function fetchTx(net, c, txHash, sender) {
  const params = { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' };
  let tx = null; let err = null;
  try { tx = await rpcCall(net, c, 'EXPERIMENTAL_tx_status', params); } catch (e) { err = e; }
  if (!tx?.receipts) { try { tx = await rpcCall(net, c, 'tx', params); } catch (e) { throw err ?? e; } }
  return tx;
}

/** nearcore's receipt view of DeployContract carries the 32-byte code HASH (base64), not the code (2.13.4); older nodes carry the code. */
const deployedCodeHex = (b64) => { const raw = Buffer.from(b64, 'base64'); return raw.length === 32 ? hex(raw) : sha256Hex(raw); };

/**
 * Transaction-level proof that the VAULT deployed exactly the attested code, at {name}.{vault}, with the approved owner/proposer.
 * `decision` may be the decision row ({ payload: json string }) or the payload object. The sub-account name comes from
 * expected.name, else the explicit `name`, else payload.registry.contractAccount minus ".{vault}" (the approved target account);
 * if none is available the check fails closed.
 */
async function verifyDeploy({ net, txHash, vault, agent, decision, manifest, expected, name, fetchImpl, role, wasmPath } = {}) {
  const checks = [];
  const fail = (extra) => ({ ok: false, account: null, checks: [...checks, ...extra], observedAt: Date.now() });
  const c = ctx({ fetchImpl, role });
  if (net?.mainnet) return fail([check('mainnet is blocked', false, net.id ?? '')]);
  try {
    const payload = parseMaybe(decision?.payload ?? decision) ?? {};
    let exp = expected;
    if (!exp) { try { exp = expectedTemplate({ manifest, payload, vault, wasmPath }); } catch (e) { return fail([check('expected template computable from attestation + approved payload', false, String(e.message).slice(0, 200))]); } }
    const approvedAccount = payload.registry?.contractAccount ?? '';
    const derived = approvedAccount && approvedAccount.endsWith(`.${vault}`) ? approvedAccount.slice(0, -(vault.length + 1)) : '';
    const wantName = exp.name ?? name ?? derived;
    checks.push(check('expected sub-account name is known (explicit or from the approved contractAccount)', validSubName(wantName), String(wantName).slice(0, 40)));
    if (!validSubName(wantName)) return fail([]);
    const target = subAccountOf(vault, wantName);
    if (approvedAccount) checks.push(check('deployed account is the approved contractAccount', approvedAccount === target, `${target} vs ${approvedAccount}`));
    const wantCodeHex = exp.templateId;
    const wantOwner = payload.registry?.owner ?? exp.initMaterial?.owner_id;
    const wantProposer = payload.registry?.proposer ?? exp.initMaterial?.proposer_id;
    if (!isHex32(wantCodeHex) || sha256Hex(exp.code) !== wantCodeHex) return fail([check('expected.templateId == sha256(expected.code)', false, '')]);
    if (manifest?.sha256) checks.push(check('expected template id == attested manifest sha256', String(manifest.sha256).toLowerCase() === wantCodeHex, wantCodeHex.slice(0, 16)));
    if (wantOwner !== exp.initMaterial?.owner_id || wantProposer !== exp.initMaterial?.proposer_id) checks.push(check('init material owner/proposer == approved payload', false, 'mismatch'));

    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(txHash))) return fail([check('tx hash is base58', false, String(txHash).slice(0, 60))]);
    const tx = await fetchTx(net, c, txHash, agent);
    const t = tx.transaction ?? {};
    checks.push(check('tx hash returned by the node == requested', t.hash === txHash, String(t.hash)));
    checks.push(check('tx finalized', tx.final_execution_status === 'FINAL', tx.final_execution_status));
    checks.push(check('signer == the agent', t.signer_id === agent, `${t.signer_id} vs ${agent}`));
    checks.push(check('receiver == the vault', t.receiver_id === vault, `${t.receiver_id} vs ${vault}`));
    const acts = t.actions ?? [];
    const fc = acts.length === 1 ? acts[0].FunctionCall : null;
    checks.push(check('exactly one action: FunctionCall `deploy` with 0 attached deposit', Boolean(fc) && fc.method_name === 'deploy' && String(fc.deposit) === '0', acts.map((a) => Object.keys(a)[0]).join(',') + (fc ? `:${fc.method_name}:${fc.deposit}` : '')));
    const args = fc ? b64json(fc.args) : null;
    checks.push(check('deploy args are exactly { template, name, code }', Boolean(args) && deepEq(Object.keys(args).sort(), ['code', 'name', 'template']), args ? Object.keys(args).join(',') : 'unparsable'));
    checks.push(check('deploy template == expected template id', args?.template === wantCodeHex, String(args?.template).slice(0, 20)));
    checks.push(check('deploy name == expected name', args?.name === wantName, `${args?.name} vs ${wantName}`));
    const argCode = typeof args?.code === 'string' ? new Uint8Array(Buffer.from(args.code, 'base64')) : null;
    checks.push(check('deploy code sha256 == attested wasm sha256', Boolean(argCode) && sha256Hex(argCode) === wantCodeHex, argCode ? sha256Hex(argCode).slice(0, 16) : 'none'));

    // ---- every receipt, including the callback
    const status = tx.status ?? {};
    checks.push(check('top-level tx status is SuccessValue', status.SuccessValue !== undefined && !status.Failure, status.Failure ? JSON.stringify(status.Failure).slice(0, 160) : 'SuccessValue'));
    const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])].filter(Boolean);
    const failed = outcomes.filter((o) => failureOf(o));
    checks.push(check('no failed receipt anywhere in the receipt tree', failed.length === 0 && outcomes.length >= 3, failed.length ? `${failed[0].outcome.executor_id}: ${JSON.stringify(failureOf(failed[0])).slice(0, 160)}` : `${outcomes.length} outcomes ok`));
    const receipts = tx.receipts ?? [];
    const outcomeById = new Map((tx.receipts_outcome ?? []).map((o) => [o.id, o]));
    const actionsOf = (r) => r.receipt?.Action?.actions ?? [];
    const kinds = (r) => actionsOf(r).map((a) => (typeof a === 'string' ? a : Object.keys(a)[0]));

    const batch = receipts.find((r) => r.receiver_id === target && r.predecessor_id === vault && kinds(r).includes('DeployContract'));
    checks.push(check('batch receipt vault -> {name}.{vault} present', Boolean(batch), `${receipts.length} receipts`));
    if (batch) {
      const k = kinds(batch);
      checks.push(check('batch is exactly CreateAccount, Transfer, DeployContract, FunctionCall (no AddKey / Stake / DeleteAccount)', deepEq(k, ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']), k.join(',')));
      const a = actionsOf(batch);
      const dc = a.find((x) => x.DeployContract)?.DeployContract;
      checks.push(check('batch DeployContract code (hash) == attested wasm sha256', Boolean(dc) && deployedCodeHex(dc.code) === wantCodeHex, dc ? deployedCodeHex(dc.code).slice(0, 16) : 'none'));
      checks.push(check('batch Transfer deposit == expected template deposit', String(a.find((x) => x.Transfer)?.Transfer?.deposit) === String(exp.deposit), `${a.find((x) => x.Transfer)?.Transfer?.deposit} vs ${exp.deposit}`));
      const init = a.find((x) => x.FunctionCall)?.FunctionCall;
      checks.push(check('batch calls `new` with exactly the owner-fixed init material', init?.method_name === 'new' && deepEq(b64json(init.args), exp.initMaterial), init ? `${init.method_name} ${Buffer.from(init.args, 'base64').toString().slice(0, 120)}` : 'none'));
      const bo = outcomeById.get(batch.receipt_id);
      checks.push(check('batch receipt executed successfully', Boolean(bo) && bo.outcome?.status?.SuccessValue !== undefined, bo ? JSON.stringify(bo.outcome.status).slice(0, 120) : 'no outcome'));
    }
    const cb = receipts.find((r) => r.receiver_id === vault && r.predecessor_id === vault && actionsOf(r).some((x) => x.FunctionCall?.method_name === 'on_deployed'));
    checks.push(check('on_deployed callback receipt present', Boolean(cb), ''));
    const cbo = cb ? outcomeById.get(cb.receipt_id) : null;
    checks.push(check('on_deployed callback executed successfully', Boolean(cbo) && cbo.outcome?.status?.SuccessValue !== undefined, cbo ? JSON.stringify(cbo.outcome.status).slice(0, 120) : 'no outcome'));
    // Only logs emitted by the vault itself count (the deployed contract could print anything).
    const vaultEvents = outcomes.filter((o) => o.outcome?.executor_id === vault).flatMap(parseEvents);
    const deployed = vaultEvents.find((e) => e.event === 'deployed');
    const confirmed = vaultEvents.find((e) => e.event === 'deploy_confirmed');
    const failedEv = vaultEvents.find((e) => e.event === 'deploy_failed');
    checks.push(check('vault emitted `deployed` for this agent / template / name / target / deposit', Boolean(deployed) && deployed.data?.agent === agent && deployed.data?.template === wantCodeHex && deployed.data?.name === wantName && deployed.data?.target === target && String(deployed.data?.deposit) === String(exp.deposit), deployed ? `${deployed.data.name} -> ${deployed.data.target}` : 'none'));
    checks.push(check('callback emitted `deploy_confirmed` for this template / name / target', Boolean(confirmed) && confirmed.data?.template === wantCodeHex && confirmed.data?.name === wantName && confirmed.data?.target === target, confirmed ? 'deploy_confirmed' : 'missing'));
    checks.push(check('no `deploy_failed` event (callback did not reverse the charge)', !failedEv, failedEv ? JSON.stringify(failedEv.data).slice(0, 160) : 'none'));

    // ---- on-chain end state of the sub-account (final)
    let acct = null;
    try { acct = await viewAccount(net, c, { finality: 'final' }, target); } catch (e) { checks.push(check('sub-account exists on chain', false, String(e.message).slice(0, 160))); }
    if (!acct) return { ok: false, account: target, checks, observedAt: Date.now() };
    const wantB58 = base58(hexToBytes(wantCodeHex));
    checks.push(check('sub-account code hash == attested wasm sha256', acct.code_hash === wantB58, `${acct.code_hash} vs ${wantB58}`));
    let nKeys = null; let keyErr = '';
    try { nKeys = ((await rpcCall(net, c, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: target })).keys ?? []).length; } catch (e) { keyErr = String(e.message).slice(0, 160); }
    checks.push(check('sub-account has NO access keys (immutable)', nKeys === 0, nKeys === null ? `key list unreadable: ${keyErr}` : `${nKeys} keys`)); // an unreadable list is a failure, never "zero keys
    try {
      const cfg = await view(net, c, { finality: 'final' }, target, 'config');
      checks.push(check('registry owner == approved owner', cfg.owner_id === wantOwner, `${cfg.owner_id} vs ${wantOwner}`));
      checks.push(check('registry proposer == approved proposer', cfg.proposer_id === wantProposer, `${cfg.proposer_id} vs ${wantProposer}`));
      checks.push(check('registry network_id == approved network', cfg.network_id === exp.initMaterial.network_id, `${cfg.network_id} vs ${exp.initMaterial.network_id}`));
      checks.push(check('registry not paused at deploy', cfg.paused === false));
    } catch (e) { checks.push(check('registry config() view callable', false, String(e.message).slice(0, 200))); }
    return { ok: checks.every((x) => x.ok), account: target, checks, observedAt: Date.now() };
  } catch (e) {
    // Unknown tx, RPC error, unreachable node: a verification failure, never a pass.
    return fail([check('transaction found and verifiable on this network', false, String(e.message).slice(0, 240))]);
  }
}

// ------------------------------------------------------------------ verifyPay (payouts build)
const parseNep141 = (outcome) => (outcome?.outcome?.logs ?? []).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => { try { return JSON.parse(l.slice(11)); } catch { return null; } }).filter((e) => e?.standard === 'nep141');

/**
 * Transaction-level proof that the bound agent made the VAULT pay exactly `amount` of `token` to `to`, and that the token moved the funds.
 *   - the tx: signed by `agent`, to `vault`, ONE FunctionCall `pay` with 0 deposit and args exactly the approved { token, to, amount [, memo] }
 *   - nothing failed anywhere in the receipt tree (a failed ft_transfer is a Failure outcome even though the callback itself succeeds)
 *   - the vault's own `paid` event names that agent / token / payee / amount, and there is NO `pay_failed` event
 *   - the vault -> token receipt is a single `ft_transfer(receiver_id = to, amount)` with 1 yocto and executed successfully on the token
 *   - the `on_paid` callback ran and succeeded for the same token / payee / amount
 *   - the token MUST have emitted an NEP-141 `ft_transfer` event vault -> payee for that amount (no event = not a payment)
 * `memo`: when non-empty it must equal the memo that was sent. -> { ok, checks, observedAt, paid }
 */
async function verifyPay({ net, txHash, vault, agent, token, to, amount, memo, fetchImpl, role } = {}) {
  const checks = [];
  const fail = (extra) => ({ ok: false, checks: [...checks, ...extra], observedAt: Date.now(), paid: null });
  const c = ctx({ fetchImpl, role });
  if (net?.mainnet) return fail([check('mainnet is blocked', false, net.id ?? '')]);
  try {
    const want = big(amount);
    if (!validAccount(vault) || !validAccount(agent) || !validAccount(token) || !validAccount(to) || want === null || want <= 0n || want > U128_MAX) return fail([check('expected vault / agent / token / payee / amount are valid', false, '')]);
    const wantMemo = typeof memo === 'string' && memo !== '' ? memo : null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(txHash))) return fail([check('tx hash is base58', false, String(txHash).slice(0, 60))]);
    const tx = await fetchTx(net, c, txHash, agent);
    const t = tx.transaction ?? {};
    checks.push(check('tx hash returned by the node == requested', t.hash === txHash, String(t.hash)));
    checks.push(check('tx finalized', tx.final_execution_status === 'FINAL', tx.final_execution_status));
    checks.push(check('signer == the agent', t.signer_id === agent, `${t.signer_id} vs ${agent}`));
    checks.push(check('receiver == the vault', t.receiver_id === vault, `${t.receiver_id} vs ${vault}`));
    const acts = t.actions ?? [];
    const fc = acts.length === 1 ? acts[0].FunctionCall : null;
    checks.push(check('exactly one action: FunctionCall `pay` with 0 attached deposit', Boolean(fc) && fc.method_name === 'pay' && String(fc.deposit) === '0', acts.map((a) => Object.keys(a)[0]).join(',') + (fc ? `:${fc.method_name}:${fc.deposit}` : '')));
    const args = fc ? b64json(fc.args) : null;
    const keys = args ? Object.keys(args).sort() : [];
    checks.push(check('pay args are exactly { token, to, amount [, memo] }', Boolean(args) && keys.every((k) => ['amount', 'memo', 'to', 'token'].includes(k)) && ['amount', 'to', 'token'].every((k) => keys.includes(k)), keys.join(',') || 'unparsable'));
    checks.push(check('pay token == approved token', args?.token === token, `${args?.token} vs ${token}`));
    checks.push(check('pay payee == approved payee', args?.to === to, `${args?.to} vs ${to}`));
    checks.push(check('pay amount == approved amount', String(args?.amount) === want.toString(), `${args?.amount} vs ${want}`));
    checks.push(check('pay memo == approved memo', wantMemo === null ? (args?.memo === undefined || args?.memo === null || args?.memo === '') : args?.memo === wantMemo, String(args?.memo ?? '').slice(0, 60)));

    const status = tx.status ?? {};
    checks.push(check('top-level tx status is SuccessValue', status.SuccessValue !== undefined && !status.Failure, status.Failure ? JSON.stringify(status.Failure).slice(0, 160) : 'SuccessValue'));
    const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])].filter(Boolean);
    const failed = outcomes.filter((o) => failureOf(o));
    checks.push(check('no failed receipt anywhere in the receipt tree (a failed ft_transfer shows up here)', failed.length === 0 && outcomes.length >= 3, failed.length ? `${failed[0].outcome.executor_id}: ${JSON.stringify(failureOf(failed[0])).slice(0, 160)}` : `${outcomes.length} outcomes ok`));

    const receipts = tx.receipts ?? [];
    const outcomeById = new Map((tx.receipts_outcome ?? []).map((o) => [o.id, o]));
    const callsOf = (r) => (r.receipt?.Action?.actions ?? []).filter((a) => a?.FunctionCall).map((a) => a.FunctionCall);
    const ftReceipts = receipts.filter((r) => r.predecessor_id === vault && r.receiver_id === token && callsOf(r).some((f) => f.method_name === 'ft_transfer'));
    checks.push(check('exactly one vault -> token ft_transfer receipt', ftReceipts.length === 1, `${ftReceipts.length} found`));
    const ftr = ftReceipts[0];
    if (ftr) {
      const acts2 = ftr.receipt?.Action?.actions ?? [];
      const f = acts2.length === 1 ? acts2[0].FunctionCall : null;
      const fa = f ? b64json(f.args) : null;
      checks.push(check('ft_transfer is the receipt\'s only action, with exactly 1 yoctoNEAR', Boolean(f) && f.method_name === 'ft_transfer' && String(f.deposit) === '1', f ? `${f.method_name}:${f.deposit}` : 'none'));
      checks.push(check('ft_transfer receiver_id == approved payee', fa?.receiver_id === to, `${fa?.receiver_id} vs ${to}`));
      checks.push(check('ft_transfer amount == approved amount', String(fa?.amount) === want.toString(), `${fa?.amount} vs ${want}`));
      const fo = outcomeById.get(ftr.receipt_id);
      checks.push(check('token executed ft_transfer successfully', Boolean(fo) && fo.outcome?.executor_id === token && fo.outcome?.status?.SuccessValue !== undefined, fo ? JSON.stringify(fo.outcome.status).slice(0, 120) : 'no outcome'));
      // MANDATORY: NEP-141 requires the token to emit this event. A token that succeeds without it (faulty or malicious) cannot be shown to have moved funds, so it is not a payment.
      const ev = parseNep141(fo);
      checks.push(check('token event ft_transfer vault -> payee for the approved amount', ev.some((e) => e.event === 'ft_transfer' && (e.data ?? []).some((d) => d.old_owner_id === vault && d.new_owner_id === to && String(d.amount) === want.toString())), ev.length ? ev.map((e) => e.event).join(',') : 'the token emitted no NEP-141 event'));
    }
    const cb = receipts.find((r) => r.receiver_id === vault && r.predecessor_id === vault && callsOf(r).some((f) => f.method_name === 'on_paid'));
    checks.push(check('on_paid callback receipt present', Boolean(cb), ''));
    const cbo = cb ? outcomeById.get(cb.receipt_id) : null;
    checks.push(check('on_paid callback executed successfully', Boolean(cbo) && cbo.outcome?.status?.SuccessValue !== undefined, cbo ? JSON.stringify(cbo.outcome.status).slice(0, 120) : 'no outcome'));
    const cba = cb ? b64json(callsOf(cb).find((f) => f.method_name === 'on_paid')?.args) : null;
    checks.push(check('on_paid names the same token / payee / amount', Boolean(cba) && cba.token === token && cba.to === to && String(cba.amount) === want.toString(), cba ? `${cba.token} ${cba.to} ${cba.amount}` : 'none'));

    // Only logs emitted by the vault itself count (a token or payee contract could print anything).
    const vaultEvents = outcomes.filter((o) => o.outcome?.executor_id === vault).flatMap(parseEvents);
    const paid = vaultEvents.filter((e) => e.event === 'paid');
    const p0 = paid[0]?.data;
    checks.push(check('vault emitted exactly one `paid` for this agent / token / payee / amount', paid.length === 1 && p0?.agent === agent && p0?.token === token && p0?.to === to && String(p0?.amount) === want.toString(), paid.length ? `${paid.length}x ${p0?.token} -> ${p0?.to} ${p0?.amount}` : 'none'));
    const pf = vaultEvents.find((e) => e.event === 'pay_failed');
    checks.push(check('no `pay_failed` event (the callback did not reverse the charge)', !pf, pf ? JSON.stringify(pf.data).slice(0, 160) : 'none'));
    const ok = checks.every((x) => x.ok);
    return { ok, checks, observedAt: Date.now(), paid: ok ? { token, to, amount: want.toString() } : null };
  } catch (e) {
    // Unknown tx, RPC error, unreachable node: a verification failure, never a pass.
    return fail([check('transaction found and verifiable on this network', false, String(e.message).slice(0, 240))]);
  }
}

// ------------------------------------------------------------------ extensions required by src/vault/index.js (VAULT_REQUIRED_LOOP)
function loadAttestedBuild(path, build, version) {
  const source = path.replace(/^.*\/contracts\//, 'contracts/');
  try { const b = readFileSync(path); return Object.freeze({ build, version, sha256: sha256Hex(b), codeHash: base58(sha256(b)), bytes: b.length, source }); } catch (e) { return Object.freeze({ build, version, sha256: null, codeHash: null, bytes: 0, source, error: String(e.code ?? e.message).slice(0, 80) }); }
}
const BUILD_VERSION = Object.freeze({ v1: '1.0.0', pay: '1.1.0' });
/** The two attested vault builds (scripts/near-vault-build.sh): v1 = autonear_vault.wasm, pay = autonear_vault_pay.wasm. sha256 is null when a build is absent here. */
export const ATTESTED_BUILDS = Object.freeze({
  v1: loadAttestedBuild(VAULT_WASM_PATH, 'v1', BUILD_VERSION.v1),
  pay: loadAttestedBuild(VAULT_PAY_WASM_PATH, 'pay', BUILD_VERSION.pay),
});
/** Attested vault build = the wasm in contracts/near-vault/dist (scripts/near-vault-build.sh). sha256 is null when it has not been built here.
 *  BACKWARD COMPATIBLE: the top-level fields (sha256, codeHash, bytes, source) are the v1 build, exactly as before; `builds` carries both. */
const ATTESTED_VAULT = Object.freeze({ ...ATTESTED_BUILDS.v1, builds: ATTESTED_BUILDS });
/** 'v1' | 'pay' | null for an on-chain code hash (base58, as view_account returns it). null = not an attested build. */
export function buildOfCodeHash(codeHash) { return Object.values(ATTESTED_BUILDS).find((b) => b.codeHash && b.codeHash === codeHash)?.build ?? null; }
/** Which attested build is deployed at `vault`? -> { build: 'v1'|'pay'|null, codeHash, version } from the final view_account + config(). null build = unattested code; version is what the contract claims. */
async function detectVaultBuild({ net, vault, fetchImpl, role, block } = {}) {
  const c = ctx({ fetchImpl, role }); const blk = blockRef(block);
  const acct = await viewAccount(net, c, blk, vault);
  const cfg = await view(net, c, blk, vault, 'config');
  return { build: buildOfCodeHash(acct.code_hash), codeHash: acct.code_hash, version: cfg.version ?? null };
}

/** Gas attached by the agent's signer (src/agent/near-signer.js DEFAULT_GAS); signerOptions() pins the same numbers so estimateFee and the signer agree. */
export const ATTACHED_GAS = Object.freeze({ draw: 50n * TGAS, deploy: 300n * TGAS, pay: 100n * TGAS });
/** The signer prices the worst case at current gas price x 1.5 (gasPriceMultiplier default). Same arithmetic here. */
export const GAS_PRICE_MULTIPLIER_PERCENT = 150n;
const nearNetworkId = (net) => net?.nearNetworkId ?? net?.networkId ?? (net?.mainnet ? 'mainnet' : net?.id === 'near-testnet' ? 'testnet' : 'localnet');

/** Options for keystore.signer('near', opts). The signer itself refuses any chain_id that is not testnet / sandbox / localnet or differs from networkId. */
const signerOptions = ({ net, fetchImpl, extra = {}, payouts = false } = {}) => ({
  rpcUrl: net.rpc, networkId: nearNetworkId(net), fetchImpl, role: 'launch',
  // `payouts: true` (a payouts-build vault) also pins the gas of `pay`; the default keeps the v1 shape byte for byte.
  gas: { draw: ATTACHED_GAS.draw.toString(), deploy: ATTACHED_GAS.deploy.toString(), ...(payouts ? { pay: ATTACHED_GAS.pay.toString() } : {}) }, ...extra,
});

/** Worst-case fee (yoctoNEAR, bigint) the signer would price this call at: attached gas x gas_price x 1.5. No deposit is ever attached by the agent. */
async function estimateFee({ net, call, fetchImpl, role } = {}) {
  const gas = ATTACHED_GAS[call?.method];
  if (gas === undefined) throw new Error(`estimateFee: unknown method "${String(call?.method).slice(0, 20)}"`);
  const r = await rpcCall(net, ctx({ fetchImpl, role: role ?? 'launch' }), 'gas_price', [null]);
  const price = BigInt(r.gas_price);
  return { gas, price, worstCaseFee: (gas * price * GAS_PRICE_MULTIPLIER_PERCENT + 99n) / 100n };
}

/**
 * Per-decision sub-account. The approved payload names it (registry.contractAccount = <name>.<vault>); only if the payload names none a
 * deterministic name is derived from the decision id. `predicted` = the full account id the vault will create.
 */
function deployTarget({ decision, vault, expected } = {}) {
  const payload = parseMaybe(decision?.payload ?? decision) ?? {};
  const ca = payload.registry?.contractAccount;
  const named = typeof ca === 'string' && vault && ca.endsWith(`.${vault}`) ? ca.slice(0, -(vault.length + 1)) : expected?.name ?? null;
  if (named && validSubName(named)) return { nameOrSalt: named, predicted: subAccountOf(vault, named) };
  if (ca) throw new Error(`deployTarget: approved contractAccount "${String(ca).slice(0, 70)}" is not <name>.${vault}`);
  const derived = `reg-${sha256Hex(new TextEncoder().encode(`autonear:deploy:${decision?.id ?? ''}`)).slice(0, 16)}`;
  return { nameOrSalt: derived, predicted: subAccountOf(vault, derived) };
}

/**
 * ADDITIVE helper (not part of the binding interface): is the on-chain template exactly what the approved payload says?
 * On NEAR the template id is sha256(wasm) ONLY; the init args the vault will use are whatever the owner stored with it, so id equality
 * does NOT prove the registry will be owned by the approved owner. Feed it a readState() result (templates[].initArgs/deposit).
 */
function checkTemplate({ state, expected }) {
  const checks = [];
  const t = (state?.templates ?? []).find((x) => String(x.id).toLowerCase() === expected.templateId);
  checks.push(check('template allowlisted on-chain', Boolean(t), t ? t.label : 'missing'));
  if (t) {
    checks.push(check('on-chain init_args == approved init material (owner / proposer / network)', deepEq(t.initArgs, expected.initMaterial), stable(t.initArgs).slice(0, 140)));
    checks.push(check('on-chain template deposit == approved deposit', String(t.deposit) === String(expected.deposit), `${t.deposit} vs ${expected.deposit}`));
    checks.push(check('on-chain template init_gas == 30 Tgas', String(t.initGas) === expected.initGas, String(t.initGas)));
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ------------------------------------------------------------------ human plan (near-cli-rs commands, UNEXECUTED here)
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function formatNear(yocto) {
  const y = BigInt(yocto); const whole = y / NEAR_YOCTO; const frac = (y % NEAR_YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const NEAR_YOCTO = 10n ** 24n;
/**
 * Exact owner-side steps for a grant_mandate payload { vault:{address,owner}, agent:{account}, mandate:{...}, templates:[...], fund:{amount} }.
 * `cli` follows scripts/near-vault-deploy.sh (near-cli-rs); `call` is the structured equivalent. NONE of these commands has been executed
 * by this repository (the near CLI is not installed here); the contract methods and JSON args they carry ARE what the sandbox e2e sends.
 */
function planSteps({ net, payload, vault }) {
  const network = nearNetworkId(net); const owner = payload.vault?.owner; const agent = payload.agent?.account; const m = payload.mandate ?? {};
  const callCli = (method, args, deposit = '0') => `near contract call-function as-transaction ${shq(vault)} ${method} json-args ${shq(JSON.stringify(args))} prepaid-gas '30 Tgas' attached-deposit '${deposit} NEAR' sign-as ${shq(owner)} network-config ${network} sign-with-keychain send`;
  const steps = [];
  for (const t of payload.templates ?? []) {
    const args = { template_id: t.templateId, label: t.label, deposit: String(t.deposit), init_args: t.initMaterial ?? {}, init_gas: DEFAULT_INIT_GAS.toString() };
    steps.push({
      who: 'human', title: `allow_template: ${t.label}`,
      note: `Owner allowlists templateId ${t.templateId} (= sha256 of the attested registry wasm) with the init args FIXED here (${stable(t.initMaterial ?? {}).slice(0, 200)}) and a ${formatNear(t.deposit)} NEAR deposit per deploy. On NEAR the template id does NOT contain the init args: check them before running.`,
      call: { receiverId: vault, method: 'allow_template', args, gas: '30000000000000', deposit: '0' }, cli: callCli('allow_template', args),
    });
  }
  const sm = { agent, expires_at: String(m.expiresAt), per_draw_cap: String(m.perDrawCap), period_secs: String(m.periodSecs), period_cap: String(m.periodCap), total_cap: String(m.totalCap), max_deploys: Number(m.maxDeploys) };
  steps.push({
    who: 'human', title: 'set_mandate',
    note: `Binds the agent account ${agent}. expires_at (${m.expiresAt}) must still satisfy now < expires_at <= now + 30 days when you send this, otherwise the vault panics E_BadMandate: propose again. Caps are in yoctoNEAR.`,
    call: { receiverId: vault, method: 'set_mandate', args: sm, gas: '30000000000000', deposit: '0' }, cli: callCli('set_mandate', sm),
  });
  const fund = String(payload.fund?.amount ?? '0');
  if (BigInt(fund) > 0n) {
    steps.push({
      who: 'human', title: `Fund the vault with ${formatNear(fund)} NEAR`, note: 'Plain transfer to the vault account (no event). Gifts only: funding changes no budget; withdraw() returns it to the owner any time. The vault keeps ~2.5 NEAR for its own storage plus a 1 NEAR reserve.',
      call: { receiverId: vault, method: null, args: null, deposit: fund },
      cli: `near tokens ${shq(owner)} send-near ${shq(vault)} '${formatNear(fund)} NEAR' network-config ${network} sign-with-keychain send`,
    });
  }
  if (payload.payouts) steps.push(...grantPayoutSteps({ net, payload, vault }));
  steps.push({
    who: 'human', title: 'Seed the agent account with a little gas (once)', note: `The agent pays the gas of its OWN first draw, and a NEAR implicit account does not exist until it receives a transfer. Send ~1 NEAR to ${agent} once; after that the vault funds its gas. (Sandbox: one deploy tx cost ~0.014 NEAR and needs ~0.045 NEAR of balance as worst-case prepaid gas.)`,
    call: { receiverId: agent, method: null, args: null, deposit: String(NEAR_YOCTO) },
    cli: `near tokens ${shq(owner)} send-near ${shq(agent)} '1 NEAR' network-config ${network} sign-with-keychain send`,
  });
  steps.push({
    who: 'human', title: 'Decide about the vault account\'s own keys', note: `Whoever holds a FULL-ACCESS key on ${vault} can redeploy it or move its balance, bypassing every rule. Keep that key under the owner multisig, or delete it once everything is verified (the vault can then never be changed; owner withdraw() still works).`,
  }); // no cli on purpose: a read-only key listing is a different command shape and its near-cli-rs syntax was not verified here

  return steps;
}

// ------------------------------------------------------------------ payouts: owner-side plan steps (builders only; not wired into planSteps/activation yet)
/** Attached to NEP-145 `storage_deposit(registration_only)`: 0.0025 NEAR. Above the usual minimum (~0.00125); with registration_only the token refunds the excess. */
export const STORAGE_DEPOSIT_DEFAULT = 25n * 10n ** 20n;
const humanStep = ({ net, owner, receiver, method, args, gas, deposit = 0n, title, note }) => ({
  who: 'human', title, note,
  call: { receiverId: receiver, method, args, gas: gas.toString(), deposit: deposit.toString() },
  cli: `near contract call-function as-transaction ${shq(receiver)} ${method} json-args ${shq(JSON.stringify(args))} prepaid-gas '${gas / TGAS} Tgas' attached-deposit '${formatNear(deposit)} NEAR' sign-as ${shq(owner)} network-config ${nearNetworkId(net)} sign-with-keychain send`,
});
/** Owner step: register `account` on `token` (NEP-145 storage_deposit, registration_only). ft_transfer to an unregistered account fails, the vault reverses the charge. */
function storageDepositStep({ net, owner, token, account, deposit = STORAGE_DEPOSIT_DEFAULT, label } = {}) {
  if (!validAccount(owner) || !validAccount(token) || !validAccount(account)) throw new Error('storageDepositStep: owner, token and account must be NEAR account ids');
  const d = big(deposit); if (d === null || d <= 0n) throw new Error('storageDepositStep: deposit must be a positive yoctoNEAR amount');
  return humanStep({ net, owner, receiver: token, method: 'storage_deposit', args: { account_id: account, registration_only: true }, gas: 30n * TGAS, deposit: d,
    title: `storage_deposit: register ${account} on ${label ?? token}`,
    note: `Pays the token contract's one-time storage fee (${formatNear(d)} NEAR attached, registration_only: the excess is refunded) so ${account} can hold ${label ?? token}. Without it a transfer to this account fails and the vault gives the budget back.` });
}
/** Owner step: allow_token on the vault (payouts build). Caps are in the token's smallest unit. */
function allowTokenStep({ net, owner, vault, token, perPayCap, periodCap, totalCap, label, decimals } = {}) {
  const c = buildCall('allow_token', { vault, token, perPayCap, periodCap, totalCap });
  const shown = (v) => (decimals === undefined ? String(v) : formatUnitsStr(v, decimals));
  return humanStep({ net, owner, receiver: vault, method: 'allow_token', args: c.args, gas: BigInt(c.gas),
    title: `allow_token: ${label ?? token}`,
    note: `Owner allowlists ${token} for payouts: at most ${shown(c.args.per_pay_cap)} per payment, ${shown(c.args.period_cap)} per period, ${shown(c.args.total_cap)} in total (same clock, agent, expiry, pause and revoke as the NEAR mandate; set_mandate resets the usage, not the caps).` });
}
/** Owner step: allow_payee on the vault (payouts build). */
function allowPayeeStep({ net, owner, vault, account } = {}) {
  const c = buildCall('allow_payee', { vault, account });
  return humanStep({ net, owner, receiver: vault, method: 'allow_payee', args: c.args, gas: BigInt(c.gas), title: `allow_payee: ${account}`,
    note: `Owner lets the agent pay ${account}. The agent can pay nobody who is not on this list.` });
}
const formatUnitsStr = (v, decimals) => { const d = 10n ** BigInt(decimals); const x = BigInt(v); const f = (x % d).toString().padStart(Number(decimals), '0').replace(/0+$/, ''); return f ? `${x / d}.${f}` : `${x / d}`; };
/**
 * Exact owner-side steps of a payouts grant, in the order that is safe to run: (1) register the vault and each payee on each token (storage_deposit),
 * (2) allow_token per token, (3) allow_payee per payee. Funding the vault with the token itself and the mandate/NEAR steps stay in planSteps.
 * tokens: [{ token, perPayCap, periodCap, totalCap, label?, decimals?, storageDeposit? }]; payees: [account]; registered: ['<token>:<account>'] already registered (skipped).
 * Refuses what the contract would refuse (E_BadToken / E_BadPayee): > 8 tokens, > 64 payees, caps out of order, a token that is also a payee, the vault / system / zero account.
 */
function payoutPlanSteps({ net, vault, owner, tokens = [], payees = [], registered = [] } = {}) {
  if (!validAccount(vault) || !validAccount(owner)) throw new Error('payoutPlanSteps: vault and owner must be NEAR account ids');
  if (tokens.length > 8) throw new Error('payoutPlanSteps: at most 8 tokens (E_BadToken)');
  if (payees.length > 64) throw new Error('payoutPlanSteps: at most 64 payees (E_BadPayee)');
  const tokenIds = tokens.map((t) => t.token);
  if (new Set(tokenIds).size !== tokenIds.length || new Set(payees).size !== payees.length) throw new Error('payoutPlanSteps: duplicate token or payee');
  for (const a of tokenIds) if (payees.includes(a)) throw new Error(`payoutPlanSteps: ${a} cannot be both a token and a payee (E_BadToken / E_BadPayee)`);
  const done = new Set(registered instanceof Set ? [...registered] : registered);
  const steps = [];
  const reg = (t, account) => { if (!done.has(`${t.token}:${account}`)) steps.push(storageDepositStep({ net, owner, token: t.token, account, deposit: t.storageDeposit, label: t.label })); };
  for (const t of tokens) { buildCall('allow_token', { vault, ...t }); reg(t, vault); }   // validates every cap/account before any step is returned
  for (const a of payees) buildCall('allow_payee', { vault, account: a });
  for (const t of tokens) for (const a of payees) reg(t, a);
  for (const t of tokens) steps.push(allowTokenStep({ net, owner, vault, ...t }));
  for (const a of payees) steps.push(allowPayeeStep({ net, owner, vault, account: a }));
  return steps;
}

const MOCK_MINT_MAX_WHOLE = 10_000n;
/** Owner step: `mint(account_id, amount)` on the TESTNET MOCK token (open faucet, <= 10,000 whole tokens per call). `deposit` (default 0.0025 NEAR) is the token's storage
 *  fee for an account that is not registered yet; it is REQUIRED then (E_StorageDeposit otherwise) and the token refunds the excess, so a registered receiver loses nothing. */
function mintStep({ net, owner, token, account, amount, deposit = STORAGE_DEPOSIT_DEFAULT, label, decimals } = {}) {
  if (!validAccount(owner) || !validAccount(token) || !validAccount(account)) throw new Error('mintStep: owner, token and account must be NEAR account ids');
  const a = needAmount('mint amount', amount); const d = big(deposit);
  if (d === null || d < 0n) throw new Error('mintStep: deposit must be a yoctoNEAR amount');
  const shown = decimals === undefined ? a.toString() : formatUnitsStr(a, decimals);
  return humanStep({ net, owner, receiver: token, method: 'mint', args: { account_id: account, amount: a.toString() }, gas: 30n * TGAS, deposit: d,
    title: `mint ${shown} ${label ?? token} to ${account} (test faucet)`,
    note: `Open faucet of the testnet mock token: anyone may mint, up to ${MOCK_MINT_MAX_WHOLE} whole tokens per call. ${formatNear(d)} NEAR is attached for the token's storage fee: it is needed when ${account} is not registered on the token yet, and the excess is refunded to you.` });
}
/** Owner step: `ft_transfer(receiver_id, amount)` from the owner to the vault, 1 yoctoNEAR (NEP-141). The vault must already be registered on the token. */
function ftTransferStep({ net, owner, token, receiver, amount, label, decimals, memo } = {}) {
  if (!validAccount(owner) || !validAccount(token) || !validAccount(receiver)) throw new Error('ftTransferStep: owner, token and receiver must be NEAR account ids');
  const a = needAmount('ft_transfer amount', amount);
  const shown = decimals === undefined ? a.toString() : formatUnitsStr(a, decimals);
  return humanStep({ net, owner, receiver: token, method: 'ft_transfer', args: { receiver_id: receiver, amount: a.toString(), ...(memo ? { memo } : {}) }, gas: 30n * TGAS, deposit: 1n,
    title: `Fund the vault with ${shown} ${label ?? token}`,
    note: `Plain NEP-141 transfer of ${shown} ${label ?? token} from you to ${receiver} (1 yoctoNEAR attached, as the standard requires). Funding changes no budget: only allow_token limits do. withdraw_token returns it to you at any time.` });
}
/** The payouts part of a grant plan: registrations, allow_token, allow_payee (payoutPlanSteps) and the token funding (mint for the testnet mock token, then the transfer to the vault). */
function grantPayoutSteps({ net, payload, vault }) {
  const p = payload.payouts; const owner = payload.vault?.owner;
  const tokens = p.tokens.map((t) => ({ token: t.token, perPayCap: t.perPayCap, periodCap: t.periodCap, totalCap: t.totalCap, label: t.symbol, decimals: t.decimals }));
  const steps = payoutPlanSteps({ net, vault, owner, tokens, payees: p.payees });
  const fund = p.fund;
  if (fund && BigInt(fund.amount) > 0n) {
    const t = p.tokens.find((x) => x.token === fund.token);
    if (t?.mock) {
      const chunk = MOCK_MINT_MAX_WHOLE * 10n ** BigInt(t.decimals);
      for (let left = BigInt(fund.amount); left > 0n; left -= chunk) steps.push(mintStep({ net, owner, token: t.token, account: owner, amount: left > chunk ? chunk : left, label: t.symbol, decimals: t.decimals }));
    }
    steps.push(ftTransferStep({ net, owner, token: fund.token, receiver: vault, amount: fund.amount, label: t?.symbol, decimals: t?.decimals, memo: 'fund vault' }));
  }
  return steps;
}

// ------------------------------------------------------------------ explorers
const explorerBase = (net) => String(net?.explorer ?? '').replace(/\/txns\/?$/, '');
/** testnet: https://testnet.nearblocks.io/txns/<hash>. A local network (no explorer) returns ''. */
function explorerTx(net, txHash) { return net?.explorer ? `${String(net.explorer).replace(/\/?$/, '/')}${txHash}` : ''; }
function explorerAddress(net, addr) { const b = explorerBase(net); return b ? `${b}/address/${addr}` : ''; }

export const adapter = Object.freeze({
  chain: 'near',
  unit,
  attested: ATTESTED_VAULT,
  readState, verifyVaultCode, expectedTemplate, buildCall, verifyDeploy,
  explorerTx, explorerAddress,
  // extensions required by src/vault/index.js (VAULT_REQUIRED_LOOP)
  preview, estimateFee, signerOptions, deployTarget, planSteps,
  // additive extras (ignoring them is safe)
  previewDraw, previewDeploy, checkTemplate, depositForWasm, validSubName, subAccountOf,
  // payouts build (phase 2a): which build is on chain, the pay preview, NEP-141 / NEP-145 reads, owner plan-step builders
  builds: ATTESTED_BUILDS, detectVaultBuild, buildOfCodeHash, previewPay,
  ftBalance, storageBalanceOf, ftRegistered, storageBalanceBounds, ftMetadata,
  payoutPlanSteps, storageDepositStep, allowTokenStep, allowPayeeStep,
  // payouts build (phase 2b): verify a pay transaction, funding plan steps
  verifyPay, mintStep, ftTransferStep, grantPayoutSteps,
});
export default adapter;
