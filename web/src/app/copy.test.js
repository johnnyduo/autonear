import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANNED, T, P, ROUTES, describeDecision, historyLine, homeLine, tokenAmount, payError, payReason } from './copy.js';

const PAYLOAD = { action: 'pay_testnet', protocol: 'near', network: 'near-testnet', vault: 'v.testnet', token: 'usdc.testnet', symbol: 'USDC', decimals: 6, payee: 'alice.testnet', amount: '25000000', memo: 'invoice 42' };
const NEVER = [/NEP-?141/i, /ft_transfer/i, /yocto/i, /wasm/i, /signer/i];

const PAY_ENTRIES = [
  { kind: 'pay', status: 'confirmed', amount: '25000000', detail: 'paid 25 USDC (25000000 base units) of usdc.testnet to alice.testnet; verified on chain' },
  { kind: 'pay', status: 'failed', detail: 'payment of 25 USDC to alice.testnet did NOT go through: the token refused the transfer and the vault gave the budget back' },
  { kind: 'pay', status: 'failed', detail: 'payment tx confirmed but verification FAILED (NOT released, the loop is blocked): x' },
  { kind: 'refused', status: 'refused', detail: 'payment of 500 USDC to alice.testnet not sent: the amount is above the per-payment cap the owner set (PerPayCap); nothing was signed' },
  { kind: 'refused', status: 'refused', detail: 'payment of 5 USDC to bob.testnet not sent: bob.testnet is not registered on the USDC token (the transfer would fail); the payee or the owner has to run storage_deposit; nothing was signed' },
  { kind: 'refused', status: 'refused', detail: 'payment of 5 USDC to bob.testnet not sent: the vault holds 1 USDC but the payment needs 5 USDC' },
  { kind: 'refused', status: 'refused', detail: 'payment of 5 USDC to bob.testnet not sent: the vault would refuse it (Weird)' },
  { kind: 'pay', status: 'weird', detail: '' },
];
const PAY_ERRORS = [
  { status: 409, code: 'state', message: 'alice.testnet is not one of the payees the owner approved for this vault' },
  { status: 409, code: 'state', message: 'alice.testnet is not on the vault\'s on-chain payee list (the owner has not finished allow_payee, or removed it)' },
  { status: 409, code: 'state', message: 'usdc.testnet is not one of the tokens the owner approved for this vault' },
  { status: 409, code: 'state', message: 'USDC is not on the vault\'s on-chain allowlist (the owner has not finished allow_token, or removed it)' },
  { status: 409, code: 'state', message: '25 USDC is above the per-payment cap on chain (10 USDC)' },
  { status: 409, code: 'state', message: 'the vault is not active yet: finish the owner\'s grant steps first' },
  { status: 400, code: 'unavailable', message: 'the vault could not be read just now (x): try again in a moment' },
  { status: 400, code: 'input', message: 'memo must be text of at most 128 bytes' },
  { status: 400, code: 'input', message: 'amount must be a positive whole number in the token\'s smallest unit (a decimal string)' },
  { status: 500, message: 'boom with mandate and hash inside' },
];

test('no banned jargon in any user-facing string', () => {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(T); walk(ROUTES); walk(P);
  for (const d of [{ action: 'deploy_testnet', chain_id: 'evm:84532' }, { action: 'grant_mandate', chain_id: 'evm:84532' }, { action: 'x' }, { action: 'pay_testnet', chain_id: 'near-testnet', payload: PAYLOAD }, { action: 'pay_testnet', payload: { ...PAYLOAD, memo: '' } }, { action: 'pay_testnet' }]) walk(describeDecision(d));
  for (const e of [{ kind: 'draw', detail: 'top-up' }, { kind: 'deploy', status: 'confirmed' }, { kind: 'activate' }, { kind: 'anomaly' }, { kind: 'refused', detail: 'left for a human' }, { kind: 'loop', detail: 'resumed' }, ...PAY_ENTRIES]) strings.push(historyLine(e, undefined, () => PAYLOAD));
  for (const e of [new Error('x'), { status: 401 }, { status: 0 }, { code: 'fixture' }, ...PAY_ERRORS]) strings.push(payError(e, { maxPayment: '10 USDC' }));
  for (const a of [{ paused: true }, { pending: 2 }, { demo: true }, { sourcesOk: 9, sourcesTotal: 9 }, { vaultLive: true }, { vaultLive: true, signing: true, mode: 'auto' }, { vaultLive: true, signing: true, mode: 'manual' }]) walk(homeLine({ sourcesOk: 9, sourcesTotal: 9, ...a }));
  for (const s of strings) for (const n of NEVER) assert.ok(!n.test(s), `"${s}" contains a word owners never see`);
  for (const s of strings) for (const b of BANNED) assert.ok(!new RegExp(`\\b${b}`, 'i').test(s), `"${s}" contains "${b}"`);
});
test('every route has a title', () => {
  for (const k of ['home', 'approvals', 'watch', 'vault']) assert.ok(ROUTES[k]);
});
test('copy.js is the only module that defines the jargon map', () => {
  assert.match(readFileSync(new URL('./copy.js', import.meta.url), 'utf8'), /mandate -> limits/);
});

