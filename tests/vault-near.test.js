// Offline tests for src/vault/near.js (NEAR adapter) and src/agent/near-admin.js. Every RPC is a mock (fetchImpl); the sandbox
// run lives in scripts/e2e-near-sandbox.mjs. The mocked transaction mirrors the SHAPE a real nearcore 2.13.4 returned
// (EXPERIMENTAL_tx_status: transaction, transaction_outcome, receipts_outcome, receipts; DeployContract in a receipt carries the
// 32-byte code HASH as base64), recorded once from the sandbox run, with a tiny stand-in wasm instead of the 210 KB registry.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adapter, depositForWasm, STORAGE_BYTE_COST, VAULT_WASM_PATH, REGISTRY_WASM_PATH, sha256Hex, validSubName } from '../src/vault/near.js';
import { enforceCall, normalizeLimits } from '../src/agent/limits.js';
import { defaultEncodeArgs, serializeTransaction, ed25519PublicKey, ed25519Signer, ed25519Verify, implicitAccountId, formatSecretKey } from '../src/agent/near-signer.js';
import * as admin from '../src/agent/near-admin.js';
import { base58, hexToBytes } from '../src/chains/common.js';
import { readFileSync, existsSync } from 'node:fs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const NEAR = 10n ** 24n;
const VAULT = 'vault.test.near'; const OWNER = 'owner.test.near'; const AGENT = 'ab'.repeat(32); const OTHER_AGENT = 'cd'.repeat(32);
const NAME = 'reg1'; const TARGET = `${NAME}.${VAULT}`;
const WASM = new Uint8Array(Buffer.from('\0asm-stand-in-registry-wasm-for-tests-'.repeat(20)));
const WASM_SHA = sha(WASM);
const manifest = { sha256: WASM_SHA, wasm: WASM };
const NET = { id: 'near-testnet', protocol: 'near', rpc: 'https://rpc.testnet.near.org', explorer: 'https://testnet.nearblocks.io/txns/', mainnet: false };
const approved = { action: 'deploy_testnet', protocol: 'near', network: 'near-testnet', registry: { owner: OWNER, proposer: AGENT, maxSpendCap: '0', contractAccount: TARGET } };
const TX = base58(new Uint8Array(createHash('sha256').update('tx').digest()));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ mock RPC
function makeWorld() {
  const exp = adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT });
  const w = {
    exp,
    block: { height: 1234, hash: 'BLOCKHASH', timestamp_nanosec: '1700000100000000000' },
    accounts: { [VAULT]: { amount: String(50n * NEAR), code_hash: '', storage_usage: 250000 }, [AGENT]: { amount: String(NEAR), code_hash: '11111111111111111111111111111111' }, [TARGET]: { amount: String(exp.deposit), code_hash: base58(hexToBytes(WASM_SHA)), storage_usage: 5000 } },
    keys: { [TARGET]: [], [VAULT]: [] },
    views: {
      [VAULT]: {
        config: { owner: OWNER, pending_owner: null, paused: false, network_id: 'testnet', epoch: '1', vault_id: VAULT, version: '1.0.0', reserve: String(NEAR) },
        mandate: { agent: AGENT, expires_at: '1700003600', per_draw_cap: String(NEAR), period_secs: '3600', period_cap: String(5n * NEAR), total_cap: String(20n * NEAR), max_deploys: 3, revoked: false, start: '1700000000', active: true },
        usage: { total_spent: '0', period_index: '0', period_spent: '0', deploys: 0 },
        available: String(45n * NEAR),
        templates: [{ id: WASM_SHA, label: 'registry-x', deposit: exp.deposit, init_args: exp.initMaterial, init_gas: '30000000000000' }],
        period_state: { period_index: '0', period_start: '1700000000', period_end: '1700003600', period_spent: '0', period_remaining: String(5n * NEAR), total_spent: '0', total_remaining: String(20n * NEAR), deploys: 0, deploys_remaining: 3, active: true },
        preview_draw: (a) => (BigInt(a.amount) > NEAR ? 'PerDrawCap' : ''),
        preview_deploy: () => '',
      },
      [TARGET]: { config: { owner_id: OWNER, proposer_id: AGENT, paused: false, network_id: 'testnet' } },
    },
    txs: {},
    calls: [],
  };
  w.accounts[VAULT].code_hash = base58(hexToBytes(sha('vault-build')));
  w.txs[TX] = goodTx(w);
  return w;
}

function goodTx(w, { name = NAME } = {}) {
  const target = `${name}.${VAULT}`;
  const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', version: '1.0.0', event, data })}`;
  const args = b64(JSON.stringify({ template: WASM_SHA, name, code: b64(WASM) }));
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: { signer_id: AGENT, public_key: 'ed25519:xx', nonce: 5, receiver_id: VAULT, hash: TX, actions: [{ FunctionCall: { method_name: 'deploy', args, gas: 300000000000000, deposit: '0' } }] },
    transaction_outcome: { id: TX, outcome: { executor_id: AGENT, logs: [], status: { SuccessReceiptId: 'R_DEPLOY' } } },
    receipts_outcome: [
      { id: 'R_DEPLOY', outcome: { executor_id: VAULT, logs: [ev('deployed', { agent: AGENT, template: WASM_SHA, name, target, deposit: w.exp.deposit, epoch: '1', deploys: 1, total_spent: w.exp.deposit, period_spent: w.exp.deposit })], status: { SuccessReceiptId: 'R_CB' } } },
      { id: 'R_BATCH', outcome: { executor_id: target, logs: ['EVENT_JSON:{"standard":"autonear_registry","version":"1.0.0","event":"initialized"}'], status: { SuccessValue: '' } } },
      { id: 'R_REFUND', outcome: { executor_id: AGENT, logs: [], status: { SuccessValue: '' } } },
      { id: 'R_CB', outcome: { executor_id: VAULT, logs: [ev('deploy_confirmed', { template: WASM_SHA, name, target })], status: { SuccessValue: '' } } },
    ],
    receipts: [
      { predecessor_id: AGENT, receiver_id: VAULT, receipt_id: 'R_DEPLOY', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'deploy', args, gas: 300000000000000, deposit: '0' } }] } } },
      { predecessor_id: VAULT, receiver_id: target, receipt_id: 'R_BATCH', receipt: { Action: { actions: ['CreateAccount', { Transfer: { deposit: w.exp.deposit } }, { DeployContract: { code: b64(hexToBytes(WASM_SHA)) } }, { FunctionCall: { method_name: 'new', args: b64(JSON.stringify(w.exp.initMaterial)), gas: 30000000000000, deposit: '0' } }] } } },
      { predecessor_id: 'system', receiver_id: AGENT, receipt_id: 'R_REFUND', receipt: { Action: { actions: [{ Transfer: { deposit: '1000' } }] } } },
      { predecessor_id: VAULT, receiver_id: VAULT, receipt_id: 'R_CB', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'on_deployed', args: 'e30=', gas: 10000000000000, deposit: '0' } }] } } },
    ],
  };
}

