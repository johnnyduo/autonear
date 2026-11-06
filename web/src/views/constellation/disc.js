// Pixel-disc scene (primary hero). Every stored evidence record becomes a 9x9 pixel glyph derived from its REAL content hash
// (sha256 of the stored content, exposed as `content_hash`); glyphs are packed in a circular dot-matrix disc, one sector per topic.
// Glyph colour = source, brightness = NEAR relevance, a red pixel ring marks bot / duplicate / injection flags.
// Orbit rings = the sources (satellite angle = UTC time of day of that source's last real ingest); beams fire only on real arrivals / replay.
import { hash32, WELLS, WELL_SHORT } from './data.js';
import { ROLES } from './shared.js';
import { PSTRIDE, LSTRIDE } from './scene.js';
import { drawDiscOverlay } from './overlay-disc.js';
import { buildFx, fxBudget } from './fx-disc.js';
import { buildFlow, flowBudget } from './fx-flow.js';

export const R0 = 300; export const G = 9;
/** Source orbit s as a tilted ellipse in disc radii: flat enough that nine of them still fit a 16:10 stage. */
export const orbitShape = (s) => { const a = 1.5 + 0.085 * s; return { a, b: a * (0.58 + 0.01 * s), phi: [-0.2, 0.15, -0.1, 0.22][s % 4] }; };
const WARM = [1, 0.8, 0.46]; const LIME = [0.776, 0.957, 0.196]; const RISK = [1, 0.416, 0.239];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - (1 - t) ** 3;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 32 bytes: the record's content_hash when present, else a fingerprint of title + url + observed_at (labelled as such in the card). */
export function fingerprint(e) {
  if (/^[0-9a-f]{64}$/.test(e.content_hash ?? '')) return { bytes: Uint8Array.from(e.content_hash.match(/../g), (h) => parseInt(h, 16)), real: true };
  const s = `${e.title}|${e.canonical_url}|${e.observed_at}`; const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { const h = hash32(`${i}:${s}`); out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 255; out[i * 4 + 2] = (h >>> 8) & 255; out[i * 4 + 3] = h & 255; }
  return { bytes: out, real: false };
}
const bit = (b, k) => (b[k >> 3] >> (k & 7)) & 1;

/** 9x9 left-right symmetric glyph: 45 hash bits choose lit pixels (centre column biased on by a second bit), 90 more bits set per-pixel intensity. */
export function glyphPixels(bytes) {
  const out = [];
  for (let r = 0; r < G; r++) for (let c = 0; c < 5; c++) {
    const k = r * 5 + c; let on = bit(bytes, k); if (c === 4) on |= bit(bytes, 45 + k);
    if (!on) continue; const lv = bit(bytes, 90 + k * 2) * 2 + bit(bytes, 91 + k * 2);
    out.push([c, r, lv]); if (c < 4) out.push([G - 1 - c, r, lv]);
  }
  return out;
}

export class DiscScene {
  constructor({ calm = false } = {}) {
    this.kind = 'disc'; this.calm = calm; this.W = 800; this.H = 500; this.t = 0; this.model = null;
    this.cam = { zoom: 1, tzoom: 1, px: 0, py: 0, tpx: 0, tpy: 0, par: [0, 0], tpar: [0, 0] };
    this.auto = !calm; this.dragging = false; this.hover = null; this.pinned = null; this.focus = null; this.hold = false;
    this.q = { dust: 600, prov: true, fx: 1 }; this.fxT = 0; this.ripples = []; this.trail = []; this.ptr = null; this.sweepF = new Float32Array(0); this.flowF = new Float32Array(0); this.flowPairs = []; this.flowMax = 1; this.srcColors = []; this.fkKey = ''; this.fkT = 0; this.lastTrail = null; this.filter = { srcOff: new Set(), topicOff: new Set() };
    this.replay = { active: false, playing: false, pos: 0, speed: 26, mode: 'ingest' };
    this.sparks = []; this.srcFlash = []; this.srcInfo = []; this.roleState = {}; this.runWell = -1; this.activeRun = false;
    this.ov = {}; this.stats = null; this.intro = 0; this.idleSince = 0; this.stars = null; this.labelState = new Map();
  }

