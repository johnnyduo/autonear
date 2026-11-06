import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultStatus, fuelState, budgetUse, withdrawCheck, maxText, shortAddr, payFuelWarning, payoutsNeedNote, mintCheck, mintCall, isMockToken, MINT_MAX_WHOLE, MINT_PRESETS, LOW_FUEL } from './vaultView.js';

const NEAR = 10n ** 24n;
test('vaultStatus: the most urgent thing wins, in a fixed order, and each state names the next step', () => {
  assert.equal(vaultStatus({ pendingMine: true, paused: true, stopped: true }).key, 'pending');
  assert.equal(vaultStatus({ paused: true, stopped: true, live: true }).key, 'paused'); assert.equal(vaultStatus({ paused: true }).action, 'unpause');
  assert.equal(vaultStatus({ stopped: true, live: true }).key, 'stopped'); assert.equal(vaultStatus({ stopped: true }).action, 'start');
  assert.equal(vaultStatus({ live: false }).key, 'nolimits'); assert.equal(vaultStatus({ live: false }).action, 'limits'); assert.equal(vaultStatus({ live: false, demo: true }).action, null, 'a made-up vault has nowhere to go');
  const ok = vaultStatus({ live: true }); assert.equal(ok.key, 'live'); assert.equal(ok.tone, 'ok'); assert.equal(ok.action, null);
  for (const s of [{ pendingMine: true }, { paused: true }, { stopped: true }, {}, { live: true }]) { const r = vaultStatus(s); assert.ok(r.title.length > 10 && r.text.length > 20 && r.chip, JSON.stringify(s)); }
});
test('fuelState: low below 0.05 NEAR, ok at or above it, unknown when the chain or the balance is unknown', () => {
  assert.equal(fuelState({ agentBalance: String(LOW_FUEL.near - 1n) }, 'near'), 'low'); assert.equal(fuelState({ agentBalance: String(LOW_FUEL.near) }, 'near'), 'ok');
  assert.equal(fuelState({ agentBalance: '0' }, 'near'), 'low'); assert.equal(fuelState({ agentBalance: null }, 'near'), 'unknown'); assert.equal(fuelState({ agentBalance: '5' }, 'evm'), 'unknown'); assert.equal(fuelState({}, 'near'), 'unknown');
});
test('budgetUse: share of the total budget, null when no limits are on or revoked', () => {
  assert.equal(budgetUse({}), null); assert.equal(budgetUse({ mandate: { revoked: true, totalCap: '10' } }), null); assert.equal(budgetUse({ mandate: { totalCap: '0' } }), null);
  const u = budgetUse({ mandate: { totalCap: String(4n * NEAR) }, usage: { totalSpent: String(NEAR) } }); assert.equal(u.ratio, 0.25); assert.equal(u.used, NEAR);
  assert.equal(budgetUse({ mandate: { totalCap: '10' } }).ratio, 0, 'no usage yet'); assert.equal(budgetUse({ mandate: { totalCap: '10' }, usage: { totalSpent: '99' } }).ratio, 1, 'never above 100%');
});
test('withdrawCheck: empty is quiet; bad input, zero and too much each say why; a good amount returns base units', () => {
  const d = 24;
  assert.deepEqual(withdrawCheck('', String(NEAR), d), { base: null, error: '' }); assert.deepEqual(withdrawCheck('   ', String(NEAR), d), { base: null, error: '' });
  assert.match(withdrawCheck('abc', String(NEAR), d).error, /number/); assert.match(withdrawCheck('-1', String(NEAR), d).error, /number/); assert.match(withdrawCheck('1e3', String(NEAR), d).error, /number/);
  assert.match(withdrawCheck('0', String(NEAR), d).error, /more than zero/); assert.match(withdrawCheck('0.0', String(NEAR), d).error, /more than zero/);
  assert.match(withdrawCheck('1.0000001', String(NEAR), d).error, /more than the vault/);
  assert.deepEqual(withdrawCheck('0.5', String(NEAR), d), { base: NEAR / 2n, error: '' }); assert.deepEqual(withdrawCheck('1', String(NEAR), d), { base: NEAR, error: '' }, 'exactly everything is allowed');
  assert.match(withdrawCheck('1.5', '1', 0).error, /whole number/); assert.equal(withdrawCheck('1', null, d).base, NEAR, 'an unknown balance does not block (the chain decides)');
  assert.match(withdrawCheck(`0.${'1'.repeat(25)}`, String(NEAR), d).error, /decimals/);
});
test('maxText is the exact available amount, never rounded; empty when nothing to take', () => {
  assert.equal(maxText(String(NEAR + 1n), 24), '1.000000000000000000000001'); assert.equal(maxText(String(3n * NEAR / 2n), 24), '1.5'); assert.equal(maxText('0', 24), ''); assert.equal(maxText(null, 24), '');
  assert.equal(withdrawCheck(maxText(String(NEAR + 1n), 24), String(NEAR + 1n), 24).base, NEAR + 1n, 'pressing Max then Take back is always accepted');
});
test('shortAddr keeps short strings whole and shortens long ones in the middle', () => { assert.equal(shortAddr('vault.testnet'), 'vault.testnet'); assert.equal(shortAddr('0x5ebaddf71482d40044391923be1fc42938129988'), '0x5ebadd…129988'); assert.equal(shortAddr(null), ''); });