function rpc(w) {
  return async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    w.calls.push({ method, params });
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    const err = (data) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error', data } }), { status: 200 });
    if (method === 'block') return ok({ header: w.block });
    if (method === 'EXPERIMENTAL_tx_status' || method === 'tx') {
      const t = w.txs[params.tx_hash];
      if (!t) return err(`Transaction ${params.tx_hash} doesn't exist`);
      if (method === 'tx' && w.txNoReceipts) { const { receipts: _r, ...rest } = t; return ok(rest); }
      return ok(t);
    }
    if (method === 'query') {
      if (params.request_type === 'view_account') { const a = w.accounts[params.account_id]; return a ? ok({ code_hash: '11111111111111111111111111111111', storage_usage: 100, ...a }) : err(`account ${params.account_id} does not exist while viewing`); }
      if (params.request_type === 'view_access_key_list') return ok({ keys: w.keys[params.account_id] ?? [] });
      if (params.request_type === 'call_function') {
        const v = w.views[params.account_id]?.[params.method_name];
        if (v === undefined) return err(`method ${params.method_name} not found on ${params.account_id}`);
        const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const val = typeof v === 'function' ? v(args) : v;
        return ok({ result: Array.from(Buffer.from(JSON.stringify(val))), logs: [], block_height: 1 });
      }
    }
    return err(`unmocked ${method}`);
  };
}
const verify = (w, over = {}) => adapter.verifyDeploy({ net: NET, txHash: TX, vault: VAULT, agent: AGENT, decision: { payload: JSON.stringify(approved) }, manifest, expected: { ...w.exp, name: NAME }, fetchImpl: rpc(w), ...over });
const failedOf = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

// ------------------------------------------------------------------ interface shape
describe('interface (docs/agent-vault-spec.md, Phase 2)', () => {
  test('exports the binding adapter members', () => {
    assert.equal(adapter.chain, 'near');
    assert.deepEqual(adapter.unit, { symbol: 'NEAR', base: 'yoctoNEAR', decimals: 24 });
    for (const f of ['readState', 'verifyVaultCode', 'expectedTemplate', 'buildCall', 'verifyDeploy', 'explorerTx', 'explorerAddress']) assert.equal(typeof adapter[f], 'function', f);
  });
  test('buildCall output is accepted by the signer limits and encodes to the vault ABI', () => {
    const limits = normalizeLimits('near', { maxFeePerTx: 1n, allowedTargets: [VAULT] });
    const d = adapter.buildCall('draw', { vault: VAULT, amount: 5n * NEAR });
    assert.deepEqual(d, { method: 'draw', target: VAULT, args: { amount: String(5n * NEAR) } });
    assert.equal(enforceCall('near', d, limits), VAULT);
    assert.deepEqual(defaultEncodeArgs('draw', d.args), { amount: String(5n * NEAR) });
    const dep = adapter.buildCall('deploy', { vault: VAULT, template: WASM_SHA, code: WASM, nameOrSalt: 'reg1' });
    assert.equal(enforceCall('near', dep, limits), VAULT);
    assert.deepEqual(Object.keys(dep).sort(), ['args', 'method', 'target']);
    assert.deepEqual(defaultEncodeArgs('deploy', dep.args), { template: WASM_SHA, name: 'reg1', code: b64(WASM) });
  });
  test('buildCall refuses bad input before anything can be signed', () => {
    assert.throws(() => adapter.buildCall('draw', { vault: VAULT, amount: 0n }), /positive/);
    assert.throws(() => adapter.buildCall('draw', { vault: VAULT, amount: 'abc' }), /positive/);
    assert.throws(() => adapter.buildCall('draw', { vault: 'BAD', amount: 1n }), /vault/);
    assert.throws(() => adapter.buildCall('deploy', { vault: VAULT, template: WASM_SHA, code: new Uint8Array([1, 2, 3]), nameOrSalt: 'reg1' }), /CodeMismatch/);
    assert.throws(() => adapter.buildCall('deploy', { vault: VAULT, template: 'zz', code: WASM, nameOrSalt: 'reg1' }), /64-hex/);
    for (const bad of ['a.b', 'A', '-a', 'a--b', '', 'x'.repeat(33)]) assert.throws(() => adapter.buildCall('deploy', { vault: VAULT, template: WASM_SHA, code: WASM, nameOrSalt: bad }), /name/, bad);
    assert.throws(() => adapter.buildCall('upgrade', { vault: VAULT }), /unknown kind/);
  });
  test('name grammar mirrors the contract', () => {
    for (const ok of ['a', 'reg1', 'a-b_c', 'x'.repeat(32), '1a']) assert.equal(validSubName(ok), true, ok);
    for (const bad of ['', 'a.b', 'A', '-a', 'a-', 'a--b', 'a_-b', 'x'.repeat(33), 'a b']) assert.equal(validSubName(bad), false, bad);
  });
  test('explorer helpers (testnet) and empty for a local network', () => {
    assert.equal(adapter.explorerTx(NET, 'HASH'), 'https://testnet.nearblocks.io/txns/HASH');
    assert.equal(adapter.explorerAddress(NET, VAULT), `https://testnet.nearblocks.io/address/${VAULT}`);
    assert.equal(adapter.explorerTx({ rpc: 'http://127.0.0.1:1', explorer: '' }, 'H'), '');
    assert.equal(adapter.explorerAddress({ rpc: 'http://127.0.0.1:1', explorer: '' }, 'a'), '');
  });
});

