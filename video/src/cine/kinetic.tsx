import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { C, F } from '../theme';

export const cl = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sm = (t: number) => { const x = cl(t); return x * x * (3 - 2 * x); };
export const eo3 = (t: number) => 1 - Math.pow(1 - cl(t), 3);
export const eoExpo = (t: number) => (cl(t) >= 1 ? 1 : 1 - Math.pow(2, -10 * cl(t)));
export const eoBack = (t: number, k = 1.9) => { const x = cl(t) - 1; return 1 + (k + 1) * x * x * x + k * x * x; };
export const eio = (t: number) => { const x = cl(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
/** 0 -> 1 over [at, at+dur] seconds */
export const rp = (sec: number, at: number, dur = 0.5, ease: (t: number) => number = eo3) => ease((sec - at) / dur);

export const NEON = { cy: '#26e6ff', mg: '#ff38c8', vi: '#8f52ff', lime: '#c6f432', warn: '#f2b84b', risk: '#ff6a3d', white: '#faf6ff' };

/**
 * Kinetic headline: every letter is its own element that STRETCHES in (tall and wide, then snaps to size, with a variable-font width
 * axis sweep) and can stretch OUT sideways. `sec` is the time the caller counts from; `at` is when the first letter lands.
 */
export const KText: React.FC<{
  text: string; sec: number; at: number; size: number;
  mode?: 'stretch' | 'drop' | 'wave' | 'rise'; stagger?: number; dur?: number; out?: number;
  color?: string; grad?: [string, string]; wdth?: number; wght?: number; family?: string; italic?: boolean;
  align?: 'left' | 'center' | 'right'; glow?: string; style?: React.CSSProperties; spacing?: number;
}> = ({ text, sec, at, size, mode = 'stretch', stagger = 0.045, dur = 0.7, out, color = C.chalk, grad, wdth = 100, wght = 800, family = F.kinetic, italic, align = 'left', glow, style, spacing = 0 }) => {
  const chars = [...text];
  const mid = (chars.length - 1) / 2;
  const hex = (h: string): number[] => { if (h.startsWith('rgb')) return (h.match(/[\d.]+/g) ?? ['255', '255', '255']).slice(0, 3).map(Number); const x = h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h; return [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  const gc = grad ? [hex(grad[0]), hex(grad[1])] : null;
  return (
    <div style={{ fontFamily: family, fontSize: size, lineHeight: 1, whiteSpace: 'pre', textAlign: align, letterSpacing: spacing, fontStyle: italic ? 'italic' : 'normal', ...style }}>
      {chars.map((ch, i) => {
        const lt = sec - at - i * stagger;
        const e = mode === 'stretch' ? eoBack(lt / dur, 1.5) : mode === 'drop' ? eoBack(lt / dur, 2.6) : eo3(lt / dur);
        const vis = cl(lt / (dur * 0.35));
        const q = out === undefined ? 0 : eio((sec - out - Math.abs(i - mid) * stagger * 0.5) / 0.55);
        let sx = 1, sy = 1, ty = 0, tx = 0, w = wdth, bl = 0;
        if (mode === 'stretch') { const k = 1 - e; sy = 1 + k * 2.1; sx = 1 - k * 0.3; w = lerp(wdth, 150, cl(k * 1.2)); ty = k * size * 0.1; bl = cl(k) * 12; }
        else if (mode === 'drop') { const k = 1 - e; ty = -k * size * 1.4; sy = 1 + k * 0.5; bl = cl(k) * 8; }
        else if (mode === 'rise') { const k = 1 - e; ty = k * size * 0.5; bl = cl(k) * 10; }
        else if (mode === 'wave') { sy = 1 + 0.16 * Math.sin(sec * 3.4 + i * 0.7); w = wdth + 38 * Math.sin(sec * 2.6 + i * 0.55); }
        if (q > 0) { sx *= 1 + q * 2.8; sy *= 1 - q * 0.5; tx = (i - mid) * q * size * 0.22; bl += q * 18; }
        const col = gc ? `rgb(${gc[0].map((v, k) => Math.round(lerp(v, gc[1][k], i / Math.max(1, chars.length - 1)))).join(',')})` : color;
        return (
          <span key={i} style={{ display: 'inline-block', opacity: cl(vis * (1 - q)), color: col, fontWeight: wght, fontVariationSettings: `'wdth' ${w.toFixed(1)}, 'wght' ${wght}`, transformOrigin: '50% 100%', transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, filter: bl > 0.2 ? `blur(${bl.toFixed(1)}px)` : undefined, textShadow: glow ? `0 0 ${size * 0.25}px ${glow}` : undefined }}>{ch === ' ' ? ' ' : ch}</span>
        );
      })}
    </div>
  );
};

/**
 * A word stretched across the frame with real glyph stretching (SVG textLength + spacingAndGlyphs). `p` 0..1 goes from natural width to `to` px.
 * `echo` draws hollow trailing copies for the speed-trail look.
 */
export const StretchWord: React.FC<{
  text: string; cx: number; cy: number; size: number; p: number; to: number; opacity?: number;
  fill?: string; stroke?: string; wdth?: number; wght?: number; echo?: number; echoGap?: number; skew?: number; glow?: string; grad?: [string, string]; from?: number;
}> = ({ text, cx, cy, size, p, to, opacity = 1, fill = C.chalk, stroke, wdth = 100, wght = 900, echo = 0, echoGap = 0.12, skew = 0, glow, grad, from }) => {
  const natural = size * 0.62 * text.length * (wdth / 100);
  const len = lerp(from ?? natural, to, cl(p));
  const id = React.useId().replace(/:/g, '');
  const copies = Array.from({ length: echo }, (_, k) => k + 1);
  const common = { fontFamily: F.kinetic, fontSize: size, fontWeight: wght, style: { fontVariationSettings: `'wdth' ${wdth}, 'wght' ${wght}` } as React.CSSProperties, textLength: len, lengthAdjust: 'spacingAndGlyphs' as const };
  return (
    <svg width="100%" height="100%" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity, filter: glow ? `drop-shadow(0 0 28px ${glow})` : undefined }}>
      {grad && <defs><linearGradient id={id} x1="0" x2="1"><stop offset="0" stopColor={grad[0]} /><stop offset="1" stopColor={grad[1]} /></linearGradient></defs>}
      {copies.reverse().map((k) => (
        <text key={k} x={cx - len / 2} y={cy + size * 0.36 + k * size * echoGap} {...common} fill="none" stroke={stroke ?? fill} strokeWidth={2} opacity={0.5 / (k + 0.4)} transform={`skewX(${skew})`}>{text}</text>
      ))}
      <text x={cx - len / 2} y={cy + size * 0.36} {...common} fill={grad ? `url(#${id})` : fill} stroke={stroke} strokeWidth={stroke ? 2 : 0} transform={`skewX(${skew})`}>{text}</text>
    </svg>
  );
};

/** Masked line wipe for secondary copy: the text slides up out of a clip box with a small skew. */
export const Wipe: React.FC<{ children: React.ReactNode; sec: number; at: number; dur?: number; out?: number; style?: React.CSSProperties }> = ({ children, sec, at, dur = 0.55, out, style }) => {
  const e = eoExpo((sec - at) / dur);
  const q = out === undefined ? 0 : eio((sec - out) / 0.4);
  return (
    <div style={{ overflow: 'hidden', paddingBottom: '0.12em', ...style }}>
      <div style={{ transform: `translateY(${(1 - e + q) * 105}%) skewY(${(1 - e) * 4}deg)`, opacity: cl(e * (1 - q) * 3) }}>{children}</div>
    </div>
  );
};

/** Small mono label chip with an accent tick. */
export const Tag: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = NEON.cy, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: F.mono, fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', color, ...style }}>
    <span style={{ width: 22, height: 2, background: color, display: 'inline-block' }} />{children}
  </span>
);

/** Glass card used for info panels. */
export const Glass: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties; edge?: string }> = ({ children, style, edge = 'rgba(255,255,255,0.16)' }) => (
  <div style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.09), rgba(255,255,255,0.025))', border: `1px solid ${edge}`, borderRadius: 18, backdropFilter: 'blur(14px)', boxShadow: '0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.18)', ...style }}>{children}</div>
);

export const Fill: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => <AbsoluteFill style={style}>{children}</AbsoluteFill>;
export { interpolate };
