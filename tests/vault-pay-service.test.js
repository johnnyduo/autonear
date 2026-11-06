// Phase 2b-1 against a FAKE NEAR testnet (tests/pay-helpers.js): the grant `payouts` section, activation / verifyMandate, the human plan, the vault report, the pay_testnet
// decision (POST/GET /api/payments, approve/reject, approveUnderMandate) and recordPayment / adapter.verifyPay. No network, no key. The world needs the attested vault wasm
// builds (contracts/near-vault/dist): without them those tests skip with a reason.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, now } from '../src/db.js';
import { adapter, ATTESTED_BUILDS } from '../src/vault/near.js';
import { normalizeState, modelFromState, verifyMandate, vaultReport, getVault, buildOfAttestedRef, readVault } from '../src/vault/index.js';
import { approveUnderMandate, releaseToHuman, getDecision } from '../src/decisions.js';
import { recordPayment, listPayments, createPayment } from '../src/payments.js';
import { createApp } from '../src/app.js';
import { issueSession, deriveSecret } from '../src/owner-session.js';
import { VaultModel } from '../src/vault-model.js';
import { makeWorld, makeChain, rpc, payTx, failedPayTx, apiClient, approvedPayment, skipNoBuilds, NEAR, M, VAULT, OWNER, AGENT, USDC, USDT, ALICE, BOB, CAROL, TX, TX2, OPERATOR, b64 } from './pay-helpers.js';

const NET = { id: 'near-testnet', protocol: 'near', rpc: 'https://rpc.testnet.near.org', explorer: 'https://testnet.nearblocks.io/txns/', mainnet: false };
const failedNames = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const want = { net: NET, txHash: TX, vault: VAULT, agent: AGENT, token: USDC, to: ALICE, amount: String(25n * M), memo: 'invoice 42' };
const verifyPay = (tx, over = {}, chain = {}) => { const w = makeChain(); w.txs[TX] = tx; Object.assign(w, chain); return adapter.verifyPay({ ...want, fetchImpl: rpc(w), ...over }); };

describe('adapter.verifyPay (fake receipts)', () => {
  test('a good pay: sent by the agent to the vault, vault `paid` event, token ft_transfer succeeded, callback ok, no pay_failed', async () => {
    const r = await verifyPay(payTx());
    assert.equal(r.ok, true, JSON.stringify(failedNames(r))); assert.deepEqual(r.paid, { token: USDC, to: ALICE, amount: String(25n * M) });
    assert.ok(r.checks.length >= 20);
  });
  test('a failed transfer (pay_failed, token receipt Failure) is NOT a payment, even though the callback and the top-level status succeeded', async () => {
    const t = failedPayTx(); assert.equal(t.status.SuccessValue, '');
    const r = await verifyPay(t);
    assert.equal(r.ok, false); assert.equal(r.paid, null);
    const f = failedNames(r);
    assert.ok(f.some((n) => /no failed receipt/.test(n)) && f.some((n) => /token executed ft_transfer successfully/.test(n)) && f.some((n) => /no `pay_failed`/.test(n)), f.join(' | '));
    assert.ok(!f.some((n) => /exactly one `paid`/.test(n)), 'the vault did emit `paid` (optimistic charge); it is the reversal that makes it not a payment');
  });
  test('pay_failed alone (token receipt looks fine) still fails', async () => {
    const t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_CB').outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', version: '1.1.0', event: 'pay_failed', data: { token: USDC, to: ALICE, amount: String(25n * M), epoch: '1', reversed: true } })}`];
    const r = await verifyPay(t); assert.equal(r.ok, false); assert.deepEqual(failedNames(r), ['no `pay_failed` event (the callback did not reverse the charge)']);
  });
  test('wrong amount / payee / token in the transaction versus the APPROVED payment are each rejected', async () => {
    for (const [what, tx, re] of [
      ['amount', payTx({ amount: String(26n * M) }), /pay amount == approved amount/],
      ['payee', payTx({ to: BOB }), /pay payee == approved payee/],
      ['token', payTx({ token: USDT }), /pay token == approved token/],
    ]) {
      const r = await verifyPay(tx); assert.equal(r.ok, false, what); assert.ok(failedNames(r).some((n) => re.test(n)), `${what}: ${failedNames(r)}`);
    }
    // ...and the same transaction proves a different approved payment only if it matches that one exactly
    assert.equal((await verifyPay(payTx({ to: BOB }), { to: BOB })).ok, true);
  });
  test('wrong sender (not the mandate-bound agent) and wrong receiver (not the vault) are rejected', async () => {
    let r = await verifyPay(payTx({ agent: 'evil.testnet' })); assert.equal(r.ok, false); assert.ok(failedNames(r).some((n) => /signer == the agent/.test(n)));
    r = await verifyPay(payTx({ vault: 'other-vault.testnet' })); assert.equal(r.ok, false); assert.ok(failedNames(r).some((n) => /receiver == the vault/.test(n)));
    r = await verifyPay(payTx(), { agent: 'someone-else.testnet' }); assert.equal(r.ok, false);
  });
  test('structure: one pay action with 0 deposit, exact args, not a lookalike method, finalized', async () => {
    let t = payTx(); t.transaction.actions[0].FunctionCall.method_name = 'draw'; assert.equal((await verifyPay(t)).ok, false);
    t = payTx(); t.transaction.actions[0].FunctionCall.deposit = '1'; assert.ok(failedNames(await verifyPay(t)).some((n) => /0 attached deposit/.test(n)));
    t = payTx(); t.transaction.actions.push({ Transfer: { deposit: '5' } }); assert.equal((await verifyPay(t)).ok, false);
    t = payTx(); t.transaction.actions[0].FunctionCall.args = b64({ token: USDC, to: ALICE, amount: String(25n * M), memo: 'invoice 42', extra: 1 }); assert.ok(failedNames(await verifyPay(t)).some((n) => /exactly/.test(n)));
    t = payTx(); t.final_execution_status = 'EXECUTED'; assert.ok(failedNames(await verifyPay(t)).some((n) => /finalized/.test(n)));
    t = payTx(); t.status = { Failure: { ActionError: {} } }; assert.equal((await verifyPay(t)).ok, false);
    t = payTx(); t.transaction.hash = 'x'; assert.ok(failedNames(await verifyPay(t)).some((n) => /hash returned/.test(n)));
  });
  test('memo: must match what was approved (and an approved empty memo means none was sent)', async () => {
    assert.ok(failedNames(await verifyPay(payTx({ memo: 'other' }))).some((n) => /memo/.test(n)));
    assert.equal((await verifyPay(payTx({ memo: '' }), { memo: '' })).ok, true);
    assert.equal((await verifyPay(payTx({ memo: '' }), { memo: undefined })).ok, true);
    assert.equal((await verifyPay(payTx({ memo: 'sneaky' }), { memo: '' })).ok, false);
  });
  test('receipts: the vault -> token ft_transfer must exist exactly once, with 1 yocto and the approved receiver / amount; the callback must exist and agree', async () => {
    let t = payTx(); t.receipts = t.receipts.filter((r) => r.receipt_id !== 'R_FT'); assert.ok(failedNames(await verifyPay(t)).some((n) => /exactly one vault -> token ft_transfer/.test(n)));
    t = payTx(); t.receipts.find((r) => r.receipt_id === 'R_FT').receipt.Action.actions[0].FunctionCall.deposit = '0'; assert.equal((await verifyPay(t)).ok, false);
    t = payTx(); t.receipts.find((r) => r.receipt_id === 'R_FT').receipt.Action.actions[0].FunctionCall.args = b64({ receiver_id: CAROL, amount: String(25n * M) }); assert.ok(failedNames(await verifyPay(t)).some((n) => /receiver_id/.test(n)));
    t = payTx(); t.receipts.find((r) => r.receipt_id === 'R_FT').receipt.Action.actions[0].FunctionCall.args = b64({ receiver_id: ALICE, amount: '1' }); assert.ok(failedNames(await verifyPay(t)).some((n) => /ft_transfer amount/.test(n)));
    t = payTx(); t.receipts = t.receipts.filter((r) => r.receipt_id !== 'R_CB'); assert.ok(failedNames(await verifyPay(t)).some((n) => /on_paid callback receipt present/.test(n)));
    t = payTx(); t.receipts.find((r) => r.receipt_id === 'R_CB').receipt.Action.actions[0].FunctionCall.args = b64({ token: USDC, to: BOB, amount: String(25n * M) }); assert.ok(failedNames(await verifyPay(t)).some((n) => /on_paid names/.test(n)));
    t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_FT').outcome.executor_id = 'fake-token.testnet'; assert.ok(failedNames(await verifyPay(t)).some((n) => /token executed/.test(n)));
  });
  test('events: exactly one vault `paid` naming this agent / token / payee / amount; only events logged by the VAULT count', async () => {
    let t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_PAY').outcome.logs = []; assert.ok(failedNames(await verifyPay(t)).some((n) => /exactly one `paid`/.test(n)));
    t = payTx(); const lg = t.receipts_outcome.find((o) => o.id === 'R_PAY').outcome.logs; t.receipts_outcome.find((o) => o.id === 'R_PAY').outcome.logs = [lg[0], lg[0]]; assert.ok(failedNames(await verifyPay(t)).some((n) => /exactly one `paid`/.test(n)));
    // a `paid` log printed by the token contract (or any other account) is not the vault's event
    t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_FT').outcome.logs.push(lg[0]); t.receipts_outcome.find((o) => o.id === 'R_PAY').outcome.logs = []; assert.equal((await verifyPay(t)).ok, false);
    t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_FT').outcome.logs.push(`EVENT_JSON:${JSON.stringify({ standard: 'autonear_vault', event: 'pay_failed', data: {} })}`); assert.equal((await verifyPay(t)).ok, true, 'a pay_failed printed by the TOKEN is not the vault\'s');
    // token events: when the token emits NEP-141 events one must be vault -> payee for the amount
    t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_FT').outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: VAULT, new_owner_id: BOB, amount: String(25n * M) }] })}`];
    assert.ok(failedNames(await verifyPay(t)).some((n) => /token event ft_transfer/.test(n)));
    // ...and the event is MANDATORY: a token that reports success but emits no NEP-141 event is not a payment
    t = payTx(); t.receipts_outcome.find((o) => o.id === 'R_FT').outcome.logs = []; const none = await verifyPay(t); assert.equal(none.ok, false); assert.equal(none.paid, null);
    assert.deepEqual(failedNames(none), ['token event ft_transfer vault -> payee for the approved amount']); assert.ok(none.checks.every((c) => !c.info));
  });
  test('unknown tx, unreachable node, bad hash, mainnet, bad inputs: a failed verification, never a throw and never a pass', async () => {
    const w = makeChain(); w.txs = {};
    let r = await adapter.verifyPay({ ...want, fetchImpl: rpc(w) }); assert.equal(r.ok, false); assert.ok(failedNames(r).some((n) => /found and verifiable/.test(n)));
    r = await adapter.verifyPay({ ...want, fetchImpl: rpc({ ...makeChain(), down: true }) }); assert.equal(r.ok, false);
    r = await adapter.verifyPay({ ...want, txHash: 'not a hash', fetchImpl: rpc(w) }); assert.equal(r.ok, false);
    r = await adapter.verifyPay({ ...want, net: { ...NET, mainnet: true }, fetchImpl: async () => { throw new Error('must not call'); } }); assert.equal(r.ok, false);
    for (const bad of [{ amount: '0' }, { amount: 'x' }, { token: 'BAD' }, { to: undefined }, { vault: 'BAD' }]) assert.equal((await adapter.verifyPay({ ...want, ...bad, fetchImpl: rpc(w) })).ok, false);
  });
  test('falls back to `tx` when the node has no EXPERIMENTAL_tx_status receipts, and refuses a tx without receipts', async () => {
    const w = makeChain(); w.txs[TX] = payTx();
    const { receipts: _r, ...noReceipts } = payTx();
    w.txs[TX] = noReceipts; const r = await adapter.verifyPay({ ...want, fetchImpl: rpc(w) });
    assert.equal(r.ok, false); assert.ok(failedNames(r).some((n) => /exactly one vault -> token ft_transfer/.test(n)));
  });
});