// ------------------------------------------------------------------ expectedTemplate
describe('expectedTemplate (local computation from attestation + approved payload)', () => {
  test('template id = sha256 of the attested wasm; init material = the registry `new` args; nothing from chain', () => {
    const e = adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT });
    assert.equal(e.templateId, WASM_SHA);
    assert.deepEqual(e.code, WASM);
    assert.deepEqual(e.initMaterial, { network_id: 'testnet', owner_id: OWNER, proposer_id: AGENT });
    assert.equal(e.initArgsJson, '{"network_id":"testnet","owner_id":"owner.test.near","proposer_id":"' + AGENT + '"}');
    assert.equal(e.label, `registry-${WASM_SHA.slice(0, 8)}`);
    assert.deepEqual(e.allowTemplateArgs, { template_id: WASM_SHA, label: e.label, deposit: e.deposit, init_args: e.initMaterial, init_gas: '30000000000000' });
    assert.equal(typeof e.deposit, 'string');
  });
  test('max_spend_cap only when the approved payload has a positive cap (registry rejects 0)', () => {
    const e = adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, maxSpendCap: '1000' } } });
    assert.equal(e.initMaterial.max_spend_cap, '1000');
    assert.ok(!('max_spend_cap' in adapter.expectedTemplate({ manifest, payload: approved }).initMaterial));
  });
  test('a grant_mandate payload with templates[] initMaterial is honoured; a disagreeing registry block is refused', () => {
    const gm = { kind: 'grant_mandate', templates: [{ templateId: WASM_SHA, label: 'reg-v9', deposit: String(10n * NEAR), initMaterial: { owner_id: OWNER, proposer_id: AGENT, network_id: 'testnet' } }] };
    const e = adapter.expectedTemplate({ manifest, payload: gm });
    assert.equal(e.label, 'reg-v9'); assert.equal(e.deposit, String(10n * NEAR));
    assert.throws(() => adapter.expectedTemplate({ manifest, payload: { ...gm, registry: { owner: OTHER_AGENT, proposer: AGENT } } }), /disagrees/);
    assert.throws(() => adapter.expectedTemplate({ manifest, payload: { ...gm, templates: [{ ...gm.templates[0], deposit: '5' }] } }), /below the storage minimum/);
  });
  test('refuses: wasm that does not match the attestation, missing owner/proposer, bad sha, oversized label', () => {
    assert.throws(() => adapter.expectedTemplate({ manifest: { sha256: '0'.repeat(64), wasm: WASM }, payload: approved }), /does not match the attestation/);
    assert.throws(() => adapter.expectedTemplate({ manifest: { sha256: 'xyz', wasm: WASM }, payload: approved }), /64-hex/);
    assert.throws(() => adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { proposer: AGENT } } }), /owner and registry.proposer/);
    assert.throws(() => adapter.expectedTemplate({ manifest, payload: approved, label: 'x'.repeat(65) }), /label/);
  });
  test('network id: near-testnet -> testnet, explicit registry.networkId wins', () => {
    assert.equal(adapter.expectedTemplate({ manifest, payload: approved }).initMaterial.network_id, 'testnet');
    assert.equal(adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, networkId: 'localnet' } } }).initMaterial.network_id, 'localnet');
  });
  test('deposit sizing: registry 210,822 bytes -> minimum 2.109 NEAR, deposit 3.8 NEAR, monotonic, rounded up to 0.1 NEAR', () => {
    const { minimum, deposit } = depositForWasm(210_822);
    assert.equal(minimum, (210_822n + 100n) * STORAGE_BYTE_COST);
    assert.equal(deposit, 38n * 10n ** 23n);
    assert.ok(deposit > minimum);
    assert.equal(depositForWasm(1000).deposit % (10n ** 23n), 0n);
    assert.ok(depositForWasm(300_000).deposit > depositForWasm(210_822).deposit);
  });
  test('the real attested registry wasm (when built) gets the documented 3.8 NEAR', { skip: existsSync(REGISTRY_WASM_PATH) ? false : 'registry wasm not built' }, () => {
    const real = new Uint8Array(readFileSync(REGISTRY_WASM_PATH));
    const e = adapter.expectedTemplate({ manifest: { sha256: sha(real) }, payload: approved });
    assert.equal(e.templateId, sha(real));
    assert.equal(e.deposit, String(38n * 10n ** 23n));
    assert.ok(BigInt(e.deposit) > BigInt(e.minDeposit));
  });
});