  /* ------------------------------------------------------------ model & layout */
  setModel(model) {
    const first = !this.model; const oldApp = this.app; const oldIds = this.model?.nodes.map((n) => n.id);
    this.model = model; const nodes = model.nodes; const N = nodes.length;
    this.fit = null; this.layout();
    const prev = new Map(); if (oldIds && oldApp) oldIds.forEach((id, i) => prev.set(id, oldApp[i]));
    this.app = new Float32Array(N); this.vis = new Float32Array(N).fill(1); this.visT = new Float32Array(N).fill(1); this.born = new Float32Array(N).fill(-1); this.mask = new Uint8Array(N).fill(1);
    const births = [];
    nodes.forEach((n, i) => { if (!first && !prev.has(n.id)) { this.app[i] = 0; this.born[i] = this.t; births.push(i); } else this.app[i] = 1; });
    if (first && !this.calm) this.intro = 0; else this.intro = 1;
    this.index = new Map(nodes.map((n, i) => [n.id, i]));
    this.sortReplay(); this.applyFilter(); this.computeStats(); this.makeStars();
    this.sweepF = new Float32Array(N); this.flowF = new Float32Array(N);
    this.maxP = this.pix.n + 4096 + this.q.dust + this.fxExtra(); this.P = new Float32Array(this.maxP * PSTRIDE);
    this.maxL = 8192; this.L = new Float32Array(this.maxL * 2 * LSTRIDE);
    return births;
  }

  layout() {
    const m = this.model; const nodes = m.nodes; const N = nodes.length; const Wn = m.wells.length;
    const by = Array.from({ length: Wn }, () => []); nodes.forEach((n, i) => by[n.primary].push(i));
    const live = by.map((l, w) => [w, l.length]).filter(([, c]) => c > 0); const K = live.length; const gap = K > 1 ? 0.05 : 0;
    const total = Math.PI * 2 - gap * K; this.sectors = new Array(Wn).fill(null); let a = -Math.PI / 2 + gap / 2;
    for (const [w, c] of live) { const span = (total * c) / N; this.sectors[w] = { w, a0: a, a1: a + span, mid: a + span / 2, n: c }; a += span + gap; }
    // pitch: largest ring spacing at which every sector's rings can hold its records
    const rho0 = R0 * 0.27; let pitch = 40; let rings;
    const ringsFor = (p) => { const rs = []; for (let r = rho0 + p / 2; r <= R0 - p / 2 + 0.01; r += p) rs.push(r); return rs; };
    for (; pitch > 5; pitch -= 0.25) {
      rings = ringsFor(pitch); let ok = true;
      for (const [w, c] of live) { const sp = this.sectors[w].a1 - this.sectors[w].a0 - 0.02; let cap = 0; for (const r of rings) cap += Math.max(1, Math.floor((r * sp) / pitch)); if (cap < c) { ok = false; break; } }
      if (ok) break;
    }
    this.pitch = pitch; this.gsize = pitch * 0.9; this.pu = this.gsize / G; this.rings = rings;
    nodes.forEach((n, i) => { n.slot = null; });
    for (const [w, c] of live) {
      const sec = this.sectors[w]; const sp = sec.a1 - sec.a0 - 0.02; const caps = rings.map((r) => Math.max(1, Math.floor((r * sp) / pitch))); const capSum = caps.reduce((x, y) => x + y, 0);
      // distribute records over rings in proportion to ring capacity (largest remainder), so every sector reaches the rim
      const raw = caps.map((k) => (c * k) / capSum); const cnt = raw.map(Math.floor); let rem = c - cnt.reduce((x, y) => x + y, 0);
      raw.map((v, j) => [v - Math.floor(v), j]).sort((x, y) => y[0] - x[0]).forEach(([, j]) => { if (rem > 0 && cnt[j] < caps[j]) { cnt[j]++; rem--; } });
      const order = by[w].slice().sort((x, y) => nodes[x].p - nodes[y].p || (nodes[x].id < nodes[y].id ? -1 : 1)); // oldest at the core, newest at the rim
      let k = 0;
      rings.forEach((r, j) => { for (let s = 0; s < cnt[j] && k < order.length; s++, k++) { const th = sec.a0 + 0.01 + ((s + 0.5) / cnt[j]) * sp; nodes[order[k]].slot = { x: Math.cos(th) * r, y: Math.sin(th) * r, th, r }; } });
      for (; k < order.length; k++) { const r = rings[rings.length - 1]; nodes[order[k]].slot = { x: Math.cos(sec.mid) * r, y: Math.sin(sec.mid) * r, th: sec.mid, r }; }
    }
    // pixels
    const px = []; const fp = nodes.map((n) => fingerprint(n.e)); this.fp = fp;
    nodes.forEach((n, i) => {
      if (!n.slot) return; const gp = glyphPixels(fp[i].bytes); const u = this.pu; n.npix = gp.length;
      for (const [c, r, lv] of gp) px.push([n.slot.x + (c - 4) * u, n.slot.y + (r - 4) * u, i, lv, ((hash32(`${n.id}:${c}:${r}`) % 1000) / 1000), 0]);
      if (n.flagged) { // red pixel ring around the glyph
        const h = 5; for (let k = -h; k <= h; k++) for (const [cx, cy] of [[k, -h], [k, h], [-h, k], [h, k]]) { if ((cx + cy + h) % 2) continue; px.push([n.slot.x + cx * u * 0.92, n.slot.y + cy * u * 0.92, i, 3, 0.3, 1]); }
      }
    });
    const n = px.length; const pix = { n, x: new Float32Array(n), y: new Float32Array(n), i: new Int32Array(n), lv: new Uint8Array(n), thr: new Float32Array(n), kind: new Uint8Array(n) };
    px.forEach((p, k) => { pix.x[k] = p[0]; pix.y[k] = p[1]; pix.i[k] = p[2]; pix.lv[k] = p[3]; pix.thr[k] = p[4]; pix.kind[k] = p[5]; });
    this.pix = pix;
  }

