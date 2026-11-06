// Offline tests for the payouts support of src/vault/near.js (phase 2a): build detection / dual attestation, readState.payouts, buildCall for pay and the owner
// methods, preview('pay'), NEP-141 / NEP-145 reads and the owner plan-step builders. Every RPC is a fake (fetchImpl), same style as tests/vault-near.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { adapter, ATTESTED_BUILDS, buildOfCodeHash, ATTACHED_GAS, OWNER_GAS, STORAGE_DEPOSIT_DEFAULT, VAULT_WASM_PATH, VAULT_PAY_WASM_PATH } from '../src/vault/near.js';
import { base58, hexToBytes } from '../src/chains/common.js';

const NEAR = 10n ** 24n;
const VAULT = 'vault.test.near', OWNER = 'owner.test.near', AGENT = 'ab'.repeat(32);
const USDC = 'usdc.test.near', USDT = 'usdt.test.near', ALICE = 'alice.test.near', BOB = 'bob.test.near';
const NET = { id: 'near-testnet', protocol: 'near', rpc: 'https://rpc.testnet.near.org', explorer: 'https://testnet.nearblocks.io/txns/', mainnet: false };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const b58Of = (hex) => base58(hexToBytes(hex));
const HAVE_BUILDS = existsSync(VAULT_WASM_PATH) && existsSync(VAULT_PAY_WASM_PATH);
const failedOf = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

function makeWorld({ pay = true, version, codeHash } = {}) {
  const v1 = ATTESTED_BUILDS.v1.sha256 ?? sha('v1-stand-in'); const pb = ATTESTED_BUILDS.pay.sha256 ?? sha('pay-stand-in');
  const w = {
    block: { height: 4321, hash: 'BLOCKHASH', timestamp_nanosec: '1700000100000000000' },
    accounts: { [VAULT]: { amount: String(50n * NEAR), code_hash: b58Of(pay ? pb : v1), storage_usage: 250000 }, [AGENT]: { amount: String(NEAR), code_hash: '11111111111111111111111111111111' } },
    keys: { [VAULT]: [] },
    calls: [],
    views: {
      [VAULT]: {
        config: { owner: OWNER, pending_owner: null, paused: false, network_id: 'testnet', epoch: '1', vault_id: VAULT, version: version ?? (pay ? '1.1.0' : '1.0.0'), reserve: String(NEAR) },
        mandate: { agent: AGENT, expires_at: '1700003600', per_draw_cap: String(NEAR), period_secs: '3600', period_cap: String(5n * NEAR), total_cap: String(20n * NEAR), max_deploys: 3, revoked: false, start: '1700000000', active: true },
        usage: { total_spent: '0', period_index: '0', period_spent: '0', deploys: 0 },
        available: String(45n * NEAR), templates: [],
        period_state: { period_index: '0', period_start: '1700000000', period_end: '1700003600', period_spent: '0', period_remaining: String(5n * NEAR), total_spent: '0', total_remaining: String(20n * NEAR), deploys: 0, deploys_remaining: 3, active: true },
        preview_draw: '', preview_deploy: '',
      },
      [USDC]: {
        ft_balance_of: (a) => ({ [VAULT]: '123000000', [OWNER]: '5' })[a.account_id] ?? '0',
        storage_balance_of: (a) => (a.account_id === ALICE || a.account_id === VAULT ? { total: '1250000000000000000000', available: '0' } : null),
        storage_balance_bounds: { min: '1250000000000000000000', max: null },
        ft_metadata: { spec: 'ft-1.0.0', name: 'Mock USDC', symbol: 'USDC', decimals: 6 },
      },
    },
  };
  if (codeHash) w.accounts[VAULT].code_hash = codeHash;
  if (pay) {
    Object.assign(w.views[VAULT], {
      tokens: [{ token: USDC, per_pay_cap: '10000000', period_cap: '25000000', total_cap: '100000000' }, { token: USDT, per_pay_cap: '3', period_cap: '4', total_cap: '5' }],
      token_usage: (a) => (a.token === USDC ? { total_spent: '7000000', period_index: '0', period_spent: '7000000' } : { total_spent: '0', period_index: '0', period_spent: '0' }),
      payees: (a) => [ALICE, BOB].slice(Number(a.from_index ?? 0), Number(a.from_index ?? 0) + Number(a.limit ?? 50)),
      preview_pay: (a) => (BigInt(a.amount) > 10000000n ? 'PerPayCap' : ''),
    });
  }
  return w;
}

