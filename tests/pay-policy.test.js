// Phase 2b-1, rules without a chain: grant `payouts` section, the pay_testnet payload and its ceilings, the agent signer's pay limits, the payments migration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertGrantPayload, assertPayPayload, assertDecisionAllowed, tokenTotalCeiling, payPerPaymentCeiling, vaultLimits, DECISION_LIMITS, TOKEN_CEILINGS } from '../src/policy.js';
import { normalizeLimits, enforceCall, LimitError, VAULT_METHODS, DEFAULT_METHODS } from '../src/agent/limits.js';
import * as near from '../src/agent/near-signer.js';
import { SCHEMA, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, openDb } from '../src/db.js';

const VAULT = 'vault.testnet', OWNER = 'owner.testnet', AGENT = 'ab'.repeat(32), USDC = 'usdc.testnet', USDT = 'usdt.testnet', ALICE = 'alice.testnet', BOB = 'bob.testnet';
const M = 10n ** 6n;

function grant(payouts, over = {}) {
  return {
    kind: 'grant_mandate', vault: { chainId: 'near-testnet', address: VAULT, owner: OWNER }, agent: { account: AGENT },
    mandate: { expiresAt: '2000000000', perDrawCap: '10', periodSecs: '3600', periodCap: '20', totalCap: '50', maxDeploys: '2' },
    templates: [{ artifactHash: 'a'.repeat(64), templateId: 'b'.repeat(64), label: 'registry', deposit: '1' }],
    fund: { amount: '0' }, loop: { maxPerDay: 5 },
    ...(payouts === undefined ? {} : { payouts }), ...over,
  };
}
const tok = (o = {}) => ({ token: USDC, symbol: 'USDC', decimals: 6, perPayCap: String(10n * M), periodCap: String(25n * M), totalCap: String(100n * M), ...o });
const okPayouts = (o = {}) => ({ tokens: [tok()], payees: [ALICE, BOB], ...o });
const rejects = (p, re, code, env) => assert.throws(() => assertGrantPayload(p, 'near', env ?? {}), (e) => (re ? re.test(e.message) : true) && (code ? e.code === code : true), `${re}`);

