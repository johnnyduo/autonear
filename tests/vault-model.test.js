import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultModel, VaultError, ERROR_CODES, runScenario, describeBudget, budgetToJSON, toBig } from '../src/vault-model.js';

const conformance = JSON.parse(readFileSync(new URL('../contracts/vault-conformance.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- conformance, both chains
test('conformance file: error list equals the model error list', () => {
  assert.deepEqual([...conformance.errors].sort(), [...ERROR_CODES].sort());
  assert.equal(conformance.version, 1);
});

for (const chain of ['evm', 'near']) {
  for (const sc of conformance.scenarios) {
    test(`conformance [${chain}] ${sc.name}`, (t) => {
      const r = runScenario(sc, chain);
      if (r.skipped) { t.skip(`scenario is only for ${sc.only}`); return; }
      assert.ok(r.steps > 0);
      assert.deepEqual(r.failures, [], `${sc.name} on ${chain}: ${JSON.stringify(r.failures)}`);
    });
  }
}

test('conformance: every error code in the file is exercised by at least one expectation on some chain', () => {
  const seen = new Set();
  for (const sc of conformance.scenarios) for (const s of sc.steps) if (s.expect?.err) seen.add(s.expect.err);
  const missing = ERROR_CODES.filter((c) => !seen.has(c));
  // Documented gap, not a failure of the model: BadTemplate is only exercised via the EVM-only scenario. Everything else must be hit.
  assert.deepEqual(missing, []);
});

test('runScenario reports (does not throw on) a wrong expectation', () => {
  const r = runScenario({ name: 'x', setup: { balance: 10 }, steps: [{ t: 1, as: 'agent', op: 'draw', args: { amount: 1 }, expect: 'ok', state: { available: 99 } }] }, 'evm');
  assert.equal(r.failures.length, 2);
  assert.equal(r.failures[0].field, 'expect');
  assert.deepEqual(r.failures[0].got, { err: 'NoMandate' });
  assert.equal(r.failures[1].field, 'state.available');
});

test('runScenario honours the agent_received key from the spec text as well as `received`', () => {
  const r = runScenario({ name: 'x', setup: { balance: 100 }, steps: [
    { t: 1, as: 'owner', op: 'set_mandate', args: { agent: 'agent', expires_at: 100, per_draw_cap: 50, period_secs: 60, period_cap: 50, total_cap: 50, max_deploys: 0 }, expect: 'ok' },
    { t: 2, as: 'agent', op: 'draw', args: { amount: 7 }, expect: 'ok', state: { agent_received: 7 } },
  ] }, 'near');
  assert.deepEqual(r.failures, []);
});

// ---------------------------------------------------------------- targeted unit tests
const MANDATE = { agent: 'agent', expires_at: 10_000, per_draw_cap: 100, period_secs: 600, period_cap: 250, total_cap: 400, max_deploys: 3 };
const mk = (chain = 'evm', balance = 1000n) => { const m = new VaultModel({ chain, owner: 'owner', balance }); m.exec('set_mandate', 'owner', MANDATE, 1000); return m; };
const code = (fn) => { try { fn(); } catch (e) { return e.code ?? `NON_VAULT:${e}`; } return 'ok'; };

test('BigInt, number and decimal-string amounts are accepted; junk is BadAmount, never a TypeError', () => {
  const m = mk();
  m.exec('draw', 'agent', { amount: 5 }, 1001); m.exec('draw', 'agent', { amount: 5n }, 1001); m.exec('draw', 'agent', { amount: '5' }, 1001);
  assert.equal(m.usage.totalSpent, 15n);
  for (const bad of [1.5, -1, '1e3', 'abc', null, undefined, NaN, {}, [], '01']) assert.equal(code(() => m.exec('draw', 'agent', { amount: bad }, 1002)), 'BadAmount', String(bad));
  assert.equal(toBig(2 ** 60), null); // unsafe integers must be passed as BigInt/string
  assert.equal(toBig(2n ** 100n), 2n ** 100n);
});

test('a rejected op never mutates state', () => {
  const m = mk('near');
  m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  const before = JSON.stringify(m.snapshot(1002), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) + m.events.length;
  for (const [op, who, args] of [['draw', 'agent', { amount: 101 }], ['draw', 'other', { amount: 1 }], ['deploy', 'agent', { template: 't1', name: 'A!' }], ['deploy', 'agent', { template: 'nope', name: 'a' }], ['withdraw', 'owner', { amount: 10_000 }], ['set_mandate', 'owner', { ...MANDATE, agent: '' }]]) {
    assert.ok(code(() => m.exec(op, who, args, 1002)) !== 'ok', op);
  }
  assert.equal(JSON.stringify(m.snapshot(1002), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) + m.events.length, before);
});

test('check order: NoMandate > Unauthorized > Paused > MandateInactive > op rules', () => {
  const m = new VaultModel({ chain: 'evm', owner: 'owner', balance: 100n });
  assert.equal(code(() => m.exec('draw', 'other', { amount: 0 }, 1)), 'NoMandate');
  m.exec('set_mandate', 'owner', { ...MANDATE, expires_at: 100 }, 1);
  m.exec('pause', 'owner', {}, 1); m.exec('revoke', 'owner', {}, 1);
  assert.equal(code(() => m.exec('draw', 'other', { amount: 0 }, 500)), 'Unauthorized');
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 0 }, 500)), 'Paused');
  m.exec('unpause', 'owner', {}, 2);
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 0 }, 50)), 'MandateInactive');
});

