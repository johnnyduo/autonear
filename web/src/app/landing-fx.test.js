import test from 'node:test';
import assert from 'node:assert/strict';
import { springStep, dampingFor, sagFromTension, taperWidth, sagShape, sagLimit, quadPoint, cubicPoint, curveSegments, narrowSegments, sampleSegments, cumulative, pointAt, head, ribbonPath, polylinePath, threadPoints } from './landing-fx.js';

const noNaN = (s) => assert.ok(!/NaN|Infinity/.test(s), s.slice(0, 80));

test('spring converges on its target and stays finite after a long frame', () => {
  let s = { x: 0, v: 0 };
  for (let i = 0; i < 400; i++) s = springStep(s, 12, 40, dampingFor(40, 0.3), 1 / 60);
  assert.ok(Math.abs(s.x - 12) < 1e-3 && Math.abs(s.v) < 1e-3, JSON.stringify(s));
  const big = springStep({ x: 0, v: 0 }, 5, 300, 4, 5);
  assert.ok(Number.isFinite(big.x) && Math.abs(big.x) < 50);
  assert.deepEqual(springStep({ x: 1, v: 2 }, 3, 40, 5, NaN), { x: 1, v: 2 }, 'a bad dt does nothing');
});

test('a lightly damped spring overshoots, a critically damped one does not', () => {
  const run = (zeta) => { let s = { x: 0, v: 0 }; let peak = 0; for (let i = 0; i < 300; i++) { s = springStep(s, 10, 40, dampingFor(40, zeta), 1 / 60); peak = Math.max(peak, s.x); } return peak; };
  assert.ok(run(0.2) > 10.5);
  assert.ok(run(1) <= 10.001);
});

test('sag shrinks as tension grows and stays inside its limits', () => {
  let prev = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) { const s = sagFromTension(700, t); assert.ok(s <= prev); prev = s; }
  assert.ok(sagFromTension(700, 1) < 4);
  assert.ok(sagFromTension(700, 0) > 30);
  assert.equal(sagFromTension(700, 0, { max: 12 }), 12);
  assert.equal(sagFromTension(700, 5), sagFromTension(700, 1), 'tension is clamped');
  assert.equal(sagFromTension(-5, 0), 0);
});

test('taper is positive and never widens toward the sphere', () => {
  let prev = Infinity;
  for (let u = 0; u <= 1.0001; u += 0.05) { const w = taperWidth(u, 2.4, 0.7); assert.ok(w > 0 && w <= prev + 1e-12); prev = w; }
  assert.equal(taperWidth(0, 2.4, 0.7), 2.4);
  assert.ok(Math.abs(taperWidth(1, 2.4, 0.7) - 0.7) < 1e-9);
  assert.ok(taperWidth(-3, 2, 1) === 2 && taperWidth(9, 2, 1) === 1);
});

test('points on a quadratic and a cubic start and end where they should', () => {
  const a = [0, 0]; const b = [50, 80]; const c = [100, 20]; const d = [160, 0];
  assert.deepEqual(quadPoint(a, b, c, 0), a); assert.deepEqual(quadPoint(a, b, c, 1), c);
  assert.deepEqual(cubicPoint(a, b, c, d, 0), a); assert.deepEqual(cubicPoint(a, b, c, d, 1), d);
  assert.deepEqual(quadPoint(a, [5, 5], c, 0.5), [(0 + 10 + 100) / 4, (0 + 10 + 20) / 4]);
});

test('the curve passes through its points and the lookup by length hits both ends', () => {
  const pts = threadPoints([10, 10], [700, 90], { sag: [30, 30] });
  const segs = curveSegments(pts);
  assert.equal(segs.length, 3);
  const line = sampleSegments(segs, 10); const cum = cumulative(line);
  assert.deepEqual(line[0], pts[0]); assert.deepEqual(line.at(-1), pts[3]);
  assert.deepEqual(pointAt(line, cum, 0), pts[0]); assert.deepEqual(pointAt(line, cum, 1), pts[3]);
  const mid = pointAt(line, cum, 0.5);
  assert.ok(mid[0] > 10 && mid[0] < 700);
  assert.ok(head(line, cum, 0.4).length < line.length && head(line, cum, 1) === line);
});

test('a zero-length path gives no NaN anywhere', () => {
  const p = [[5, 5], [5, 5], [5, 5], [5, 5]];
  const line = sampleSegments(curveSegments(p), 6); const cum = cumulative(line);
  assert.deepEqual(pointAt(line, cum, 0.5), [5, 5]);
  noNaN(ribbonPath(line, (u) => taperWidth(u, 2, 1)));
  noNaN(polylinePath(line));
  noNaN(ribbonPath(head(line, cum, 0.5), () => 1, line.length));
  assert.equal(ribbonPath([], () => 1), '');
  assert.deepEqual(pointAt([], [], 0.5), [0, 0]);
  noNaN(polylinePath(sampleSegments(curveSegments(threadPoints([1, 1], [1, 1], { sag: [0, 0] })), 4)));
});

test('the ribbon is a closed shape with the requested width', () => {
  const d = ribbonPath([[0, 0], [10, 0], [20, 0]], () => 4);
  assert.ok(d.startsWith('M0.00 2.00') && d.endsWith('Z'));
  assert.ok(d.includes('L20.00 -2.00'));
});

test('the sag limit keeps the thread above the sub line and ignores a rectangle it never reaches', () => {
  const p0 = [170, 390]; const p1 = [900, 440]; const rect = { l: 56, t: 450, r: 530, b: 500 };
  const lim = sagLimit(p0, p1, rect);
  assert.ok(Number.isFinite(lim) && lim >= 0, String(lim));
  for (let i = 1; i < 40; i++) { const u = i / 40; const x = 170 + 730 * u; if (x < rect.l - 6 || x > rect.r + 6) continue; assert.ok(390 + 50 * u + lim * sagShape(u) <= rect.t - 6 + 1e-9, `u=${u}`); }
  assert.equal(sagLimit(p0, p1, { l: 56, t: 380, r: 530, b: 500 }), 0, 'a rectangle the straight line already crosses allows no sag');
  assert.equal(sagLimit(p0, p1, { l: 1000, t: 450, r: 1200, b: 500 }), Infinity);
  assert.equal(sagShape(0), 0); assert.equal(sagShape(1), 0); assert.equal(sagShape(0.78), 1);
});

test('narrow layout runs down the gutter, stays inside it and ends at the given point', () => {
  const segs = narrowSegments([160, 220], [195, 900], { gutterX: 383, midY: 620, sag: [6, 6] });
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0][0], [160, 220]); assert.deepEqual(segs[2][3], [195, 900]);
  for (let i = 1; i < 3; i++) assert.deepEqual(segs[i][0], segs[i - 1][3], 'segments join');
  const line = sampleSegments(segs, 12);
  assert.ok(line.every(([x]) => x <= 383.001 && x >= 160 - 1), 'no overshoot past the gutter');
  noNaN(ribbonPath(line, (u) => taperWidth(u, 2, 1)));
});
