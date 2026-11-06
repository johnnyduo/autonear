// Maths for the landing hero thread: a spring-damper, a smooth path through a few points, arc-length lookups and a tapered ribbon.
// Plain numbers in, plain numbers out, so it runs in Node tests. Points are [x, y].

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// One step of x'' = k (target - x) - c x'. Sub-stepped so a long frame cannot blow the simulation up.
export function springStep(s, target, k, c, dt) {
  const total = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const n = Math.max(1, Math.ceil(total / (1 / 120)));
  const h = total / n;
  let { x, v } = s;
  for (let i = 0; i < n; i++) { v += (k * (target - x) - c * v) * h; x += v * h; }
  return { x, v };
}

// damping coefficient for a given stiffness and damping ratio (0.2 rings for a while, 1 does not overshoot)
export const dampingFor = (k, zeta) => 2 * zeta * Math.sqrt(k);

// How far the thread hangs below the straight line between its ends. tension 0 = slack, 1 = pulled taut.
export function sagFromTension(len, tension, { rest = 0.055, taut = 0.004, max = Infinity } = {}) {
  const t = clamp(tension, 0, 1);
  const sag = Math.max(0, len) * (taut + (rest - taut) * (1 - t) * (1 - t));
  return Math.min(sag, max);
}

// Line width along the thread: u = 0 at the headline end, u = 1 at the sphere. Never below w1, never increasing.
export function taperWidth(u, w0, w1, curve = 1.5) {
  const f = (1 - clamp(u, 0, 1)) ** curve;
  return Math.max(0.01, w1 + (w0 - w1) * f);
}

// weight of the sag along the thread: nothing at either end, most of it in the last third, where the lower end is
const SHAPE = [[0, 0], [0.45, 0.1], [0.78, 1], [1, 0]];
export const SAG_AT = [SHAPE[1][0], SHAPE[2][0]];
export const SAG_W = [SHAPE[1][1], SHAPE[2][1]];
export function sagShape(u) {
  const x = clamp(u, 0, 1);
  for (let i = 1; i < SHAPE.length; i++) {
    if (x <= SHAPE[i][0]) { const [a, wa] = SHAPE[i - 1]; const [b, wb] = SHAPE[i]; return lerp(wa, wb, (x - a) / (b - a)); }
  }
  return 0;
}

// The largest sag that keeps the thread above a rectangle {l, t, r, b} (the sub line under the headline).
// Only the stretch of the thread that is over the rectangle counts.
export function sagLimit(p0, p1, rect, margin = 6) {
  let limit = Infinity;
  for (let i = 1; i < 40; i++) {
    const u = i / 40; const x = lerp(p0[0], p1[0], u); const y = lerp(p0[1], p1[1], u); const w = sagShape(u);
    if (w < 0.05 || x < rect.l - margin || x > rect.r + margin) continue;
    limit = Math.min(limit, Math.max(0, rect.t - margin - y) / w);
  }
  return limit;
}

export function quadPoint(a, b, c, t) {
  const m = 1 - t;
  return [m * m * a[0] + 2 * m * t * b[0] + t * t * c[0], m * m * a[1] + 2 * m * t * b[1] + t * t * c[1]];
}

export function cubicPoint(a, b, c, d, t) {
  const m = 1 - t; const w0 = m * m * m; const w1 = 3 * m * m * t; const w2 = 3 * m * t * t; const w3 = t * t * t;
  return [w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]];
}

// Smooth curve through the points (Catmull-Rom turned into cubic segments). The curve passes through every point.
export function curveSegments(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(pts.length - 1, i + 2)];
    segs.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return segs;
}

// per cubic segment `per` samples, plus the final point
export function sampleSegments(segs, per = 12) {
  const out = [];
  for (const s of segs) for (let i = 0; i < per; i++) out.push(cubicPoint(s[0], s[1], s[2], s[3], i / per));
  if (segs.length) out.push(segs[segs.length - 1][3]);
  return out;
}

// cumulative length along the sampled points
export function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return cum;
}

// the point a fraction u of the way along, measured by length (so a pulse moves at a steady speed)
export function pointAt(points, cum, u) {
  if (!points.length) return [0, 0];
  const total = cum[cum.length - 1];
  if (!(total > 0)) return points[0];
  const want = clamp(u, 0, 1) * total;
  let lo = 0; let hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= want) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo]; const f = span > 0 ? (want - cum[lo]) / span : 0;
  return [lerp(points[lo][0], points[hi][0], f), lerp(points[lo][1], points[hi][1], f)];
}

// only the first part (fraction r by length) of the sampled points, with an interpolated last point
export function head(points, cum, r) {
  if (r >= 1) return points;
  if (r <= 0 || points.length < 2) return points.slice(0, 1);
  const total = cum[cum.length - 1]; const want = r * total;
  let k = 1; while (k < cum.length - 1 && cum[k] < want) k++;
  return [...points.slice(0, k), pointAt(points, cum, r)];
}

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '0');

export function polylinePath(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])}`).join('');
}

// Closed outline of a line whose width follows widthAt(i / (n - 1)). Zero-length steps fall back to a horizontal tangent.
export function ribbonPath(points, widthAt, total = points.length) {
  const n = points.length;
  if (!n) return '';
  const left = []; const right = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)]; const b = points[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0]; let ty = b[1] - a[1]; const m = Math.hypot(tx, ty);
    if (m > 1e-9) { tx /= m; ty /= m; } else { tx = 1; ty = 0; }
    const w = widthAt(total > 1 ? i / (total - 1) : 0) / 2;
    left.push([points[i][0] - ty * w, points[i][1] + tx * w]);
    right.push([points[i][0] + ty * w, points[i][1] - tx * w]);
  }
  return `${polylinePath(left)}${right.reverse().map((p) => `L${f2(p[0])} ${f2(p[1])}`).join('')}Z`;
}

// Control points of the thread on a wide layout: a gentle catenary between the headline and the sphere.
// `sag` is how far each of the two inner points hangs (px, before the shape weight), `sway` moves them sideways.
export function threadPoints(start, end, { sag = [0, 0], sway = [0, 0] } = {}) {
  const pts = [start];
  for (let i = 0; i < 2; i++) {
    const u = SAG_AT[i];
    pts.push([lerp(start[0], end[0], u) + sway[i], lerp(start[1], end[1], u) + sag[i] * SAG_W[i]]);
  }
  pts.push(end);
  return pts;
}

// Narrow layout (copy above the sphere): out of the headline, down the right-hand gutter past the text and buttons, then in to the sphere.
// `sag` bows the straight run to the left by a few px, `sway` moves it sideways.
export function narrowSegments(start, end, { gutterX, midY, sag = [0, 0], sway = [0, 0] }) {
  const y1 = start[1] + 40; const y2 = Math.max(y1 + 60, midY);
  const a = gutterX - sag[0] + sway[0]; const b = gutterX - sag[1] + sway[1];
  const over = [gutterX, y1];
  const into = [gutterX, y2];
  return [
    [start, [start[0] + (gutterX - start[0]) * 0.55, start[1]], [gutterX, y1 - 24], over],
    [over, [a, y1 + (y2 - y1) / 3], [b, y2 - (y2 - y1) / 3], into],
    [into, [gutterX, y2 + (end[1] - y2) * 0.45], [end[0] + (gutterX - end[0]) * 0.3, end[1] - 34], end],
  ];
}
