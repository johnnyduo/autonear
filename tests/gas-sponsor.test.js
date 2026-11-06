// Gas sponsor (loop rule m). Gate-by-gate tests call sponsorGas directly; the loop tests run the REAL autonomyTick against the fake NEAR testnet of tests/pay-helpers.js.
// The sender is injected (no key, no network). Real-chain behaviour of the transfer itself is a plain NEAR Transfer through src/agent/near-admin.js (covered by the testnet e2e).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sponsorConfig, sponsorGas, clearSponsorClaim, nearToYocto, SPONSOR_HARD, SPONSOR_DEFAULTS } from '../src/gas-sponsor.js';
import { autonomyTick } from '../src/autonomy.js';
import { memDb } from './helpers.js';
import { appendLedger } from '../src/vault/index.js';
import { normalizeLimits, enforceCall } from '../src/agent/limits.js';
import { createHash } from 'node:crypto';
import { base58 } from '../src/chains/common.js';
import { setPaused } from '../src/orchestrator/coordinator.js';
import { makeWorld, payTx, approvedPayment, skipNoBuilds, NEAR, M, VAULT, AGENT, USDC, ALICE } from './pay-helpers.js';

const DAY_MS = 86_400_000;
const SK = `ed25519:${'3'.repeat(88)}`;
const SPONSOR = 'gas-pool.testnet';
const ENV = { GAS_SPONSOR_ENABLED: '1', GAS_SPONSOR_ACCOUNT: SPONSOR, GAS_SPONSOR_SECRET_KEY: SK, GAS_SPONSOR_AGENTS: AGENT };
const NET = { id: 'near-testnet', protocol: 'near', mainnet: false, rpc: 'http://x', networkId: 'testnet' };
const vault = { id: 'vlt_test' };

/** A scripted sender: records transfers, never touches a network. */
function sender({ balance = 5n * NEAR, behaviour = [] } = {}) {
  const calls = []; let n = 0;
  return { calls, txVerdict: 'unknown', balance: async () => balance, txStatus: async function () { return this.txVerdict; }, transfer: async (to, amount) => { calls.push({ to, amount }); const b = behaviour.shift() ?? 'ok'; if (b === 'throw') throw new Error('socket hang up'); if (b === 'pending') return { ok: false, status: 'pending', txHash: `H${n++}` }; if (b === 'failed') return { ok: false, status: 'failed', txHash: `H${n++}`, failure: { x: 1 } }; return { ok: true, status: 'success', txHash: `H${n++}` }; } };
}
const stateOf = async (db) => JSON.parse((await db.get('SELECT v FROM kv WHERE k=?', ['gassponsor:state']))?.v ?? 'null');
const ageState = async (db, ms) => { const st = await stateOf(db); st.spend = st.spend.map((r) => ({ ...r, t: r.t - ms })); await db.run('UPDATE kv SET v=? WHERE k=?', [JSON.stringify(st), 'gassponsor:state']); };
const ctxOf = (db, deps = {}, env = ENV) => ({ db, deps, env, redact: (m) => String(m?.message ?? m).slice(0, 300) });
const rows = (db) => db.all("SELECT kind,status,detail,amount,tx_hash FROM vault_ledger WHERE detail LIKE 'gas sponsor:%' ORDER BY id");
const ask = (ctx, o = {}) => sponsorGas(ctx, { vault, net: NET, agent: AGENT, balance: NEAR / 100n, ...o });

