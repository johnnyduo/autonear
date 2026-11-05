// Scene: camera, projection, per-frame draw lists (renderer-agnostic), picking, filters, replay and live-arrival animation.
// Renderers (render-gl.js / render-2d.js) only receive flat typed arrays; overlay.js draws labels and rings from `scene.ov`.
import { WELLS } from './data.js';
import { createNodes, roleRing, sourceAnchors, stepNodes, wellAnchors } from './sim.js';
import { ROLES } from './shared.js';
import { drawOverlay } from './overlay.js';

export const PSTRIDE = 8; // x, y, size(css px), r, g, b, a, blur
export const LSTRIDE = 6; // x, y, r, g, b, a   (two vertices per line)
const LIME = [0.776, 0.957, 0.196]; const RISK = [1, 0.416, 0.239]; const WARN = [0.949, 0.722, 0.294]; const CHALK = [0.925, 0.914, 0.875]; const DIM = [0.55, 0.56, 0.54];
const FOV = Math.tan((46 * Math.PI) / 360); // tan(fov/2)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - (1 - t) ** 3;
const back = (t) => { const c = 1.55; const u = t - 1; return 1 + (c + 1) * u ** 3 + c * u ** 2; };
const REL_COL = { contradicts: RISK, competitor: WARN, usage: LIME, tag: DIM };

export class Scene {
  constructor({ calm = false } = {}) {
    this.kind = 'graph'; this.calm = calm; this.W = 800; this.H = 500; this.t = 0;
    this.cam = { yaw: 0.6, pitch: 0.32, dist: 3.4, tyaw: 0.6, tpitch: 0.32, tdist: 3.4, vyaw: 0, vpitch: 0, px: 0, py: 0, tpx: 0, tpy: 0 };
    this.auto = !calm; this.dragging = false; this.idleSince = 0; this.hold = false;
    this.q = { dust: 700, prov: true, dprMax: 2 };
    this.model = null; this.alpha = 1; this.st = null; this.hover = null; this.pinned = null; this.focus = null;
    this.filter = { srcOff: new Set(), topicOff: new Set() }; this.replay = { active: false, playing: false, pos: 0, speed: 26, mode: 'ingest' };
    this.sparks = []; this.srcFlash = []; this.srcInfo = []; this.roleState = {}; this.runWell = -1; this.activeRun = false;
    this.ov = { wells: [], srcs: [], roles: [], marks: [], flagged: [] };
    this.dust = null; this.maxP = 0; this.settledAt = 0; this.intro = 0; this.birthList = [];
  }

