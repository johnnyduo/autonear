import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate } from './contract-sim-core.js';

const base = { method: 'propose_payout', allowed: ['propose_payout', 'approve_payout'], amount: 120, perCall: 200, perPeriod: 500, spent: 0 };

test('an amount inside every limit is accepted and every step passes', () => {
  const r = simulate(base);
  assert.equal(r.accepted, true);
  assert.equal(r.code, null);
  assert.ok(r.steps.length >= 4 && r.steps.every((s) => s.ok));
  assert.deepEqual(r.steps.map((s) => typeof s.text), r.steps.map(() => 'string'));
});

test('a method that is not on the allowlist is refused with E_TemplateNotAllowed and nothing else is checked', () => {
  const r = simulate({ ...base, method: 'execute_payout' });
  assert.equal(r.accepted, false);
  assert.equal(r.code, 'E_TemplateNotAllowed');
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].ok, false);
});

test('an amount above the per-call cap is refused with E_PerDrawCap and asks for the owner', () => {
  const r = simulate({ ...base, amount: 201 });
  assert.equal(r.code, 'E_PerDrawCap');
  assert.equal(r.accepted, false);
  assert.match(r.steps.at(-1).text, /owner approval is needed above the cap/);
  assert.equal(simulate({ ...base, amount: 200 }).accepted, true, 'the cap itself is allowed');
});

test('an amount above what is left in the period is refused with E_PeriodCap', () => {
  const r = simulate({ ...base, amount: 150, spent: 400 });
  assert.equal(r.code, 'E_PeriodCap');
  assert.match(r.steps.at(-1).text, /100 left in this period/);
  assert.equal(simulate({ ...base, amount: 100, spent: 400 }).accepted, true);
  assert.equal(simulate({ ...base, amount: 1, spent: 900 }).code, 'E_PeriodCap', 'spent above the cap leaves nothing');
});

test('the per-call check comes before the period check', () => {
  assert.equal(simulate({ ...base, amount: 300, spent: 400 }).code, 'E_PerDrawCap');
});

test('bad amounts are refused: zero, negative, fraction, text, empty', () => {
  for (const amount of [0, -5, 1.5, 'abc', '', null, NaN, Infinity]) {
    const r = simulate({ ...base, amount });
    assert.equal(r.accepted, false, String(amount));
    assert.equal(r.code, 'E_BadAmount', String(amount));
  }
  assert.equal(simulate({ ...base, amount: '50' }).accepted, true, 'a numeric string from an input field is read as a number');
});

test('missing or odd input does not throw', () => {
  assert.equal(simulate().accepted, false);
  assert.equal(simulate({}).code, 'E_TemplateNotAllowed');
  assert.equal(simulate({ ...base, allowed: 'propose_payout' }).code, 'E_TemplateNotAllowed');
});

test('the same input gives the same result', () => {
  assert.deepEqual(simulate({ ...base, amount: 999 }), simulate({ ...base, amount: 999 }));
});

test('the copy of simulate inside web/public/contract-sim.js is identical to this module', () => {
  const grab = (file, indent) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = src.match(/\/\/ BEGIN simulate[^\n]*\n([\s\S]*?)\n\s*\/\/ END simulate/);
    assert.ok(m, `markers missing in ${file}`);
    return m[1].split('\n').map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
  };
  const mod = grab('./contract-sim-core.js', '');
  const pub = grab('../../public/contract-sim.js', '  ');
  assert.ok(mod.startsWith('function simulate('));
  assert.equal(pub, mod);
});
