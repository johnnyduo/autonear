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
export const OUT = { shipped: [0.78, 0.96, 0.2], live: [0.4, 1, 0.8], failed: [1, 0.25, 0.5], held: [0.97, 0.72, 0.3], waiting: [0.5, 0.85, 1], in_progress: [0.97, 0.72, 0.3], ready: [0.78, 0.96, 0.2], not_started: [0.55, 0.57, 0.6] };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const px0 = (O, cx, s, k) => cx + O[0] * s * k; const py0 = (O, cy, s, k) => cy - O[1] * s * k;
const mat = (yaw, pit) => { const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pit); const sp = Math.sin(pit); return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy]; };
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** Points on a sphere (golden spiral) with a size tier each: 0 = tiny pixel square, 1 = small dot, 2 = medium dot, 3 = large glowing dot. */
function dotSphere(n, seed) {
  const out = new Float32Array(n * 5); let r = seed; const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  for (let i = 0; i < n; i++) { const y = 1 - ((i + 0.5) / n) * 2; const rr = Math.sqrt(1 - y * y); const ph = i * 2.399963229728653; const u = rnd(); out.set([rr * Math.cos(ph), y, rr * Math.sin(ph), u < 0.5 ? 0 : u < 0.8 ? 1 : u < 0.955 ? 2 : 3, rnd() * 6.28], i * 5); }
  return out;
}

/** The opportunity the star is voting on: the one the journey follows, else the winner, else the first. */
export function focusEntry(d) { const c = d?.council; if (!c) return null; return c.opportunities.find((o) => o.oppId === d.journey?.oppId) ?? c.opportunities.find((o) => o.oppId === c.winner) ?? c.opportunities[0] ?? null; }