describe('payouts grant: proposal', { skip: skipNoBuilds }, () => {
  test('payload `payouts` = tokens (with server-read symbol / decimals), payees, fund; the mock token is detected from its metadata; client symbol / decimals / mock are ignored', async () => {
    const world = await makeWorld({ grant: false });
    const p = await world.propose({ payouts: { tokens: [{ token: USDC, symbol: 'FAKE', decimals: 18, mock: false, perPayCap: String(40n * M), periodCap: String(100n * M), totalCap: String(400n * M) }], payees: [ALICE, BOB], fund: { token: USDC, amount: String(500n * M) } } });
    assert.equal(p.status, 201, p.text);
    assert.deepEqual(p.json.payload.payouts, {
      tokens: [{ token: USDC, symbol: 'USDC', decimals: 6, perPayCap: '40000000', periodCap: '100000000', totalCap: '400000000', mock: true }],
      payees: [ALICE, BOB], fund: { token: USDC, amount: '500000000' },
    });
    assert.equal(p.json.max_spend, p.json.payload.mandate.totalCap, 'the decision spend stays the NEAR total cap');
    const ft = world.w.calls.filter((c) => c.method === 'query' && c.params.method_name === 'ft_metadata'); assert.ok(ft.length >= 1, 'metadata was read from the token');
  });
  test('a non-mock token has no `mock` flag; fund is optional (omitted when absent or 0)', async () => {
    const world = await makeWorld({ grant: false });
    const p = await world.propose({ payouts: { tokens: [{ token: USDT, perPayCap: '1000000', periodCap: '2000000', totalCap: '3000000' }], payees: [ALICE], fund: { token: USDT, amount: '0' } } });
    assert.equal(p.status, 201, p.text); assert.deepEqual(p.json.payload.payouts, { tokens: [{ token: USDT, symbol: 'USDT', decimals: 6, perPayCap: '1000000', periodCap: '2000000', totalCap: '3000000' }], payees: [ALICE] });
  });
  test('a grant without `payouts` is exactly the old payload (no payouts key) and still works on the payouts build', async () => {
    const world = await makeWorld({ grant: false, payouts: null });
    const p = await world.propose(); assert.equal(p.status, 201, p.text);
    assert.deepEqual(Object.keys(p.json.payload), ['kind', 'vault', 'agent', 'mandate', 'templates', 'fund', 'loop']);
    assert.equal(world.w.calls.filter((c) => c.method === 'query' && c.params.method_name === 'ft_metadata').length, 0);
  });
  test('the vault must be the payouts build: a v1 vault with `payouts` is refused (409), a v1 grant on a v1 vault works', async () => {
    const world = await makeWorld({ pay: false, grant: false, payouts: null });
    const bad = await world.propose({ payouts: { tokens: [{ token: USDC, perPayCap: '1', periodCap: '1', totalCap: '1' }], payees: [ALICE] } });
    assert.equal(bad.status, 409); assert.match(bad.json.error, /v1 build.*payouts build/);
    assert.equal((await world.propose()).status, 201);
    assert.equal(world.w.calls.filter((c) => c.method === 'query' && c.params.method_name === 'ft_metadata').length, 0, 'nothing is read from a token for a refused request');
  });
  test('refusals: not an NEP-141 token, no usable symbol/decimals, caps over the ceiling in token units, bad accounts, duplicates, unknown fields, sizes, mainnet', async () => {
    const world = await makeWorld({ grant: false });
    const body = (over) => ({ payouts: { tokens: [{ token: USDC, perPayCap: '1', periodCap: '2', totalCap: '3' }], payees: [ALICE], ...over } });
    let r = await world.propose(body({ tokens: [{ token: 'nothing.testnet', perPayCap: '1', periodCap: '2', totalCap: '3' }] })); assert.equal(r.status, 400); assert.match(r.json.error, /not a readable NEP-141 token/);
    world.w.views['weird.testnet'] = { ft_metadata: { name: 'x', symbol: 'A B', decimals: 6 } };
    r = await world.propose(body({ tokens: [{ token: 'weird.testnet', perPayCap: '1', periodCap: '2', totalCap: '3' }] })); assert.equal(r.status, 400); assert.match(r.json.error, /usable symbol/);
    world.w.views['nodec.testnet'] = { ft_metadata: { name: 'x', symbol: 'NODEC', decimals: 'many' } };
    r = await world.propose(body({ tokens: [{ token: 'nodec.testnet', perPayCap: '1', periodCap: '2', totalCap: '3' }] })); assert.equal(r.status, 400); assert.match(r.json.error, /usable decimals/);
    r = await world.propose(body({ tokens: [{ token: USDC, perPayCap: '1', periodCap: '2', totalCap: String(1001n * M) }] })); assert.equal(r.status, 400); assert.equal(r.json.code, 'spend'); assert.match(r.json.error, /exceeds the ceiling 1000000000 \(6 decimals\)/);
    r = await world.propose(body({ tokens: [{ token: USDC, perPayCap: '5', periodCap: '2', totalCap: '3' }] })); assert.equal(r.status, 400); assert.match(r.json.error, /perPayCap <= periodCap/);
    r = await world.propose(body({ payees: ['BAD'] })); assert.equal(r.status, 400);
    r = await world.propose(body({ payees: [ALICE, ALICE] })); assert.equal(r.status, 400); assert.match(r.json.error, /listed twice/);
    r = await world.propose(body({ payees: [USDC] })); assert.equal(r.status, 400); assert.match(r.json.error, /both a token and a payee/);
    r = await world.propose(body({ payees: [VAULT] })); assert.equal(r.status, 400);
    r = await world.propose(body({ payees: [] })); assert.equal(r.status, 400);
    r = await world.propose(body({ tokens: [] })); assert.equal(r.status, 400);
    r = await world.propose(body({ payees: Array.from({ length: 65 }, (_, i) => `p${i}.testnet`) })); assert.equal(r.status, 400);
    r = await world.propose(body({ extra: 1 })); assert.equal(r.status, 400); assert.match(r.json.error, /unexpected field/);
    r = await world.propose(body({ fund: { token: USDT, amount: '5' } })); assert.equal(r.status, 400);
    r = await world.propose({ payouts: 'yes' }); assert.equal(r.status, 400);
    r = await world.propose({ chainId: 'near-mainnet' }); assert.equal(r.status, 400); assert.equal(r.json.code, 'network_blocked');
    assert.equal((await world.db.get("SELECT COUNT(*) n FROM decisions WHERE action='grant_mandate'")).n, 0, 'nothing was stored by any refused proposal');
  });
});

