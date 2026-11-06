// HUD overlay for the glyph sphere: satellite markers + labels, topic labels, agent roles, hover/pin brackets, and the stored-aggregate readouts
// (record count, top opportunity score + confidence, relevance stripes, flagged share). Rings, orbits, arcs and beams are drawn as glowing lines by sphere.js.
import { srcLines, COL, placeLabels } from './overlay.js';

const TAU = Math.PI * 2;
const MONO = (px, w = 500) => `${w} ${px}px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,Menlo,monospace`;
const SERIF = (px) => `400 ${px}px "Instrument Serif","Times New Roman",serif`;
const rgb = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const LIMEC = [0.776, 0.957, 0.196];

export function drawSphereOverlay(ctx, sc, { W, H, dpr, reserved = [], calm, narrow, labelsOn = true }) {
  const ov = sc.ov; const m = sc.model; const t = sc.t; const { cx, cy, R } = ov; const st = sc.stats;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.textBaseline = 'middle'; ctx.lineCap = 'butt';
  const items = []; const fs = narrow ? 9.5 : 10.5; const z = sc.cam.zoom; const fade = Math.min(1, 1.5 / Math.max(1, z * 0.6));
  const hot = sc.hover ?? sc.pinned ?? sc.focus; const isHot = (a, i) => hot && hot.t === a && hot.i === i;
  ctx.globalAlpha = sc.intro;
  // Values ease from 0 to the stored number when the view opens and whenever the number changes. Cosmetic; the end value is the stored one.
  const HUD = sc.hud ?? (sc.hud = { v: {}, last: t });
  const dtH = Math.min(0.1, Math.max(0, t - HUD.last)); HUD.last = t;
  const tw = (key, target, rate = 2.2) => { if (calm) return target; const cur = HUD.v[key] ?? 0; const nv = cur + (target - cur) * (1 - Math.exp(-dtH * rate)); HUD.v[key] = Math.abs(target - nv) < 1e-4 * Math.max(1, Math.abs(target)) ? target : nv; return HUD.v[key]; };

  for (const s of ov.sparkles ?? []) { ctx.strokeStyle = `rgba(255,236,200,${s.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6); ctx.stroke(); }

  // ---- satellites (angle on the orbit = UTC time of day of that source's last real ingest)
  for (const s of ov.sats) {
    const info = s.info; const a = s.off * (s.occ ? 0.3 : 1); const tone = info.bad ? [1, 0.416, 0.239] : info.recent ? LIMEC : [0.78, 0.78, 0.72];
    ctx.lineWidth = info.recent ? 1.8 : 1.1; ctx.strokeStyle = rgb(tone, (info.recent ? 0.95 : 0.6) * a); if (!info.recent && !info.bad) ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (info.recent && !calm) { const ph = (t / 2.4 + s.i * 0.25) % 1; ctx.strokeStyle = rgb(tone, 0.7 * (1 - ph) * a); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 20 * ph, 0, TAU); ctx.stroke(); }
    if (s.fl && !calm) { const u = (t - s.fl.t) / 0.6; if (u >= 0 && u < 1) { ctx.strokeStyle = rgb(LIMEC, 0.8 * (1 - u)); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 16 * u, 0, TAU); ctx.stroke(); } }
    if (s.occ && !isHot('src', s.i)) continue;
    const [n1, n2] = srcLines(info, m.sources[s.i]);
    items.push({ key: `s${s.i}`, x: s.x, y: s.y, r: 14, a, pr: isHot('src', s.i) ? 0 : 2, lines: [[n1, fs + 0.5, COL.chalk, 600], [n2, fs - 1, info.bad ? COL.risk : info.recent ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- topic labels (front side only)
  if (z < 3.2) for (const w of ov.wells) {
    if (w.z < -0.1 * 300) continue; const wl = m.wells[w.w]; const l2 = wl.opp ? `${wl.opp.score.toFixed(2)} score · ${w.n} rec` : `${w.n} rec · no hub`;
    items.push({ key: `w${w.w}`, x: w.ax, y: w.ay, r: 3, a: w.on ? 1 : 0.5, pr: w.hl ? 0 : 1, pref: Math.cos(Math.atan2(w.ay - cy, w.ax - cx)) >= 0 ? 0 : 1, lead: { x: w.x, y: w.y }, lines: [[wl.label.toUpperCase(), fs + 0.5, COL.chalk, 600], [l2, fs - 1, wl.opp ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- agent roles (dark when idle; lit only from real run events)
  for (const r of ov.roles) {
    const tone = r.st === 'halted' ? [1, 0.416, 0.239] : LIMEC; const sz = 4.6; const o = r.occ ? 0.3 : 1; ctx.save(); ctx.globalAlpha = sc.intro * o; ctx.translate(r.x, r.y); ctx.rotate(Math.PI / 4);
    ctx.beginPath(); ctx.rect(-sz * 0.7, -sz * 0.7, sz * 1.4, sz * 1.4); ctx.fillStyle = r.lit ? rgb(tone, 0.95) : 'rgba(10,12,15,0.92)'; ctx.fill(); ctx.lineWidth = r.st === 'working' ? 2 : 1.2; ctx.strokeStyle = r.lit ? rgb(tone, 1) : 'rgba(140,139,130,0.8)'; ctx.stroke(); ctx.restore();
    if (r.st === 'working' && !calm) { const ph = (t / 1.8) % 1; ctx.strokeStyle = rgb(tone, 0.75 * (1 - ph)); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(r.x, r.y, sz + 16 * ph, 0, TAU); ctx.stroke(); }
    if (!r.occ && (r.lit || (!narrow && labelsOn && r.z > 0))) items.push({ key: `r${r.i}`, x: r.x, y: r.y, r: 9, a: r.lit ? 1 : 0.85, pr: isHot('role', r.i) ? 0 : r.lit ? 2 : 4, lines: [[r.role[2], fs - 1, r.lit ? COL.chalk : COL.chalk3, 500], ...(r.lit ? [[r.st, fs - 1.5, r.st === 'halted' ? COL.risk : COL.lime, 500]] : [])] });
  }

  // ---- marks (glyph brackets)
  for (const mk of ov.marks) {
    if (mk.key.t !== 'ev') { if (mk.kind !== 'hover') { ctx.strokeStyle = COL.lime; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(mk.x, mk.y, 12, 0, TAU); ctx.stroke(); } continue; }
    const h = Math.max(7, mk.r + 3); const L = Math.max(4, h * 0.45); ctx.lineWidth = mk.kind === 'hover' ? 1.2 : 1.8; ctx.strokeStyle = mk.kind === 'hover' ? 'rgba(236,233,223,0.9)' : COL.lime;
    if (mk.kind === 'focus') { ctx.setLineDash([4, 3]); ctx.strokeRect(mk.x - h, mk.y - h, h * 2, h * 2); ctx.setLineDash([]); continue; }
    ctx.beginPath(); for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(mk.x + sx * h, mk.y + sy * (h - L)); ctx.lineTo(mk.x + sx * h, mk.y + sy * h); ctx.lineTo(mk.x + sx * (h - L), mk.y + sy * h); } ctx.stroke();
  }

  // ---- left readout: stored record count + top opportunity score / confidence
  if (W >= 900 && z < 2.2) {
    const x0 = 28; let y = cy - R * 0.62; ctx.textAlign = 'left'; ctx.fillStyle = `rgba(236,233,223,${0.95 * fade})`; ctx.font = SERIF(54); ctx.fillText(String(Math.round(tw('N', st.N, 2.4))), x0, y);
    ctx.font = MONO(fs - 1.5); ctx.fillStyle = `rgba(180,178,168,${fade})`; ctx.fillText('STORED RECORDS', x0, y + 34);
    if (st.top >= 0) {
      const w = m.wells[st.top]; const o = w.opp; const gs = tw('gs', o.score, 1.8); const gc = tw('gc', o.confidence, 1.8); y += 84; const bw = 150;
      ctx.fillStyle = COL.lime; ctx.font = MONO(20, 500); ctx.fillText(gs.toFixed(2), x0, y); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText(`TOP SCORE · ${w.label.toUpperCase()}`, x0 + 56, y);
      ctx.fillStyle = rgb(LIMEC, 0.14); ctx.fillRect(x0, y + 14, bw, 3); ctx.save(); ctx.shadowColor = 'rgba(198,244,50,0.6)'; ctx.shadowBlur = 8; ctx.fillStyle = rgb(LIMEC, 0.95); ctx.fillRect(x0, y + 14, bw * gs, 3); ctx.restore();
      ctx.fillStyle = COL.chalk2; ctx.fillText(`CONFIDENCE ${gc.toFixed(2)}`, x0, y + 32); ctx.fillStyle = 'rgba(180,178,168,0.18)'; ctx.fillRect(x0, y + 44, bw, 2);
      ctx.fillStyle = 'rgba(214,226,190,0.85)'; for (let q = 0; q < Math.floor((bw * gc) / 9); q++) ctx.fillRect(x0 + q * 9, y + 44, 6, 2);
    }
  }

  // ---- relevance stripes (right edge): share of stored records with relevance >= 0.95, and the flagged share
  if (W >= 900 && z < 2.5) {
    const n = 26; const x1 = W - 20; const x0 = x1 - 46; const y1 = cy + R * 0.82; const hi = tw('hi', st.high, 1.8); const fillF = hi * n; const fl = tw('fl', st.flagged, 2.2);
    const scan = calm ? -1 : ((t * 0.32) % 1.25) * n - 1.5;
    for (let i = 0; i < n; i++) {
      const y = y1 - i * 6; const lit = Math.max(0, Math.min(1, fillF - i)); const wave = calm ? 0 : Math.max(0, Math.sin((i / n) * TAU * 1.5 - t * 2.4)) ** 4; const near = Math.max(0, 1 - Math.abs(i - scan) / 2.2);
      const a = lit > 0 ? (0.62 + 0.3 * wave) * Math.max(0.35, lit) + 0.4 * near : 0.32 + 0.35 * near;
      ctx.fillStyle = lit > 0 ? `rgba(${198 + Math.round(40 * near)},${244 + Math.round(10 * near)},${50 + Math.round(120 * near)},${Math.min(1, a)})` : `rgba(140,139,130,${Math.min(0.8, a)})`;
      ctx.fillRect(x0 + (n - i) * 0.35, y, 46 - (n - i) * 0.35, 2.4);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = COL.lime; ctx.font = MONO(20, 500); ctx.fillText(`${Math.round(hi * 100)}%`, x1, y1 + 22); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText('RELEVANCE ≥ 0.95', x1, y1 + 38);
    const fy = cy - R * 0.82; ctx.fillStyle = COL.chalk; ctx.font = MONO(15, 500); ctx.fillText(`${Math.round(fl)} FLAGGED`, x1, fy - 8); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText(`${(st.flagged / st.N * 100).toFixed(1)}% OF RECORDS`, x1, fy + 8);
    if (st.flagged > 0) { const pr = calm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2); ctx.font = MONO(15, 500); const w2 = ctx.measureText(`${Math.round(fl)} FLAGGED`).width; ctx.fillStyle = `rgba(255,106,61,${0.55 + 0.4 * pr})`; ctx.beginPath(); ctx.arc(x1 - w2 - 12, fy - 8, 3.2 + pr * 1.4, 0, TAU); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  placeLabels(ctx, sc, items, { W, H, reserved, narrow, labelsOn });
}
