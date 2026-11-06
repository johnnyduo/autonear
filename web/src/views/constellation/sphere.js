// Glyph sphere (primary hero view). Same data and the same meaning as the glyph disc, wrapped onto a globe:
//  longitude = primary topic (one wedge per topic, width = record count) · latitude = age (oldest at the south, newest toward the north pole)
//  glyph = 9x9 pixel pattern from the record's content hash · colour = source · brightness = NEAR relevance · red pixel ring = flag.
// The sphere is projected on the CPU into the same flat point/line buffers the disc uses, so render-gl.js (bloom) and render-2d.js (fallback) draw it unchanged.
// Decoration only: surface lattice, graticule, scan ring, dust shell, limb glow, cursor trail, auto spin. Everything labelled in the legend is stored data.
import { hash32, WELLS } from './data.js';
import { ROLES } from './shared.js';
import { PSTRIDE, LSTRIDE } from './scene.js';
import { DiscScene, G, R0, fingerprint, glyphPixels } from './disc.js';
import { drawSphereOverlay } from './overlay-sphere.js';
import { CouncilStar } from './council-star.js';

const DD = R0 * 7; // camera distance: mild perspective
const TAU = Math.PI * 2;
const LAT = 1.12; // glyph rings span +-64 degrees
const LIGHT = (() => { const v = [-0.45, 0.5, 0.74]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
const WARM = [1, 0.8, 0.46]; const LIME = [0.776, 0.957, 0.196]; const RISK = [1, 0.416, 0.239]; const GOLD = [0.95, 0.76, 0.42];
const TILT = [0.35, -0.5, 0.75, -0.2, 0.55, -0.7, 0.15, -0.35];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - (1 - t) ** 3;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const wrap = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
/** Row-major 3x3 for yaw (about the vertical axis) then pitch (about x). z of the result points at the viewer. */
const mat = (yaw, pit) => { const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pit); const sp = Math.sin(pit); return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy]; };
const rnd = (seed) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

export class SphereScene extends DiscScene {
  constructor(opts = {}) {
    super(opts);
    this.kind = 'sphere';
    this.cam = { zoom: 1, tzoom: 1, px: 0, py: 0, tpx: 0, tpy: 0, par: [0, 0], tpar: [0, 0], yaw: 0.6, tyaw: 0.6, pit: 0.34, tpit: 0.34, vyaw: 0, vpit: 0 };
    this.council = new CouncilStar(); this.swap = 0; this.swapT = 0; this.onSwap = null; this.evMain = true; this.evView = null; this.sHit = [];
    this.spin = 0; this.spinV = 1; this.O = new Float64Array(3); this.nodeOk = new Uint8Array(0);
    const r = rnd(4242); const M = 900; this.lat3 = new Float32Array(M * 4); // fibonacci lattice: x, y, z, lat
    for (let i = 0; i < M; i++) { const y = 1 - ((i + 0.5) / M) * 2; const rr = Math.sqrt(1 - y * y); const ph = i * 2.399963229728653; this.lat3.set([R0 * 0.996 * rr * Math.cos(ph), R0 * 0.996 * y, R0 * 0.996 * rr * Math.sin(ph), Math.asin(y)], i * 4); }
    this.orbDust = Array.from({ length: 150 }, () => ({ u: r(), j: [r() - 0.5, r() - 0.5, r() - 0.5], sz: 1.3 + r() * 2.6, sp: 0.025 + r() * 0.06, tw: r() * 6 }));
    this.shell = Array.from({ length: 460 }, () => ({ lon: r() * TAU, lat: Math.asin(r() * 2 - 1), rad: 1.1 + Math.pow(r(), 1.6) * 0.75, sp: (r() - 0.35) * 0.09, sz: 1.6 + r() * 2.4, al: 0.25 + r() * 0.6 }));
  }