test('draw rule order: BadAmount > PerDrawCap > PeriodCap > TotalCap > InsufficientBalance', () => {
  const m = new VaultModel({ chain: 'evm', owner: 'owner', balance: 10n });
  m.exec('set_mandate', 'owner', { ...MANDATE, per_draw_cap: 100, period_cap: 100, total_cap: 100 }, 1000);
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 0 }, 1001)), 'BadAmount');
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 101 }, 1001)), 'PerDrawCap');
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 50 }, 1001)), 'InsufficientBalance');
  m.exec('deposit', 'other', { amount: 1000 }, 1001);
  m.exec('draw', 'agent', { amount: 100 }, 1002);
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 1 }, 1003)), 'PeriodCap');   // period 100/100 and total 100/100: period wins
  assert.equal(code(() => m.exec('draw', 'agent', { amount: 1 }, 1600)), 'TotalCap');   // new period, total exhausted
});

test('deploy rule order: TemplateNotAllowed > CodeMismatch > DeployLimit > PeriodCap > TotalCap > InsufficientBalance > AddressTaken > BadName', () => {
  const m = new VaultModel({ chain: 'near', owner: 'owner', balance: 100n });
  m.exec('set_mandate', 'owner', { ...MANDATE, period_cap: 250, total_cap: 400, max_deploys: 1 }, 1000);
  m.exec('allow_template', 'owner', { template: 't1', label: 'a', deposit: 60 }, 1000);
  m.exec('allow_template', 'owner', { template: 'big', label: 'b', deposit: 300 }, 1000);
  assert.equal(code(() => m.exec('deploy', 'agent', { template: 'zz', name: 'A!', code: 'q' }, 1001)), 'TemplateNotAllowed');
  assert.equal(code(() => m.exec('deploy', 'agent', { template: 't1', name: 'A!', code: 'q' }, 1001)), 'CodeMismatch');
  assert.equal(code(() => m.exec('deploy', 'agent', { template: 'big', name: 'A!' }, 1001)), 'PeriodCap');   // 300 > period_cap 250 before BadName
  assert.equal(code(() => m.exec('deploy', 'agent', { template: 't1', name: 'A!' }, 1001)), 'BadName');
  m.exec('deploy', 'agent', { template: 't1', name: 'ok' }, 1001);
  assert.equal(code(() => m.exec('deploy', 'agent', { template: 't1', name: 'A!' }, 1002)), 'DeployLimit');
});