  makeStars() {
    if (this.stars) return; let s = 7711; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const n = 520; const st = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { st[i * 6] = rnd(); st[i * 6 + 1] = rnd(); st[i * 6 + 2] = 0.2 + rnd() * 0.8; st[i * 6 + 3] = rnd(); st[i * 6 + 4] = rnd() * 40; st[i * 6 + 5] = rnd() < 0.05 ? 1 : 0; }
    this.stars = st;
  }

  computeStats() {
    const m = this.model; const N = m.nodes.length || 1; const src = new Array(m.sources.length).fill(0); let fl = 0; let rel = 0; let hi = 0;
    for (const n of m.nodes) { src[n.src]++; if (n.flagged) fl++; rel += n.rel; if (n.rel >= 0.95) hi++; }
    let top = -1; m.wells.forEach((w, i) => { if (w.opp && (top < 0 || w.opp.score > m.wells[top].opp.score)) top = i; });
    this.stats = { N, src, flagged: fl, meanRel: rel / N, high: hi / N, top };
    const cnt = new Map(); this.srcColors = m.sources.map(() => null);
    for (const n of m.nodes) { const kk = n.src * 8 + n.primary; cnt.set(kk, (cnt.get(kk) ?? 0) + 1); if (!this.srcColors[n.src]) this.srcColors[n.src] = n.color; }
    this.flowPairs = [...cnt].map(([kk, c]) => ({ s: Math.floor(kk / 8), w: kk % 8, c })).sort((a, b) => a.s - b.s || a.w - b.w); this.flowMax = Math.max(1, ...this.flowPairs.map((p) => p.c));
  }

  /* ------------------------------------------------------------ setters (same surface as scene.js) */
  setSources(list) { this.srcInfo = list; }
  setRoles(states, oppId, active) { this.roleState = states; this.activeRun = active; this.runWell = oppId ? WELLS.indexOf(String(oppId).replace(/^opp_/, '')) : -1; }
  setFilter(f) { this.filter = f; this.applyFilter(); }
  applyFilter() { if (!this.model) return; const { srcOff, topicOff } = this.filter; this.model.nodes.forEach((n, i) => { this.visT[i] = srcOff.has(this.model.sources[n.src]?.id) || topicOff.has(WELLS[n.primary]) ? 0.07 : 1; }); }
  fxExtra() { return fxBudget(this.q.fx) + flowBudget(this.q.fx); }
  setQuality(q) { this.q = { ...this.q, ...q }; if (this.model) { const need = this.pix.n + 4096 + this.q.dust + this.fxExtra(); if (this.P.length < need * PSTRIDE) { this.maxP = need; this.P = new Float32Array(need * PSTRIDE); } } }
  settle() {}
  resize(W, H) { this.W = W; this.H = H; this.fit = null; }
  onResize() { this.sized = true; }
  drawOverlay(ctx, o) { drawDiscOverlay(ctx, this, o); }
  sortReplay() {
    const nodes = this.model.nodes; const md = this.replay.mode;
    this.order = nodes.map((n, i) => i).sort((a, b) => (md === 'ingest' ? nodes[a].t - nodes[b].t || nodes[a].p - nodes[b].p : nodes[a].p - nodes[b].p || nodes[a].t - nodes[b].t) || (nodes[a].id < nodes[b].id ? -1 : 1));
    this.rank = new Int32Array(nodes.length); this.order.forEach((ni, r) => { this.rank[ni] = r; });
  }
  startReplay(mode = this.replay.mode) { this.replay = { ...this.replay, active: true, playing: true, pos: 0, mode }; this.sortReplay(); this.lastReplayN = 0; this.model.nodes.forEach((n, i) => { this.app[i] = 0; this.born[i] = -1; }); this.sparks.length = 0; }
  setReplayMode(mode) { const prev = this.replay.pos; this.replay.mode = mode; this.sortReplay(); this.lastReplayN = Math.floor(prev); this.model.nodes.forEach((n, i) => { this.app[i] = this.rank[i] < this.lastReplayN ? 1 : 0; this.born[i] = -1; }); }
  stopReplay() { this.replay = { ...this.replay, active: false, playing: false }; this.model.nodes.forEach((n, i) => { this.app[i] = 1; this.born[i] = -1; }); }
  seek(pos) { const N = this.model.nodes.length; const p = clamp(pos, 0, N); this.replay.pos = p; const n = Math.floor(p); this.lastReplayN = n; this.model.nodes.forEach((x, i) => { this.app[i] = this.rank[i] < n ? 1 : 0; this.born[i] = -1; }); this.sparks.length = 0; }
  replayCurrent() { const n = Math.floor(this.replay.pos); return n > 0 ? this.model.nodes[this.order[Math.min(n, this.model.nodes.length) - 1]] : null; }
  spark(ni, now, replay) { const s = this.model.nodes[ni].src; if (this.sparks.length > 220) this.sparks.shift(); this.sparks.push({ ni, s, t0: now }); if (now - (this.srcFlash[s]?.t ?? -9) > 0.38) this.srcFlash[s] = { t: now, replay: Boolean(replay) }; }

