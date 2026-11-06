// DATA-BEARING animated relations for the glyph disc. Unlike fx-disc.js (pure ornament), everything here is computed from the stored model:
//  1. source -> topic ribbons: one per (source, primary topic) pair that really has records; thickness/brightness = record count; dots flow source -> topic and pop where they land.
//  2. ambient provenance tour: the scene steps through REAL stored records (round-robin over sources, most relevant first) and pops a card: which source it came from, which topic it sits in.
//     It is a tour of stored data, NOT a live event feed (live arrivals use the separate spark beams), and the legend says so.
//  3. focus web: hover/pin a glyph -> its source and every stored opportunity link (colour = relation) light up with flowing dots; hover a source -> a ripple floods its records and its ribbons
//     brighten with counts; hover a topic -> its records converge on the rim and the sources feeding it light up.
// Output: GL particles/lines through o.pushP / o.pushL, node brightness in sc.flowF, and overlay descriptions in sc.ov.pops / sc.ov.tags (drawn by overlay-flow.js).
import { srcShort } from '../_evidence-parts.jsx';
import { WELLS } from './data.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - (1 - t) ** 3;
export const TOUR_LIFE = 3.6; const TOUR_GAP = 2.1;
const REL = { contradicts: [1, 0.416, 0.239], competitor: [0.949, 0.722, 0.294], usage: [0.776, 0.957, 0.196], supports: [0.55, 0.92, 0.72], tag: [0.82, 0.82, 0.76] };
const mixInt = (x) => { x = Math.imul(x ^ (x >>> 16), 0x45d2f9b); x = Math.imul(x ^ (x >>> 15), 0x45d2f9b); return (x ^ (x >>> 16)) >>> 0; };
export const flowBudget = (fx) => Math.ceil(2600 * clamp(fx, 0, 1)) + 160;

const bow = (ax, ay, bx, by, ox, oy, amt) => { // quadratic control point, bowed away from (ox,oy)
  const mx = (ax + bx) / 2; const my = (ay + by) / 2; let nx = -(by - ay); let ny = bx - ax; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; if (nx * (mx - ox) + ny * (my - oy) < 0) { nx = -nx; ny = -ny; }
  const d = Math.hypot(bx - ax, by - ay); return [mx + nx * d * amt, my + ny * d * amt];
};
const qx = (p0, c, p1, u) => (1 - u) * (1 - u) * p0 + 2 * (1 - u) * u * c + u * u * p1;