test('EVM address tracking is per (template, salt); NEAR is per name', () => {
  const e = mk('evm'); e.exec('allow_template', 'owner', { template: 't1', label: 'a', deposit: 0 }, 1001); e.exec('allow_template', 'owner', { template: 't2', label: 'b', deposit: 0 }, 1001);
  e.exec('deploy', 'agent', { template: 't1', salt: 's' }, 1002);
  assert.equal(code(() => e.exec('deploy', 'agent', { template: 't1', salt: 's' }, 1003)), 'AddressTaken');
  assert.equal(code(() => e.exec('deploy', 'agent', { template: 't2', salt: 's' }, 1003)), 'ok'); // different initcode -> different CREATE2 address
  const n = mk('near'); n.exec('allow_template', 'owner', { template: 't1', label: 'a', deposit: 0 }, 1001); n.exec('allow_template', 'owner', { template: 't2', label: 'b', deposit: 0 }, 1001);
  n.exec('deploy', 'agent', { template: 't1', name: 's' }, 1002);
  assert.equal(code(() => n.exec('deploy', 'agent', { template: 't2', name: 's' }, 1003)), 'AddressTaken');
});

test('template validation: label bytes, EVM deposit, NEAR init_args size, unknown disallow', () => {
  const e = new VaultModel({ chain: 'evm' }), n = new VaultModel({ chain: 'near' });
  assert.equal(code(() => e.exec('allow_template', 'owner', { template: 't', label: 'x'.repeat(65), deposit: 0 }, 1)), 'BadTemplate');
  assert.equal(code(() => e.exec('allow_template', 'owner', { template: 't', label: 'é'.repeat(33), deposit: 0 }, 1)), 'BadTemplate'); // 66 bytes
  assert.equal(code(() => e.exec('allow_template', 'owner', { template: 't', label: 'x'.repeat(64), deposit: 0 }, 1)), 'ok');
  assert.equal(code(() => e.exec('allow_template', 'owner', { template: 't', label: 'x', deposit: 1 }, 1)), 'BadTemplate');
  assert.equal(code(() => n.exec('allow_template', 'owner', { template: 't', label: 'x', deposit: 1, init_args: 'x'.repeat(1025) }, 1)), 'BadTemplate');
  assert.equal(code(() => n.exec('allow_template', 'owner', { template: 't', label: 'x', deposit: 1, init_args: { owner: 'dao.testnet' }, init_gas: 30 }, 1)), 'ok');
  assert.equal(n.template('t').deposit, 1n);
  assert.equal(code(() => n.exec('disallow_template', 'owner', { template: 'zz' }, 1)), 'TemplateNotAllowed');
  // re-allowing updates
  n.exec('allow_template', 'owner', { template: 't', label: 'y', deposit: 2 }, 1);
  assert.equal(n.template('t').label, 'y'); assert.equal(n.listTemplates().length, 1);
});

test('NEAR async deploy: onDeployFailed reverses counters, refunds the deposit, frees the name; idempotent', () => {
  const m = mk('near'); m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  const r = m.exec('deploy', 'agent', { template: 't1', name: 'a' }, 1002);
  assert.deepEqual([m.usage.deploys, m.usage.totalSpent, m.usage.periodSpent, m.available()], [1n, 60n, 60n, 940n]);
  assert.equal(m.pendingDeploys.size, 1);
  assert.equal(m.onDeployFailed(r), true);
  assert.deepEqual([m.usage.deploys, m.usage.totalSpent, m.usage.periodSpent, m.available()], [0n, 0n, 0n, 1000n]);
  assert.equal(m.onDeployFailed(r), false);
  assert.equal(m.events.at(-1).type, 'DeployFailed');
  m.exec('deploy', 'agent', { template: 't1', name: 'a' }, 1003); // name is free again
  // success path closes the window without reversing
  const r2 = m.exec('deploy', 'agent', { template: 't1', name: 'b' }, 1004);
  assert.equal(m.onDeployed(r2), true); assert.equal(m.onDeployFailed(r2), false); assert.equal(m.usage.deploys, 2n);
});

test('onDeployFailed after a new mandate (epoch changed) only refunds balance and frees the name; usage is not double-reversed', () => {
  const m = mk('near'); m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  const r = m.exec('deploy', 'agent', { template: 't1', name: 'a' }, 1002);
  m.exec('set_mandate', 'owner', { ...MANDATE, expires_at: 9000 }, 1003);
  assert.equal(m.onDeployFailed(r), true);
  assert.deepEqual([m.usage.deploys, m.usage.totalSpent], [0n, 0n]);
  assert.equal(m.available(), 1000n);
});