test('payFuelWarning: only a paying vault with NO spendable NEAR is warned; unknown balances and ordinary vaults are not', () => {
  assert.match(payFuelWarning({ payouts: { tokens: [] }, available: '0' }), /No payment can go out yet/);
  assert.equal(payFuelWarning({ payouts: { tokens: [] }, available: '1' }), ''); assert.equal(payFuelWarning({ payouts: { tokens: [] }, available: String(NEAR) }), '');
  assert.equal(payFuelWarning({ available: '0' }), '', 'a vault that cannot pay people needs no such warning'); assert.equal(payFuelWarning({ payouts: { tokens: [] }, available: null }), ''); assert.equal(payFuelWarning(null), '');
});
test('payoutsNeedNote: shown only for a grant with at least one payout token', () => {
  assert.match(payoutsNeedNote({ payouts: { tokens: [{ token: 'usdc.testnet' }] } }), /1 NEAR reserve/);
  for (const p of [null, {}, { payouts: {} }, { payouts: { tokens: [] } }, { payouts: { tokens: 'x' } }]) assert.equal(payoutsNeedNote(p), '', JSON.stringify(p));
});

test('mintCheck: quiet when empty, explains every bad input, accepts up to the contract ceiling and no further', () => {
  assert.deepEqual(mintCheck('', 6), { base: null, error: '' });
  for (const bad of ['abc', '-5', '1e3', '1,000']) assert.match(mintCheck(bad, 6).error, /number/, bad);
  assert.match(mintCheck('0', 6).error, /more than zero/); assert.match(mintCheck('1.1234567', 6).error, /6 decimals/);
  assert.deepEqual(mintCheck('100', 6), { base: 100_000_000n, error: '' }); assert.deepEqual(mintCheck('12.5', 6), { base: 12_500_000n, error: '' });
  assert.equal(mintCheck('10000', 6).base, MINT_MAX_WHOLE * 10n ** 6n, 'exactly the ceiling is allowed'); assert.match(mintCheck('10000.000001', 6).error, /at most 10,000/); assert.match(mintCheck('10001', 6).error, /at most 10,000/);
  assert.ok(MINT_PRESETS.every((n) => mintCheck(String(n), 6).base !== null));
});
test('isMockToken: only a token whose own metadata says "Mock ..." counts; anything else gets no faucet card', () => {
  assert.equal(isMockToken({ name: 'Mock USDC (testnet, anyone can mint)' }), true); assert.equal(isMockToken({ name: 'mock usdc' }), true);
  for (const m of [null, {}, { name: 'USD Coin' }, { name: 'Not a Mockup' }, { name: 'Mockingbird' }, { name: 5 }]) assert.equal(isMockToken(m), false, JSON.stringify(m));
});

test('mintCall: the exact call for the mint button; storage is paid only for a receiver that is not registered; impossible amounts never become a call', () => {
  const c = mintCall({ token: 'usdc.testnet', to: 'vault.testnet', base: 100_000_000n, decimals: 6, registered: { total: '1' } });
  assert.deepEqual(c, { receiver: 'usdc.testnet', method: 'mint', args: { account_id: 'vault.testnet', amount: '100000000' }, deposit: 0n });
  assert.equal(mintCall({ token: 'usdc.testnet', to: 'v.testnet', base: 1n, decimals: 6, registered: null }).deposit, 25n * 10n ** 20n);
  for (const base of [0n, -1n, 10_000n * 10n ** 6n + 1n, null, undefined, 5]) assert.throws(() => mintCall({ token: 't', to: 'v', base, decimals: 6, registered: null }), /./, String(base));
  assert.equal(mintCall({ token: 't', to: 'v', base: 10_000n * 10n ** 6n, decimals: 6, registered: {} }).args.amount, '10000000000');
});