function rpc(w) {
  return async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    w.calls.push({ method, params });
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    const err = (data) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error', data } }), { status: 200 });
    if (method === 'block') return ok({ header: w.block });
    if (method === 'gas_price') return ok({ gas_price: '100000000' });
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
const viewCalls = (w) => w.calls.filter((c) => c.method === 'query' && c.params.request_type === 'call_function').map((c) => `${c.params.account_id}:${c.params.method_name}`);

describe('two attested builds', () => {
  test('attested keeps the v1 shape at the top level and carries both builds', () => {
    const a = adapter.attested;
    assert.equal(a.sha256, ATTESTED_BUILDS.v1.sha256); assert.equal(a.codeHash, ATTESTED_BUILDS.v1.codeHash); assert.ok('bytes' in a && 'source' in a);
    assert.equal(a.builds, ATTESTED_BUILDS); assert.equal(adapter.builds, ATTESTED_BUILDS);
    assert.equal(ATTESTED_BUILDS.v1.version, '1.0.0'); assert.equal(ATTESTED_BUILDS.pay.version, '1.1.0');
  });
  test('the dist wasm hashes are the attested ones (v1 a052d400..., payouts aa08ad2b...)', { skip: HAVE_BUILDS ? false : 'wasm not built' }, () => {
    assert.equal(ATTESTED_BUILDS.v1.sha256, 'a052d400c3bc1a136c6cffed3457073cf59cee75582d1bb39d14cc7cfc7eb00d');
    assert.equal(ATTESTED_BUILDS.pay.sha256, 'aa08ad2bc90cd5f87a723a3ca3c16811cbc48d866e7a981861cc057c8203c945');
    assert.equal(ATTESTED_BUILDS.pay.codeHash, b58Of(ATTESTED_BUILDS.pay.sha256));
    assert.equal(buildOfCodeHash(ATTESTED_BUILDS.v1.codeHash), 'v1'); assert.equal(buildOfCodeHash(ATTESTED_BUILDS.pay.codeHash), 'pay'); assert.equal(buildOfCodeHash('nope'), null);
  });
  test('verifyVaultCode with the adapter\'s own attested (what src/vault/index.js passes) or no attested accepts EITHER build and reports which', { skip: HAVE_BUILDS ? false : 'wasm not built' }, async () => {
    for (const attested of [adapter.attested, undefined]) {
      let r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested, fetchImpl: rpc(makeWorld({ pay: false })) });
      assert.equal(r.ok, true, JSON.stringify(failedOf(r))); assert.equal(r.build, 'v1'); assert.equal(r.version, '1.0.0');
      r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested, fetchImpl: rpc(makeWorld({ pay: true })) });
      assert.equal(r.ok, true, JSON.stringify(failedOf(r))); assert.equal(r.build, 'pay'); assert.equal(r.version, '1.1.0');
    }
  });
  test('the version must match the build that matched the hash (a v1 hash claiming 1.1.0, a payouts hash claiming 1.0.0)', { skip: HAVE_BUILDS ? false : 'wasm not built' }, async () => {
    let r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: adapter.attested, fetchImpl: rpc(makeWorld({ pay: false, version: '1.1.0' })) });
    assert.equal(r.ok, false); assert.equal(r.build, null); assert.ok(failedOf(r).some((n) => /version is 1\.0\.0/.test(n)));
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: adapter.attested, fetchImpl: rpc(makeWorld({ pay: true, version: '1.0.0' })) });
    assert.equal(r.ok, false); assert.ok(failedOf(r).some((n) => /version is 1\.1\.0/.test(n)));
  });
  test('an unknown code hash matches neither build', async () => {
    const r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: adapter.attested, fetchImpl: rpc(makeWorld({ codeHash: b58Of(sha('evil')) })) });
    assert.equal(r.ok, false); assert.equal(r.build, null); assert.ok(failedOf(r).some((n) => /code hash/.test(n)));
  });
  test('an explicit attested hash is exactly that build: the payouts hash -> build "pay"; any other hash stays the v1 line (version 1.0.0)', async () => {
    const pb = ATTESTED_BUILDS.pay.sha256 ?? sha('pay-stand-in');
    let r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: pb, fetchImpl: rpc(makeWorld({ pay: true })) });
    assert.equal(r.ok, true, JSON.stringify(failedOf(r))); assert.equal(r.build, 'pay');
    // the v1 hash alone does not accept the payouts vault
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: sha('v1-only'), fetchImpl: rpc(makeWorld({ pay: true })) });
    assert.equal(r.ok, false);
    const w = makeWorld({ pay: false, codeHash: b58Of(sha('vault-build')) });
    r = await adapter.verifyVaultCode({ net: NET, vault: VAULT, attested: sha('vault-build'), fetchImpl: rpc(w) });
    assert.equal(r.ok, true); assert.equal(r.build, 'v1');
  });
  test('detectVaultBuild: hash -> build, plus what config() claims', { skip: HAVE_BUILDS ? false : 'wasm not built' }, async () => {
    assert.deepEqual(await adapter.detectVaultBuild({ net: NET, vault: VAULT, fetchImpl: rpc(makeWorld({ pay: true })) }), { build: 'pay', codeHash: ATTESTED_BUILDS.pay.codeHash, version: '1.1.0' });
    assert.equal((await adapter.detectVaultBuild({ net: NET, vault: VAULT, fetchImpl: rpc(makeWorld({ pay: false })) })).build, 'v1');
    assert.equal((await adapter.detectVaultBuild({ net: NET, vault: VAULT, fetchImpl: rpc(makeWorld({ codeHash: b58Of(sha('evil')) })) })).build, null);
  });
});

