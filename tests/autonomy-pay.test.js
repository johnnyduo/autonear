// Rule (l): the autonomy loop runs pay_testnet decisions. Everything here runs against the FAKE NEAR testnet of tests/pay-helpers.js (no network, no key): the loop is the
// REAL src/autonomy.js, the adapter is the REAL src/vault/near.js (preview, ft reads, fee estimate, verifyPay), the database and the policy are real. Only the signer is
// scripted (it still passes through the production limits check) and the fake chain is moved by the script exactly as the chain would move.
// The real contracts and the real receipts are covered by `npm run e2e:near-pay` (local nearcore sandbox), not here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { autonomyTick, classifyPay } from '../src/autonomy.js';
import { autonomyMaxPaymentsPerDay, AUTONOMY_HARD_MAX_PAYMENTS_PER_DAY } from '../src/config.js';
import { setMode } from '../src/autonomy-mode.js';
import { setPaused } from '../src/orchestrator/coordinator.js';
import { getLoop, resumeLoop, verifyLedgerChain, LEDGER_KINDS } from '../src/vault/index.js';
import { normalizeLimits, enforceCall, LimitError } from '../src/agent/limits.js';
import { base58 } from '../src/chains/common.js';
import { now } from '../src/db.js';
import { makeWorld, payTx, failedPayTx, approvedPayment, skipNoBuilds, NEAR, M, VAULT, AGENT, USDC, ALICE, BOB, CAROL, OWNER } from './pay-helpers.js';

