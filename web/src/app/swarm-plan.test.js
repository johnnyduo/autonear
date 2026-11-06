import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planTasks } from './swarm-plan.js';

const AGENTS = ['Copy', 'Layout', 'Style', 'Media', 'Check'];
// A page shaped like the rendered site: hero box with text and a button, a features grid, a steps list, a footer line.
function page(extraCards = 0) {
  const els = [{ id: 'hero', kind: 'box' }, { id: 'h1', kind: 'text', parent: 'hero', len: 60 }, { id: 'sub', kind: 'text', parent: 'hero', len: 130 }, { id: 'cta', kind: 'button', parent: 'hero' }, { id: 'art', kind: 'media', parent: 'hero' }, { id: 'rule', kind: 'line' }];
  for (let i = 0; i < 3 + extraCards; i++) {
    els.push({ id: `f${i}`, kind: 'box' }, { id: `f${i}t`, kind: 'text', parent: `f${i}`, len: 24 }, { id: `f${i}b`, kind: 'text', parent: `f${i}`, len: 100 });
  }
  els.push({ id: 'foot', kind: 'box', agent: 'Check' }, { id: 'footnote', kind: 'text', parent: 'foot', len: 90, agent: 'Check' });
  return els;
}
const byId = (tasks) => Object.fromEntries(tasks.map((t) => [t.id, t]));

test('every element gets exactly one task, in the same order', () => {
  const els = page();
  const tasks = planTasks(els, { agents: AGENTS, totalMs: 16800 });
  assert.equal(tasks.length, els.length);
  assert.deepEqual(tasks.map((t) => t.id), els.map((e) => e.id));
  assert.equal(new Set(tasks.map((t) => t.id)).size, els.length);
  for (const t of tasks) assert.ok(AGENTS.includes(t.agent) && AGENTS.includes(t.owner));
});

test('a child starts after its parent ends, with and without work stealing', () => {
  for (const steal of [true, false]) {
    for (const extra of [0, 4, 20]) {
      const tasks = planTasks(page(extra), { agents: AGENTS, totalMs: 16800, steal });
      const m = byId(tasks);
      for (const t of tasks) for (const d of t.deps) assert.ok(t.start >= m[d].start + m[d].duration, `${t.id} starts before ${d} ends (steal=${steal})`);
    }
  }
});

test('one agent never works on two tasks at the same time', () => {
  const tasks = planTasks(page(6), { agents: AGENTS, totalMs: 16800 });
  for (const a of AGENTS) {
    const mine = tasks.filter((t) => t.agent === a).sort((x, y) => x.start - y.start);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].start >= mine[i - 1].start + mine[i - 1].duration, `${a} overlaps`);
  }
});

test('the whole build finishes within totalMs and uses most of it for a normal page', () => {
  for (const [extra, total] of [[0, 16800], [10, 16800], [3, 9000]]) {
    const tasks = planTasks(page(extra), { agents: AGENTS, totalMs: total });
    const end = Math.max(...tasks.map((t) => t.start + t.duration));
    assert.ok(end <= total, `ends at ${end} of ${total}`);
  }
  const tasks = planTasks(page(10), { agents: AGENTS, totalMs: 16800 });
  assert.ok(Math.max(...tasks.map((t) => t.start + t.duration)) > 16800 * 0.8);
});

test('durations stay between 120 ms and 1800 ms', () => {
  for (const els of [page(0), page(30), [{ id: 'a', kind: 'text', len: 5000 }, { id: 'b', kind: 'line' }]]) {
    for (const t of planTasks(els, { agents: AGENTS, totalMs: 16800 })) assert.ok(t.duration >= 120 && t.duration <= 1800, `${t.id}: ${t.duration}`);
  }
});

test('assignment follows data-sw-agent, then the kind', () => {
  const els = [{ id: 'a', kind: 'box' }, { id: 'b', kind: 'text' }, { id: 'c', kind: 'line' }, { id: 'd', kind: 'media' }, { id: 'e', kind: 'button' }, { id: 'f', kind: 'text', agent: 'Check' }, { id: 'g', kind: 'box', agent: 'Style' }, { id: 'h', kind: 'box', agent: 'Nobody' }];
  const o = byId(planTasks(els, { agents: AGENTS, totalMs: 16800, steal: false }));
  assert.deepEqual([o.a.agent, o.b.agent, o.c.agent, o.d.agent, o.e.agent], ['Layout', 'Copy', 'Style', 'Media', 'Layout']);
  assert.equal(o.f.agent, 'Check');
  assert.equal(o.g.agent, 'Style');
  assert.equal(o.h.agent, 'Layout', 'an unknown agent name falls back to the kind');
  const s = byId(planTasks(els, { agents: AGENTS, totalMs: 16800 }));
  for (const e of els) assert.equal(s[e.id].owner, o[e.id].agent, 'the owner does not change when stealing is on');
});

test('an idle agent helps: with stealing on, Check works although only the footer is its own', () => {
  const tasks = planTasks(page(4), { agents: AGENTS, totalMs: 16800 });
  const check = tasks.filter((t) => t.agent === 'Check');
  assert.ok(check.length > 2);
  assert.ok(check.some((t) => t.stolen));
  const off = planTasks(page(4), { agents: AGENTS, totalMs: 16800, steal: false });
  assert.ok(off.every((t) => !t.stolen));
  assert.equal(off.filter((t) => t.agent === 'Check').length, 2);
});

test('stealing lets tasks take at least as long as without it, inside the same total', () => {
  const sum = (ts) => ts.reduce((a, t) => a + t.duration, 0);
  const on = planTasks(page(6), { agents: AGENTS, totalMs: 4000 });
  const off = planTasks(page(6), { agents: AGENTS, totalMs: 4000, steal: false });
  assert.ok(sum(on) >= sum(off));
});

test('a missing, unknown or later parent is treated as no parent', () => {
  const tasks = planTasks([{ id: 'x', kind: 'box', parent: 'zzz' }, { id: 'y', kind: 'box', parent: 'later' }, { id: 'later', kind: 'box' }], { agents: AGENTS, totalMs: 5000 });
  for (const t of tasks) assert.deepEqual(t.deps, []);
});

test('empty input and unknown kinds do not throw', () => {
  assert.deepEqual(planTasks([], { agents: AGENTS, totalMs: 1000 }), []);
  assert.equal(planTasks([{ id: 'a', kind: 'weird' }], { agents: AGENTS, totalMs: 1000 })[0].kind, 'box');
});

test('the same input gives the same plan', () => {
  assert.deepEqual(planTasks(page(2), { agents: AGENTS, totalMs: 16800 }), planTasks(page(2), { agents: AGENTS, totalMs: 16800 }));
});

test('the copy of planTasks inside web/public/swarm.js is identical to this module', () => {
  const grab = (file, indent) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = src.match(/\/\/ BEGIN planTasks[^\n]*\n([\s\S]*?)\n\s*\/\/ END planTasks/);
    assert.ok(m, `markers missing in ${file}`);
    return m[1].split('\n').map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
  };
  const mod = grab('./swarm-plan.js', '');
  const pub = grab('../../public/swarm.js', '  ');
  assert.ok(mod.startsWith('function planTasks('));
  assert.equal(pub, mod);
});
