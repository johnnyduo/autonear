// Shared scaffolding for the payouts (phase 2b-1) service tests: a FAKE NEAR testnet (vault of the payouts build + a mock token, served through an injected fetchImpl),
// receipts of pay transactions, and a complete "world" (database, app, vault attached, grant proposed + approved, chain brought to the granted state, vault activated).
// Nothing here touches a network. The vault code hash is the real attested payouts wasm (contracts/near-vault/dist), so tests that need it skip when it is not built.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { memDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { recordAttestation } from '../src/attest.js';
import { ATTESTED_BUILDS, REGISTRY_WASM_PATH } from '../src/vault/near.js';
import { base58, hexToBytes } from '../src/chains/common.js';

export const NEAR = 10n ** 24n;
export const VAULT = 'vault.testnet', OWNER = 'owner.testnet', AGENT = 'ab'.repeat(32);
export const USDC = 'usdc.testnet', USDT = 'usdt.testnet', ALICE = 'alice.testnet', BOB = 'bob.testnet', CAROL = 'carol.testnet';
export const M = 10n ** 6n;
export const OPERATOR = 'test-operator-token';
export const HAVE_BUILDS = Boolean(ATTESTED_BUILDS.v1.sha256 && ATTESTED_BUILDS.pay.sha256) && existsSync(REGISTRY_WASM_PATH);
export const skipNoBuilds = HAVE_BUILDS ? false : 'attested wasm builds not present (contracts/near-vault/dist, contracts/near-registry/dist)';
export const TX = '8mXz1cWfWhQ7zY3iKJp4nRtVb6sLd9aEoUq2HgFxYk5T'; // base58, 44 chars
export const TX2 = '5Kq9xHn3sP7wRtYbZc2dLmVf8aJgUeNo4iXyWk6TzB1C';
const b58Of = (hex) => base58(hexToBytes(hex));
export const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');

/** A fake chain: the payouts vault (`pay: true`) or the v1 vault, the mock token USDC (6 decimals, "Mock" name) and a plain USDT, and a tx store. Mutate `w` between calls. */
export function makeChain({ pay = true } = {}) {
  const buildHash = pay ? ATTESTED_BUILDS.pay.sha256 : ATTESTED_BUILDS.v1.sha256;
  const w = {
    pay,
    block: { height: 5000, hash: 'BLOCKHASH', timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) },
    accounts: { [VAULT]: { amount: String(50n * NEAR), code_hash: b58Of(buildHash ?? 'aa'.repeat(32)), storage_usage: 250000 }, [AGENT]: { amount: String(NEAR), code_hash: '11111111111111111111111111111111' } },
    keys: { [VAULT]: [] },
    calls: [],
    txs: {},
    views: {
      [VAULT]: {
        config: { owner: OWNER, pending_owner: null, paused: false, network_id: 'testnet', epoch: '0', vault_id: VAULT, version: pay ? '1.1.0' : '1.0.0', reserve: String(NEAR) },
        mandate: null,
        usage: { total_spent: '0', period_index: '0', period_spent: '0', deploys: 0 },
        available: String(45n * NEAR), templates: [],
        period_state: null,
        preview_draw: '', preview_deploy: '',
      },
      [USDC]: {
        ft_balance_of: (a) => w.balances[a.account_id] ?? '0',
        storage_balance_of: () => ({ total: '1250000000000000000000', available: '0' }),
        storage_balance_bounds: { min: '1250000000000000000000', max: null },
        ft_metadata: { spec: 'ft-1.0.0', name: 'Mock USDC (testnet, anyone can mint)', symbol: 'USDC', decimals: 6 },
      },
      [USDT]: { ft_metadata: { spec: 'ft-1.0.0', name: 'Tether USD', symbol: 'USDT', decimals: 6 }, ft_balance_of: '0' },
    },
    balances: { [VAULT]: String(500n * M) },
    onChainTokens: [], onChainPayees: [], usage: {},
  };
  if (pay) {
    Object.assign(w.views[VAULT], {
      tokens: () => w.onChainTokens.map((t) => ({ token: t.token, per_pay_cap: t.perPayCap, period_cap: t.periodCap, total_cap: t.totalCap })),
      token_usage: (a) => w.usage[a.token] ?? { total_spent: '0', period_index: '0', period_spent: '0' },
      payees: (a) => w.onChainPayees.slice(Number(a.from_index ?? 0), Number(a.from_index ?? 0) + Number(a.limit ?? 50)),
      preview_pay: '',
    });
  }
  /** Bring the chain to the state a grant payload describes (what the owner's wallet steps would do). */
  w.applyGrant = (payload, { epoch = 1, payouts = true, start } = {}) => {
    const m = payload.mandate; const v = w.views[VAULT];
    v.config.epoch = String(epoch);
    v.mandate = { agent: payload.agent.account, expires_at: m.expiresAt, per_draw_cap: m.perDrawCap, period_secs: m.periodSecs, period_cap: m.periodCap, total_cap: m.totalCap, max_deploys: Number(m.maxDeploys), revoked: false, start: String(start ?? Math.floor(Date.now() / 1000) - 60), active: true };
    v.templates = payload.templates.map((t) => ({ id: t.templateId, label: t.label, deposit: t.deposit, init_args: t.initMaterial, init_gas: '30000000000000' }));
    const nowSecs = Number(v.mandate.start);
    v.period_state = { period_index: '0', period_start: String(nowSecs), period_end: String(nowSecs + Number(m.periodSecs)), period_spent: '0', period_remaining: m.periodCap, total_spent: '0', total_remaining: m.totalCap, deploys: 0, deploys_remaining: Number(m.maxDeploys), active: true };
    if (payouts && payload.payouts) {
      w.onChainTokens = payload.payouts.tokens.map((t) => ({ token: t.token, perPayCap: t.perPayCap, periodCap: t.periodCap, totalCap: t.totalCap }));
      w.onChainPayees = [...payload.payouts.payees];
    }
    return w;
  };
  return w;
}