export class CouncilStar {
  constructor() {
    this.cam = { yaw: 0.5, tyaw: 0.5, pit: 0.38, tpit: 0.38, vyaw: 0, vpit: 0, zoom: 1, tzoom: 1 }; this.spin = 0; this.spinV = 1;
    this.dots = dotSphere(980, 913); this.pod = dotSphere(150, 77); this.podOrder = Array.from({ length: 150 }, (_, i) => i).sort((a, b) => this.pod[a * 5 + 1] - this.pod[b * 5 + 1]); this.data = null; this.podV = null; this.seats = []; this.cry = []; this.flash = []; this.view = null; this.O = new Float64Array(3); this.lane = []; this.bursts = [];
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
    const { pushP, pushL, cx, cy, k, W, H, T, calm, main, fade } = f; this.topSafe = f.topSafe ?? 0; const O = this.O; const e = this.entry; const votes = e?.votes ?? []; const S = e?.support ?? 0; const verdict = e?.verdict ?? 'watch'; const vc = VERD[verdict];
    const M = mat(this.cam.yaw + this.spin, this.cam.pit); const MW = mat(this.cam.yaw, this.cam.pit);
    const xf = (m, x, y, z) => { O[0] = m[0] * x + m[1] * y + m[2] * z; O[1] = m[3] * x + m[4] * y + m[5] * z; O[2] = m[6] * x + m[7] * y + m[8] * z; };
    const P = (z) => DD / (DD - z); const R = C0 * k; this.view = { cx, cy, R, main };
    const cyc = calm ? CYCLE - 0.5 : T % CYCLE; const fired = (i) => cyc >= 1.4 + i * 1.05; const sinceFire = (i) => cyc - (1.4 + i * 1.05);
    let partial = 0; votes.forEach((v, i) => { if (fired(i)) partial += v.weight * v.support; });
    const gaugeS = calm ? S : partial; const pulse = calm ? 0.5 : 0.5 + 0.5 * Math.sin(T * 2.2);

    // ---- aura (cyberpunk haze: violet outer, magenta inner) + core, brightness follows the weighted support
    pushP(cx, cy, R * 4.2, VIO[0], VIO[1], VIO[2], 0.13 * fade, 0.5); pushP(cx, cy, R * 2.6, MAG[0], MAG[1], MAG[2], 0.1 * fade, 0.5);
    pushP(cx, cy, R * (1.1 + 0.5 * gaugeS + 0.06 * pulse), MAG[0], 0.3, 0.9, (0.3 + 0.2 * gaugeS) * fade, 0.3); pushP(cx, cy, R * 0.34, 1, 0.8, 1, 0.55 * fade, 0);

    // ---- dot-matrix star: 760 points in four sizes (pixel squares, small, medium, large glowing dots), a scan band runs over it, colour runs cyan to magenta with height
    { const D = this.dots; const sweep = calm ? 9 : Math.sin(T * 0.55) * 0.95; const SZ = [2.2, 2.8, 4.4, 7.2]; const R3 = C0 * 0.8;
      for (let i = 0; i < D.length / 5; i++) {
        const o = i * 5; xf(M, D[o] * R3, D[o + 1] * R3, D[o + 2] * R3); const f = O[2] / R3; const tier = D[o + 3]; if (f < -0.05 && tier < 2 && (i & 1)) continue; const s = P(O[2]);
        const band = calm ? 0 : Math.exp(-(((D[o + 1] - sweep) / 0.13) ** 2)); const wv = calm ? 0 : Math.max(0, Math.sin(T * 1.4 + D[o + 4])) ** 10; const col = mix(CYAN, MAG, clamp(0.5 + 0.5 * D[o + 1] + 0.22 * Math.sin(T * 0.7 + D[o + 4]), 0, 1));
        const al = (f > 0 ? 0.3 + 0.62 * f : 0.07) * (1 + 2.4 * band + 1.6 * wv) * fade * (tier === 3 ? 1.1 : 1); const sz = SZ[tier] * (0.55 + 0.5 * Math.max(0, f)) * (0.6 + k * 1.4) * s * (1 + 0.5 * band + 0.3 * wv);
        pushP(px0(O, cx, s, k), py0(O, cy, s, k), sz * (tier >= 2 ? 1.5 : 1), col[0], col[1], col[2], Math.min(1.3, al), tier === 0 ? -1 : tier === 1 ? 0.25 : 0.12);
      } }

    // ---- gauge ring: 144 dots around the star; the filled part (bigger, verdict colour) is the weighted support, big white dots mark the watch / go thresholds
    { const rg = C0 * 1.42; const tl = -0.32; const rules = this.data?.council?.rules ?? { watchAt: 0.48, goAt: 0.62 }; const n = 144;
      for (let q = 0; q < n; q++) {
        const th = (q / n) * TAU; const fill = q / n < gaugeS; const mk = [rules.watchAt, rules.goAt].some((r) => Math.abs(q / n - r) < 0.6 / n); const ca = Math.cos(th); const sa = Math.sin(th);
        xf(MW, rg * ca, -Math.sin(tl) * rg * sa, Math.cos(tl) * rg * sa); const s = P(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const front = O[2] > 0 ? 1 : 0.35; const col = mk ? WHITE : fill ? vc : VIO;
        const sz = (mk ? 7 : fill ? (q % 3 === 0 ? 5.2 : 3.4) : q % 6 === 0 ? 3.2 : 2) * (0.6 + k * 1.2) * s; pushP(x, y, sz, col[0], col[1], col[2], (mk ? 0.95 : fill ? 0.9 : 0.32) * front * fade, fill || mk ? 0.12 : -1);
        if (fill && q === Math.floor(gaugeS * n) - 1) pushP(x, y, 22, vc[0], vc[1], vc[2], 0.7 * fade, 0.1);
      } }

    // ---- seat ring + seats: seven beacons on a tilted ring. Each fires a bolt into the core when its stored vote is replayed.
    { const rs = C0 * 1.12; const tl = 0.5; 
      for (let q = 0; q < 110; q++) { const th = (q / 110) * TAU + (calm ? 0 : T * 0.03); xf(MW, rs * Math.cos(th), -Math.sin(tl) * rs * Math.sin(th), Math.cos(tl) * rs * Math.sin(th)); const s = P(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const sz = (q % 9 === 0 ? 5 : q % 3 === 0 ? 3 : 2) * (0.6 + k * 1.2) * s; pushP(x, y, sz, CYAN[0], CYAN[1], CYAN[2], (q % 9 === 0 ? 0.55 : 0.3) * (O[2] > 0 ? 1 : 0.35) * fade, q % 3 ? -1 : 0.2); }
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
    if (!calm) { const tb = cyc - 10.3; if (tb > 0 && tb < 1.6) { const u = tb / 1.6; const rr = R * (0.9 + 2.2 * u); const a = 0.8 * (1 - u) * fade; for (let q = 0; q < 64; q++) { const th = (q / 64) * TAU; pushP(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr * 0.9, q % 4 === 0 ? 9 : 4, vc[0], vc[1], vc[2], a, q % 2 ? -1 : 0.15); } } }

    // ---- launch lane (main view only): verdict -> research -> build -> decision -> approve -> deploy -> verify -> monitor, then the OUTCOME pod (the final judgement).
    // Stage colours and the pod come from the stored journey; the pulse that runs along the lane replays the verdict.
    this.lane = []; this.podV = null; const jr = this.data?.journey; const oc = jr?.outcome; const occ = OUT[oc?.state ?? 'not_started'];
    if (main && fade > 0.4) {
      const st = jr?.stages ?? []; const nodes = [{ label: 'Verdict', state: e ? 'verdict' : 'todo', detail: e ? (verdict === 'go' ? 'GO: backed' : verdict === 'watch' ? 'WATCH: not yet' : 'DROP') : '' }, ...st]; const narrow = W < 640; const y = Math.min((f.bottomSafe ?? H - 24) - (narrow ? 66 : 64), cy + R * 2.05);
      const x0 = W * (narrow ? 0.07 : 0.1); const x1 = W * (narrow ? 0.76 : 0.8); const n = nodes.length; const podX = W * (narrow ? 0.89 : 0.915); const podR = narrow ? 24 : 40;
      const col = (s2) => (s2 === 'verdict' ? vc : s2 === 'done' ? [0.78, 0.96, 0.2] : s2 === 'active' ? [0.97, 0.72, 0.3] : s2 === 'blocked' ? [1, 0.25, 0.5] : [0.42, 0.45, 0.5]);
      const xs = (i) => x0 + ((x1 - x0) * i) / (n - 1); const dot = (x, y2, sz, c, a, sq) => pushP(x, y2, sz, c[0], c[1], c[2], a, sq ? -1 : 0.15);
      for (let i = 0; i < n; i++) {
        const x = xs(i); const c = col(nodes[i].state); const act = nodes[i].state === 'active';
        if (i) { const pc = col(nodes[i - 1].state); const todo = nodes[i].state === 'todo'; const xa = xs(i - 1) + 16; const xb = x - 16; const cnt = Math.max(2, Math.floor((xb - xa) / 9)); for (let q = 0; q < cnt; q++) { const xx = xa + ((xb - xa) * (q + 0.5)) / cnt; dot(xx, y, q % 3 === 0 ? 4 : 2.4, pc, todo ? 0.2 : 0.7, q % 3); } }
        pushP(x, y, act ? 44 + 10 * pulse : 30, c[0], c[1], c[2], nodes[i].state === 'todo' ? 0.25 : 0.6, 0.3); dot(x, y, 11, c, nodes[i].state === 'todo' ? 0.5 : 1, false); dot(x, y, 5, WHITE, nodes[i].state === 'todo' ? 0.4 : 0.95, true);
        this.lane.push({ x, y, ...nodes[i] });
      }
      // connector from the last stage to the pod
      { const last = nodes[n - 1]; const xa = x1 + 16; const xb = podX - podR - 8; const cnt = Math.max(2, Math.floor((xb - xa) / 9)); const pc = col(last.state); for (let q = 0; q < cnt; q++) dot(xa + ((xb - xa) * (q + 0.5)) / cnt, y, q % 3 === 0 ? 4 : 2.4, pc, last.state === 'todo' ? 0.2 : 0.7, q % 3); }
      // outcome pod: a small dot-sphere that fills bottom to top with the share of finished stages, coloured by the final judgement
      { const prog = oc ? oc.progress.done / Math.max(1, oc.progress.total) : 0; const spinP = calm ? 0.4 : T * 0.5; const Mp = mat(spinP, 0.35); const nLit = Math.round(prog * (this.pod.length / 5));
        pushP(podX, y, podR * (3.3 + 0.4 * pulse), occ[0], occ[1], occ[2], 0.22 * fade, 0.5);
        this.podOrder.forEach((idx, rank) => { const o = idx * 5; xf(Mp, this.pod[o] * podR, this.pod[o + 1] * podR, this.pod[o + 2] * podR); const on = rank < nLit; const f = O[2] / podR; const tier = this.pod[o + 3]; const c = on ? occ : VIO; const sz = [2.8, 3.4, 4.6, 6.4][tier] * (0.6 + 0.4 * Math.max(0, f)); pushP(podX + O[0], y - O[1], sz, c[0], c[1], c[2], (on ? 1 : 0.55) * (f > 0 ? 1 : 0.45) * fade, tier === 0 ? -1 : 0.2); });
        if (!calm && oc) { const st2 = oc.state; if (st2 === 'shipped' || st2 === 'live') { for (let q = 0; q < 6; q++) { const u = ((T * 0.6 + q / 6) % 1); const a = (q / 6) * TAU + T * 0.4; pushP(podX + Math.cos(a) * podR * (1.2 + u), y + Math.sin(a) * podR * (1.2 + u), 4, occ[0], occ[1], occ[2], 0.8 * (1 - u), 0.1); } }
          else if (st2 === 'failed') { const g = hash(Math.floor(T * 9)); if (g > 0.55) pushL(podX - podR * 1.5, y + (g - 0.7) * podR * 2, 0.6, podX + podR * 1.5, y + (g - 0.7) * podR * 2, 0.6, occ[0], occ[1], occ[2]); }
          else { const ring = (T * 0.4) % 1; for (let q = 0; q < 20; q++) { const a = (q / 20) * TAU; pushP(podX + Math.cos(a) * podR * (1.15 + ring * 0.8), y + Math.sin(a) * podR * (1.15 + ring * 0.8), 3, occ[0], occ[1], occ[2], 0.5 * (1 - ring), -1); } } }
        this.podV = { x: podX, y, r: podR }; }
      // the verdict pulse running along the lane
      if (!calm && e) { const first = nodes.findIndex((nd, i) => i && nd.state !== 'done'); const end = first < 0 ? n - 1 : Math.max(0, first - 1 + (verdict === 'go' ? 1 : 0)); const u = clamp((cyc - 10.4) / 3, 0, 1); if (cyc > 10.4 && end > 0) { const xx = xs(0) + (xs(end) - xs(0)) * u; pushP(xx, y, 24, vc[0], vc[1], vc[2], 0.9 * (1 - u * 0.4), 0.1); for (let q = 1; q < 6; q++) pushP(xx - q * 8 * u, y, 8 - q, vc[0], vc[1], vc[2], 0.6 * (1 - q / 6), 0.1); } }
      // the verdict's path: a dotted curve from the star down to the first node of the lane (the verdict is what starts the lane)
      { const ax = cx; const ay = cy + R * 0.9; const bx = this.lane[0]?.x ?? cx; const by = y - 16; const qx = bx; const qy = ay; // the curve leaves the star sideways and drops onto the first node from above, away from the lane's own dots this.verdictCurve = null;
        for (let q = 1; q < 22; q++) { const u = q / 22; const a = (1 - u) * (1 - u); const b2 = 2 * u * (1 - u); const d = u * u; const xx = a * ax + b2 * qx + d * bx; const yy = a * ay + b2 * qy + d * by; if (q === 11) this.verdictCurve = { x: xx, y: yy }; dot(xx, yy, q % 4 === 0 ? 6 : 3.4, vc, 0.85 * fade, q % 4); }
        if (!calm) { const u = clamp((cyc - 10.0) / 1.2, 0, 1); if (cyc > 10 && u < 1) { const a = (1 - u) * (1 - u); const b2 = 2 * u * (1 - u); const d = u * u; pushP(a * ax + b2 * qx + d * bx, a * ay + b2 * qy + d * by, 14, vc[0], vc[1], vc[2], 0.9 * (1 - u * 0.5), 0.1); } } }
    }
    this.cycle = cyc; this.verdict = verdict; this.partial = gaugeS;
  }

  /** Called by the scene when a summary packet lands on a crystal. */
  hit(i, T) { this.flash[i] = T; }

  pick(x, y, touch) {
    const slop = touch ? 10 : 3;
    for (const s of this.seats) if ((s.x - x) ** 2 + (s.y - y) ** 2 < (s.r + slop) ** 2 && s.z > -40) return { t: 'seat', i: s.i };
    for (const c of this.cry) if ((c.x - x) ** 2 + (c.y - y) ** 2 < (c.r + slop) ** 2) return { t: 'prod', i: c.i };
    if (this.podV && (this.podV.x - x) ** 2 + (this.podV.y - y) ** 2 < (this.podV.r * 1.5 + slop) ** 2) return { t: 'outcome', i: 0 };
    return null;
  }
  screenOf(key) { if (key.t === 'outcome') return this.podV ? { x: this.podV.x, y: this.podV.y, r: this.podV.r } : null; if (key.t === 'seat') { const s = this.seats[key.i]; return s ? { x: s.x, y: s.y, r: 14 } : null; } const c = this.cry[key.i]; return c ? { x: c.x, y: c.y, r: c.r } : null; }
}