// ------------------------------------------------------------------ readState / verifyVaultCode
describe('readState', () => {
  test('maps every view, pins one block, returns decimal strings for money and numbers for time/counters', async () => {
    const w = makeWorld();
    const s = await adapter.readState({ net: NET, vault: VAULT, now: 1700000200, fetchImpl: rpc(w), previews: { draw: ['5', String(2n * NEAR)], deploy: [{ template: WASM_SHA, name: 'reg1' }] } });
    assert.deepEqual(s.config, { owner: OWNER, pendingOwner: null, paused: false, networkId: 'testnet', epoch: 1, vaultId: VAULT, version: '1.0.0', reserve: String(NEAR) });
    assert.equal(s.mandate.agent, AGENT); assert.equal(s.mandate.perDrawCap, String(NEAR)); assert.equal(s.mandate.maxDeploys, 3); assert.equal(s.mandate.expiresAt, 1700003600); assert.equal(s.mandate.active, true);
    assert.deepEqual(s.usage, { totalSpent: '0', periodSpent: '0', deploys: 0, periodIndex: 0 });
    assert.equal(s.available, String(45n * NEAR));
    assert.equal(s.templates.length, 1); assert.equal(s.templates[0].id, WASM_SHA); assert.equal(s.templates[0].deposit, w.exp.deposit);
    assert.equal(s.agentBalance, String(NEAR)); assert.equal(s.blockTime, 1700000100); assert.equal(s.blockHeight, 1234);
    assert.equal(s.period.remaining, String(5n * NEAR));
    assert.deepEqual(s.previews, { draw: { 5: '', [String(2n * NEAR)]: 'PerDrawCap' }, deploy: { [`${WASM_SHA}:reg1`]: '' } });
    assert.doesNotThrow(() => JSON.stringify(s));
    const queries = w.calls.filter((c) => c.method === 'query');
    assert.ok(queries.every((q) => q.params.block_id === 1234), 'all views pinned to the same block');
    assert.equal(queries.find((q) => q.params.method_name === 'period_state').params.args_base64, Buffer.from(JSON.stringify({ now: '1700000200' })).toString('base64'));
  });
  test('no mandate -> mandate null, agentBalance null; missing agent account -> "0" and agentExists false', async () => {
    let w = makeWorld(); w.views[VAULT].mandate = null; w.views[VAULT].period_state = null;
    let s = await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) });
    assert.equal(s.mandate, null); assert.equal(s.agentBalance, null); assert.equal(s.period, null);
    w = makeWorld(); delete w.accounts[AGENT];
    s = await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) });
    assert.equal(s.agentBalance, '0'); assert.equal(s.agentExists, false);
  });
  test('an RPC failure is thrown (the caller treats it as readError), not swallowed', async () => {
    const w = makeWorld(); delete w.views[VAULT].usage;
    await assert.rejects(adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) }), /usage/);
  });
});

describe('verifyVaultCode', () => {
  const vsha = sha('vault-build');
  test('accepts when on-chain hash == base58(sha256(attested)); attested may be hex, manifest or bytes', async () => {
    const w = makeWorld();
    for (const attested of [vsha, { sha256: vsha }, { wasmSha256: vsha }, new Uint8Array(Buffer.from('vault-build'))]) {
      const r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested, fetchImpl: rpc(w) });
      assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    }
  });
  test('refuses a different build, a vault_id that is not this account, and an account without the contract', async () => {
    const w = makeWorld();
    let r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: sha('other-build'), fetchImpl: rpc(w) });
    assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /code hash/.test(n)));
    w.views[VAULT].config.vault_id = 'evil.near';
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: vsha, fetchImpl: rpc(w) });
    assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /vault_id/.test(n)));
    r = await adapter.verifyVaultCode({ net: NET, vault: 'nobody.test.near', attested: vsha, fetchImpl: rpc(makeWorld()) });
    assert.equal(r.ok, false);
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: 'not-hex', fetchImpl: rpc(makeWorld()) });
    assert.equal(r.ok, false);
  });
  test('reports vault full-access keys as INFO (never a silent pass of the question), locked vault says so', async () => {
    const w = makeWorld(); w.keys[VAULT] = [{ public_key: 'ed25519:KEY', access_key: { nonce: 0, permission: 'FullAccess' } }];
    let r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: vsha, fetchImpl: rpc(w) });
    assert.ok(r.checks.some((c) => c.info && /ed25519:KEY/.test(c.detail)));
    w.keys[VAULT] = [];
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: vsha, fetchImpl: rpc(w) });
    assert.ok(r.checks.some((c) => c.info && /locked/.test(c.detail)));
  });
  test('default attested = contracts/near-vault/dist/autonear_vault.wasm', { skip: existsSync(VAULT_WASM_PATH) ? false : 'vault wasm not built' }, async () => {
    const w = makeWorld(); w.accounts[VAULT].code_hash = base58(hexToBytes(sha256Hex(readFileSync(VAULT_WASM_PATH))));
    assert.equal((await adapter.verifyVaultCode({ net: NET, vault: VAULT, fetchImpl: rpc(w) })).ok, true);
  });
});