  ripple(x, y) { if (!this.calm) { if (this.ripples.length > 6) this.ripples.shift(); this.ripples.push({ x, y, t0: this.t }); } }

  /* ------------------------------------------------------------ camera: zoom + pan (+ mouse parallax for the starfield) */
  fitDist() { return 1; }
  /**
   * Layout fit. The whole system (disc + every source orbit + the agent-role ring) must stay inside the stage: the extents of the tilted ellipses are measured in disc radii, then the
   * disc radius is the largest that fits the free area (top = tools row, bottom = chips). On a narrow stage the disc keeps a minimum size and the orbits compress instead (not below 0.8).
   */
  get fitInfo() {
    if (this.fit) return this.fit; const W = this.W; const H = this.H; const S = Math.max(1, this.model?.sources.length ?? 4);
    let ew = 2.3; let eh = 1.2; // agent-role ring: a = 2.3 R, b = a / 2, tilt 0.12
    for (let s = 0; s < S; s++) { const { a, b, phi } = orbitShape(s); const cp = Math.cos(phi); const sp = Math.sin(phi); ew = Math.max(ew, Math.hypot(a * cp, b * sp)); eh = Math.max(eh, Math.hypot(a * sp, b * cp)); }
    const narrow = W < 640; const padX = narrow ? 8 : 26; const top = narrow ? 112 : 66; const bottom = narrow ? 150 : 96; const availH = Math.max(120, H - top - bottom);
    const rFit = Math.min((W / 2 - padX) / ew, availH / 2 / eh); const rMin = Math.min(W * (narrow ? 0.27 : 0.34), availH / 2 / 1.45);
    let R; let ks = 1; if (rFit >= rMin) R = rFit; else { R = rMin; ks = Math.max(narrow ? 0.7 : 0.8, rFit / rMin); }
    this.fit = { scale0: R / R0, ks, ccx: W / 2, ccy: top + availH / 2, ew, eh }; return this.fit;
  }
  get scale0() { return this.fitInfo.scale0; }
  get ccx() { return this.fitInfo.ccx; }
  get ccy() { return this.fitInfo.ccy; }
  clampPan() { const c = this.cam; const lim = R0 * this.scale0 * (c.tzoom * 0.9 + 0.2); c.tpx = clamp(c.tpx, -lim, lim); c.tpy = clamp(c.tpy, -lim, lim); }
  drag(dx, dy) { const c = this.cam; c.tpx += dx; c.tpy += dy; this.clampPan(); this.idleSince = this.t; }
  zoom(f, ax, ay) {
    const c = this.cam; const nz = clamp(c.tzoom / f, 1, 11); const k = nz / c.tzoom;
    const ox = (ax ?? this.ccx) - this.ccx; const oy = (ay ?? this.ccy) - this.ccy; // keep the point under the cursor fixed
    c.tpx = ox - (ox - c.tpx) * k; c.tpy = oy - (oy - c.tpy) * k; c.tzoom = nz; if (nz === 1) { c.tpx *= 0.4; c.tpy *= 0.4; } this.clampPan(); this.idleSince = this.t;
  }
  rotateBy(dy, dp) { this.drag(-dy * 380, dp * 380); }
  pointer(nx, ny) { this.cam.tpar = [nx, ny]; }
  resetView() { Object.assign(this.cam, { tzoom: 1, tpx: 0, tpy: 0 }); this.idleSince = this.t; }
  focusOn(key) { // ease the camera onto a glyph
    if (key.t !== 'ev') return; const n = this.model.nodes[key.i]; if (!n.slot) return; const c = this.cam; const z = Math.max(c.tzoom, 5);
    c.tzoom = z; c.tpx = -n.slot.x * this.scale0 * z; c.tpy = -n.slot.y * this.scale0 * z; this.clampPan();
  }