export function rpc(w) {
  return async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    w.calls.push({ method, params });
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    const err = (data) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error', data } }), { status: 200 });
    if (w.down) return err('node unreachable');
    if (method === 'block') return ok({ header: w.block });
    if (method === 'gas_price') return ok({ gas_price: '100000000' });
    if (method === 'EXPERIMENTAL_tx_status' || method === 'tx') {
      const t = w.txs[params.tx_hash];
      if (!t) return err(`Transaction ${params.tx_hash} doesn't exist`);
      return ok(t);
    }
    if (method === 'query') {
      if (params.request_type === 'view_account') { const a = w.accounts[params.account_id]; return a ? ok({ code_hash: '11111111111111111111111111111111', storage_usage: 100, ...a }) : err(`account ${params.account_id} does not exist while viewing`); }
      if (params.request_type === 'view_access_key_list') return ok({ keys: w.keys[params.account_id] ?? [] });
      if (params.request_type === 'call_function') {
        const v = w.views[params.account_id]?.[params.method_name];
        if (v === undefined) return err(`method ${params.method_name} not found on ${params.account_id}`);
        const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        return ok({ result: Array.from(Buffer.from(JSON.stringify(typeof v === 'function' ? v(args) : v))), logs: [], block_height: 1 });
      }
    }
    return err(`unmocked ${method}`);
  };
}

/** The transaction of a successful `pay` as EXPERIMENTAL_tx_status returns it: vault.pay -> token.ft_transfer -> vault.on_paid. Override any part. */
export function payTx({ vault = VAULT, agent = AGENT, token = USDC, to = ALICE, amount = String(25n * M), memo = 'invoice 42', hash = TX } = {}) {
  const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', version: '1.1.0', event, data })}`;
  const nep = (oldOwner, newOwner, amt) => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: oldOwner, new_owner_id: newOwner, amount: amt }] })}`;
  const payArgs = { token, to, amount, ...(memo ? { memo } : {}) };
  const ftArgs = { receiver_id: to, amount, ...(memo ? { memo } : {}) };
  const action = { FunctionCall: { method_name: 'pay', args: b64(payArgs), gas: 100000000000000, deposit: '0' } };
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: { signer_id: agent, public_key: 'ed25519:xx', nonce: 5, receiver_id: vault, hash, actions: [action] },
    transaction_outcome: { id: hash, outcome: { executor_id: agent, logs: [], status: { SuccessReceiptId: 'R_PAY' } } },
    receipts_outcome: [
      { id: 'R_PAY', outcome: { executor_id: vault, logs: [ev('paid', { agent, token, to, amount, memo: memo || null, epoch: '1', total_spent: amount, period_spent: amount })], status: { SuccessReceiptId: 'R_CB' } } },
      { id: 'R_FT', outcome: { executor_id: token, logs: [nep(vault, to, amount)], status: { SuccessValue: '' } } },
      { id: 'R_CB', outcome: { executor_id: vault, logs: [], status: { SuccessValue: '' } } },
      { id: 'R_REFUND', outcome: { executor_id: agent, logs: [], status: { SuccessValue: '' } } },
    ],
    receipts: [
      { predecessor_id: agent, receiver_id: vault, receipt_id: 'R_PAY', receipt: { Action: { actions: [action] } } },
      { predecessor_id: vault, receiver_id: token, receipt_id: 'R_FT', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_transfer', args: b64(ftArgs), gas: 30000000000000, deposit: '1' } }] } } },
      { predecessor_id: vault, receiver_id: vault, receipt_id: 'R_CB', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'on_paid', args: b64({ epoch: '1', period_index: '0', token, to, amount }), gas: 10000000000000, deposit: '0' } }] } } },
      { predecessor_id: 'system', receiver_id: agent, receipt_id: 'R_REFUND', receipt: { Action: { actions: [{ Transfer: { deposit: '1000' } }] } } },
    ],
  };
}
/** Same tx, but the token refused the transfer: the callback succeeded and logged pay_failed (charge reversed). */
export function failedPayTx(o = {}) {
  const t = payTx(o);
  const { vault = VAULT, token = USDC, to = ALICE, amount = String(25n * M) } = o;
  t.receipts_outcome.find((x) => x.id === 'R_FT').outcome = { executor_id: token, logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account doesn\'t have enough balance' } } } } } };
  t.receipts_outcome.find((x) => x.id === 'R_CB').outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', version: '1.1.0', event: 'pay_failed', data: { token, to, amount, epoch: '1', reversed: true } })}`];
  void vault;
  return t;
}