  /* ------------------------------------------------------------ model */
  setModel(model, { announce } = {}) {
    const prev = new Map();
    if (this.model && this.st) this.model.nodes.forEach((n, i) => prev.set(n.id, [this.st.pos[i * 3], this.st.pos[i * 3 + 1], this.st.pos[i * 3 + 2]]));
    const first = !this.model;
    this.model = model;
    if (first) { this.wp = wellAnchors(model); this.sp = sourceAnchors(model.sources.length); }
    else if (this.sp.length / 3 !== model.sources.length) this.sp = sourceAnchors(model.sources.length);
    this.st = createNodes(model, this.wp, this.sp, prev);
    const N = model.nodes.length; const E = N + model.wells.length + model.sources.length + ROLES.length;
    this.E = E; this.sx = new Float32Array(E); this.sy = new Float32Array(E); this.sz = new Float32Array(E); this.ss = new Float32Array(E);
    this.ex = new Float32Array(E); this.ey = new Float32Array(E); this.ez = new Float32Array(E); this.rr = new Float32Array(E); this.ea = new Float32Array(E);
    const oldApp = this.app; const oldVis = this.vis;
    this.app = new Float32Array(N); this.vis = new Float32Array(N).fill(1); this.born = new Float32Array(N).fill(-1);
    model.nodes.forEach((n, i) => { this.vis[i] = 1; this.app[i] = 1; });
    this.index = new Map(model.nodes.map((n, i) => [n.id, i]));
    this.order = model.nodes.map((n, i) => i);
    this.sortReplay();
    this.mask = new Uint8Array(N).fill(1);
    this.maxP = 4096 + this.q.dust; this.P = new Float32Array(this.maxP * PSTRIDE);
    this.maxL = N * 6 + 512; this.L = new Float32Array(this.maxL * 2 * LSTRIDE);
    if (first) {
      this.alpha = 1; this.intro = 0;
      if (this.calm) this.settle(160);
      else model.nodes.forEach((n, i) => { this.app[i] = 0; this.born[i] = this.t + 0.15 + ((n.h % 1000) / 1000) * 0.7; });
    } else {
      this.alpha = Math.max(this.alpha, 0.4);
      model.nodes.forEach((n, i) => { if (this.st.fresh[i]) { this.app[i] = 0; this.born[i] = this.t; this.birthList.push(i); } else if (oldApp) this.app[i] = 1; });
    }
    this.vis = this.vis || oldVis; this.applyFilter();
    this.makeDust();
    return this.birthList.splice(0);
  }
  makeDust() {
    const n = this.q.dust; if (this.dust && this.dust.length === n * 5) return;
    const d = new Float32Array(n * 5); let s = 20260711;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < n; i++) { const r = 1.6 + rnd() * 3.4; const a = rnd() * 6.2832; const y = rnd() * 2 - 1; const q = Math.sqrt(1 - y * y); d[i * 5] = Math.cos(a) * q * r; d[i * 5 + 1] = y * r * 0.8; d[i * 5 + 2] = Math.sin(a) * q * r; d[i * 5 + 3] = rnd(); d[i * 5 + 4] = rnd(); }
    this.dust = d;
  }
  settle(n) { for (let i = 0; i < n; i++) { stepNodes(this.model, this.st, this.wp, this.sp, this.alpha); this.alpha *= 0.96; } this.alpha = 0.001; }
  setQuality(q) { this.q = { ...this.q, ...q }; this.makeDust(); this.maxP = 4096 + this.q.dust; if (this.P.length < this.maxP * PSTRIDE) this.P = new Float32Array(this.maxP * PSTRIDE); }
  resize(W, H) { this.W = W; this.H = H; }
  onResize() { if (!this.sized) { this.cam.tdist = this.cam.dist = this.fitDist(); this.sized = true; } else this.cam.tdist = Math.max(this.cam.tdist, this.fitDist() * 0.6); }
  drawOverlay(ctx, o) { drawOverlay(ctx, this, o); }

  /* ------------------------------------------------------------ state setters */
  setSources(list) { this.srcInfo = list; }
  setRoles(states, oppId, active) { this.roleState = states; this.activeRun = active; this.runWell = oppId ? WELLS.indexOf(String(oppId).replace(/^opp_/, '')) : -1; }
  setFilter(f) { this.filter = f; this.applyFilter(); }
  applyFilter() {
    if (!this.model) return; const { srcOff, topicOff } = this.filter;
    this.visT = this.model.nodes.map((n) => (srcOff.has(this.model.sources[n.src]?.id) || topicOff.has(WELLS[n.primary]) ? 0.06 : 1));
  }
  sortReplay() {
    const nodes = this.model.nodes; const m = this.replay.mode;
    this.order = nodes.map((n, i) => i).sort((a, b) => (m === 'ingest' ? nodes[a].t - nodes[b].t || nodes[a].p - nodes[b].p : nodes[a].p - nodes[b].p || nodes[a].t - nodes[b].t) || (nodes[a].id < nodes[b].id ? -1 : 1));
    this.rank = new Int32Array(nodes.length); this.order.forEach((ni, r) => { this.rank[ni] = r; });
  }
  startReplay(mode = this.replay.mode) { this.replay = { ...this.replay, active: true, playing: true, pos: 0, mode }; this.sortReplay(); this.lastReplayN = 0; this.model.nodes.forEach((n, i) => { this.app[i] = 0; this.born[i] = -1; }); }
  setReplayMode(mode) { const prev = this.replay.pos; this.replay.mode = mode; this.sortReplay(); this.replay.pos = Math.min(prev, this.model.nodes.length); this.lastReplayN = Math.floor(this.replay.pos); this.model.nodes.forEach((n, i) => { const on = this.rank[i] < this.lastReplayN; this.app[i] = on ? 1 : 0; }); }
  stopReplay() { this.replay = { ...this.replay, active: false, playing: false }; this.model.nodes.forEach((n, i) => { this.app[i] = 1; this.born[i] = -1; }); }
  seek(pos) { const N = this.model.nodes.length; const p = clamp(pos, 0, N); this.replay.pos = p; const n = Math.floor(p); this.lastReplayN = n; this.model.nodes.forEach((x, i) => { this.app[i] = this.rank[i] < n ? 1 : 0; this.born[i] = -1; }); }
  replayCurrent() { const n = Math.floor(this.replay.pos); return n > 0 ? this.model.nodes[this.order[Math.min(n, this.model.nodes.length) - 1]] : null; }

  /* ------------------------------------------------------------ camera input */
  drag(dx, dy) { const c = this.cam; c.tyaw += dx * 0.0062; c.tpitch = clamp(c.tpitch + dy * 0.0052, -1.25, 1.25); c.vyaw = dx * 0.0062; c.vpitch = dy * 0.0052; this.idleSince = this.t; }
  zoom(f) { this.cam.tdist = clamp(this.cam.tdist * f, 1.7, 6); this.idleSince = this.t; }
  rotateBy(dy, dp) { this.cam.tyaw += dy; this.cam.tpitch = clamp(this.cam.tpitch + dp, -1.25, 1.25); this.idleSince = this.t; }
  pointer(nx, ny) { this.cam.tpx = nx; this.cam.tpy = ny; }
  resetView() { Object.assign(this.cam, { tyaw: this.cam.yaw % (Math.PI * 2), tpitch: 0.32, tdist: this.fitDist() }); this.idleSince = this.t; }
  fitDist() { const asp = this.W / this.H; return clamp(1.3 / (FOV * Math.min(asp, 1.35)), 2.4, 6); }

  /* ------------------------------------------------------------ frame */
  frame(now, dt, nowMs) {
    const m = this.model; if (!m) return;
    this.t = now; const calm = this.calm; const c = this.cam;
    // sim: settles in ~1.5 s, then stays still (ambient motion is analytic wobble, not physics)
    if (this.alpha > 0.012) { const it = dt > 0.026 ? 2 : 1; for (let k = 0; k < it; k++) { stepNodes(m, this.st, this.wp, this.sp, this.alpha); this.alpha *= 0.955; } }
    // replay clock
    const rp = this.replay; const N = m.nodes.length;
    if (rp.active) {
      if (rp.playing) { rp.pos = Math.min(N, rp.pos + rp.speed * dt); if (rp.pos >= N) rp.playing = false; }
      const n = Math.floor(rp.pos);
      for (let r = this.lastReplayN ?? 0; r < n; r++) { const ni = this.order[r]; if (this.app[ni] === 0 && this.born[ni] < 0) { this.born[ni] = now; this.spark(ni, now, true); } }
      this.lastReplayN = n;
    }
    // camera
    if (this.auto && !calm && !this.dragging && !this.pinned && !this.hold && now - this.idleSince > 1.2) c.tyaw += 0.05 * dt;
    if (!this.dragging && !calm) { c.tyaw += c.vyaw; c.tpitch = clamp(c.tpitch + c.vpitch, -1.25, 1.25); c.vyaw *= 0.93; c.vpitch *= 0.9; }
    const k = calm ? 1 : 1 - Math.exp(-dt * 7); c.yaw += (c.tyaw - c.yaw) * k; c.pitch += (c.tpitch - c.pitch) * k; c.dist += (c.tdist - c.dist) * k; c.px += (c.tpx - c.px) * k * 0.5; c.py += (c.tpy - c.py) * k * 0.5;
    this.intro = calm ? 1 : Math.min(1, this.intro + dt / 2.6);
    this.project(now);
    this.build(now, dt, nowMs);
  }

  project(now) {
    const m = this.model; const N = m.nodes.length; const Wn = m.wells.length; const S = m.sources.length; const c = this.cam;
    const calm = this.calm; const pos = this.st.pos;
    const yaw = c.yaw + c.px * 0.07; const pitch = c.pitch - c.py * 0.045; const dist = c.dist * (1 + (1 - ease(this.intro)) * 0.28);
    this._yaw = yaw; this._pitch = pitch; this._dist = dist;
    const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pitch); const sp = Math.sin(pitch);
    const focal = (0.5 * this.H) / FOV; const cx = this.W / 2; const cyy = this.H / 2 + (this.W < 640 ? -this.H * 0.02 : 0);
    this._focal = focal; this.ref = focal / this.fitDist();
    const put = (e, x, y, z, rad) => {
      this.ex[e] = x; this.ey[e] = y; this.ez[e] = z;
      const x1 = x * cy + z * sy; const z1 = -x * sy + z * cy; const y2 = y * cp - z1 * sp; const z2 = y * sp + z1 * cp; const zc = z2 + dist;
      const kk = focal / Math.max(0.2, zc); this.sx[e] = cx + x1 * kk; this.sy[e] = cyy - y2 * kk; this.sz[e] = zc; this.ss[e] = kk; this.rr[e] = rad;
    };
    const wob = calm ? 0 : 0.0075;
    for (let i = 0; i < N; i++) {
      const n = m.nodes[i]; const p = pos[i * 3]; const ph = n.h * 0.0001;
      put(i, p + wob * Math.sin(now * 0.45 + ph), pos[i * 3 + 1] + wob * Math.sin(now * 0.37 + ph * 1.7), pos[i * 3 + 2] + wob * Math.sin(now * 0.41 + ph * 2.3), 0);
    }
    for (let w = 0; w < Wn; w++) put(N + w, this.wp[w * 3], this.wp[w * 3 + 1], this.wp[w * 3 + 2], 0);
    for (let s = 0; s < S; s++) put(N + Wn + s, this.sp[s * 3], this.sp[s * 3 + 1] + (calm ? 0 : 0.012 * Math.sin(now * 0.6 + s * 2)), this.sp[s * 3 + 2], 0);
    for (let r = 0; r < ROLES.length; r++) { const p = roleRing(r, ROLES.length, calm ? 0 : now); put(N + Wn + S + r, p[0], p[1], p[2], 0); }
  }

  spark(ni, now, replay) {
    const s = this.model.nodes[ni].src; if (this.sparks.length > 160) this.sparks.shift();
    this.sparks.push({ ni, s, t0: now });
    if (now - (this.srcFlash[s]?.t ?? -9) > 0.38) this.srcFlash[s] = { t: now, replay: Boolean(replay) };
  }

  build(now, dt) {
    const m = this.model; const N = m.nodes.length; const Wn = m.wells.length; const S = m.sources.length;
    const P = this.P; let np = 0; const L = this.L; let nl = 0; const calm = this.calm;
    const dist = this._dist; const ref = this.ref; const fgR = 1.25;
    const depthA = (z) => 1 - 0.62 * clamp((z - (dist - fgR)) / (2 * fgR), 0, 1);
    const blurOf = (z) => { const d = Math.abs(z - dist) / 1.5; return clamp(d * d * 0.95, 0, 0.92); };
    const pushP = (x, y, size, r, g, b, a, bl) => { if (np >= this.maxP || a <= 0.002) return; const o = np * PSTRIDE; P[o] = x; P[o + 1] = y; P[o + 2] = size; P[o + 3] = r; P[o + 4] = g; P[o + 5] = b; P[o + 6] = a; P[o + 7] = bl; np++; };
    const pushL = (x1, y1, a1, x2, y2, a2, r, g, b) => { if (nl >= this.maxL || (a1 <= 0.002 && a2 <= 0.002)) return; const o = nl * 2 * LSTRIDE; L[o] = x1; L[o + 1] = y1; L[o + 2] = r; L[o + 3] = g; L[o + 4] = b; L[o + 5] = a1; L[o + 6] = x2; L[o + 7] = y2; L[o + 8] = r; L[o + 9] = g; L[o + 10] = b; L[o + 11] = a2; nl++; };

    // focus set (hover > pinned): highlighted nodes stay bright, the rest recede
    const fk = this.hover ?? this.pinned ?? this.focus; const mask = this.mask; let focusing = false; let fNode = -1; let fWell = -1; let fSrc = -1; let fRole = -1;
    if (fk) {
      focusing = true; mask.fill(0);
      if (fk.t === 'ev') { fNode = fk.i; mask[fk.i] = 1; fSrc = m.nodes[fk.i].src; }
      else if (fk.t === 'well') { fWell = fk.i; m.nodes.forEach((n, i) => { if (n.wells.some((l) => l.w === fk.i)) mask[i] = 1; }); }
      else if (fk.t === 'src') { fSrc = fk.i; m.nodes.forEach((n, i) => { if (n.src === fk.i) mask[i] = 1; }); }
      else { fRole = fk.i; mask.fill(1); focusing = false; }
    }

    // ---- dust (decorative; not data)
    const yawD = this._yaw * 0.55; const pitD = this._pitch * 0.55; const cyd = Math.cos(yawD); const syd = Math.sin(yawD); const cpd = Math.cos(pitD); const spd = Math.sin(pitD);
    const focal = this._focal; const drift = calm ? 0 : this.t * 0.012;
    const nd = this.q.dust; const D = this.dust;
    for (let i = 0; i < nd; i++) {
      const o = i * 5; const ang = drift * (0.4 + D[o + 3]); const ca = Math.cos(ang); const sa = Math.sin(ang);
      const x0 = D[o] * ca + D[o + 2] * sa; const z0 = -D[o] * sa + D[o + 2] * ca; const y0 = D[o + 1];
      const x1 = x0 * cyd + z0 * syd; const z1 = -x0 * syd + z0 * cyd; const y2 = y0 * cpd - z1 * spd; const z2 = y0 * spd + z1 * cpd + dist;
      if (z2 < 0.4) continue; const kk = focal / z2; const x = this.W / 2 + x1 * kk; const y = this.H / 2 - y2 * kk;
      if (x < -20 || y < -20 || x > this.W + 20 || y > this.H + 20) continue;
      const tw = calm ? 1 : 0.72 + 0.28 * Math.sin(this.t * 0.35 + D[o + 4] * 40); // slow shimmer, far below 3 Hz
      const near = clamp(1.4 - z2 / 6, 0.15, 1); const sz = 1.2 + D[o + 3] * 2.2 * (kk / ref) * 0.45;
      pushP(x, y, sz * 2.4, 0.78, 0.82, 0.9, (0.1 + 0.2 * D[o + 4]) * tw * near, clamp(1 - near, 0, 0.7));
    }

    // ---- edges
    const sOff = N + Wn; const rolesBase = N + Wn + S;
    const hl = (i) => (focusing ? mask[i] : 1);
    let fEdge = 0;
    for (let i = 0; i < N; i++) {
      const n = m.nodes[i]; const ap = this.app[i]; if (ap <= 0.01) continue;
      const v = this.vis[i]; const hot = focusing && (i === fNode);
      const dim = focusing ? (mask[i] ? 1 : 0.28) : 1;
      const za = depthA(this.sz[i]);
      const nx = this.sx[i]; const ny = this.sy[i];
      for (const lk of n.wells) {
        const w = N + lk.w; const col = lk.rel === 'supports' ? n.color : REL_COL[lk.rel] ?? n.color; const strong = lk.rel === 'contradicts' || lk.rel === 'competitor' || lk.rel === 'usage';
        let a = (strong ? 0.2 : 0.085) * v * ap * za * dim; if (hot || (fWell === lk.w && mask[i])) a = Math.max(a, strong ? 0.75 : 0.5) * v;
        pushL(nx, ny, a, this.sx[w], this.sy[w], a * 0.25, col[0], col[1], col[2]);
      }
      if (this.q.prov || hot || (fSrc === n.src && mask[i])) {
        const s = sOff + n.src; let a = 0.02 * v * ap * dim; if (hot || (fSrc === n.src && mask[i] && focusing)) a = 0.4 * v;
        pushL(this.sx[s], this.sy[s], a * 1.7, nx, ny, a * 0.5, n.color[0], n.color[1], n.color[2]);
        if (hot) fEdge++;
      }
    }
    // active-run beams: role -> the run's opportunity hub (only while real run events say the role is working / done / halted)
    if (this.activeRun && this.runWell >= 0) {
      ROLES.forEach(([rid], r) => {
        const st = this.roleState[rid] ?? 'idle'; if (st === 'idle') return; const e = rolesBase + r; const w = N + this.runWell;
        const col = st === 'halted' ? RISK : LIME; const a = st === 'working' ? 0.8 : 0.28;
        pushL(this.sx[e], this.sy[e], a, this.sx[w], this.sy[w], a * 0.5, col[0], col[1], col[2]);
        if (st === 'working' && !calm) for (let q = 0; q < 3; q++) { const u = ((this.t * 0.45 + q / 3 + r * 0.13) % 1); pushP(this.sx[e] + (this.sx[w] - this.sx[e]) * u, this.sy[e] + (this.sy[w] - this.sy[e]) * u, 9, col[0], col[1], col[2], 0.9 * Math.sin(u * Math.PI), 0); }
      });
    }

    // ---- nodes
    const flagged = this.ov.flagged; flagged.length = 0;
    for (let i = 0; i < N; i++) {
      const n = m.nodes[i];
      // born / appear animation
      if (this.born[i] >= 0 && this.app[i] < 1) { const u = (this.t - this.born[i]) / (n.fresh ? 1 : 0.95); this.app[i] = u <= 0 ? 0 : clamp(u, 0, 1); if (u >= 1) this.born[i] = -1; }
      const ap = this.app[i]; if (ap <= 0.001) continue;
      const vt = this.visT[i]; this.vis[i] += (vt - this.vis[i]) * Math.min(1, dt * 9);
      const v = this.vis[i]; const dim = focusing ? (mask[i] ? 1 : 0.3) : 1;
      const z = this.sz[i]; const u = this.ss[i] / ref; const bl = blurOf(z);
      const sc = back(ap) * (0.35 + 0.65 * ap);
      const core = (1.5 + 2.7 * n.rel) * u * sc * (v < 0.5 ? 0.7 : 1);
      let a = 0.95 * depthA(z) * v * dim * Math.min(1, ap * 1.6);
      const hot = i === fNode || (this.pinned?.t === 'ev' && this.pinned.i === i);
      const col = n.color;
      pushP(this.sx[i], this.sy[i], core * 2 * 3.2 * (hot ? 1.5 : 1), col[0], col[1], col[2], a * 0.62, bl);
      this.rr[i] = core;
      if (n.flagged && v > 0.5) flagged.push({ x: this.sx[i], y: this.sy[i], r: core + 3.5 * u + 1.5, a: Math.min(1, depthA(z) * dim * ap) });
      if (ap < 1 && this.born[i] >= 0 && ap > 0.02) pushP(this.sx[i], this.sy[i], core * 2 * 9 * (1 - ap * 0.4), 0.78, 0.96, 0.2, 0.55 * (1 - ap), 0); // arrival bloom
    }

    // ---- sparks (a real arrival: a provenance pulse travelling from its source emitter to the new record)
    for (let k = this.sparks.length - 1; k >= 0; k--) {
      const sp = this.sparks[k]; const u = (this.t - sp.t0) / 0.75; if (u >= 1) { this.sparks.splice(k, 1); continue; } if (u < 0) continue;
      const i = sp.ni; const s = sOff + sp.s; const e = ease(u);
      const x = this.sx[s] + (this.sx[i] - this.sx[s]) * e; const y = this.sy[s] + (this.sy[i] - this.sy[s]) * e;
      const e0 = ease(Math.max(0, u - 0.18)); const x0 = this.sx[s] + (this.sx[i] - this.sx[s]) * e0; const y0 = this.sy[s] + (this.sy[i] - this.sy[s]) * e0;
      pushL(x0, y0, 0, x, y, 0.9, 0.78, 0.96, 0.2); pushP(x, y, 15, 0.86, 1, 0.5, 0.95 * Math.sin(Math.min(1, u * 1.1) * Math.PI * 0.9 + 0.3), 0);
    }

    // ---- hubs (wells)
    const ov = this.ov; ov.wells.length = 0; ov.srcs.length = 0; ov.roles.length = 0; ov.marks.length = 0;
    for (let w = 0; w < Wn; w++) {
      const e = N + w; const z = this.sz[e]; const u = this.ss[e] / ref; const wl = m.wells[w]; const da = depthA(z);
      const dimW = focusing ? ((fWell === w || (fNode >= 0 && m.nodes[fNode].wells.some((l) => l.w === w))) ? 1 : 0.4) : 1;
      const visible = !this.filter.topicOff.has(WELLS[w]);
      const bright = (wl.opp ? 1 : 0.55) * (visible ? 1 : 0.3);
      const pulse = calm ? 1 : 1 + 0.06 * Math.sin(this.t * 0.9 + w * 1.3);
      const size = (wl.opp ? 62 : 44) * u * pulse;
      pushP(this.sx[e], this.sy[e], size, 0.93, 0.92, 0.82, 0.38 * da * dimW * bright, blurOf(z) * 0.5);
      pushP(this.sx[e], this.sy[e], size * 0.32, 1, 1, 0.95, 0.9 * da * dimW * bright, 0);
      this.rr[e] = (wl.opp ? 17 : 12) * u;
      ov.wells.push({ i: w, x: this.sx[e], y: this.sy[e], r: this.rr[e], u, a: da * dimW * (visible ? 1 : 0.4), wl, z });
    }
    // ---- sources (emitters)
    for (let s = 0; s < S; s++) {
      const e = sOff + s; const z = this.sz[e]; const u = this.ss[e] / ref; const info = this.srcInfo[s] ?? {}; const col = m.nodes.find((n) => n.src === s)?.color ?? [0.7, 0.7, 0.7];
      const off = this.filter.srcOff.has(m.sources[s].id); const recent = Boolean(info.recent);
      const dimS = focusing ? (fSrc === s || (fNode >= 0 && m.nodes[fNode].src === s) ? 1 : 0.45) : 1; const base = (off ? 0.25 : 1) * dimS * depthA(z);
      const fl = this.srcFlash[s]; const flash = fl && !calm ? Math.max(0, 1 - (this.t - fl.t) / 0.6) : 0;
      pushP(this.sx[e], this.sy[e], (recent ? 64 : 46) * u * (1 + flash * 0.5), col[0], col[1], col[2], (recent ? 0.5 : 0.28) * base + flash * 0.4, blurOf(z) * 0.4);
      pushP(this.sx[e], this.sy[e], 15 * u, 1, 1, 1, 0.95 * base, 0);
      this.rr[e] = 12 * u;
      ov.srcs.push({ i: s, x: this.sx[e], y: this.sy[e], r: this.rr[e], u, col, info, a: base, flash, fl });
    }
    // ---- agent roles (orbiting; lit only by real run events)
    for (let r = 0; r < ROLES.length; r++) {
      const e = rolesBase + r; const z = this.sz[e]; const u = this.ss[e] / ref; const st = this.activeRun ? this.roleState[ROLES[r][0]] ?? 'idle' : 'idle';
      const lit = st !== 'idle'; const col = st === 'halted' ? RISK : LIME;
      if (lit) pushP(this.sx[e], this.sy[e], (st === 'working' ? 54 : 34) * u, col[0], col[1], col[2], st === 'working' ? 0.55 : 0.28, blurOf(z) * 0.3);
      this.rr[e] = 8 * u;
      ov.roles.push({ i: r, x: this.sx[e], y: this.sy[e], r: this.rr[e], u, st, lit, a: depthA(z), role: ROLES[r], z });
    }
    // ---- marks (hover / pinned / keyboard focus)
    for (const [kind, key] of [['hover', this.hover], ['pinned', this.pinned], ['focus', this.focus]]) {
      const e = key && this.entityOf(key); if (e === null || e === undefined) continue;
      ov.marks.push({ kind, x: this.sx[e], y: this.sy[e], r: Math.max(9, this.rr[e] + 7), key });
    }
    this.np = np; this.nl = nl;
  }

  /* ------------------------------------------------------------ keys / picking */
  entityOf(k) {
    const N = this.model.nodes.length; const Wn = this.model.wells.length; const S = this.model.sources.length;
    return k.t === 'ev' ? k.i : k.t === 'well' ? N + k.i : k.t === 'src' ? N + Wn + k.i : N + Wn + S + k.i;
  }
  keyOf(e) {
    const N = this.model.nodes.length; const Wn = this.model.wells.length; const S = this.model.sources.length;
    return e < N ? { t: 'ev', i: e } : e < N + Wn ? { t: 'well', i: e - N } : e < N + Wn + S ? { t: 'src', i: e - N - Wn } : { t: 'role', i: e - N - Wn - S };
  }
  screenOf(key) { const e = this.entityOf(key); return { x: this.sx[e], y: this.sy[e], r: this.rr[e] }; }
  pick(x, y, touch) {
    if (!this.model) return null; const N = this.model.nodes.length; let best = -1; let bd = 1e9;
    const slop = touch ? 14 : 5;
    for (let e = 0; e < this.E; e++) {
      if (e < N && (this.app[e] < 0.6 || this.vis[e] < 0.5)) continue;
      const dx = this.sx[e] - x; const dy = this.sy[e] - y; const rad = Math.max(e < N ? 6 : 14, this.rr[e] + slop);
      const d2 = dx * dx + dy * dy; if (d2 > rad * rad) continue;
      const score = d2 / (rad * rad) + (this.sz[e] - this._dist) * 0.05 + (e < N ? 0 : -0.15); // prefer hubs/sources over a node under them
      if (score < bd) { bd = score; best = e; }
    }
    return best < 0 ? null : this.keyOf(best);
  }
}