describe('activation and verifyMandate with payouts', { skip: skipNoBuilds }, () => {
  test('exact match activates; the build of record is the payouts build (vaults.attested_ref = its sha256) and the report says so', async () => {
    const world = await makeWorld();
    assert.equal(world.activation.json.activated, true, world.activation.text);
    const row = await world.db.get('SELECT * FROM vaults WHERE id=?', [world.vaultId]);
    assert.equal(row.status, 'active'); assert.equal(row.attested_ref, ATTESTED_BUILDS.pay.sha256); assert.equal(buildOfAttestedRef(adapter, row.attested_ref), 'pay');
    const v = (await world.api('/api/vault')).json.vaults[0]; assert.equal(v.build, 'pay');
    const ver = (await world.api(`/api/vault/verify?decisionId=${world.grant.id}`)).json;
    assert.equal(ver.ok, true, JSON.stringify(ver.fields.filter((f) => !f.ok)));
    for (const re of [/vault is the payouts build/, /payout token usdc\.testnet allowlisted/, /perPayCap == approved/, /periodCap == approved/, /totalCap == approved/, /every approved payee/, /no payee allowlisted that this decision did not approve/, /no payout token allowlisted that this decision did not approve/]) assert.ok(ver.fields.some((f) => re.test(f.name)), String(re));
  });
  test('each deviation on chain is a mismatch and leaves the vault inactive: missing token, any cap, extra token, missing payee, extra payee', async () => {
    const cases = {
      'missing token': (w) => { w.onChainTokens = []; },
      'perPayCap differs': (w) => { w.onChainTokens[0].perPayCap = String(41n * M); },
      'periodCap differs': (w) => { w.onChainTokens[0].periodCap = String(99n * M); },
      'totalCap differs': (w) => { w.onChainTokens[0].totalCap = String(401n * M); },
      'extra token': (w) => { w.onChainTokens.push({ token: USDT, perPayCap: '1', periodCap: '1', totalCap: '1' }); },
      'missing payee': (w) => { w.onChainPayees = [ALICE]; },
      'extra payee': (w) => { w.onChainPayees.push(CAROL); },
      'swapped payee': (w) => { w.onChainPayees = [ALICE, CAROL]; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const world = await makeWorld({ mutate });
      assert.equal(world.activation.json.activated, false, name);
      assert.equal((await world.db.get('SELECT status FROM vaults WHERE id=?', [world.vaultId])).status, 'attached', name);
      const ver = (await world.api(`/api/vault/verify?decisionId=${world.grant.id}`)).json; assert.equal(ver.ok, false, name);
      assert.ok(ver.fields.some((f) => !f.ok), name);
    }
  });
  test('a grant WITH payouts never activates a v1-build vault (verifyMandate: "vault is the payouts build")', async () => {
    const world = await makeWorld();
    const state = (await world.refresh()).state;
    const asV1 = { ...state, build: 'v1' }; delete asV1.payouts;
    const r = verifyMandate(asV1, world.grant.payload, { protocol: 'near', adapter });
    assert.equal(r.ok, false); assert.ok(r.checks.some((c) => !c.ok && /payouts build/.test(c.name)));
    assert.equal(verifyMandate(state, world.grant.payload, { protocol: 'near', adapter }).ok, true);
  });
  test('v1 grant (no payouts) on a payouts-build vault: activates while nothing is configured, a MISMATCH once the owner allowlisted a token or a payee the grant never named', async () => {
    const clean = await makeWorld({ payouts: null });
    assert.equal(clean.activation.json.activated, true, clean.activation.text);
    assert.equal((await clean.db.get('SELECT attested_ref a FROM vaults')).a, ATTESTED_BUILDS.pay.sha256);
    assert.equal((await clean.api('/api/vault')).json.vaults[0].build, 'pay');
    for (const [name, mutate] of Object.entries({ 'token configured': (w) => { w.onChainTokens = [{ token: USDC, perPayCap: '1', periodCap: '1', totalCap: '1' }]; }, 'payee configured': (w) => { w.onChainPayees = [ALICE]; } })) {
      const world = await makeWorld({ payouts: null, mutate });
      assert.equal(world.activation.json.activated, false, name);
      const ver = (await world.api(`/api/vault/verify?decisionId=${world.grant.id}`)).json;
      assert.ok(ver.fields.some((f) => !f.ok && /no payout token or payee configured on-chain/.test(f.name)), name);
    }
  });
  test('a v1 grant on a v1 vault is exactly as before: no payout checks at all, attested_ref = the v1 build', async () => {
    const world = await makeWorld({ pay: false, payouts: null });
    assert.equal(world.activation.json.activated, true, world.activation.text);
    assert.equal((await world.db.get('SELECT attested_ref a FROM vaults')).a, ATTESTED_BUILDS.v1.sha256);
    const ver = (await world.api(`/api/vault/verify?decisionId=${world.grant.id}`)).json;
    assert.ok(!ver.fields.some((f) => /payout|payee/i.test(f.name)));
    const v = (await world.api('/api/vault')).json.vaults[0]; assert.equal(v.build, 'v1'); assert.equal('payouts' in v, false);
  });
  test('the epoch pin still applies: a new mandate epoch on chain needs a new approved grant', async () => {
    const world = await makeWorld();
    world.w.views[VAULT].config.epoch = '2';
    const ver = (await world.api(`/api/vault/verify?decisionId=${world.grant.id}`)).json;
    assert.equal(ver.ok, false); assert.ok(ver.fields.some((f) => !f.ok && /epoch/.test(f.name)));
  });
});

describe('state: normalizeState keeps payouts; modelFromState rebuilds the model for parity checks', { skip: skipNoBuilds }, () => {
  test('normalizeState keeps build + payouts as BigInts; v1 state has neither key', async () => {
    const world = await makeWorld();
    const s = (await world.refresh()).state;
    assert.equal(s.build, 'pay'); assert.deepEqual(s.payees ?? s.payouts.payees, [ALICE, BOB]);
    assert.deepEqual(s.payouts.tokens, [{ token: USDC, perPayCap: 40n * M, periodCap: 100n * M, totalCap: 400n * M, usage: { total: 0n, period: 0n, periodIndex: 0n } }]);
    const v1 = await makeWorld({ pay: false, payouts: null }); const s1 = (await v1.refresh()).state;
    assert.equal(s1.build, 'v1'); assert.equal('payouts' in s1, false);
    assert.throws(() => normalizeState({ config: { owner: 'o', epoch: 0 }, mandate: null, blockTime: 1, payouts: { tokens: [{ token: 't.testnet', perPayCap: 'x' }], payees: [] } }), /not an integer/);
  });
  test('modelFromState: tokens, payees and usage stamped with config.epoch; previewPay agrees with the amounts the chain enforces', async () => {
    const world = await makeWorld();
    world.w.usage[USDC] = { total_spent: String(380n * M), period_index: '0', period_spent: String(90n * M) };
    const s = (await world.refresh()).state;
    const model = modelFromState(s, 'near', { vaultId: VAULT });
    assert.ok(model instanceof VaultModel); assert.equal(model.vaultId, VAULT);
    assert.deepEqual([...model.payees], [ALICE, BOB]); assert.deepEqual(model.tokens.get(USDC), { perPayCap: 40n * M, periodCap: 100n * M, totalCap: 400n * M });
    assert.deepEqual(model.tokenUsage.get(USDC), { epoch: s.config.epoch, total: 380n * M, periodIndex: 0n, period: 90n * M });
    const t = s.blockTime;
    assert.equal(model.previewPay(USDC, ALICE, 10n * M, { now: t }), '');
    assert.equal(model.previewPay(USDC, ALICE, 11n * M, { now: t }), 'PeriodCap', '90 spent of 100 this period');
    assert.equal(model.previewPay(USDC, ALICE, 21n * M, { now: t }), 'PeriodCap');
    assert.equal(model.previewPay(USDC, ALICE, 41n * M, { now: t }), 'PerPayCap');
    assert.equal(model.previewPay(USDC, CAROL, 1n, { now: t }), 'PayeeNotAllowed'); assert.equal(model.previewPay(USDT, ALICE, 1n, { now: t }), 'TokenNotAllowed');
    assert.equal(model.previewPay(USDC, ALICE, 0n, { now: t }), 'BadAmount');
    const later = modelFromState(s, 'near', { vaultId: VAULT }); later.tokenUsage.set(USDC, { ...later.tokenUsage.get(USDC), period: 0n, total: 395n * M });
    assert.equal(later.previewPay(USDC, ALICE, 6n * M, { now: t }), 'TotalCap');
    // a different epoch's usage reads as zero (the stamp matters)
    model.config.epoch = s.config.epoch + 1n; assert.equal(model.previewPay(USDC, ALICE, 10n * M, { now: t }), '');
    // without a vaultId the default id is used and a v1 state still builds a model (no payouts)
    assert.equal(modelFromState(s, 'near').vaultId, 'vault');
    const v1 = (await (await makeWorld({ pay: false, payouts: null })).refresh()).state; assert.equal(modelFromState(v1, 'near').tokens.size, 0);
  });
});

describe('human plan with payouts', { skip: skipNoBuilds }, () => {
  test('owner steps in a safe order: registrations, allow_token, allow_payee, mint (mock token) with a storage deposit, owner ft_transfer of fund.amount to the vault (1 yocto)', async () => {
    const world = await makeWorld({ grant: false });
    const g = (await world.propose()).json;
    const plan = (await world.api(`/api/vault/plan?decisionId=${g.id}`)).json;
    const titles = plan.steps.map((s) => s.title);
    const idx = (re) => titles.findIndex((t) => re.test(t));
    assert.ok(idx(/^allow_template/) < idx(/^set_mandate/) && idx(/^set_mandate/) < idx(/^storage_deposit: register vault\.testnet/));
    assert.ok(idx(/^storage_deposit: register vault/) < idx(/^allow_token/) && idx(/^allow_token/) < idx(/^allow_payee: alice/) && idx(/^allow_payee: bob/) < idx(/^mint /));
    assert.ok(idx(/^mint /) < idx(/^Fund the vault with 500 USDC/) && idx(/^Fund the vault with 500 USDC/) < idx(/^Seed the agent/));
    const human = plan.steps.filter((s) => s.who === 'human' && s.call);
    const by = (m) => human.filter((s) => s.call.method === m);
    assert.deepEqual(by('storage_deposit').map((s) => [s.call.receiverId, s.call.args.account_id]), [[USDC, VAULT], [USDC, ALICE], [USDC, BOB]]);
    assert.ok(by('storage_deposit').every((s) => s.call.args.registration_only === true && BigInt(s.call.deposit) > 0n));
    assert.deepEqual(by('allow_token').map((s) => [s.call.receiverId, s.call.args]), [[VAULT, { token: USDC, per_pay_cap: '40000000', period_cap: '100000000', total_cap: '400000000' }]]);
    assert.deepEqual(by('allow_payee').map((s) => s.call.args), [{ account: ALICE }, { account: BOB }]);
    const mint = by('mint'); assert.equal(mint.length, 1);
    assert.deepEqual([mint[0].call.receiverId, mint[0].call.args], [USDC, { account_id: OWNER, amount: '500000000' }]);
    assert.ok(BigInt(mint[0].call.deposit) > 0n, 'the mock mint needs an attached storage deposit for an unregistered receiver');
    assert.match(mint[0].note, /storage fee.*not registered.*refunded/s);
    const ft = by('ft_transfer'); assert.equal(ft.length, 1);
    assert.deepEqual([ft[0].call.receiverId, ft[0].call.args.receiver_id, ft[0].call.args.amount, ft[0].call.deposit], [USDC, VAULT, '500000000', '1']);
    for (const s of [...by('mint'), ...ft, ...by('allow_token')]) { assert.equal(typeof s.call.gas, 'string'); assert.match(s.cli, /^near contract call-function as-transaction /); assert.doesNotMatch(s.cli, /private|secret/i); assert.ok(s.cli.includes(`sign-as '${OWNER}'`)); }
    assert.ok(plan.steps.some((s) => s.who === 'server' && /Payout check/.test(s.title)));
  });
  test('no mint step for a token that is not the mock; no funding steps without fund; a v1 plan is unchanged', async () => {
    const usdt = await makeWorld({ grant: false, payouts: null });
    const g = (await usdt.propose({ payouts: { tokens: [{ token: USDT, perPayCap: '5', periodCap: '6', totalCap: '7' }], payees: [ALICE], fund: { token: USDT, amount: '7' } } })).json;
    const calls = (await usdt.api(`/api/vault/plan?decisionId=${g.id}`)).json.steps.filter((s) => s.call).map((s) => s.call.method);
    assert.ok(!calls.includes('mint') && calls.includes('ft_transfer'), calls.join(','));
    const nofund = await makeWorld({ grant: false, payouts: null });
    const g2 = (await nofund.propose({ payouts: { tokens: [{ token: USDC, perPayCap: '5', periodCap: '6', totalCap: '7' }], payees: [ALICE] } })).json;
    const c2 = (await nofund.api(`/api/vault/plan?decisionId=${g2.id}`)).json.steps.filter((s) => s.call).map((s) => s.call.method);
    assert.ok(!c2.includes('mint') && !c2.includes('ft_transfer') && c2.includes('allow_token'));
    const v1 = await makeWorld({ pay: false, grant: false, payouts: null });
    const g3 = (await v1.propose()).json;
    const p3 = (await v1.api(`/api/vault/plan?decisionId=${g3.id}`)).json.steps;
    assert.deepEqual(p3.filter((s) => s.call).map((s) => s.call.method), ['allow_template', 'set_mandate', null], 'allow_template, set_mandate, agent seed: nothing about tokens');
    assert.ok(!JSON.stringify(p3).match(/allow_token|storage_deposit|Payout check/));
  });
  test('a fund above one mint call (10,000 whole tokens) is split into several mint steps; the funding transfer carries the whole amount', () => {
    const payload = { vault: { address: VAULT, owner: OWNER }, agent: { account: AGENT }, mandate: { expiresAt: '5', perDrawCap: '1', periodSecs: '3600', periodCap: '1', totalCap: '1', maxDeploys: '0' }, templates: [], fund: { amount: '0' },
      payouts: { tokens: [{ token: USDC, symbol: 'USDC', decimals: 6, perPayCap: '1', periodCap: '1', totalCap: '1', mock: true }], payees: [ALICE], fund: { token: USDC, amount: String(25_000n * M) } } };
    const steps = adapter.planSteps({ net: NET, payload, vault: VAULT }).filter((s) => s.call);
    const mints = steps.filter((s) => s.call.method === 'mint').map((s) => s.call.args.amount);
    assert.deepEqual(mints, [String(10_000n * M), String(10_000n * M), String(5_000n * M)]);
    assert.equal(steps.find((s) => s.call.method === 'ft_transfer').call.args.amount, String(25_000n * M));
  });
});

describe('vault report with payouts', { skip: skipNoBuilds }, () => {
  test('build, tokens (caps, usage, remaining, vault balance via ft_balance_of) and payees; usage and balance follow the chain', async () => {
    const world = await makeWorld();
    const rep = async () => (await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 0 })).vaults[0];
    let v = await rep();
    assert.equal(v.build, 'pay');
    assert.deepEqual(v.payouts.payees, [{ account: ALICE, matches: true }, { account: BOB, matches: true }]);
    assert.deepEqual(v.payouts.tokens, [{
      token: USDC, symbol: 'USDC', decimals: 6, perPayCap: '40000000', periodCap: '100000000', totalCap: '400000000',
      usage: { totalSpent: '0', periodSpent: '0' }, remaining: { period: '100000000', total: '400000000', maxPayment: '40000000' }, balance: '500000000', matches: true,
    }]);
    world.w.usage[USDC] = { total_spent: String(380n * M), period_index: '0', period_spent: String(90n * M) }; world.w.balances[VAULT] = String(120n * M);
    await world.refresh();
    v = await rep();
    assert.deepEqual(v.payouts.tokens[0].usage, { totalSpent: '380000000', periodSpent: '90000000' });
    assert.deepEqual(v.payouts.tokens[0].remaining, { period: '10000000', total: '20000000', maxPayment: '10000000' });
    assert.equal(v.payouts.tokens[0].balance, '120000000');
    // a payee/token on chain that the grant does not name is shown, flagged
    world.w.onChainPayees.push(CAROL); await world.refresh();
    v = await rep(); assert.deepEqual(v.payouts.payees.map((p) => [p.account, p.matches]), [[ALICE, true], [BOB, true], [CAROL, false]]);
  });
  test('a token balance that cannot be read does not break the report', async () => {
    const world = await makeWorld();
    world.w.views[USDC].ft_balance_of = () => { throw new Error('boom'); };
    const v = (await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 0 })).vaults[0];
    assert.equal(v.payouts.tokens[0].balance, null); assert.match(v.payouts.tokens[0].balanceError, /boom|ft_balance_of/);
    assert.equal(v.payouts.tokens[0].perPayCap, '40000000');
  });
  test('concurrent public reports share ONE in-flight token balance read (no RPC fan-out)', async () => {
    const world = await makeWorld();
    const count = () => world.w.calls.filter((c) => c.params?.method_name === 'ft_balance_of').length;
    await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 0 }); const n = count(); // also warms everything else
    const reports = await Promise.all(Array.from({ length: 8 }, () => vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 60_000 })));
    const tokens = reports[0].vaults[0].payouts.tokens.length;
    assert.ok(count() - n <= tokens, `at most one read per token for 8 concurrent reports, got ${count() - n}`);
    assert.ok(reports.every((r) => r.vaults[0].payouts.tokens[0].balance === reports[0].vaults[0].payouts.tokens[0].balance));
  });
  test('a token balance read that never settles times out; the next report is not stuck on it', async () => {
    const world = await makeWorld();
    const hang = (url, init) => { const b = JSON.parse(init?.body ?? '{}'); if (b.params?.method_name === 'ft_balance_of') return new Promise(() => {}); return world.fetchImpl(url, init); };
    const t0 = Date.now();
    const r = await vaultReport(world.db, { fetchImpl: hang, balanceMaxAgeMs: 0, balanceTimeoutMs: 50 });
    assert.ok(Date.now() - t0 < 5000, 'returned despite the hung read');
    const tok = r.vaults[0].payouts.tokens[0];
    assert.equal(tok.balance, null); assert.match(String(tok.balanceError), /timed out/);
    const again = await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 0 });
    assert.notEqual(again.vaults[0].payouts.tokens[0].balance, null, 'a later report reads normally');
  });
  test('balance reads are cached per database for a few seconds (a polling UI is not one RPC per poll)', async () => {
    const world = await makeWorld();
    const count = () => world.w.calls.filter((c) => c.params?.method_name === 'ft_balance_of').length;
    await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 60_000 }); const n = count();
    await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 60_000 }); assert.equal(count(), n);
    await vaultReport(world.db, { fetchImpl: world.fetchImpl, balanceMaxAgeMs: 0 }); assert.equal(count(), n + 1);
  });
});