describe('readState payouts', () => {
  test('payouts build: payouts = { tokens: [{ token, perPayCap, periodCap, totalCap, usage: { total, period, periodIndex } }], payees }; v1 fields unchanged', async () => {
    const w = makeWorld({ pay: true });
    const s = await adapter.readState({ net: NET, vault: VAULT, now: 1700000200, fetchImpl: rpc(w), previews: { draw: ['5'], pay: [{ token: USDC, to: ALICE, amount: '20000000' }, { token: USDC, to: ALICE, amount: 1 }] } });
    assert.equal(s.build, 'pay'); assert.equal(s.config.version, '1.1.0');
    assert.deepEqual(s.payouts, {
      tokens: [
        { token: USDC, perPayCap: '10000000', periodCap: '25000000', totalCap: '100000000', usage: { total: '7000000', period: '7000000', periodIndex: 0 } },
        { token: USDT, perPayCap: '3', periodCap: '4', totalCap: '5', usage: { total: '0', period: '0', periodIndex: 0 } },
      ],
      payees: [ALICE, BOB],
    });
    assert.deepEqual(s.previews.pay, { [`${USDC}:${ALICE}:20000000`]: 'PerPayCap', [`${USDC}:${ALICE}:1`]: '' });
    assert.equal(s.mandate.agent, AGENT); assert.equal(s.available, String(45n * NEAR));
    assert.doesNotThrow(() => JSON.stringify(s));
    assert.ok(w.calls.filter((c) => c.method === 'query').every((q) => q.params.block_id === 4321), 'payout views are pinned to the same block');
  });
  test('v1 vault: no payouts key and NO payout view is ever called', async () => {
    const w = makeWorld({ pay: false });
    const s = await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w), previews: { draw: ['5'], pay: [{ token: USDC, to: ALICE, amount: 1 }] } });
    assert.equal('payouts' in s, false); assert.equal(s.build, 'v1'); assert.deepEqual(s.previews, { draw: { 5: '' }, deploy: {} });
    assert.ok(!viewCalls(w).some((c) => /:(tokens|payees|token_usage|preview_pay|token_period_state)$/.test(c)), viewCalls(w).join(','));
  });
  test('more than 100 payees are read in pages', async () => {
    const w = makeWorld({ pay: true }); const all = Array.from({ length: 130 }, (_, i) => `p${i}.test.near`);
    w.views[VAULT].payees = (a) => all.slice(Number(a.from_index), Number(a.from_index) + Number(a.limit));
    const s = await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) });
    assert.deepEqual(s.payouts.payees, all);
  });
  test('a payouts build with no tokens or payees: empty lists; an RPC failure of a payout view is thrown, not swallowed', async () => {
    const w = makeWorld({ pay: true }); w.views[VAULT].tokens = []; w.views[VAULT].payees = [];
    assert.deepEqual((await adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) })).payouts, { tokens: [], payees: [] });
    delete w.views[VAULT].payees;
    await assert.rejects(adapter.readState({ net: NET, vault: VAULT, fetchImpl: rpc(w) }), /payees/);
  });
});

