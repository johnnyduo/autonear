// Landing hero extras: the thread from the headline to the sphere, pointer parallax, atmosphere layers and the topic ticker.
// One requestAnimationFrame loop drives everything that moves; it only writes transforms, opacity and the thread's path data.
// Geometry is read when the page is laid out or resized, never per frame. With reduced motion nothing moves: the thread is drawn once, at rest.
import { useEffect, useRef } from 'react';
import { TOPIC_LABELS } from './landing-demo.js';
import {
  clamp, springStep, dampingFor, sagFromTension, sagLimit, taperWidth, threadPoints, curveSegments, sampleSegments,
  cumulative, pointAt, narrowSegments, head, ribbonPath, polylinePath,
} from './landing-fx.js';

const NARROW = '(max-width: 900px)';
const LAYER = { atmo: 10, stage: 6, copy: 3, tilt: 1.5 }; // largest shift in px, and tilt in degrees
const REVEAL_AT = 1.05; // seconds after mount: the headline has risen, the thread is thrown to the sphere
const REVEAL_FOR = 1.5;
const PULSES = [0, 0.34, 0.67];
const ease3 = (t) => 1 - (1 - t) ** 3;
const r2 = (n) => Math.round(n * 100) / 100;

// offset of el inside root, ignoring transforms (they move with the pointer)
function box(el, root) {
  let x = 0; let y = 0;
  for (let n = el; n && n !== root; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

// where the text of el really is (its lines), inside root; the block itself is wider than its text
function textRect(el, root) {
  const rg = document.createRange(); rg.selectNodeContents(el);
  const h = root.getBoundingClientRect(); let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
  for (const q of rg.getClientRects()) { l = Math.min(l, q.left - h.left); t = Math.min(t, q.top - h.top); r = Math.max(r, q.right - h.left); b = Math.max(b, q.bottom - h.top); }
  return { l, t, r, b };
}

export default function LandingFx({ heroRef, calm }) {
  const atmo = useRef(null); const spot = useRef(null); const svg = useRef(null);
  const glowA = useRef(null); const glowB = useRef(null); const core = useRef(null);
  const knot = useRef(null); const ring = useRef(null); const pulse = useRef([]);

  useEffect(() => {
    const hero = heroRef.current; const el = { atmo: atmo.current, spot: spot.current, svg: svg.current, glowA: glowA.current, glowB: glowB.current, core: core.current, knot: knot.current, ring: ring.current, pulse: pulse.current };
    if (!hero || !el.svg) return undefined;
    const bg = hero.querySelector('.ln-bg'); const copy = hero.querySelector('.ln-copy');
    const mqNarrow = matchMedia(NARROW);
    const coarse = matchMedia('(hover: none), (pointer: coarse)').matches;

    const G = { ok: false, start: [0, 0], end: [0, 0], len: 1, limit: Infinity, narrow: false, gutterX: 0, midY: 0 };
    const S = {
      ten: { x: 0, v: 0 }, hover: false, focus: false,
      sag: [{ x: 0, v: 0 }, { x: 0, v: 0 }], sway: [{ x: 0, v: 0 }, { x: 0, v: 0 }], seeded: false,
      nx: 0, ny: 0, cx: 0, cy: 0, px: 0, py: 0, in: false, spotA: 0, lx: 0, ly: 0, // pointer target, eased pointer, pointer inside, spotlight opacity and position
      clock: 0, t: 0, wall: 0, ringIn: 0, rect: null, rectDirty: true, written: { a: '', b: '', c: '' },
    };

    const measure = () => {
      const em = hero.querySelector('h1 em'); const word = em?.lastElementChild; const sub = hero.querySelector('.ln-sub');
      if (!bg || !word) { G.ok = false; return; }
      G.narrow = mqNarrow.matches;
      const w = box(word, hero); const b = box(bg, hero); const fs = parseFloat(getComputedStyle(word).fontSize) || 48;
      G.start = [w.x + w.w - 0.06 * fs + 5, w.y + fs * 0.57];
      // the engine puts the sphere's centre this far above the middle of the stage (its top and bottom margins differ, see fitInfo in sphere.js)
      const cx = b.x + b.w / 2; const cy = b.y + b.h / 2 - (b.w < 640 ? 19 : 15);
      if (G.narrow) {
        G.end = [cx, cy - Math.min(b.w * 0.36, b.h * 0.34)];
        G.gutterX = hero.offsetWidth - 7; G.midY = b.y + b.h * 0.08; G.limit = Infinity;
      } else {
        G.end = [cx, cy];
        G.limit = sub ? sagLimit(G.start, G.end, textRect(sub, hero)) : Infinity;
      }
      G.len = Math.hypot(G.end[0] - G.start[0], G.end[1] - G.start[1]);
      G.ok = G.len > 40; el.svg.classList.toggle('on', G.ok);
      S.rectDirty = true;
    };

    const sagTarget = () => {
      const t = clamp(S.ten.x, 0, 1);
      return G.narrow ? 6 * (1 - t) : sagFromTension(G.len, t, { max: G.limit });
    };

    // geometry in, DOM writes out. `parts` holds the eased parallax offsets.
    const draw = (reveal, pulses) => {
      if (!G.ok || reveal <= 0) { for (const k of ['glowA', 'glowB', 'core']) el[k].setAttribute('d', ''); el.knot.style.opacity = 0; el.ring.style.opacity = 0; for (const p of el.pulse) p.style.opacity = 0; return; }
      const par = !calm && !G.narrow;
      const sx = par ? -S.cx * LAYER.stage : 0; const sy = par ? -S.cy * LAYER.stage : 0;
      const kx = par ? S.cx * LAYER.copy : 0; const ky = par ? S.cy * LAYER.copy : 0;
      const start = [G.start[0] + kx, G.start[1] + ky]; const end = [G.end[0] + sx, G.end[1] + sy];
      const tens = clamp(S.ten.x, 0, 1);
      const sag = [S.sag[0].x, S.sag[1].x]; const sway = [S.sway[0].x, S.sway[1].x];
      const segs = G.narrow ? narrowSegments(start, end, { gutterX: G.gutterX, midY: G.midY, sag, sway }) : curveSegments(threadPoints(start, end, { sag, sway }));
      const line = sampleSegments(segs, 14); const cum = cumulative(line);
      const part = head(line, cum, reveal);
      const w0 = 2.6 + 0.9 * tens;
      const d = ribbonPath(part, (u) => taperWidth(u, w0, 0.7), line.length);
      el.core.setAttribute('d', d);
      const center = polylinePath(part);
      el.glowA.setAttribute('d', center); el.glowB.setAttribute('d', center);
      el.glowA.style.opacity = r2(0.07 + 0.1 * tens); el.glowB.style.opacity = r2(0.2 + 0.25 * tens);
      el.core.style.opacity = r2(0.88 + 0.12 * tens);
      el.knot.setAttribute('transform', `translate(${r2(start[0])} ${r2(start[1])})`); el.knot.style.opacity = Math.min(1, reveal * 8);
      if (reveal >= 1) {
        const k = S.ringIn * (1 - 0.18 * tens);
        el.ring.setAttribute('transform', `translate(${r2(end[0])} ${r2(end[1])}) scale(${r2(k)})`); el.ring.style.opacity = r2(Math.min(1, S.ringIn * 1.4) * (0.8 + 0.2 * tens));
      } else el.ring.style.opacity = 0;
      PULSES.forEach((ph, i) => {
        const p = el.pulse[i];
        const u = (ph + S.clock) % 1;
        if (!pulses || u >= reveal) { p.style.opacity = 0; return; }
        const at = pointAt(line, cum, u);
        p.setAttribute('transform', `translate(${r2(at[0])} ${r2(at[1])})`); p.style.opacity = r2(Math.sin(Math.PI * u) ** 0.7 * (0.75 + 0.25 * tens));
      });
    };

    const write = (key, node, value) => { if (S.written[key] !== value) { S.written[key] = value; node.style.transform = value; } };
    const applyParallax = () => {
      if (calm || G.narrow) { if (S.written.a) { for (const [k, n] of [['a', el.atmo], ['b', bg], ['c', copy]]) { S.written[k] = ''; if (n) n.style.transform = ''; } } return; }
      const x = r2(S.cx); const y = r2(S.cy);
      write('a', el.atmo, `translate3d(${r2(-x * LAYER.atmo)}px, ${r2(-y * LAYER.atmo)}px, 0)`);
      if (bg) write('b', bg, `perspective(1400px) translate3d(${r2(-x * LAYER.stage)}px, ${r2(-y * LAYER.stage)}px, 0) rotateX(${r2(y * LAYER.tilt)}deg) rotateY(${r2(-x * LAYER.tilt)}deg)`);
      if (copy) write('c', copy, `translate3d(${r2(x * LAYER.copy)}px, ${r2(y * LAYER.copy)}px, 0)`);
    };

    // reduced motion: draw the thread once, at rest, and again after a resize
    const still = () => {
      measure();
      S.sag.forEach((s) => { s.x = sagTarget(); s.v = 0; }); S.ringIn = 1;
      draw(1, false); applyParallax();
    };

    let raf = 0; let last = 0; let running = false; let inView = true;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const raw = (now - last) / 1000; const dt = Math.min(0.05, raw); last = now; S.t += dt; S.wall += raw; // the thread's entrance follows the clock, the physics follows capped steps
      if (!S.seeded && G.ok) { S.sag.forEach((s) => { s.x = sagTarget() * 0.4; }); S.seeded = true; }
      // pointer: eased toward its target; touch devices drift slowly on their own
      if (coarse) { S.nx = Math.sin(S.t * 0.11) * 0.8; S.ny = Math.cos(S.t * 0.083) * 0.6; }
      const ease = 1 - Math.exp(-dt * 4.5);
      S.cx += (S.nx - S.cx) * ease; S.cy += (S.ny - S.cy) * ease;
      applyParallax();
      if (!coarse) {
        if (S.rectDirty) { S.rect = hero.getBoundingClientRect(); S.rectDirty = false; }
        const fast = 1 - Math.exp(-dt * 9);
        S.lx += (S.px - S.lx) * fast; S.ly += (S.py - S.ly) * fast;
        S.spotA += ((S.in ? 1 : 0) - S.spotA) * (1 - Math.exp(-dt * 3));
        el.spot.style.transform = `translate3d(${r2(S.lx - 280)}px, ${r2(S.ly - 280)}px, 0)`; el.spot.style.opacity = r2(S.spotA);
      }
      // thread: tension eases toward 1 while the button is hovered or focused; the slack follows through springs
      S.ten = springStep(S.ten, S.hover || S.focus ? 1 : 0, 70, dampingFor(70, 0.8), dt);
      const tens = clamp(S.ten.x, 0, 1); const target = sagTarget();
      S.sag[0] = springStep(S.sag[0], target, 34, dampingFor(34, 0.26), dt);
      S.sag[1] = springStep(S.sag[1], target, 22, dampingFor(22, 0.3), dt);
      const wind = (1 - 0.85 * tens) * (G.narrow ? 1.5 : 4);
      for (let i = 0; i < 2; i++) S.sway[i] = springStep(S.sway[i], Math.sin(S.t * (0.55 + i * 0.23) + i * 1.9) * wind + (G.narrow ? 0 : S.cx * 6 * (1 - tens)), 18, dampingFor(18, 0.35), dt);
      S.clock += dt * 0.16 * (1 + 2.4 * tens);
      const reveal = ease3(clamp((S.wall - REVEAL_AT) / REVEAL_FOR, 0, 1));
      if (reveal >= 1) S.ringIn = ease3(clamp((S.wall - REVEAL_AT - REVEAL_FOR) / 0.7, 0, 1));
      draw(reveal, true);
    };
    const run = () => {
      const want = !calm && inView && !document.hidden;
      if (want && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
      else if (!want && running) { running = false; cancelAnimationFrame(raf); }
    };

    const onMove = (e) => {
      if (calm || coarse || e.pointerType === 'touch') return;
      S.in = true; S.px = e.clientX - (S.rect?.left ?? 0); S.py = e.clientY - (S.rect?.top ?? 0);
      S.nx = clamp((e.clientX / innerWidth) * 2 - 1, -1, 1); S.ny = clamp((e.clientY / innerHeight) * 2 - 1, -1, 1);
    };
    const onLeave = () => { S.in = false; S.nx = 0; S.ny = 0; };
    const onDirty = () => { S.rectDirty = true; };
    const btn = (e) => e.target?.closest?.('.btn.primary');
    const hoverOn = (e) => { if (btn(e)) S.hover = true; };
    const hoverOff = (e) => { if (btn(e) && !e.relatedTarget?.closest?.('.btn.primary')) S.hover = false; };
    const focusOn = (e) => { if (btn(e)) S.focus = true; };
    const focusOff = (e) => { if (btn(e)) S.focus = false; };
    const cta = hero.querySelector('.ln-cta');

    const relayout = () => { if (calm) still(); else { measure(); if (!running) draw(0, false); } };
    const ro = new ResizeObserver(relayout);
    ro.observe(hero); const h1 = hero.querySelector('h1'); if (h1) ro.observe(h1);
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; run(); }, { threshold: 0 });
    io.observe(hero);
    const vis = () => run();
    document.addEventListener('visibilitychange', vis);
    document.fonts?.ready.then(relayout).catch(() => {});
    document.fonts?.addEventListener?.('loadingdone', relayout);
    mqNarrow.addEventListener('change', relayout);
    if (!calm) {
      hero.addEventListener('pointermove', onMove, { passive: true }); hero.addEventListener('pointerleave', onLeave);
      addEventListener('scroll', onDirty, { passive: true }); addEventListener('resize', onDirty);
      cta?.addEventListener('pointerover', hoverOn); cta?.addEventListener('pointerout', hoverOff);
      cta?.addEventListener('focusin', focusOn); cta?.addEventListener('focusout', focusOff);
    }
    if (calm) still(); else { measure(); run(); }

    return () => {
      cancelAnimationFrame(raf); running = false;
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', vis);
      document.fonts?.removeEventListener?.('loadingdone', relayout); mqNarrow.removeEventListener('change', relayout);
      hero.removeEventListener('pointermove', onMove); hero.removeEventListener('pointerleave', onLeave);
      removeEventListener('scroll', onDirty); removeEventListener('resize', onDirty);
      cta?.removeEventListener('pointerover', hoverOn); cta?.removeEventListener('pointerout', hoverOff);
      cta?.removeEventListener('focusin', focusOn); cta?.removeEventListener('focusout', focusOff);
      for (const n of [el.atmo, bg, copy]) if (n) n.style.transform = '';
    };
  }, [heroRef, calm]);

  const group = TOPIC_LABELS.flatMap((t) => [<span key={t}>{t}</span>, <i key={`${t}-d`} />]);
  return (
    <>
      <div className="ln-fx" ref={atmo} aria-hidden="true">
        <i className="ln-aurora" /><i className="ln-grid" /><i className="ln-spot" ref={spot} />
      </div>
      <svg className="ln-leash" ref={svg} aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="ln-halo"><stop offset="0" stopColor="#e6ff8a" stopOpacity=".55" /><stop offset="1" stopColor="#c6f432" stopOpacity="0" /></radialGradient>
        </defs>
        <path ref={glowA} className="ln-leash-glow a" fill="none" />
        <path ref={glowB} className="ln-leash-glow b" fill="none" />
        <path ref={core} className="ln-leash-core" />
        <circle ref={knot} className="ln-leash-knot" r="2.4" />
        {PULSES.map((p, i) => <g key={p} ref={(n) => { pulse.current[i] = n; }} className="ln-leash-pulse"><circle r="7" fill="url(#ln-halo)" /><circle r="1.5" fill="#f4ffc4" /></g>)}
        <g ref={ring} className="ln-leash-ring"><circle className="wave" r="9" /><circle className="rim" r="9" /><circle className="dot" r="2.2" /></g>
      </svg>
      <div className="ln-fx-over" aria-hidden="true" />
      <div className="ln-ticker" aria-hidden="true">
        <div className="ln-ticker-track"><div>{group}</div><div>{group}</div></div>
      </div>
    </>
  );
}
