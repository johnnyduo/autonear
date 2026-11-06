import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P } from './copy.js';
import { byteLen, parseTokenAmount, paymentRows, payBody, payFormOff, shortAccount, tokenView, validatePay } from './pay.js';

const tok = { token: 'usdc.testnet', symbol: 'USDC', decimals: 6, perPayCap: '100000000', periodCap: '250000000', totalCap: '1000000000', usage: { totalSpent: '300000000', periodSpent: '75000000' }, remaining: { period: '175000000', total: '700000000', maxPayment: '100000000' }, balance: '480000000', matches: true };
const owner = { address: '0xabc', isOwner: true };
const vault = { address: 'v.testnet', status: 'active', paused: false, mandate: { revoked: false }, payouts: { tokens: [tok], payees: [{ account: 'alice.testnet' }] } };

test('amounts typed by a person become base units and are never rounded', () => {
  assert.deepEqual(parseTokenAmount('25', 6), { base: 25000000n });
  assert.deepEqual(parseTokenAmount(' 12.5 ', 6), { base: 12500000n });
  assert.deepEqual(parseTokenAmount('0.000001', 6), { base: 1n });
  assert.deepEqual(parseTokenAmount('7', 0), { base: 7n });
  assert.deepEqual(parseTokenAmount('123456789012345678901234567890.5', 6), { base: 123456789012345678901234567890500000n });
  assert.equal(parseTokenAmount('1.0000001', 6).error, 'places');
  assert.equal(parseTokenAmount('1.5', 0).error, 'places');
  assert.equal(parseTokenAmount('0', 6).error, 'zero'); assert.equal(parseTokenAmount('0.000', 6).error, 'zero');
  for (const bad of ['', '  ']) assert.equal(parseTokenAmount(bad, 6).error, 'empty');
  for (const bad of ['-1', '1e3', '1,5', '.5', '5.', 'abc', '0x10', '1 2', '+3']) assert.equal(parseTokenAmount(bad, 6).error, 'format', bad);
});
test('account ids are shortened only when long', () => {
  assert.equal(shortAccount('alice.testnet'), 'alice.testnet');
  const id = 'a'.repeat(64); const s = shortAccount(id);
  assert.ok(s.length < 30 && s.includes('…') && s.startsWith('aaaa') && s.endsWith('aaaa'));
  assert.equal(shortAccount(null), '');
});
test('a token is shown with exact caps, what is left, and the balance (null = unknown)', () => {
  const v = tokenView(tok);
  assert.equal(v.usable, true);
  assert.equal(v.each.cap, '100 USDC'); assert.equal(v.period.cap, '250 USDC'); assert.equal(v.period.left, '175 USDC'); assert.equal(v.total.left, '700 USDC');
  assert.equal(v.balance, '480 USDC'); assert.equal(v.maxPaymentText, '100 USDC');
  assert.equal(v.period.frac, 0.3); assert.equal(v.total.frac, 0.3);
  assert.equal(tokenView({ ...tok, balance: null }).balance, null);
  assert.equal(tokenView({ ...tok, remaining: { ...tok.remaining, period: '0' } }).period.none, true);
  const odd = tokenView({ ...tok, symbol: null, decimals: null });
  assert.equal(odd.usable, false); assert.equal(odd.each.cap, null);
  assert.equal(tokenView({ ...tok, matches: false }).usable, false);
});
test('the pay form is off with a reason: wallet, vault state, nothing set up', () => {
  assert.equal(payFormOff({ owner: {}, vault }), P.signIn);
  assert.equal(payFormOff({ owner: { address: '0x1', isOwner: false }, vault }), null);
  assert.equal(payFormOff({ owner, demo: true, vault }), null);
  assert.equal(payFormOff({ owner, vault: { ...vault, payouts: undefined } }), P.offNoBuild);
  assert.equal(payFormOff({ owner, vault: { ...vault, status: 'pending' } }), P.offNotOn);
  assert.equal(payFormOff({ owner, vault: { ...vault, mandate: null } }), P.offNotOn);
  assert.equal(payFormOff({ owner, vault: { ...vault, mandate: { revoked: true } } }), P.offNotOn);
  assert.equal(payFormOff({ owner, vault: { ...vault, paused: true } }), P.offPaused);
  assert.equal(payFormOff({ owner, vault, stopped: true }), P.offPaused);
  assert.equal(payFormOff({ owner, vault: { ...vault, payouts: { tokens: [tok], payees: [] } } }), P.offNone);
  assert.equal(payFormOff({ owner, vault: { ...vault, payouts: { tokens: [], payees: [{ account: 'a.testnet' }] } } }), P.offNone);
  assert.equal(payFormOff({ owner, vault }), '');
});
test('form checks give one plain sentence per field', () => {
  const tv = tokenView(tok);
  const base = { tv, payee: 'alice.testnet', amount: '25' };
  assert.deepEqual(validatePay(base), { ok: true, base: 25000000n, errors: {}, warn: undefined });
  assert.equal(validatePay({ ...base, payee: '' }).errors.payee, P.fPayeeNeeded);
  assert.equal(validatePay({ ...base, amount: '' }).errors.amount, P.fEnter);
  assert.equal(validatePay({ ...base, amount: 'x' }).errors.amount, P.fFormat);
  assert.equal(validatePay({ ...base, amount: '0' }).errors.amount, P.fZero);
  assert.match(validatePay({ ...base, amount: '1.1234567' }).errors.amount, /USDC has at most 6 decimal places/);
  assert.match(validatePay({ ...base, amount: '100.000001' }).errors.amount, /The most is 100 USDC/);
  assert.equal(validatePay({ ...base, amount: '100' }).ok, true);
  assert.equal(validatePay({ ...base, tv: tokenView({ ...tok, remaining: { ...tok.remaining, maxPayment: '0' } }) }).errors.amount, P.fNoRoom);
  assert.equal(validatePay({ ...base, note: 'é'.repeat(65) }).errors.note, P.fNote2); // 65 x 2 bytes = 130
  assert.equal(validatePay({ ...base, note: 'é'.repeat(64) }).ok, true);
  assert.equal(validatePay({ ...base, reference: 'x'.repeat(129) }).errors.reference, P.fRef2);
  assert.equal(validatePay({ ...base, amount: '90', tv: tokenView({ ...tok, balance: '1000000' }) }).warn, P.fLow); // warns, does not block
  assert.equal(validatePay({ ...base, amount: '90', tv: tokenView({ ...tok, balance: '1000000' }) }).ok, true);
  assert.ok(validatePay({ ...base, tv: tokenView({ ...tok, symbol: null }) }).errors.amount);
  assert.equal(byteLen('é'), 2);
});
test('the request body carries base units as a string and leaves empty optional fields out', () => {
  assert.deepEqual(payBody({ vault, token: 'usdc.testnet', payee: 'alice.testnet', base: 25000000n, note: ' invoice 42 ', reference: '' }), { vault: 'v.testnet', token: 'usdc.testnet', payee: 'alice.testnet', amount: '25000000', memo: 'invoice 42' });
  assert.deepEqual(payBody({ vault, token: 't', payee: 'p', base: 5n, note: '', reference: 'ref-1' }), { vault: 'v.testnet', token: 't', payee: 'p', amount: '5', reference: 'ref-1' });
});
test('payment rows: this vault only, newest first, plain states, link only when given', () => {
  const items = [
    { decisionId: 'a', vault: 'v.testnet', payee: 'alice.testnet', amount: '25000000', decimals: 6, symbol: 'USDC', memo: 'invoice 42', status: 'executed', effectiveStatus: 'executed', createdAt: 100, payment: { recordedAt: 150, explorerUrl: 'https://x/tx' } },
    { decisionId: 'b', vault: 'v.testnet', payee: 'bob.testnet', amount: '5', decimals: 6, symbol: 'USDC', memo: '', status: 'pending', effectiveStatus: 'pending', createdAt: 200, payment: null },
    { decisionId: 'c', vault: 'other.testnet', payee: 'x', amount: '1', decimals: 6, symbol: 'USDC', status: 'pending', effectiveStatus: 'pending', createdAt: 300 },
  ];
  const rows = paymentRows({ items }, vault);
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a']);
  assert.equal(rows[0].state, 'Waiting for your OK'); assert.equal(rows[0].amount, '0.000005 USDC'); assert.equal(rows[0].link, '');
  assert.equal(rows[1].state, 'Paid'); assert.equal(rows[1].link, 'https://x/tx'); assert.equal(rows[1].when, 150); assert.equal(rows[1].done, true);
  assert.deepEqual(paymentRows(null, vault), []);
});
