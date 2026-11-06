// Runs contracts/vault-conformance-pay.json against src/vault-model.js. The SAME file is executed against the Rust payouts build by
// contracts/near-vault/src/conformance_pay.rs (cargo test --features payouts). Schema = vault-conformance.json: steps { t, as, op, args, expect,
// state? }; roles are mapped to account ids through the file's `accounts` table so both sides see identical strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultModel, VaultError, ALL_ERROR_CODES, PAYOUT_ERROR_CODES } from '../src/vault-model.js';

const file = JSON.parse(readFileSync(new URL('../contracts/vault-conformance-pay.json', import.meta.url), 'utf8'));
const A = file.accounts;
const ROLE = Object.fromEntries(Object.entries(A).map(([r, a]) => [a, r]));
const acct = (r) => { if (!(r in A)) throw new Error(`unknown role ${r}`); return A[r]; };

/** Role-named args -> account-id args (what the model and the contract both receive). */
function translate(op, a = {}) {
  const o = { ...a };
  for (const k of ['agent', 'token', 'to', 'account']) if (typeof o[k] === 'string' && k in o && !(op === 'set_mandate' && k !== 'agent')) o[k] = acct(o[k]);
  if (o.memo_len !== undefined) { o.memo = 'x'.repeat(o.memo_len); delete o.memo_len; }
  if (o.memo_repeat !== undefined) { o.memo = o.memo_repeat[0].repeat(o.memo_repeat[1]); delete o.memo_repeat; }
  return o;
}
const snap = (m, t) => JSON.stringify(m.snapshot(t), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) + m.events.length;
const sorted = (xs) => xs.map((x) => ROLE[x]).sort();

function runPay(sc) {
  const m = new VaultModel({ chain: 'near', owner: A.owner, balance: BigInt(sc.setup.balance), networkId: 'testnet', vaultId: A.vault, callDeposit: 0n });
  const failures = [];
  const fail = (i, op, field, expected, got) => failures.push({ step: i, op, field, expected, got });
  sc.steps.forEach((s, i) => {
    const caller = acct(s.as); const args = translate(s.op, s.args);
    const before = snap(m, s.t);
    let preview = null;
    if (s.op === 'pay') preview = m.previewPay(args.token, args.to, args.amount, { now: s.t });
    let got = 'ok';
    try {
      const out = m.exec(s.op, caller, args, s.t);
      if (typeof out === 'string') got = out === '' ? 'ok' : { err: out };
    } catch (e) {
      if (e instanceof VaultError) got = { err: e.code }; else { fail(i, s.op, 'threw-non-VaultError', s.expect, String(e?.stack ?? e)); return; }
    }
    const want = s.expect;
    if (!(want === 'ok' ? got === 'ok' : (typeof got === 'object' && got.err === want.err))) fail(i, s.op, 'expect', want, got);
    if (typeof got === 'object' && snap(m, s.t) !== before && s.op !== 'preview_pay') fail(i, s.op, 'a failing call changed state', null, null);
    if (preview !== null) {   // preview parity (previews assume the bound agent and carry no memo)
      const ok = got === 'ok'; const code = ok ? '' : got.err;
      const same = ok ? preview === '' : code === 'Unauthorized' ? preview !== 'Unauthorized' : code === 'BadMemo' ? (preview === '' || preview === 'InsufficientBalance') : preview === code;
      if (!same) fail(i, s.op, 'preview-parity', code, preview);
    }
    for (const [k, v] of Object.entries(s.state ?? {})) {
      const t = BigInt(s.t); let obs;
      switch (k) {
        case 'available': case 'total_spent': case 'period_spent': case 'epoch': case 'paused': case 'revoked': obs = m.observe(t)[k]; if (typeof obs === 'bigint') obs = Number(obs); break;
        case 'token_total': for (const [r, n] of Object.entries(v)) if (m.tokenUsageView(acct(r)).totalSpent !== BigInt(n)) fail(i, s.op, `token_total.${r}`, n, String(m.tokenUsageView(acct(r)).totalSpent)); continue;
        case 'token_period': for (const [r, n] of Object.entries(v)) if (m.tokenPeriodSpent(acct(r), t) !== BigInt(n)) fail(i, s.op, `token_period.${r}`, n, String(m.tokenPeriodSpent(acct(r), t))); continue;
        case 'token_sent': for (const [tr, tos] of Object.entries(v)) for (const [r, n] of Object.entries(tos)) if (m.tokenSentTo(acct(tr), acct(r)) !== BigInt(n)) fail(i, s.op, `token_sent.${tr}.${r}`, n, String(m.tokenSentTo(acct(tr), acct(r)))); continue;
        case 'allowed_tokens': obs = sorted([...m.tokens.keys()]); break;
        case 'allowed_payees': obs = sorted([...m.payees]); break;
        case 'n_tokens': obs = m.tokens.size; break;
        case 'n_payees': obs = m.payees.size; break;
        case 'caps': { const o = Object.fromEntries(Object.keys(v).map((r) => { const l = m.tokens.get(acct(r)); return [r, l ? [l.perPayCap, l.periodCap, l.totalCap].map(Number) : null]; })); if (JSON.stringify(o) !== JSON.stringify(v)) fail(i, s.op, 'caps', v, o); continue; }
        default: fail(i, s.op, `unknown-state-key.${k}`, v, undefined); continue;
      }
      if (JSON.stringify(obs) !== JSON.stringify(v)) fail(i, s.op, `state.${k}`, v, obs);
    }
  });
  return failures;
}

test('pay conformance file: the error list is the v1 list plus the payout codes, in the model', () => {
  assert.deepEqual(file.errors, [...ALL_ERROR_CODES]);
  assert.equal(file.version, 1);
  assert.deepEqual([...PAYOUT_ERROR_CODES], ['TokenNotAllowed', 'PayeeNotAllowed', 'PerPayCap', 'BadToken', 'BadPayee', 'BadMemo']);
});

for (const sc of file.scenarios) {
  test(`pay conformance [model] ${sc.name}`, () => {
    assert.ok(sc.steps.length > 0);
    assert.deepEqual(runPay(sc), [], sc.name);
  });
}

test('pay conformance: every payout error code and the agent-gate codes are asserted by at least one step', () => {
  const seen = new Set();
  for (const sc of file.scenarios) for (const s of sc.steps) if (s.expect?.err) seen.add(s.expect.err);
  for (const c of [...PAYOUT_ERROR_CODES, 'NoMandate', 'Unauthorized', 'Paused', 'MandateInactive', 'BadAmount', 'PeriodCap', 'TotalCap', 'InsufficientBalance']) assert.ok(seen.has(c), c);
});

test('pay conformance: the runner reports (does not throw on) a wrong expectation', () => {
  const sc = { name: 'x', setup: { balance: 10 }, steps: [{ t: 1, as: 'agent', op: 'pay', args: { token: 'usdc', to: 'alice', amount: 1 }, expect: 'ok', state: { token_total: { usdc: 9 } } }] };
  const f = runPay(sc);
  assert.equal(f[0].field, 'expect'); assert.deepEqual(f[0].got, { err: 'NoMandate' });
});
