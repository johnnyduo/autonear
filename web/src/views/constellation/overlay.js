// 2D overlay: score rings, source pulses, agent-role glyphs, selection marks and collision-free labels. Crisp text stays out of the GL pass.
import { fmt } from '../../api.js';
import { srcShort } from '../_evidence-parts.jsx';
import { lastIngest } from './shared.js';

const TAU = Math.PI * 2;
export const COL = { lime: '#c6f432', risk: '#ff6a3d', chalk: '#ece9df', chalk2: '#b4b2a8', chalk3: '#8c8b82', ink: '#0a0c0f', warn: '#f2b84b' };
const FONT = (px, w = 500) => `${w} ${px}px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,Menlo,monospace`;
const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
export const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function srcLines(info, s) {
  const when = info.last;
  const l2 = info.bad ? String(info.status).replace('_', ' ') : info.recent ? `ingested ${fmt.ago(when)}` : when ? `quiet · ${fmt.ago(when)}` : 'never ingested';
  return [srcShort(s.id).toUpperCase(), l2];
}

export function drawOverlay(ctx, scene, { W, H, dpr, reserved = [], calm, narrow, labelsOn = true }) {
  const ov = scene.ov; const t = scene.t;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.textBaseline = 'middle'; ctx.lineCap = 'round';
  const items = []; const fs = narrow ? 9.5 : 10.5;
  const hot = scene.hover ?? scene.pinned ?? scene.focus; const isHot = (t_, i) => hot && hot.t === t_ && hot.i === i;

  // flagged records: red ring (bot / duplicate / injection flag)
  for (const f of ov.flagged) { ctx.strokeStyle = rgba([1, 0.416, 0.239], 0.9 * f.a); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.stroke(); }

  // opportunity hubs: outer arc = score, inner arc = confidence (stored values)
  for (const w of ov.wells) {
    const wl = w.wl; const R = Math.max(10, Math.min(32, w.r)); const a = w.a;
    if (wl.opp) {
      const sc = Math.max(0, Math.min(1, wl.opp.score ?? 0)); const cf = Math.max(0, Math.min(1, wl.opp.confidence ?? 0));
      ctx.lineWidth = 1.4; ctx.strokeStyle = rgba([0.93, 0.91, 0.87], 0.16 * a); ctx.beginPath(); ctx.arc(w.x, w.y, R, 0, TAU); ctx.stroke();
      ctx.lineWidth = 2.4; ctx.strokeStyle = rgba([0.776, 0.957, 0.196], 0.95 * a); ctx.beginPath(); ctx.arc(w.x, w.y, R, -Math.PI / 2, -Math.PI / 2 + sc * TAU); ctx.stroke();
      const r2 = R - 5; ctx.lineWidth = 1; ctx.strokeStyle = rgba([0.93, 0.91, 0.87], 0.12 * a); ctx.beginPath(); ctx.arc(w.x, w.y, r2, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.4; ctx.strokeStyle = rgba([0.8, 0.85, 0.9], 0.75 * a); ctx.beginPath(); ctx.arc(w.x, w.y, r2, -Math.PI / 2, -Math.PI / 2 + cf * TAU); ctx.stroke();
    } else {
      ctx.setLineDash([2, 4]); ctx.lineWidth = 1; ctx.strokeStyle = rgba([0.93, 0.91, 0.87], 0.4 * a); ctx.beginPath(); ctx.arc(w.x, w.y, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    }
    const l1 = wl.label.toUpperCase(); const l2 = wl.opp ? `${wl.opp.score.toFixed(2)} score · ${wl.linked} rec` : `${wl.linked} rec · no hub`;
    items.push({ key: `w${w.i}`, x: w.x, y: w.y, r: R + 4, a, pr: isHot('well', w.i) ? 0 : 1, lines: [[l1, fs + 0.5, COL.chalk, 600], [l2, fs - 1, wl.opp ? COL.lime : COL.chalk2, 500]] });
  }

  // source emitters
  for (const s of ov.srcs) {
    const info = s.info; const src = scene.model.sources[s.i]; const R = Math.max(8, Math.min(24, s.r)); const a = s.a;
    const tone = info.bad ? [1, 0.416, 0.239] : info.recent ? [0.776, 0.957, 0.196] : [0.7, 0.7, 0.66];
    ctx.lineWidth = info.recent ? 1.8 : 1.1; ctx.strokeStyle = rgba(tone, (info.recent ? 0.95 : 0.55) * a); if (!info.recent && !info.bad) ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (info.recent && !calm) { const ph = (t / 2.4) % 1; ctx.strokeStyle = rgba(tone, 0.7 * (1 - ph) * a); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(s.x, s.y, R + R * 1.7 * ph, 0, TAU); ctx.stroke(); }
    if (s.fl && !calm) { const u = (t - s.fl.t) / 0.6; if (u >= 0 && u < 1) { ctx.strokeStyle = rgba([0.776, 0.957, 0.196], 0.8 * (1 - u) * a); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(s.x, s.y, R + R * 1.4 * u, 0, TAU); ctx.stroke(); } }
    const [n1, n2] = srcLines(info, src);
    items.push({ key: `s${s.i}`, x: s.x, y: s.y, r: R + 4, a, pr: isHot('src', s.i) ? 0 : 2, lines: [[n1, fs + 0.5, COL.chalk, 600], [n2, fs - 1, info.bad ? COL.risk : info.recent ? COL.lime : COL.chalk2, 500]] });
  }

  // agent roles: dark when idle, lit only from real run events
  for (const r of ov.roles) {
    const u = Math.max(0.8, Math.min(1.5, r.u)); const sz = 5.2 * u; const a = r.a;
    const tone = r.st === 'halted' ? [1, 0.416, 0.239] : [0.776, 0.957, 0.196];
    if (r.st === 'working' && !calm) { const ph = (t / 1.8) % 1; ctx.strokeStyle = rgba(tone, 0.75 * (1 - ph)); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(r.x, r.y, sz + 16 * ph, 0, TAU); ctx.stroke(); }
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.PI / 4); ctx.beginPath(); ctx.rect(-sz * 0.7, -sz * 0.7, sz * 1.4, sz * 1.4);
    ctx.fillStyle = r.lit ? rgba(tone, 0.95) : 'rgba(10,12,15,0.9)'; ctx.fill(); ctx.lineWidth = r.st === 'working' ? 2 : 1.2; ctx.strokeStyle = r.lit ? rgba(tone, 1) : rgba([0.55, 0.55, 0.51], 0.8 * a); ctx.stroke(); ctx.restore();
    if (r.lit || (!narrow && labelsOn)) items.push({ key: `r${r.i}`, x: r.x, y: r.y, r: sz + 5, a: r.lit ? 1 : 0.9 * a, pr: isHot('role', r.i) ? 0 : r.lit ? 2 : 4, lines: [[r.role[2], fs - 1, r.lit ? COL.chalk : COL.chalk3, 500], ...(r.lit ? [[r.st, fs - 1.5, r.st === 'halted' ? COL.risk : COL.lime, 500]] : [])] });
  }

  // marks
  for (const m of ov.marks) {
    if (m.kind === 'hover') { ctx.strokeStyle = 'rgba(236,233,223,0.85)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.stroke(); }
    if (m.kind === 'pinned') { ctx.strokeStyle = COL.lime; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 2, 0, TAU); ctx.stroke(); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; ctx.beginPath(); ctx.moveTo(m.x + Math.cos(a) * (m.r + 5), m.y + Math.sin(a) * (m.r + 5)); ctx.lineTo(m.x + Math.cos(a) * (m.r + 11), m.y + Math.sin(a) * (m.r + 11)); ctx.stroke(); } }
    if (m.kind === 'focus') { ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.lime; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
  }

  placeLabels(ctx, scene, items, { W, H, reserved, narrow, labelsOn });
}

/** Collision-free labels (lowest priority number first; remembered placement + fade avoid flicker). items: {key,x,y,r,a,pr,lines:[[text,px,color,weight]]} */
export function placeLabels(ctx, scene, items, { W, H, reserved = [], labelsOn = true }) {
  if (!labelsOn) return;
  const placed = [...reserved]; scene.labelState ??= new Map();
  const cand = (it, w, h, k) => {
    const g = 6; const { x, y, r } = it;
    switch (k) {
      case 0: return { x: x + r + g, y: y - h / 2 }; case 1: return { x: x - r - g - w, y: y - h / 2 };
      case 2: return { x: x - w / 2, y: y - r - g - h }; case 3: return { x: x - w / 2, y: y + r + g };
      case 4: return { x: x + r * 0.7 + g, y: y - r * 0.7 - g - h }; case 5: return { x: x + r * 0.7 + g, y: y + r * 0.7 + g };
      case 6: return { x: x - r * 0.7 - g - w, y: y - r * 0.7 - g - h }; default: return { x: x - r * 0.7 - g - w, y: y + r * 0.7 + g };
    }
  };
  items.sort((a, b) => a.pr - b.pr);
  const seen = new Set();
  for (const it of items) {
    seen.add(it.key);
    ctx.font = FONT(it.lines[0][1], it.lines[0][3]);
    let w = 0; const lh = it.lines.map((l) => l[1] + 3); let h = 0;
    for (const l of it.lines) { ctx.font = FONT(l[1], l[3]); w = Math.max(w, ctx.measureText(l[0]).width); h += l[1] + 3; }
    const st = scene.labelState.get(it.key) ?? { k: it.pref ?? 0, a: 0 };
    let chosen = null; let ck = st.k;
    const order = [st.k, 0, 1, 2, 3, 4, 5, 6, 7].filter((v, i, arr) => arr.indexOf(v) === i);
    for (const k of order) {
      const p = cand(it, w, h, k); const rect = { x: p.x - 3, y: p.y - 2, w: w + 6, h: h + 4 };
      if (rect.x < 4 || rect.y < 4 || rect.x + rect.w > W - 4 || rect.y + rect.h > H - 4) continue;
      if (placed.some((q) => hit(rect, q))) continue;
      chosen = { p, rect }; ck = k; break;
    }
    const target = chosen ? 1 : 0; st.k = ck; st.a += (target - st.a) * 0.22; scene.labelState.set(it.key, st);
    if (!chosen && st.a < 0.03) continue;
    const pos = chosen ? chosen.p : cand(it, w, h, st.k); const rect = chosen ? chosen.rect : { x: pos.x - 3, y: pos.y - 2, w: w + 6, h: h + 4 };
    if (chosen) placed.push(rect);
    if (chosen && it.lead) { ctx.strokeStyle = `rgba(180,178,168,${0.4 * st.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(it.lead.x, it.lead.y); ctx.lineTo(it.x, it.y); ctx.stroke(); }
    let y = pos.y; ctx.shadowColor = 'rgba(6,8,10,0.95)'; ctx.shadowBlur = 5; ctx.textAlign = 'left';
    for (const l of it.lines) { ctx.font = FONT(l[1], l[3]); ctx.globalAlpha = Math.max(0, Math.min(1, st.a * Math.max(it.a, 0.55))); ctx.fillStyle = l[2]; ctx.fillText(l[0], pos.x, y + l[1] / 2); y += l[1] + 3; }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  }
  for (const k of scene.labelState.keys()) if (!seen.has(k)) scene.labelState.delete(k);
}
