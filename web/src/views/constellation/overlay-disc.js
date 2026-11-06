// HUD overlay for the pixel disc: topic/opportunity rim (score arcs), source-share ring, top-score + confidence gauges,
// UTC clock ring, orbits + satellites, agent roles, centre numeral, relevance stripes. All values are stored aggregates; ornaments are labelled decorative.
import { fmt } from '../../api.js';
import { srcShort } from '../_evidence-parts.jsx';
import { COL, placeLabels, srcLines } from './overlay.js';
import { drawFlowOverlay, drawHudRings } from './overlay-flow.js';

const TAU = Math.PI * 2;
const MONO = (px, w = 500) => `${w} ${px}px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,Menlo,monospace`;
const SERIF = (px) => `400 ${px}px "Instrument Serif","Times New Roman",serif`;
const rgb = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const GOLD = [0.95, 0.76, 0.42]; const LIMEC = [0.776, 0.957, 0.196]; const CH = [0.93, 0.91, 0.87];
const arc = (ctx, cx, cy, r, a0, a1) => { ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke(); };

export function drawDiscOverlay(ctx, sc, { W, H, dpr, reserved = [], calm, narrow, labelsOn = true }) {
  const ov = sc.ov; const m = sc.model; const t = sc.t; const { cx, cy, R } = ov; const st = sc.stats;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.textBaseline = 'middle'; ctx.lineCap = 'butt';
  const items = []; const fs = narrow ? 9.5 : 10.5; const z = sc.cam.zoom; const fade = Math.min(1, 1.5 / Math.max(1, z * 0.6));
  const hot = sc.hover ?? sc.pinned ?? sc.focus; const isHot = (a, i) => hot && hot.t === a && hot.i === i;
  const spin = calm || !sc.auto ? 0 : t;
  ctx.globalAlpha = sc.intro;
  // Values ease from 0 to the stored number when the view opens and whenever the number changes. The motion is cosmetic; the end value is the stored one.
  const HUD = sc.hud ?? (sc.hud = { v: {}, last: t });
  const dtH = Math.min(0.1, Math.max(0, t - HUD.last)); HUD.last = t;
  const tw = (key, target, rate = 2.2) => { if (calm) return target; const cur = HUD.v[key] ?? 0; const nv = cur + (target - cur) * (1 - Math.exp(-dtH * rate)); HUD.v[key] = Math.abs(target - nv) < 1e-4 * Math.max(1, Math.abs(target)) ? target : nv; return HUD.v[key]; };
  const comet = (r, a0, a1, key, col, speed = 0.3, len = 0.09) => { // bright short segment running along an arc
    if (calm || a1 - a0 < 0.02) return; const u = (t * speed + key * 0.137) % 1; const h = a0 + (a1 - a0) * u; ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = ctx.lineWidth + 1.2; ctx.strokeStyle = rgb(col, 0.9); ctx.shadowColor = rgb(col, 0.8); ctx.shadowBlur = 8; arc(ctx, cx, cy, r, Math.max(a0, h - len), h); ctx.restore();
  };

  // ---- sparkles (decorative stars)
  for (const s of ov.sparkles ?? []) { ctx.strokeStyle = `rgba(255,236,200,${s.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6); ctx.stroke(); }

  // ---- decorative ornament rings (no data): hairlines + slowly turning dashes
  ctx.lineWidth = 1; ctx.strokeStyle = rgb(GOLD, 0.1); arc(ctx, cx, cy, R * 1.015, 0, TAU);
  ctx.setLineDash([1.5, 7]); ctx.lineDashOffset = -spin * 5; ctx.strokeStyle = rgb(GOLD, 0.22); arc(ctx, cx, cy, R * 1.62, 0, TAU); ctx.setLineDash([]);
  ctx.strokeStyle = rgb(GOLD, 0.08);
  drawHudRings(ctx, sc, { cx, cy, R, narrow, calm });

  // ---- orbits + satellites (source rings; angle = UTC time of day of the last real ingest)
  const clockR = R * 1.36;
  for (const s of ov.sats) {
    const col = s.col; const info = s.info; const a = s.off;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(s.phi);
    ctx.lineWidth = 1; ctx.strokeStyle = rgb(col, 0.2 * a); ctx.beginPath(); ctx.ellipse(0, 0, s.a, s.b, 0, 0, TAU); ctx.stroke();
    // comet tail hugging the orbit behind the satellite
    const tail = info.recent ? 1.3 : 0.7; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    const g = ctx.createLinearGradient(0, 0, 0, 0); void g;
    for (let q = 0; q < 14; q++) { const u0 = s.tod - ((q + 1) / 14) * tail; const u1 = s.tod - (q / 14) * tail; ctx.strokeStyle = rgb(col, (1 - q / 14) * (info.recent ? 0.9 : 0.5) * a); ctx.beginPath(); ctx.ellipse(0, 0, s.a, s.b, 0, u0, u1); ctx.stroke(); }
    ctx.restore(); ctx.lineCap = 'butt';
    // satellite ring + recency pulse (only when that source really ingested in the last 20 minutes)
    const tone = info.bad ? [1, 0.416, 0.239] : info.recent ? LIMEC : [0.78, 0.78, 0.72];
    ctx.lineWidth = info.recent ? 1.8 : 1.1; ctx.strokeStyle = rgb(tone, (info.recent ? 0.95 : 0.6) * a); if (!info.recent && !info.bad) ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (info.recent && !calm) { const ph = (t / 2.4 + s.i * 0.25) % 1; ctx.strokeStyle = rgb(tone, 0.7 * (1 - ph) * a); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 20 * ph, 0, TAU); ctx.stroke(); }
    if (s.fl && !calm) { const u = (t - s.fl.t) / 0.6; if (u >= 0 && u < 1) { ctx.strokeStyle = rgb(LIMEC, 0.8 * (1 - u)); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 16 * u, 0, TAU); ctx.stroke(); } }
    // clock tick at the same time-of-day angle + connector
    const tx = cx + Math.cos(s.tod) * clockR; const ty = cy + Math.sin(s.tod) * clockR;
    ctx.strokeStyle = rgb(col, 0.9 * a); ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(cx + Math.cos(s.tod) * (clockR - 6), cy + Math.sin(s.tod) * (clockR - 6)); ctx.lineTo(cx + Math.cos(s.tod) * (clockR + 6), cy + Math.sin(s.tod) * (clockR + 6)); ctx.stroke();
    ctx.setLineDash([1, 4]); ctx.lineWidth = 1; ctx.strokeStyle = rgb(col, 0.35 * a); ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
    const [n1, n2] = srcLines(info, m.sources[s.i]);
    items.push({ key: `s${s.i}`, x: s.x, y: s.y, r: 14, a, pr: isHot('src', s.i) ? 0 : 2, lines: [[n1, fs + 0.5, COL.chalk, 600], [n2, fs - 1, info.bad ? COL.risk : info.recent ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- UTC clock ring (ticks every hour; numerals every 6 h)
  ctx.lineWidth = 1; ctx.strokeStyle = rgb(CH, 0.2); arc(ctx, cx, cy, clockR, 0, TAU);
  for (let h = 0; h < 24; h++) { const a = (h / 24) * TAU - Math.PI / 2; const len = h % 6 === 0 ? 8 : 4; ctx.strokeStyle = rgb(CH, h % 6 === 0 ? 0.55 : 0.28); ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (clockR - len / 2), cy + Math.sin(a) * (clockR - len / 2)); ctx.lineTo(cx + Math.cos(a) * (clockR + len / 2), cy + Math.sin(a) * (clockR + len / 2)); ctx.stroke(); }
  if (!narrow && z < 3) { ctx.font = MONO(fs - 1.5); ctx.fillStyle = COL.chalk3; ctx.textAlign = 'center'; [['00', 0], ['06', 1], ['12', 2], ['18', 3]].forEach(([l, q]) => { const a = (q / 4) * TAU - Math.PI / 2; ctx.fillText(l, cx + Math.cos(a) * (clockR + 15), cy + Math.sin(a) * (clockR + 15)); }); ctx.fillText('UTC', cx + 20, cy - clockR - 15); }

  { // current UTC time of day on the clock ring, so a source's last-ingest angle can be read against "now"
    const d = new Date(); const day = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400; const na = day * TAU - Math.PI / 2; const pu = calm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.6);
    ctx.save(); ctx.strokeStyle = `rgba(255,248,225,${0.65 + 0.3 * pu})`; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(255,240,200,0.8)'; ctx.shadowBlur = 6 + 6 * pu;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(na) * (clockR - 11), cy + Math.sin(na) * (clockR - 11)); ctx.lineTo(cx + Math.cos(na) * (clockR + 11), cy + Math.sin(na) * (clockR + 11)); ctx.stroke(); ctx.restore();
  }
  // ---- source-share ring (stored counts per source)
  const sh = R * 1.135; const gapA = 0.035; let a0 = -Math.PI / 2 + 0.01; const tot = st.N; ctx.lineWidth = 2.2;
  m.sources.forEach((s, i) => {
    const frac = st.src[i] / tot; const span = Math.max(0, frac * (TAU - gapA * m.sources.length)) * tw('ring', 1, 1.3); const col = m.nodes.find((n) => n.src === i)?.color ?? [0.7, 0.7, 0.7]; const off = sc.filter.srcOff.has(s.id);
    ctx.strokeStyle = rgb(col, off ? 0.2 : 0.9); arc(ctx, cx, cy, sh, a0, a0 + span); a0 += span + gapA;
  });
  if (!calm) { const ph = (t * 0.5) % TAU; ctx.lineWidth = 3.4; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,250,235,0.5)'; ctx.shadowColor = 'rgba(255,250,235,0.7)'; ctx.shadowBlur = 8; arc(ctx, cx, cy, sh, ph, ph + 0.3); ctx.shadowBlur = 0; ctx.lineCap = 'butt'; }

  // ---- topic / opportunity rim: track + score fill
  const rim = R * 1.055; ctx.lineWidth = 3;
  for (const s of sc.sectors) {
    if (!s) continue; const wl = m.wells[s.w]; const on = !sc.filter.topicOff.has(wl.id); const hl = isHot('well', s.w);
    ctx.strokeStyle = rgb(CH, (hl ? 0.6 : 0.22) * (on ? 1 : 0.4)); arc(ctx, cx, cy, rim, s.a0, s.a1);
    if (wl.opp) { const sc2 = Math.max(0, Math.min(1, wl.opp.score)) * tw(`rim${s.w}`, 1, 1.6); ctx.strokeStyle = rgb(LIMEC, (hl ? 1 : 0.9) * (on ? 1 : 0.3)); ctx.lineWidth = hl ? 4 : 3; const e1 = s.a0 + (s.a1 - s.a0) * sc2; arc(ctx, cx, cy, rim, s.a0, e1); if (on) comet(rim, s.a0, e1, s.w + 1, [0.95, 1, 0.7], 0.28, 0.07); ctx.lineWidth = 3; }
    const lx = cx + Math.cos(s.mid) * rim; const ly = cy + Math.sin(s.mid) * rim; const ax = cx + Math.cos(s.mid) * R * 1.78; const ay = cy + Math.sin(s.mid) * R * 1.78;
    const l2 = wl.opp ? `${wl.opp.score.toFixed(2)} score · ${s.n} rec` : `${s.n} rec · no hub`;
    if (z < 3.5) items.push({ key: `w${s.w}`, x: ax, y: ay, r: 3, a: on ? 1 : 0.5, pr: hl ? 0 : 1, pref: Math.cos(s.mid) >= 0 ? 0 : 1, lead: { x: lx, y: ly }, lines: [[wl.label.toUpperCase(), fs + 0.5, COL.chalk, 600], [l2, fs - 1, wl.opp ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- gauges: top opportunity score (thick) + its confidence (dashed). 0..1 maps to 0..270 degrees from the lower left.
  if (st.top >= 0 && !(narrow && z > 1.5)) {
    const w = m.wells[st.top]; const o = w.opp; const g0 = Math.PI * 0.75; const sw = Math.PI * 1.5; const gr = R * 1.215;
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = rgb(LIMEC, 0.1); arc(ctx, cx, cy, gr, g0, g0 + sw);
    const gsc = tw('gs', o.score, 1.8); const gcf = tw('gc', o.confidence, 1.8); ctx.shadowColor = 'rgba(198,244,50,0.5)'; ctx.shadowBlur = 10; ctx.strokeStyle = rgb(LIMEC, 0.95); arc(ctx, cx, cy, gr, g0, g0 + sw * gsc); ctx.shadowBlur = 0; comet(gr, g0, g0 + sw * gsc, 11, [0.95, 1, 0.7], 0.22, 0.12); ctx.lineWidth = 4;
    ctx.lineWidth = 2; ctx.strokeStyle = rgb([0.85, 0.88, 0.8], 0.75); ctx.setLineDash([7, 4]); ctx.lineDashOffset = calm ? 0 : -t * 6; arc(ctx, cx, cy, gr + 8, g0, g0 + sw * gcf); ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.lineCap = 'butt';
    const ea = g0 + sw * gsc; const ex = cx + Math.cos(ea) * (gr + 20); const ey = cy + Math.sin(ea) * (gr + 20);
    if (!narrow) { ctx.textAlign = Math.cos(ea) > 0 ? 'left' : 'right'; ctx.fillStyle = COL.lime; ctx.font = MONO(15, 500); ctx.fillText(gsc.toFixed(2), ex + (Math.cos(ea) > 0 ? 4 : -4), ey - 5); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText(`TOP SCORE · ${w.label.toUpperCase()}`, ex + (Math.cos(ea) > 0 ? 4 : -4), ey + 9); ctx.fillText(`CONF ${gcf.toFixed(2)}`, ex + (Math.cos(ea) > 0 ? 4 : -4), ey + 21); }
  }

  // ---- agent roles (dark when idle; lit only from real run events)
  for (const r of ov.roles) {
    const tone = r.st === 'halted' ? [1, 0.416, 0.239] : LIMEC; const sz = 4.6; ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.PI / 4);
    if (r.st === 'working' && !calm) { ctx.restore(); const ph = (t / 1.8) % 1; ctx.strokeStyle = rgb(tone, 0.75 * (1 - ph)); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(r.x, r.y, sz + 16 * ph, 0, TAU); ctx.stroke(); ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.PI / 4); }
    ctx.beginPath(); ctx.rect(-sz * 0.7, -sz * 0.7, sz * 1.4, sz * 1.4); ctx.fillStyle = r.lit ? rgb(tone, 0.95) : 'rgba(10,12,15,0.92)'; ctx.fill(); ctx.lineWidth = r.st === 'working' ? 2 : 1.2; ctx.strokeStyle = r.lit ? rgb(tone, 1) : 'rgba(140,139,130,0.8)'; ctx.stroke(); ctx.restore();
    if (r.lit || (!narrow && labelsOn)) items.push({ key: `r${r.i}`, x: r.x, y: r.y, r: 9, a: r.lit ? 1 : 0.85, pr: isHot('role', r.i) ? 0 : r.lit ? 2 : 4, lines: [[r.role[2], fs - 1, r.lit ? COL.chalk : COL.chalk3, 500], ...(r.lit ? [[r.st, fs - 1.5, r.st === 'halted' ? COL.risk : COL.lime, 500]] : [])] });
  }

  // ---- centre readout (stored aggregate)
  if (z < 2.2) { ctx.textAlign = 'center'; ctx.fillStyle = `rgba(236,233,223,${0.95 * fade})`; ctx.font = SERIF(Math.max(16, Math.min(46, R * 0.17))); ctx.fillText(String(Math.round(tw('N', st.N, 2.4))), cx, cy - 4); ctx.font = MONO(fs - 1.5); ctx.fillStyle = `rgba(180,178,168,${fade})`; ctx.fillText('STORED RECORDS', cx, cy + Math.max(14, R * 0.1)); }

  // ---- marks (glyph brackets)
  for (const mk of ov.marks) {
    if (mk.key.t !== 'ev') { if (mk.kind !== 'hover') { ctx.strokeStyle = COL.lime; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(mk.x, mk.y, 12, 0, TAU); ctx.stroke(); } continue; }
    const h = Math.max(7, mk.r + 3); const L = Math.max(4, h * 0.45); ctx.lineWidth = mk.kind === 'hover' ? 1.2 : 1.8; ctx.strokeStyle = mk.kind === 'hover' ? 'rgba(236,233,223,0.9)' : COL.lime; if (mk.kind === 'focus') ctx.setLineDash([4, 3]);
    if (mk.kind === 'focus') { ctx.strokeRect(mk.x - h, mk.y - h, h * 2, h * 2); ctx.setLineDash([]); continue; }
    ctx.beginPath(); for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(mk.x + sx * h, mk.y + sy * (h - L)); ctx.lineTo(mk.x + sx * h, mk.y + sy * h); ctx.lineTo(mk.x + sx * (h - L), mk.y + sy * h); } ctx.stroke();
  }

  // ---- relevance stripes (right edge): share of stored records with relevance >= 0.95. The fill and the numbers ease up from 0; a light wave runs up the lit stripes and a scan line crosses the column.
  if (W >= 900 && z < 2.5) {
    const n = 26; const x1 = W - 20; const x0 = x1 - 46; const y1 = cy + R * 0.9; const hi = tw('hi', st.high, 1.8); const fillF = hi * n; const fl = tw('fl', st.flagged, 2.2);
    const scan = calm ? -1 : ((t * 0.32) % 1.25) * n - 1.5; // row index of the scan line, mostly inside the column
    for (let i = 0; i < n; i++) {
      const y = y1 - i * 6; const lit = Math.max(0, Math.min(1, fillF - i));
      const wave = calm ? 0 : Math.max(0, Math.sin((i / n) * TAU * 1.5 - t * 2.4)) ** 4; const near = Math.max(0, 1 - Math.abs(i - scan) / 2.2);
      const a = lit > 0 ? (0.62 + 0.3 * wave) * Math.max(0.35, lit) + 0.4 * near : 0.32 + 0.35 * near;
      ctx.fillStyle = lit > 0 ? `rgba(${198 + Math.round(40 * near)},${244 + Math.round(10 * near)},${50 + Math.round(120 * near)},${Math.min(1, a)})` : `rgba(140,139,130,${Math.min(0.8, a)})`;
      ctx.fillRect(x0 + (n - i) * 0.35, y, 46 - (n - i) * 0.35, 2.4);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = COL.lime; ctx.font = MONO(20, 500); ctx.fillText(`${Math.round(hi * 100)}%`, x1, y1 + 22); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText('RELEVANCE ≥ 0.95', x1, y1 + 38);
    const fy = cy - R * 0.9; ctx.fillStyle = COL.chalk; ctx.font = MONO(15, 500); ctx.fillText(`${Math.round(fl)} FLAGGED`, x1, fy - 8); ctx.fillStyle = COL.chalk2; ctx.font = MONO(fs - 1.5); ctx.fillText(`${(st.flagged / st.N * 100).toFixed(1)}% OF RECORDS`, x1, fy + 8);
    if (st.flagged > 0) { const pr = calm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2); ctx.font = MONO(15, 500); const w2 = ctx.measureText(`${Math.round(fl)} FLAGGED`).width; ctx.fillStyle = `rgba(255,106,61,${0.55 + 0.4 * pr})`; ctx.beginPath(); ctx.arc(x1 - w2 - 12, fy - 8, 3.2 + pr * 1.4, 0, TAU); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  placeLabels(ctx, sc, items, { W, H, reserved, narrow, labelsOn });
  drawFlowOverlay(ctx, sc, { W, H, reserved, narrow, calm });
  void fmt; void srcShort;
}