test('onDeployFailed in a later period does not touch the new period_spent', () => {
  const m = mk('near'); m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  const r = m.exec('deploy', 'agent', { template: 't1', name: 'a' }, 1002);
  m.exec('deploy', 'agent', { template: 't1', name: 'b' }, 1700); // period 1
  m.onDeployFailed(r);
  assert.deepEqual([m.usage.deploys, m.usage.totalSpent, m.usage.periodSpent], [1n, 60n, 60n]);
});

test('previews equal what the real op would do, and never mutate', () => {
  const m = mk('near'); m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  const snap = () => JSON.stringify(m.snapshot(1002), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  const s0 = snap();
  assert.equal(m.exec('preview_draw', 'anyone', { amount: 100 }, 1002), '');
  assert.equal(m.exec('preview_draw', 'anyone', { amount: 101 }, 1002), 'PerDrawCap');
  assert.equal(m.exec('preview_deploy', 'x', { template: 't1', name: 'a' }, 1002), '');
  assert.equal(m.exec('preview_deploy', 'x', { template: 't1', name: 'A!' }, 1002), 'BadName');
  assert.equal(m.exec('preview_draw', 'x', { amount: 1 }, 99_999), 'MandateInactive');
  assert.equal(snap(), s0);
  assert.equal(new VaultModel({ chain: 'evm' }).previewDraw(1, 5), 'NoMandate');
});

test('ownership: pending owner has no powers; accept clears pending', () => {
  const m = new VaultModel({ chain: 'evm', owner: 'o1', balance: 5n });
  m.exec('transfer_ownership', 'o1', { to: 'o2' }, 1);
  assert.equal(code(() => m.exec('withdraw', 'o2', { amount: 1 }, 1)), 'Unauthorized');
  m.exec('accept_ownership', 'o2', {}, 2);
  assert.equal(m.config.owner, 'o2'); assert.equal(m.config.pendingOwner, null);
  assert.equal(code(() => m.exec('accept_ownership', 'o2', {}, 3)), 'Unauthorized');
  assert.equal(code(() => m.exec('transfer_ownership', 'o2', { to: '0x0000000000000000000000000000000000000000' }, 3)), 'BadOwner');
});

test('describeBudget: headroom across per-draw, period, total, deploys, balance', () => {
  const m = mk('near', 120n); m.exec('allow_template', 'owner', { template: 't1', label: 'x', deposit: 60 }, 1001);
  let b = describeBudget(m, 1001);
  assert.equal(b.active, true); assert.equal(b.blocked, '');
  assert.equal(b.maxDraw, 100n); assert.equal(b.maxDeployDeposit, 120n);
  assert.deepEqual([b.period.remaining, b.total.remaining, b.deploys.remaining, b.available], [250n, 400n, 3n, 120n]);
  m.exec('draw', 'agent', { amount: 100 }, 1002);
  b = describeBudget(m, 1003);
  assert.equal(b.maxDraw, 20n); assert.equal(b.period.spent, 100n); assert.equal(b.period.remaining, 150n);
  assert.equal(b.period.resetsAt, 1600n);
  b = describeBudget(m, 1600);           // new period: spent treated as 0, but balance still limits
  assert.equal(b.period.spent, 0n); assert.equal(b.period.remaining, 250n); assert.equal(b.maxDraw, 20n);
  m.exec('pause', 'owner', {}, 1604);
  b = describeBudget(m, 1605);
  assert.equal(b.blocked, 'Paused'); assert.equal(b.active, false); assert.equal(b.maxDraw, 0n);
  assert.equal(describeBudget(new VaultModel({ chain: 'evm' }), 1).blocked, 'NoMandate');
  assert.equal(describeBudget(mk(), 99_999).blocked, 'MandateInactive');
  const j = budgetToJSON(describeBudget(mk(), 1001));
  assert.equal(j.total.cap, '400'); assert.doesNotThrow(() => JSON.stringify(j));
});

test('describeBudget agrees with previews at the boundary', () => {
  const m = mk('evm', 1000n); m.exec('draw', 'agent', { amount: 90 }, 1001); m.exec('draw', 'agent', { amount: 100 }, 1002);
  const b = describeBudget(m, 1003);
  assert.equal(m.previewDraw(b.maxDraw, 1003), '');
  assert.notEqual(m.previewDraw(b.maxDraw + 1n, 1003), '');
});

test('clone is independent', () => {
  const m = mk(); const c = m.clone();
  c.exec('draw', 'agent', { amount: 10 }, 1002);
  assert.equal(m.usage.totalSpent, 0n); assert.equal(c.usage.totalSpent, 10n);
});

// ---------------------------------------------------------------- property tests (seeded, deterministic)
function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function runRandom(seed, chain, steps = 400) {
  const rnd = prng(seed); const pick = (a) => a[Math.floor(rnd() * a.length)]; const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const m = new VaultModel({ chain, owner: 'owner', balance: BigInt(int(0, 800)) });
  const callers = ['owner', 'agent', 'agent', 'agent', 'other', 'newOwner'];
  const pool = Array.from({ length: 60 }, (_, i) => `n${i}`);
  const names = chain === 'near' ? [...pool, 'A!', 'x.y', ''] : [...pool, ''];
  const tpls = ['t1', 't2', 't3'];
  let now = 1000; const pending = [];
  // Start from a sane mandate + allowlisted templates so deploys/draws actually succeed; random ops then churn it.
  m.exec('set_mandate', 'owner', { agent: 'agent', expires_at: now + 20_000, per_draw_cap: 60, period_secs: 600, period_cap: 150, total_cap: 400, max_deploys: 6 }, now);
  for (const t of tpls) m.exec('allow_template', 'owner', { template: t, label: t, deposit: chain === 'near' ? int(0, 60) : 0 }, now);
  let ops = 0, vaultErrors = 0, deployed = 0;
  const check = () => {
    const u = m.usage, mand = m.mandate;
    assert.ok(u.totalSpent >= 0n && u.periodSpent >= 0n && u.deploys >= 0n && m.balance >= 0n, 'non-negative');
    if (mand) {
      assert.ok(u.totalSpent <= mand.totalCap, 'total_spent <= total_cap');
      assert.ok(u.periodSpent <= mand.periodCap, 'period_spent <= period_cap');
      assert.ok(m.periodState(now).spent <= mand.periodCap, 'effective period_spent <= period_cap');
      assert.ok(u.deploys <= mand.maxDeploys, 'deploys <= max_deploys');
      assert.ok(u.periodSpent <= u.totalSpent, 'period_spent <= total_spent');
    }
    let recv = 0n; for (const v of m.received.values()) recv += v;
    assert.equal(m.deposited, m.balance + recv + m.deployedDeposits, 'funds conserved');
    assert.ok(m.deployedDeposits >= 0n);
    for (const addr of m.received.keys()) assert.ok(addr === 'owner' || addr === 'newOwner' || addr === 'agent' || addr === 'other' || m.config.owner === addr, 'funds only reach owner(s) or the bound agent');
  };
  for (let i = 0; i < steps; i++) {
    now += pick([0, 1, 5, 60, 300, 700, 2000]);
    const who = pick(callers);
    const kind = pick(['draw', 'draw', 'draw', 'deploy', 'deploy', 'deploy', 'deposit', 'deposit', 'withdraw', 'set_mandate', 'revoke', 'pause', 'unpause', 'unpause', 'allow_template', 'allow_template', 'allow_template', 'disallow_template', 'transfer_ownership', 'accept_ownership', 'preview_draw', 'preview_deploy', 'fail_pending']);
    const args = {
      draw: () => ({ amount: pick([0, 1, 10, 50, 100, 101, 250, 5000, 1.5, -2, '7', 7n]) }),
      deploy: () => ({ template: pick(tpls), name: pick(names), ...(rnd() < 0.1 ? { code: pick(tpls) } : {}) }),
      deposit: () => ({ amount: int(0, 300) }),
      withdraw: () => ({ amount: int(0, 400) }),
      set_mandate: () => (rnd() < 0.6
        ? { agent: pick(['agent', 'agent', 'other']), expires_at: now + int(100, 20_000), per_draw_cap: int(1, 80), period_secs: pick([60, 600, 600, 3000]), period_cap: int(80, 200), total_cap: int(200, 500), max_deploys: int(0, 8) }
        : { agent: pick(['agent', 'other', '']), expires_at: now + pick([-5, 0, 1, 100, 3000, 50000, 3_000_000]), per_draw_cap: int(0, 120), period_secs: pick([30, 60, 600, 600, 90000, 3_000_000]), period_cap: int(0, 300), total_cap: int(0, 500), max_deploys: pick([0, 1, 2, 5, 2000]) }),
      allow_template: () => ({ template: pick(tpls), label: pick(['x', 'y', 'y', 'z'.repeat(70)]), deposit: pick([0, 0, 5, 40, 120]) }),
      disallow_template: () => ({ template: pick(tpls) }),
      transfer_ownership: () => ({ to: pick(['newOwner', 'owner', '', 'other']) }),
      preview_draw: () => ({ amount: int(0, 150) }),
      preview_deploy: () => ({ template: pick(tpls), name: pick(names) }),
    }[kind]?.() ?? {};
    const ok0 = JSON.stringify([m.usage, m.balance, m.config, m.mandate, [...m.taken], [...m.received]], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    try {
      ops++;
      if (kind === 'fail_pending') { const r = pending.shift(); if (r) m.onDeployFailed(r, { releaseName: rnd() < 0.5 }); }
      else {
        const preDraw = kind === 'draw' && who === m.mandate?.agent ? m.previewDraw(args.amount, now) : null;
        const preDep = kind === 'deploy' && who === m.mandate?.agent ? m.previewDeploy(args.template, args.name, now, args.code) : null;
        const out = m.exec(kind, who, args, now);
        if (preDraw !== null) assert.equal(preDraw, '', 'preview said error but draw succeeded');
        if (preDep !== null) assert.equal(preDep, '', 'preview said error but deploy succeeded');
        if (kind === 'deploy') { deployed++; if (chain === 'near') pending.push(out); }
      }
    } catch (e) {
      assert.ok(e instanceof VaultError, `non-VaultError thrown: ${e?.stack}`);
      assert.ok(ERROR_CODES.includes(e.code), `unknown code ${e.code}`);
      vaultErrors++;
      const ok1 = JSON.stringify([m.usage, m.balance, m.config, m.mandate, [...m.taken], [...m.received]], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      assert.equal(ok1, ok0, `rejected ${kind} mutated state`);
      // previews must agree with the failing real op when the caller is the bound agent
      if (kind === 'draw' && who === m.mandate?.agent) assert.equal(m.previewDraw(args.amount, now), e.code);
      if (kind === 'deploy' && who === m.mandate?.agent) assert.equal(m.previewDeploy(args.template, args.name, now, args.code), e.code);
    }
    check();
  }
  return { ops, vaultErrors, deployed };
}

for (const chain of ['evm', 'near']) {
  test(`property [${chain}]: random op sequences keep every invariant, throw only VaultError`, () => {
    let totalOps = 0, deploys = 0, errs = 0;
    for (let seed = 1; seed <= 150; seed++) { const r = runRandom(seed * 7919, chain); totalOps += r.ops; deploys += r.deployed; errs += r.vaultErrors; }
    assert.ok(totalOps >= 60_000);
    assert.ok(errs > 1000, 'generator must hit rejections');
    assert.ok(deploys > 250, `generator must exercise deploys (got ${deploys})`);
  });
}

test('property: describeBudget.maxDraw is exactly the largest draw previewDraw accepts', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = prng(seed); const m = new VaultModel({ chain: 'evm', owner: 'owner', balance: BigInt(Math.floor(rnd() * 500)) });
    m.exec('set_mandate', 'owner', { agent: 'agent', expires_at: 5000, per_draw_cap: 1 + Math.floor(rnd() * 100), period_secs: 600, period_cap: 150 + Math.floor(rnd() * 100), total_cap: 300 + Math.floor(rnd() * 200), max_deploys: 0 }, 1000);
    let now = 1000;
    for (let i = 0; i < 25; i++) {
      now += Math.floor(rnd() * 400);
      const b = describeBudget(m, now);
      if (b.maxDraw > 0n) assert.equal(m.previewDraw(b.maxDraw, now), '');
      assert.notEqual(m.previewDraw(b.maxDraw + 1n, now), '');
      if (b.maxDraw > 0n && rnd() < 0.8) m.exec('draw', 'agent', { amount: b.maxDraw > 3n ? b.maxDraw / 2n + 1n : b.maxDraw }, now);
    }
  }
});