describe('grant payload: payouts section', () => {
  test('a v1 grant (no payouts) and a valid payouts grant both pass; the section is optional', () => {
    assert.doesNotThrow(() => assertGrantPayload(grant(), 'near', {}));
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ fund: { token: USDC, amount: String(50n * M) } })), 'near', {}));
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ tokens: [tok({ mock: true })] })), 'near', {}));
  });
  test('payouts exist only for NEAR', () => {
    const evm = { ...grant(okPayouts()), vault: { address: '0x' + '1'.repeat(40), owner: '0x' + '2'.repeat(40) }, agent: { address: '0x' + '3'.repeat(40) }, templates: [{ artifactHash: 'a'.repeat(64), templateId: 'b'.repeat(64), label: 'r', deposit: '0' }] };
    assert.throws(() => assertGrantPayload(evm, 'evm', {}), (e) => /only on NEAR/.test(e.message) && e.code === 'schema');
    // ...and the same grant without the section is a normal EVM grant
    delete evm.payouts; assert.doesNotThrow(() => assertGrantPayload(evm, 'evm', {}));
  });
  test('shape: object, known fields only, tokens 1..8, payees 1..64', () => {
    rejects(grant([]), /must be an object/); rejects(grant('x'), /must be an object/); rejects(grant(null), /must be an object/);
    rejects(grant(okPayouts({ extra: 1 })), /unexpected field "extra"/);
    rejects(grant(okPayouts({ tokens: [] })), /tokens must list 1\.\.8/); rejects(grant(okPayouts({ payees: [] })), /payees must list 1\.\.64/);
    rejects(grant({ payees: [ALICE] }), /tokens must list/); rejects(grant({ tokens: [tok()] }), /payees must list/);
    const nine = Array.from({ length: 9 }, (_, i) => tok({ token: `tok${i}.testnet` }));
    rejects(grant(okPayouts({ tokens: nine })), /1\.\.8/);
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ tokens: nine.slice(0, 8) })), 'near', {}));
    const many = Array.from({ length: 65 }, (_, i) => `p${i}.testnet`);
    rejects(grant(okPayouts({ payees: many })), /1\.\.64/);
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ payees: many.slice(0, 64) })), 'near', {}));
    rejects(grant(okPayouts({ tokens: [tok({ surprise: 1 })] })), /unexpected token field "surprise"/);
    rejects(grant(okPayouts({ tokens: ['x'] })), /each token must be an object/);
  });
  test('cap ordering 0 < perPay <= period <= total, decimal-string caps that fit u128', () => {
    rejects(grant(okPayouts({ tokens: [tok({ perPayCap: '0' })] })), /0 < perPayCap <= periodCap <= totalCap/);
    rejects(grant(okPayouts({ tokens: [tok({ perPayCap: String(26n * M) })] })), /perPayCap <= periodCap/);
    rejects(grant(okPayouts({ tokens: [tok({ periodCap: String(101n * M) })] })), /periodCap <= totalCap/);
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ tokens: [tok({ perPayCap: '5', periodCap: '5', totalCap: '5' })] })), 'near', {}));
    rejects(grant(okPayouts({ tokens: [tok({ perPayCap: 5 })] })), /decimal integer string/);
    rejects(grant(okPayouts({ tokens: [tok({ totalCap: '1.5' })] })), /decimal integer string/);
    rejects(grant(okPayouts({ tokens: [tok({ totalCap: '-1' })] })), /decimal integer string/);
    rejects(grant(okPayouts({ tokens: [tok({ perPayCap: '1', periodCap: '1', totalCap: '1' + '0'.repeat(40) })] })), /does not fit in 128 bits/, 'grant', {});
  });
  test('symbol and decimals are required in the payload (the server fills them from the token), mock must be a boolean', () => {
    const t = tok(); delete t.decimals; rejects(grant(okPayouts({ tokens: [t] })), /decimals is missing/);
    const s = tok(); delete s.symbol; rejects(grant(okPayouts({ tokens: [s] })), /symbol is missing/);
    rejects(grant(okPayouts({ tokens: [tok({ decimals: 6.5 })] })), /decimals/); rejects(grant(okPayouts({ tokens: [tok({ decimals: 37 })] })), /decimals/);
    rejects(grant(okPayouts({ tokens: [tok({ symbol: 'US DC' })] })), /symbol/); rejects(grant(okPayouts({ tokens: [tok({ mock: 'yes' })] })), /mock must be true or false/);
  });
  test('no duplicates, token/payee exclusion, valid NEAR account ids, never the vault / system / zero account', () => {
    rejects(grant(okPayouts({ tokens: [tok(), tok()] })), /listed twice/); rejects(grant(okPayouts({ payees: [ALICE, ALICE] })), /payee alice.testnet is listed twice/);
    rejects(grant(okPayouts({ payees: [ALICE, USDC] })), /both a token and a payee/);
    for (const bad of ['BAD', 'a', 'has space.testnet', '-x.testnet', VAULT, 'system', '0'.repeat(64)]) {
      rejects(grant(okPayouts({ payees: [bad] })), /payee/, undefined, {});
      rejects(grant(okPayouts({ tokens: [tok({ token: bad })] })), /token/, undefined, {});
    }
    rejects(grant(okPayouts({ payees: [42] })), /payee "42"/);
  });
  test('per-token total-cap ceiling is in the token\'s OWN base units: default 1000 whole tokens, env VAULT_MAX_TOKEN_TOTAL_WHOLE, compiled-in maximum 100000', () => {
    const g = (total, decimals = 6, token = USDC) => grant(okPayouts({ tokens: [tok({ token, decimals, perPayCap: '1', periodCap: '1', totalCap: String(total) })] }));
    assert.equal(tokenTotalCeiling(6, {}), 1000n * M); assert.equal(tokenTotalCeiling(24, {}), 1000n * 10n ** 24n); assert.equal(tokenTotalCeiling(0, {}), 1000n);
    assert.doesNotThrow(() => assertGrantPayload(g(1000n * M), 'near', {}));
    rejects(g(1000n * M + 1n), /exceeds the ceiling 1000000000 \(6 decimals\)/, 'spend', {});
    // the same whole-token amount scales with decimals: 1000 tokens of a 24-decimal token is 1000e24, and 1001e6 of a 6-decimal one is over
    assert.doesNotThrow(() => assertGrantPayload(g(1000n * 10n ** 24n, 24), 'near', {}));
    rejects(g(1000n * 10n ** 24n + 1n, 24), /exceeds the ceiling/, 'spend', {});
    // env raises it, but never above 100000 whole tokens; garbage falls back to the default
    assert.doesNotThrow(() => assertGrantPayload(g(5000n * M), 'near', { VAULT_MAX_TOKEN_TOTAL_WHOLE: '5000' }));
    rejects(g(5000n * M + 1n), /exceeds the ceiling/, 'spend', { VAULT_MAX_TOKEN_TOTAL_WHOLE: '5000' });
    assert.equal(tokenTotalCeiling(6, { VAULT_MAX_TOKEN_TOTAL_WHOLE: '999999999' }), 100_000n * M);
    assert.equal(tokenTotalCeiling(6, { VAULT_MAX_TOKEN_TOTAL_WHOLE: '999999999' }), TOKEN_CEILINGS.totalWhole.hardMaxWhole * M);
    for (const junk of ['abc', '-5', '0', '1.5', '', ' ', '1e3']) assert.equal(tokenTotalCeiling(6, { VAULT_MAX_TOKEN_TOTAL_WHOLE: junk }), 1000n * M, junk);
    rejects(g(100_000n * M + 1n), /exceeds the ceiling/, 'spend', { VAULT_MAX_TOKEN_TOTAL_WHOLE: '999999999' });
    // the ceiling also holds for the existing NEAR budget: payouts do not loosen mandate.totalCap
    rejects(grant(okPayouts(), { mandate: { ...grant().mandate, totalCap: String(21n * 10n ** 24n), periodCap: String(21n * 10n ** 24n) } }), /spend ceiling/, 'spend', {});
  });
  test('fund: one of the listed tokens, a positive amount, within the same ceiling', () => {
    rejects(grant(okPayouts({ fund: { token: USDT, amount: '5' } })), /one of the listed tokens/);
    rejects(grant(okPayouts({ fund: { token: USDC, amount: '0' } })), /positive/); rejects(grant(okPayouts({ fund: { token: USDC, amount: 5 } })), /positive/);
    rejects(grant(okPayouts({ fund: { token: USDC, amount: String(1001n * M) } })), /exceeds the token ceiling/, 'spend', {});
    rejects(grant(okPayouts({ fund: { token: USDC, amount: '5', x: 1 } })), /unexpected fund field/); rejects(grant(okPayouts({ fund: 'x' })), /fund must be an object/);
    assert.doesNotThrow(() => assertGrantPayload(grant(okPayouts({ fund: { token: USDC, amount: String(1000n * M) } })), 'near', {}));
  });
  test('mainnet stays blocked: a payouts grant on near-mainnet (or any unknown network) is refused by assertDecisionAllowed', () => {
    const row = (chain, p) => ({ action: 'grant_mandate', chain_id: chain, target: VAULT, method: 'grant_mandate', max_spend: p.mandate.totalCap, expiry: Date.now() + 1000, payload: JSON.stringify(p) });
    assert.doesNotThrow(() => assertDecisionAllowed(row('near-testnet', grant(okPayouts()))));
    assert.throws(() => assertDecisionAllowed(row('near-mainnet', grant(okPayouts()))), (e) => e.code === 'network_blocked');
    assert.throws(() => assertDecisionAllowed(row('near-testnet', grant(okPayouts({ tokens: [tok({ totalCap: String(2000n * M) })] })))), (e) => e.code === 'spend');
  });
});

