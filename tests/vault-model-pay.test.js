// Payouts in the JS model (src/vault-model.js). Mirrors the named Rust tests of contracts/near-vault/src/tests_pay.rs one to one where the
// behaviour is observable from the model; contracts/vault-conformance-pay.json (tests/vault-pay-conformance.test.js) is the shared check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultModel, VaultError, ERROR_CODES, ALL_ERROR_CODES, PAYOUT_ERROR_CODES, LIMITS } from '../src/vault-model.js';

const DAY = 86_400, USDC = 1_000_000n, NEAR = 10n ** 24n;
const T0 = 1_700_000_000;
const OWNER = 'owner.testnet', AGENT = 'agent.testnet', OTHER = 'other.testnet', NEW_OWNER = 'newowner.testnet', VAULT = 'vault.testnet';
const TOKEN = 'usdc.testnet', TOKEN2 = 'usdt.testnet', PAYEE = 'alice.testnet', PAYEE2 = 'bob.testnet';
const code = (fn) => { try { fn(); } catch (e) { return e instanceof VaultError ? e.code : `NON_VAULT:${e}`; } return 'ok'; };

class Fx {
  constructor(avail = 1000n * NEAR) { this.m = new VaultModel({ chain: 'near', owner: OWNER, balance: avail, vaultId: VAULT, networkId: 'testnet' }); this.t = T0; }
  static withMandate() { const f = new Fx(); f.setMandate(); return f; }
  static ready() { const f = Fx.withMandate(); f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC); f.allowPayee(PAYEE); return f; }
  setMandate(agent = AGENT) { this.m.exec('set_mandate', OWNER, { agent, expires_at: this.t + DAY, per_draw_cap: 10n * NEAR, period_secs: 3600, period_cap: 25n * NEAR, total_cap: 100n * NEAR, max_deploys: 5 }, this.t); }
  allowToken(token, per, period, total, as = OWNER) { return this.m.exec('allow_token', as, { token, per_pay_cap: per, period_cap: period, total_cap: total }, this.t); }
  allowPayee(a, as = OWNER) { return this.m.exec('allow_payee', as, { account: a }, this.t); }
  pay(amount, { as = AGENT, token = TOKEN, to = PAYEE, memo } = {}) { return this.m.exec('pay', as, { token, to, amount, ...(memo === undefined ? {} : { memo }) }, this.t); }
  payCode(amount, o) { return code(() => this.pay(amount, o)); }
  usage(token = TOKEN) { const u = this.m.tokenUsageView(token); return [u.totalSpent, u.periodSpent]; }
  preview(token, to, amount) { return this.m.previewPay(token, to, amount, { now: this.t }); }
  events() { return this.m.events.map((e) => e.type); }
}

test('error lists: v1 list untouched, payout codes separate, everything in ALL_ERROR_CODES', () => {
  assert.equal(ERROR_CODES.length, 17);
  assert.deepEqual([...PAYOUT_ERROR_CODES], ['TokenNotAllowed', 'PayeeNotAllowed', 'PerPayCap', 'BadToken', 'BadPayee', 'BadMemo']);
  assert.deepEqual([...ALL_ERROR_CODES], [...ERROR_CODES, ...PAYOUT_ERROR_CODES]);
  assert.deepEqual([LIMITS.maxTokens, LIMITS.maxPayees, LIMITS.maxMemoBytes], [8, 64, 128]);
});

test('a v1 model is untouched by payouts: no token configured -> snapshot has no payouts key and v1 ops behave as before', () => {
  const m = new VaultModel({ chain: 'near', owner: 'owner', balance: 100n });
  m.exec('set_mandate', 'owner', { agent: 'agent', expires_at: 10_000, per_draw_cap: 100, period_secs: 600, period_cap: 250, total_cap: 400, max_deploys: 3 }, 1000);
  m.exec('draw', 'agent', { amount: 7 }, 1001);
  assert.equal('payouts' in m.snapshot(1001), false);
  assert.equal(m.available(), 93n);
  assert.deepEqual([...m.tokens], []); assert.equal(m.payees.size, 0);
  assert.equal(m.previewPay('t', 'p', 1, { now: 1001 }), 'TokenNotAllowed');
});