describe('POST/GET /api/payments', { skip: skipNoBuilds }, () => {
  const body = (o = {}) => ({ token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', ...o });

  test('creates a pending pay_testnet decision with nonce, payload hash and expiry, exactly like other decisions', async () => {
    const world = await makeWorld();
    const r = await world.pay(body({ reference: 'inv-42' }));
    assert.equal(r.status, 201, r.text);
    const d = r.json;
    assert.match(d.id, /^dec_[0-9a-f]{14}$/); assert.equal(d.action, 'pay_testnet'); assert.equal(d.status, 'pending'); assert.equal(d.chain_id, 'near-testnet');
    assert.equal(d.target, VAULT); assert.equal(d.method, 'pay'); assert.equal(d.max_spend, String(25n * M)); assert.match(d.nonce, /^[0-9a-f]{24}$/);
    assert.deepEqual(d.payload, { action: 'pay_testnet', protocol: 'near', network: 'near-testnet', vault: VAULT, token: USDC, symbol: 'USDC', decimals: 6, payee: ALICE, amount: '25000000', memo: 'invoice 42', reference: 'inv-42' });
    const row = await world.db.get('SELECT * FROM decisions WHERE id=?', [d.id]);
    assert.equal(d.payload_hash, sha256(row.payload)); assert.equal(row.payload_hash, d.payload_hash);
    assert.ok(row.expiry > now() + 23 * 3600_000 && row.expiry <= now() + 24 * 3600_000 + 1000);
    assert.equal(d.created, true); assert.deepEqual(d.decision.id, d.id); assert.equal(d.confirmPhrase, `approve ${d.id}`); assert.equal(d.payment, null);
    assert.equal(row.artifact_hash, ATTESTED_BUILDS.pay.sha256, 'artifact_hash = the attested vault build the payment goes through');
    const a = await world.db.get("SELECT detail FROM audit WHERE action='decision.proposed' ORDER BY id DESC LIMIT 1"); assert.match(a.detail, /pay_testnet/);
  });
  test('symbol and decimals come from the approved grant (token metadata), never from the request: sending them is refused', async () => {
    const world = await makeWorld();
    for (const extra of [{ symbol: 'FAKE' }, { decimals: 18 }, { network: 'near-mainnet' }, { status: 'approved' }]) { const r = await world.pay(body(extra)); assert.equal(r.status, 400, JSON.stringify(extra)); assert.match(r.json.error, /unexpected field/); }
    assert.equal((await world.db.get("SELECT COUNT(*) n FROM decisions WHERE action='pay_testnet'")).n, 0);
  });
  test('auth: no token 401, a wrong token 401, the operator token and a signed-in OWNER session are accepted, a stranger\'s session is not', async () => {
    const world = await makeWorld();
    assert.equal((await world.pay(body(), { auth: false })).status, 401);
    assert.equal((await apiClient(world.app, 'wrong')('/api/payments', { method: 'POST', body: body() })).status, 401);
    const ownerEvm = '0x' + '5'.repeat(40); const stranger = '0x' + '6'.repeat(40);
    const app = createApp({ db: world.db, operatorToken: OPERATOR, fetchImpl: world.fetchImpl, defer: () => {}, ownerAddress: ownerEvm });
    const secret = deriveSecret(OPERATOR);
    const asOwner = apiClient(app, issueSession({ address: ownerEvm, secret })); const asStranger = apiClient(app, issueSession({ address: stranger, secret }));
    assert.equal((await asStranger('/api/payments', { method: 'POST', body: body() })).status, 401);
    const ok = await asOwner('/api/payments', { method: 'POST', body: body({ amount: String(5n * M) }) }); assert.equal(ok.status, 201, ok.text);
    assert.equal((await world.db.get("SELECT actor FROM audit WHERE action='decision.proposed' ORDER BY id DESC LIMIT 1")).actor, `owner:${ownerEvm}`);
    assert.equal((await world.pay(body({ amount: String(6n * M) }))).status, 201);
  });
  test('GET /api/payments is public and lists requests with plain-words summaries; other methods are 405', async () => {
    const world = await makeWorld();
    assert.deepEqual((await world.api('/api/payments', { auth: false })).json, { items: [] });
    const d = (await world.pay(body())).json;
    const list = (await world.api('/api/payments', { auth: false })).json.items;
    assert.equal(list.length, 1);
    assert.deepEqual({ ...list[0], createdAt: 0, expiry: 0 }, {
      decisionId: d.id, status: 'pending', effectiveStatus: 'pending', vault: VAULT, token: USDC, symbol: 'USDC', decimals: 6, payee: ALICE, amount: '25000000', amountDisplay: '25 USDC',
      memo: 'invoice 42', summary: 'Pay 25 USDC to alice.testnet for invoice 42', createdAt: 0, expiry: 0, approver: null, payment: null,
    });
    const del = await world.api('/api/payments', { method: 'DELETE' }); assert.equal(del.status, 405); assert.match(del.headers.get('allow'), /POST/);
    assert.equal((await world.api('/api/payments?limit=1', { auth: false })).status, 200);
  });
  test('validation: required fields, whole-number amount, memo <= 128 bytes, account ids, unknown fields', async () => {
    const world = await makeWorld();
    const bad = async (o, re) => { const r = await world.pay(o); assert.equal(r.status, 400, JSON.stringify(o)); assert.match(r.json.error, re); };
    await bad({ payee: ALICE, amount: '1' }, /missing "token"/); await bad({ token: USDC, amount: '1' }, /missing "payee"/); await bad({ token: USDC, payee: ALICE }, /missing "amount"/);
    for (const a of ['0', '-5', '1.5', 'abc', '', '01', null, true, [], 2.5]) await bad(body({ amount: a }), /amount/);
    await bad(body({ memo: 'x'.repeat(129) }), /memo/); await bad(body({ memo: 'é'.repeat(65) }), /memo/); await bad(body({ memo: 7 }), /memo|schema/);
    await bad(body({ reference: 'r'.repeat(129) }), /reference/);
    await bad(body({ payee: 'BAD' }), /not one of the payees|payee/);
    assert.equal((await world.pay(body({ memo: 'x'.repeat(128) }))).status, 201);
    const em = await world.pay(body({ memo: '', amount: 25000000 })); assert.equal(em.status, 201, 'a safe-integer amount is accepted and stored as a string');
    assert.equal(em.json.payload.memo, ''); assert.equal(em.json.payload.amount, '25000000');
    assert.equal((await world.api('/api/payments', { method: 'POST', body: [1] })).status, 400);
  });
  test('early checks against the grant AND the vault\'s on-chain allowlist: token, payee, per-payment cap (friendly 409s, the chain still enforces)', async () => {
    const world = await makeWorld();
    let r = await world.pay(body({ token: USDT })); assert.equal(r.status, 409); assert.match(r.json.error, /usdt\.testnet is not one of the tokens the owner approved/);
    r = await world.pay(body({ payee: CAROL })); assert.equal(r.status, 409); assert.match(r.json.error, /carol\.testnet is not one of the payees the owner approved/);
    r = await world.pay(body({ amount: String(41n * M) })); assert.equal(r.status, 409); assert.match(r.json.error, /41 USDC is above the per-payment cap on chain \(40 USDC\)/);
    assert.equal((await world.pay(body({ amount: String(40n * M) }))).status, 201, 'exactly the cap is fine');
    // on-chain drift: the owner removed the payee / token / lowered the cap after the grant
    world.w.onChainPayees = [ALICE]; await world.refresh();
    r = await world.pay(body({ payee: BOB })); assert.equal(r.status, 409); assert.match(r.json.error, /bob\.testnet is not on the vault's on-chain payee list/);
    world.w.onChainTokens[0].perPayCap = String(10n * M); await world.refresh();
    r = await world.pay(body({ amount: String(11n * M) })); assert.equal(r.status, 409); assert.match(r.json.error, /above the per-payment cap on chain \(10 USDC\)/);
    world.w.onChainTokens = []; await world.refresh();
    r = await world.pay(body()); assert.equal(r.status, 409); assert.match(r.json.error, /not on the vault's on-chain allowlist/);
  });
  test('the policy ceiling applies on top: more than 100 whole tokens per payment is refused (400, spend) even when the vault would allow it', async () => {
    const world = await makeWorld({ payouts: { tokens: [{ token: USDC, perPayCap: String(500n * M), periodCap: String(600n * M), totalCap: String(900n * M) }], payees: [ALICE] } });
    assert.equal(world.activation.json.activated, true, world.activation.text);
    const r = await world.pay(body({ amount: String(150n * M) })); assert.equal(r.status, 400); assert.equal(r.json.code, 'spend'); assert.match(r.json.error, /per-payment ceiling 100000000/);
    assert.equal((await world.pay(body({ amount: String(100n * M) }))).status, 201);
  });
  test('needs an active vault with payouts in its grant; unreadable vault state is a clear 400; several active vaults need `vault`', async () => {
    const early = await makeWorld({ grant: false });
    let r = await early.pay(body()); assert.equal(r.status, 409); assert.match(r.json.error, /not active yet/);
    const noPayouts = await makeWorld({ payouts: null });
    r = await noPayouts.pay(body()); assert.equal(r.status, 409); assert.match(r.json.error, /no token payouts/);
    const none = createApp({ db: (await makeWorld({ grant: false })).db, operatorToken: OPERATOR, defer: () => {} });
    const world = await makeWorld();
    r = await world.pay(body({ vault: 'nothing.testnet' })); assert.equal(r.status, 404);
    r = await world.pay(body({ vault: VAULT })); assert.equal(r.status, 201);
    await world.db.run('UPDATE vaults SET last_read_at=0 WHERE id=?', [world.vaultId]); world.w.down = true;
    r = await world.pay(body({ amount: '1' })); assert.equal(r.status, 400); assert.equal(r.json.code, 'unavailable'); assert.match(r.json.error, /could not be read just now/);
    void none;
  });
  test('an identical pending request is returned, not duplicated (200, created:false); a different `reference` is a new request', async () => {
    const world = await makeWorld();
    const a = await world.pay(body()); const b = await world.pay(body());
    assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.id, a.json.id); assert.equal(b.json.created, false);
    const c = await world.pay(body({ reference: 'second' })); assert.equal(c.status, 201); assert.notEqual(c.json.id, a.json.id);
    assert.equal((await world.db.get("SELECT COUNT(*) n FROM decisions WHERE action='pay_testnet'")).n, 2);
  });
  test('approve / reject reuse the decision routes: nonce, payload hash, typed phrase and expiry are enforced; the approver becomes the bound signer', async () => {
    const world = await makeWorld();
    const d = (await world.pay(body())).json;
    const approve = (o = {}) => world.api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER, ...o } });
    assert.equal((await approve({ nonce: 'bad' })).status, 409);
    assert.equal((await approve({ payloadHash: 'f'.repeat(64) })).status, 409);
    assert.equal((await approve({ confirm: 'yes' })).status, 400);
    const noSigner = await approve({ signer: 'BAD!' }); assert.equal(noSigner.status, 400); assert.match(noSigner.json.error, /payment approval/);
    const ok = await approve(); assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.status, 'approved'); assert.equal(ok.json.bound_signer, OWNER); assert.equal(ok.json.approver, 'operator');
    assert.equal((await approve()).status, 409, 'once');
    const e = (await world.pay(body({ amount: '7' }))).json;
    const rej = await world.api(`/api/decisions/${e.id}/reject`, { method: 'POST', body: { reason: 'not today' } }); assert.equal(rej.status, 200); assert.equal(rej.json.status, 'rejected');
    assert.equal((await world.api(`/api/decisions/${e.id}/reject`, { method: 'POST' })).status, 409);
    const x = (await world.pay(body({ amount: '8' }))).json; await world.db.run('UPDATE decisions SET expiry=? WHERE id=?', [now() - 1, x.id]);
    assert.equal((await world.api(`/api/decisions/${x.id}/approve`, { method: 'POST', body: { nonce: x.nonce, payloadHash: x.payload_hash, confirm: `approve ${x.id}`, signer: OWNER } })).status, 409);
    assert.equal((await world.api('/api/payments', { auth: false })).json.items.find((i) => i.decisionId === x.id).effectiveStatus, 'expired');
    // approval never moves money or records a payment
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0); assert.equal((await world.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0);
  });
  test('kill switch: a paused system refuses approvals of payments like any other decision', async () => {
    const world = await makeWorld();
    const d = (await world.pay(body())).json;
    assert.equal((await world.api('/api/security/pause', { method: 'POST' })).status, 200);
    const r = await world.api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER } });
    assert.equal(r.status, 423);
  });
  test('createPayment is also callable directly (what a CLI would use)', async () => {
    const world = await makeWorld();
    const d = await createPayment(world.db, body(), { fetchImpl: world.fetchImpl, actor: 'cli' });
    assert.equal(d.created, true); assert.equal(d.action, 'pay_testnet');
    assert.equal((await listPayments(world.db)).items.length, 1);
  });
});