describe('preview(pay)', () => {
  test('calls preview_pay with { token, to, amount } at the requested block and returns the code', async () => {
    const w = makeWorld({ pay: true });
    assert.equal(await adapter.preview('pay', { net: NET, vault: VAULT, token: USDC, to: ALICE, amount: 1n, block: 4321, fetchImpl: rpc(w) }), '');
    assert.equal(await adapter.preview('pay', { net: NET, vault: VAULT, token: USDC, to: ALICE, amount: '99999999', fetchImpl: rpc(w) }), 'PerPayCap');
    const q = w.calls.filter((c) => c.method === 'query' && c.params.method_name === 'preview_pay');
    assert.equal(q[0].params.block_id, 4321); assert.equal(q[1].params.finality, 'final');
    assert.deepEqual(JSON.parse(Buffer.from(q[0].params.args_base64, 'base64').toString()), { token: USDC, to: ALICE, amount: '1' });
    assert.equal(await adapter.previewPay({ net: NET, vault: VAULT, token: USDC, to: ALICE, amount: 5, fetchImpl: rpc(w) }), '');
  });
});

describe('buildCall: pay and the owner payout methods', () => {
  test('pay: exactly { method, target, args } (the signer\'s call shape); memo only when given; amounts are decimal strings', () => {
    assert.deepEqual(adapter.buildCall('pay', { vault: VAULT, token: USDC, to: ALICE, amount: 25n * 10n ** 6n }), { method: 'pay', target: VAULT, args: { token: USDC, to: ALICE, amount: '25000000' } });
    const m = adapter.buildCall('pay', { vault: VAULT, token: USDC, to: ALICE, amount: '5', memo: 'invoice 42' });
    assert.deepEqual(m.args, { token: USDC, to: ALICE, amount: '5', memo: 'invoice 42' }); assert.deepEqual(Object.keys(m).sort(), ['args', 'method', 'target']);
    assert.equal(adapter.buildCall('pay', { vault: VAULT, token: USDC, to: ALICE, amount: 1, memo: null }).args.memo, undefined);
    assert.equal(ATTACHED_GAS.pay, 100n * 10n ** 12n);
  });
  test('pay refuses bad input before anything can be signed', () => {
    const ok = { vault: VAULT, token: USDC, to: ALICE, amount: 1 };
    for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 'abc' }, { amount: 1n << 128n }, { token: 'BAD' }, { to: 'BAD' }, { vault: 'BAD' }, { memo: 'x'.repeat(129) }, { memo: 'é'.repeat(65) }, { memo: 5 }]) assert.throws(() => adapter.buildCall('pay', { ...ok, ...bad }), Error, String(Object.keys(bad)));
    assert.doesNotThrow(() => adapter.buildCall('pay', { ...ok, memo: 'é'.repeat(64) }));
    assert.doesNotThrow(() => adapter.buildCall('pay', { ...ok, amount: (1n << 128n) - 1n }));
  });
  test('allow_token / disallow_token / allow_payee / disallow_payee / withdraw_token: the exact JSON args of the Rust methods, with gas and deposit', () => {
    assert.deepEqual(adapter.buildCall('allow_token', { vault: VAULT, token: USDC, perPayCap: 10n, periodCap: '25', totalCap: 100 }), { method: 'allow_token', target: VAULT, args: { token: USDC, per_pay_cap: '10', period_cap: '25', total_cap: '100' }, gas: String(30n * 10n ** 12n), deposit: '0' });
    assert.deepEqual(adapter.buildCall('disallow_token', { vault: VAULT, token: USDC }), { method: 'disallow_token', target: VAULT, args: { token: USDC }, gas: String(OWNER_GAS.disallow_token), deposit: '0' });
    assert.deepEqual(adapter.buildCall('allow_payee', { vault: VAULT, account: ALICE }), { method: 'allow_payee', target: VAULT, args: { account: ALICE }, gas: String(OWNER_GAS.allow_payee), deposit: '0' });
    assert.deepEqual(adapter.buildCall('disallow_payee', { vault: VAULT, account: ALICE }).args, { account: ALICE });
    assert.deepEqual(adapter.buildCall('withdraw_token', { vault: VAULT, token: USDC, amount: 7n }), { method: 'withdraw_token', target: VAULT, args: { token: USDC, amount: '7' }, gas: String(100n * 10n ** 12n), deposit: '0' });
  });
  test('owner calls refuse what the contract would refuse (E_BadToken / E_BadPayee / E_BadAmount) and unknown kinds', () => {
    const T = { vault: VAULT, token: USDC, perPayCap: 1, periodCap: 1, totalCap: 1 };
    assert.throws(() => adapter.buildCall('allow_token', { ...T, perPayCap: 0 }), /positive/);
    assert.throws(() => adapter.buildCall('allow_token', { ...T, perPayCap: 2 }), /caps must satisfy/);
    assert.throws(() => adapter.buildCall('allow_token', { ...T, periodCap: 3, totalCap: 2 }), /caps must satisfy/);
    for (const t of [VAULT, 'system', '0'.repeat(64)]) assert.throws(() => adapter.buildCall('allow_token', { ...T, token: t }), /BadToken/, t);
    for (const a of [VAULT, 'system', '0'.repeat(64)]) assert.throws(() => adapter.buildCall('allow_payee', { vault: VAULT, account: a }), /BadPayee/, a);
    assert.throws(() => adapter.buildCall('withdraw_token', { vault: VAULT, token: VAULT, amount: 1 }), /BadToken/);
    assert.throws(() => adapter.buildCall('withdraw_token', { vault: VAULT, token: USDC, amount: 0 }), /positive/);
    assert.doesNotThrow(() => adapter.buildCall('disallow_token', { vault: VAULT, token: USDC }));
    assert.throws(() => adapter.buildCall('upgrade', { vault: VAULT }), /unknown kind/);
  });
  test('estimateFee prices pay at 100 Tgas x gas price x 1.5; signerOptions pins pay only when asked (the v1 shape is untouched)', async () => {
    const w = makeWorld();
    const e = await adapter.estimateFee({ net: NET, vault: VAULT, agent: AGENT, call: adapter.buildCall('pay', { vault: VAULT, token: USDC, to: ALICE, amount: 1 }), fetchImpl: rpc(w) });
    assert.equal(e.worstCaseFee, 100n * 10n ** 12n * 10n ** 8n * 3n / 2n);
    assert.deepEqual(adapter.signerOptions({ net: NET }).gas, { draw: String(50n * 10n ** 12n), deploy: String(300n * 10n ** 12n) });
    assert.deepEqual(adapter.signerOptions({ net: NET, payouts: true }).gas, { draw: String(50n * 10n ** 12n), deploy: String(300n * 10n ** 12n), pay: String(100n * 10n ** 12n) });
  });
});

