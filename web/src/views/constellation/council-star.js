// The Council star: the second body in the constellation. A cyberpunk wireframe star with seven seats (the seven research roles) on a ring, a score gauge ring, and one crystal per opportunity
// orbiting outside. The evidence star sends "summary streams" to the crystals; the seats fire into the core; the verdict leaves along the launch lane (research -> build -> decision -> approve -> deploy -> verify).
// DATA that is real: seat support + reasons, weighted support, verdict, momentum, which crystal is the winner, the lane's stage states (from /api/council). The bolts, streams and pulses REPLAY those stored votes and
// that stored journey as an illustration; they are not live events. Only the stage colours (from stored runs/decisions/deployments) change with real activity.
import { PSTRIDE, LSTRIDE } from './scene.js'; // eslint-disable-line no-unused-vars

const TAU = Math.PI * 2; const DD = 2100; const C0 = 230;
const CYAN = [0.15, 0.9, 1]; const MAG = [1, 0.22, 0.78]; const VIO = [0.56, 0.32, 1]; const WHITE = [1, 0.97, 1];
const VERD = { go: [0.78, 0.96, 0.2], watch: [0.97, 0.72, 0.3], drop: [0.55, 0.57, 0.6] };
const STANCE = { back: [0.35, 1, 0.82], abstain: [0.97, 0.72, 0.3], object: [1, 0.25, 0.5] };
export const SEAT_NAMES = ['Collector', 'Analyst', 'Skeptic', 'Architect', 'Builder', 'Security', 'Planner'];
const CYCLE = 14;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mat = (yaw, pit) => { const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pit); const sp = Math.sin(pit); return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy]; };
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function icosphere(sub = 2) {
  const t = (1 + Math.sqrt(5)) / 2; const nm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(nm);
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(); const mid = (a, b) => { const key = a < b ? `${a}_${b}` : `${b}_${a}`; if (cache.has(key)) return cache.get(key); V.push(nm(V[a].map((x, i) => (x + V[b][i]) / 2))); cache.set(key, V.length - 1); return V.length - 1; };
    const G = []; for (const [a, b, c] of F) { const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a); G.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); } F = G;
  }
  const E = new Set(); for (const [a, b, c] of F) for (const [x, y] of [[a, b], [b, c], [c, a]]) E.add(x < y ? `${x}_${y}` : `${y}_${x}`);
  return { V, E: [...E].map((e) => e.split('_').map(Number)) };
}

/** The opportunity the star is voting on: the one the journey follows, else the winner, else the first. */
export function focusEntry(d) { const c = d?.council; if (!c) return null; return c.opportunities.find((o) => o.oppId === d.journey?.oppId) ?? c.opportunities.find((o) => o.oppId === c.winner) ?? c.opportunities[0] ?? null; }

export class CouncilStar {
  constructor() {
    this.cam = { yaw: 0.5, tyaw: 0.5, pit: 0.38, tpit: 0.38, vyaw: 0, vpit: 0, zoom: 1, tzoom: 1 }; this.spin = 0; this.spinV = 1;
    this.geo = icosphere(2); this.data = null; this.seats = []; this.cry = []; this.flash = []; this.view = null; this.O = new Float64Array(3); this.lane = []; this.bursts = [];
  }
  setData(d) { this.data = d; }
  get entry() { return focusEntry(this.data); }
  drag(dx, dy) { const c = this.cam; c.tyaw += dx * 0.0072; c.tpit = clamp(c.tpit + dy * 0.0072, -1.2, 1.2); c.vyaw = c.vyaw * 0.5 + dx * 0.0072 * 30; c.vpit = c.vpit * 0.5 + dy * 0.0072 * 30; }
  step(dt, calm, dragging, hovering) {
    const c = this.cam; if (!dragging && !calm) { c.tyaw += c.vyaw * dt; c.tpit = clamp(c.tpit + c.vpit * dt, -1.2, 1.2); }
    if (!dragging) { const d = Math.exp(-dt * 2.8); c.vyaw *= d; c.vpit *= d; }
    const k = calm ? 1 : 1 - Math.exp(-dt * 10); c.yaw += (c.tyaw - c.yaw) * k; c.pit += (c.tpit - c.pit) * k; c.zoom += (c.tzoom - c.zoom) * k;
    this.spinV += ((hovering ? 0.15 : 1) - this.spinV) * (1 - Math.exp(-dt * 3)); if (!calm && !dragging) this.spin += dt * 0.11 * this.spinV;
  }