test('fresh vault: no tokens or payees, preview NoMandate, no period state', () => {
  const f = new Fx(5n * NEAR);
  assert.deepEqual(f.m.tokenList(), []); assert.deepEqual(f.m.payeeList(), []);
  assert.deepEqual(f.usage(), [0n, 0n]);
  assert.equal(f.m.tokenPeriodState(TOKEN, T0), null);
  assert.equal(f.preview(TOKEN, PAYEE, 1), 'NoMandate');
});

test('allow_token rejects bad inputs and updates in place', () => {
  const f = Fx.withMandate();
  const bad = (token, a, b, c) => code(() => f.allowToken(token, a, b, c));
  assert.equal(bad(TOKEN, 0, 5, 5), 'BadToken'); assert.equal(bad(TOKEN, 6, 5, 9), 'BadToken'); assert.equal(bad(TOKEN, 5, 9, 8), 'BadToken');
  assert.equal(bad(VAULT, 1, 1, 1), 'BadToken'); assert.equal(bad('system', 1, 1, 1), 'BadToken'); assert.equal(bad('0'.repeat(64), 1, 1, 1), 'BadToken');
  assert.equal(bad('', 1, 1, 1), 'BadToken');
  assert.equal(bad(TOKEN, 1, 1, -1), 'BadToken'); assert.equal(bad(TOKEN, 'x', 1, 1), 'BadToken'); assert.equal(bad(TOKEN, 1, 1, 1n << 128n), 'BadToken');
  assert.deepEqual(f.m.tokenList(), []);
  f.allowToken(TOKEN, 5, 5, 5);
  assert.deepEqual(f.m.events.at(-1), { seq: f.m.events.at(-1).seq, type: 'TokenAllowed', token: TOKEN, perPayCap: 5n, periodCap: 5n, totalCap: 5n, updated: false });
  f.allowToken(TOKEN, 6, 7, 8);
  assert.equal(f.m.events.at(-1).updated, true);
  assert.deepEqual(f.m.tokenList(), [{ token: TOKEN, perPayCap: 6n, periodCap: 7n, totalCap: 8n }]);
  f.allowToken(TOKEN, '6', '7', (1n << 128n) - 1n);   // decimal strings and the u128 maximum are fine
});

test('token count is capped at 8 but updates still work', () => {
  const f = Fx.withMandate();
  for (let i = 0; i < 8; i++) f.allowToken(`t${i}.testnet`, 1, 1, 1);
  assert.equal(code(() => f.allowToken('t8.testnet', 1, 1, 1)), 'BadToken');
  f.allowToken('t3.testnet', 2, 3, 4);
  assert.equal(f.m.tokenList().length, 8);
  f.m.exec('disallow_token', OWNER, { token: 't0.testnet' }, f.t);
  f.allowToken('t8.testnet', 1, 1, 1);
});

test('disallow_token unknown reverts, emits on change only', () => {
  const f = Fx.ready();
  const n = f.m.events.length;
  assert.equal(code(() => f.m.exec('disallow_token', OWNER, { token: TOKEN2 }, f.t)), 'TokenNotAllowed');
  assert.equal(f.m.events.length, n);
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t);
  assert.equal(f.m.events.at(-1).type, 'TokenDisallowed'); assert.deepEqual(f.m.tokenList(), []);
});