const ENV = { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5' };
const BODY = (over = {}) => ({ token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', ...over });
const hashOf = (n) => base58(new Uint8Array(createHash('sha256').update(`tx-${n}`).digest()));
const FAILURE = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_PerPayCap: per-pay cap exceeded' } } } };

/** A scripted agent: `behaviour` is a list consumed one per signAndSend (default 'ok'). It moves the fake chain the way the real one would. */
function setupAgent(world, behaviour = []) {
  const { w } = world;
  const seen = { signerOpts: [], sends: [] };
  let n = 0;
  const chainPay = ({ token, to, amount }) => {
    w.balances[VAULT] = String(BigInt(w.balances[VAULT]) - BigInt(amount)); w.balances[to] = String(BigInt(w.balances[to] ?? 0) + BigInt(amount));
    const u = w.usage[token] ?? { total_spent: '0', period_index: '0', period_spent: '0' };
    w.usage[token] = { total_spent: String(BigInt(u.total_spent) + BigInt(amount)), period_index: u.period_index, period_spent: String(BigInt(u.period_spent) + BigInt(amount)) };
  };
  const send = async (call) => {
    seen.sends.push(call);
    if (call.method === 'draw') {
      const v = w.views[VAULT]; const a = BigInt(call.args.amount);
      v.usage = { ...v.usage, total_spent: String(BigInt(v.usage.total_spent) + a), period_spent: String(BigInt(v.usage.period_spent) + a) };
      w.accounts[AGENT].amount = String(BigInt(w.accounts[AGENT].amount) + a);
      return { ok: true, status: 'success', txHash: hashOf(`draw${n++}`) };
    }
    const kind = behaviour.shift() ?? 'ok';
    const hash = hashOf(`pay${n++}`);
    const { token, to, amount, memo } = call.args;
    const o = { to, token, amount, memo: memo ?? '', hash };
    if (kind === 'throw') throw new Error('socket hang up');
    if (kind === 'limit') throw new LimitError('fee_ceiling', 'worst-case fee too high');
    if (kind === 'ok') { chainPay(call.args); w.txs[hash] = payTx(o); return { ok: true, status: 'success', txHash: hash }; }
    if (kind === 'mismatch') { chainPay(call.args); w.txs[hash] = payTx({ ...o, amount: String(BigInt(amount) + 1n) }); return { ok: true, status: 'success', txHash: hash }; }
    if (kind === 'failed') { w.txs[hash] = failedPayTx(o); return { ok: false, status: 'failed', txHash: hash }; }
    if (kind === 'rejected') { // the vault itself panicked: one failed receipt, no events, no ft_transfer
      const t = payTx(o); t.status = { Failure: FAILURE }; t.receipts = [t.receipts[0]];
      t.receipts_outcome = [{ id: 'R_PAY', outcome: { executor_id: VAULT, logs: [], status: { Failure: FAILURE } } }];
      w.txs[hash] = t; return { ok: false, status: 'failed', txHash: hash };
    }
    if (kind === 'pending') { seen.pendingLater = () => { chainPay(call.args); w.txs[hash] = payTx(o); }; return { ok: false, status: 'pending', txHash: hash }; }
    throw new Error(`unknown behaviour ${kind}`);
  };
  const keystore = {
    publicView: () => ({ evm: null, near: { account: AGENT, publicKey: 'ed25519:test' } }),
    redactText: (x) => String(x),
    signer: (chain, opts) => { seen.signerOpts.push(opts); return { async signAndSend(call, limits) { enforceCall('near', call, normalizeLimits('near', limits)); seen.limits = limits; return send(call); } }; },
  };
  const tick = (extra = {}) => autonomyTick(world.db, { keystore, signingSupported: true, fetchImpl: world.fetchImpl, catchUpAttempts: 1, catchUpMs: 1, env: { ...ENV, ...(extra.env ?? {}) } });
  return { seen, tick, keystore };
}
const ledger = (db) => db.all('SELECT kind,status,detail,decision_id,tx_hash,amount FROM vault_ledger ORDER BY id');
const runs = (db) => db.all('SELECT * FROM mandate_runs');
const status = async (db, id) => (await db.get('SELECT status, approver, bound_signer FROM decisions WHERE id=?', [id]));
const aged = (db, id) => db.run('UPDATE mandate_runs SET created_at=? WHERE decision_id=?', [now() - 31 * 60_000, id]);

describe('classifyPay (what a finished pay transaction turned out to be)', () => {
  test('recorded / payFailed / noReceipt / vaultRejected / mismatch', () => {
    assert.equal(classifyPay({ recorded: true }), 'recorded');
    assert.equal(classifyPay({ recorded: false, payFailed: true, verification: { checks: [] } }), 'payFailed');
    assert.equal(classifyPay({ recorded: false, verification: { checks: [{ name: 'transaction found and verifiable on this network', ok: false, detail: 'x' }] } }), 'noReceipt');
    assert.equal(classifyPay({ recorded: false, verification: { checks: [{ name: 'vault emitted exactly one `paid` for this agent / token / payee / amount', ok: false, detail: 'none' }, { name: 'exactly one vault -> token ft_transfer receipt', ok: false, detail: '0 found' }] } }), 'vaultRejected');
    assert.equal(classifyPay({ recorded: false, verification: { checks: [{ name: 'pay amount == approved amount', ok: false, detail: '26 vs 25' }] } }), 'mismatch');
    // a `paid` event with no ft_transfer receipt is NOT a clean rejection: money may have moved somewhere we cannot see
    assert.equal(classifyPay({ recorded: false, verification: { checks: [{ name: 'exactly one vault -> token ft_transfer receipt', ok: false, detail: '0 found' }] } }), 'mismatch');
  });
  test('the payments limit has its own env, default 5, hard maximum 20; the ledger knows the kind', () => {
    assert.equal(autonomyMaxPaymentsPerDay({}), 5); assert.equal(autonomyMaxPaymentsPerDay({ AUTONOMY_MAX_PAYMENTS_PER_DAY: '3' }), 3);
    assert.equal(autonomyMaxPaymentsPerDay({ AUTONOMY_MAX_PAYMENTS_PER_DAY: '9999' }), AUTONOMY_HARD_MAX_PAYMENTS_PER_DAY); assert.equal(AUTONOMY_HARD_MAX_PAYMENTS_PER_DAY, 20);
    assert.equal(autonomyMaxPaymentsPerDay({ AUTONOMY_MAX_PAYMENTS_PER_DAY: 'x' }), 5); assert.equal(autonomyMaxPaymentsPerDay({ AUTONOMY_MAX_PAYMENTS_PER_DAY: '0' }), 5);
    assert.equal(autonomyMaxPaymentsPerDay({ AUTONOMY_MAX_PER_DAY: '9' }), 5, 'the deploy limit does not leak into the payments limit');
    assert.ok(LEDGER_KINDS.includes('pay'));
  });
});

describe('rule (l): which payments the loop runs', { skip: skipNoBuilds }, () => {
  test('Manual: a pending request is left alone (no chain read for it, nothing signed); the owner approving it makes the next tick pay it', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const r = (await world.pay(BODY())).json; assert.equal(r.status, 'pending');
    const m = await agent.tick();
    assert.equal(m.vaults[0].manual, true); assert.equal(agent.seen.sends.length, 0); assert.equal((await runs(world.db)).length, 0); assert.equal((await status(world.db, r.id)).status, 'pending');
    const a = await world.api(`/api/decisions/${r.id}/approve`, { method: 'POST', body: { nonce: r.nonce, payloadHash: r.payload_hash, confirm: `approve ${r.id}`, signer: OWNER } });
    assert.equal(a.status, 200);
    const p = await agent.tick();
    assert.deepEqual(p.vaults[0].done, [r.id]);
    const d = await status(world.db, r.id); assert.equal(d.status, 'executed'); assert.match(d.approver, /^mandate:vlt_[0-9a-f]+:1\+operator$/);
    assert.equal(world.w.balances[ALICE], String(25n * M)); assert.equal(world.w.balances[VAULT], String(475n * M));
    const pay = await world.db.get('SELECT * FROM payments WHERE decision_id=?', [r.id]); assert.ok(pay); assert.match(pay.status, /^verified/); assert.equal(pay.amount, String(25n * M));
    assert.equal((await runs(world.db))[0].status, 'confirmed');
  });
  test('Auto: a pending, unbound request is paid by itself (the council gate does not apply to payments)', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    await setMode(world.db, 'auto', 'test');
    const r = (await world.pay(BODY())).json;
    const t = await agent.tick();
    assert.deepEqual(t.vaults[0].done, [r.id]);
    const d = await status(world.db, r.id); assert.equal(d.status, 'executed'); assert.match(d.approver, /^mandate:vlt_[0-9a-f]+:1$/);
    assert.equal(world.w.balances[ALICE], String(25n * M));
  });
  test('the call is exactly vault.pay with the approved token / payee / amount / memo; limits allow only `pay`, only the vault; the signer is built for the payouts build (pay gas pinned)', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    await approvedPayment(world, BODY(), { claim: false });
    await agent.tick();
    assert.equal(agent.seen.sends.length, 1);
    assert.deepEqual(agent.seen.sends[0], { method: 'pay', target: VAULT, args: { token: USDC, to: ALICE, amount: String(25n * M), memo: 'invoice 42' } });
    assert.deepEqual(agent.seen.limits.allowedMethods, ['pay']); assert.deepEqual(agent.seen.limits.allowedTargets, [VAULT]);
    assert.ok(BigInt(agent.seen.limits.maxFeePerTx) > 0n && BigInt(agent.seen.limits.maxFeePerTx) <= NEAR);
    assert.equal(agent.seen.signerOpts[0].gas.pay, String(100n * 10n ** 12n));
  });
  test('an empty memo is not sent as a memo at all', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    await approvedPayment(world, BODY({ memo: '' }), { claim: false });
    await agent.tick();
    assert.deepEqual(agent.seen.sends[0].args, { token: USDC, to: ALICE, amount: String(25n * M) });
  });
  test('a payment that names another vault, an expired approval, and an already-run decision are not candidates', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const d = await approvedPayment(world, BODY(), { claim: false });
    const other = JSON.parse((await world.db.get('SELECT payload FROM decisions WHERE id=?', [d.id])).payload); other.vault = 'someone-elses-vault.testnet';
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify(other), d.id]);
    assert.equal((await agent.tick()).vaults[0].manual, true, 'a payment for another vault is invisible to this vault');
    const e = await approvedPayment(world, BODY({ memo: 'second' }), { claim: false });
    await world.db.run('UPDATE decisions SET expiry=? WHERE id=?', [now() - 1, e.id]);
    assert.equal((await agent.tick()).vaults[0].manual, true, 'an expired approval is not run');
    assert.equal(agent.seen.sends.length, 0);
  });
  test('kill switch and a paused loop: nothing is signed, the approved payment waits', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const d = await approvedPayment(world, BODY(), { claim: false });
    await setPaused(world.db, true, 'test');
    assert.match((await agent.tick()).skipped, /kill switch/);
    await setPaused(world.db, false, 'test');
    await world.db.run("INSERT INTO kv(k,v) VALUES('vault:loop',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [JSON.stringify({ state: 'paused', reason: 'x' })]);
    assert.match((await agent.tick()).skipped, /loop paused/);
    assert.equal(agent.seen.sends.length, 0); assert.equal((await status(world.db, d.id)).status, 'approved');
    await resumeLoop(world.db); await agent.tick();
    assert.equal((await status(world.db, d.id)).status, 'executed');
  });
});