describe('NEP-141 / NEP-145 reads', () => {
  test('ftBalance, storageBalanceOf, ftRegistered, storageBalanceBounds, ftMetadata', async () => {
    const w = makeWorld(); const f = rpc(w);
    assert.equal(await adapter.ftBalance({ net: NET, token: USDC, account: VAULT, fetchImpl: f }), '123000000');
    assert.equal(await adapter.ftBalance({ net: NET, token: USDC, account: BOB, fetchImpl: f }), '0');
    assert.deepEqual(await adapter.storageBalanceOf({ net: NET, token: USDC, account: ALICE, fetchImpl: f }), { total: '1250000000000000000000', available: '0' });
    assert.equal(await adapter.storageBalanceOf({ net: NET, token: USDC, account: BOB, fetchImpl: f }), null);
    assert.equal(await adapter.ftRegistered({ net: NET, token: USDC, account: ALICE, fetchImpl: f }), true);
    assert.equal(await adapter.ftRegistered({ net: NET, token: USDC, account: BOB, fetchImpl: f }), false);
    assert.deepEqual(await adapter.storageBalanceBounds({ net: NET, token: USDC, fetchImpl: f }), { min: '1250000000000000000000', max: null });
    assert.equal((await adapter.ftMetadata({ net: NET, token: USDC, fetchImpl: f })).decimals, 6);
    const q = w.calls.find((c) => c.params?.method_name === 'ft_balance_of');
    assert.deepEqual(JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString()), { account_id: VAULT });
    assert.equal(q.params.finality, 'final');
    await adapter.ftBalance({ net: NET, token: USDC, account: VAULT, block: 4321, fetchImpl: f });
    assert.equal(w.calls.filter((c) => c.params?.method_name === 'ft_balance_of').at(-1).params.block_id, 4321);
  });
  test('bad ids are refused locally; a token that is not a contract is an error, not a silent 0', async () => {
    await assert.rejects(adapter.ftBalance({ net: NET, token: 'BAD', account: VAULT, fetchImpl: rpc(makeWorld()) }), /account ids/);
    await assert.rejects(adapter.ftBalance({ net: NET, token: 'nothing.test.near', account: VAULT, fetchImpl: rpc(makeWorld()) }), /not found/);
  });
});