test('allow_payee rules, pagination and idempotence', () => {
  const f = Fx.ready();
  for (const bad of [VAULT, 'system', '0'.repeat(64), TOKEN, '']) assert.equal(code(() => f.allowPayee(bad)), 'BadPayee', bad);
  assert.equal(code(() => f.allowToken(PAYEE, 1, 1, 1)), 'BadToken');   // a payee cannot become a token either
  const n = f.m.events.length;
  f.allowPayee(PAYEE); assert.equal(f.m.events.length, n, 'idempotent: no event');
  f.allowPayee(PAYEE2); assert.equal(f.m.events.at(-1).type, 'PayeeAllowed');
  assert.deepEqual(f.m.payeeList(1, 5), [PAYEE2]); assert.deepEqual(f.m.payeeList(2), []);
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t); f.allowPayee(TOKEN);   // a disallowed token can be listed as a payee
  assert.equal(code(() => f.m.exec('disallow_payee', OWNER, { account: 'nobody.testnet' }, f.t)), 'PayeeNotAllowed');
  f.m.exec('disallow_payee', OWNER, { account: PAYEE }, f.t); assert.equal(f.m.events.at(-1).type, 'PayeeDisallowed');
  assert.equal(f.m.payees.size, 2);
});

test('payee count is capped at 64', () => {
  const f = Fx.withMandate();
  for (let i = 0; i < 64; i++) f.allowPayee(`p${i}.testnet`);
  assert.equal(code(() => f.allowPayee('p64.testnet')), 'BadPayee');
  f.allowPayee('p10.testnet');   // already listed: no-op even when full
  assert.equal(f.m.payeeList(0, 100).length, 64);
});

test('only the owner reaches owner methods and only the agent pays', () => {
  const f = Fx.ready();
  for (const who of [AGENT, OTHER, NEW_OWNER]) {
    assert.equal(code(() => f.allowToken(TOKEN2, 1, 1, 1, who)), 'Unauthorized', who);
    assert.equal(code(() => f.m.exec('disallow_token', who, { token: TOKEN }, f.t)), 'Unauthorized');
    assert.equal(code(() => f.allowPayee(PAYEE2, who)), 'Unauthorized');
    assert.equal(code(() => f.m.exec('disallow_payee', who, { account: PAYEE }, f.t)), 'Unauthorized');
    assert.equal(code(() => f.m.exec('withdraw_token', who, { token: TOKEN, amount: 1 }, f.t)), 'Unauthorized');
  }
  for (const who of [OWNER, OTHER, PAYEE]) assert.equal(f.payCode(USDC, { as: who }), 'Unauthorized', who);
  assert.deepEqual(f.usage(), [0n, 0n]);
  assert.equal(f.m.tokenList().length, 1); assert.deepEqual([...f.m.payees], [PAYEE]);
});

test('pay returns the one ft_transfer to make, charges optimistically and takes only the call deposit', () => {
  const f = Fx.ready(); const before = f.m.balance;
  const r = f.pay(7n * USDC, { memo: 'invoice 42' });
  assert.deepEqual({ ...r }, { token: TOKEN, to: PAYEE, amount: 7n * USDC, memo: 'invoice 42', epoch: 1n, periodIndex: 0n });
  assert.equal(before - f.m.balance, 1n, 'only the 1 yocto leaves the vault');
  assert.deepEqual(f.usage(), [7n * USDC, 7n * USDC]);
  const e = f.m.events.at(-1);
  assert.equal(e.type, 'Paid'); assert.equal(e.agent, AGENT); assert.equal(e.memo, 'invoice 42'); assert.equal(e.totalSpent, 7n * USDC);
  assert.equal(f.m.tokenSentTo(TOKEN, PAYEE), 7n * USDC);
  assert.equal(f.pay(USDC).memo, null, 'no memo -> null');
});

test('pay never touches the NEAR budget and a NEAR draw never touches token usage', () => {
  const f = Fx.ready();
  f.pay(5n * USDC);
  assert.deepEqual([f.m.usage.totalSpent, f.m.usage.periodSpent], [0n, 0n]);
  f.m.exec('draw', AGENT, { amount: NEAR }, f.t);
  assert.deepEqual(f.usage(), [5n * USDC, 5n * USDC]);
});