describe('rule (l): early refusals sign nothing, claim nothing, and are ledgered once', { skip: skipNoBuilds }, () => {
  async function refusal(setup, body = BODY(), auto = false) {
    const world = await makeWorld(); const agent = setupAgent(world);
    setup(world.w);
    let d;
    if (auto) { await setMode(world.db, 'auto', 'test'); d = (await world.pay(body)).json; } else d = await approvedPayment(world, body, { claim: false });
    const t1 = await agent.tick(); await agent.tick();
    const L = (await ledger(world.db)).filter((x) => x.decision_id === d.id && x.kind === 'refused');
    assert.equal(agent.seen.sends.length, 0, 'nothing was signed'); assert.equal((await runs(world.db)).length, 0, 'nothing was claimed');
    assert.equal(L.length, 1, `ledgered exactly once: ${JSON.stringify(L)}`); assert.match(L[0].detail, /nothing was signed/);
    assert.equal((await status(world.db, d.id)).status, auto ? 'pending' : 'approved', 'the decision stays for the owner');
    assert.equal((await getLoop(world.db)).state === 'blocked', false);
    return { world, agent, d, detail: L[0].detail, t1 };
  }
  test('payee not registered on the token', async () => {
    const r = await refusal((w) => { w.views[USDC].storage_balance_of = (a) => (a.account_id === ALICE ? null : { total: '1', available: '0' }); });
    assert.match(r.detail, new RegExp(`${ALICE} is not registered on the USDC token`));
  });
  test('vault token balance below the amount (Auto, pending request)', async () => {
    const r = await refusal((w) => { w.balances[VAULT] = String(10n * M); }, BODY(), true);
    assert.match(r.detail, /the vault holds 10 USDC but the payment needs 25 USDC/);
  });
  test('period cap used up (model and chain agree on the code)', async () => {
    const r = await refusal((w) => { w.usage[USDC] = { total_spent: String(90n * M), period_index: '0', period_spent: String(90n * M) }; w.views[VAULT].preview_pay = () => 'PeriodCap'; });
    assert.match(r.detail, /budget for this token in the current period is used up \(PeriodCap\)/);
  });
  test('total cap used up', async () => {
    const r = await refusal((w) => { w.usage[USDC] = { total_spent: String(390n * M), period_index: '1', period_spent: '0' }; w.views[VAULT].preview_pay = () => 'TotalCap'; });
    assert.match(r.detail, /total budget for this token is used up \(TotalCap\)/);
  });
  test('model and chain DISAGREE: anomaly, the loop is blocked, nothing signed (same as draw / deploy)', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    world.w.views[VAULT].preview_pay = () => 'PerPayCap'; // the chain says no, the model (built from the same state) says yes
    await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.equal(t.vaults[0].blocked, true); assert.equal((await getLoop(world.db)).state, 'blocked'); assert.match((await getLoop(world.db)).reason, /model\/chain preview mismatch on pay/);
    assert.equal(agent.seen.sends.length, 0); assert.equal((await runs(world.db)).length, 0);
    assert.ok((await ledger(world.db)).some((x) => x.kind === 'anomaly'));
  });
  test('a payment whose payee the activated grant never named is LEFT for a human (ledgered once), never claimed', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const d = await approvedPayment(world, BODY(), { claim: false });
    // bypass the API (which would refuse this) the way a bug or a stale row could: the loop must not guess
    const p = JSON.parse((await world.db.get('SELECT payload FROM decisions WHERE id=?', [d.id])).payload); p.payee = 'dave.testnet';
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify(p), d.id]);
    const t = await agent.tick(); await agent.tick();
    assert.deepEqual(t.vaults[0].left, [d.id]);
    const L = (await ledger(world.db)).filter((x) => x.decision_id === d.id); assert.equal(L.length, 1); assert.match(L[0].detail, /^left for a human: the vault's activated grant does not name this token and payee/);
    assert.equal(agent.seen.sends.length, 0); assert.equal((await runs(world.db)).length, 0); assert.equal((await status(world.db, d.id)).status, 'approved');
  });
  test('if the on-chain payee list drifts from the grant, the vault is reported as drifted before any payment is looked at', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const d = await approvedPayment(world, BODY(), { claim: false });
    world.w.onChainPayees.push(CAROL); // the owner (or an attacker with the owner key) allowlisted someone the grant never named
    const t = await agent.tick();
    assert.equal(t.vaults[0].drift, true); assert.equal(agent.seen.sends.length, 0); assert.equal((await status(world.db, d.id)).status, 'approved');
  });
});