  /* ------------------------------------------------------------ frame */
  toScreen(x, y) { const k = this.scale0 * this.cam.zoom; return [this.ccx + this.cam.px + x * k, this.ccy + this.cam.py + y * k]; }
  frame(now, dt) {
    const m = this.model; if (!m) return; this.t = now; const c = this.cam; const calm = this.calm; const N = m.nodes.length;
    const k = calm ? 1 : 1 - Math.exp(-dt * 8); c.zoom += (c.tzoom - c.zoom) * k; c.px += (c.tpx - c.px) * k; c.py += (c.tpy - c.py) * k;
    c.par[0] += (c.tpar[0] - c.par[0]) * k * 0.4; c.par[1] += (c.tpar[1] - c.par[1]) * k * 0.4;
    this.intro = calm ? 1 : Math.min(1, this.intro + dt / 2.4); if (!calm && this.auto) this.fxT += dt;
    if (this.ptr && !calm) { const lt = this.lastTrail; if (!lt || Math.hypot(this.ptr.x - lt.x, this.ptr.y - lt.y) > 7) { this.trail.push({ x: this.ptr.x, y: this.ptr.y, t: now }); this.lastTrail = { x: this.ptr.x, y: this.ptr.y }; if (this.trail.length > 40) this.trail.shift(); } } else this.lastTrail = null;
    const rp = this.replay;
    if (rp.active) {
      if (rp.playing) { rp.pos = Math.min(N, rp.pos + rp.speed * dt); if (rp.pos >= N) rp.playing = false; }
      const n = Math.floor(rp.pos);
      for (let r = this.lastReplayN ?? 0; r < n; r++) { const ni = this.order[r]; if (this.app[ni] === 0 && this.born[ni] < 0) { this.born[ni] = now; this.spark(ni, now, true); } }
      this.lastReplayN = n;
    }
    // appear animation: a born glyph materialises pixel by pixel; the first-load sweep is a decorative reveal (not an event)
    for (let i = 0; i < N; i++) {
      if (this.born[i] >= 0) { const u = (now - this.born[i] - (this.sparkLead ?? 0.42)) / 0.8; this.app[i] = u <= 0 ? 0 : clamp(u, 0, 1); if (u >= 1) this.born[i] = -1; }
      this.vis[i] += (this.visT[i] - this.vis[i]) * Math.min(1, dt * 9);
    }
    this.build(now, dt);
  }

  sat(s, now) { // satellite position: tilted ellipse, angle = UTC time of day of the last real ingest
    const info = this.srcInfo[s] ?? {}; const R = R0 * this.scale0 * this.cam.zoom; const ks = this.orbitK(); const sh = orbitShape(s);
    const a = sh.a * R * ks; const b = sh.b * R * ks; const phi = sh.phi;
    const tod = info.last ? ((info.last % 86400000) / 86400000) * Math.PI * 2 - Math.PI / 2 : -Math.PI / 2;
    const ex = a * Math.cos(tod); const ey = b * Math.sin(tod); const cp = Math.cos(phi); const sp = Math.sin(phi);
    return { x: this.ccx + this.cam.px + ex * cp - ey * sp, y: this.ccy + this.cam.py + ex * sp + ey * cp, a, b, phi, tod };
  }
  orbitK() { return this.fitInfo.ks; }
  roleAt(r, now) { const R = R0 * this.scale0 * this.cam.zoom; const ks = this.orbitK(); const th = (r / ROLES.length) * Math.PI * 2 + (this.calm || !this.auto ? 0.4 : now * 0.05); const a = 2.3 * R * ks; const b = a * 0.5; const phi = 0.12; const ex = a * Math.cos(th); const ey = b * Math.sin(th); return { x: this.ccx + this.cam.px + ex * Math.cos(phi) - ey * Math.sin(phi), y: this.ccy + this.cam.py + ex * Math.sin(phi) + ey * Math.cos(phi), th }; }