test('pay rules run in the documented order', () => {
  const f = new Fx(100n * NEAR);
  assert.equal(f.payCode(1), 'NoMandate');
  f.setMandate(); f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC); f.allowPayee(PAYEE);
  const ghost = { token: TOKEN2, to: 'nobody.testnet' };
  assert.equal(f.payCode(0, { as: OTHER, ...ghost }), 'Unauthorized');
  f.m.exec('pause', OWNER, {}, f.t);
  assert.equal(f.payCode(0, ghost), 'Paused');
  f.m.exec('unpause', OWNER, {}, f.t);
  assert.equal(f.payCode(0, ghost), 'TokenNotAllowed');
  assert.equal(f.payCode(0, { to: 'nobody.testnet' }), 'PayeeNotAllowed');
  assert.equal(f.payCode(0), 'BadAmount');
  assert.equal(f.payCode(10n * USDC + 1n), 'PerPayCap');
  f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 25n * USDC);
  f.pay(10n * USDC); f.pay(10n * USDC);
  assert.equal(f.payCode(6n * USDC), 'PeriodCap');
  f.t += 3600;
  assert.equal(f.payCode(6n * USDC), 'TotalCap');
  f.pay(5n * USDC); assert.equal(f.payCode(1), 'TotalCap');
  f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC);
  const long = 'x'.repeat(LIMITS.maxMemoBytes + 1);
  assert.equal(f.payCode(0, { memo: long }), 'BadAmount'); assert.equal(f.payCode(1, { memo: long }), 'BadMemo');
  f.pay(1, { memo: 'y'.repeat(LIMITS.maxMemoBytes) });
  f.m.balance = 0n;
  assert.equal(f.payCode(1, { memo: long }), 'BadMemo', 'memo before balance'); assert.equal(f.payCode(1), 'InsufficientBalance');
});

test('memo limit counts bytes, not chars', () => {
  const f = Fx.ready();
  f.pay(1, { memo: 'é'.repeat(LIMITS.maxMemoBytes / 2) });
  assert.equal(f.payCode(1, { memo: 'é'.repeat(LIMITS.maxMemoBytes / 2 + 1) }), 'BadMemo');
  assert.equal(f.payCode(1, { memo: 5 }), 'BadMemo', 'a non-string memo is refused, not coerced');
  f.pay(1, { memo: '' });
});

test('revoke, pause and expiry (exclusive) block pay', () => {
  let f = Fx.ready();
  f.m.exec('pause', OWNER, {}, f.t); assert.equal(f.payCode(1), 'Paused'); f.m.exec('unpause', OWNER, {}, f.t);
  f.pay(1);
  f.t = T0 + DAY - 1; f.pay(1);
  f.t = T0 + DAY; assert.equal(f.payCode(1), 'MandateInactive');
  f = Fx.ready(); f.m.exec('revoke', OWNER, {}, f.t);
  assert.equal(f.payCode(1), 'MandateInactive'); assert.deepEqual(f.usage(), [0n, 0n]);
});

test('the agent can never pay a non-allowlisted payee or token', () => {
  const f = Fx.ready();
  for (const to of [OWNER, AGENT, OTHER, VAULT, TOKEN, TOKEN2, PAYEE2]) assert.equal(f.payCode(USDC, { to }), 'PayeeNotAllowed', to);
  for (const token of [TOKEN2, OWNER, VAULT, PAYEE]) assert.equal(f.payCode(USDC, { token }), 'TokenNotAllowed', token);
  f.pay(USDC);
  f.m.exec('disallow_payee', OWNER, { account: PAYEE }, f.t); assert.equal(f.payCode(USDC), 'PayeeNotAllowed');
  f.allowPayee(PAYEE); f.pay(USDC);
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t); assert.equal(f.payCode(USDC), 'TokenNotAllowed');
  f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC); f.allowPayee(AGENT);   // the owner's choice
  f.pay(USDC, { to: AGENT });
});

