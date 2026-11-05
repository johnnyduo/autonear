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
  const out = {
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
  if (previews) {
    out.previews = { draw: {}, deploy: {} };
    for (const a of previews.draw ?? []) out.previews.draw[String(a)] = await v('preview_draw', { amount: String(a) });
    for (const d of previews.deploy ?? []) out.previews.deploy[`${d.template}:${d.name}`] = await v('preview_deploy', { template: d.template, name: d.name });
  }
  return out;
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
const blockRef = (block) => (block === undefined || block === null || block === '' ? { finality: 'final' } : { block_id: /^\d+$/.test(String(block)) ? Number(block) : String(block) });
/** Core-facing preview (src/vault/index.js): '' = the call would pass, else the vault's error code name. `block` = readState().blockTag. */
async function preview(kind, { net, vault, amount, template, nameOrSalt, name, block, fetchImpl, role } = {}) {
  if (kind === 'draw') return previewDraw({ net, vault, amount, block, fetchImpl, role });
  if (kind === 'deploy') return previewDeploy({ net, vault, template, name: nameOrSalt ?? name, block, fetchImpl, role });
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
 * attested: the vault build's sha256 hex, a manifest { sha256 }, or the wasm bytes; omitted = sha256 of contracts/near-vault/dist/autonear_vault.wasm.
 * Checks: on-chain code hash == base58(sha256(attested wasm)); config() is callable and names this very account; vault holds no function-call/other
 * keys is NOT judged here (INFO only): a full-access key on the vault account can bypass every rule and a human must own that decision.
 */
async function verifyVaultCode({ net, vault, attested, fetchImpl, role } = {}) {
  const c = ctx({ fetchImpl, role });
  const checks = [];
  let want = attested === undefined || attested === null ? null : attestedHash(attested);
  let source = 'attested';
  if (!want) {
    try { want = sha256Hex(readFileSync(VAULT_WASM_PATH)); source = 'contracts/near-vault/dist'; } catch (e) { checks.push(check('attested vault wasm hash available', false, `${VAULT_WASM_PATH}: ${e.code ?? e.message}`)); return { ok: false, checks }; }
  }
  checks.push(check('attested vault hash is 64 lowercase hex', isHex32(want), `${source}: ${String(want).slice(0, 70)}`));
  if (!isHex32(want)) return { ok: false, checks };
  const wantB58 = base58(hexToBytes(want));
  try {
    const acct = await viewAccount(net, c, { finality: 'final' }, vault);
    checks.push(check('on-chain code hash == attested vault wasm sha256', acct.code_hash === wantB58, `${acct.code_hash} vs ${wantB58}`));
  } catch (e) { checks.push(check('vault account readable', false, String(e.message).slice(0, 200))); return { ok: false, checks }; }
  try {
    const cfg = await view(net, c, { finality: 'final' }, vault, 'config');
    checks.push(check('config() callable and vault_id == this account', cfg.vault_id === vault, `${cfg.vault_id} vs ${vault}`));
    checks.push(check('config().version is 1.0.0', cfg.version === '1.0.0', String(cfg.version)));
  } catch (e) { checks.push(check('config() callable', false, String(e.message).slice(0, 200))); }
  try {
    const keys = await rpcCall(net, c, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: vault });
    const full = (keys.keys ?? []).filter((k) => k.access_key?.permission === 'FullAccess').map((k) => k.public_key);
    checks.push({ name: 'INFO: full-access keys on the vault account (whoever holds one can bypass the contract; a human must confirm each is theirs)', ok: true, detail: full.join(', ') || 'none (vault account is locked)', info: true });
  } catch (e) { checks.push({ name: 'INFO: vault access key list unavailable', ok: true, detail: String(e.message).slice(0, 160), info: true }); }
  return { ok: checks.every((x) => x.ok), checks };
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
/** -> { method, target, args } exactly as src/agent/near-signer.js (enforceCall + defaultEncodeArgs) accepts and encodes it. */
function buildCall(kind, { vault, amount, template, code, nameOrSalt } = {}) {
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
  throw new Error(`buildCall: unknown kind "${String(kind).slice(0, 20)}"`);
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
    const keys = await rpcCall(net, c, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: target });
    checks.push(check('sub-account has NO access keys (immutable)', (keys.keys ?? []).length === 0, `${(keys.keys ?? []).length} keys`));
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

// ------------------------------------------------------------------ extensions required by src/vault/index.js (VAULT_REQUIRED_LOOP)
function loadAttestedVault() {
  try { const b = readFileSync(VAULT_WASM_PATH); return Object.freeze({ sha256: sha256Hex(b), codeHash: base58(sha256(b)), bytes: b.length, source: 'contracts/near-vault/dist/autonear_vault.wasm' }); } catch (e) { return Object.freeze({ sha256: null, codeHash: null, bytes: 0, source: 'contracts/near-vault/dist/autonear_vault.wasm', error: String(e.code ?? e.message).slice(0, 80) }); }
}
/** Attested vault build = the wasm in contracts/near-vault/dist (scripts/near-vault-build.sh). sha256 is null when it has not been built here. */
const ATTESTED_VAULT = loadAttestedVault();

/** Gas attached by the agent's signer (src/agent/near-signer.js DEFAULT_GAS); signerOptions() pins the same numbers so estimateFee and the signer agree. */
export const ATTACHED_GAS = Object.freeze({ draw: 50n * TGAS, deploy: 300n * TGAS });
/** The signer prices the worst case at current gas price x 1.5 (gasPriceMultiplier default). Same arithmetic here. */
export const GAS_PRICE_MULTIPLIER_PERCENT = 150n;
const nearNetworkId = (net) => net?.nearNetworkId ?? net?.networkId ?? (net?.mainnet ? 'mainnet' : net?.id === 'near-testnet' ? 'testnet' : 'localnet');

/** Options for keystore.signer('near', opts). The signer itself refuses any chain_id that is not testnet / sandbox / localnet or differs from networkId. */
const signerOptions = ({ net, fetchImpl, extra = {} } = {}) => ({
  rpcUrl: net.rpc, networkId: nearNetworkId(net), fetchImpl, role: 'launch',
  gas: { draw: ATTACHED_GAS.draw.toString(), deploy: ATTACHED_GAS.deploy.toString() }, ...extra,
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
});
export default adapter;