  build(now, dt) {
    const m = this.model; const N = m.nodes.length; const P = this.P; let np = 0; const L = this.L; let nl = 0; const calm = this.calm;
    const pushP = (x, y, size, r, g, b, a, bl) => { if (np >= this.maxP || a <= 0.002) return; const o = np * PSTRIDE; P[o] = x; P[o + 1] = y; P[o + 2] = size; P[o + 3] = r; P[o + 4] = g; P[o + 5] = b; P[o + 6] = a; P[o + 7] = bl; np++; };
    const pushL = (x1, y1, a1, x2, y2, a2, r, g, b) => { if (nl >= this.maxL || (a1 <= 0.002 && a2 <= 0.002)) return; const o = nl * 2 * LSTRIDE; L[o] = x1; L[o + 1] = y1; L[o + 2] = r; L[o + 3] = g; L[o + 4] = b; L[o + 5] = a1; L[o + 6] = x2; L[o + 7] = y2; L[o + 8] = r; L[o + 9] = g; L[o + 10] = b; L[o + 11] = a2; nl++; };
    const W = this.W; const H = this.H; const z = this.cam.zoom; const k = this.scale0 * z; const cx = this.ccx + this.cam.px; const cy = this.ccy + this.cam.py; const R = R0 * k;
    const ov = this.ov; ov.sats = []; ov.roles = []; ov.marks = []; ov.sparkles = []; ov.R = R; ov.cx = cx; ov.cy = cy; ov.k = k;

    // ---- starfield (decorative; three parallax depths; slow shimmer far below 3 Hz)
    const S = this.stars; const par = this.cam.par; const drift = calm || !this.auto ? 0 : this.t * 0.6;
    const nS = Math.min(S.length / 6, Math.round(S.length / 6 * (this.q.dust / 600)));
    for (let i = 0; i < nS; i++) {
      const o = i * 6; const d = S[o + 2]; let x = S[o] * W + par[0] * 14 * d - this.cam.px * 0.04 * d + drift * d * 0.4; let y = S[o + 1] * H + par[1] * 10 * d - this.cam.py * 0.04 * d; x = ((x % W) + W) % W;
      const tw = calm ? 0.8 : 0.6 + 0.4 * Math.sin(this.t * 0.45 * (0.4 + S[o + 3]) + S[o + 4]);
      const big = S[o + 5] > 0; pushP(x, y, big ? 7 : 2.4 + d * 2.2, 1, 0.93, 0.8, (big ? 0.9 : 0.22 + 0.4 * S[o + 3] * d) * tw, 0); if (big) (ov.sparkles ??= []).push({ x, y, a: 0.5 * tw });
    }
    // ---- warm halo behind the disc (decorative bloom) + core glow
    if (!this.q.flat) { pushP(cx, cy, R * 3.8, 1, 0.72, 0.32, 0.16, 0.5); pushP(cx, cy, R * 2.4, 1, 0.78, 0.4, 0.14, 0.3); } pushP(cx, cy, R * 0.5, 1, 0.85, 0.5, 0.12, 0.2);

    const fxo = { pushP, pushL, cx, cy, R, k, W, H }; buildFx(this, fxo);

    // ---- focus (hover > pinned > keyboard)
    const fk = this.hover ?? this.pinned ?? this.focus; let fNode = -1; let fSec = -1; let fSrc = -1;
    if (fk?.t === 'ev') fNode = fk.i; else if (fk?.t === 'well') fSec = fk.i; else if (fk?.t === 'src') fSrc = fk.i;
    const focusing = fNode >= 0 || fSec >= 0 || fSrc >= 0;
    const fnode = fNode >= 0 ? m.nodes[fNode] : null;

    // ---- shafts: one per source, brightness decays with the age of that source's last REAL ingest (floor keeps it faintly visible)
    const now0 = Date.now(); const cut = Math.max(W, H) * 1.2;
    for (let s = 0; s < m.sources.length; s++) {
      const sat = this.sat(s, now); const info = this.srcInfo[s] ?? {}; const col = m.nodes.find((n) => n.src === s)?.color ?? [0.8, 0.8, 0.8];
      const age = info.last ? Math.max(0, now0 - info.last) : 1e12; const live = info.recent ? 1 : Math.max(0.1, Math.exp(-age / (6 * 3600e3)) * 0.7);
      const dx = cx - sat.x; const dy = cy - sat.y; const dl = Math.hypot(dx, dy) || 1; const ux = dx / dl; const uy = dy / dl; const vx = -uy; const vy = ux;
      const ex = sat.x - ux * cut; const ey = sat.y - uy * cut; const tx = cx + ux * -R * 0.1; const ty = cy + uy * -R * 0.1; // aimed into the disc
      const off = this.filter.srcOff.has(m.sources[s].id) ? 0.25 : 1; const dimS = focusing && fSrc >= 0 && fSrc !== s ? 0.35 : 1; const A = live * off * dimS * this.intro;
      for (const [w, a, c0] of [[0, 0.5, 1], [3, 0.2, 0.3], [-3, 0.2, 0.3], [7, 0.1, 0.12], [-7, 0.1, 0.12]]) { const ox = vx * w; const oy = vy * w; const cc = mix(col, [1, 0.93, 0.8], 0.55 * c0 + 0.2); pushL(ex + ox * 3, ey + oy * 3, 0, sat.x + ox, sat.y + oy, a * A * 0.55, cc[0], cc[1], cc[2]); pushL(sat.x + ox, sat.y + oy, a * A * 0.55, tx + ox * 0.4, ty + oy * 0.4, a * A * 0.25, cc[0], cc[1], cc[2]); }
      if (info.recent && !calm) for (let q = 0; q < 4; q++) { const u = (this.t * 0.35 + q / 4 + s * 0.21) % 1; pushP(sat.x + (tx - sat.x) * u, sat.y + (ty - sat.y) * u, 12, 1, 0.95, 0.75, 0.8 * Math.sin(u * Math.PI), 0); }
      const flash = this.srcFlash[s] && !calm ? Math.max(0, 1 - (this.t - this.srcFlash[s].t) / 0.6) : 0;
      const recent = Boolean(info.recent); const sz = (recent ? 36 : 22) * Math.min(1.6, 0.8 + k * 2.4 / 1.0) * (1 + flash * 0.8);
      pushP(sat.x, sat.y, sz, col[0], col[1], col[2], (recent ? 0.7 : 0.4) * off + flash * 0.4, 0.1); pushP(sat.x, sat.y, 9, 1, 1, 0.92, 0.95 * off, 0);
      ov.sats.push({ i: s, x: sat.x, y: sat.y, a: sat.a, b: sat.b, phi: sat.phi, tod: sat.tod, col, info, flash, off, fl: this.srcFlash[s] });
    }

    buildFlow(this, fxo);

    // ---- glyph pixels
    const pix = this.pix; const pu = this.pu; this.pixStart = np; let busy = this.intro < 1 || this.replay.active || this.sparks.length > 0; if (this.q.flat === false || (this.q.fx ?? 0) >= 0.5 || this.flow?.tours?.length || this.ripples.length || this.trail.length) busy = true; const psz = Math.max(0.9, pu * k * 0.95); const nodes = m.nodes;
    const x0 = -40; const y0 = -40; const x1 = W + 40; const y1 = H + 40;
    for (let p = 0; p < pix.n; p++) {
      const i = pix.i[p]; const sx = cx + pix.x[p] * k; const sy = cy + pix.y[p] * k;
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
      const n = nodes[i]; let ap = this.app[i];
      if (this.intro < 1 && !this.replay.active) { const thn = (Math.atan2(n.slot.y, n.slot.x) + Math.PI * 2.5) % (Math.PI * 2); ap = clamp((this.intro * (Math.PI * 2 + 1.1) - thn) / 1.1, 0, 1); }
      if (ap <= 0) continue; const thr = pix.thr[p]; const al = clamp((ap - thr * 0.85) * 5, 0, 1); if (al <= 0) continue;
      const lv = pix.lv[p]; const rel = 0.32 + 0.68 * clamp(n.rel, 0, 1);
      const hot = this.hover && this.hover.t === 'ev' && this.hover.i === i; const pinned = this.pinned?.t === 'ev' && this.pinned.i === i;
      let dim = 1;
      if (focusing) { if (fNode >= 0) dim = i === fNode ? 1.5 : (fnode.wells.some((l) => n.wells.some((q) => q.w === l.w)) ? 0.55 : 0.3); else if (fSec >= 0) dim = n.wells.some((l) => l.w === fSec) ? 1.15 : 0.25; else if (fSrc >= 0) dim = n.src === fSrc ? 1.2 : 0.3; }
      const shimmer = calm || this.q.flat ? 1 : 0.84 + 0.16 * Math.sin(this.fxT * 0.9 + pix.thr[p] * 18.85 + n.h * 0.001); const boost = 1 + 1.3 * this.sweepF[i] + 2.1 * this.flowF[i];
      if (pix.kind[p] === 1) { pushP(sx, sy, psz * 1.6, RISK[0], RISK[1], RISK[2], 0.9 * al * this.vis[i] * Math.min(1, dim + 0.2), -1); continue; }
      const level = [0.5, 0.75, 1, 1.35][lv]; const a = clamp(rel * level * 0.7 * al * this.vis[i] * dim * shimmer * boost, 0, 2.1);
      const hotMix = lv === 3 ? 0.25 : 0; const base = mix(n.color, WARM, 0.06); const c = hotMix ? mix(base, [1, 0.96, 0.88], hotMix) : base;
      pushP(sx, sy, psz * 1.55, c[0], c[1], c[2], a, -1);
      if (pinned || hot) { /* bright glyph handled by overlay frame */ }
    }

    this.pixEnd = np;
    for (let i = 0; i < N; i++) if (this.born[i] >= 0 || Math.abs(this.vis[i] - this.visT[i]) > 0.01) { busy = true; break; }
    this.layerKey = busy ? null : `${this.W}x${this.H}|${z.toFixed(3)}|${Math.round(cx)}|${Math.round(cy)}|${fk ? fk.t + fk.i : ''}|${this.pinned ? this.pinned.t + this.pinned.i : ''}|${[...this.filter.srcOff, ...this.filter.topicOff].join(',')}|${N}|${this.pix.n}`;

    // ---- beams: each real arrival (live poll or replay) streaks from its source satellite to the glyph slot
    for (let q = this.sparks.length - 1; q >= 0; q--) {
      const sp = this.sparks[q]; const u = (this.t - sp.t0) / 0.45; if (u >= 1) { this.sparks.splice(q, 1); continue; } if (u < 0) continue;
      const n = nodes[sp.ni]; if (!n.slot) continue; const sat = ov.sats[sp.s]; if (!sat) continue;
      const tx = cx + n.slot.x * k; const ty = cy + n.slot.y * k; const e = ease(u); const e0 = ease(Math.max(0, u - 0.3));
      const x = sat.x + (tx - sat.x) * e; const y = sat.y + (ty - sat.y) * e; const xt = sat.x + (tx - sat.x) * e0; const yt = sat.y + (ty - sat.y) * e0;
      const c = mix(n.color, [1, 0.95, 0.8], 0.6); pushL(xt, yt, 0, x, y, 1, c[0], c[1], c[2]); pushL(xt, yt, 0, x, y, 0.5, 1, 1, 1);
      pushP(x, y, 17, c[0], c[1], c[2], 0.9, 0); if (u > 0.85) pushP(tx, ty, this.gsize * k * 2.2 * (1 - (u - 0.85) / 0.15 * 0.3), 1, 0.92, 0.6, 0.5 * (1 - (u - 0.85) / 0.15), 0.3);
    }
    // ---- run beams: working roles -> the run's topic sector (REAL run events only)
    ov.roles = ROLES.map((r, i) => { const p = this.roleAt(i, now); const st = this.activeRun ? this.roleState[r[0]] ?? 'idle' : 'idle'; return { i, x: p.x, y: p.y, st, lit: st !== 'idle', role: r }; });
    const sec = this.runWell >= 0 ? this.sectors[this.runWell] : null;
    if (this.activeRun && sec) {
      const tx = cx + Math.cos(sec.mid) * R * 0.6; const ty = cy + Math.sin(sec.mid) * R * 0.6;
      for (const r of ov.roles) { if (!r.lit) continue; const col = r.st === 'halted' ? RISK : LIME; const a = r.st === 'working' ? 0.8 : 0.25; pushL(r.x, r.y, a, tx, ty, a * 0.3, col[0], col[1], col[2]); pushP(r.x, r.y, r.st === 'working' ? 46 : 26, col[0], col[1], col[2], r.st === 'working' ? 0.55 : 0.25, 0.2); if (r.st === 'working' && !calm) for (let q = 0; q < 3; q++) { const u = (this.t * 0.5 + q / 3 + r.i * 0.11) % 1; pushP(r.x + (tx - r.x) * u, r.y + (ty - r.y) * u, 9, col[0], col[1], col[2], 0.9 * Math.sin(u * Math.PI), 0); } }
    }
    // ---- marks
    for (const [kind, key] of [['hover', this.hover], ['pinned', this.pinned], ['focus', this.focus]]) {
      if (!key) continue; const p = this.screenOf(key); if (p) ov.marks.push({ kind, x: p.x, y: p.y, r: p.r, key });
    }
    this.np = np; this.nl = nl;
  }