describe('sponsorConfig: off by default, strict, hard ceilings', () => {
  test('off unless GAS_SPONSOR_ENABLED=1; enabled but incomplete is reported as misconfigured, never half-on', () => {
    assert.deepEqual(sponsorConfig({}), { enabled: false });
    assert.deepEqual(sponsorConfig({ GAS_SPONSOR_ENABLED: '0' }), { enabled: false });
    for (const [over, why] of [[{ GAS_SPONSOR_AGENTS: '' }, /allowlist/], [{ GAS_SPONSOR_AGENTS: 'NOT AN ACCOUNT!' }, /not a NEAR account/], [{ GAS_SPONSOR_SECRET_KEY: 'nope' }, /secret key/], [{ GAS_SPONSOR_ACCOUNT: '' , GAS_SPONSOR_KEY_FILE: '/nonexistent/x.json' }, /sponsor account/], [{ GAS_SPONSOR_AGENTS: SPONSOR }, /cannot also be/], [{ GAS_SPONSOR_AGENTS: 'a1.testnet,a2.testnet,a3.testnet,a4.testnet,a5.testnet' }, /at most/]]) {
      const c = sponsorConfig({ ...ENV, ...over, GAS_SPONSOR_KEY_FILE: over.GAS_SPONSOR_KEY_FILE ?? '/nonexistent/x.json' });
      assert.equal(c.enabled, false); assert.match(c.misconfigured, why);
    }
  });
  test('defaults, and no environment value can exceed the compiled-in ceilings; invalid values fall back to the default', () => {
    const d = sponsorConfig(ENV); assert.equal(d.enabled, true);
    assert.equal(d.amount, SPONSOR_DEFAULTS.amount); assert.equal(d.low, SPONSOR_DEFAULTS.low); assert.equal(d.minIntervalMs, 30 * 60_000); assert.deepEqual(d.agents, [AGENT]);
    const big = sponsorConfig({ ...ENV, GAS_SPONSOR_AMOUNT_NEAR: '9999', GAS_SPONSOR_PER_AGENT_DAY_NEAR: '9999', GAS_SPONSOR_GLOBAL_DAY_NEAR: '9999', GAS_SPONSOR_LIFETIME_NEAR: '9999', GAS_SPONSOR_MIN_INTERVAL_MIN: '1' });
    assert.equal(big.amount, SPONSOR_HARD.amount); assert.equal(big.perAgentDay, SPONSOR_HARD.perAgentDay); assert.equal(big.globalDay, SPONSOR_HARD.globalDay); assert.equal(big.lifetime, SPONSOR_HARD.lifetime);
    assert.equal(big.minIntervalMs, 30 * 60_000, 'an interval under the 5-minute floor falls back to the default');
    const junk = sponsorConfig({ ...ENV, GAS_SPONSOR_AMOUNT_NEAR: '-1', GAS_SPONSOR_LOW_NEAR: 'x', GAS_SPONSOR_PER_AGENT_DAY_NEAR: '0' });
    assert.equal(junk.amount, SPONSOR_DEFAULTS.amount); assert.equal(junk.low, SPONSOR_DEFAULTS.low); assert.equal(junk.perAgentDay, SPONSOR_DEFAULTS.perAgentDay);
    assert.equal(nearToYocto('0.1'), NEAR / 10n); assert.equal(nearToYocto('1e3'), null); assert.equal(nearToYocto('0.'), null);
  });
  test('the key may come from the ignored key file instead of the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-')); writeFileSync(join(dir, 'k.json'), JSON.stringify({ accountId: SPONSOR, near: { secretKey: SK } }));
    const c = sponsorConfig({ GAS_SPONSOR_ENABLED: '1', GAS_SPONSOR_AGENTS: AGENT, GAS_SPONSOR_KEY_FILE: join(dir, 'k.json') });
    assert.equal(c.enabled, true); assert.equal(c.accountId, SPONSOR);
    writeFileSync(join(dir, 'bad.json'), '{not json'); assert.match(sponsorConfig({ GAS_SPONSOR_ENABLED: '1', GAS_SPONSOR_AGENTS: AGENT, GAS_SPONSOR_KEY_FILE: join(dir, 'bad.json') }).misconfigured, /not valid JSON/);
  });
});