test('caps are per token and boundaries are inclusive', () => {
  const f = Fx.ready(); f.allowToken(TOKEN2, 3n * USDC, 4n * USDC, 5n * USDC);
  f.pay(10n * USDC); f.pay(10n * USDC); f.pay(5n * USDC);
  assert.equal(f.payCode(1), 'PeriodCap'); assert.deepEqual(f.usage(), [25n * USDC, 25n * USDC]); assert.deepEqual(f.usage(TOKEN2), [0n, 0n]);
  f.pay(3n * USDC, { token: TOKEN2 }); assert.equal(f.payCode(3n * USDC, { token: TOKEN2 }), 'PeriodCap');
  for (let i = 0; i < 3; i++) { f.t += 3600; f.pay(10n * USDC); f.pay(10n * USDC); f.pay(5n * USDC); }
  assert.equal(f.usage()[0], 100n * USDC);
  f.t += 3600; assert.equal(f.payCode(1), 'TotalCap');
});

test('pay needs 1 yocto of spendable NEAR (exact edge, real yocto accounting)', () => {
  const f = Fx.ready(); f.m.balance = 0n;
  assert.equal(f.payCode(1), 'InsufficientBalance'); assert.equal(f.preview(TOKEN, PAYEE, 1), 'InsufficientBalance');
  assert.equal(code(() => f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: 1 }, f.t)), 'InsufficientBalance');
  f.m.balance = 1n; f.pay(1); assert.equal(f.m.balance, 0n);
  assert.equal(f.payCode(1), 'InsufficientBalance');
});

test('huge amounts never overflow (BigInt, u128 maximum)', () => {
  const MAX = (1n << 128n) - 1n;
  const f = Fx.withMandate(); f.allowToken(TOKEN, MAX, MAX, MAX); f.allowPayee(PAYEE);
  f.pay(MAX - 1n); assert.equal(f.payCode(2), 'PeriodCap'); f.pay(1n);
  assert.deepEqual(f.usage(), [MAX, MAX]); assert.equal(f.payCode(1), 'PeriodCap');
  assert.equal(f.payCode(MAX + 1n), 'BadAmount', 'beyond u128 is not an amount');
  f.m.onPaid({ epoch: 1, periodIndex: 0, token: TOKEN, to: PAYEE, amount: MAX }); f.m.onPaid({ epoch: 1, periodIndex: 0, token: TOKEN, to: PAYEE, amount: MAX });
  assert.deepEqual(f.usage(), [0n, 0n]);
});

test('token_period_state tracks rollover and remaining', () => {
  const f = Fx.ready(); f.pay(10n * USDC);
  let s = f.m.tokenPeriodState(TOKEN, f.t);
  assert.deepEqual([s.periodIndex, s.periodStart, s.periodEnd, s.periodSpent, s.periodRemaining, s.totalSpent, s.totalRemaining, s.active], [0n, BigInt(T0), BigInt(T0 + 3600), 10n * USDC, 15n * USDC, 10n * USDC, 90n * USDC, true]);
  s = f.m.tokenPeriodState(TOKEN, T0 + 3600);
  assert.deepEqual([s.periodIndex, s.periodSpent, s.periodRemaining, s.totalRemaining], [1n, 0n, 25n * USDC, 90n * USDC]);
  assert.equal(f.m.tokenPeriodState(TOKEN, T0 + DAY).active, false);
  assert.equal(f.m.tokenPeriodState(TOKEN2, f.t), null);
  assert.equal(f.m.tokenPeriodSpent(TOKEN, T0 + 3600), 0n);
});

test('a time before the mandate start is period 0 (the contract saturates; v1 periodIndex does not)', () => {
  const f = Fx.ready();
  f.t = T0 - 5; f.pay(1);
  assert.equal(f.m.tokenUsageView(TOKEN).periodIndex, 0n);
});