describe('owner plan steps for a payouts grant (builders only)', () => {
  const T = { token: USDC, perPayCap: 10_000_000n, periodCap: 25_000_000n, totalCap: 100_000_000n, label: 'USDC', decimals: 6 };
  test('order: register vault + payees on each token, allow_token per token, allow_payee per payee; exact calls and near-cli commands', () => {
    const steps = adapter.payoutPlanSteps({ net: NET, vault: VAULT, owner: OWNER, tokens: [T], payees: [ALICE, BOB] });
    assert.deepEqual(steps.map((s) => `${s.call.receiverId}:${s.call.method}:${JSON.stringify(s.call.args)}`), [
      `${USDC}:storage_deposit:${JSON.stringify({ account_id: VAULT, registration_only: true })}`,
      `${USDC}:storage_deposit:${JSON.stringify({ account_id: ALICE, registration_only: true })}`,
      `${USDC}:storage_deposit:${JSON.stringify({ account_id: BOB, registration_only: true })}`,
      `${VAULT}:allow_token:${JSON.stringify({ token: USDC, per_pay_cap: '10000000', period_cap: '25000000', total_cap: '100000000' })}`,
      `${VAULT}:allow_payee:${JSON.stringify({ account: ALICE })}`,
      `${VAULT}:allow_payee:${JSON.stringify({ account: BOB })}`,
    ]);
    assert.ok(steps.every((s) => s.who === 'human' && /^near contract call-function as-transaction /.test(s.cli) && /sign-with-keychain send$/.test(s.cli) && s.cli.includes(`sign-as '${OWNER}'`) && /network-config testnet/.test(s.cli)));
    assert.equal(steps[0].call.deposit, STORAGE_DEPOSIT_DEFAULT.toString()); assert.match(steps[0].cli, /attached-deposit '0\.0025 NEAR'/);
    assert.equal(steps[3].call.deposit, '0'); assert.match(steps[3].cli, /attached-deposit '0 NEAR'/);
    assert.match(steps[3].note, /10 per payment, 25 per period, 100 in total/);
    assert.ok(steps[3].cli.includes(`as-transaction '${VAULT}' allow_token json-args`) && steps[0].cli.includes(`as-transaction '${USDC}' storage_deposit json-args`));
  });
  test('already registered accounts are skipped; a custom storage deposit is honoured; two tokens', () => {
    const steps = adapter.payoutPlanSteps({ net: NET, vault: VAULT, owner: OWNER, tokens: [T, { ...T, token: USDT, storageDeposit: 10n ** 22n }], payees: [ALICE], registered: [`${USDC}:${VAULT}`, `${USDT}:${ALICE}`] });
    const titles = steps.map((s) => s.title);
    assert.equal(titles.filter((x) => /^storage_deposit/.test(x)).length, 2);   // alice on usdc + vault on usdt
    assert.equal(steps.find((s) => s.call.receiverId === USDT).call.deposit, String(10n ** 22n));
    assert.equal(steps.filter((s) => s.call.method === 'allow_token').length, 2);
  });
  test('refuses what the contract refuses, before returning any step', () => {
    const base = { net: NET, vault: VAULT, owner: OWNER, tokens: [T], payees: [ALICE] };
    assert.throws(() => adapter.payoutPlanSteps({ ...base, tokens: Array.from({ length: 9 }, (_, i) => ({ ...T, token: `t${i}.test.near` })) }), /at most 8 tokens/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, payees: Array.from({ length: 65 }, (_, i) => `p${i}.test.near`) }), /at most 64 payees/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, payees: [USDC] }), /both a token and a payee/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, payees: [VAULT] }), /BadPayee/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, payees: [ALICE, ALICE] }), /duplicate/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, tokens: [{ ...T, perPayCap: 30_000_000n }] }), /caps must satisfy/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, tokens: [{ ...T, token: 'system' }] }), /BadToken/);
    assert.throws(() => adapter.payoutPlanSteps({ ...base, owner: 'BAD' }), /account ids/);
  });
  test('single builders: storageDepositStep, allowTokenStep, allowPayeeStep', () => {
    assert.equal(adapter.storageDepositStep({ net: NET, owner: OWNER, token: USDC, account: ALICE }).call.deposit, STORAGE_DEPOSIT_DEFAULT.toString());
    assert.throws(() => adapter.storageDepositStep({ net: NET, owner: OWNER, token: USDC, account: ALICE, deposit: 0 }), /positive/);
    assert.equal(adapter.allowTokenStep({ net: NET, owner: OWNER, vault: VAULT, ...T }).call.method, 'allow_token');
    assert.equal(adapter.allowPayeeStep({ net: NET, owner: OWNER, vault: VAULT, account: ALICE }).call.args.account, ALICE);
  });
});

test('v1 interface is unchanged: the same members exist, draw/deploy buildCall output has no gas/deposit keys', () => {
  for (const f of ['readState', 'verifyVaultCode', 'expectedTemplate', 'buildCall', 'verifyDeploy', 'explorerTx', 'explorerAddress', 'preview', 'estimateFee', 'signerOptions', 'deployTarget', 'planSteps']) assert.equal(typeof adapter[f], 'function', f);
  assert.deepEqual(Object.keys(adapter.buildCall('draw', { vault: VAULT, amount: 1 })).sort(), ['args', 'method', 'target']);
});
