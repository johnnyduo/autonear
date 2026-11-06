// Decoration for the glyph disc. Nothing in this file carries data: it depends only on time and fixed random seeds.
// Data layers are in disc.js, overlay-disc.js and fx-flow.js.
// Back to front: nebula, spiral dust arms, orbit rings, star-polygon rings, shockwaves, core rays, radar sweep, glow bursts, comets, cursor effects.
// Motion is slow. Nothing blinks faster than 3 Hz. With reduced motion the clock stays at 0 and the sweep, bursts and comets are off.
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t) => 1 - (1 - t) ** 3;
const STOPS = [[1, 0.8, 0.5], [1, 0.5, 0.72], [0.62, 0.48, 1], [0.3, 0.86, 0.95]];
const C = [0, 0, 0];
const ramp = (u) => { const x = clamp(u, 0, 1) * 3; const i = Math.min(2, Math.floor(x)); const f = x - i; const a = STOPS[i]; const b = STOPS[i + 1]; C[0] = a[0] + (b[0] - a[0]) * f; C[1] = a[1] + (b[1] - a[1]) * f; C[2] = a[2] + (b[2] - a[2]) * f; return C; };
const rng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const mixInt = (x) => { x = Math.imul(x ^ (x >>> 16), 0x45d2f9b); x = Math.imul(x ^ (x >>> 15), 0x45d2f9b); return (x ^ (x >>> 16)) >>> 0; };

export const FX_ARMS = 3200; const FX_NEB = 44; const RING_R = [1.2, 1.42, 1.62, 1.88, 2.12, 2.4]; const RING_DENS = 105; const N_COMET = 6;
/** Upper bound of decorative particles one frame can push at quality fx (0..1): sized so the scene's particle buffer never overflows. */
export const fxBudget = (fx) => Math.ceil((FX_ARMS + FX_NEB + 1500 + 260) * clamp(fx, 0, 1)) + 80;

let SEED = null;
function seeds() {
  if (SEED) return SEED; const r = rng(0x5eed1);
  const arms = new Float32Array(FX_ARMS * 7); // rr, th0, phase, bright, size, tint, big
  for (let i = 0; i < FX_ARMS; i++) {
    const o = i * 7; const rr = 0.2 + 2.35 * Math.pow(r(), 1.35); const arm = Math.floor(r() * 5); const scat = (r() + r() + r() - 1.5) * 1.3;
    arms[o] = rr; arms[o + 1] = (arm * TAU) / 5 + 2.4 * Math.log(1 + rr * 2.6) + scat * (0.55 / (0.5 + rr)); arms[o + 2] = r() * TAU; arms[o + 3] = r(); arms[o + 4] = r(); arms[o + 5] = r(); arms[o + 6] = r() > 0.965 ? 1 : 0;
  }
  const neb = new Float32Array(FX_NEB * 6); // angle, radius, omega, size, tint, phase
  for (let i = 0; i < FX_NEB; i++) { const o = i * 6; neb[o] = r() * TAU; neb[o + 1] = 0.35 + r() * 2.2; neb[o + 2] = (r() < 0.5 ? -1 : 1) * (0.012 + r() * 0.03); neb[o + 3] = 0.9 + r() * 1.5; neb[o + 4] = r(); neb[o + 5] = r() * TAU; }
  const com = new Float32Array(N_COMET * 5); // period, offset, direction angle, lane (-0.5..0.5), tint
  for (let i = 0; i < N_COMET; i++) { const o = i * 5; com[o] = 8 + r() * 7; com[o + 1] = r(); com[o + 2] = r() * TAU; com[o + 3] = r() - 0.5; com[o + 4] = r(); }
  SEED = { arms, neb, com }; return SEED;
}

/** Glyph brightness boost while the radar sweep passes (filled per node; 0 when the sweep is off). */
export function sweepGlyphs(sc, phi) {
  const nodes = sc.model.nodes; const F = sc.sweepF; if (!F || F.length !== nodes.length) return;
  for (let i = 0; i < nodes.length; i++) { const s = nodes[i].slot; if (!s || phi === null) { F[i] = 0; continue; } const lag = (((phi - s.th) % TAU) + TAU) % TAU; F[i] = lag < 2.6 ? Math.exp(-lag * 2.1) : lag > TAU - 0.08 ? 0.6 : 0; }
}

/**
 * Push the decorative layers. `o` = { pushP, pushL, cx, cy, R, k, W, H }. Returns { phi } (sweep angle or null).
 * Colours are premultiplied-additive, so alphas are kept low: a hundred overlapping dust motes must not wash the disc out.
 */