  /* ------------------------------------------------------------ layout: topics are longitude wedges, rings are latitudes */
  layout() {
    const m = this.model; const nodes = m.nodes; const N = nodes.length; const Wn = m.wells.length;
    const by = Array.from({ length: Wn }, () => []); nodes.forEach((n, i) => by[n.primary].push(i));
    const live = by.map((l, w) => [w, l.length]).filter(([, c]) => c > 0); const K = live.length; const gap = K > 1 ? 0.05 : 0;
    const total = TAU - gap * K; this.sectors = new Array(Wn).fill(null); let a = -Math.PI / 2 + gap / 2;
    for (const [w, c] of live) { const span = (total * c) / N; this.sectors[w] = { w, a0: a, a1: a + span, mid: a + span / 2, n: c }; a += span + gap; }
    const latsFor = (p) => { const nR = Math.max(1, Math.floor((2 * LAT * R0) / p)); const st = (2 * LAT) / nR; return Array.from({ length: nR }, (_, j) => -LAT + (j + 0.5) * st); };
    let pitch = 40; let lats = latsFor(pitch);
    for (; pitch > 5; pitch -= 0.25) {
      lats = latsFor(pitch); let ok = true;
      for (const [w, c] of live) { const sp = this.sectors[w].a1 - this.sectors[w].a0 - 0.02; let cap = 0; for (const lt of lats) cap += Math.max(1, Math.floor((R0 * Math.cos(lt) * sp) / pitch)); if (cap < c) { ok = false; break; } }
      if (ok) break;
    }
    this.pitch = pitch; this.gsize = pitch * 0.64; this.pu = this.gsize / G; this.rings = lats;
    this.nc = new Float32Array(N * 9); this.nr = new Float32Array(N * 9); this.nsx = new Float32Array(N); this.nsy = new Float32Array(N); this.nf = new Float32Array(N); this.nlt = new Float32Array(N); this.nrad = new Float32Array(N); this.nlat = new Float32Array(N); this.nodeOk = new Uint8Array(N); this.simT = new Float32Array(N).fill(-9); this.flashTab = new Float32Array(N); this.bySrc = m.sources.map(() => []); this.byWell = by;
    nodes.forEach((n, i) => { (this.bySrc[n.src] ??= []).push(i); });
    const place = (i, th, lat) => {
      const cl = Math.cos(lat); const sl = Math.sin(lat); const co = Math.cos(th); const so = Math.sin(th); nodes[i].slot = { x: 0, y: 0, r: R0, th, lat };
      this.nc.set([R0 * cl * co, R0 * sl, R0 * cl * so, -so, 0, co, -sl * co, cl, -sl * so], i * 9); this.nlat[i] = lat; this.nodeOk[i] = 1;
    };
    nodes.forEach((n) => { n.slot = null; });
    for (const [w, c] of live) {
      const sec = this.sectors[w]; const sp = sec.a1 - sec.a0 - 0.02; const caps = lats.map((lt) => Math.max(1, Math.floor((R0 * Math.cos(lt) * sp) / pitch))); const capSum = caps.reduce((x, y) => x + y, 0);
      const raw = caps.map((kk) => (c * kk) / capSum); const cnt = raw.map(Math.floor); let rem = c - cnt.reduce((x, y) => x + y, 0);
      raw.map((v, j) => [v - Math.floor(v), j]).sort((x, y) => y[0] - x[0]).forEach(([, j]) => { if (rem > 0 && cnt[j] < caps[j]) { cnt[j]++; rem--; } });
      const order = by[w].slice().sort((x, y) => nodes[x].p - nodes[y].p || (nodes[x].id < nodes[y].id ? -1 : 1)); // oldest at the south, newest toward the north
      let k = 0;
      lats.forEach((lt, j) => { for (let s = 0; s < cnt[j] && k < order.length; s++, k++) place(order[k], sec.a0 + 0.01 + ((s + 0.5) / cnt[j]) * sp, lt); });
      for (; k < order.length; k++) place(order[k], sec.mid, lats[lats.length - 1]);
    }
    // glyph pixels: offsets in the tangent plane (east, north), in sphere units
    const px = []; const fp = nodes.map((n) => fingerprint(n.e)); this.fp = fp; const u = this.pu;
    nodes.forEach((n, i) => {
      if (!n.slot) return; const gp = glyphPixels(fp[i].bytes); n.npix = gp.length;
      for (const [c, r, lv] of gp) px.push([(c - 4) * u, -(r - 4) * u, i, lv, (hash32(`${n.id}:${c}:${r}`) % 1000) / 1000, 0]);
      if (n.flagged) { const h = 5; for (let k = -h; k <= h; k++) for (const [cx, cy] of [[k, -h], [k, h], [-h, k], [h, k]]) { if ((cx + cy + h) % 2) continue; px.push([cx * u * 0.92, -cy * u * 0.92, i, 3, 0.3, 1]); } }
    });
    const n = px.length; const pix = { n, x: new Float32Array(n), y: new Float32Array(n), i: new Int32Array(n), lv: new Uint8Array(n), thr: new Float32Array(n), kind: new Uint8Array(n) };
    px.forEach((p, k) => { pix.x[k] = p[0]; pix.y[k] = p[1]; pix.i[k] = p[2]; pix.lv[k] = p[3]; pix.thr[k] = p[4]; pix.kind[k] = p[5]; });
    this.pix = pix;
    // graticule (decorative): parallels, meridians, and a brighter meridian on every topic boundary
    const G3 = []; const poly = (n3, f, a, col) => { const p = new Float32Array(n3 * 3); for (let q = 0; q < n3; q++) p.set(f(q / (n3 - 1)), q * 3); G3.push({ p, n: n3, a, col }); };
    const sph = (lon, lat, r = R0 * 0.992) => [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon)];
    for (let d = -60; d <= 60; d += 15) poly(73, (u2) => sph(u2 * TAU, (d * Math.PI) / 180), d === 0 ? 0.22 : 0.09, GOLD);
    for (let q = 0; q < 12; q++) poly(41, (u2) => sph((q / 12) * TAU, -1.4 + u2 * 2.8), 0.06, [0.8, 0.85, 0.9]);
    for (const s of this.sectors) if (s) { poly(33, (u2) => sph(s.a0 - 0.025, -LAT - 0.1 + u2 * (LAT * 2 + 0.2)), 0.3, GOLD); poly(33, (u2) => sph(s.a1 + 0.025, -LAT - 0.1 + u2 * (LAT * 2 + 0.2)), 0.3, GOLD); }
    this.grat = G3;
  }

  /* ------------------------------------------------------------ camera */
  get fitInfo() {
    if (this.fit) return this.fit; const W = this.W; const H = this.H; const S = Math.max(1, this.model?.sources.length ?? 4);
    const ew = this.orbitR(S - 1) * 1.08; const eh = 1.3; const narrow = W < 640; const padX = narrow ? 8 : 26; const top = narrow ? 112 : 66; const bottom = narrow ? 150 : 96; const availH = Math.max(120, H - top - bottom);
    const rFit = Math.min((W / 2 - padX) / ew, availH / 2 / eh); const rMin = Math.min(W * (narrow ? 0.34 : 0.22), availH / 2 / 1.12);
    let R; let ks = 1; if (rFit >= rMin) R = rFit; else { R = rMin; ks = Math.max(narrow ? 0.7 : 0.8, rFit / rMin); }
    this.fit = { scale0: R / R0, ks, ccx: W / 2, ccy: top + availH / 2, ew, eh }; return this.fit;
  }
  orbitR(s) { return 1.34 + 0.07 * s; }
  setCouncil(d) { this.council.setData(d); }
  swapTo(i, instant = false) { const to = i ? 1 : 0; if (this.swapT === to && !instant) return; this.swapT = to; if (instant || this.calm) this.swap = to; this.onSwap?.(to); }
  get councilMain() { return this.swapT > 0.5; }
  drag(dx, dy) { if (this.councilMain) return this.council.drag(dx, dy); const c = this.cam; c.tyaw += dx * 0.0072; c.tpit = clamp(c.tpit + dy * 0.0072, -1.3, 1.3); c.vyaw = c.vyaw * 0.5 + dx * 0.0072 * 60 * 0.5; c.vpit = c.vpit * 0.5 + dy * 0.0072 * 60 * 0.5; }
  zoom(f) { if (this.councilMain) { const c2 = this.council.cam; c2.tzoom = clamp(c2.tzoom / f, 0.75, 1.8); return; } const c = this.cam; c.tzoom = clamp(c.tzoom / f, 1, 4.2); }
  rotateBy(a, b) { if (this.councilMain) { const c2 = this.council.cam; c2.tyaw += a; c2.tpit = clamp(c2.tpit + b, -1.2, 1.2); return; } const c = this.cam; c.tyaw += a; c.tpit = clamp(c.tpit + b, -1.3, 1.3); c.vyaw = c.vpit = 0; }
  resetView() { if (this.councilMain) { const c2 = this.council.cam; c2.tzoom = 1; c2.tpit = 0.38; return; } const c = this.cam; c.tzoom = 1; c.tpit = 0.34; c.vyaw = c.vpit = 0; c.tyaw = c.yaw + wrap(0.6 - c.yaw); }
  focusOn(key) { // turn the globe so the chosen glyph (or topic wedge) faces the viewer
    if (this.councilMain) return; const c = this.cam; let lon; let lat;
    if (key.t === 'ev') { const n = this.model.nodes[key.i]; if (!n.slot) return; lon = n.slot.th; lat = n.slot.lat; c.tzoom = Math.max(c.tzoom, 2.4); }
    else if (key.t === 'well') { const s = this.sectors[key.i]; if (!s) return; lon = s.mid; lat = 0.2; c.tzoom = Math.max(c.tzoom, 1.5); } else return;
    c.tyaw = c.yaw + wrap(lon - Math.PI / 2 - this.spin - c.yaw); c.tpit = clamp(lat, -1.15, 1.15); c.vyaw = c.vpit = 0;
  }
  frame(now, dt) {
    const c = this.cam; const calm = this.calm;
    if (!this.dragging && !calm) { c.tyaw += c.vyaw * dt; c.tpit = clamp(c.tpit + c.vpit * dt, -1.3, 1.3); }
    if (!this.dragging) { const d = Math.exp(-dt * 2.8); c.vyaw *= d; c.vpit *= d; }
    const k = calm ? 1 : 1 - Math.exp(-dt * 10); c.yaw += (c.tyaw - c.yaw) * k; c.pit += (c.tpit - c.pit) * k;
    const tgt = this.pinned ? 0 : this.hover ? 0.12 : 1; this.spinV = this.pinned ? 0 : this.spinV + (tgt - this.spinV) * (1 - Math.exp(-dt * 3));
    if (!calm && this.auto && !this.dragging) this.spin += dt * 0.075 * this.spinV;
    this.swap += (this.swapT - this.swap) * (calm ? 1 : 1 - Math.exp(-dt * 3.4)); if (Math.abs(this.swapT - this.swap) < 0.002) this.swap = this.swapT;
    this.council.step(dt, calm, this.dragging && this.councilMain, this.hover?.t === 'seat' || this.hover?.t === 'prod');
    super.frame(now, dt);
  }

  /* ------------------------------------------------------------ frame build */
  build(now) {
    const m = this.model; const nodes = m.nodes; const N = nodes.length; const P = this.P; const L = this.L; let np = 0; let nl = 0; const calm = this.calm; const flat = this.q.flat;
    const pushP = (x, y, size, r, g, b, a, bl) => { if (np >= this.maxP || a <= 0.002) return; const o = np * PSTRIDE; P[o] = x; P[o + 1] = y; P[o + 2] = size; P[o + 3] = r; P[o + 4] = g; P[o + 5] = b; P[o + 6] = a; P[o + 7] = bl; np++; };
    const pushL = (x1, y1, a1, x2, y2, a2, r, g, b) => { if (nl >= this.maxL || (a1 <= 0.002 && a2 <= 0.002)) return; const o = nl * 2 * LSTRIDE; L[o] = x1; L[o + 1] = y1; L[o + 2] = r; L[o + 3] = g; L[o + 4] = b; L[o + 5] = a1; L[o + 6] = x2; L[o + 7] = y2; L[o + 8] = r; L[o + 9] = g; L[o + 10] = b; L[o + 11] = a2; nl++; };
    const W = this.W; const H = this.H; const zm = this.cam.zoom; const ks = this.fitInfo.ks; const sw = this.swap; const se = sw * sw * (3 - 2 * sw); const lerp = (a, b, t) => a + (b - a) * t; const nrw = W < 640; const sc0 = this.scale0;
    const smallK = sc0 * (nrw ? 0.2 : 0.25); const k = lerp(sc0 * zm, smallK, se); const smallY = nrw ? this.ccy + R0 * sc0 * 1.28 : this.ccy; const cx = lerp(this.ccx, W * (nrw ? 0.2 : 0.13), se); const cy = lerp(this.ccy, smallY, se); const R = R0 * k;
    const coK = lerp(smallK * 0.8, sc0 * 1.02 * this.council.cam.zoom, se); const coX = lerp(W * (nrw ? 0.8 : 0.87), (W - (this.rightInset ?? 0)) / 2, se); const coY = lerp(smallY, this.ccy + (nrw ? 0 : 18), se); this.evMain = se < 0.5; this.evView = { cx, cy, R };
    const ov = this.ov; ov.sats = []; ov.roles = []; ov.marks = []; ov.sparkles = []; ov.wells = []; ov.wellPts = []; ov.R = R; ov.cx = cx; ov.cy = cy; ov.k = k;
    const mS = mat(this.cam.yaw + this.spin, this.cam.pit); const mC = mat(this.cam.yaw, this.cam.pit); const O = this.O;
    const xf = (M, x, y, z) => { O[0] = M[0] * x + M[1] * y + M[2] * z; O[1] = M[3] * x + M[4] * y + M[5] * z; O[2] = M[6] * x + M[7] * y + M[8] * z; };
    const persp = (z) => DD / (DD - z);
    const fxT = this.fxT; const spinning = !calm && this.auto;

    // ---- starfield (decorative)
    const S = this.stars; const par = this.cam.par; const drift = spinning ? this.t * 0.6 : 0;
    const nS = Math.min(S.length / 6, Math.round(S.length / 6 * (this.q.dust / 600)));
    for (let i = 0; i < nS; i++) {
      const o = i * 6; const d = S[o + 2]; let x = S[o] * W + par[0] * 14 * d + drift * d * 0.4; const y = S[o + 1] * H + par[1] * 10 * d; x = ((x % W) + W) % W;
      const tw = calm ? 0.8 : 0.6 + 0.4 * Math.sin(this.t * 0.45 * (0.4 + S[o + 3]) + S[o + 4]); const big = S[o + 5] > 0;
      pushP(x, y, big ? 7 : 2.4 + d * 2.2, 1, 0.93, 0.8, (big ? 0.9 : 0.22 + 0.4 * S[o + 3] * d) * tw, 0); if (big) ov.sparkles.push({ x, y, a: 0.5 * tw });
    }
    // ---- body glow + limb ring (decorative)
    if (!flat) { pushP(cx, cy, R * 3.8, 1, 0.72, 0.32, 0.14, 0.5); pushP(cx - R * 0.22, cy - R * 0.28, R * 2.3, 1, 0.8, 0.45, 0.07, 0.5); }
    pushP(cx, cy, R * 1.2, 1, 0.82, 0.5, 0.1, 0.4);
    if (!flat) { const nL = 84; for (let q = 0; q < nL; q++) { const a = (q / nL) * TAU; const pu = calm ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 0.9 + q * 0.33); pushP(cx + Math.cos(a) * R * 1.005, cy + Math.sin(a) * R * 1.005, R * 0.11, 0.55 + 0.4 * Math.cos(a), 0.78, 1, 0.045 + 0.03 * pu, 0.6); } }

    // ---- nodes: rotate the glyph centre + its tangent axes once; pixels only add offsets
    const nc = this.nc; const nr = this.nr;
    const sweepLat = calm ? 9 : Math.sin(fxT * 0.42) * 1.15;
    for (let i = 0; i < N; i++) {
      if (!this.nodeOk[i]) continue; const o = i * 9;
      xf(mS, nc[o], nc[o + 1], nc[o + 2]); const X = O[0]; const Y = O[1]; const Z = O[2]; const s = persp(Z);
      nr[o] = X; nr[o + 1] = Y; nr[o + 2] = Z; xf(mS, nc[o + 3], nc[o + 4], nc[o + 5]); nr[o + 3] = O[0]; nr[o + 4] = O[1]; nr[o + 5] = O[2]; xf(mS, nc[o + 6], nc[o + 7], nc[o + 8]); nr[o + 6] = O[0]; nr[o + 7] = O[1]; nr[o + 8] = O[2];
      const f = Z / R0; this.nf[i] = f; this.nsx[i] = cx + X * s * k; this.nsy[i] = cy - Y * s * k; this.nlt[i] = 0.7 + 0.3 * Math.max(0, (X * LIGHT[0] + Y * LIGHT[1] + Z * LIGHT[2]) / R0);
      this.nrad[i] = Math.max(6, this.pitch * k * s * 0.46); this.sweepF[i] = calm ? 0 : Math.exp(-(((this.nlat[i] - sweepLat) / 0.11) ** 2));
    }

    // ---- surface lattice: the dot-matrix skin of the globe (decorative)
    { const lt = this.lat3; const M = Math.min(lt.length / 4, Math.round(lt.length / 4 * clamp(this.q.dust / 600, 0.45, 1))); const sz = 1.5 + k * 1.3;
      for (let i = 0; i < M; i++) {
        const o = i * 4; xf(mS, lt[o], lt[o + 1], lt[o + 2]); const f = O[2] / R0; if (f < -0.02 && (i & 1)) continue; const s = persp(O[2]); const sw = calm ? 0 : Math.exp(-(((lt[o + 3] - sweepLat) / 0.1) ** 2));
        const lit = 0.7 + 0.3 * Math.max(0, (O[0] * LIGHT[0] + O[1] * LIGHT[1] + O[2] * LIGHT[2]) / R0); const a = (f > 0 ? 0.05 + 0.1 * Math.pow(f, 0.6) : 0.025) * lit * (1 + 5 * sw) * this.intro;
        pushP(cx + O[0] * s * k, cy - O[1] * s * k, sz * (1 + sw), 1, 0.88 - 0.1 * sw, 0.7, a, 0);
      } }

    // ---- graticule (decorative)
    for (const g of this.grat) {
      let px = 0; let py = 0; let pa = 0; const col = g.col; const A = g.a * this.intro;
      for (let q = 0; q < g.n; q++) {
        xf(mS, g.p[q * 3], g.p[q * 3 + 1], g.p[q * 3 + 2]); const s = persp(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const f = O[2] / R0; const a = A * (f > 0 ? 0.4 + 0.6 * f : 0.16);
        if (q) pushL(px, py, pa, x, y, a, col[0], col[1], col[2]); px = x; py = y; pa = a;
      }
    }
    // ---- scan ring: a bright parallel sweeping pole to pole (decorative; glyphs under it flare)
    if (!calm) {
      const cl = Math.cos(sweepLat); const sl = Math.sin(sweepLat); let px = 0; let py = 0; let pa = 0;
      for (let q = 0; q <= 96; q++) {
        const a = (q / 96) * TAU; xf(mS, R0 * 1.004 * cl * Math.cos(a), R0 * 1.004 * sl, R0 * 1.004 * cl * Math.sin(a)); const s = persp(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const f = O[2] / R0; const al = (f > 0 ? 0.25 + 0.65 * f : 0.07) * this.intro;
        if (q) pushL(px, py, pa, x, y, al, 0.95, 1, 0.8); px = x; py = y; pa = al; if (q % 8 === 0 && f > 0.1) pushP(x, y, 7 + 5 * f, 0.95, 1, 0.7, 0.2 * f, 0.1);
      }
    }

    // ---- dust shell (decorative): slow orbiting motes around the globe, depth-faded
    if (!flat) {
      const nD = Math.round(this.shell.length * clamp(this.q.dust / 600, 0.3, 1));
      for (let i = 0; i < nD; i++) {
        const d = this.shell[i]; const lon = d.lon + (spinning ? fxT * d.sp : 0); const cl = Math.cos(d.lat); const r = R0 * d.rad;
        xf(mC, r * cl * Math.cos(lon), r * Math.sin(d.lat), r * cl * Math.sin(lon)); const s = persp(O[2]); const x = cx + O[0] * s * k; const y = cy - O[1] * s * k; const occ = O[2] < 0 && Math.hypot(O[0], O[1]) < R0 * 0.99;
        pushP(x, y, d.sz * (0.7 + k * 0.7) * s, 1, 0.9, 0.72, d.al * (occ ? 0.05 : O[2] > 0 ? 0.55 : 0.22) * this.intro * (0.7 + 0.3 * Math.sin(this.t * 0.8 + i)), 0);
      }
    }

    // ---- focus (hover > pinned > keyboard)
    const fk = this.hover ?? this.pinned ?? this.focus; let fNode = -1; let fSec = -1; let fSrc = -1;
    if (fk?.t === 'ev') fNode = fk.i; else if (fk?.t === 'well') fSec = fk.i; else if (fk?.t === 'src') fSrc = fk.i;
    const focusing = fNode >= 0 || fSec >= 0 || fSrc >= 0; const fnode = fNode >= 0 ? nodes[fNode] : null;

    // ---- source orbits + satellites (angle = UTC time of day of the last REAL ingest)
    const now0 = Date.now(); const dayA = ((now0 % 86400000) / 86400000) * TAU - Math.PI / 2;
    const orb = (s, t) => { const ro = R0 * this.orbitR(s) * ks; const tl = TILT[s % 8]; const om = 0.4 + 0.8 * s; const lx = ro * Math.cos(t); const lz = ro * Math.sin(t); const y1 = -Math.sin(tl) * lz; const z1 = Math.cos(tl) * lz; xf(mC, Math.cos(om) * lx + Math.sin(om) * z1, y1, -Math.sin(om) * lx + Math.cos(om) * z1); };
    const occl = () => O[2] < 0 && Math.hypot(O[0], O[1]) < R0 * 0.98;
    for (let s = 0; s < m.sources.length; s++) {
      const info = this.srcInfo[s] ?? {}; const col = this.srcColors[s] ?? [0.8, 0.8, 0.8]; const tod = info.last ? ((info.last % 86400000) / 86400000) * TAU - Math.PI / 2 : -Math.PI / 2;
      const off = this.filter.srcOff.has(m.sources[s].id) ? 0.25 : 1; const dimS = focusing && fSrc >= 0 && fSrc !== s ? 0.35 : 1; const A = off * dimS * this.intro; const hotS = fSrc === s;
      let px = 0; let py = 0; let pa = 0;
      for (let q = 0; q <= 72; q++) { orb(s, (q / 72) * TAU); const sp = persp(O[2]); const x = cx + O[0] * sp * k; const y = cy - O[1] * sp * k; const a = (hotS ? 0.6 : 0.3) * A * (occl() ? 0.25 : O[2] > 0 ? 1 : 0.5); if (q) pushL(px, py, pa, x, y, a, col[0], col[1], col[2]); px = x; py = y; pa = a; }
      const tail = info.recent ? 1.3 : 0.7; px = 0;
      for (let q = 0; q <= 16; q++) { orb(s, tod - (q / 16) * tail); const sp = persp(O[2]); const x = cx + O[0] * sp * k; const y = cy - O[1] * sp * k; const a = (1 - q / 16) * (info.recent ? 0.95 : 0.55) * A * (occl() ? 0.3 : 1); if (q) pushL(px, py, pa, x, y, a, col[0], col[1], col[2]); px = x; py = y; pa = a; }
      if (!flat) { // orbit dust (decorative): motes stream off the satellite along its orbit, spread out and fade; a faint ring of dust circles the whole orbit
        const nd = Math.round(this.orbDust.length * clamp(this.q.dust / 600, 0.3, 1) * (info.recent ? 1 : 0.8)); const span = info.recent ? 4.8 : 3.4; const sp0 = R0 * 0.07 * ks;
        for (let q = 0; q < nd; q++) {
          const d = this.orbDust[q]; const u = ((d.u + s * 0.137 + (calm ? 0 : this.t * d.sp)) % 1 + 1) % 1; const fade = (1 - u) ** 1.6; orb(s, tod - u * span); const wob = 0.4 + u * 1.6;
          const sp = persp(O[2]); const x = cx + (O[0] + d.j[0] * sp0 * wob) * sp * k; const y = cy - (O[1] + d.j[1] * sp0 * wob) * sp * k; const a = fade * (0.35 + 0.65 * (calm ? 1 : 0.5 + 0.5 * Math.sin(this.t * 1.7 + d.tw))) * (occl() ? 0.2 : O[2] > 0 ? 1 : 0.55) * A * (info.recent ? 0.95 : 0.6);
          const c = mix(col, [1, 0.95, 0.85], 0.5 * (1 - u)); pushP(x, y, d.sz * (1.1 + k * 1.2) * sp, c[0], c[1], c[2], Math.min(1.2, a * 1.7), 0.1);
        }
        for (let q = 0; q < 40; q++) { const d = this.orbDust[q + 60]; orb(s, (q / 40) * TAU + (calm ? 0 : this.t * 0.02 * (s % 2 ? 1 : -1))); const sp = persp(O[2]); pushP(cx + (O[0] + d.j[0] * sp0) * sp * k, cy - (O[1] + d.j[1] * sp0) * sp * k, d.sz * 1.2 * sp, 1, 0.92, 0.78, 0.3 * A * (occl() ? 0.2 : O[2] > 0 ? 1 : 0.5) * (0.6 + 0.4 * Math.sin(this.t * 1.1 + d.tw)), 0.2); }
      }
      orb(s, dayA); { const sp = persp(O[2]); const pu = calm ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 2.6); pushP(cx + O[0] * sp * k, cy - O[1] * sp * k, 7, 1, 0.97, 0.88, (0.45 + 0.4 * pu) * (occl() ? 0.2 : 1) * A, 0); } // UTC "now" on this orbit
      orb(s, tod); const sp = persp(O[2]); const sx = cx + O[0] * sp * k; const sy = cy - O[1] * sp * k; const oc = occl(); const vis = oc ? 0.3 : 1; const z = O[2];
      const age = info.last ? Math.max(0, now0 - info.last) : 1e12; const live = info.recent ? 1 : Math.max(0.1, Math.exp(-age / (6 * 3600e3)) * 0.7);
      // shaft: from the satellite toward the globe, brightness decays with the age of that ingest
      { const d = Math.hypot(O[0], O[1], O[2]) || 1; const tx = cx + (O[0] / d) * R0 * 1.02 * persp(O[2] * 0.2) * k; const ty = cy - (O[1] / d) * R0 * 1.02 * persp(O[2] * 0.2) * k; const cc = mix(col, [1, 0.93, 0.8], 0.6);
        pushL(sx, sy, 0.5 * live * A * vis, tx, ty, 0.05 * live * A * vis, cc[0], cc[1], cc[2]); pushL(sx + 2, sy, 0.25 * live * A * vis, tx, ty, 0.02 * live * A * vis, cc[0], cc[1], cc[2]);
        if (info.recent && !calm) for (let q = 0; q < 4; q++) { const u = (this.t * 0.35 + q / 4 + s * 0.21) % 1; pushP(sx + (tx - sx) * u, sy + (ty - sy) * u, 11, 1, 0.95, 0.75, 0.8 * Math.sin(u * Math.PI) * A * vis, 0); } }
      const flash = this.srcFlash[s] && !calm ? Math.max(0, 1 - (this.t - this.srcFlash[s].t) / 0.6) : 0; const recent = Boolean(info.recent); const sz = (recent ? 36 : 22) * Math.min(1.6, 0.8 + k * 2.4) * (1 + flash * 0.8) * sp;
      pushP(sx, sy, sz, col[0], col[1], col[2], ((recent ? 0.7 : 0.4) * off + flash * 0.4) * vis, 0.1); pushP(sx, sy, 9, 1, 1, 0.92, 0.95 * off * vis, 0);
      ov.sats.push({ i: s, x: sx, y: sy, z, occ: oc, col, info, flash, off, fl: this.srcFlash[s] });
    }

    // ---- topic rim on the equator: track + opportunity-score fill (stored scores)
    const mid3 = [];
    for (const sec of this.sectors) {
      if (!sec) continue; const wl = m.wells[sec.w]; const on = !this.filter.topicOff.has(wl.id); const hl = fSec === sec.w || (this.pinned?.t === 'well' && this.pinned.i === sec.w); const score = wl.opp ? clamp(wl.opp.score, 0, 1) : 0;
      const nseg = Math.max(4, Math.ceil((sec.a1 - sec.a0) / 0.06)); const rr = R0 * 1.075; let px = 0; let py = 0; let pz = 0;
      for (let q = 0; q <= nseg; q++) {
        const u = q / nseg; const th = sec.a0 + (sec.a1 - sec.a0) * u; xf(mS, rr * Math.cos(th), 0, rr * Math.sin(th)); const sp = persp(O[2]); const x = cx + O[0] * sp * k; const y = cy - O[1] * sp * k; const z = O[2];
        if (z > -0.15 * R0) ov.wellPts.push({ w: sec.w, x, y });
        if (q) { const zf = (pz + z) * 0.5 > 0 ? 1 : 0.28; const ta = (hl ? 0.6 : 0.25) * (on ? 1 : 0.4) * zf; pushL(px, py, ta, x, y, ta, 0.93, 0.91, 0.87);
          if (wl.opp && u - 1 / nseg < score) { const fa = (hl ? 1 : 0.85) * (on ? 1 : 0.3) * zf; pushL(px, py, fa, x, y, fa, LIME[0], LIME[1], LIME[2]); } }
        px = x; py = y; pz = z;
      }
      if (wl.opp && on && !calm && score > 0.02) { const u = ((this.t * 0.28 + sec.w * 0.137) % 1) * score; const th = sec.a0 + (sec.a1 - sec.a0) * u; xf(mS, rr * Math.cos(th), 0, rr * Math.sin(th)); const sp = persp(O[2]); pushP(cx + O[0] * sp * k, cy - O[1] * sp * k, 12, 0.95, 1, 0.7, (O[2] > 0 ? 0.8 : 0.2), 0.1); }
      xf(mS, rr * Math.cos(sec.mid), 0, rr * Math.sin(sec.mid)); const sp = persp(O[2]); const x = cx + O[0] * sp * k; const y = cy - O[1] * sp * k; const z = O[2];
      xf(mS, rr * 1.3 * Math.cos(sec.mid), 0, rr * 1.3 * Math.sin(sec.mid)); const sp2 = persp(O[2]);
      mid3.push(sec.w); ov.wells.push({ w: sec.w, x, y, z, on, hl, ax: cx + O[0] * sp2 * k, ay: cy - O[1] * sp2 * k, n: sec.n, mid: sec.mid });
    }

    // ---- agent roles on a tilted ring between the globe and the orbits (dark unless a real run event lights them)
    { const Rr = R0 * 1.16; const tl = 0.5; let px = 0; let py = 0; let pa = 0;
      for (let q = 0; q <= 64; q++) { const th = (q / 64) * TAU; const lx = Rr * Math.cos(th); const lz = Rr * Math.sin(th); xf(mC, lx, -Math.sin(tl) * lz, Math.cos(tl) * lz); const sp = persp(O[2]); const x = cx + O[0] * sp * k; const y = cy - O[1] * sp * k; const a = 0.09 * this.intro * (occl() ? 0.3 : O[2] > 0 ? 1 : 0.5); if (q) pushL(px, py, pa, x, y, a, 0.93, 0.91, 0.87); px = x; py = y; pa = a; }
      ov.roles = ROLES.map((r, i) => {
        const th = (i / ROLES.length) * TAU + (calm || !this.auto ? 0.4 : now * 0.06); const lx = Rr * Math.cos(th); const lz = Rr * Math.sin(th); xf(mC, lx, -Math.sin(tl) * lz, Math.cos(tl) * lz); const sp = persp(O[2]);
        const st = this.activeRun ? this.roleState[r[0]] ?? 'idle' : 'idle'; return { i, x: cx + O[0] * sp * k, y: cy - O[1] * sp * k, z: O[2], occ: occl(), st, lit: st !== 'idle', role: r };
      }); }

    // ---- glyph pixels
    const pix = this.pix; const pu = this.pu; this.pixStart = np; const psz0 = Math.max(0.9, pu * k * 0.95); const x0 = -40; const y0 = -40; const x1 = W + 40; const y1 = H + 40; const dimTable = new Float32Array(N); const flashTab = this.flashTab;
    for (let i = 0; i < N; i++) {
      const n = nodes[i]; let dim = 1;
      if (focusing) { if (fNode >= 0) dim = i === fNode ? 1.5 : (fnode.wells.some((l) => n.wells.some((q) => q.w === l.w)) ? 0.55 : 0.3); else if (fSec >= 0) dim = n.wells.some((l) => l.w === fSec) ? 1.15 : 0.25; else if (fSrc >= 0) dim = n.src === fSrc ? 1.2 : 0.3; }
      dimTable[i] = dim; flashTab[i] = Math.max(0, 1 - (this.t - this.simT[i]) / 0.8);
    }
    for (let p = 0; p < pix.n; p++) {
      const i = pix.i[p]; const f = this.nf[i]; const thr = pix.thr[p]; if (f < -0.05 && thr > 0.35) continue; // far side: a thinned ghost layer shows through
      const o = i * 9; const dx = pix.x[p]; const dy = pix.y[p]; const X = nr[o] + nr[o + 3] * dx + nr[o + 6] * dy; const Y = nr[o + 1] + nr[o + 4] * dx + nr[o + 7] * dy; const Z = nr[o + 2] + nr[o + 5] * dx + nr[o + 8] * dy; const s = DD / (DD - Z);
      const sx = cx + X * s * k; const sy = cy - Y * s * k; if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
      const n = nodes[i]; let ap = this.app[i];
      if (this.intro < 1 && !this.replay.active) { const thn = (n.slot.th + Math.PI * 2.5) % TAU; ap = clamp((this.intro * (TAU + 1.1) - thn) / 1.1, 0, 1); }
      if (ap <= 0) continue; const al = clamp((ap - thr * 0.85) * 5, 0, 1); if (al <= 0) continue;
      const ff = f > 0 ? 0.32 + 0.68 * Math.min(1, f / 0.5) : 0.1; const psz = psz0 * s * (0.55 + 0.45 * Math.max(0, f)); const dim = dimTable[i];
      if (pix.kind[p] === 1) { pushP(sx, sy, psz * 2.6, RISK[0], RISK[1], RISK[2], 0.8 * al * this.vis[i] * Math.min(1, dim + 0.2) * (f > 0 ? 1 : 0.2), 0.1); continue; }
      const lv = pix.lv[p]; const rel = 0.32 + 0.68 * clamp(n.rel, 0, 1); const shimmer = calm || flat ? 1 : 0.84 + 0.16 * Math.sin(fxT * 0.9 + thr * 18.85 + n.h * 0.001); const boost = 1 + 1.4 * this.sweepF[i] + 1.8 * flashTab[i];
      const level = [0.5, 0.75, 1, 1.35][lv]; const a = clamp(rel * level * 0.7 * al * this.vis[i] * dim * shimmer * boost, 0, 2.1) * ff * this.nlt[i];
      const base = mix(n.color, WARM, 0.06); const c = lv === 3 ? mix(base, [1, 0.96, 0.88], 0.25) : base;
      pushP(sx, sy, psz * [2.3, 2.7, 3.1, 3.8][lv], c[0], c[1], c[2], a * 1.15, 0.12);
    }
    this.pixEnd = np;
    // hovered / pinned glyph: soft halo
    for (const key of [this.hover, this.pinned, this.focus]) if (key?.t === 'ev' && this.nodeOk[key.i] && this.nf[key.i] > 0) { const i = key.i; const c = nodes[i].color; pushP(this.nsx[i], this.nsy[i], this.nrad[i] * 3.4, c[0], c[1], c[2], 0.22, 0.4); }
    this.layerKey = null; // a spinning globe is never a still layer

    // ---- illustrative pipeline (decorative; labelled "illustration" in the legend and HUD): packets fly from each source orbit to a glyph of that source, and arcs link glyphs of one topic.
    // Not live events. The real arrivals are the beams below.
    if (!calm && ov.sats.length) {
      const sim = this.sim ?? (this.sim = { pk: [], arcs: [], tp: 0, ta: 0 }); const T = this.t; const stt = this.stats;
      if (T > sim.tp && sim.pk.length < 36) {
        sim.tp = T + 0.18 + Math.random() * 0.3; let r0 = Math.random() * stt.N; let s = 0; while (s < stt.src.length - 1 && r0 > stt.src[s]) { r0 -= stt.src[s]; s++; }
        const list = this.bySrc[s]; for (let tr = 0; tr < 6 && list?.length; tr++) { const ni = list[(Math.random() * list.length) | 0]; if (this.nodeOk[ni] && this.nf[ni] > 0.12 && this.vis[ni] > 0.5 && this.app[ni] > 0.9) { sim.pk.push({ s, ni, t0: T, dur: 0.9 + Math.random() * 0.6, bend: (Math.random() - 0.5) * 0.6 }); break; } }
      }
      if (T > sim.ta && sim.arcs.length < 5) {
        sim.ta = T + 0.9 + Math.random() * 1.4; const secs = this.sectors.filter(Boolean); const sc2 = secs[(Math.random() * secs.length) | 0]; const list = sc2 && this.byWell[sc2.w];
        if (list && list.length > 3) { const a = list[(Math.random() * list.length) | 0]; const b = list[(Math.random() * list.length) | 0]; if (a !== b && this.nodeOk[a] && this.nodeOk[b]) sim.arcs.push({ a, b, t0: T, dur: 2.8 }); }
      }
      for (let q = sim.pk.length - 1; q >= 0; q--) {
        const pk = sim.pk[q]; const u = (T - pk.t0) / pk.dur; if (u >= 1) { this.simT[pk.ni] = T; sim.pk.splice(q, 1); continue; }
        const sat = ov.sats[pk.s]; if (!sat) continue; const tx = this.nsx[pk.ni]; const ty = this.nsy[pk.ni]; const dx = tx - sat.x; const dy = ty - sat.y; const dl = Math.hypot(dx, dy) || 1; const col = mix(this.srcColors[pk.s] ?? [0.8, 0.8, 0.8], [1, 0.95, 0.85], 0.35);
        const at = (e) => { const bw = Math.sin(e * Math.PI) * pk.bend * dl; return [sat.x + dx * e - (dy / dl) * bw, sat.y + dy * e + (dx / dl) * bw]; };
        const vis = (sat.occ ? 0.3 : 1) * (this.nf[pk.ni] > 0 ? 1 : 0.3); const e = u * u * (3 - 2 * u); let [px, py] = at(Math.max(0, e - 0.2));
        for (let c = 1; c <= 5; c++) { const [qx, qy] = at(Math.max(0, e - 0.2 + (0.2 * c) / 5)); pushL(px, py, 0.5 * (c / 5) * vis, qx, qy, 0.5 * ((c + 1) / 5) * vis, col[0], col[1], col[2]); px = qx; py = qy; }
        pushP(px, py, 9, col[0], col[1], col[2], 0.85 * vis * Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.5 + 0.2), 0.1);
        if (u > 0.9) { const g = (u - 0.9) / 0.1; pushP(tx, ty, this.nrad[pk.ni] * 3 * g, col[0], col[1], col[2], 0.4 * g * vis, 0.3); }
      }
      for (let q = sim.arcs.length - 1; q >= 0; q--) {
        const ar = sim.arcs[q]; const u = (T - ar.t0) / ar.dur; if (u >= 1) { sim.arcs.splice(q, 1); continue; }
        const oa = ar.a * 9; const ob = ar.b * 9; const A0 = [nr[oa], nr[oa + 1], nr[oa + 2]]; const B0 = [nr[ob], nr[ob + 1], nr[ob + 2]]; const head = Math.min(1, u * 2.4); const fadeA = Math.sin(Math.PI * u) ** 0.8 * 0.6; const lift = 0.1 + 0.22 * Math.hypot(A0[0] - B0[0], A0[1] - B0[1], A0[2] - B0[2]) / (2 * R0);
        let px = 0; let py = 0; let pa = 0; const NS = 18;
        for (let c = 0; c <= NS; c++) {
          const v = (c / NS) * head; let X = A0[0] + (B0[0] - A0[0]) * v; let Y = A0[1] + (B0[1] - A0[1]) * v; let Z = A0[2] + (B0[2] - A0[2]) * v; const l = Math.hypot(X, Y, Z) || 1; const rr = (R0 * (1 + lift * Math.sin(Math.PI * v))) / l; X *= rr; Y *= rr; Z *= rr;
          const sp = persp(Z); const x = cx + X * sp * k; const y = cy - Y * sp * k; const a = fadeA * (Z > 0 ? 1 : 0.15) * (c / NS * 0.7 + 0.3); if (c) pushL(px, py, pa, x, y, a, 0.78, 0.96, 0.5); px = x; py = y; pa = a;
          if (c === NS && head > 0.99) pushP(x, y, 12, 0.85, 1, 0.6, fadeA * (Z > 0 ? 1 : 0.2), 0.1);
        }
      }
    }
    // ---- beams: each real arrival (live poll or replay) streaks from its source satellite to the glyph
    for (let q = this.sparks.length - 1; q >= 0; q--) {
      const sp = this.sparks[q]; const u = (this.t - sp.t0) / 0.45; if (u >= 1) { this.sparks.splice(q, 1); continue; } if (u < 0) continue;
      const n = nodes[sp.ni]; if (!this.nodeOk[sp.ni]) continue; const sat = ov.sats[sp.s]; if (!sat) continue;
      const tx = this.nsx[sp.ni]; const ty = this.nsy[sp.ni]; const e = ease(u); const e0 = ease(Math.max(0, u - 0.3));
      const x = sat.x + (tx - sat.x) * e; const y = sat.y + (ty - sat.y) * e; const xt = sat.x + (tx - sat.x) * e0; const yt = sat.y + (ty - sat.y) * e0; const c = mix(n.color, [1, 0.95, 0.8], 0.6);
      pushL(xt, yt, 0, x, y, 1, c[0], c[1], c[2]); pushL(xt, yt, 0, x, y, 0.5, 1, 1, 1); pushP(x, y, 17, c[0], c[1], c[2], 0.9, 0);
      if (u > 0.85) pushP(tx, ty, this.gsize * k * 2.2 * (1 - ((u - 0.85) / 0.15) * 0.3), 1, 0.92, 0.6, 0.5 * (1 - (u - 0.85) / 0.15), 0.3);
    }
    // ---- run beams: working roles -> the run's topic wedge (REAL run events only)
    const sec = this.runWell >= 0 ? this.sectors[this.runWell] : null;
    if (this.activeRun && sec) {
      xf(mS, R0 * Math.cos(sec.mid), 0, R0 * Math.sin(sec.mid)); const sp = persp(O[2]); const tx = cx + O[0] * sp * k; const ty = cy - O[1] * sp * k; const front = O[2] > -0.2 * R0 ? 1 : 0.3;
      for (const r of ov.roles) { if (!r.lit) continue; const col = r.st === 'halted' ? RISK : LIME; const a = (r.st === 'working' ? 0.8 : 0.25) * front; pushL(r.x, r.y, a, tx, ty, a * 0.3, col[0], col[1], col[2]); pushP(r.x, r.y, r.st === 'working' ? 46 : 26, col[0], col[1], col[2], r.st === 'working' ? 0.55 : 0.25, 0.2); if (r.st === 'working' && !calm) for (let q = 0; q < 3; q++) { const u = (this.t * 0.5 + q / 3 + r.i * 0.11) % 1; pushP(r.x + (tx - r.x) * u, r.y + (ty - r.y) * u, 9, col[0], col[1], col[2], 0.9 * Math.sin(u * Math.PI) * front, 0); } }
    }
    // ---- cursor trail + click ripples (decorative)
    for (let q = this.trail.length - 1; q >= 0; q--) { const tr = this.trail[q]; const a = (this.t - tr.t) / 0.7; if (a >= 1) { this.trail.splice(q, 1); continue; } pushP(tr.x, tr.y, 14 * (1 - a) + 4, 1, 0.9, 0.6, 0.38 * (1 - a), 0.2); }
    for (let q = this.ripples.length - 1; q >= 0; q--) {
      const rp = this.ripples[q]; const u = (this.t - rp.t0) / 0.9; if (u >= 1) { this.ripples.splice(q, 1); continue; } const rad = 8 + 90 * ease(u); const a = 0.7 * (1 - u); let ax = rp.x + rad; let ay = rp.y;
      for (let c = 1; c <= 28; c++) { const th = (c / 28) * TAU; const bx = rp.x + Math.cos(th) * rad; const by = rp.y + Math.sin(th) * rad; pushL(ax, ay, a, bx, by, a, 1, 0.92, 0.65); ax = bx; ay = by; }
    }
    // ---- the council star, and the summary streams that carry the evidence story to it
    let topSafe = 0; let bottomSafe = H - 24; for (const r of this.resv ?? []) { if (r.y < H * 0.3) { if (r.x < W / 2 + 360 && r.x + r.w > W / 2 - 360) topSafe = Math.max(topSafe, r.y + r.h); } else if (r.y > H * 0.55) bottomSafe = Math.min(bottomSafe, r.y); } // only what overlaps the centred header counts at the top
    this.council.build({ topSafe, bottomSafe, rightInset: this.rightInset ?? 0, pushP, pushL, cx: coX, cy: coY, k: coK, W, H, T: this.t, calm, main: se > 0.5, fade: 1 });
    { const cry = this.council.cry; const T = this.t; ov.streamCap = null; const GOLDS = [1, 0.8, 0.46]; const CYN = [0.2, 0.92, 1]; const MG = [1, 0.25, 0.8];
      for (const c of cry) {
        const wi = WELLS.indexOf(c.o.topic); const w = ov.wells.find((q) => q.w === wi); if (!w) continue; const share = clamp((w.n / Math.max(1, N)) * 3, 0.15, 1); const boost = c.win ? 1.5 : 1;
        const x0 = w.x; const y0 = w.y; const x1 = c.x; const y1 = c.y; const dx = x1 - x0; const dy = y1 - y0; const dl = Math.hypot(dx, dy) || 1; let nx = -dy / dl; let ny = dx / dl; if (ny > 0) { nx = -nx; ny = -ny; } const lift = Math.min(170, dl * 0.3) * (0.7 + 0.5 * share);
        const qx = (x0 + x1) / 2 + nx * lift; const qy = (y0 + y1) / 2 + ny * lift; const bez = (u) => { const a = (1 - u) * (1 - u); const b = 2 * u * (1 - u); const d = u * u; return [a * x0 + b * qx + d * x1, a * y0 + b * qy + d * y1]; };
        const front = w.z > -0.1 * R0 ? 1 : 0.35; let [px, py] = bez(0);
        for (let q = 1; q <= 26; q++) { const u = q / 26; const [x, y] = bez(u); const col = mix(GOLDS, u < 0.55 ? CYN : MG, u); const al = (0.16 + 0.5 * share) * boost * front * (0.45 + 0.55 * u); pushL(px, py, al, x, y, al, col[0], col[1], col[2]); if (share > 0.45) pushL(px, py + 1.4, al * 0.6, x, y + 1.4, al * 0.6, col[0], col[1], col[2]); px = x; py = y; }
        pushP(x0, y0, 14, GOLDS[0], GOLDS[1], GOLDS[2], 0.45 * front, 0.2);
        if (!calm) { const npk = 2 + Math.round(4 * share); for (let p = 0; p < npk; p++) {
          const u = ((T * (0.13 + 0.14 * share) + p / npk + wi * 0.17) % 1 + 1) % 1; const col = mix(GOLDS, u < 0.55 ? CYN : MG, u);
          for (let j = 0; j < 4; j++) { const [ax, ay] = bez(Math.max(0, u - 0.025 * j)); const [bx, by] = bez(Math.max(0, u - 0.025 * (j + 1))); const al = (1 - j / 4) * 0.8 * front * boost; pushL(ax, ay, al, bx, by, al * 0.6, col[0], col[1], col[2]); }
          const [hx, hy] = bez(u); pushP(hx, hy, 8 + 8 * share, col[0], col[1], col[2], Math.sin(Math.PI * u) * 1.1 * front * boost, 0.1);
          if (u > 0.965 && T - (this.sHit[c.i] ?? -9) > 0.6) { this.sHit[c.i] = T; this.council.hit(c.i, T); }
        } }
        if (c.win) { const [mx, my] = bez(0.5); ov.streamCap = { x: mx, y: my }; }
      } }
    if (sw > 0.01 && sw < 0.99 && !calm) { const u = Math.sin(Math.PI * sw); pushP((cx + coX) / 2, (cy + coY) / 2, 320 * u + 12, 0.75, 0.45, 1, 0.3 * u, 0.5); pushP(coX, coY, 220 * u + 8, 1, 0.3, 0.85, 0.22 * u, 0.5); }
    // ---- marks
    for (const [kind, key] of [['hover', this.hover], ['pinned', this.pinned], ['focus', this.focus]]) { if (!key) continue; const p = this.screenOf(key); if (p && (key.t !== 'ev' || this.nf[key.i] > -0.05)) ov.marks.push({ kind, x: p.x, y: p.y, r: p.r, key }); }
    this.np = np; this.nl = nl;
  }

  /* ------------------------------------------------------------ keys / picking */
  screenOf(key) {
    if (key.t === 'seat' || key.t === 'prod') return this.council.screenOf(key);
    if (key.t === 'body') { const v = key.i === 1 ? this.council.view : this.evView; return v ? { x: v.cx, y: v.cy, r: v.R * 1.6 } : null; }
    if (key.t === 'ev') { if (!this.nodeOk[key.i]) return null; return { x: this.nsx[key.i], y: this.nsy[key.i], r: this.nrad[key.i] }; }
    if (key.t === 'well') { const w = this.ov.wells?.find((q) => q.w === key.i); return w ? { x: w.x, y: w.y, r: 10 } : null; }
    if (key.t === 'src') { const s = this.ov.sats?.[key.i]; return s ? { x: s.x, y: s.y, r: 12 } : null; }
    const r = this.ov.roles?.[key.i]; return r ? { x: r.x, y: r.y, r: 10 } : null;
  }
  pick(x, y, touch) {
    if (!this.model) return null; const slop = touch ? 12 : 4;
    { const cv = this.council.view; const ev = this.evView; const near = (v, m) => v && (v.cx - x) ** 2 + (v.cy - y) ** 2 < (Math.max(m, v.R * 2.1) + slop) ** 2;
      if (this.swap < 0.5) { if (near(cv, 34)) return { t: 'body', i: 1 }; } else { const k2 = this.council.pick(x, y, touch); if (k2) return k2; if (near(ev, 38)) return { t: 'body', i: 0 }; return null; } }
    for (const s of this.ov.sats ?? []) if (!s.occ && (s.x - x) ** 2 + (s.y - y) ** 2 < (14 + slop) ** 2) return { t: 'src', i: s.i };
    for (const r of this.ov.roles ?? []) if (!r.occ && (r.x - x) ** 2 + (r.y - y) ** 2 < (12 + slop) ** 2) return { t: 'role', i: r.i };
    let best = -1; let bd = 1e12; const extra = touch ? 5 : 0;
    for (let i = 0; i < this.nodeOk.length; i++) {
      if (!this.nodeOk[i] || this.nf[i] < 0.06 || this.app[i] < 0.6 || this.vis[i] < 0.5) continue; const r = this.nrad[i] * (0.55 + 0.45 * Math.min(1, this.nf[i] * 2)) + extra; const d = (this.nsx[i] - x) ** 2 + (this.nsy[i] - y) ** 2;
      if (d < r * r && d < bd) { bd = d; best = i; }
    }
    if (best >= 0) return { t: 'ev', i: best };
    for (const p of this.ov.wellPts ?? []) if ((p.x - x) ** 2 + (p.y - y) ** 2 < (9 + slop) ** 2) return { t: 'well', i: p.w };
    return null;
  }
  drawOverlay(ctx, o) { this.resv = o.reserved ?? []; drawSphereOverlay(ctx, this, o); }
  fxExtra() { return 2600; } // headroom for the council star's dots, rings and lane
}

export { WELLS };