describe('rule (l): outcomes of a sent payment', { skip: skipNoBuilds }, () => {
  test('the chain refused the transfer and the vault gave the budget back: ledger failed, released to the owner, the loop is NOT blocked', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['failed']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.equal(t.vaults[0].refused, 'transfer failed; the vault reversed the charge');
    const row = await status(world.db, d.id); assert.equal(row.status, 'pending'); assert.equal(row.approver, null); assert.equal(row.bound_signer, null);
    assert.equal((await runs(world.db))[0].status, 'failed'); assert.equal((await getLoop(world.db)).state === 'blocked', false);
    assert.equal(await world.db.get('SELECT 1 x FROM payments'), undefined);
    const L = (await ledger(world.db)).filter((x) => x.kind === 'pay'); assert.equal(L.length, 1); assert.equal(L[0].status, 'failed'); assert.match(L[0].detail, /did NOT go through/); assert.ok(L[0].tx_hash);
  });
  test('the vault itself rejected the call (a race on a cap): nothing moved, released, not blocked', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['rejected']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.equal(t.vaults[0].refused, 'rejected by the vault');
    assert.equal((await status(world.db, d.id)).status, 'pending'); assert.equal((await getLoop(world.db)).state === 'blocked', false);
    assert.match((await ledger(world.db)).filter((x) => x.kind === 'pay')[0].detail, /rejected by the vault itself/);
  });
  test('receipt not seen before the timeout: the run stays `submitted` with its hash; the next tick records it from the chain and never sends twice', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['pending']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.equal(t.vaults[0].done.length, 0);
    let run = (await runs(world.db))[0]; assert.equal(run.status, 'submitted'); assert.ok(run.tx_hash);
    assert.equal((await status(world.db, d.id)).status, 'approved');
    const t2 = await agent.tick(); // the node still does not show it: retry later, do not release, do not block
    assert.equal((await runs(world.db))[0].status, 'submitted'); assert.equal((await getLoop(world.db)).state === 'blocked', false);
    agent.seen.pendingLater(); // the tx lands
    const t3 = await agent.tick();
    run = (await runs(world.db))[0]; assert.equal(run.status, 'confirmed');
    assert.equal((await status(world.db, d.id)).status, 'executed'); assert.equal(agent.seen.sends.length, 1, 'one send, ever');
    assert.ok((await ledger(world.db)).some((x) => x.kind === 'pay' && x.status === 'confirmed' && /reconciled/.test(x.detail)));
    void t2; void t3;
  });
  test('landed but NOT as approved (the tx pays 1 base unit too much): the loop BLOCKS, the decision is NOT released (a re-approval could pay twice), the run stays submitted', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['mismatch']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.equal(t.vaults[0].blocked, true); assert.equal((await getLoop(world.db)).state, 'blocked'); assert.match((await getLoop(world.db)).reason, /did not verify/);
    assert.equal((await status(world.db, d.id)).status, 'approved'); assert.equal((await runs(world.db))[0].status, 'submitted');
    assert.equal(await world.db.get('SELECT 1 x FROM payments'), undefined);
    assert.ok((await ledger(world.db)).some((x) => x.kind === 'pay' && x.status === 'failed' && /NOT released/.test(x.detail)));
    // an operator who has looked rejects the payment: the run closes and the vault is free again after resume
    await world.api(`/api/decisions/${d.id}/reject`, { method: 'POST', body: { reason: 'checked on the explorer' } });
    await resumeLoop(world.db); await agent.tick();
    assert.equal((await runs(world.db))[0].status, 'failed'); assert.equal((await getLoop(world.db)).state === 'blocked', false);
  });
  test('the signer refuses before sending (a limit): released, nothing sent. An unknown send failure is NOT released', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['limit']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    await agent.tick();
    assert.equal((await status(world.db, d.id)).status, 'pending'); assert.equal((await runs(world.db))[0].status, 'failed');
    const world2 = await makeWorld(); const agent2 = setupAgent(world2, ['throw']);
    const d2 = await approvedPayment(world2, BODY(), { claim: false });
    const t = await agent2.tick();
    assert.match(t.vaults[0].refused, /socket hang up/);
    assert.equal((await status(world2.db, d2.id)).status, 'approved', 'a payment of unknown fate is never handed back'); assert.equal((await runs(world2.db))[0].status, 'submitted'); assert.equal((await runs(world2.db))[0].tx_hash, null);
    assert.equal((await getLoop(world2.db)).state === 'blocked', false, 'not blocked yet: reconcile blocks after the window');
  });
  test('gas: an agent too poor for 3x the fee gets ONE bounded draw first (parity-checked, ledgered), then pays', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    world.w.accounts[AGENT].amount = String(10n ** 22n); // enough for the draw's own gas (7.5e21), not for 3x the pay fee (4.5e22)
    await approvedPayment(world, BODY(), { claim: false });
    const t = await agent.tick();
    assert.deepEqual(agent.seen.sends.map((c) => c.method), ['draw', 'pay']); assert.equal(t.vaults[0].done.length, 1);
    const draw = (await ledger(world.db)).find((x) => x.kind === 'draw'); assert.equal(draw.status, 'confirmed'); assert.match(draw.detail, /3x fee headroom/);
    assert.ok(BigInt(agent.seen.sends[0].args.amount) < NEAR / 2n, 'inside the per-draw cap');
  });
});