describe('approveUnderMandate with pay_testnet', { skip: skipNoBuilds }, () => {
  const approveByOwner = async (world, d) => (await world.api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER } })).status;
  const newPay = async (world, o = {}) => (await world.pay({ token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', ...o })).json;

  test('owner path (Manual): an owner-approved payment is claimed under the mandate; the record says the owner approved and did not sign; one mandate_run', async () => {
    const world = await makeWorld(); const d = await newPay(world); assert.equal(await approveByOwner(world, d), 200);
    const vault = await getVault(world.db, world.vaultId);
    const r = await approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true });
    assert.equal(r.status, 'approved'); assert.equal(r.approver, `mandate:${world.vaultId}:1+operator`); assert.equal(r.bound_signer, VAULT);
    assert.equal(r.approval.humanApproved, true); assert.equal(r.approval.humanSigned, false);
    const run = await world.db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [d.id]); assert.deepEqual([run.vault_id, run.epoch, run.status], [world.vaultId, 1, 'claimed']);
    assert.match((await world.db.get("SELECT detail FROM audit WHERE action='decision.owner_approved_executed_under_mandate'")).detail, /pay|operator/);
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true }), (e) => e.code === 'state', 'one execution per decision, ever');
  });
  test('Auto path: a pending payment nobody touched is claimed under the mandate (approver mandate:<vault>:<epoch>, no human)', async () => {
    const world = await makeWorld(); const d = await newPay(world);
    const r = await approveUnderMandate(world.db, d.id, { vault: await getVault(world.db, world.vaultId), epoch: 1 });
    assert.equal(r.approver, `mandate:${world.vaultId}:1`); assert.equal(r.approval.humanApproved, false);
    const h = await newPay(world, { amount: '9' }); assert.equal(await approveByOwner(world, h), 200);
    await assert.rejects(approveUnderMandate(world.db, h.id, { vault: await getVault(world.db, world.vaultId), epoch: 1 }), (e) => e.code === 'state', 'an owner-approved decision cannot take the Auto path');
  });
  test('the owner path refuses a payment the owner has not approved; only one payment is in flight per vault', async () => {
    const world = await makeWorld(); const vault = await getVault(world.db, world.vaultId);
    const a = await newPay(world); await assert.rejects(approveUnderMandate(world.db, a.id, { vault, epoch: 1, byOwner: true }), (e) => e.code === 'state');
    await approveByOwner(world, a); await approveUnderMandate(world.db, a.id, { vault, epoch: 1, byOwner: true });
    const b = await newPay(world, { amount: '9' }); await approveByOwner(world, b);
    await assert.rejects(approveUnderMandate(world.db, b.id, { vault, epoch: 1, byOwner: true }), /another agent action is already in flight/);
  });
  test('guards: inactive vault, other network, expiry, mainnet, tampered payload, vault named in the payload, token/payee/cap vs the activated grant, kill switch', async () => {
    const world = await makeWorld(); const vault = await getVault(world.db, world.vaultId);
    const mk = async (o) => { const d = await newPay(world, o); await approveByOwner(world, d); return d; };
    const d = await mk({});
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault: { ...vault, status: 'attached' }, epoch: 1, byOwner: true }), /not active/);
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault: { ...vault, chain_id: 'near-mainnet' }, epoch: 1, byOwner: true }), (e) => e.code === 'network_blocked');
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault: { ...vault, address: 'other.testnet' }, epoch: 1, byOwner: true }), /different vault/);
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault, epoch: 'x', byOwner: true }), (e) => e.code === 'input');
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault: { ...vault, mandate_decision_id: 'dec_none' }, epoch: 1, byOwner: true }), /does not include this token/);
  });
  test('guards (continued): hash tamper, grant without the payee, symbol/decimals drift, expired approval, other actions', async () => {
    const world = await makeWorld(); const vault = await getVault(world.db, world.vaultId);
    const d = (await world.pay({ token: USDC, payee: ALICE, amount: '5', memo: 'm' })).json; await approveByOwner(world, d);
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify({ ...d.payload, memo: 'changed' }), d.id]);
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true }), (e) => e.code === 'payload_hash');
    const e = (await world.pay({ token: USDC, payee: BOB, amount: '6', memo: 'm' })).json; await approveByOwner(world, e);
    const grant = JSON.parse((await world.db.get('SELECT payload FROM decisions WHERE id=?', [world.grant.id])).payload);
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify({ ...grant, payouts: { ...grant.payouts, payees: [ALICE] } }), world.grant.id]);
    await assert.rejects(approveUnderMandate(world.db, e.id, { vault, epoch: 1, byOwner: true }), /does not include this payee/);
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify({ ...grant, payouts: { ...grant.payouts, tokens: [{ ...grant.payouts.tokens[0], decimals: 18 }] } }), world.grant.id]);
    await assert.rejects(approveUnderMandate(world.db, e.id, { vault, epoch: 1, byOwner: true }), /symbol or decimals differ/);
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify({ ...grant, payouts: { ...grant.payouts, tokens: [{ ...grant.payouts.tokens[0], perPayCap: '5' }] } }), world.grant.id]);
    await assert.rejects(approveUnderMandate(world.db, e.id, { vault, epoch: 1, byOwner: true }), /above the per-payment cap the owner set \(0\.000005 USDC\)/);
    await world.db.run('UPDATE decisions SET payload=? WHERE id=?', [JSON.stringify(grant), world.grant.id]);
    await world.db.run('UPDATE decisions SET expiry=? WHERE id=?', [now() - 1, e.id]);
    await assert.rejects(approveUnderMandate(world.db, e.id, { vault, epoch: 1, byOwner: true }), /expired/);
    await assert.rejects(approveUnderMandate(world.db, world.grant.id, { vault, epoch: 1 }), /only deploy_testnet and pay_testnet/);
  });
  test('a valid claim succeeds; kill switch refuses; a failed attempt can be released back to the humans', async () => {
    const world = await makeWorld(); const vault = await getVault(world.db, world.vaultId);
    const d = await newPay(world); await approveByOwner(world, d);
    await world.api('/api/security/pause', { method: 'POST' });
    await assert.rejects(approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true }), (e) => e.code === 'paused');
    await world.api('/api/security/resume', { method: 'POST' });
    await approveUnderMandate(world.db, d.id, { vault, epoch: 1, byOwner: true });
    const r = await releaseToHuman(world.db, d.id, 'pay failed');
    assert.equal(r.status, 'pending'); assert.equal(r.approver, null); assert.equal(r.bound_signer, null);
    assert.equal((await world.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'failed');
  });
});