const registryAttestation = () => {
  const wasm = readFileSync(REGISTRY_WASM_PATH);
  return { protocol: 'near', commitSha: 'test-fixture', manifest: { sha256: createHash('sha256').update(wasm).digest('hex'), bytes: wasm.length, sourceSha256: 'cd'.repeat(32) }, tests: { passed: 5, failed: 0, lint: true, names: ['x'] } };
};

export function apiClient(app, token = OPERATOR) {
  const ip = `test-ip-${Math.random().toString(36).slice(2)}`; // own rate-limit bucket per client (writes are limited to 20/min per ip)
  return async (path, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const r = await app(new Request('http://t' + path, { method, headers: { 'x-peer-ip': ip, ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
}

export const MANDATE = { perDrawCap: String(NEAR / 2n), periodSecs: 3600, periodCap: String(2n * NEAR), totalCap: String(5n * NEAR), maxDeploys: 2 };
export const PAYOUTS = () => ({
  tokens: [{ token: USDC, perPayCap: String(40n * M), periodCap: String(100n * M), totalCap: String(400n * M) }],
  payees: [ALICE, BOB],
  fund: { token: USDC, amount: String(500n * M) },
});

/**
 * database + app + fake chain, vault attached. With `grant` (default true) the grant is proposed (with `payouts` unless `payouts: null`), approved by the owner, the chain
 * brought to the granted state and the vault activated, so POST /api/payments works. `granted: false` stops after attach.
 */
export async function makeWorld({ pay = true, payouts = PAYOUTS(), grant = true, mandate = MANDATE, mutate } = {}) {
  const w = makeChain({ pay });
  const db = await memDb();
  await recordAttestation(db, registryAttestation());
  const artifactHash = registryAttestation().manifest.sha256;
  const fetchImpl = rpc(w);
  const app = createApp({ db, operatorToken: OPERATOR, fetchImpl, defer: () => {} });
  const api = apiClient(app);
  const world = { w, db, app, api, fetchImpl, artifactHash };
  const att = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'near-testnet', address: VAULT } });
  if (att.status !== 201) throw new Error(`attach ${att.status} ${att.text}`);
  world.vaultId = att.json.vaultId;
  world.propose = (over = {}) => api('/api/vault/mandates/propose', { method: 'POST', body: { chainId: 'near-testnet', vault: VAULT, agent: { account: AGENT }, mandate, templates: [{ artifactHash }], fund: { amount: '0' }, loop: { maxPerDay: 5 }, ...(payouts ? { payouts } : {}), ...over } });
  world.approve = (g) => api(`/api/decisions/${g.id}/approve`, { method: 'POST', body: { nonce: g.nonce, payloadHash: g.payload_hash, confirm: `approve ${g.id}`, signer: OWNER } });
  world.refresh = async () => (await import('../src/vault/index.js')).readVault(db, await (await import('../src/vault/index.js')).getVault(db, world.vaultId), { fetchImpl, force: true });
  world.activate = (g) => api('/api/vault/activate', { method: 'POST', body: { decisionId: g.id } });
  if (grant) {
    const p = await world.propose();
    if (p.status !== 201) throw new Error(`propose ${p.status} ${p.text}`);
    world.grant = p.json;
    const a = await world.approve(p.json);
    if (a.status !== 200) throw new Error(`approve ${a.status} ${a.text}`);
    w.applyGrant(p.json.payload);
    if (mutate) mutate(w, p.json.payload);
    world.activation = await world.activate(p.json);
  }
  world.pay = (body, o = {}) => apiClient(app)('/api/payments', { method: 'POST', body, ...o }); // fresh rate-limit bucket per call (writes are limited to 20/min per ip)
  return world;
}

/** An agent-run payment: a pay_testnet decision approved by the owner, then claimed under the vault's mandate (what the loop does in 2b-2). */
export async function approvedPayment(world, body = { token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42' }, { claim = true } = {}) {
  const { approveUnderMandate } = await import('../src/decisions.js');
  const { getVault } = await import('../src/vault/index.js');
  const r = await world.pay(body);
  if (r.status !== 201 && r.status !== 200) throw new Error(`payment ${r.status} ${r.text}`);
  const d = r.json;
  const a = await world.api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER } });
  if (a.status !== 200) throw new Error(`approve ${a.status} ${a.text}`);
  if (claim) { const vault = await getVault(world.db, world.vaultId); await approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true }); }
  return d;
}