describe('rule (l): limits and reconcile', { skip: skipNoBuilds }, () => {
  test('payments have their OWN per-day limit: the second payment waits (ledgered once), the first still ran', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const a = await approvedPayment(world, BODY({ memo: 'one' }), { claim: false });
    const b = await approvedPayment(world, BODY({ memo: 'two', amount: String(10n * M) }), { claim: false });
    const t = await agent.tick({ env: { AUTONOMY_MAX_PAYMENTS_PER_DAY: '1' } }); await agent.tick({ env: { AUTONOMY_MAX_PAYMENTS_PER_DAY: '1' } });
    const st = [(await status(world.db, a.id)).status, (await status(world.db, b.id)).status].sort();
    assert.deepEqual(st, ['approved', 'executed'], 'exactly one ran');
    assert.match(t.vaults[0].refused, /per-day payment limit reached \(1 agent payments in 24h\)/);
    assert.equal((await ledger(world.db)).filter((x) => /per-day payment limit/.test(x.detail)).length, 1);
    await agent.tick({ env: { AUTONOMY_MAX_PAYMENTS_PER_DAY: '2' } }); // a higher limit lets the other through
    assert.equal((await status(world.db, a.id)).status, 'executed'); assert.equal((await status(world.db, b.id)).status, 'executed');
  });
  test('the DEPLOY limit does not govern payments (AUTONOMY_MAX_PER_DAY=1, yet two payments run) and payments are not counted against it', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const a = await approvedPayment(world, BODY({ memo: 'one' }), { claim: false });
    const b = await approvedPayment(world, BODY({ memo: 'two', amount: String(10n * M) }), { claim: false });
    await agent.tick({ env: { AUTONOMY_MAX_PER_DAY: '1' } });
    assert.equal((await status(world.db, a.id)).status, 'executed'); assert.equal((await status(world.db, b.id)).status, 'executed');
    const n = await world.db.get("SELECT COUNT(*) n FROM mandate_runs r LEFT JOIN decisions d ON d.id=r.decision_id WHERE COALESCE(d.action,'')<>'pay_testnet'");
    assert.equal(n.n, 0); assert.equal((await runs(world.db)).length, 2);
  });
  test('reconcile: a submitted payment with NO saved hash older than the window BLOCKS the loop with an operator message and is never released; rejecting it closes the run', async () => {
    const world = await makeWorld(); const agent = setupAgent(world);
    const d = await approvedPayment(world, BODY(), { claim: true }); // claimed under the mandate, as the loop does just before signing
    await world.db.run("UPDATE mandate_runs SET status='submitted' WHERE decision_id=?", [d.id]);
    await agent.tick(); // young: waits
    assert.equal((await getLoop(world.db)).state === 'blocked', false);
    await aged(world.db, d.id);
    const t = await agent.tick();
    assert.equal(t.vaults[0].blocked, true); const loop = await getLoop(world.db);
    assert.equal(loop.state, 'blocked'); assert.match(loop.reason, /hash was never saved/); assert.match(loop.reason, new RegExp(`POST /api/decisions/${d.id}/receipt`));
    assert.equal((await status(world.db, d.id)).status, 'approved'); assert.equal((await runs(world.db))[0].status, 'submitted'); assert.equal(agent.seen.sends.length, 0);
    await resumeLoop(world.db); assert.equal((await agent.tick()).vaults[0].blocked, true, 'resuming without resolving it blocks again');
    await world.api(`/api/decisions/${d.id}/reject`, { method: 'POST', body: { reason: 'did not land' } });
    await resumeLoop(world.db); await agent.tick();
    assert.equal((await runs(world.db))[0].status, 'failed'); assert.equal((await getLoop(world.db)).state === 'blocked', false);
  });
  test('reconcile with a saved hash records the payment (recordPayment, not recordDeployment) and an operator can do the same with POST /receipt', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['pending']);
    const d = await approvedPayment(world, BODY(), { claim: false });
    await agent.tick(); const run = (await runs(world.db))[0]; assert.ok(run.tx_hash);
    agent.seen.pendingLater();
    const r = await world.api(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash: run.tx_hash } });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.recorded, true); assert.ok(r.json.payment);
    assert.equal((await status(world.db, d.id)).status, 'executed');
    await agent.tick(); assert.equal((await runs(world.db))[0].status, 'confirmed');
  });
  test('the hash-chained ledger stays valid through all of it, and no entry carries more than the token, payee and amount of the payment', async () => {
    const world = await makeWorld(); const agent = setupAgent(world, ['ok', 'failed']);
    await approvedPayment(world, BODY(), { claim: false }); await agent.tick();
    await approvedPayment(world, BODY({ payee: BOB, memo: 'secret-looking memo' }), { claim: false }); await agent.tick();
    assert.deepEqual(await verifyLedgerChain(world.db), { ok: true });
    const pays = (await ledger(world.db)).filter((x) => x.kind === 'pay');
    assert.equal(pays.length, 2); assert.ok(pays.every((x) => /^[0-9]+$/.test(x.amount) && x.detail.includes(USDC) && (x.detail.includes(ALICE) || x.detail.includes(BOB))));
    assert.ok(!pays.some((x) => /secret-looking memo/.test(x.detail)), 'the free-text memo is not copied into the ledger');
    void CAROL;
  });
});