test('preview_pay matches the real call over a sweep', () => {
  const f = Fx.ready(); f.allowToken(TOKEN2, 3n * USDC, 4n * USDC, 5n * USDC);
  const cases = [[TOKEN, PAYEE, USDC], [TOKEN, PAYEE, 0n], [TOKEN, PAYEE, 10n * USDC], [TOKEN, PAYEE, 10n * USDC + 1n], [TOKEN, PAYEE2, USDC], [TOKEN2, PAYEE, 3n * USDC], [TOKEN2, PAYEE, 4n * USDC], ['nope.testnet', PAYEE, USDC], [TOKEN, OWNER, USDC], [TOKEN, PAYEE, (1n << 128n) - 1n]];
  for (let step = 0; step < 7; step++) {
    if (step === 1) { f.payCode(10n * USDC); f.payCode(10n * USDC); }
    if (step === 2) f.t += 3600;
    if (step === 3) f.m.exec('pause', OWNER, {}, f.t);
    if (step === 4) { f.m.exec('unpause', OWNER, {}, f.t); f.m.exec('revoke', OWNER, {}, f.t); }
    if (step === 5) f.setMandate();
    if (step === 6) f.t += DAY;
    for (const [token, to, amount] of cases) {
      const pv = f.preview(token, to, amount); const real = code(() => f.pay(amount, { token, to }));
      assert.equal(pv, real === 'ok' ? '' : real, `step ${step} ${token} ${to} ${amount}`);
    }
  }
  // previews assume the bound agent unless a caller is given; they carry an optional memo; they never mutate
  const g = Fx.ready();
  assert.equal(g.m.previewPay(TOKEN, PAYEE, 1, { caller: OTHER, now: g.t }), 'Unauthorized');
  assert.equal(g.m.previewPay(TOKEN, PAYEE, 1, { now: g.t, memo: 'x'.repeat(129) }), 'BadMemo');
  assert.deepEqual(g.usage(), [0n, 0n]);
});

test('re-allowing a token does not reset its usage', () => {
  const f = Fx.ready(); f.pay(10n * USDC); f.pay(10n * USDC);
  f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC); assert.deepEqual(f.usage(), [20n * USDC, 20n * USDC]);
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t); assert.deepEqual(f.usage(), [20n * USDC, 20n * USDC], 'usage survives disallow');
  f.allowToken(TOKEN, 10n * USDC, 25n * USDC, 100n * USDC); assert.deepEqual(f.usage(), [20n * USDC, 20n * USDC]);
  assert.equal(f.payCode(6n * USDC), 'PeriodCap'); f.pay(5n * USDC);
  f.allowToken(TOKEN, 10n * USDC, 30n * USDC, 100n * USDC); f.pay(5n * USDC);
});

test('set_mandate resets token usage for every token and keeps allowlists and caps', () => {
  const f = Fx.ready(); f.allowToken(TOKEN2, 3n * USDC, 4n * USDC, 5n * USDC);
  f.pay(10n * USDC); f.pay(3n * USDC, { token: TOKEN2 });
  f.setMandate();
  assert.deepEqual(f.usage(), [0n, 0n]); assert.deepEqual(f.usage(TOKEN2), [0n, 0n]);
  assert.equal(f.m.tokenPeriodState(TOKEN, f.t).periodRemaining, 25n * USDC);
  assert.equal(f.m.tokenList().length, 2); assert.equal(f.m.payees.size, 1);
  f.pay(10n * USDC); f.pay(10n * USDC); f.pay(5n * USDC); assert.equal(f.payCode(1), 'PeriodCap');
});

const fail = (f, args) => f.m.onPaid({ epoch: 1, periodIndex: 0, token: TOKEN, to: PAYEE, ...args });

test('a stale usage record cannot leak into a newer epoch via a late reversal', () => {
  const f = Fx.ready(); f.pay(4n * USDC); f.setMandate(); f.pay(2n * USDC);
  assert.deepEqual(f.usage(), [2n * USDC, 2n * USDC]);
  assert.equal(fail(f, { amount: 4n * USDC }), false);   // the epoch-1 transfer fails late: reported, not applied
  assert.deepEqual(f.usage(), [2n * USDC, 2n * USDC]);
  assert.equal(f.m.events.at(-1).type, 'PayFailed'); assert.equal(f.m.events.at(-1).reversed, false);
});

