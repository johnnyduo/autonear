// HUD overlay for the glyph sphere: satellite markers + labels, topic labels, agent roles, hover/pin brackets, and the stored-aggregate readouts
// (record count, top opportunity score + confidence, relevance stripes, flagged share). Rings, orbits, arcs and beams are drawn as glowing lines by sphere.js.
import { fmt } from '../../api.js';
import { srcShort } from '../_evidence-parts.jsx';
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
  ctx.globalAlpha = sc.intro; const evMain = sc.evMain !== false;
  // Values ease from 0 to the stored number when the view opens and whenever the number changes. Cosmetic; the end value is the stored one.
  const HUD = sc.hud ?? (sc.hud = { v: {}, last: t });
  const dtH = Math.min(0.1, Math.max(0, t - HUD.last)); HUD.last = t;
  const tw = (key, target, rate = 2.2) => { if (calm) return target; const cur = HUD.v[key] ?? 0; const nv = cur + (target - cur) * (1 - Math.exp(-dtH * rate)); HUD.v[key] = Math.abs(target - nv) < 1e-4 * Math.max(1, Math.abs(target)) ? target : nv; return HUD.v[key]; };

  for (const s of ov.sparkles ?? []) { ctx.strokeStyle = `rgba(255,236,200,${s.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6); ctx.stroke(); }

  // ---- satellites (angle on the orbit = UTC time of day of that source's last real ingest)
  for (const s of (evMain ? ov.sats : [])) {
    const info = s.info; const a = s.off * (s.occ ? 0.3 : 1); const tone = info.bad ? [1, 0.416, 0.239] : info.recent ? LIMEC : [0.78, 0.78, 0.72];
    ctx.lineWidth = info.recent ? 1.8 : 1.1; ctx.strokeStyle = rgb(tone, (info.recent ? 0.95 : 0.6) * a); if (!info.recent && !info.bad) ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (info.recent && !calm) { const ph = (t / 2.4 + s.i * 0.25) % 1; ctx.strokeStyle = rgb(tone, 0.7 * (1 - ph) * a); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 20 * ph, 0, TAU); ctx.stroke(); }
    if (s.fl && !calm) { const u = (t - s.fl.t) / 0.6; if (u >= 0 && u < 1) { ctx.strokeStyle = rgb(LIMEC, 0.8 * (1 - u)); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(s.x, s.y, 9 + 16 * u, 0, TAU); ctx.stroke(); } }
    if (s.occ && !isHot('src', s.i)) continue;
    const [n1, n2] = srcLines(info, m.sources[s.i]);
    items.push({ key: `s${s.i}`, x: s.x, y: s.y, r: 14, a, pr: isHot('src', s.i) ? 0 : 2, lines: [[n1, fs + 0.5, COL.chalk, 600], [n2, fs - 1, info.bad ? COL.risk : info.recent ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- topic labels (front side only)
  if (evMain && z < 3.2) for (const w of ov.wells) {
    if (w.z < -0.1 * 300) continue; const wl = m.wells[w.w]; const l2 = wl.opp ? `${wl.opp.score.toFixed(2)} score · ${w.n} rec` : `${w.n} rec · no hub`;
    items.push({ key: `w${w.w}`, x: w.ax, y: w.ay, r: 3, a: w.on ? 1 : 0.5, pr: w.hl ? 0 : 1, pref: Math.cos(Math.atan2(w.ay - cy, w.ax - cx)) >= 0 ? 0 : 1, lead: { x: w.x, y: w.y }, lines: [[wl.label.toUpperCase(), fs + 0.5, COL.chalk, 600], [l2, fs - 1, wl.opp ? COL.lime : COL.chalk2, 500]] });
  }

  // ---- agent roles (dark when idle; lit only from real run events)
  for (const r of (evMain ? ov.roles : [])) {
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
  if (evMain && W >= 900 && z < 2.2) {
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

  // ---- pipeline panel: the four stage bars are an ILLUSTRATION (a looping animation, not live events); the countdown and last-ingest lines are real
  if (evMain && W >= 900 && z < 2.2 && !narrow) {
    const x0 = 28; let y = cy + R * 0.3; const stages = ['FETCH', 'DEDUPE', 'SCORE', 'LINK']; const ph = calm ? 0 : ((t % 6) / 6) * 4; const bw = 112;
    ctx.textAlign = 'left'; ctx.font = MONO(fs - 1.5, 600); ctx.fillStyle = COL.chalk2; ctx.fillText('PIPELINE', x0, y); ctx.font = MONO(fs - 2.5); ctx.fillStyle = COL.chalk3; ctx.fillText('ILLUSTRATION · NOT LIVE EVENTS', x0 + 62, y);
    stages.forEach((nm, i) => {
      const yy = y + 18 + i * 17; const act = !calm && Math.floor(ph) === i; const prog = calm ? 1 : act ? ph - i : i < ph ? 1 : 0; const glow = act ? 1 : Math.max(0.28, 1 - (((ph - i - 1) % 4) + 4) % 4 * 0.3);
      ctx.fillStyle = act ? COL.lime : COL.chalk2; ctx.font = MONO(fs - 1, act ? 600 : 500); ctx.fillText(nm, x0, yy);
      ctx.fillStyle = 'rgba(180,178,168,0.16)'; ctx.fillRect(x0 + 62, yy - 2, bw, 3);
      ctx.save(); ctx.globalAlpha = sc.intro * glow; ctx.fillStyle = rgb(LIMEC, 0.9); ctx.fillRect(x0 + 62, yy - 2, bw * prog, 3);
      if (act) { ctx.shadowColor = 'rgba(198,244,50,0.9)'; ctx.shadowBlur = 8; ctx.fillStyle = '#f4ffc8'; ctx.fillRect(x0 + 62 + bw * prog - 2, yy - 3, 3, 5); }
      ctx.restore();
    });
    const d = Date.now(); const rem = Math.max(0, Math.ceil(d / 900000) * 900000 - d) / 1000; const mm = String(Math.floor(rem / 60)).padStart(2, '0'); const ss = String(Math.floor(rem % 60)).padStart(2, '0');
    let li = -1; let lt = 0; (sc.srcInfo ?? []).forEach((s2, i) => { if (s2?.last > lt) { lt = s2.last; li = i; } });
    const yb = y + 18 + 4 * 17 + 8; ctx.font = MONO(fs - 1.5); ctx.fillStyle = COL.chalk2; ctx.fillText('NEXT SCHEDULED TICK', x0, yb); ctx.fillStyle = COL.lime; ctx.font = MONO(13, 500); ctx.fillText(`${mm}:${ss}`, x0 + 128, yb);
    if (li >= 0) { ctx.font = MONO(fs - 1.5); ctx.fillStyle = COL.chalk2; ctx.fillText('LAST INGEST', x0, yb + 17); ctx.fillStyle = COL.chalk; ctx.fillText(`${srcShort(m.sources[li]?.id)} · ${fmt.ago(lt)}`, x0 + 128, yb + 17); }
  }

  // ---- relevance stripes (right edge): share of stored records with relevance >= 0.95, and the flagged share
  if (evMain && W >= 900 && z < 2.5) {
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
  const cRes = councilOverlay(ctx, sc, { W, H, narrow, calm, fs, items, hot, isHot, evMain, t });
  ctx.globalAlpha = 1;
  const hud = evMain && W >= 900 && z < 2.2 && !narrow ? [{ x: 16, y: cy - R * 0.62 - 34, w: 240, h: 150 }, { x: 16, y: cy + R * 0.3 - 16, w: 270, h: 160 }] : []; // keep point labels off the left readouts
  placeLabels(ctx, sc, items, { W, H, reserved: [...reserved, ...hud, ...(cRes ?? [])], narrow, labelsOn });
}

const OCSS = { shipped: '#c6f432', live: '#66ffcc', failed: '#ff4080', held: '#f2b84b', waiting: '#80d9ff', in_progress: '#f2b84b', ready: '#c6f432', not_started: '#8c8b82' };
const VCSS = { go: '#c6f432', watch: '#f2b84b', drop: '#8c8b82' }; const SCSS = { back: '#59ffd1', abstain: '#f2b84b', object: '#ff4080' };
const cut = (str, n) => (str.length > n ? `${str.slice(0, n - 1)}…` : str);

/** Labels, captions and the launch-lane text for the council star (and the small caption of whichever star is not in the middle). */
function councilOverlay(ctx, sc, { W, H, narrow, calm, fs, items, hot, isHot, evMain, t }) {
  const cs = sc.council; const v = cs.view; if (!v) return []; const e = cs.entry; const res = []; const oc = cs.data?.journey?.outcome; const main = v.main; const vcol = VCSS[e?.verdict ?? 'watch'];
  ctx.save(); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  if (main) {
    if (e) {
      ctx.font = MONO(fs - 1.5, 600); ctx.fillStyle = '#7ee9ff'; ctx.fillText((calm || (cs.cycle ?? 0) >= 10.3 ? 'COUNCIL STAR · VERDICT' : 'COUNCIL STAR · REPLAYING THE STORED VOTES'), W / 2, narrow ? 100 : 62);
      ctx.font = SERIF(narrow ? 22 : 30); ctx.fillStyle = 'rgba(236,233,223,0.95)'; ctx.fillText(cut(e.title, narrow ? 32 : 60), W / 2, narrow ? 128 : 92);
      ctx.font = MONO(fs, 600); ctx.fillStyle = vcol; ctx.shadowColor = vcol; ctx.shadowBlur = 10;
      ctx.fillText(`${(e.verdict === 'go' ? 'GO · WAITING TO BE BUILT' : e.verdict === 'watch' ? 'WATCH · NOT YET' : 'DROP').toUpperCase()}  ·  SUPPORT ${e.support.toFixed(2)}`, W / 2, narrow ? 150 : 118); ctx.shadowBlur = 0;
      if (oc) { ctx.font = MONO(fs, 600); ctx.fillStyle = OCSS[oc.state]; ctx.shadowColor = OCSS[oc.state]; ctx.shadowBlur = 8; ctx.fillText(`FINAL JUDGEMENT  ·  ${oc.headline.toUpperCase()}`, W / 2, narrow ? 172 : 142); ctx.shadowBlur = 0; ctx.font = MONO(fs - 1.5); ctx.fillStyle = COL.chalk2; ctx.fillText(cut(oc.next, narrow ? 44 : 110), W / 2, narrow ? 190 : 160); }
    } else { ctx.font = MONO(fs); ctx.fillStyle = COL.chalk2; ctx.fillText('The council has nothing to vote on yet.', W / 2, 90); }
    cs.seats.forEach((s) => { if (s.z < -40 || !s.vote) return; const c = s.lit ? SCSS[s.vote.stance] : COL.chalk3; items.push({ key: `seat${s.i}`, x: s.x, y: s.y, r: 12, a: s.lit ? 1 : 0.55, pr: isHot('seat', s.i) ? 0 : 3, lines: [[s.name.toUpperCase(), fs, COL.chalk, 600], [s.lit ? `${s.vote.support.toFixed(2)} · ${s.vote.stance}` : 'waiting…', fs - 1, c, 500]] }); });
    cs.cry.forEach((c) => { items.push({ key: `prod${c.i}`, x: c.x, y: c.y, r: c.r, a: c.z > 0 ? 1 : 0.5, pr: isHot('prod', c.i) ? 0 : c.win ? 1 : 4, lines: [[cut(c.o.title, 26), fs, c.win ? COL.chalk : COL.chalk2, 600], [c.win ? `${c.o.verdict.toUpperCase()} · WAITING TO BE BUILT` : `${c.o.verdict.toUpperCase()} · ${c.o.support.toFixed(2)}`, fs - 1, VCSS[c.o.verdict], 500]] }); });
    cs.lane.forEach((n, i) => { const c = n.state === 'done' ? '#c6f432' : n.state === 'active' ? '#f2b84b' : n.state === 'blocked' ? '#ff4080' : '#8c8b82'; ctx.font = MONO(narrow ? 8.5 : fs - 1, 600); ctx.fillStyle = c; ctx.fillText(narrow ? cut(n.label, 8).toUpperCase() : n.label.toUpperCase(), n.x, n.y + 24); if (!narrow) { ctx.font = MONO(fs - 2.5); ctx.fillStyle = COL.chalk3; ctx.fillText(cut(n.detail ?? '', 24), n.x, n.y + 38); } void i; });
    if (cs.podV) { const pv = cs.podV; const c = OCSS[oc?.state ?? 'not_started']; ctx.font = MONO(narrow ? 8.5 : fs - 1, 600); ctx.fillStyle = c; ctx.fillText('OUTCOME', pv.x, pv.y + pv.r + 16); if (!narrow && oc) { ctx.font = MONO(fs - 2.5); ctx.fillStyle = COL.chalk2; ctx.fillText(cut(oc.headline, 22), pv.x, pv.y + pv.r + 30); } if (isHot('outcome', 0)) { ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(pv.x, pv.y, pv.r * 1.7, 0, TAU); ctx.stroke(); ctx.setLineDash([]); } }
    if (cs.lane.length && !narrow) { ctx.font = MONO(fs - 2, 500); ctx.fillStyle = 'rgba(126,233,255,0.8)'; ctx.fillText('PRODUCT LAUNCH LANE · stage colours are the stored state of the journey', W / 2, cs.lane[0].y - 26); }
  } else {
    ctx.font = MONO(fs - 1, 600); ctx.fillStyle = '#7ee9ff'; ctx.fillText('COUNCIL', v.cx, v.cy + v.R * 2.6 + 6); ctx.font = MONO(fs - 2, 500); ctx.fillStyle = e ? vcol : COL.chalk3; ctx.fillText(e ? `${e.verdict.toUpperCase()} · ${cut(e.title, 18)}` : 'counting votes…', v.cx, v.cy + v.R * 2.6 + 20);
    if (oc) { ctx.fillStyle = OCSS[oc.state]; ctx.fillText(cut(oc.headline, 26), v.cx, v.cy + v.R * 2.6 + 33); ctx.fillStyle = COL.chalk3; ctx.fillText('click to open', v.cx, v.cy + v.R * 2.6 + 46); } else { ctx.fillStyle = COL.chalk3; ctx.fillText('click to open', v.cx, v.cy + v.R * 2.6 + 33); }
  }
  if (!evMain && sc.evView) { const ev = sc.evView; ctx.font = MONO(fs - 1, 600); ctx.fillStyle = '#ffcc77'; ctx.fillText('EVIDENCE', ev.cx, ev.cy + ev.R * 1.9 + 14); ctx.font = MONO(fs - 2, 500); ctx.fillStyle = COL.chalk3; ctx.fillText(`${sc.stats?.N ?? 0} stored records · click to open`, ev.cx, ev.cy + ev.R * 1.9 + 28); }
  if (evMain && sc.ov.streamCap && !narrow) { const c = sc.ov.streamCap; ctx.font = MONO(fs - 2, 600); ctx.fillStyle = 'rgba(126,233,255,0.85)'; ctx.fillText('EVIDENCE SUMMARY ▸ COUNCIL', c.x, c.y - 12); res.push({ x: c.x - 90, y: c.y - 24, w: 180, h: 20 }); }
  if (hot?.t === 'body') { const bv = hot.i === 1 ? v : sc.evView; if (bv) { ctx.strokeStyle = 'rgba(126,233,255,0.8)'; ctx.lineWidth = 1.4; ctx.setLineDash([4, 5]); ctx.lineDashOffset = calm ? 0 : -t * 14; ctx.beginPath(); ctx.arc(bv.cx, bv.cy, Math.max(30, bv.R * 2.2), 0, TAU); ctx.stroke(); ctx.setLineDash([]); } }
  ctx.restore();
  return res;
}