describe('recordPayment', { skip: skipNoBuilds }, () => {
  const setup = async (o = {}) => { const world = await makeWorld(); const d = await approvedPayment(world, o.body); return { world, d }; };
  const tx = (world, t = payTx(), hash = TX) => { world.w.txs[hash] = { ...t, transaction: { ...t.transaction, hash } }; };

  test('verifies the transaction, writes the payments row and marks the decision executed (mandate run confirmed), audit entry; idempotent for the same hash', async () => {
    const { world, d } = await setup(); tx(world);
    const r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    assert.equal(r.recorded, true, JSON.stringify(r.verification?.checks?.filter((c) => !c.ok)));
    assert.deepEqual([r.payment.txHash, r.payment.vaultId], [TX, world.vaultId]); assert.match(r.payment.id, /^pay_[0-9a-f]{14}$/);
    const row = await world.db.get('SELECT * FROM payments WHERE decision_id=?', [d.id]);
    assert.deepEqual({ ...row, id: 0, verification: 0, created_at: 0 }, { id: 0, decision_id: d.id, vault_id: world.vaultId, token: USDC, payee: ALICE, amount: '25000000', tx_hash: TX, status: 'verified', verification: 0, created_at: 0 });
    assert.equal(JSON.parse(row.verification).ok, true); assert.equal(JSON.parse(row.verification).via.humanSigned, false);
    assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'executed');
    const run = await world.db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [d.id]); assert.deepEqual([run.status, run.tx_hash], ['confirmed', TX]);
    assert.match((await world.db.get("SELECT detail FROM audit WHERE action='payment.recorded'")).detail, new RegExp(TX));
    const again = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    assert.equal(again.recorded, true); assert.equal(again.idempotent, true); assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 1);
    await assert.rejects(recordPayment(world.db, d.id, { txHash: TX2, fetchImpl: world.fetchImpl }), /different transaction is already recorded/);
    // the decision now shows the payment, and the list links it to the explorer
    assert.equal((await getDecision(world.db, d.id)).payment.tx_hash, TX);
    const item = (await listPayments(world.db)).items[0]; assert.equal(item.payment.txHash, TX); assert.equal(item.payment.explorerUrl, `https://testnet.nearblocks.io/txns/${TX}`); assert.equal(item.effectiveStatus, 'executed');
  });
  test('a failed token transfer (pay_failed) records NOTHING: no row, the decision stays approved, payFailed is reported', async () => {
    const { world, d } = await setup(); tx(world, failedPayTx());
    const r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    assert.equal(r.recorded, false); assert.equal(r.payFailed, true); assert.equal(r.verification.ok, false);
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0);
    assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'approved');
    assert.equal((await world.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'claimed');
    assert.ok(await world.db.get("SELECT 1 x FROM audit WHERE action='payment.rejected'"));
  });
  test('wrong amount, wrong payee, wrong token in the transaction (versus the approved payload) record nothing', async () => {
    for (const bad of [payTx({ amount: String(26n * M) }), payTx({ to: BOB }), payTx({ token: USDT }), payTx({ amount: '1' })]) {
      const { world, d } = await setup(); tx(world, bad);
      const r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
      assert.equal(r.recorded, false); assert.equal(r.payFailed, false);
      assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0); assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'approved');
    }
  });
  test('wrong sender: a transaction not sent by the mandate-bound agent is rejected (even if everything else matches)', async () => {
    const { world, d } = await setup(); tx(world, payTx({ agent: 'evil.testnet' }));
    const r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    assert.equal(r.recorded, false); assert.ok(failedNames(r.verification).some((n) => /signer == the agent/.test(n)));
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0);
  });
  test('a hash already recorded for another decision is refused, even for an identical payment (one transaction proves one payment)', async () => {
    const { world, d } = await setup(); tx(world);
    await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    // a second, identical request approved and claimed under the mandate (the first one is executed, so nothing is in flight)
    const d2 = await approvedPayment(world, { token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', reference: 'again' });
    await assert.rejects(recordPayment(world.db, d2.id, { txHash: TX, fetchImpl: world.fetchImpl }), /already recorded for another payment/);
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 1); assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d2.id])).status, 'approved');
    tx(world, payTx({ hash: TX2 }), TX2);
    assert.equal((await recordPayment(world.db, d2.id, { txHash: TX2, fetchImpl: world.fetchImpl })).recorded, true);
  });
  test('the hash is bound to THIS decision\'s run: a second identical decision cannot be closed with the first one\'s (unrecorded) hash', async () => {
    const world = await makeWorld(); const never = world.fetchImpl;
    const d1 = await approvedPayment(world, { token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', reference: 'one' });
    await world.db.run('UPDATE mandate_runs SET tx_hash=?, status=? WHERE decision_id=?', [TX, 'submitted', d1.id]); // run 1 sent TX and saved it, nobody recorded it yet
    tx(world); // TX really is a good payment of 25 USDC to ALICE
    await world.db.run("UPDATE decisions SET status='executed' WHERE id=?", [d1.id]); // free the in-flight slot without touching run 1's hash
    await world.db.run("UPDATE mandate_runs SET status='failed' WHERE decision_id=?", [d1.id]);
    const d2 = await approvedPayment(world, { token: USDC, payee: ALICE, amount: String(25n * M), memo: 'invoice 42', reference: 'two' });
    await assert.rejects(recordPayment(world.db, d2.id, { txHash: TX, fetchImpl: never }), (e) => e.code === 'state' && /another mandate run/.test(e.message));
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0); assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d2.id])).status, 'approved');
    assert.equal((await world.db.get('SELECT tx_hash FROM mandate_runs WHERE decision_id=?', [d2.id])).tx_hash, null);
    // a run that saved its own hash accepts only that hash
    await world.db.run('UPDATE mandate_runs SET tx_hash=? WHERE decision_id=?', [TX2, d2.id]);
    await assert.rejects(recordPayment(world.db, d2.id, { txHash: TX, fetchImpl: never }), (e) => e.code === 'state' && /hash mismatch/.test(e.message));
    tx(world, payTx({ hash: TX2 }), TX2);
    assert.equal((await recordPayment(world.db, d2.id, { txHash: TX2, fetchImpl: world.fetchImpl })).recorded, true);
  });
  test('a run with a saved hash records with exactly that hash; lost-hash recovery binds the verified hash to the run once', async () => {
    const a = await setup(); tx(a.world, payTx(), TX);
    await a.world.db.run('UPDATE mandate_runs SET tx_hash=? WHERE decision_id=?', [TX, a.d.id]);
    assert.equal((await recordPayment(a.world.db, a.d.id, { txHash: TX, fetchImpl: a.world.fetchImpl })).recorded, true);
    const b = await setup(); tx(b.world);
    assert.equal((await b.world.db.get('SELECT tx_hash FROM mandate_runs WHERE decision_id=?', [b.d.id])).tx_hash, null);
    // an unverifiable hash binds nothing
    let r = await recordPayment(b.world.db, b.d.id, { txHash: TX2, fetchImpl: b.world.fetchImpl }); assert.equal(r.recorded, false);
    assert.equal((await b.world.db.get('SELECT tx_hash FROM mandate_runs WHERE decision_id=?', [b.d.id])).tx_hash, null);
    r = await recordPayment(b.world.db, b.d.id, { txHash: TX, fetchImpl: b.world.fetchImpl }); assert.equal(r.recorded, true);
    const run = await b.world.db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [b.d.id]); assert.deepEqual([run.tx_hash, run.status], [TX, 'confirmed']);
  });
  test('lost-hash recovery: a hash that another run already carries is refused, even if that run belongs to a different vault decision still unrecorded', async () => {
    const { world, d } = await setup(); tx(world);
    await world.db.run("INSERT INTO mandate_runs(decision_id,vault_id,epoch,tx_hash,status,created_at) VALUES('dec_other','vlt_other',1,?,'failed',?)", [TX, Date.now()]);
    await assert.rejects(recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl }), (e) => e.code === 'state' && /another mandate run/.test(e.message));
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0);
  });
  test('the bind itself is race-safe: if another run takes the hash between the check and the bind, nothing is recorded', async () => {
    const { world, d } = await setup(); tx(world);
    const realRun = world.db.run.bind(world.db);
    world.db.run = async (sql, params) => { // simulate the other run winning the hash right before our conditional UPDATE
      if (/UPDATE mandate_runs SET tx_hash=\? WHERE decision_id=\? AND tx_hash IS NULL/.test(sql)) await realRun("INSERT INTO mandate_runs(decision_id,vault_id,epoch,tx_hash,status,created_at) VALUES('dec_racer','vlt_x',1,?,'submitted',?)", [TX, Date.now()]);
      return realRun(sql, params);
    };
    await assert.rejects(recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl }), (e) => e.code === 'state');
    world.db.run = realRun;
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0); assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'approved');
  });
  test('race: concurrent recordings of one decision write exactly one row', async () => {
    const { world, d } = await setup(); tx(world);
    const rs = await Promise.allSettled([1, 2, 3, 4].map(() => recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl })));
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 1);
    assert.ok(rs.some((r) => r.status === 'fulfilled' && r.value.recorded));
    for (const r of rs) if (r.status === 'rejected') assert.equal(r.reason.code, 'state');
    assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'executed');
  });
  test('recovers a partial write: the payments row exists but the decision / run were not advanced', async () => {
    const { world, d } = await setup(); tx(world);
    await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl });
    await world.db.run("UPDATE decisions SET status='approved' WHERE id=?", [d.id]); await world.db.run("UPDATE mandate_runs SET status='claimed' WHERE decision_id=?", [d.id]);
    const r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl }); assert.equal(r.idempotent, true);
    assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'executed'); assert.equal((await world.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'confirmed');
  });
  test('refusals before any RPC: unknown / non-payment decision, not approved, not claimed under a mandate, bad tx hash, kill switch', async () => {
    const world = await makeWorld(); const never = async () => { throw new Error('no RPC expected'); };
    await assert.rejects(recordPayment(world.db, 'dec_nope', { txHash: TX, fetchImpl: never }), (e) => e.code === 'not_found');
    await assert.rejects(recordPayment(world.db, world.grant.id, { txHash: TX, fetchImpl: never }), /not a payment/);
    const pending = (await world.pay({ token: USDC, payee: ALICE, amount: '5' })).json;
    await assert.rejects(recordPayment(world.db, pending.id, { txHash: TX, fetchImpl: never }), /not approved/);
    await world.api(`/api/decisions/${pending.id}/approve`, { method: 'POST', body: { nonce: pending.nonce, payloadHash: pending.payload_hash, confirm: `approve ${pending.id}`, signer: OWNER } });
    await assert.rejects(recordPayment(world.db, pending.id, { txHash: TX, fetchImpl: never }), /under the mandate/);
    const d = await approvedPayment(world, { token: USDC, payee: BOB, amount: '6' });
    for (const h of ['', 'abc', undefined, 5, 'l'.repeat(44)]) await assert.rejects(recordPayment(world.db, d.id, { txHash: h, fetchImpl: never }), (e) => e.code === 'input');
    await world.api('/api/security/pause', { method: 'POST' });
    await assert.rejects(recordPayment(world.db, d.id, { txHash: TX, fetchImpl: never }), (e) => e.code === 'paused');
  });
  test('an unknown transaction or an unreachable node is a failed verification (recorded:false), never an exception and never a row', async () => {
    const { world, d } = await setup();
    let r = await recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl }); assert.equal(r.recorded, false);
    world.w.down = true; r = await recordPayment(world.db, d.id, { txHash: TX2, fetchImpl: world.fetchImpl }); assert.equal(r.recorded, false);
    assert.equal((await world.db.get('SELECT COUNT(*) n FROM payments')).n, 0);
  });
  test('a payment record needs the mandate run of THIS vault (a decision whose vault differs from the run is refused)', async () => {
    const { world, d } = await setup(); tx(world);
    await world.db.run("UPDATE decisions SET bound_signer='other.testnet' WHERE id=?", [d.id]);
    await assert.rejects(recordPayment(world.db, d.id, { txHash: TX, fetchImpl: world.fetchImpl }), /no mandate run \/ vault matches/);
  });
});

void readVault; void CAROL; void NEAR; void AGENT;
