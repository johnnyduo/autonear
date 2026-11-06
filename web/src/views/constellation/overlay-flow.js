// 2D overlay for the spectacle layers.
//  drawHudRings: decorative turning instrument rings + a ring of REAL content-hash prefixes (the newest stored records' sha256 fingerprints) scrolling round the clock ring. Ornament only; the hashes are real, the motion is not data.
//  drawFlowOverlay: data-bearing pop cards (ambient provenance tour: source -> topic of a REAL stored record) and relation tags (hover/pin web, source/topic focus counts).
import { srcShort } from '../_evidence-parts.jsx';

const TAU = Math.PI * 2;
const MONO = (px, w = 500) => `${w} ${px}px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,Menlo,monospace`;
const SANS = (px, w = 500) => `${w} ${px}px "Inter Tight Variable","Inter Tight",system-ui,sans-serif`;
const rgb = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const back = (t) => { const c = 1.7; const u = t - 1; return 1 + (c + 1) * u ** 3 + c * u ** 2; };
const GOLD = [0.95, 0.76, 0.42]; const CYAN = [0.3, 0.86, 0.95]; const VIOLET = [0.62, 0.48, 1]; const ICE = [0.8, 0.92, 1]; const LIMEC = [0.776, 0.957, 0.196];

const roundRect = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
const fit = (ctx, text, maxW) => { if (ctx.measureText(text).width <= maxW) return text; let s = text; while (s.length > 4 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1); return `${s}…`; };
const wrap = (ctx, text, maxW, maxLines) => {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = t; }
  if (lines.length < maxLines && cur) lines.push(cur); else if (cur && lines.length === maxLines) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/…$/, '')}…`;
  return lines.map((l) => fit(ctx, l, maxW));
};

/** Decorative turning rings, brackets and the scrolling hash ring. All geometry is a function of R and the ornament clock. */
export function drawHudRings(ctx, sc, { cx, cy, R, narrow, calm }) {
  const T = sc.fxT ?? 0; const z = sc.cam.zoom; const fade = clamp(1.6 - z * 0.35, 0, 1) * ((sc.q.fx ?? 1) > 0.05 ? 1 : 0); if (fade <= 0.02) return;
  ctx.save(); ctx.globalAlpha *= fade; ctx.lineCap = 'butt';
  const ring = (r, dash, lw, col, a, om) => { const c = TAU * r; ctx.setLineDash(dash); ctx.lineDashOffset = -(T * om * r); ctx.lineWidth = lw; ctx.strokeStyle = rgb(col, a); ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); void c; };
  ring(R * 1.46, [18, 10], 1, CYAN, 0.2, 0.05); ring(R * 1.52, [2, 5], 2.2, GOLD, 0.28, -0.07); ring(R * 1.9, [60, 22, 6, 22], 1, VIOLET, 0.2, 0.03); ring(R * 2.12, [1, 3], 1, ICE, 0.16, -0.02); ring(R * 1.0 + 3, [3, 9], 1, LIMEC, 0.18, 0.06);
  ctx.setLineDash([]);
  // HUD brackets: four arcs that slowly circle the disc
  ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.strokeStyle = rgb(LIMEC, 0.5);
  for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + T * 0.1; ctx.beginPath(); ctx.arc(cx, cy, R * 1.585, a, a + 0.34); ctx.stroke(); }
  ctx.strokeStyle = rgb(CYAN, 0.38); ctx.lineWidth = 1.6;
  for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU - T * 0.07 + 0.5; ctx.beginPath(); ctx.arc(cx, cy, R * 1.995, a, a + 0.22); ctx.stroke(); }
  ctx.lineCap = 'butt';
  if (!narrow) {
    // graduated ring: 180 ticks, every 10th long
    ctx.beginPath(); const r1 = R * 1.7; const rot = -T * 0.02;
    for (let i = 0; i < 180; i++) { const a = (i / 180) * TAU + rot; const L = i % 10 === 0 ? 8 : i % 5 === 0 ? 5 : 2.5; ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * (r1 + L), cy + Math.sin(a) * (r1 + L)); }
    ctx.strokeStyle = rgb(ICE, 0.26); ctx.lineWidth = 1; ctx.stroke();
    // ring of real content-hash prefixes, scrolling slowly (decorative motion, real strings)
    if (!sc.hashText && sc.fp) { const nodes = sc.model.nodes; const ids = nodes.map((n, i) => i).filter((i) => sc.fp[i]?.real).sort((a, b) => nodes[b].t - nodes[a].t).slice(0, 44); sc.hashText = ids.map((i) => Array.from(sc.fp[i].bytes.slice(0, 5), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()).join('  ·  '); }
    const txt = sc.hashText; if (txt && z < 2.6) {
      ctx.font = MONO(7.8, 500); ctx.fillStyle = rgb(GOLD, 0.34); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const rt = R * 1.29; const step = 4; const cw = 4.7; const circ = TAU * rt; const total = Math.floor(circ / (cw * step)) * step; const off = Math.floor(T * 1.4) % txt.length;
      for (let i = 0; i < total; i += step) { const chunk = [...Array(step)].map((_, j) => txt[(i + j + off) % txt.length]).join(''); const a = ((i + step / 2) / total) * TAU - Math.PI / 2; ctx.save(); ctx.translate(cx + Math.cos(a) * rt, cy + Math.sin(a) * rt); ctx.rotate(a + Math.PI / 2); ctx.fillText(chunk, 0, 0); ctx.restore(); }
    }
  }
  ctx.restore();
}

/** Pop cards for the provenance tour + relation tags for the focus web. */
export function drawFlowOverlay(ctx, sc, { W, H, reserved = [], narrow, calm }) {
  const ov = sc.ov; const m = sc.model; const { cx, cy } = ov; ctx.textBaseline = 'middle'; ctx.lineCap = 'round';
  // tags first (small pills), then cards on top
  for (const tg of ov.tags ?? []) {
    const s = calm ? 1 : clamp(back(tg.pop), 0, 1.15); if (s <= 0.02) continue; ctx.save(); ctx.font = MONO(narrow ? 9 : 10, 600); const text = tg.text.toUpperCase(); const w = ctx.measureText(text).width + 16; const h = 20;
    let px; let py; if (tg.head) { px = tg.x; py = tg.y - 24; } else { const a = tg.ang ?? 0; px = tg.x + Math.cos(a) * 22; py = tg.y + Math.sin(a) * 22; }
    let bx = (Math.cos(tg.ang ?? 0) >= 0 || tg.head ? px - (tg.head ? w / 2 : 0) : px - w); bx = clamp(bx, 6, W - w - 6); const by = clamp(py - h / 2, 56, H - h - 56);
    ctx.translate(bx + w / 2, by + h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2); ctx.globalAlpha = clamp(tg.pop, 0, 1);
    ctx.fillStyle = 'rgba(8,10,13,0.86)'; roundRect(ctx, 0, 0, w, h, 10); ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = rgb(tg.col, 0.9); ctx.stroke();
    ctx.fillStyle = rgb(tg.col, 1); ctx.textAlign = 'left'; ctx.fillText(text, 8, h / 2 + 0.5); ctx.restore();
  }
  for (const p of ov.pops ?? []) {
    const n = m.nodes[p.ni]; const e = n.e; const a0 = p.age; if (a0 < 0.55) continue;
    const u = clamp((a0 - 0.55) / 0.4, 0, 1); const s = calm ? 1 : back(u); const alpha = clamp(u * 1.6, 0, 1) * p.fade; if (alpha <= 0.02) continue;
    const w = narrow ? 188 : 244; ctx.save(); ctx.font = SANS(narrow ? 11 : 12, 500); const lines = wrap(ctx, e.title ?? '', w - 24, 2); const h = 18 + 18 + lines.length * 15 + 20;
    const dx = p.gx - cx; const dy = p.gy - cy; const dl = Math.hypot(dx, dy) || 1; const ux = dx / dl; const uy = dy / dl;
    const reach = 34 + Math.min((w / 2) / Math.max(0.25, Math.abs(ux)), (h / 2) / Math.max(0.25, Math.abs(uy)));
    let kx = p.gx + ux * reach; let ky = p.gy + uy * reach; kx = clamp(kx, w / 2 + 8, W - w / 2 - 8); ky = clamp(ky, 60 + h / 2, H - 58 - h / 2);
    for (const r of reserved) if (kx + w / 2 > r.x && kx - w / 2 < r.x + r.w && ky + h / 2 > r.y && ky - h / 2 < r.y + r.h) { ky = r.y > H / 2 ? r.y - h / 2 - 6 : r.y + r.h + h / 2 + 6; }
    const col = p.col; ctx.globalAlpha = alpha;
    // leader from the glyph to the card
    ctx.strokeStyle = rgb(col, 0.85); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p.gx, p.gy); ctx.lineTo(kx - Math.sign(kx - p.gx) * 0, ky); ctx.stroke(); ctx.fillStyle = rgb(col, 1); ctx.beginPath(); ctx.arc(p.gx, p.gy, 3, 0, TAU); ctx.fill();
    ctx.translate(kx, ky); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
    ctx.shadowColor = rgb(col, 0.5); ctx.shadowBlur = 18; ctx.fillStyle = 'rgba(8,10,13,0.9)'; roundRect(ctx, 0, 0, w, h, 9); ctx.fill(); ctx.shadowBlur = 0; ctx.lineWidth = 1.4; ctx.strokeStyle = rgb(col, 0.95); ctx.stroke();
    ctx.fillStyle = rgb(col, 1); ctx.beginPath(); ctx.arc(14, 17, 4.5, 0, TAU); ctx.fill();
    ctx.textAlign = 'left'; ctx.font = MONO(10.5, 700); ctx.fillStyle = rgb(col, 1); const sname = srcShort(e.source_id).toUpperCase(); ctx.fillText(sname, 25, 17); const sw = ctx.measureText(sname).width;
    ctx.fillStyle = 'rgba(236,233,223,0.55)'; ctx.fillText('→', 25 + sw + 7, 17); ctx.fillStyle = 'rgba(236,233,223,0.95)'; ctx.fillText(fit(ctx, m.wells[p.w].label.toUpperCase(), w - 70 - sw), 25 + sw + 21, 17);
    ctx.font = SANS(narrow ? 11 : 12, 500); ctx.fillStyle = 'rgba(236,233,223,0.92)'; lines.forEach((l, i) => ctx.fillText(l, 12, 37 + i * 15));
    ctx.font = MONO(9, 500); ctx.fillStyle = 'rgba(180,178,168,0.95)'; const rel = (e.relevance ?? 0).toFixed(2); const rl = n.wells[0]?.rel && n.wells[0].rel !== 'tag' ? ` · ${n.wells[0].rel}` : ''; ctx.fillText(fit(ctx, `STORED RECORD · RELEVANCE ${rel}${rl}`, w - 24), 12, h - 11);
    ctx.restore();
  }
}