test('a late reversal with only a stale record changes nothing', () => {
  const f = Fx.ready(); f.pay(4n * USDC); f.setMandate();
  assert.equal(fail(f, { epoch: 2, amount: 4n * USDC }), false);
  assert.deepEqual(f.usage(), [0n, 0n]);
});

test('failed transfer reverses the charge and emits PayFailed; the refunded call deposit comes back', () => {
  const f = Fx.ready(); f.pay(10n * USDC); assert.equal(f.m.balance, 1000n * NEAR - 1n);
  assert.equal(fail(f, { amount: 10n * USDC }), true);
  assert.deepEqual(f.usage(), [0n, 0n]); assert.equal(f.m.balance, 1000n * NEAR);
  assert.equal(f.m.tokenSentTo(TOKEN, PAYEE), 0n);
  const e = f.m.events.at(-1); assert.equal(e.type, 'PayFailed'); assert.equal(e.reversed, true); assert.equal(e.amount, 10n * USDC);
  f.pay(10n * USDC); f.pay(10n * USDC); f.pay(5n * USDC);   // the whole budget is usable again
});

test('successful transfer keeps the charge and emits nothing', () => {
  const f = Fx.ready(); f.pay(10n * USDC); const n = f.m.events.length;
  assert.equal(f.m.onPaid({ epoch: 1, periodIndex: 0, token: TOKEN, to: PAYEE, amount: 10n * USDC }, false), null);
  assert.deepEqual(f.usage(), [10n * USDC, 10n * USDC]); assert.equal(f.m.events.length, n);
});

test('failed transfer after a mandate replacement does not touch the new epoch', () => {
  const f = Fx.ready(); f.pay(4n * USDC); f.setMandate(); f.pay(2n * USDC);
  fail(f, { amount: 4n * USDC });
  assert.deepEqual(f.usage(), [2n * USDC, 2n * USDC]); assert.equal(f.m.events.at(-1).reversed, false);
});

test('failed transfer after a period rollover reverses the total but not the new period', () => {
  const f = Fx.ready(); f.pay(4n * USDC); f.t += 3600; f.pay(3n * USDC);
  fail(f, { amount: 4n * USDC });
  const u = f.m.tokenUsageView(TOKEN);
  assert.deepEqual([u.totalSpent, u.periodIndex, u.periodSpent], [3n * USDC, 1n, 3n * USDC]);
});

test('failed transfer callback replay cannot underflow', () => {
  const f = Fx.ready(); f.pay(4n * USDC);
  fail(f, { amount: 4n * USDC }); fail(f, { amount: 4n * USDC });
  assert.deepEqual(f.usage(), [0n, 0n]);
  assert.equal(fail(f, { token: TOKEN2, amount: 4n * USDC }), false);   // no record for that token: report only
});

test('a reversal also works after the token was disallowed and never touches other tokens', () => {
  const f = Fx.ready(); f.allowToken(TOKEN2, 3n * USDC, 4n * USDC, 5n * USDC);
  f.pay(4n * USDC); f.pay(3n * USDC, { token: TOKEN2 });
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t);
  assert.equal(fail(f, { amount: 4n * USDC }), true);
  assert.deepEqual(f.usage(), [0n, 0n]); assert.deepEqual(f.usage(TOKEN2), [3n * USDC, 3n * USDC]);
});

test('pay callback does not touch the NEAR counters', () => {
  const f = Fx.ready(); f.m.exec('draw', AGENT, { amount: 2n * NEAR }, f.t); f.pay(USDC); fail(f, { amount: USDC });
  assert.equal(f.m.usage.totalSpent, 2n * NEAR);
});