describe('pay_testnet policy', () => {
  const payload = (o = {}) => ({ action: 'pay_testnet', protocol: 'near', network: 'near-testnet', vault: VAULT, token: USDC, symbol: 'USDC', decimals: 6, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', ...o });
  const row = (p, o = {}) => ({ action: 'pay_testnet', chain_id: 'near-testnet', target: VAULT, method: 'pay', max_spend: p.amount, expiry: Date.now() + 3600_000, payload: JSON.stringify(p), ...o });
  const bad = (p, re, code, env, o) => assert.throws(() => assertPayPayload(p, row(p, o), env ?? {}), (e) => re.test(e.message) && (!code || e.code === code), String(re));

  test('pay_testnet is an enabled action; a valid payload passes both assertPayPayload and assertDecisionAllowed', () => {
    assert.ok(DECISION_LIMITS.allowedActions.includes('pay_testnet'));
    const p = payload();
    assert.doesNotThrow(() => assertPayPayload(p, row(p), {}));
    assert.doesNotThrow(() => assertDecisionAllowed(row(p)));
    assert.doesNotThrow(() => assertDecisionAllowed(row(payload({ memo: '', reference: 'ref-1' }), { max_spend: String(25n * M) })));
  });
  test('testnet only: other networks, the mainnet id, EVM chains and a mismatching payload.network are refused', () => {
    const p = payload();
    assert.throws(() => assertDecisionAllowed(row(p, { chain_id: 'near-mainnet' })), (e) => e.code === 'network_blocked');
    assert.throws(() => assertDecisionAllowed(row(p, { chain_id: 'evm:84532' })), (e) => e.code === 'network_blocked');
    bad(payload({ network: 'near-mainnet' }), /only NEAR testnet/, 'network_blocked'); bad(payload({ protocol: 'evm' }), /only NEAR testnet/, 'network_blocked');
    bad(p, /only NEAR testnet/, 'network_blocked', {}, { chain_id: 'near-mainnet' });
  });
  test('per-payment ceiling = min(PAY_MAX_PER_PAYMENT_WHOLE (default 100) x 10^decimals, the token total ceiling)', () => {
    assert.equal(payPerPaymentCeiling(6, {}), 100n * M); assert.equal(payPerPaymentCeiling(24, {}), 100n * 10n ** 24n);
    assert.doesNotThrow(() => assertPayPayload(payload({ amount: String(100n * M) }), row(payload({ amount: String(100n * M) })), {}));
    bad(payload({ amount: String(100n * M + 1n) }), /exceeds the per-payment ceiling 100000000/, 'spend');
    // env raises it, bounded by the token total ceiling (1000 whole by default) and the compiled-in maximum
    assert.equal(payPerPaymentCeiling(6, { PAY_MAX_PER_PAYMENT_WHOLE: '500' }), 500n * M);
    assert.equal(payPerPaymentCeiling(6, { PAY_MAX_PER_PAYMENT_WHOLE: '5000' }), 1000n * M, 'capped by the token total ceiling');
    assert.equal(payPerPaymentCeiling(6, { PAY_MAX_PER_PAYMENT_WHOLE: '5000', VAULT_MAX_TOKEN_TOTAL_WHOLE: '9000' }), 5000n * M);
    assert.equal(payPerPaymentCeiling(6, { PAY_MAX_PER_PAYMENT_WHOLE: '99999999', VAULT_MAX_TOKEN_TOTAL_WHOLE: '99999999' }), 100_000n * M, 'compiled-in maximum');
    assert.equal(payPerPaymentCeiling(6, { PAY_MAX_PER_PAYMENT_WHOLE: 'junk' }), 100n * M);
    assert.equal(payPerPaymentCeiling(6, { VAULT_MAX_TOKEN_TOTAL_WHOLE: '50' }), 50n * M, 'a lower token ceiling lowers the per-payment ceiling too');
    assert.doesNotThrow(() => assertPayPayload(payload({ amount: String(500n * M) }), row(payload({ amount: String(500n * M) })), { PAY_MAX_PER_PAYMENT_WHOLE: '500' }));
    bad(payload({ amount: String(500n * M + 1n) }), /per-payment ceiling/, 'spend', { PAY_MAX_PER_PAYMENT_WHOLE: '500' });
    // the ceiling is in the token's own units: 6 decimals and 24 decimals both mean "100 whole tokens"
    bad(payload({ decimals: 24, amount: String(100n * 10n ** 24n + 1n) }), /per-payment ceiling/, 'spend');
    assert.doesNotThrow(() => assertPayPayload(payload({ decimals: 24, amount: String(100n * 10n ** 24n) }), row(payload({ decimals: 24, amount: String(100n * 10n ** 24n) })), {}));
  });
  test('amount: positive whole number string that fits u128; max_spend must equal it', () => {
    for (const a of ['0', '-1', '1.5', '', 'abc', 25, null, String(1n << 128n)]) bad(payload({ amount: a }), /amount|schema/, undefined, undefined, { max_spend: String(a) });
    bad(payload(), /max_spend must equal/, 'spend', {}, { max_spend: '1' });
  });
  test('memo: text of at most 128 BYTES (multi-byte counted), may be empty; reference likewise', () => {
    assert.doesNotThrow(() => assertPayPayload(payload({ memo: 'x'.repeat(128) }), row(payload({ memo: 'x'.repeat(128) })), {}));
    assert.doesNotThrow(() => assertPayPayload(payload({ memo: 'é'.repeat(64) }), row(payload({ memo: 'é'.repeat(64) })), {}));
    bad(payload({ memo: 'x'.repeat(129) }), /memo must be text of at most 128 bytes/); bad(payload({ memo: 'é'.repeat(65) }), /at most 128 bytes/);
    bad(payload({ memo: 5 }), /memo/); { const p = payload(); delete p.memo; bad(p, /memo/); }
    bad(payload({ reference: 'r'.repeat(129) }), /reference/); bad(payload({ reference: 7 }), /reference/);
  });
  test('accounts and fields: valid NEAR ids, payee/token not the vault, symbol/decimals present, no unknown fields, target is the vault, method is pay', () => {
    bad(payload({ payee: 'BAD' }), /payee is not a valid NEAR account/); bad(payload({ token: 'x' }), /token is not a valid/); bad(payload({ vault: 'Nope' }), /vault is not a valid/);
    bad(payload({ payee: VAULT }), /cannot be the vault/); bad(payload({ token: VAULT }), /cannot be the vault/); bad(payload({ payee: USDC }), /must differ/); bad(payload({ payee: 'system' }), /payee is not a valid/);
    bad(payload({ symbol: undefined }), /symbol/); bad(payload({ decimals: '6' }), /decimals/); bad(payload({ decimals: -1 }), /decimals/);
    bad(payload({ extra: 1 }), /unexpected field "extra"/); bad(payload({ action: 'x' }), /payload.action/);
    bad(payload(), /target must be the vault/, undefined, {}, { target: 'other.testnet' }); bad(payload(), /method must be/, undefined, {}, { method: 'draw' });
  });
  test('/api/security data: the ceilings in force are published', () => {
    const l = vaultLimits({ VAULT_MAX_TOKEN_TOTAL_WHOLE: '2000' }).tokenPayouts;
    assert.equal(l.totalCap.defaultWhole, '1000'); assert.equal(l.totalCap.compiledMaxWhole, '100000'); assert.equal(l.totalCap.effectiveWhole, '2000');
    assert.equal(l.perPayment.defaultWhole, '100'); assert.equal(l.maxTokens, 8); assert.equal(l.maxPayees, 64); assert.equal(l.maxMemoBytes, 128);
  });
});

describe('agent signer: pay', () => {
  const vault = 'vault.autonear.testnet';
  const limits = { maxFeePerTx: 10n ** 23n, allowedTargets: [vault], allowedMethods: ['draw', 'deploy', 'pay'] };
  const pay = (args = {}, target = vault) => ({ method: 'pay', target, args: { token: USDC, to: ALICE, amount: '25000000', ...args } });
  const refused = (fn, code) => assert.throws(fn, (e) => e instanceof LimitError && e.code === code, code);

  test('VAULT_METHODS now includes pay, but the DEFAULT stays draw+deploy: pay is opt-in, never implicit', () => {
    assert.deepEqual([...VAULT_METHODS], ['draw', 'deploy', 'pay']); assert.deepEqual([...DEFAULT_METHODS], ['draw', 'deploy']);
    const l = normalizeLimits('near', { maxFeePerTx: 1n, allowedTargets: [vault] });
    assert.deepEqual([...l.allowedMethods], ['draw', 'deploy']);
    refused(() => enforceCall('near', pay(), l), 'method_not_permitted');
  });
  test('an exact pay to the vault is accepted; memo optional; amount may be a string, bigint or safe integer', () => {
    const l = normalizeLimits('near', limits);
    assert.equal(enforceCall('near', pay(), l), vault);
    assert.equal(enforceCall('near', pay({ memo: 'invoice 1' }), l), vault); assert.equal(enforceCall('near', pay({ memo: null }), l), vault);
    assert.equal(enforceCall('near', pay({ amount: 5n }), l), vault); assert.equal(enforceCall('near', pay({ amount: 5 }), l), vault);
  });
  test('pay to a non-vault target is refused (the vault is the only target), before anything is signed', () => {
    const l = normalizeLimits('near', limits);
    refused(() => enforceCall('near', pay({}, 'attacker.testnet'), l), 'target_not_permitted');
    refused(() => enforceCall('near', pay({}, USDC), l), 'target_not_permitted'); // not even the token contract itself
    refused(() => enforceCall('near', pay({}, ALICE), l), 'target_not_permitted');
  });
  test('wrong argument shape is refused: unknown keys, missing/invalid token or payee, the vault as token or payee, bad amount, memo over 128 bytes', () => {
    const l = normalizeLimits('near', limits);
    refused(() => enforceCall('near', pay({ deposit: '1' }), l), 'bad_call'); refused(() => enforceCall('near', pay({ receiver_id: ALICE }), l), 'bad_call');
    refused(() => enforceCall('near', pay({ token: undefined }), l), 'bad_call'); refused(() => enforceCall('near', pay({ to: 'BAD' }), l), 'bad_call');
    refused(() => enforceCall('near', pay({ token: 'x' }), l), 'bad_call'); refused(() => enforceCall('near', pay({ to: vault }), l), 'bad_call'); refused(() => enforceCall('near', pay({ token: vault }), l), 'bad_call');
    refused(() => enforceCall('near', pay({ to: USDC }), l), 'bad_call'); refused(() => enforceCall('near', pay({ to: 'system' }), l), 'bad_call');
    for (const amount of ['0', 0, -1, '1.5', 'abc', '', null, undefined, 1.5, 2 ** 60, String(1n << 128n), {}]) refused(() => enforceCall('near', pay({ amount }), l), 'bad_call');
    refused(() => enforceCall('near', pay({ memo: 'x'.repeat(129) }), l), 'bad_call'); refused(() => enforceCall('near', pay({ memo: 5 }), l), 'bad_call');
    assert.equal(enforceCall('near', pay({ memo: 'x'.repeat(128) }), l), vault);
    refused(() => enforceCall('near', { method: 'pay', target: vault }, l), 'bad_call');
    refused(() => enforceCall('near', { ...pay(), deposit: '1' }, l), 'bad_call'); refused(() => enforceCall('near', { ...pay(), gas: '1' }, l), 'bad_call');
  });
  test('owner methods and everything else are still refused, even when listed in allowedMethods', () => {
    for (const m of ['allow_token', 'disallow_token', 'allow_payee', 'disallow_payee', 'withdraw_token', 'withdraw', 'set_mandate', 'revoke', 'pause', 'allow_template', 'ft_transfer', 'storage_deposit', 'mint']) {
      refused(() => normalizeLimits('near', { ...limits, allowedMethods: ['pay', m] }), 'method_not_permitted');
      refused(() => enforceCall('near', { method: m, target: vault, args: { token: USDC, account: ALICE, amount: '1' } }, normalizeLimits('near', limits)), 'method_not_permitted');
    }
  });
  test('pay does not exist on EVM: neither as an allowed method nor as a call', () => {
    refused(() => normalizeLimits('evm', { maxFeePerTx: 1n, allowedTargets: ['0x' + '1'.repeat(40)], allowedMethods: ['pay'] }), 'method_not_permitted');
    const l = normalizeLimits('evm', { maxFeePerTx: 1n, allowedTargets: ['0x' + '1'.repeat(40)] });
    refused(() => enforceCall('evm', { method: 'pay', target: '0x' + '1'.repeat(40), args: { token: USDC, to: ALICE, amount: '1' } }, l), 'method_not_permitted');
  });

  // ---- end to end through the NEAR signer against a fake RPC: the exact bytes, the gas, the fee bound
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const pub = near.ed25519PublicKey(seed); const sign = near.ed25519Signer(seed);
  const key = { accountId: near.implicitAccountId(pub), publicKey: pub, publicKeyString: near.formatPublicKey(pub), sign };
  const bh = Buffer.alloc(32, 7);
  function fakeNode(sent = []) {
    return async (_u, init) => {
      const { method, params, id } = JSON.parse(init.body);
      const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
      if (method === 'status') return ok({ chain_id: 'testnet' });
      if (method === 'gas_price') return ok({ gas_price: '100000000' });
      if (method === 'query') return ok({ nonce: 41, block_hash: (await import('../src/agent/base58.js')).base58Encode(bh), permission: 'FullAccess' });
      if (method === 'send_tx') { sent.push(params); return ok({ final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' }, transaction_outcome: { outcome: { status: { SuccessReceiptId: 'x' }, tokens_burnt: '1', gas_burnt: 1 } }, receipts_outcome: [] }); }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } }), { status: 200 });
    };
  }
  test('encodes pay as JSON { token, to, amount (string), memo } with 100 Tgas, 0 deposit; the fee bound is gas x price x 1.5', async () => {
    const sent = []; const signer = near.createNearSigner({ key, rpcUrl: 'https://rpc.testnet.near.org', fetchImpl: fakeNode(sent), pollMs: 1, sleep: async () => {} });
    const r = await signer.signAndSend(pay({ memo: 'invoice 42', amount: 25000000n }), limits);
    assert.equal(r.ok, true); assert.equal(r.method, 'pay'); assert.equal(r.attachedGas, String(100n * 10n ** 12n));
    assert.equal(r.maxFeeBound, String((100n * 10n ** 12n * 100000000n * 150n + 99n) / 100n));
    const bytes = Buffer.from(sent[0].signed_tx_base64, 'base64');
    const txBytes = bytes.subarray(0, bytes.length - 65);
    const expected = near.serializeTransaction({ signerId: key.accountId, publicKey: pub, nonce: 42n, receiverId: vault, blockHash: bh, actions: [near.functionCall('pay', JSON.stringify({ token: USDC, to: ALICE, amount: '25000000', memo: 'invoice 42' }), 100n * 10n ** 12n, 0n)] });
    assert.equal(Buffer.from(txBytes).toString('hex'), Buffer.from(expected).toString('hex'));
  });
  test('the signer refuses a pay with the fee ceiling too low, a non-vault target, or bad args, sending nothing', async () => {
    const sent = []; const signer = near.createNearSigner({ key, rpcUrl: 'https://rpc.testnet.near.org', fetchImpl: fakeNode(sent), pollMs: 1, sleep: async () => {} });
    await assert.rejects(signer.signAndSend(pay({}, 'attacker.testnet'), limits), /target_not_permitted/);
    await assert.rejects(signer.signAndSend(pay({ amount: '0' }), limits), /bad_call/);
    await assert.rejects(signer.signAndSend(pay({ extra: 1 }), limits), /bad_call/);
    await assert.rejects(signer.signAndSend({ method: 'withdraw_token', target: vault, args: { token: USDC, amount: '1' } }, limits), /method_not_permitted/);
    await assert.rejects(signer.signAndSend(pay(), { ...limits, maxFeePerTx: 1000n }), (e) => e instanceof LimitError && e.code === 'fee_ceiling');
    await assert.rejects(signer.signAndSend(pay(), { maxFeePerTx: 10n ** 23n, allowedTargets: [vault] }), /method_not_permitted/); // default limits: no pay
    assert.equal(sent.length, 0);
  });
  test('defaultEncodeArgs: pay is validated again at encoding time; unknown methods have no encoding', () => {
    assert.deepEqual(near.defaultEncodeArgs('pay', { token: USDC, to: ALICE, amount: 5n }), { token: USDC, to: ALICE, amount: '5' });
    assert.throws(() => near.defaultEncodeArgs('pay', { token: USDC, to: 'BAD', amount: 5 }), LimitError);
    assert.throws(() => near.defaultEncodeArgs('pay', { token: USDC, to: ALICE, amount: 0 }), LimitError);
    assert.throws(() => near.defaultEncodeArgs('pay', { token: USDC, to: ALICE, amount: 1n << 128n }), LimitError);
    assert.throws(() => near.defaultEncodeArgs('withdraw_token', { token: USDC, amount: 1 }), LimitError);
    assert.deepEqual(near.defaultEncodeArgs('draw', { amount: 7 }), { amount: '7' });
  });
});

describe('payments migration', () => {
  test('migrations/0004_payments.sql is exactly the generated SCHEMA_V4, additive only, and applies twice (idempotent) on top of 0001..0003', () => {
    const sql = readFileSync(new URL('../migrations/0004_payments.sql', import.meta.url), 'utf8');
    assert.ok(sql.endsWith(SCHEMA_V4), 'regenerate with: node scripts/gen-migration.mjs');
    assert.doesNotMatch(SCHEMA_V4, /ALTER TABLE|DROP |DELETE |UPDATE /i);
    const files = ['0001_init.sql', '0002_indexes.sql', '0003_vault.sql', '0004_payments.sql'].map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
    for (const [i, f] of ['0001', '0002', '0003'].entries()) assert.ok(files[i].endsWith([SCHEMA, SCHEMA_V2, SCHEMA_V3][i]), `${f} unchanged`);
    const raw = new DatabaseSync(':memory:');
    for (const s of files) raw.exec(s);
    raw.exec("INSERT INTO payments(id,decision_id,vault_id,token,payee,amount,tx_hash,status,verification,created_at) VALUES('p1','d1','v1','t','a','1','h1','verified','{}',1)");
    for (const s of files) raw.exec(s); // second application: no error, no data loss
    raw.exec(files[3]);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
    const cols = raw.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'decision_id', 'vault_id', 'token', 'payee', 'amount', 'tx_hash', 'status', 'verification', 'created_at']);
    assert.throws(() => raw.exec("INSERT INTO payments VALUES('p2','d1','v1','t','a','1','h2','verified','{}',1)"), /UNIQUE/, 'one payment per decision');
    assert.throws(() => raw.exec("INSERT INTO payments VALUES('p3','d3','v1','t','a','1','h1','verified','{}',1)"), /UNIQUE/, 'one tx proves one payment');
  });
  test('openDb creates the table and can be re-opened over an existing database (idempotent exec of every schema)', async () => {
    const db = await openDb({ path: ':memory:' });
    await db.exec(SCHEMA_V4); await db.exec(SCHEMA_V4);
    assert.equal((await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'")).name, 'payments');
    assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='payments_by_vault'"));
  });
});