test('token amounts: 6 decimals, 0 decimals, big numbers, exact and never rounded up', () => {
  assert.equal(tokenAmount('25000000', 6, 'USDC'), '25 USDC');
  assert.equal(tokenAmount('12500000', 6, 'USDC'), '12.5 USDC');
  assert.equal(tokenAmount('1', 6, 'USDC'), '0.000001 USDC');
  assert.equal(tokenAmount('0', 6, 'USDC'), '0 USDC');
  assert.equal(tokenAmount('25', 0, 'PTS'), '25 PTS');
  assert.equal(tokenAmount('1234567', 0, 'PTS'), '1,234,567 PTS');
  assert.equal(tokenAmount('123456789012345678901234567890', 6, 'USDC'), '123,456,789,012,345,678,901,234.56789 USDC');
  assert.equal(tokenAmount(123456789012345678901234567890n, 18, 'DAI'), '123,456,789,012.34567890123456789 DAI');
  assert.equal(tokenAmount(25000000n, 6, 'USDC'), '25 USDC');
  assert.equal(tokenAmount(25000000, 6), '25');
  assert.equal(tokenAmount('1999999999999999999999', 18, 'DAI'), '1,999.999999999999999999 DAI');
});
test('token amounts with a display limit are cut, never rounded up', () => {
  assert.equal(tokenAmount('1999999', 6, 'USDC', { max: 2 }), '1.99 USDC');
  assert.equal(tokenAmount('1999999', 6, 'USDC', { max: 0 }), '1 USDC');
  assert.equal(tokenAmount('999999', 6, 'USDC', { max: 3 }), '0.999 USDC');
  assert.equal(tokenAmount('1', 6, 'USDC', { max: 3 }), '<0.001 USDC');
  assert.equal(tokenAmount('1', 6, 'USDC', { max: 0 }), '<1 USDC');
  assert.equal(tokenAmount('1500000', 6, 'USDC', { max: 6 }), '1.5 USDC');
});
test('token amounts refuse input that is not a whole number or has unusable decimals', () => {
  for (const bad of [null, undefined, '', 'abc', '1.5', '1e6', 1.5, NaN, {}]) assert.equal(tokenAmount(bad, 6, 'USDC'), null, String(bad));
  for (const bad of [undefined, null, -1, 1.5, 37, 'x']) assert.equal(tokenAmount('1', bad, 'USDC'), null, String(bad));
});
test('a pay request reads in plain words, with the note as the reason', () => {
  const t = describeDecision({ action: 'pay_testnet', chain_id: 'near-testnet', payload: PAYLOAD });
  assert.equal(t.title, 'Pay 25 USDC to alice.testnet');
  assert.equal(t.why, 'For: invoice 42');
  assert.equal(t.cost, '25 USDC from the vault (test money)');
  const n = describeDecision({ action: 'pay_testnet', payload: { ...PAYLOAD, memo: '', amount: '12500000' } });
  assert.equal(n.title, 'Pay 12.5 USDC to alice.testnet'); assert.equal(n.why, P.whyNoNote);
  assert.match(describeDecision({ action: 'pay_testnet' }).title, /^Pay an amount to someone$/);
});
test('payment history lines', () => {
  const pay = () => PAYLOAD;
  assert.equal(historyLine(PAY_ENTRIES[0], undefined, pay), 'Paid 25 USDC to alice.testnet');
  assert.equal(historyLine(PAY_ENTRIES[0]), 'A payment was sent from the vault');
  assert.match(historyLine(PAY_ENTRIES[1]), /^A payment was refused: the token refused it/);
  assert.match(historyLine(PAY_ENTRIES[2]), /^A payment could not be confirmed/);
  assert.equal(historyLine(PAY_ENTRIES[3]), 'A payment was refused: it is above the limit for one payment');
  assert.equal(historyLine(PAY_ENTRIES[4]), 'A payment was refused: that person has not set up an account for the token yet');
  assert.equal(historyLine(PAY_ENTRIES[5]), 'A payment was refused: the vault does not hold enough of the token');
  assert.equal(historyLine(PAY_ENTRIES[6]), 'A payment was refused: the vault’s rules did not allow it');
  assert.ok(historyLine(PAY_ENTRIES[7]).length > 0); // an unknown shape of a known kind still reads as something
  assert.equal(historyLine({ kind: 'brand_new_kind', detail: 'x'.repeat(200) }).length, 80); // unknown kinds still fall back
  assert.equal(payReason('the owner\'s budget for this token in the current period is used up (PeriodCap)'), 'the budget for this period is used up');
  assert.equal(payReason('the owner\'s total budget for this token is used up (TotalCap)'), 'the total budget for this token is used up');
});
test('POST /api/payments errors become one plain sentence each, and the raw server text is never shown', () => {
  const out = PAY_ERRORS.map((e) => payError(e, { maxPayment: '10 USDC' }));
  assert.deepEqual(out.slice(0, 4), [P.errPayee, P.errPayee, P.errToken, P.errToken]);
  assert.equal(out[4], 'That is above the limit for one payment. The most is 10 USDC.');
  assert.equal(payError(PAY_ERRORS[4]), P.errOver);
  assert.deepEqual(out.slice(5), [P.errNotOn, P.errRead, P.errNote, P.errAmount, P.errGeneric]);
  assert.equal(payError({ status: 401, message: 'operator token or owner sign-in required' }), P.errAuth);
  assert.equal(payError({ status: 0, code: 'network', message: 'Network error' }), P.errNetwork);
  assert.equal(payError({ status: 0, code: 'fixture', message: 'Fixture mode' }), P.errDemo);
  assert.equal(payError({ status: 409, code: 'state', message: 'something new' }), P.errState);
  for (const s of out) assert.ok(!/allow_|on-chain|mandate|hash/.test(s));
});