test('withdraw_token goes to the OWNER only, charges nothing, and works while paused, revoked and expired', () => {
  const f = Fx.ready(); const before = f.m.balance;
  const r = f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: 9n * USDC }, f.t);
  assert.deepEqual({ ...r }, { token: TOKEN, to: OWNER, amount: 9n * USDC });
  assert.equal(before - f.m.balance, 1n); assert.equal(f.m.events.at(-1).type, 'TokenWithdrawn'); assert.deepEqual(f.usage(), [0n, 0n]);
  f.m.exec('pause', OWNER, {}, f.t); f.m.exec('revoke', OWNER, {}, f.t); f.t = T0 + 10 * DAY;
  assert.equal(f.payCode(1), 'Paused');
  f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: USDC }, f.t);
  f.m.exec('disallow_token', OWNER, { token: TOKEN }, f.t);
  f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: USDC }, f.t); f.m.exec('withdraw_token', OWNER, { token: TOKEN2, amount: USDC }, f.t);
  new VaultModel({ chain: 'near', owner: OWNER, balance: 10n * NEAR }).exec('withdraw_token', OWNER, { token: TOKEN, amount: 1 }, 5);   // no mandate ever
});

test('withdraw_token rejects zero and reserved tokens (BadToken before BadAmount); the current owner receives it', () => {
  const f = Fx.ready();
  assert.equal(code(() => f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: 0 }, f.t)), 'BadAmount');
  assert.equal(code(() => f.m.exec('withdraw_token', OWNER, { token: VAULT, amount: 0 }, f.t)), 'BadToken');
  assert.equal(code(() => f.m.exec('withdraw_token', OWNER, { token: 'system', amount: 1 }, f.t)), 'BadToken');
  assert.equal(code(() => f.m.exec('withdraw_token', OTHER, { token: VAULT, amount: 0 }, f.t)), 'Unauthorized');
  f.m.exec('transfer_ownership', OWNER, { to: NEW_OWNER }, f.t); f.m.exec('accept_ownership', NEW_OWNER, {}, f.t);
  assert.equal(code(() => f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: 1 }, f.t)), 'Unauthorized');
  assert.equal(f.m.exec('withdraw_token', NEW_OWNER, { token: TOKEN, amount: 1 }, f.t).to, NEW_OWNER);
});

test('withdraw_token callback failure only reports (and returns the call deposit); nothing is charged', () => {
  const f = Fx.ready(); f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: USDC }, f.t);
  assert.equal(f.m.onTokenWithdrawn({ token: TOKEN, to: OWNER, amount: USDC }), true);
  assert.equal(f.m.events.at(-1).type, 'TokenWithdrawFailed'); assert.equal(f.m.tokenSentTo(TOKEN, OWNER), 0n); assert.deepEqual(f.usage(), [0n, 0n]);
  assert.equal(f.m.onTokenWithdrawn({ token: TOKEN, to: OWNER, amount: USDC }, false), false);
});

test('a rejected payout op never mutates state; clone() carries the payout state', () => {
  const f = Fx.ready(); f.pay(3n * USDC); f.m.exec('withdraw_token', OWNER, { token: TOKEN, amount: 2 }, f.t);
  const s = (m) => JSON.stringify(m.snapshot(f.t), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) + m.events.length;
  const before = s(f.m);
  for (const fn of [() => f.pay(0), () => f.pay(11n * USDC), () => f.allowToken(TOKEN2, 0, 0, 0), () => f.allowPayee(VAULT), () => f.m.exec('disallow_payee', OWNER, { account: 'nobody.testnet' }, f.t), () => f.m.exec('withdraw_token', OWNER, { token: VAULT, amount: 1 }, f.t), () => f.pay(1, { as: OTHER })]) assert.notEqual(code(fn), 'ok');
  assert.equal(s(f.m), before);
  const c = f.m.clone(); assert.equal(s(c), before);
  c.exec('pay', AGENT, { token: TOKEN, to: PAYEE, amount: USDC }, f.t);
  assert.equal(s(f.m), before, 'the clone is independent');
});