// ------------------------------------------------------------------ verifyDeploy
describe('verifyDeploy: transaction-level proof', () => {
  test('a correct deploy passes every check (name taken from expected, or derived from the approved contractAccount)', async () => {
    const w = makeWorld();
    let r = await verify(w);
    assert.equal(r.ok, true, JSON.stringify(failedOf(r))); assert.equal(r.account, TARGET); assert.ok(r.checks.length >= 25);
    r = await verify(w, { expected: undefined });
    assert.equal(r.ok, true, JSON.stringify(failedOf(r)));
  });
  test('works with a node that only has `tx` with receipts, and with the older receipt view that carries the full code', async () => {
    const w = makeWorld(); w.txs[TX].receipts[1].receipt.Action.actions[2] = { DeployContract: { code: b64(WASM) } };
    assert.equal((await verify(w)).ok, true);
  });
  test('wrong signer', async () => {
    const w = makeWorld(); w.txs[TX].transaction.signer_id = OTHER_AGENT;
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('signer == the agent'));
    const r2 = await verify(makeWorld(), { agent: OTHER_AGENT }); assert.equal(r2.ok, false);
  });
  test('wrong receiver', async () => {
    const w = makeWorld(); w.txs[TX].transaction.receiver_id = 'evil.test.near';
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('receiver == the vault'));
  });
  test('wrong method (a draw) and extra actions', async () => {
    let w = makeWorld(); w.txs[TX].transaction.actions[0].FunctionCall.method_name = 'draw';
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /exactly one action/.test(n)));
    w = makeWorld(); w.txs[TX].transaction.actions.push({ Transfer: { deposit: '1' } });
    r = await verify(w); assert.equal(r.ok, false);
    w = makeWorld(); w.txs[TX].transaction.actions[0].FunctionCall.deposit = '1';
    r = await verify(w); assert.equal(r.ok, false);
  });
  test('failed callback result: callback receipt Failure', async () => {
    const w = makeWorld(); w.txs[TX].receipts_outcome.find((o) => o.id === 'R_CB').outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: boom' } } } } };
    w.txs[TX].status = { Failure: { ActionError: { index: 0, kind: {} } } };
    const r = await verify(w); assert.equal(r.ok, false);
    assert.ok(failedOf(r).includes('on_deployed callback executed successfully')); assert.ok(failedOf(r).some((n) => /no failed receipt/.test(n)));
  });
  test('failed BATCH while the callback handled it (top-level SuccessValue!): deploy_failed is refused', async () => {
    const w = makeWorld();
    const t = w.txs[TX];
    t.receipts_outcome.find((o) => o.id === 'R_BATCH').outcome.status = { Failure: { ActionError: { index: null, kind: { LackBalanceForState: { account_id: TARGET, amount: '1' } } } } };
    const cb = t.receipts_outcome.find((o) => o.id === 'R_CB');
    cb.outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', version: '1.0.0', event: 'deploy_failed', data: { template: WASM_SHA, name: NAME, target: TARGET, deposit: w.exp.deposit, epoch: '1', reversed: true } })}`];
    delete w.accounts[TARGET];
    const r = await verify(w);
    assert.equal(t.status.SuccessValue, '', 'premise: the top-level status looks fine');
    assert.equal(r.ok, false);
    for (const re of [/no failed receipt/, /batch receipt executed successfully/, /deploy_confirmed/, /no `deploy_failed`/, /sub-account exists/]) assert.ok(failedOf(r).some((n) => re.test(n)), String(re));
  });
  test('a forged `deploy_confirmed` printed by the DEPLOYED contract (not the vault) does not count', async () => {
    const w = makeWorld(); const t = w.txs[TX];
    const confirmed = t.receipts_outcome.find((o) => o.id === 'R_CB').outcome.logs;
    t.receipts_outcome.find((o) => o.id === 'R_CB').outcome.logs = [];
    t.receipts_outcome.find((o) => o.id === 'R_BATCH').outcome.logs.push(...confirmed);
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /deploy_confirmed/.test(n)));
  });
  test('missing callback receipt', async () => {
    const w = makeWorld(); w.txs[TX].receipts = w.txs[TX].receipts.filter((x) => x.receipt_id !== 'R_CB');
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('on_deployed callback receipt present'));
  });
  test('sub-account with an access key (full access or function call) is refused', async () => {
    for (const permission of ['FullAccess', { FunctionCall: { allowance: null, receiver_id: 'x', method_names: [] } }]) {
      const w = makeWorld(); w.keys[TARGET] = [{ public_key: 'ed25519:K', access_key: { nonce: 0, permission } }];
      const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('sub-account has NO access keys (immutable)'));
    }
  });
  test('wrong code hash on the sub-account', async () => {
    const w = makeWorld(); w.accounts[TARGET].code_hash = base58(hexToBytes(sha('something else')));
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('sub-account code hash == attested wasm sha256'));
  });
  test('wrong code in the deploy args or in the batch DeployContract', async () => {
    let w = makeWorld(); const fc = w.txs[TX].transaction.actions[0].FunctionCall;
    fc.args = b64(JSON.stringify({ template: WASM_SHA, name: NAME, code: b64(Buffer.from('evil')) }));
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('deploy code sha256 == attested wasm sha256'));
    w = makeWorld(); w.txs[TX].receipts[1].receipt.Action.actions[2] = { DeployContract: { code: b64(hexToBytes(sha('evil'))) } };
    r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /batch DeployContract/.test(n)));
  });
  test('wrong owner / proposer on the deployed registry', async () => {
    let w = makeWorld(); w.views[TARGET].config.owner_id = 'attacker.near';
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('registry owner == approved owner'));
    w = makeWorld(); w.views[TARGET].config.proposer_id = 'attacker.near';
    r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('registry proposer == approved proposer'));
  });
  test('init material sent in `new` differs from the approved one (owner swapped by the vault template)', async () => {
    const w = makeWorld(); w.txs[TX].receipts[1].receipt.Action.actions[3].FunctionCall.args = b64(JSON.stringify({ ...w.exp.initMaterial, owner_id: 'attacker.near' }));
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /exactly the owner-fixed init material/.test(n)));
  });
  test('batch with an AddKey / extra action, or a different deposit', async () => {
    let w = makeWorld(); w.txs[TX].receipts[1].receipt.Action.actions.push({ AddKey: { public_key: 'ed25519:K', access_key: { nonce: 0, permission: 'FullAccess' } } });
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /batch is exactly/.test(n)));
    w = makeWorld(); w.txs[TX].receipts[1].receipt.Action.actions[1] = { Transfer: { deposit: '1' } };
    r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /Transfer deposit/.test(n)));
  });
  test('tampered name: tx deployed another name than expected / than the approved contractAccount', async () => {
    let w = makeWorld(); w.txs[TX] = goodTx(w, { name: 'sneaky' }); w.accounts['sneaky.' + VAULT] = w.accounts[TARGET]; w.views['sneaky.' + VAULT] = w.views[TARGET]; w.keys['sneaky.' + VAULT] = [];
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('deploy name == expected name'));
    r = await verify(w, { expected: { ...w.exp, name: 'sneaky' } });
    assert.equal(r.ok, false); assert.ok(failedOf(r).includes('deployed account is the approved contractAccount'), 'approved contractAccount says reg1');
    r = await verify(makeWorld(), { expected: { ...w.exp, name: 'other' } }); assert.equal(r.ok, false);
  });
  test('wrong template id in the args / expectation that disagrees with the attestation', async () => {
    let w = makeWorld(); w.txs[TX].transaction.actions[0].FunctionCall.args = b64(JSON.stringify({ template: sha('x'), name: NAME, code: b64(WASM) }));
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('deploy template == expected template id'));
    w = makeWorld();
    r = await verify(w, { manifest: { sha256: sha('another build'), wasm: WASM } }); assert.equal(r.ok, false);
    r = await verify(w, { expected: { ...w.exp, templateId: sha('bogus') } }); assert.equal(r.ok, false);
  });
  test('not finalized, hash mismatch, unknown tx, RPC error, mainnet, bad hash, no name known: all fail closed without throwing', async () => {
    let w = makeWorld(); w.txs[TX].final_execution_status = 'EXECUTED_OPTIMISTIC';
    let r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('tx finalized'));
    w = makeWorld(); w.txs[TX].transaction.hash = 'SOMETHINGELSE';
    assert.equal((await verify(w)).ok, false);
    r = await verify(makeWorld(), { txHash: base58(new Uint8Array(32).fill(7)) }); assert.equal(r.ok, false);
    r = await verify(makeWorld(), { fetchImpl: async () => { throw new TypeError('network down'); } }); assert.equal(r.ok, false);
    r = await verify(makeWorld(), { net: { ...NET, mainnet: true } }); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('mainnet is blocked'));
    r = await verify(makeWorld(), { txHash: '0xabc' }); assert.equal(r.ok, false);
    r = await verify(makeWorld(), { expected: undefined, decision: { payload: JSON.stringify({ ...approved, registry: { ...approved.registry, contractAccount: undefined } }) } });
    assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /sub-account name is known/.test(n)));
  });
  test('failed top-level tx (e.g. E_CodeMismatch panic) is refused', async () => {
    const w = makeWorld(); const t = w.txs[TX];
    t.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_CodeMismatch: code hash' } } } } };
    t.receipts_outcome = [{ id: 'R_DEPLOY', outcome: { executor_id: VAULT, logs: [], status: t.status } }];
    t.receipts = t.receipts.slice(0, 1);
    const r = await verify(w); assert.equal(r.ok, false); assert.ok(failedOf(r).includes('top-level tx status is SuccessValue'));
  });
  test('the decision may be passed as the DB row (payload JSON string) or as the payload object', async () => {
    const w = makeWorld();
    assert.equal((await verify(w, { decision: { id: 'dec_1', payload: JSON.stringify(approved) } })).ok, true);
    assert.equal((await verify(w, { decision: approved })).ok, true);
  });
});

