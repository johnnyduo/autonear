// "The Leash": the owner's limits drawn as a boundary around the agent. Sources orbit and send pulses in; the ring is how much of the limits is used;
// the inner arc is the agent's fuel; a request is a beam that stops at the ring (Manual: waits for you) or passes through it (Auto).
// Canvas 2D on purpose: cheap, works everywhere, no WebGL fallback to maintain. The model (scene-model.js) is the only source of truth.
import { useEffect, useMemo, useRef, useState } from 'react';

const TAU = Math.PI * 2;
const css = (n, d) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d; } catch { return d; } };
const palette = () => ({ signal: css('--signal', '#c6f432'), risk: css('--risk', '#ff6a3d'), warn: css('--warn', '#f2b84b'), mineral: css('--mineral-hi', '#5fa3c2'), line: css('--line-hi', '#34414c'), chalk: css('--chalk', '#ece9df') });
const rgba = (hex, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const ease = (t) => t * t * (3 - 2 * t);

export default function LeashScene({ model, reducedMotion = false, className = '', label }) {
  const ref = useRef(null); const wrap = useRef(null);
  const [hover, setHover] = useState(null);
  const live = useRef({ model, hover: null }); live.current.model = model;
  const dust = useMemo(() => Array.from({ length: 70 }, (_, i) => ({ a: (i * 2.399) % TAU, r: 0.25 + ((i * 0.618) % 1) * 0.85, s: 0.4 + ((i * 7) % 5) / 5 })), []);

  useEffect(() => {
    const cv = ref.current; const box = wrap.current; if (!cv || !box) return undefined;
    const ctx = cv.getContext('2d'); const P = palette();
    let w = 0; let h = 0; let dpr = 1; let raf = 0; let visible = true; let t0 = performance.now(); const parts = []; let lastEmit = 0;
    const size = () => { const r = box.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); w = Math.max(1, r.width); h = Math.max(1, r.height); cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const geo = () => { const R = Math.min(w, h) * 0.47; return { cx: w / 2, cy: h / 2, R }; };
    const nodePos = (n, g) => ({ x: g.cx + Math.cos(n.angle) * g.R * 0.9, y: g.cy + Math.sin(n.angle) * g.R * 0.9 });

    const draw = (now) => {
      const m = live.current.model; const g = geo(); const t = (now - t0) / 1000; const calm = reducedMotion;
      ctx.clearRect(0, 0, w, h);
      const tone = m.state === 'paused' ? P.risk : m.state === 'demo' ? P.mineral : P.signal;
      // dust
      ctx.fillStyle = rgba(P.chalk, 0.16);
      for (const d of dust) { const a = d.a + (calm ? 0 : t * 0.01 * d.s); ctx.fillRect(g.cx + Math.cos(a) * g.R * d.r * 1.15, g.cy + Math.sin(a) * g.R * d.r * 1.05, d.s, d.s); }
      // orbit
      ctx.strokeStyle = rgba(P.line, 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R * 0.9, 0, TAU); ctx.stroke();
      // limits ring
      const rr = g.R * 0.56; const fill = m.ring.fill; const ringTone = fill > 0.9 ? P.risk : fill > 0.7 ? P.warn : tone;
      ctx.lineWidth = 2; ctx.setLineDash([2, 7]); ctx.strokeStyle = rgba(P.chalk, 0.22); ctx.beginPath(); ctx.arc(g.cx, g.cy, rr * 1.12, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.strokeStyle = rgba(P.line, 0.55); ctx.beginPath(); ctx.arc(g.cx, g.cy, rr, 0, TAU); ctx.stroke();
      if (m.ring.has && fill > 0) { ctx.strokeStyle = ringTone; ctx.shadowColor = ringTone; ctx.shadowBlur = calm ? 0 : 14; ctx.beginPath(); ctx.arc(g.cx, g.cy, rr, -Math.PI / 2, -Math.PI / 2 + TAU * fill); ctx.stroke(); ctx.shadowBlur = 0; }
      // core
      const breath = calm ? 1 : 1 + Math.sin(t * 1.6) * 0.04; const cr = g.R * 0.2 * breath;
      const grd = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, cr * 2.4); grd.addColorStop(0, rgba(tone, m.state === 'paused' ? 0.35 : 0.85)); grd.addColorStop(0.45, rgba(tone, 0.22)); grd.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(g.cx, g.cy, cr * 2.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0a0c0f'; ctx.beginPath(); ctx.arc(g.cx, g.cy, cr * 0.78, 0, TAU); ctx.fill();
      ctx.strokeStyle = tone; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.beginPath(); const k = cr * 0.34; ctx.moveTo(g.cx - k, g.cy + k); ctx.lineTo(g.cx - k, g.cy - k); ctx.lineTo(g.cx + k, g.cy + k); ctx.lineTo(g.cx + k, g.cy - k); ctx.stroke();
      // gas
      if (m.gas) { const gr = cr * 1.38; const gt = m.gas.low ? (calm || Math.sin(t * 5) > 0 ? P.risk : P.warn) : P.mineral; ctx.lineWidth = 3; ctx.strokeStyle = rgba(P.line, 0.5); ctx.beginPath(); ctx.arc(g.cx, g.cy, gr, 0, TAU); ctx.stroke(); ctx.strokeStyle = gt; ctx.beginPath(); ctx.arc(g.cx, g.cy, gr, Math.PI / 2, Math.PI / 2 + TAU * Math.max(0.02, m.gas.pct)); ctx.stroke(); }
      // sources + inbound pulses
      m.nodes.forEach((n, i) => {
        const p = nodePos(n, g); const c = n.tone === 'ok' ? P.signal : n.tone === 'warn' ? P.warn : n.tone === 'bad' ? P.risk : P.line;
        const isH = live.current.hover?.id === n.id;
        if (n.tone === 'ok' && n.fresh && !calm) { const k2 = (t * 0.5 + i * 0.37) % 1; ctx.strokeStyle = rgba(c, 0.35 * (1 - k2)); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 5 + k2 * 14, 0, TAU); ctx.stroke(); }
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, p.y, isH ? 7 : 5, 0, TAU); ctx.fill();
        if (isH) { ctx.strokeStyle = rgba(P.chalk, 0.7); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, TAU); ctx.stroke(); }
        if (!calm && n.tone === 'ok' && now - lastEmit > 260 && Math.random() < 0.012 * (m.state === 'paused' ? 0 : 1)) { parts.push({ n, born: now, dur: 1700 }); lastEmit = now; }
      });
      for (let i = parts.length - 1; i >= 0; i--) {
        const pt = parts[i]; const k2 = (now - pt.born) / pt.dur; if (k2 >= 1) { parts.splice(i, 1); continue; }
        const a = nodePos(pt.n, g); const e = ease(k2); const x = a.x + (g.cx - a.x) * e; const y = a.y + (g.cy - a.y) * e;
        ctx.fillStyle = rgba(P.mineral, 1 - k2 * 0.6); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(P.mineral, 0.25 * (1 - k2)); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
      }
      // request beams
      m.beams.forEach((b, i) => {
        const ang = -Math.PI / 2 + TAU * ((i + 0.5) / Math.max(1, m.beams.length)) + 0.5; const cyc = calm ? 0.75 : ((t * 0.32 + b.phase) % 1);
        const reach = b.waiting ? Math.min(1, cyc * 1.5) * rr * 0.98 : cyc * g.R * 0.9;
        const x = g.cx + Math.cos(ang) * (cr + reach); const y = g.cy + Math.sin(ang) * (cr + reach);
        const fade = b.waiting ? 1 : 1 - Math.max(0, (cyc - 0.7) / 0.3);
        ctx.strokeStyle = rgba(P.signal, 0.35 * fade); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(g.cx + Math.cos(ang) * cr, g.cy + Math.sin(ang) * cr); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = rgba(P.signal, fade); ctx.shadowColor = P.signal; ctx.shadowBlur = calm ? 0 : 12; ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
        if (b.waiting) { const gx = g.cx + Math.cos(ang) * rr; const gy = g.cy + Math.sin(ang) * rr; ctx.strokeStyle = rgba(P.warn, calm ? 0.9 : 0.5 + Math.sin(t * 4 + i) * 0.4); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(gx, gy, 10, 0, TAU); ctx.stroke(); }
      });
    };

    live.current.draw = draw;
    const loop = (now) => { draw(now); raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0; };
    const kick = () => { if (!raf && !reducedMotion) raf = requestAnimationFrame(loop); };
    size(); draw(performance.now());
    if (!reducedMotion) kick();
    const ro = new ResizeObserver(() => { size(); draw(performance.now()); }); ro.observe(box);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }); io.observe(box);
    const vis = () => kick(); document.addEventListener('visibilitychange', vis);
    const move = (e) => {
      const r = cv.getBoundingClientRect(); const x = e.clientX - r.left; const y = e.clientY - r.top; const g = geo();
      const hit = live.current.model.nodes.find((n) => { const p = nodePos(n, g); return (p.x - x) ** 2 + (p.y - y) ** 2 < 18 * 18; });
      if ((hit?.id ?? null) !== (live.current.hover?.id ?? null)) { live.current.hover = hit ?? null; setHover(hit ? { ...hit, ...nodePos(hit, g) } : null); if (reducedMotion) draw(performance.now()); }
    };
    const leave = () => { live.current.hover = null; setHover(null); if (reducedMotion) draw(performance.now()); };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerleave', leave);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', vis); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerleave', leave); };
  }, [reducedMotion, dust]);

  useEffect(() => { if (reducedMotion) live.current.draw?.(performance.now()); }, [model, reducedMotion]); // a calm scene has no frame loop: repaint on change

  return (
    <div ref={wrap} className={`leash ${className}`} role="img" aria-label={label ?? model.summary}>
      <canvas ref={ref} className="leash-cv" />
      {hover && <div className="leash-tip" style={{ left: hover.x, top: hover.y }}>{hover.name}<span>{hover.tone === 'ok' ? 'working' : hover.tone === 'warn' ? 'slow' : hover.tone === 'off' ? 'off' : 'having trouble'}</span></div>}
      <ul className="sr">{model.nodes.map((n) => <li key={n.id}>{n.name}: {n.tone}</li>)}</ul>
      <p className="sr" aria-live="polite">{model.summary}</p>
    </div>
  );
}