describe('sponsorGas: every gate refuses and ledgers, nothing is sent', () => {
  test('disabled (default): returns null, sends nothing, writes nothing', async () => {
    const db = await memDb(); const s = sender();
    assert.equal(await ask(ctxOf(db, { gasSponsor: s }, {})), null); assert.equal(s.calls.length, 0); assert.equal((await rows(db)).length, 0);
  });
  test('enabled but misconfigured: ledgered once as a refusal, nothing sent', async () => {
    const db = await memDb(); const s = sender(); const ctx = ctxOf(db, { gasSponsor: s }, { GAS_SPONSOR_ENABLED: '1' });
    await ask(ctx); await ask(ctx);
    assert.equal(s.calls.length, 0); const r = await rows(db); assert.equal(r.length, 1); assert.match(r[0].detail, /not usable: GAS_SPONSOR_AGENTS is empty/);
  });
  test('mainnet or any network other than near-testnet is refused', async () => {
    const db = await memDb(); const s = sender(); const ctx = ctxOf(db, { gasSponsor: s });
    for (const net of [{ ...NET, mainnet: true }, { ...NET, id: 'near-mainnet' }, { ...NET, protocol: 'evm' }]) assert.equal(await ask(ctx, { net }), null);
    assert.equal(s.calls.length, 0); assert.match((await rows(db))[0].detail, /only NEAR testnet/);
  });
  test('an agent that is not on the allowlist gets nothing (case-insensitive match for the one that is)', async () => {
    const db = await memDb(); const s = sender();
    assert.equal(await ask(ctxOf(db, { gasSponsor: s }), { agent: 'ff'.repeat(32) }), null); assert.equal(s.calls.length, 0); assert.match((await rows(db))[0].detail, /not on the sponsor allowlist/);
    const ok = await ask(ctxOf(db, { gasSponsor: s }, { ...ENV, GAS_SPONSOR_AGENTS: AGENT.toUpperCase() })); assert.ok(ok.sponsored);
  });
  test('enough gas already: nothing sent, nothing reserved', async () => {
    const db = await memDb(); const s = sender();
    assert.equal(await ask(ctxOf(db, { gasSponsor: s }), { balance: NEAR / 10n }), null); assert.equal(s.calls.length, 0); assert.equal(await stateOf(db), null);
  });
  test('a successful grant: exactly the configured amount to the agent, ledgered with the amount and tx hash', async () => {
    const db = await memDb(); const s = sender(); const r = await ask(ctxOf(db, { gasSponsor: s }));
    assert.deepEqual(r, { sponsored: String(NEAR / 10n) }); assert.deepEqual(s.calls, [{ to: AGENT, amount: NEAR / 10n }]);
    const l = (await rows(db)).at(-1); assert.equal(l.kind, 'loop'); assert.equal(l.status, 'confirmed'); assert.equal(l.amount, String(NEAR / 10n)); assert.equal(l.tx_hash, 'H0'); assert.match(l.detail, /sent 0\.1000 NEAR to ab/);
    const st = await stateOf(db); assert.equal(st.claim, null, 'a known outcome leaves no claim behind'); assert.equal(st.spend[0].state, 'sent'); assert.equal(st.lifetime[AGENT], String(NEAR / 10n));
  });
  test('minimum interval between two transfers', async () => {
    const db = await memDb(); const s = sender(); const ctx = ctxOf(db, { gasSponsor: s });
    assert.ok((await ask(ctx)).sponsored); assert.equal(await ask(ctx), null); assert.equal(s.calls.length, 1); assert.match((await rows(db)).at(-1).detail, /under 30 minutes ago/);
  });
  test('per-agent 24h cap, global 24h cap and per-agent lifetime cap', async () => {
    for (const [over, re, sent] of [[{ GAS_SPONSOR_PER_AGENT_DAY_NEAR: '0.25' }, /per-agent 24h cap/, 2], [{ GAS_SPONSOR_GLOBAL_DAY_NEAR: '0.25' }, /global 24h cap/, 2], [{ GAS_SPONSOR_LIFETIME_NEAR: '0.25' }, /lifetime cap/, 2]]) {
      const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig({ ...ENV, ...over }), minIntervalMs: 0 };
      const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
      assert.ok((await ask(ctx)).sponsored); assert.ok((await ask(ctx)).sponsored); assert.equal(await ask(ctx), null);
      assert.equal(s.calls.length, sent); assert.match((await rows(db)).at(-1).detail, re);
    }
  });
  test('transfers older than 24h leave the daily caps but still count against the lifetime cap', async () => {
    const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig({ ...ENV, GAS_SPONSOR_PER_AGENT_DAY_NEAR: '0.1', GAS_SPONSOR_LIFETIME_NEAR: '0.25' }), minIntervalMs: 0 };
    const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    assert.ok((await ask(ctx)).sponsored); await ageState(db, 25 * 3600_000);
    assert.ok((await ask(ctx)).sponsored, 'the first one has aged out of the 24h window');
    await ageState(db, 25 * 3600_000);
    assert.equal(await ask(ctx), null); assert.match((await rows(db)).at(-1).detail, /lifetime cap/);
  });
  test('the pool keeps its reserve: an almost-empty sponsor account sends nothing', async () => {
    const db = await memDb(); const s = sender({ balance: NEAR / 2n + NEAR / 10n - 1n });
    assert.equal(await ask(ctxOf(db, { gasSponsor: s })), null); assert.equal(s.calls.length, 0); assert.match((await rows(db))[0].detail, /needs a top-up/);
  });
  test('a transfer that fails definitively moves nothing and gives its reservation back', async () => {
    const db = await memDb(); const s = sender({ behaviour: ['failed'] }); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    assert.equal(await ask(ctx), null); assert.equal((await rows(db)).at(-1).status, 'failed');
    const st = await stateOf(db); assert.equal(st.claim, null); assert.deepEqual(st.spend, []); assert.equal(st.lifetime[AGENT], '0');
    assert.ok((await ask(ctx)).sponsored, 'a failed transfer is not counted: it never confirmed');
  });
  test('the reservation exists BEFORE the money moves (a crash mid-send can never leave an uncounted transfer)', async () => {
    const db = await memDb(); const s = sender(); const seen = []; const orig = s.transfer;
    s.transfer = async (to, amount) => { const st = await stateOf(db); seen.push({ claim: st.claim?.status, spend: st.spend.map((r) => r.state), lifetime: st.lifetime[AGENT] }); return orig(to, amount); };
    await ask(ctxOf(db, { gasSponsor: s })); assert.deepEqual(seen, [{ claim: 'submitted', spend: ['reserved'], lifetime: String(NEAR / 10n) }]);
  });
  test('an unknown outcome (throw or no receipt) holds EVERYTHING: nothing is sent twice, and a balance that rises for another reason releases nothing', async () => {
    for (const b of ['throw', 'pending']) {
      const db = await memDb(); const s = sender({ behaviour: [b] }); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
      const first = await ask(ctx); assert.ok(first.held || first.pending);
      assert.equal((await ask(ctx)).held, true); assert.equal((await ask(ctx)).held, true); assert.equal(s.calls.length, 1, `${b}: no second transfer`);
      assert.equal(await ask(ctx, { balance: NEAR / 5n }), null, 'a rich agent needs nothing');
      assert.equal((await ask(ctx)).held, true, 'and the claim is still there when it is poor again: an unrelated deposit released nothing');
      assert.match((await rows(db)).at(-1).detail, /no known outcome|unknown outcome/);
      assert.equal((await stateOf(db)).spend.length, 1, 'the unknown transfer still counts against the caps');
    }
  });
  test('a held transfer with a tx hash is settled from the chain: success counts as sent, failure gives the reservation back', async () => {
    for (const [verdict, re, lifetime] of [['success', /settled later/, String(NEAR / 5n)], ['failed', /failed on chain/, String(NEAR / 10n)]]) {
      const db = await memDb(); const s = sender({ behaviour: ['pending'] }); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
      assert.equal((await ask(ctx)).pending, true); s.txVerdict = verdict;
      assert.ok((await ask(ctx)).sponsored, 'once settled, the next need is served'); assert.equal(s.calls.length, 2);
      assert.ok((await rows(db)).some((r) => re.test(r.detail)), verdict);
      const st = await stateOf(db); assert.equal(st.claim, null); assert.equal(st.lifetime[AGENT], lifetime, verdict);
    }
  });
  test('an operator can clear a stuck claim; the reservation keeps counting', async () => {
    const db = await memDb(); const s = sender({ behaviour: ['throw'] }); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    await ask(ctx); assert.equal((await ask(ctx)).held, true);
    assert.equal(await clearSponsorClaim(db, 'test'), true); assert.equal(await clearSponsorClaim(db, 'test'), false);
    assert.ok((await ask(ctx)).sponsored); assert.equal((await stateOf(db)).spend.length, 2, 'the unknown one is still counted');
    assert.equal((await stateOf(db)).lifetime[AGENT], String(NEAR / 5n));
  });
  test('a claim that died before sending anything (stale, still only "claimed") gives its reservation back; a fresh one blocks', async () => {
    const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    const seed = (at) => db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', ['gassponsor:state', JSON.stringify({ v: 1, claim: { id: 'x', agent: AGENT, status: 'claimed', at, amount: String(NEAR / 10n) }, spend: [{ id: 'x', t: at, agent: AGENT, amount: String(NEAR / 10n), state: 'reserved' }], lifetime: { [AGENT]: String(NEAR / 10n) } })]);
    await seed(Date.now()); assert.equal(await ask(ctx), null); assert.equal(s.calls.length, 0, 'someone is deciding right now');
    await seed(Date.now() - 20 * 60_000); assert.ok((await ask(ctx)).sponsored); assert.equal(s.calls.length, 1);
    const st = await stateOf(db); assert.equal(st.spend.length, 1); assert.equal(st.lifetime[AGENT], String(NEAR / 10n), 'the dead reservation was returned, the new one counted');
  });
  test('a process that stalled after reserving and lost its claim to a takeover does NOT send', async () => {
    const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; let done = false;
    const wrapped = { get: db.get.bind(db), all: db.all.bind(db), run: async (sql, p) => { // at the moment this process tries to mark itself submitted, another process has already taken the claim over
      if (!done && /UPDATE kv SET v=\? WHERE k=\? AND v=\?/.test(sql) && String(p[0]).includes('"submitted"')) { done = true; await db.run('UPDATE kv SET v=? WHERE k=?', [JSON.stringify({ v: 1, claim: null, spend: [], lifetime: {} }), 'gassponsor:state']); }
      return db.run(sql, p); } };
    assert.equal(await ask(ctxOf(wrapped, { gasSponsor: s, gasSponsorConfig: cfg })), null); assert.equal(s.calls.length, 0);
  });
  test('an unresolved transfer never ages out of the daily cap, and clearing it keeps it counted for 24h more', async () => {
    const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig({ ...ENV, GAS_SPONSOR_GLOBAL_DAY_NEAR: '0.1' }), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    const old = Date.now() - 3 * DAY_MS;
    await db.run('INSERT INTO kv(k,v) VALUES(?,?)', ['gassponsor:state', JSON.stringify({ v: 1, claim: { id: 'x', agent: AGENT, status: 'submitted', at: old, amount: String(NEAR / 10n) }, spend: [{ id: 'x', t: old, agent: AGENT, amount: String(NEAR / 10n), state: 'reserved' }], lifetime: { [AGENT]: String(NEAR / 10n) } })]);
    assert.equal((await ask(ctx)).held, true); assert.equal((await stateOf(db)).spend.length, 1, 'three days later it is still reserved');
    assert.equal(await clearSponsorClaim(db, 'op'), true); const st = await stateOf(db); assert.equal(st.spend[0].state, 'unknown'); assert.ok(st.spend[0].t > Date.now() - 5000);
    assert.equal(await ask(ctx), null); assert.equal(s.calls.length, 0); assert.match((await rows(db)).at(-1).detail, /global 24h cap/);
    await ageState(db, 2 * DAY_MS); assert.ok((await ask(ctx)).sponsored, 'after 24h the cleared one finally leaves the window');
  });
  test('sponsorGas never throws, even when reading the configuration blows up', async () => {
    const db = await memDb(); const boom = new Proxy({}, { get() { throw new Error(`env exploded ${SK}`); } });
    assert.equal(await sponsorGas({ db, deps: {}, env: boom, redact: (m) => String(m?.message ?? m) }, { vault, net: NET, agent: AGENT, balance: 0n }), null);
    assert.equal(JSON.stringify(await db.all('SELECT detail FROM vault_ledger')).includes(SK), false);
  });
  test('an unreadable state row is an unknown outcome: nothing is sent', async () => {
    const db = await memDb(); const s = sender(); await db.run('INSERT INTO kv(k,v) VALUES(?,?)', ['gassponsor:state', '{broken']);
    assert.equal((await ask(ctxOf(db, { gasSponsor: s }))).held, true); assert.equal(s.calls.length, 0);
  });
  test('two different allowlisted agents asking at the same moment cannot exceed the global cap', async () => {
    const db = await memDb(); const s = sender(); const A2 = 'cd'.repeat(32);
    const cfg = { ...sponsorConfig({ ...ENV, GAS_SPONSOR_AGENTS: `${AGENT},${A2}`, GAS_SPONSOR_GLOBAL_DAY_NEAR: '0.15' }), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    await Promise.all([ask(ctx), ask(ctx, { agent: A2 })]); assert.equal(s.calls.length, 1);
    assert.equal(await ask(ctx, { agent: A2 }), null); assert.equal(s.calls.length, 1, 'and once spent, the cap holds for both');
  });
  test('the sponsor secret never reaches the ledger, even when an error carries it', async () => {
    const db = await memDb(); const s = sender(); s.transfer = async () => { throw new Error(`rpc rejected the key ${SK} at /tmp/${SK.slice(8)}`); };
    await ask(ctxOf(db, { gasSponsor: s })); const all = JSON.stringify(await db.all('SELECT detail FROM vault_ledger'));
    assert.ok(all.includes('[redacted]')); assert.equal(all.includes(SK), false); assert.equal(all.includes(SK.slice(8)), false);
    const s2 = sender(); s2.balance = async () => { throw new Error(`boom ${SK}`); }; const db2 = await memDb();
    assert.equal(await ask(ctxOf(db2, { gasSponsor: s2 })), null); const all2 = JSON.stringify(await db2.all('SELECT detail FROM vault_ledger')); assert.equal(all2.includes(SK), false);
  });
  test('the kill switch is re-checked right before the money moves', async () => {
    const db = await memDb(); const s = sender();
    assert.equal(await ask(ctxOf(db, { gasSponsor: s }), { killed: () => true }), null); assert.equal(s.calls.length, 0); assert.equal(await stateOf(db), null, 'and nothing was reserved');
  });
  test('two concurrent asks send once (the durable claim)', async () => {
    const db = await memDb(); const s = sender(); const cfg = { ...sponsorConfig(ENV), minIntervalMs: 0 }; const ctx = ctxOf(db, { gasSponsor: s, gasSponsorConfig: cfg });
    const r = await Promise.all([ask(ctx), ask(ctx)]); assert.equal(s.calls.length, 1, JSON.stringify(r));
  });
  test('the ledger stays a valid hash chain after sponsor entries', async () => {
    const db = await memDb(); const s = sender(); await ask(ctxOf(db, { gasSponsor: s })); await appendLedger(db, vault.id, { kind: 'loop', status: 'confirmed', detail: 'next' });
    const { verifyLedgerChain } = await import('../src/vault/index.js'); assert.equal((await verifyLedgerChain(db)).ok, true);
  });
});