// ------------------------------------------------------------------ near-admin
describe('near-admin serialisation', () => {
  const h2b = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  const hx = (b) => Buffer.from(b).toString('hex');
  // VECTOR PROVENANCE: generated with nearcore's own Rust crates near-primitives 0.34.7 / near-crypto 0.34.7 (borsh 1.x), offline from the
  // local cargo registry, in a throwaway crate: Transaction::V0 { signer_id = hex(pubkey), nonce 9, receiver_id vault.test.near, block_hash 00..1f,
  // actions = [CreateAccount, Transfer 3 NEAR, DeployContract(11 bytes), FunctionCall new {"owner_id":"o.test.near"} 30 Tgas 7 yocto,
  // AddKey FullAccess, AddKey FunctionCall(allowance 1000, vault.test.near, [draw, deploy]) nonce 5, AddKey FunctionCall(no allowance, x.near, []), DeleteKey] },
  // SecretKey::ED25519(RFC 8032 test-1 seed||pub), the second key = PublicKey::from_seed(ED25519, "second"). NOT a hand derivation.
  const KEY2 = 'ed25519:GiRfWWQn1hAm629EDYo3HUsFmSy98MAzTTZEfJxVXguF';
  const TX_BORSH = '400000006437356139383031383262313061623764353462666564336339363430373361306565313732663364616136323332356166303231613638663730373531316100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a09000000000000000f0000007661756c742e746573742e6e656172000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f080000000003000000e3c8666c53467b020000000000010b0000000061736d0100000009080702030000006e65771a0000007b226f776e65725f6964223a226f2e746573742e6e656172227d00e057eb481b0000070000000000000000000000000000000500e97c01328c890e2a371af7b3a5aa0f7fc06d18418025826ecd1cea7de6827e620000000000000000010500e97c01328c890e2a371af7b3a5aa0f7fc06d18418025826ecd1cea7de6827e6205000000000000000001e80300000000000000000000000000000f0000007661756c742e746573742e6e656172020000000400000064726177060000006465706c6f790500e97c01328c890e2a371af7b3a5aa0f7fc06d18418025826ecd1cea7de6827e620000000000000000000006000000782e6e656172000000000600e97c01328c890e2a371af7b3a5aa0f7fc06d18418025826ecd1cea7de6827e62';
  const TX_HASH = 'a6b52b630363179776575307ac0ee943b4b90e375bfeb7c9141a4ae3656d3ef1';
  const SIG = '008a9ace8fda737103e94a8de79bf09a9312355d969884def70d65df49139d2d42a064d003146f35608065ec9765f8f61702587e958a8209ea5d8bfa07f9117d02';
  const seed = h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pub = ed25519PublicKey(seed);
  const tx = () => ({
    signerId: implicitAccountId(pub), publicKey: pub, nonce: 9n, receiverId: 'vault.test.near', blockHash: Uint8Array.from({ length: 32 }, (_, i) => i),
    actions: [
      admin.createAccount(), admin.transfer(3n * NEAR), admin.deployContract(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 9, 8, 7)),
      admin.functionCall('new', '{"owner_id":"o.test.near"}', 30n * 10n ** 12n, 7n),
      admin.addKey(KEY2, 'FullAccess'),
      admin.addKey(KEY2, { receiverId: 'vault.test.near', methodNames: ['draw', 'deploy'], allowance: 1000n }, 5n),
      admin.addKey(KEY2, { receiverId: 'x.near', methodNames: [] }),
      admin.deleteKey(KEY2),
    ],
  });
  test('Transaction bytes, sha256 hash, signature and SignedTransaction bytes equal the near-primitives 0.34.7 vector (8 actions)', () => {
    const out = admin.signAdminTransaction(tx(), ed25519Signer(seed));
    assert.equal(hx(out.txBytes), TX_BORSH);
    assert.equal(hx(out.hash), TX_HASH);
    assert.equal('00' + hx(out.signature), SIG);
    assert.equal(hx(out.signedBytes), TX_BORSH + SIG);
    assert.equal(ed25519Verify(pub, out.hash, out.signature), true);
  });
  test('FunctionCall + Transfer bytes are identical to near-signer.js serializeTransaction (one layout, two writers)', () => {
    const t = { ...tx(), actions: [admin.functionCall('draw', '{"amount":"1"}', 30_000_000_000_000n, 0n), admin.transfer(NEAR)] };
    assert.equal(hx(admin.serializeAdminTransaction(t)), hx(serializeTransaction(t)));
  });
  test('rejects what it must not sign: Stake / DeleteAccount, bad sizes, bad permission', () => {
    assert.throws(() => admin.serializeAdminTransaction({ ...tx(), actions: [{ kind: 'DeleteAccount' }] }), /not supported by near-admin/);
    assert.throws(() => admin.serializeAdminTransaction({ ...tx(), actions: [{ kind: 'Stake' }] }), /not supported/);
    assert.throws(() => admin.serializeAdminTransaction({ ...tx(), blockHash: new Uint8Array(31) }), /32 bytes/);
    assert.throws(() => admin.serializeAdminTransaction({ ...tx(), actions: [admin.transfer(1n << 128n)] }), /u128/);
    assert.throws(() => admin.serializeAdminTransaction({ ...tx(), actions: [admin.addKey(KEY2, { nope: 1 })] }), /permission/);
    assert.throws(() => admin.deployContract(new Uint8Array(0)), /non-empty/);
  });
  test('createNearAdmin: refuses a non-test chain_id and signs with the given key (mock RPC)', async () => {
    const sk = formatSecretKey(seed);
    const mk = (chainId, sent = []) => admin.createNearAdmin({
      rpcUrl: 'http://127.0.0.1:3030', accountId: implicitAccountId(pub), secretKey: sk, networkId: 'localnet', pollMs: 1, sleep: async () => {},
      fetchImpl: async (_u, init) => {
        const { method, params, id } = JSON.parse(init.body);
        const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
        if (method === 'status') return ok({ chain_id: chainId });
        if (method === 'query') return ok({ nonce: 41, block_hash: base58(new Uint8Array(32).fill(3)), permission: 'FullAccess' });
        if (method === 'send_tx') { sent.push(params); return ok({ final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { outcome: { status: { SuccessReceiptId: 'x' }, tokens_burnt: '1', gas_burnt: 1 } }, receipts_outcome: [] }); }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'unmocked ' + method } }));
      },
    });
    await assert.rejects(mk('mainnet').transfer('a.near', 1n), /not the configured test network/);
    await assert.rejects(mk('testnet').transfer('a.near', 1n), /not the configured test network/, 'configured networkId is localnet');
    const sent = [];
    const a = mk('localnet', sent);
    const r = await a.createSubAccount('x.' + implicitAccountId(pub), KEY2, NEAR);
    assert.equal(r.ok, true); assert.equal(r.nonce, 42n);
    const raw = Buffer.from(sent[0].signed_tx_base64, 'base64');
    assert.equal(raw.length > 100, true);
    assert.equal(sent[0].wait_until, 'FINAL');
    assert.ok(JSON.stringify(a).indexOf(sk) === -1 && !String(Object.keys(a)).includes('secret'), 'secret key is not reachable from the handle');
  });
});