  /** f: { pushP, pushL, cx, cy, k, W, H, T, calm, main, fade, hot } -> fills this.seats / this.cry / this.lane (screen positions) for picking and labels. */
  build(f) {
    const { pushP, pushL, cx, cy, k, W, H, T, calm, main, fade } = f; const O = this.O; const e = this.entry; const votes = e?.votes ?? []; const S = e?.support ?? 0; const verdict = e?.verdict ?? 'watch'; const vc = VERD[verdict];
    const M = mat(this.cam.yaw + this.spin, this.cam.pit); const MW = mat(this.cam.yaw, this.cam.pit);
    const xf = (m, x, y, z) => { O[0] = m[0] * x + m[1] * y + m[2] * z; O[1] = m[3] * x + m[4] * y + m[5] * z; O[2] = m[6] * x + m[7] * y + m[8] * z; };
    const P = (z) => DD / (DD - z); const R = C0 * k; this.view = { cx, cy, R, main };
    const cyc = calm ? CYCLE - 0.5 : T % CYCLE; const fired = (i) => cyc >= 1.4 + i * 1.05; const sinceFire = (i) => cyc - (1.4 + i * 1.05);
    let partial = 0; votes.forEach((v, i) => { if (fired(i)) partial += v.weight * v.support; });
    const gaugeS = calm ? S : partial; const pulse = calm ? 0.5 : 0.5 + 0.5 * Math.sin(T * 2.2);

    // ---- aura (cyberpunk haze: violet outer, magenta inner) + core, brightness follows the weighted support
    pushP(cx, cy, R * 4.2, VIO[0], VIO[1], VIO[2], 0.13 * fade, 0.5); pushP(cx, cy, R * 2.6, MAG[0], MAG[1], MAG[2], 0.1 * fade, 0.5);
    pushP(cx, cy, R * (1.1 + 0.5 * gaugeS + 0.06 * pulse), MAG[0], 0.3, 0.9, (0.3 + 0.2 * gaugeS) * fade, 0.3); pushP(cx, cy, R * 0.34, 1, 0.8, 1, 0.55 * fade, 0);

    // ---- wireframe star: icosphere edges, cyan to magenta by height, with data-flicker travelling over the edges
    const { V, E } = this.geo; const px = new Float32Array(V.length); const py = new Float32Array(V.length); const pz = new Float32Array(V.length); const R3 = C0 * 0.78;
    for (let i = 0; i < V.length; i++) { xf(M, V[i][0] * R3, V[i][1] * R3, V[i][2] * R3); const s = P(O[2]); px[i] = cx + O[0] * s * k; py[i] = cy - O[1] * s * k; pz[i] = O[2] / R3; }
    for (let q = 0; q < E.length; q++) {
      const [a, b] = E[q]; const zf = (pz[a] + pz[b]) * 0.5; const yy = (V[a][1] + V[b][1]) * 0.5; const col = mix(CYAN, MAG, clamp(0.5 + 0.55 * yy + 0.2 * Math.sin(T * 0.6 + q * 0.05), 0, 1));
      const flick = calm ? 0 : Math.max(0, Math.sin(T * 1.8 - (V[a][1] + V[a][0]) * 3.2 + q * 0.02)) ** 14; const al = (zf > 0 ? 0.2 + 0.16 * zf : 0.06) * (1 + 3.2 * flick) * fade;
      pushL(px[a], py[a], al, px[b], py[b], al, col[0], col[1], col[2]);
    }
    for (let i = 0; i < V.length; i += 1) { if (pz[i] < -0.1 && (i & 1)) continue; const w = calm ? 0 : Math.max(0, Math.sin(T * 1.5 - V[i][1] * 4)) ** 6; pushP(px[i], py[i], (2.2 + 4 * w) * (0.7 + k * 1.4), CYAN[0], CYAN[1], CYAN[2], (pz[i] > 0 ? 0.55 : 0.12) * (0.6 + 0.8 * w) * fade, 0.1); }

    // ---- gauge ring: 72 ticks around the star; the filled part is the weighted support, white marks are the watch / go thresholds
    { const rg = C0 * 1.42; const tl = -0.32; const rules = this.data?.council?.rules ?? { watchAt: 0.48, goAt: 0.62 }; const n = 72;
      for (let q = 0; q < n; q++) {
        const th = (q / n) * TAU; const fill = q / n < gaugeS; const mk = [rules.watchAt, rules.goAt].some((r) => Math.abs(q / n - r) < 0.5 / n); const l0 = rg; const l1 = rg * (mk ? 1.1 : fill ? 1.06 : 1.03);
        const ca = Math.cos(th); const sa = Math.sin(th); const p = (rr) => { xf(MW, rr * ca, -Math.sin(tl) * rr * sa, Math.cos(tl) * rr * sa); return [cx + O[0] * P(O[2]) * k, cy - O[1] * P(O[2]) * k, O[2]]; };
        const a = p(l0); const b = p(l1); const col = mk ? WHITE : fill ? vc : VIO; const al = (mk ? 0.8 : fill ? 0.85 : 0.2) * (a[2] > 0 ? 1 : 0.35) * fade; pushL(a[0], a[1], al, b[0], b[1], al, col[0], col[1], col[2]);
        if (fill && q === Math.floor(gaugeS * n) - 1) pushP(b[0], b[1], 14, vc[0], vc[1], vc[2], 0.7 * fade, 0.1);
      } }

    // ---- seat ring + seats: seven beacons on a tilted ring. Each fires a bolt into the core when its stored vote is replayed.
    { const rs = C0 * 1.12; const tl = 0.5; let ppx = 0; let ppy = 0; let ppa = 0;
      for (let q = 0; q <= 72; q++) { const th = (q / 72) * TAU; xf(MW, rs * Math.cos(th), -Math.sin(tl) * rs * Math.sin(th), Math.cos(tl) * rs * Math.sin(th)); const s = P(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const a = 0.18 * (O[2] > 0 ? 1 : 0.4) * fade; if (q) pushL(ppx, ppy, ppa, x, y, a, CYAN[0], CYAN[1], CYAN[2]); ppx = x; ppy = y; ppa = a; }
      this.seats = SEAT_NAMES.map((name, i) => {
        const th = (i / 7) * TAU + (calm ? 0.3 : T * 0.07); xf(MW, rs * Math.cos(th), -Math.sin(tl) * rs * Math.sin(th), Math.cos(tl) * rs * Math.sin(th)); const s = P(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const z = O[2];
        const v = votes[i]; const lit = Boolean(v) && fired(i); const col = lit ? STANCE[v.stance] : VIO; const fl = lit && !calm ? Math.max(0, 1 - sinceFire(i) / 0.7) : 0;
        pushP(x, y, (16 + 26 * fl) * (0.6 + k * 1.1) * s, col[0], col[1], col[2], (lit ? 0.8 : 0.35) * (z > 0 ? 1 : 0.45) * fade, 0.1); pushP(x, y, 6, 1, 1, 1, (lit ? 0.95 : 0.4) * (z > 0 ? 1 : 0.4) * fade, 0);
        if (lit && fl > 0) { // bolt: jagged line seat -> core, re-rolled ~14 times a second
          const seed = Math.floor(T * 14) * 7 + i * 13; let bx = x; let by = y; const n = 7; const dx = cx - x; const dy = cy - y; const dl = Math.hypot(dx, dy) || 1; const nx = -dy / dl; const ny = dx / dl;
          for (let j = 1; j <= n; j++) { const u = j / n; const off = j === n ? 0 : (hash(seed + j) - 0.5) * 26 * (1 - u * 0.4); const tx = x + dx * u + nx * off; const ty = y + dy * u + ny * off; pushL(bx, by, fl, tx, ty, fl, col[0], col[1], col[2]); pushL(bx, by, fl * 0.5, tx, ty, fl * 0.5, 1, 1, 1); bx = tx; by = ty; }
          pushP(cx, cy, R * 0.9 * fl + 12, col[0], col[1], col[2], 0.35 * fl * fade, 0.3);
        }
        return { i, x, y, z, name, vote: v, lit, r: 14 };
      }); }

    // ---- crystals: one per opportunity, orbiting outside the gauge; the winner burns brighter and carries the "waiting" beam
    { const list = this.data?.council?.opportunities ?? []; const rc = C0 * 1.9; const win = this.data?.council?.winner; this.cry = list.map((o, i) => {
      const th = (i / Math.max(1, list.length)) * TAU + (calm ? 0.2 : T * 0.045); const inc = 0.22 + 0.06 * Math.sin(i * 1.7); xf(MW, rc * Math.cos(th), Math.sin(inc) * rc * Math.sin(th) * 0.8, Math.cos(inc) * rc * Math.sin(th)); const s = P(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const z = O[2];
      const col = VERD[o.verdict]; const isW = o.oppId === win; const hit = this.flash[i] ? Math.max(0, 1 - (T - this.flash[i]) / 0.9) : 0; const sz = (8 + 12 * o.support + (isW ? 6 : 0) + 14 * hit) * (0.6 + k * 0.9) * s;
      pushP(x, y, sz * 2.4, col[0], col[1], col[2], (isW ? 0.5 : 0.3) * (z > 0 ? 1 : 0.5) * fade, 0.5); pushP(x, y, sz, col[0], col[1], col[2], (z > 0 ? 0.95 : 0.45) * fade, 0.08);
      const d = sz * 0.9; const al = 0.7 * (z > 0 ? 1 : 0.4) * fade; pushL(x - d, y, al, x + d, y, al, col[0], col[1], col[2]); pushL(x, y - d, al, x, y + d, al, col[0], col[1], col[2]); // four-point crystal glint
      if (isW && !calm) { const b = (T * 0.8) % 1; pushP(x, y - b * 46 * (0.5 + k), 5, col[0], col[1], col[2], 0.8 * (1 - b) * fade, 0.1); }
      return { i, x, y, z, o, win: isW, r: Math.max(9, sz * 0.9) };
    }); }

    // ---- verdict burst: when the replay reaches the end the star shockwaves in the verdict colour
    if (!calm) { const tb = cyc - 10.3; if (tb > 0 && tb < 1.6) { const u = tb / 1.6; const rr = R * (0.9 + 2.2 * u); const a = 0.8 * (1 - u) * fade; let ax = cx + rr; let ay = cy; for (let q = 1; q <= 40; q++) { const th = (q / 40) * TAU; const bx = cx + Math.cos(th) * rr; const by = cy + Math.sin(th) * rr * 0.9; pushL(ax, ay, a, bx, by, a, vc[0], vc[1], vc[2]); ax = bx; ay = by; } } }

    // ---- launch lane (main view only): verdict -> research -> build -> decision -> approve -> deploy -> verify, coloured from the stored journey
    this.lane = [];
    if (main && fade > 0.4) {
      const st = this.data?.journey?.stages ?? []; const nodes = [{ label: 'Verdict', state: e ? 'done' : 'todo', detail: e ? verdict.toUpperCase() : '' }, ...st]; const y = Math.min(H - (W < 640 ? 160 : 118), cy + R * 2.05); const x0 = W * 0.14; const x1 = W * 0.86; const n = nodes.length;
      const col = (s) => (s === 'done' ? [0.78, 0.96, 0.2] : s === 'active' ? [0.97, 0.72, 0.3] : s === 'blocked' ? [1, 0.25, 0.5] : [0.42, 0.45, 0.5]);
      for (let i = 0; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / (n - 1); const c = col(nodes[i].state); const act = nodes[i].state === 'active';
        if (i) { const pc = col(nodes[i - 1].state); const pxn = x0 + ((x1 - x0) * (i - 1)) / (n - 1); const al = nodes[i].state === 'todo' ? 0.16 : 0.6; pushL(pxn + 14, y, al, x - 14, y, al, pc[0], pc[1], pc[2]); pushL(pxn + 14, y + 1, al * 0.5, x - 14, y + 1, al * 0.5, 1, 1, 1); }
        pushP(x, y, (act ? 40 + 10 * pulse : 28), c[0], c[1], c[2], nodes[i].state === 'todo' ? 0.3 : 0.7, 0.2); pushP(x, y, 8, 1, 1, 1, nodes[i].state === 'todo' ? 0.4 : 0.95, 0);
        this.lane.push({ x, y, ...nodes[i] });
      }
      if (!calm && e) { const first = nodes.findIndex((nd, i) => i && nd.state !== 'done'); const end = first < 0 ? n - 1 : Math.max(0, first - 1 + (verdict === 'go' ? 1 : 0)); const u = clamp((cyc - 10.4) / 3, 0, 1); if (cyc > 10.4 && end > 0) { const xx = x0 + ((x1 - x0) * end * u) / (n - 1); pushP(xx, y, 22, vc[0], vc[1], vc[2], 0.9 * (1 - u * 0.4), 0.1); pushL(xx - 60 * u, y, 0, xx, y, 0.9, vc[0], vc[1], vc[2]); } }
      // feeder from the star to the verdict node
      const x = this.lane[0]?.x ?? cx; pushL(cx, cy + R * 0.82, 0.5 * fade, x, y - 8, 0.35 * fade, vc[0], vc[1], vc[2]);
    }
    this.cycle = cyc; this.verdict = verdict; this.partial = gaugeS;
  }

  /** Called by the scene when a summary packet lands on a crystal. */
  hit(i, T) { this.flash[i] = T; }

  pick(x, y, touch) {
    const slop = touch ? 10 : 3;
    for (const s of this.seats) if ((s.x - x) ** 2 + (s.y - y) ** 2 < (s.r + slop) ** 2 && s.z > -40) return { t: 'seat', i: s.i };
    for (const c of this.cry) if ((c.x - x) ** 2 + (c.y - y) ** 2 < (c.r + slop) ** 2) return { t: 'prod', i: c.i };
    return null;
  }
  screenOf(key) { if (key.t === 'seat') { const s = this.seats[key.i]; return s ? { x: s.x, y: s.y, r: 14 } : null; } const c = this.cry[key.i]; return c ? { x: c.x, y: c.y, r: c.r } : null; }
}
