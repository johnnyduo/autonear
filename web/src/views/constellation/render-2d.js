// Canvas 2D renderer with the same input as render-gl.js: 'lighter' compositing, cached glow sprites, bucketed additive lines and a cheap
// down-sample/up-sample bloom. It is the automatic fallback when WebGL2 is missing or its context is lost.
import { LSTRIDE, PSTRIDE } from './scene.js';

const q5 = (v) => Math.max(0, Math.min(31, Math.round(v * 31)));
export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: true }); if (!this.ctx) throw new Error('no 2d');
    this.kind = 'canvas2d'; this.sprites = new Map(); this.bloom = 1; this.bc = document.createElement('canvas'); this.bx = this.bc.getContext('2d');
  }
  resize(cssW, cssH, dpr) {
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr); this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.bc.width = Math.max(2, Math.round(cssW / 4)); this.bc.height = Math.max(2, Math.round(cssH / 4));
  }
  sprite(r, g, b, blur) {
    const bl = blur < 0.2 ? 0 : blur < 0.55 ? 1 : 2; const key = `${q5(r)}.${q5(g)}.${q5(b)}.${bl}`; let s = this.sprites.get(key);
    if (s) return s;
    if (this.sprites.size > 240) this.sprites.clear();
    const S = 96; s = document.createElement('canvas'); s.width = S; s.height = S; const c = s.getContext('2d');
    const R = Math.round(r * 255); const G = Math.round(g * 255); const B = Math.round(b * 255);
    const hot = `${Math.round(R + (255 - R) * 0.7)},${Math.round(G + (255 - G) * 0.7)},${Math.round(B + (255 - B) * 0.7)}`;
    const gr = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    if (bl === 0) { gr.addColorStop(0, `rgba(${hot},1)`); gr.addColorStop(0.1, `rgba(${hot},0.95)`); gr.addColorStop(0.2, `rgba(${R},${G},${B},0.5)`); gr.addColorStop(0.45, `rgba(${R},${G},${B},0.12)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`); }
    else if (bl === 1) { gr.addColorStop(0, `rgba(${hot},0.7)`); gr.addColorStop(0.15, `rgba(${R},${G},${B},0.4)`); gr.addColorStop(0.55, `rgba(${R},${G},${B},0.14)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`); }
    else { gr.addColorStop(0, `rgba(${R},${G},${B},0.3)`); gr.addColorStop(0.6, `rgba(${R},${G},${B},0.2)`); gr.addColorStop(0.9, `rgba(${R},${G},${B},0.1)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`); }
    c.fillStyle = gr; c.fillRect(0, 0, S, S); this.sprites.set(key, s); return s;
  }
  draw(f) {
    const { P, nP, L, nL } = f; const ctx = this.ctx; const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, this.cssW, this.cssH); ctx.globalCompositeOperation = 'lighter';
    // lines, bucketed by quantised colour + alpha so we stroke a handful of paths instead of thousands
    const buckets = new Map();
    for (let i = 0; i < nL; i++) {
      const o = i * 2 * LSTRIDE; const a = (L[o + 5] + L[o + 11]) * 0.5; if (a < 0.004) continue;
      const ab = Math.min(7, Math.floor(Math.sqrt(a) * 8)); const key = (q5(L[o + 2] * 0.5) << 10) | (q5(L[o + 3] * 0.5) << 5) | q5(L[o + 4] * 0.5) | (ab << 15);
      let b = buckets.get(key); if (!b) { b = { r: L[o + 2], g: L[o + 3], b: L[o + 4], a: 0, n: 0, seg: [] }; buckets.set(key, b); }
      b.a += a; b.n++; b.seg.push(L[o], L[o + 1], L[o + 6], L[o + 7]);
    }
    ctx.lineWidth = 1;
    for (const b of buckets.values()) {
      ctx.strokeStyle = `rgba(${Math.round(b.r * 255)},${Math.round(b.g * 255)},${Math.round(b.b * 255)},${Math.min(1, (b.a / b.n) * 1.5)})`;
      ctx.beginPath(); const s = b.seg; for (let k = 0; k < s.length; k += 4) { ctx.moveTo(s[k], s[k + 1]); ctx.lineTo(s[k + 2], s[k + 3]); } ctx.stroke();
    }
    const pxb = new Map(); // square glyph pixels: bucketed by colour + alpha level, one fillStyle per bucket
    const cached = Boolean(f.layerKey) && f.pixEnd > f.pixStart; let layerValid = false;
    if (cached) { if (this.layerKey === f.layerKey && this.layer) layerValid = true; }
    for (let i = 0; i < nP; i++) {
      if (layerValid && i >= f.pixStart && i < f.pixEnd) { i = f.pixEnd - 1; continue; }
      const o = i * PSTRIDE; const a = P[o + 6]; if (a < 0.004) continue; const sz = P[o + 2];
      if (P[o + 7] < -0.5) {
        const al = Math.min(7, Math.round(Math.min(1, a) * 7)); const key = (q5(P[o + 3]) << 13) | (q5(P[o + 4]) << 8) | (q5(P[o + 5]) << 3) | al; let b = pxb.get(key);
        if (!b) { b = { c: `rgba(${Math.round(P[o + 3] * 255)},${Math.round(P[o + 4] * 255)},${Math.round(P[o + 5] * 255)},${(al / 7).toFixed(2)})`, r: [] }; pxb.set(key, b); }
        const h = sz * 0.64; b.r.push(P[o] - h / 2, P[o + 1] - h / 2, h); continue;
      }
      ctx.globalAlpha = Math.min(1, a); ctx.drawImage(this.sprite(P[o + 3], P[o + 4], P[o + 5], P[o + 7]), P[o] - sz / 2, P[o + 1] - sz / 2, sz, sz);
    }
    const paintBuckets = (c2) => { for (const b of pxb.values()) { c2.fillStyle = b.c; const r = b.r; for (let k = 0; k < r.length; k += 3) c2.fillRect(r[k], r[k + 1], r[k + 2], r[k + 2]); } };
    if (layerValid) ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    else if (cached) { // static pixel layer: rasterise once, blit every frame until the camera, filter or selection changes
      if (!this.layer) this.layer = document.createElement('canvas'); this.layer.width = Math.round(this.cssW * d); this.layer.height = Math.round(this.cssH * d);
      const lc = this.layer.getContext('2d'); lc.setTransform(d, 0, 0, d, 0, 0); lc.globalCompositeOperation = 'lighter'; paintBuckets(lc); this.layerKey = f.layerKey; ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    } else paintBuckets(ctx);
    ctx.globalAlpha = 1;
    if (this.bloom > 0) { // poor man's bloom: shrink the frame, then draw it back stretched (bilinear) on top, additively
      const bx = this.bx; bx.globalCompositeOperation = 'copy'; bx.drawImage(this.canvas, 0, 0, this.bc.width, this.bc.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.55; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(this.bc, 0, 0, this.canvas.width, this.canvas.height); ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  destroy() { this.sprites.clear(); }
}