// ------------------------------------------------------------------ extensions used by src/vault/index.js + src/autonomy.js
describe('adapter extensions (VAULT_REQUIRED_LOOP)', () => {
  const REQUIRED = ['readState', 'verifyVaultCode', 'expectedTemplate', 'buildCall', 'verifyDeploy', 'explorerTx', 'explorerAddress', 'preview', 'estimateFee', 'signerOptions', 'deployTarget'];
  test('exposes every method the core demands, plus attested', () => {
    for (const m of REQUIRED) assert.equal(typeof adapter[m], 'function', m);
    assert.equal(typeof adapter.planSteps, 'function');
    assert.ok('attested' in adapter && 'sha256' in adapter.attested);
  });
  test('readState: agent argument wins for agentBalance; blockTag / blockNumber = the pinned height', async () => {
    const w = makeWorld(); w.accounts[OTHER_AGENT] = { amount: '777' };
    const s = await adapter.readState({ net: NET, vault: VAULT, agent: OTHER_AGENT, fetchImpl: rpc(w) });
    assert.equal(s.agentBalance, '777'); assert.equal(s.blockTag, 1234); assert.equal(s.blockNumber, 1234);
    w.views[VAULT].mandate = null; w.views[VAULT].period_state = null;
    assert.equal((await adapter.readState({ net: NET, vault: VAULT, agent: OTHER_AGENT, fetchImpl: rpc(w) })).agentBalance, '777', 'works without a mandate too');
  });
  test('preview(kind, ...) returns the chain error code name, at the requested block', async () => {
    const w = makeWorld();
    assert.equal(await adapter.preview('draw', { net: NET, vault: VAULT, amount: '5', block: 1234, fetchImpl: rpc(w) }), '');
    assert.equal(await adapter.preview('draw', { net: NET, vault: VAULT, amount: String(2n * NEAR), fetchImpl: rpc(w) }), 'PerDrawCap');
    assert.equal(await adapter.preview('deploy', { net: NET, vault: VAULT, template: WASM_SHA, nameOrSalt: 'reg1', block: 1234, fetchImpl: rpc(w) }), '');
    const q = w.calls.filter((c) => c.method === 'query' && /preview/.test(c.params.method_name));
    assert.equal(q[0].params.block_id, 1234); assert.equal(q[1].params.finality, 'final'); assert.equal(q[2].params.block_id, 1234);
    assert.equal(JSON.parse(Buffer.from(q[2].params.args_base64, 'base64').toString()).name, 'reg1');
    await assert.rejects(adapter.preview('upgrade', { net: NET, vault: VAULT, fetchImpl: rpc(w) }), /unknown kind/);
  });
  test('estimateFee = attached gas x gas_price x 1.5 (the signer\'s own bound); signerOptions pins the same gas', async () => {
    const w = makeWorld();
    const f = (async (u, init) => { const b = JSON.parse(init.body); return b.method === 'gas_price' ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { gas_price: '100000000' } })) : rpc(w)(u, init); });
    const e = await adapter.estimateFee({ net: NET, vault: VAULT, agent: AGENT, call: adapter.buildCall('deploy', { vault: VAULT, template: WASM_SHA, code: WASM, nameOrSalt: 'a' }), fetchImpl: f });
    assert.equal(e.worstCaseFee, 300n * 10n ** 12n * 10n ** 8n * 3n / 2n);
    const d = await adapter.estimateFee({ net: NET, vault: VAULT, agent: AGENT, call: adapter.buildCall('draw', { vault: VAULT, amount: 1n }), fetchImpl: f });
    assert.equal(d.worstCaseFee, 50n * 10n ** 12n * 10n ** 8n * 3n / 2n);
    const o = adapter.signerOptions({ net: NET, extra: { pollMs: 5 } });
    assert.deepEqual(o.gas, { draw: String(50n * 10n ** 12n), deploy: String(300n * 10n ** 12n) });
    assert.equal(o.networkId, 'testnet'); assert.equal(o.rpcUrl, NET.rpc); assert.equal(o.role, 'launch'); assert.equal(o.pollMs, 5);
    assert.equal(adapter.signerOptions({ net: { rpc: 'http://127.0.0.1:1', local: true } }).networkId, 'localnet');
    assert.equal(adapter.signerOptions({ net: { rpc: 'http://127.0.0.1:1', networkId: 'sandbox' } }).networkId, 'sandbox');
    await assert.rejects(adapter.estimateFee({ net: NET, call: { method: 'withdraw' }, fetchImpl: f }), /unknown method/);
  });
  test('expectedTemplate refuses a contractAccount that is not <name>.<vault> (the vault cannot deploy anywhere else) and returns the name', () => {
    const e = adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT });
    assert.equal(e.name, NAME);
    for (const ca of ['registry.you.testnet', `a.b.${VAULT}`, `Bad.${VAULT}`, VAULT, 'reg1.other.test.near']) {
      assert.throws(() => adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, contractAccount: ca } }, vault: VAULT }), /not <name>|can only deploy/, ca);
    }
    assert.equal(adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, contractAccount: undefined } }, vault: VAULT }).name, null, 'a grant_mandate-time call has no account yet');
  });
  test('deployTarget: name from the approved contractAccount; derived deterministic name otherwise; never an invalid one', () => {
    const t = adapter.deployTarget({ decision: { id: 'dec_1', payload: JSON.stringify(approved) }, vault: VAULT, expected: adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT }) });
    assert.deepEqual(t, { nameOrSalt: 'reg1', predicted: TARGET });
    const none = { ...approved, registry: { ...approved.registry, contractAccount: undefined } };
    const d1 = adapter.deployTarget({ decision: { id: 'dec_1', payload: JSON.stringify(none) }, vault: VAULT });
    const d2 = adapter.deployTarget({ decision: { id: 'dec_1', payload: JSON.stringify(none) }, vault: VAULT });
    assert.deepEqual(d1, d2); assert.ok(validSubName(d1.nameOrSalt) && d1.predicted === `${d1.nameOrSalt}.${VAULT}`);
    assert.notEqual(adapter.deployTarget({ decision: { id: 'dec_2', payload: JSON.stringify(none) }, vault: VAULT }).nameOrSalt, d1.nameOrSalt);
    assert.throws(() => adapter.deployTarget({ decision: { id: 'x', payload: JSON.stringify({ registry: { contractAccount: 'foo.testnet' } }) }, vault: VAULT }), /not <name>/);
  });
  test('checkTemplate: init_args are NOT part of the NEAR template id, so they are compared separately', async () => {
    const w = makeWorld();
    const s = await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) });
    assert.equal(adapter.checkTemplate({ state: s, expected: w.exp }).ok, true);
    const other = adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, owner: 'attacker.near' } } });
    assert.equal(other.templateId, w.exp.templateId, 'same id, different owner');
    const bad = adapter.checkTemplate({ state: s, expected: other });
    assert.equal(bad.ok, false); assert.ok(bad.checks.some((c) => !c.ok && /init_args/.test(c.name)));
    w.views[VAULT].templates = []; assert.equal(adapter.checkTemplate({ state: await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) }), expected: w.exp }).ok, false);
  });
  test('planSteps: allow_template (owner-fixed init args), set_mandate, fund, agent seed, key warning; amounts in NEAR; quotes escaped; nothing executed', () => {
    const payload = { vault: { address: VAULT, owner: OWNER }, agent: { account: AGENT }, mandate: { expiresAt: '1700003600', perDrawCap: String(NEAR), periodSecs: '3600', periodCap: String(5n * NEAR), totalCap: String(20n * NEAR), maxDeploys: '3' }, templates: [{ templateId: WASM_SHA, label: "it's", deposit: String(38n * 10n ** 23n), initMaterial: { owner_id: OWNER, proposer_id: AGENT, network_id: 'testnet' } }], fund: { amount: String(12n * NEAR + NEAR / 2n) } };
    const steps = adapter.planSteps({ net: NET, payload, vault: VAULT });
    assert.deepEqual(steps.map((s) => s.title.split(':')[0].split(' ')[0]), ['allow_template', 'set_mandate', 'Fund', 'Seed', 'Decide']);
    assert.ok(steps.every((s) => s.who === 'human') && steps.slice(0, 4).every((s) => /^near (contract|tokens) /.test(s.cli) && /sign-with-keychain/.test(s.cli)) && !steps[4].cli);
    assert.deepEqual(steps[0].call.args.init_args, { owner_id: OWNER, proposer_id: AGENT, network_id: 'testnet' });
    assert.match(steps[0].cli, /network-config testnet/); assert.ok(steps[0].cli.includes(`'it'\\''s'`) || steps[0].cli.includes("it'\\''s"));
    assert.equal(steps[1].call.args.max_deploys, 3); assert.equal(steps[1].call.args.agent, AGENT);
    assert.match(steps[2].title, /12\.5 NEAR/); assert.match(steps[2].cli, /'12\.5 NEAR'/);
    assert.ok(!steps.some((s) => /mainnet/.test(s.cli)));
  });
  test('attested: sha256 of the built vault wasm (or null with an error when it is not built)', () => {
    if (existsSync(VAULT_WASM_PATH)) assert.equal(adapter.attested.sha256, sha256Hex(readFileSync(VAULT_WASM_PATH)));
    else assert.equal(adapter.attested.sha256, null);
  });
});
