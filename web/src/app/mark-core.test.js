import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedOf, rng, markParams, spherePoints, rotX, rotY, rotZ, project, ringPoint, ringPoints, arcPoint, mixColor } from './mark-core.js';

const len = (p) => Math.hypot(p[0], p[1], p[2]);

test('seedOf: same text same number, different text different number, always a 32-bit unsigned integer', () => {
  assert.equal(seedOf('3f9a1c2b04'), seedOf('3f9a1c2b04'));
  assert.notEqual(seedOf('3f9a1c2b04'), seedOf('3f9a1c2b05'));
  for (const t of ['', 'a', null, undefined, 'x'.repeat(500)]) { const s = seedOf(t); assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32); }
});

test('rng: deterministic, in [0, 1), roughly uniform', () => {
  const a = rng(42); const b = rng(42);
  let sum = 0;
  for (let k = 0; k < 2000; k++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); sum += x; }
  assert.ok(Math.abs(sum / 2000 - 0.5) < 0.04);
  assert.notEqual(rng(1)(), rng(2)());
});

test('markParams: same seed same params; different seeds differ; values stay in range', () => {
  assert.deepEqual(markParams(7), markParams(7));
  const seen = new Set();
  for (let s = 1; s <= 60; s++) {
    const p = markParams(seedOf('hash' + s));
    seen.add(JSON.stringify(p));
    assert.ok(p.rings.length === 2 || p.rings.length === 3);
    assert.ok(p.nodes.length >= 3 && p.nodes.length <= 5);
    assert.equal(p.arcs.length, 4);
    for (const n of p.nodes) assert.ok(n.ring >= 0 && n.ring < p.rings.length);
    for (const r of p.rings) assert.ok(r.radius > 1.3 && r.radius < 1.8 && r.dots >= 72 && r.dots < 108);
    for (const a of p.arcs) { assert.ok(Math.abs(len(a.a) - 1) < 1e-9 && Math.abs(len(a.b) - 1) < 1e-9); assert.ok(a.period > 3 && a.offset >= 0 && a.offset < a.period); }
    assert.ok(p.bandK >= 2 && p.bandK <= 4);
  }
  assert.equal(seen.size, 60);
  const rings = new Set(); for (let s = 1; s <= 60; s++) rings.add(markParams(s).rings.length);
  assert.equal(rings.size, 2, 'both 2 and 3 rings occur');
});

test('spherePoints: n points on the unit sphere, no duplicates, the bands move points but keep them on the sphere', () => {
  for (const params of [null, markParams(11), markParams(12)]) {
    const pts = spherePoints(300, params);
    assert.equal(pts.length, 300);
    for (const p of pts) assert.ok(Math.abs(len(p) - 1) < 1e-9);
    assert.equal(new Set(pts.map((p) => p.map((v) => v.toFixed(6)).join())).size, 300);
  }
  const plain = spherePoints(100, null); const banded = spherePoints(100, markParams(5));
  assert.ok(plain.some((p, k) => Math.abs(p[1] - banded[k][1]) > 0.005));
  assert.deepEqual(spherePoints(50, markParams(3)), spherePoints(50, markParams(3)));
  assert.equal(spherePoints(0, null).length, 0);
});

test('rotations keep length and turn the right way', () => {
  const p = [0.3, -0.5, 0.8];
  for (const f of [rotX, rotY, rotZ]) { assert.ok(Math.abs(len(f(p, 1.1)) - len(p)) < 1e-12); const back = f(f(p, 0.7), -0.7); back.forEach((v, k) => assert.ok(Math.abs(v - p[k]) < 1e-12)); }
  const q = rotY([0, 0, 1], Math.PI / 2); assert.ok(Math.abs(q[0] - 1) < 1e-12 && Math.abs(q[2]) < 1e-12);
});

test('project: nearer points are larger, the axis stays centred, the camera distance is respected', () => {
  const near = project([0.5, 0.5, 1], 5); const far = project([0.5, 0.5, -1], 5);
  assert.ok(near[2] > far[2] && Math.abs(near[0]) > Math.abs(far[0]));
  assert.deepEqual(project([0, 0, 0.7], 5).slice(0, 2), [0, 0]);
  assert.equal(project([0, 0, 0], 5)[2], 1);
  assert.equal(project([0, 0, 1])[3], 1, 'default distance and z is passed through');
});

test('ringPoints: all points keep the ring radius, n of them, and the turn moves them', () => {
  const ring = markParams(9).rings[0];
  const pts = ringPoints(ring, 90, 0);
  assert.equal(pts.length, 90);
  for (const p of pts) assert.ok(Math.abs(len(p) - ring.radius) < 1e-9);
  assert.ok(len(ringPoints(ring, 90, 0.5)[0].map((v, k) => v - pts[0][k])) > 0.01);
  assert.deepEqual(ringPoint(ring, 1), ringPoint(ring, 1));
});

test('arcPoint: starts at a, ends at b, rises in the middle, stays finite for equal and opposite points', () => {
  const a = [1, 0, 0]; const b = [0, 1, 0];
  arcPoint(a, b, 0, 0.3).forEach((v, k) => assert.ok(Math.abs(v - a[k]) < 1e-9));
  arcPoint(a, b, 1, 0.3).forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-9));
  assert.ok(Math.abs(len(arcPoint(a, b, 0.5, 0.3)) - 1.3) < 1e-9);
  assert.ok(Math.abs(len(arcPoint(a, b, 0.5, 0)) - 1) < 1e-9);
  for (const t of [0, 0.5, 1]) { for (const other of [a, [-1, 0, 0]]) arcPoint(a, other, t, 0.2).forEach((v) => assert.ok(Number.isFinite(v))); }
});

test('mixColor: lime near, mineral blue far, in between is between', () => {
  assert.deepEqual(mixColor(1), [198, 244, 50]); assert.deepEqual(mixColor(0), [127, 182, 207]);
  assert.deepEqual(mixColor(2), mixColor(1)); assert.deepEqual(mixColor(-3), mixColor(0));
  const mid = mixColor(0.5); assert.ok(mid[0] > 127 && mid[0] < 198 && mid[2] > 50 && mid[2] < 207);
});

test('the copy of the core inside web/public/mark.js is identical to this module', () => {
  const grab = (file, indent) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = src.match(/\/\/ BEGIN markCore[^\n]*\n([\s\S]*?)\n\s*\/\/ END markCore/);
    assert.ok(m, `markers missing in ${file}`);
    return m[1].split('\n').map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
  };
  const mod = grab('./mark-core.js', '');
  const pub = grab('../../public/mark.js', '  ');
  assert.ok(mod.startsWith('const TAU'));
  assert.equal(pub, mod);
});