export function buildFlow(sc, o) {
  const { pushP, pushL, cx, cy, R, k, W, H } = o; const m = sc.model; const ov = sc.ov; const calm = sc.calm; const fx = clamp(sc.q.fx ?? 1, 0, 1); const nodes = m.nodes; const N = nodes.length;
  ov.pops = []; ov.tags = []; if (sc.flowF.length !== N) return; sc.flowF.fill(0); if (fx <= 0.05 || !ov.sats) return;
  const T = sc.fxT ?? 0; const real = sc.t; const sats = ov.sats; const fk = sc.hover ?? sc.pinned ?? sc.focus; const intro = sc.intro;
  const key = fk ? `${fk.t}:${fk.i}` : ''; if (sc.fkKey !== key) { sc.fkKey = key; sc.fkT = real; } const fage = calm ? 1 : clamp((real - sc.fkT) / 0.5, 0, 1); const pop = ease(fage);
  const fNode = fk?.t === 'ev' ? fk.i : -1; const fSec = fk?.t === 'well' ? fk.i : -1; const fSrc = fk?.t === 'src' ? fk.i : -1;
  const anchorAng = (w, s) => { const sec = sc.sectors[w]; if (!sec) return null; const span = sec.a1 - sec.a0; return clamp(sec.mid + (s - (m.sources.length - 1) / 2) * 0.03, sec.a0 + span * 0.08, sec.a1 - span * 0.08); };
  const anchor = (w, s = 4) => { const a = anchorAng(w, s); return a === null ? null : [cx + Math.cos(a) * R * 1.075, cy + Math.sin(a) * R * 1.075]; };
  const strip = (p0, c, p1, segs, a0, a1, col) => { let px = p0[0]; let py = p0[1]; for (let i = 1; i <= segs; i++) { const u = i / segs; const x = qx(p0[0], c[0], p1[0], u); const y = qx(p0[1], c[1], p1[1], u); pushL(px, py, a0 + (a1 - a0) * ((i - 1) / segs), x, y, a0 + (a1 - a0) * u, col[0], col[1], col[2]); px = x; py = y; } };
  const dots = (p0, c, p1, n, speed, off, size, col, a, arrive) => {
    for (let i = 0; i < n; i++) {
      const u = (T * speed + i / n + off) % 1; const x = qx(p0[0], c[0], p1[0], u); const y = qx(p0[1], c[1], p1[1], u); const f = Math.sin(u * Math.PI);
      pushP(x, y, size * (0.6 + 0.8 * f), col[0], col[1], col[2], a * f, 0);
      if (arrive && u > 0.9) { const v = (u - 0.9) / 0.1; pushP(p1[0], p1[1], 10 + 34 * v, col[0], col[1], col[2], a * 0.45 * (1 - v), 0.3); } // the dot "lands": a soft pop on the topic rim
    }
  };
  const srcCol = (s) => sc.srcColors?.[s] ?? [0.8, 0.8, 0.8];
  const srcName = (s) => srcShort(m.sources[s]?.id ?? '');

  // ---- 1. source -> topic ribbons (stored counts)
  const pairs = sc.flowPairs ?? []; const max = sc.flowMax || 1;
  for (const pr of pairs) {
    const sat = sats[pr.s]; const A = anchor(pr.w, pr.s); if (!sat || !A) continue; const off = sc.filter.srcOff.has(m.sources[pr.s]?.id) || sc.filter.topicOff.has(WELLS[pr.w]);
    let boost = 1; const isNodePair = fNode >= 0 && nodes[fNode].src === pr.s && nodes[fNode].primary === pr.w;
    if (fSrc >= 0) boost = pr.s === fSrc ? 3.4 : 0.22; else if (fSec >= 0) boost = pr.w === fSec ? 3.4 : 0.22; else if (fNode >= 0) boost = isNodePair ? 3.4 : 0.3;
    const wgt = (pr.c / max) ** 0.6; const col = srcCol(pr.s); const a = (0.13 + 0.38 * wgt) * boost * (off ? 0.2 : 1) * intro * (0.6 + 0.4 * fx); const S0 = [sat.x, sat.y]; const C = bow(sat.x, sat.y, A[0], A[1], cx, cy, 0.24);
    strip(S0, C, A, 18, a * 0.45, a, col);
    if (!off) { const nb = Math.max(8, Math.round((10 + 26 * wgt) * fx)); for (let i = 0; i < nb; i++) { const u = (i + 0.5) / nb; const f = 0.35 + 0.65 * u; pushP(qx(S0[0], C[0], A[0], u), qx(S0[1], C[1], A[1], u), 3 + 5 * wgt, col[0], col[1], col[2], a * 0.55 * f, 0.1); } } // glowing body of the ribbon
    if (!off) dots(S0, C, A, Math.max(2, Math.round((2 + 9 * wgt) * fx)), 0.13 + 0.05 * ((mixInt(pr.s * 31 + pr.w) % 100) / 100), (mixInt(pr.s * 7 + pr.w * 13) % 100) / 100, 5 + 6 * wgt, col, 0.95 * Math.min(1.4, boost), true);
    if (boost > 1.5 && (fSrc >= 0 || fSec >= 0) && !off) ov.tags.push({ x: A[0], y: A[1], text: fSrc >= 0 ? `+${pr.c} ${m.wells[pr.w].label}` : `${srcName(pr.s)} ${pr.c}`, col, pop, side: Math.cos(anchorAng(pr.w, pr.s)) >= 0 ? 1 : -1, ang: anchorAng(pr.w, pr.s) });
  }

  // ---- 2. ambient provenance tour (real stored records, round-robin over sources)
  const F = sc.flow ?? (sc.flow = { tours: [], next: 1.4, seq: 0, order: null, model: null });
  if (F.model !== m) { // order: for every source its records by relevance desc then recency, then interleave sources so small ones (Bluesky, Mastodon, Farcaster...) appear as often as GitHub
    const per = m.sources.map(() => []); nodes.forEach((n, i) => { if (n.slot) per[n.src]?.push(i); }); per.forEach((l) => l.sort((a, b) => nodes[b].rel - nodes[a].rel || nodes[b].p - nodes[a].p)); const order = []; for (let r = 0; r < 40; r++) for (const l of per) if (l[r] !== undefined) order.push(l[r]); F.order = order; F.model = m; F.tours.length = 0;
  }
  const focusing = Boolean(fk); const calmTour = calm && !F.tours.length;
  if (!calm && sc.auto && !focusing && fx >= 0.4 && F.order.length && T >= F.next && F.tours.length < 2) {
    for (let tries = 0; tries < 12; tries++) { const ni = F.order[F.seq++ % F.order.length]; if (sc.app[ni] > 0.9 && sc.vis[ni] > 0.5 && !F.tours.some((x) => x.ni === ni)) { F.tours.push({ ni, t0: T }); break; } }
    F.next = T + TOUR_GAP;
  }
  if (calmTour && F.order.length && sc.app[F.order[0]] > 0.9) F.tours.push({ ni: F.order[0], t0: -0.4 + 1.4, static: true }); // reduced motion: one fixed provenance card so the idea is still shown
  for (let q = F.tours.length - 1; q >= 0; q--) {
    const tr = F.tours[q]; const age = tr.static ? 1.6 : T - tr.t0; if (age > TOUR_LIFE) { F.tours.splice(q, 1); continue; }
    const n = nodes[tr.ni]; const sat = sats[n.src]; if (!n.slot || !sat) continue; const g = [cx + n.slot.x * k, cy + n.slot.y * k]; const col = srcCol(n.src); const fade = (age > TOUR_LIFE - 0.6 ? (TOUR_LIFE - age) / 0.6 : 1) * (focusing ? 1 - fage : 1); // a hover/pin takes over the stage: the tour fades out
    if (fade <= 0.01) continue;
    const u = clamp(age / 0.55, 0, 1); const e = ease(u); const e0 = ease(Math.max(0, u - 0.35)); const hx = sat.x + (g[0] - sat.x) * e; const hy = sat.y + (g[1] - sat.y) * e;
    if (u < 1) { pushL(sat.x + (g[0] - sat.x) * e0, sat.y + (g[1] - sat.y) * e0, 0, hx, hy, 1, col[0], col[1], col[2]); pushP(hx, hy, 20, col[0], col[1], col[2], 0.95, 0); pushP(sat.x, sat.y, 40 * (1 - u * 0.5), col[0], col[1], col[2], 0.5 * (1 - u), 0.2); }
    else {
      const v = clamp((age - 0.55) / 0.7, 0, 1); if (v < 1) pushP(g[0], g[1], sc.gsize * k * (2 + 6 * ease(v)), 1, 0.95, 0.75, 0.7 * (1 - v), 0.3);
      sc.flowF[tr.ni] = Math.max(sc.flowF[tr.ni], clamp(1.4 * (1 - (age - 0.55) / 3.1), 0, 1) * fade);
      if (age > 0.9) { const A = anchor(n.primary, n.src); if (A) { const C = bow(g[0], g[1], A[0], A[1], cx, cy, 0.22); const aa = 0.5 * fade * clamp((age - 0.9) / 0.4, 0, 1); strip(g, C, A, 14, aa, aa * 0.4, col); const du = ((age - 0.9) * 0.9) % 1; pushP(qx(g[0], C[0], A[0], du), qx(g[1], C[1], A[1], du), 9, col[0], col[1], col[2], 0.85 * fade * Math.sin(du * Math.PI), 0); } }
    }
    ov.pops.push({ ni: tr.ni, age, fade, gx: g[0], gy: g[1], sx: sat.x, sy: sat.y, col, src: n.src, w: n.primary });
  }

  // ---- 3. focus web
  const flood = (s, fe) => { // a ripple leaves the satellite and lights its records as the wavefront crosses them
    const sat = sats[s]; if (!sat) return; const col = srcCol(s); const front = fe * 950; let cnt = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i]; if (n.src !== s || !n.slot || sc.app[i] < 0.5) continue; const gx = cx + n.slot.x * k; const gy = cy + n.slot.y * k; const d = Math.hypot(gx - sat.x, gy - sat.y); const f = Math.exp(-(((d - front) / 90) ** 2)) + (d < front ? 0.35 : 0);
      sc.flowF[i] = Math.max(sc.flowF[i], clamp(f, 0, 1)); if (f > 0.05 && cnt++ < 260) pushL(sat.x, sat.y, 0.02 * f, gx, gy, 0.5 * f, col[0], col[1], col[2]);
    }
  };
  if (fSrc >= 0) { flood(fSrc, clamp((real - sc.fkT) / 1.1, 0, 1.6)); const sat = sats[fSrc]; if (sat) { const col = srcCol(fSrc); const e = ((real - sc.fkT) * 1.4) % 1; pushP(sat.x, sat.y, 30 + 140 * e, col[0], col[1], col[2], 0.35 * (1 - e), 0.4); ov.tags.push({ x: sat.x, y: sat.y, text: `${srcName(fSrc)} · ${sc.stats.src[fSrc]} records`, col, pop, side: 0, head: true }); } }
  if (fSec >= 0) {
    const sec = sc.sectors[fSec]; const col = [0.95, 0.9, 0.7]; const A = anchor(fSec); let cnt = 0;
    if (sec && A) for (let i = 0; i < N; i++) { const n = nodes[i]; if (n.primary !== fSec || !n.slot || sc.app[i] < 0.5) continue; const g = [cx + n.slot.x * k, cy + n.slot.y * k]; const sc2 = srcCol(n.src); sc.flowF[i] = Math.max(sc.flowF[i], 0.55 + 0.4 * Math.sin(T * 2 + i)); if (cnt++ < 160) { const C = bow(g[0], g[1], A[0], A[1], cx, cy, 0.18); strip(g, C, A, 8, 0.0, 0.2 * pop, sc2); const du = (T * 0.4 + (mixInt(i) % 100) / 100) % 1; pushP(qx(g[0], C[0], A[0], du), qx(g[1], C[1], A[1], du), 5, sc2[0], sc2[1], sc2[2], 0.7 * Math.sin(du * Math.PI) * pop, 0); } }
    if (A) { const e = (real * 1.2) % 1; pushP(A[0], A[1], 20 + 90 * e, col[0], col[1], col[2], 0.3 * (1 - e), 0.4); }
  }
  if (fNode >= 0) {
    const n = nodes[fNode]; if (n.slot) {
      const g = [cx + n.slot.x * k, cy + n.slot.y * k]; sc.flowF[fNode] = Math.max(sc.flowF[fNode], 0.9); const sat = sats[n.src]; const col = srcCol(n.src);
      if (sat) { const C = bow(sat.x, sat.y, g[0], g[1], cx, cy, 0.12); strip([sat.x, sat.y], C, g, 16, 0.05 * pop, 0.85 * pop, col); dots([sat.x, sat.y], C, g, 5, 0.35, 0, 7, col, 0.95 * pop, false); ov.tags.push({ x: sat.x, y: sat.y, text: `FROM ${srcName(n.src)}`, col, pop, side: 0, head: true }); }
      n.wells.forEach((l, j) => {
        const A = anchor(l.w, n.src); if (!A) return; const rc = REL[l.rel] ?? REL.tag; const C = bow(g[0], g[1], A[0], A[1], cx, cy, 0.2 + 0.05 * j);
        strip(g, C, A, 16, 0.85 * pop, 0.3 * pop, rc); dots(g, C, A, 5, 0.3, j * 0.17, 7, rc, 0.95 * pop, true);
        ov.tags.push({ x: A[0], y: A[1], text: `${m.wells[l.w].label}${l.rel !== 'tag' ? ` · ${l.rel}` : ' · tag'}`, col: rc, pop, side: Math.cos(anchorAng(l.w, n.src)) >= 0 ? 1 : -1, ang: anchorAng(l.w, n.src) });
      });
    }
  }
}