  /* ------------------------------------------------------------ keys / picking */
  screenOf(key) {
    if (key.t === 'ev') { const n = this.model.nodes[key.i]; if (!n.slot) return null; const [x, y] = this.toScreen(n.slot.x, n.slot.y); return { x, y, r: Math.max(5, this.gsize * this.scale0 * this.cam.zoom * 0.58) }; }
    if (key.t === 'well') { const s = this.sectors[key.i]; if (!s) return null; const R = R0 * this.scale0 * this.cam.zoom; const [cx, cy] = this.toScreen(0, 0); return { x: cx + Math.cos(s.mid) * R * 1.06, y: cy + Math.sin(s.mid) * R * 1.06, r: 10 }; }
    if (key.t === 'src') { const s = this.ov.sats?.[key.i]; return s ? { x: s.x, y: s.y, r: 12 } : null; }
    const r = this.ov.roles?.[key.i]; return r ? { x: r.x, y: r.y, r: 10 } : null;
  }
  pick(x, y, touch) {
    if (!this.model) return null; const slop = touch ? 12 : 4;
    for (const s of this.ov.sats ?? []) if ((s.x - x) ** 2 + (s.y - y) ** 2 < (14 + slop) ** 2) return { t: 'src', i: s.i };
    for (const r of this.ov.roles ?? []) if ((r.x - x) ** 2 + (r.y - y) ** 2 < (12 + slop) ** 2) return { t: 'role', i: r.i };
    const k = this.scale0 * this.cam.zoom; const lx = (x - this.ccx - this.cam.px) / k; const ly = (y - this.ccy - this.cam.py) / k; const rr = Math.hypot(lx, ly);
    if (rr <= R0 * 1.02) {
      const lim = this.gsize * 0.6 + (touch ? 5 / k : 0); let best = -1; let bd = 1e9;
      this.model.nodes.forEach((n, i) => { if (!n.slot || this.app[i] < 0.6 || this.vis[i] < 0.5) return; const d = Math.max(Math.abs(n.slot.x - lx), Math.abs(n.slot.y - ly)); if (d < lim && d < bd) { bd = d; best = i; } });
      if (best >= 0) return { t: 'ev', i: best };
    }
    // sector rim = the opportunity hub
    const ring = (rr * k - R0 * k * 1.06); if (Math.abs(ring) < 11 + slop) { const th = Math.atan2(ly, lx); for (const s of this.sectors) { if (!s) continue; let d = th - s.a0; d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); if (d <= s.a1 - s.a0) return { t: 'well', i: s.w }; } }
    return null;
  }
}
