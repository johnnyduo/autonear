import React from 'react';
import { C, F } from '../theme';
import { cl, lerp } from '../cine2/kinetic';

/** damped oscillation: 1 at u=0, rings and settles to 0 (the jelly wobble) */
export const wob = (u: number, zeta = 0.2, w = 26) => (u < 0 ? 0 : Math.exp(-zeta * w * u) * Math.cos(w * Math.sqrt(1 - zeta * zeta) * u));

/**
 * Physics-jelly headline. Each letter falls in, hits the line, SQUASHES wide and flat, then rings like jelly (volume-preserving: wider = shorter,
 * taller = thinner) with a travelling phase so the wobble rolls along the word. `kicks` are times (sec, same clock as `sec`) where the whole
 * word gets poked again; `out` makes the letters squish away. Glossy gel fill: bright top highlight, saturated body, deep base, soft glow.
 */
export const JellyText: React.FC<{
  text: string; sec: number; at: number; size: number; kicks?: number[]; out?: number; stagger?: number;
  colors?: [string, string, string]; family?: string; align?: 'left' | 'center' | 'right'; glow?: string; idle?: number; spacing?: number;
}> = ({ text, sec, at, size, kicks = [], out, stagger = 0.04, colors = ['#fdffe8', '#dcff4a', '#8fd10e'], family = F.kinetic, align = 'left', glow = 'rgba(198,244,50,0.45)', idle = 0.025, spacing = 0 }) => {
  const chars = [...text];
  const n = chars.length;
  return (
    <div style={{ fontFamily: family, fontSize: size, fontWeight: 900, lineHeight: 1.04, whiteSpace: 'pre', textAlign: align, letterSpacing: spacing, display: 'inline-block', filter: `drop-shadow(0 6px 0 rgba(0,0,0,0.35)) drop-shadow(0 0 ${size * 0.35}px ${glow})`, fontVariationSettings: "'wdth' 112, 'wght' 900" }}>
      {chars.map((ch, i) => {
        if (ch === ' ') return <span key={i} style={{ display: 'inline-block', width: size * 0.28 }} />;
        const u = sec - at - i * stagger;
        const fall = 0.26;
        let ty = 0, sx = 1, sy = 1, rot = 0, op = cl(u / 0.06);
        if (u < fall) { const p = cl(u / fall); ty = -size * 0.8 * (1 - p * p); sy = 1 + (1 - p) * 0.35; sx = 1 - (1 - p) * 0.14; }
        else { const w = wob(u - fall, 0.17, 24 + (i % 3)); sx = 1 + 0.42 * w; sy = 1 - 0.42 * w; ty = size * 0.1 * w * (1 - Math.abs(w) * 0.2); rot = Math.sin(i * 1.7) * 3.2 * w; }
        for (const k of kicks) { const ku = sec - k - i * stagger * 0.7; if (ku > 0) { const w = wob(ku, 0.18, 26); sx += 0.28 * w; sy -= 0.28 * w; ty += size * 0.07 * w; } }
        const idl = 1 + idle * Math.sin(sec * 3.1 + i * 0.8); sy *= idl; sx /= idl;
        let q = 0;
        if (out !== undefined) { q = cl((sec - out - i * 0.018) / 0.45); sx *= 1 + q * 1.8; sy *= 1 - q * 0.92; ty += q * size * 0.25; op *= 1 - q; }
        return (
          <span key={i} style={{ display: 'inline-block', opacity: op, transformOrigin: '50% 100%', transform: `translateY(${ty}px) rotate(${rot}deg) scale(${sx}, ${sy})`, background: `linear-gradient(180deg, ${colors[0]} 0%, ${colors[1]} 38%, ${colors[2]} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextStroke: `${Math.max(1, size * 0.012)}px rgba(255,255,255,0.35)` }}>{ch}</span>
        );
      })}
    </div>
  );
};
export { lerp };

/** Callout label for a measured element: outline pulse + jelly-popping tag. Coordinates are footage pixels (1920x1080 space). */
export const Callout: React.FC<{ x: number; y: number; w: number; h: number; text: string; sec: number; at: number; until?: number; side?: 'top' | 'bottom' | 'left' | 'right'; color?: string; pad?: number; zoom?: number }> = ({ x, y, w, h, text, sec, at, until, side = 'bottom', color = '#c6f432', pad = 10, zoom = 1 }) => {
  const u = sec - at;
  if (u < -0.01 || (until !== undefined && sec > until + 0.5)) return null;
  const outQ = until !== undefined ? cl((sec - until) / 0.35) : 0;
  const pop = u < 0.18 ? cl(u / 0.18) * 1.12 : 1 + 0.12 * wob(u - 0.18, 0.2, 24);
  const sc = pop * (1 - outQ * 0.2); const op = cl(u / 0.12) * (1 - outQ);
  const ring = 0.5 + 0.5 * Math.sin(u * 6);
  const fs = 25 / Math.max(0.8, Math.min(1.6, zoom) * 0.75 + 0.25);
  const ax = side === 'left' ? x - 14 : side === 'right' ? x + w + 14 : x + w / 2;
  const ay = side === 'top' ? y - 14 : side === 'bottom' ? y + h + 14 : y + h / 2;
  const tr = side === 'left' ? 'translate(-100%,-50%)' : side === 'right' ? 'translate(0,-50%)' : side === 'top' ? 'translate(-50%,-100%)' : 'translate(-50%,0)';
  return (
    <>
      <div style={{ position: 'absolute', left: x - pad, top: y - pad, width: w + pad * 2, height: h + pad * 2, borderRadius: 14, border: `3px solid ${color}`, boxShadow: `0 0 ${18 + ring * 22}px ${color}88, inset 0 0 ${10 + ring * 12}px ${color}33`, opacity: op * (0.7 + 0.3 * ring), transform: `scale(${lerp(1.08, 1, cl(u / 0.25))})`, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: ax, top: ay, transform: `${tr} scale(${sc}, ${1 / Math.max(0.3, sc)})`, transformOrigin: side === 'top' ? '50% 100%' : '50% 0%', opacity: op, padding: '8px 16px', borderRadius: 999, background: `linear-gradient(180deg, ${color}, ${color}cc)`, color: '#0a1204', fontFamily: F.mono, fontWeight: 800, fontSize: fs, letterSpacing: '0.07em', whiteSpace: 'nowrap', boxShadow: `0 10px 30px rgba(0,0,0,0.5), 0 0 24px ${color}77, inset 0 2px 0 rgba(255,255,255,0.6)` }}>{text}</div>
    </>
  );
};
export { C };