export function buildFx(sc, o) {
  const { pushP, pushL, cx, cy, R, k, W, H } = o; const calm = sc.calm; const fx = clamp(sc.q.fx ?? 1, 0, 1); if (fx <= 0.01) return { phi: null };
  const T = sc.fxT ?? 0; // Effect clock. It runs only while motion is on (pause stops it, reduced motion never starts it). Cursor effects below use the real clock sc.t.
  const S = seeds(); const ptr = calm ? null : sc.ptr; const zf = clamp(R / 300, 0.6, 2.4); const z = sc.cam.zoom;
  const inV = (x, y, p = 24) => x > -p && x < W + p && y > -p && y < H + p;

  // 1. Nebula: large soft colour clouds drifting around the disc
  const nN = Math.floor(FX_NEB * fx);
  for (let i = 0; i < nN; i++) {
    const q = i * 6; const th = S.neb[q] + T * S.neb[q + 2]; const rad = S.neb[q + 1] * R * (1 + 0.05 * Math.sin(T * 0.13 + S.neb[q + 5])); const x = cx + Math.cos(th) * rad; const y = cy + Math.sin(th) * rad * 0.9;
    const col = ramp(S.neb[q + 4] * 1.05); const size = Math.min(1100, S.neb[q + 3] * R * 0.9); if (!inV(x, y, size * 0.5)) continue;
    const breathe = 0.7 + 0.3 * Math.sin(T * 0.21 + S.neb[q + 5] * 2); pushP(x, y, size, col[0], col[1], col[2], 0.1 * breathe * (0.5 + 0.5 * smooth(0.3, 1.2, S.neb[q + 1])), 1);
  }

  // 2. Dust: five spiral arms that turn slowly; the cursor pushes particles aside
  const nA = Math.floor(FX_ARMS * fx); const A = S.arms; const ps = 0.6 + 0.4 * Math.min(2, zf);
  for (let i = 0; i < nA; i++) {
    const q = i * 7; const rr = A[q]; const ph = A[q + 2];
    const th = A[q + 1] + T * 0.07 + 0.16 * Math.sin(T * 0.11 + ph * 3) * rr; const r = rr * R * (1 + 0.012 * Math.sin(T * 0.4 + ph * 9));
    let x = cx + Math.cos(th) * r; let y = cy + Math.sin(th) * r * (1 - 0.14 * smooth(1, 1.8, rr));
    if (ptr) { const dx = x - ptr.x; const dy = y - ptr.y; const d2 = dx * dx + dy * dy; if (d2 < 22500) { const d = Math.sqrt(d2) + 0.001; const f = (1 - d / 150) ** 2 * 46 / d; x += dx * f; y += dy * f; } }
    if (!inV(x, y)) continue;
    const tw = 0.65 + 0.35 * Math.sin(T * (0.35 + 0.5 * A[q + 3]) + ph);
    const a = (0.22 + 0.55 * A[q + 3]) * tw * (0.3 + 0.7 * smooth(0.95, 1.25, rr)) * (1 - 0.7 * smooth(1.9, 2.6, rr));
    const col = ramp(rr / 2.6 + (A[q + 5] - 0.5) * 0.35); const big = A[q + 6] > 0;
    pushP(x, y, (big ? 3.4 : 1) * (1.8 + A[q + 4] * 3.2) * ps, col[0], col[1], col[2], big ? a * 0.6 : a, big ? 0.3 : 0);
  }

  // 3. Particle rings; a bright wave runs round each ring and neighbouring rings turn in opposite directions
  RING_R.forEach((rad, j) => {
    const n = Math.floor(rad * RING_DENS * fx); const dir = j % 2 ? -1 : 1; const om = dir * (0.05 + 0.025 * j); const kk = 2 + j; const ring = rad * R;
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + T * om; const x = cx + Math.cos(th) * ring; const y = cy + Math.sin(th) * ring; if (!inV(x, y)) continue;
      const w = (0.5 + 0.5 * Math.sin(th * kk - T * 1.1 * dir + j * 1.7)) ** 6; const col = ramp(j / 5 + 0.08 * Math.sin(th * 2 + T * 0.2));
      pushP(x, y, (2 + 3.2 * w) * ps, col[0], col[1], col[2], 0.1 + 0.62 * w, w > 0.5 ? 0.15 : 0);
    }
  });

  // 4. Star-polygon rings. The chords stay outside about 1.2 R so they never cross the glyphs
  [[48, 15, 2.3, 0.021, [0.62, 0.48, 1], 0.1], [36, 10, 1.9, -0.027, [0.3, 0.86, 0.95], 0.085], [60, 6, 1.56, 0.015, [0.95, 0.76, 0.42], 0.07]].forEach(([n, s, rad, om, col, al]) => {
    const rr = rad * R; const pts = []; for (let i = 0; i < n; i++) { const th = (i / n) * TAU + T * om; pts.push(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr * 0.97); }
    const br = 0.8 + 0.2 * Math.sin(T * 0.3 + rad * 4);
    for (let i = 0; i < n; i++) { const j = (i + s) % n; const a = al * br * fx; pushL(pts[i * 2], pts[i * 2 + 1], a, pts[j * 2], pts[j * 2 + 1], a, col[0], col[1], col[2]); }
  });

  // 5. Three rings expand from the core, 7 s apart, and fade out
  if (!calm) for (let w = 0; w < 3; w++) {
    const u = (T / 7 + w / 3) % 1; const rad = R * (0.3 + 2.2 * ease(u)); const a = 0.5 * (1 - u) ** 1.7 * smooth(0, 0.06, u) * fx; if (a < 0.01) continue;
    const col = ramp(0.1 + u * 0.8).slice(); const seg = 96;
    for (let i = 0; i < seg; i++) { const a0 = (i / seg) * TAU; const a1 = ((i + 1) / seg) * TAU; const wob = 1 + 0.012 * Math.sin(a0 * 6 + T * 0.8 + w); const wob1 = 1 + 0.012 * Math.sin(a1 * 6 + T * 0.8 + w); pushL(cx + Math.cos(a0) * rad * wob, cy + Math.sin(a0) * rad * wob, a, cx + Math.cos(a1) * rad * wob1, cy + Math.sin(a1) * rad * wob1, a, col[0], col[1], col[2]); }
  }

  // 6. Core: rays in the empty centre, a spinning ring and a slow glow
  const breath = 0.5 + 0.5 * Math.sin(T * 0.9);
  pushP(cx, cy, R * (0.52 + 0.05 * breath), 1, 0.62, 0.3, 0.16 + 0.05 * breath, 0.6);
  const rays = Math.floor(72 * Math.max(0.4, fx));
  for (let i = 0; i < rays; i++) {
    const th = (i / rays) * TAU + T * 0.05; const hsh = ((mixInt(i * 7919) % 1000) / 1000); const len = R * (0.05 + 0.2 * hsh * hsh) * (0.7 + 0.3 * Math.sin(T * 0.8 + i * 1.3));
    const col = ramp(0.05 + hsh * 0.5); pushL(cx + Math.cos(th) * R * 0.05, cy + Math.sin(th) * R * 0.05, 0.4 * fx, cx + Math.cos(th) * (R * 0.05 + len), cy + Math.sin(th) * (R * 0.05 + len), 0, col[0], col[1], col[2]);
  }
  const nr = Math.floor(48 * Math.max(0.4, fx));
  for (let i = 0; i < nr; i++) { const th = (i / nr) * TAU - T * 0.55; const w = 0.5 + 0.5 * Math.sin(th * 3 + T * 1.4); const col = ramp(0.25 + 0.5 * w); pushP(cx + Math.cos(th) * R * 0.165, cy + Math.sin(th) * R * 0.165, 2.6 + 3 * w, col[0], col[1], col[2], 0.25 + 0.5 * w, 0); }

  // 7. Radar sweep: a fading wedge from the core to the rim; glyphs it just passed get brighter (sweepGlyphs). Off with reduced motion or at low quality
  let phi = null;
  if (!calm && sc.auto && fx >= 0.5) {
    phi = (T * 0.55) % TAU; const r0 = R * 0.27; const r1 = R * 1.0;
    for (let j = 0; j < 26; j++) { const a = phi - j * 0.03; const al = 0.3 * (1 - j / 26) ** 2 * fx; pushL(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, al * 0.4, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, al, 0.78, 0.96, 0.2); }
    pushL(cx + Math.cos(phi) * r0, cy + Math.sin(phi) * r0, 0.2, cx + Math.cos(phi) * r1 * 1.04, cy + Math.sin(phi) * r1 * 1.04, 0.85, 0.92, 1, 0.75);
    for (let j = 0; j < 12; j++) { const rr = r0 + ((r1 - r0) * (j + ((T * 0.9) % 1))) / 12; pushP(cx + Math.cos(phi) * rr, cy + Math.sin(phi) * rr, 9, 0.8, 1, 0.5, 0.35 * (0.4 + 0.6 * (j / 12)), 0); }
  }
  sweepGlyphs(sc, phi);

  // 8. Glow bursts: every 0.7 s three glyphs get a soft halo (small and dim)
  const nodes = sc.model.nodes;
  if (!calm && sc.auto && fx >= 0.5 && nodes.length) {
    const slotLen = 0.7; const s0 = Math.floor(T / slotLen); const ph = T / slotLen - s0;
    for (let b = 0; b < 3; b++) {
      const ni = mixInt(s0 * 3 + b + 17) % nodes.length; const n = nodes[ni]; if (!n.slot || sc.app[ni] < 0.9) continue; const x = cx + n.slot.x * k; const y = cy + n.slot.y * k; if (!inV(x, y)) continue;
      const a = Math.sin(ph * Math.PI) ** 2 * 0.55; pushP(x, y, sc.gsize * k * (2.6 + 1.2 * ph), n.color[0], n.color[1], n.color[2], a, 0.2);
    }
  }

  // 9. Comets cross the stage, each on its own lane and period
  if (!calm && sc.auto && fx >= 0.5) for (let i = 0; i < N_COMET; i++) {
    const q = i * 5; const per = S.com[q]; const u0 = (T / per + S.com[q + 1]) % 1; const vis = 0.55; if (u0 > vis) continue; const u = u0 / vis; const ang = S.com[q + 2];
    const dx = Math.cos(ang); const dy = Math.sin(ang); const diag = Math.hypot(W, H); const nx = -dy; const ny = dx; const lane = S.com[q + 3] * Math.min(W, H) * 0.9;
    const sx = W / 2 - dx * diag * 0.6 + nx * lane; const sy = H / 2 - dy * diag * 0.6 + ny * lane; const col = ramp(0.55 + S.com[q + 4] * 0.45).slice(); const fade = Math.sin(u * Math.PI);
    const hx = sx + dx * diag * 1.2 * u; const hy = sy + dy * diag * 1.2 * u;
    pushL(hx - dx * 150 * zf, hy - dy * 150 * zf, 0, hx, hy, 0.7 * fade, col[0], col[1], col[2]);
    for (let j = 0; j < 14; j++) { const f = j / 14; pushP(hx - dx * j * 11 * zf, hy - dy * j * 11 * zf, (14 - j) * 1.1, col[0], col[1], col[2], 0.7 * fade * (1 - f) ** 1.6, 0); }
    pushP(hx, hy, 11, 1, 1, 1, 0.9 * fade, 0);
  }

  // 10. Cursor: a soft light and a ring of sparks around the pointer
  if (ptr) {
    pushP(ptr.x, ptr.y, 170, 0.45, 0.8, 1, 0.09, 0.8);
    for (let j = 0; j < 10; j++) { const a = T * 1.6 + (j / 10) * TAU; const rr = 26 + 4 * Math.sin(T * 2 + j); const col = ramp(j / 10); pushP(ptr.x + Math.cos(a) * rr, ptr.y + Math.sin(a) * rr, 4.5, col[0], col[1], col[2], 0.55, 0); }
  }
  // 11. Cursor trail and click ripples (real clock; they only appear after the user moves or clicks)
  if (!calm) {
    const now = sc.t;
    for (let q = sc.trail.length - 1; q >= 0; q--) { const p = sc.trail[q]; const u = (now - p.t) / 0.85; if (u >= 1) { sc.trail.splice(q, 1); continue; } const col = ramp(0.35 + u * 0.6); pushP(p.x, p.y, 13 * (1 - u) + 3, col[0], col[1], col[2], 0.5 * (1 - u) ** 1.6, 0.1); }
    for (let q = sc.ripples.length - 1; q >= 0; q--) {
      const rp = sc.ripples[q]; const u = (now - rp.t0) / 1.25; if (u >= 1) { sc.ripples.splice(q, 1); continue; }
      const rad = 24 + 300 * ease(u); const a = 0.75 * (1 - u) ** 1.5; const col = ramp(0.2 + u * 0.7).slice(); const seg = 60;
      for (let i = 0; i < seg; i++) { const a0 = (i / seg) * TAU; const a1 = ((i + 1) / seg) * TAU; pushL(rp.x + Math.cos(a0) * rad, rp.y + Math.sin(a0) * rad, a, rp.x + Math.cos(a1) * rad, rp.y + Math.sin(a1) * rad, a, col[0], col[1], col[2]); }
      for (let i = 0; i < 18; i++) { const a0 = (i / 18) * TAU + rp.t0; pushP(rp.x + Math.cos(a0) * rad * 1.04, rp.y + Math.sin(a0) * rad * 1.04, 6 * (1 - u) + 2, col[0], col[1], col[2], a, 0); }
    }
  }
  void z;
  return { phi };
}