/** The loop: a payment the owner approved, an agent that holds almost no gas. The agent key is scripted but passes through the production limits check. */
function loopAgent(world, order) {
  const { w } = world; let n = 0;
  const keystore = {
    publicView: () => ({ evm: null, near: { account: AGENT, publicKey: 'ed25519:test' } }), redactText: (x) => String(x),
    signer: () => ({ async signAndSend(call, limits) {
      enforceCall('near', call, normalizeLimits('near', limits)); order.push(`agent:${call.method}`);
      if (call.method === 'draw') throw new Error('this test expects the sponsor, not a vault draw, to provide gas');
      const hash = base58(new Uint8Array(createHash('sha256').update(`gs-tx-${n++}`).digest())); const { token, to, amount, memo } = call.args;
      w.balances[VAULT] = String(BigInt(w.balances[VAULT]) - BigInt(amount)); w.balances[to] = String(BigInt(w.balances[to] ?? 0) + BigInt(amount));
      const u = w.usage[token] ?? { total_spent: '0', period_index: '0', period_spent: '0' };
      w.usage[token] = { total_spent: String(BigInt(u.total_spent) + BigInt(amount)), period_index: u.period_index, period_spent: String(BigInt(u.period_spent) + BigInt(amount)) };
      w.txs[hash] = payTx({ to, token, amount, memo: memo ?? '', hash }); return { ok: true, status: 'success', txHash: hash };
    } }) };
  return { keystore, tick: (env = {}, deps = {}) => autonomyTick(world.db, { keystore, signingSupported: true, fetchImpl: world.fetchImpl, catchUpAttempts: 1, catchUpMs: 1, env: { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5', ...env }, ...deps }) };
}
const lowGas = (world) => { world.w.accounts[AGENT].amount = String(NEAR / 100n); }; // 0.01 NEAR, under the 0.05 low-water mark

describe('rule (m) in the real loop', { skip: skipNoBuilds }, () => {
  test('OFF by default: a gas-starved agent is not sponsored (the loop behaves exactly as before)', async () => {
    const world = await makeWorld(); lowGas(world); const order = []; const s = sender(); const a = loopAgent(world, order);
    await approvedPayment(world, undefined, { claim: false });
    await a.tick({}, { gasSponsor: s });
    assert.equal(s.calls.length, 0); assert.equal((await rows(world.db)).length, 0);
  });
  test('ON + allowlisted: the sponsor tops the agent up BEFORE the agent signs, then the payment goes through', async () => {
    const world = await makeWorld(); lowGas(world); const order = []; const s = sender();
    const origTransfer = s.transfer; s.transfer = async (to, amount) => { order.push('sponsor:transfer'); world.w.accounts[to].amount = String(BigInt(world.w.accounts[to].amount) + amount); return origTransfer(to, amount); };
    const a = loopAgent(world, order); const d = await approvedPayment(world, undefined, { claim: false });
    const r = await a.tick(ENV, { gasSponsor: s });
    assert.deepEqual(order, ['sponsor:transfer', 'agent:pay'], JSON.stringify(r.vaults?.[0]));
    assert.equal((await world.db.get('SELECT status FROM decisions WHERE id=?', [d.id])).status, 'executed'); assert.equal(world.w.balances[ALICE], String(25n * M));
    const l = (await rows(world.db)).filter((x) => x.status === 'confirmed'); assert.equal(l.length, 1); assert.equal(l[0].amount, String(NEAR / 10n));
  });
  test('ON but the agent is not on the allowlist: nothing is sent; the payment is refused for lack of gas as before', async () => {
    const world = await makeWorld(); lowGas(world); const order = []; const s = sender(); const a = loopAgent(world, order);
    await approvedPayment(world, undefined, { claim: false });
    await a.tick({ ...ENV, GAS_SPONSOR_AGENTS: 'someone-else.testnet' }, { gasSponsor: s });
    assert.equal(s.calls.length, 0); assert.match((await rows(world.db))[0].detail, /not on the sponsor allowlist/);
  });
  test('ON but no work is pending: even a starved agent gets nothing (the sponsor is not a faucet), in Manual and in Auto', async () => {
    const world = await makeWorld(); lowGas(world); const order = []; const s = sender(); const a = loopAgent(world, order);
    await a.tick(ENV, { gasSponsor: s });
    const { setMode } = await import('../src/autonomy-mode.js'); await setMode(world.db, 'auto'); await a.tick(ENV, { gasSponsor: s });
    assert.equal(s.calls.length, 0); assert.equal((await rows(world.db)).filter((x) => x.status === 'confirmed').length, 0);
  });
  test('kill switch engaged or loop paused: nothing is sent', async () => {
    const world = await makeWorld(); lowGas(world); const order = []; const s = sender(); const a = loopAgent(world, order);
    await approvedPayment(world, undefined, { claim: false });
    await setPaused(world.db, true, 'test'); assert.match((await a.tick(ENV, { gasSponsor: s })).skipped, /kill switch/);
    await setPaused(world.db, false, 'test');
    await world.db.run("INSERT INTO kv(k,v) VALUES('vault:loop',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [JSON.stringify({ state: 'paused', reason: 'x' })]);
    assert.match((await a.tick(ENV, { gasSponsor: s })).skipped, /loop paused/);
    assert.equal(s.calls.length, 0); assert.equal(order.length, 0);
  });
});
