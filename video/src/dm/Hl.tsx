import React from 'react';
import { C, F } from '../theme';
import { cl, eoExpo } from '../cine2/kinetic';

/** Plain highlight: a lime outline around a real UI element plus a small label. No springs, no wobble. Drawn in footage pixels; counter-scaled by the camera zoom so the label stays readable. */
export const Hl: React.FC<{ x: number; y: number; w: number; h: number; text: string; sec: number; at: number; until?: number; side?: 'top' | 'bottom' | 'left' | 'right'; color?: string; pad?: number; zoom: number }> = ({ x, y, w, h, text, sec, at, until, side = 'top', color = C.signal, pad = 8, zoom }) => {
  const inn = eoExpo((sec - at) / 0.45);
  const out = until === undefined ? 0 : cl((sec - until) / 0.3);
  const o = cl(inn * 1.6) * (1 - out);
  if (o <= 0.001) return null;
  const k = 1 / zoom;
  const L = x - pad, T = y - pad, Wd = w + pad * 2, Ht = h + pad * 2;
  const label: React.CSSProperties = { position: 'absolute', whiteSpace: 'nowrap', fontFamily: F.mono, fontWeight: 600, fontSize: 21, letterSpacing: '0.07em', color: '#10160a', background: color, padding: '7px 13px', borderRadius: 7, boxShadow: '0 6px 22px rgba(0,0,0,0.5)' };
  const pos: Record<string, React.CSSProperties> = {
    top: { left: 0, bottom: '100%', marginBottom: 12, transformOrigin: '0 100%' },
    bottom: { left: 0, top: '100%', marginTop: 12, transformOrigin: '0 0' },
    left: { right: '100%', top: '50%', marginRight: 14, transformOrigin: '100% 0', translate: '0 -50%' },
    right: { left: '100%', top: '50%', marginLeft: 14, transformOrigin: '0 0', translate: '0 -50%' },
  };
  return (
    <div style={{ position: 'absolute', left: L, top: T, width: Wd, height: Ht, opacity: o, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: 10, border: `${3 * k}px solid ${color}`, boxShadow: `0 0 0 ${9999}px rgba(0,0,0,0), 0 0 ${28 * k}px ${color}55`, transform: `scale(${1 + (1 - inn) * 0.04})` }} />
      <div style={{ ...label, ...pos[side], transform: `scale(${k}) translateY(${(1 - inn) * 6}px)` }}>{text}</div>
    </div>
  );
};
