import React from 'react';
import { C, F } from '../theme';
import { cl, eoExpo, eio } from '../cine2/kinetic';

/** `*word*` marks the italic lime accent, as in the app's own headlines. */
const parts = (s: string) => s.split(/(\*[^*]+\*)/).filter(Boolean).map((p) => (p.startsWith('*') ? { t: p.slice(1, -1), a: true } : { t: p, a: false }));

/** Word-by-word masked rise with a soft blur clearing; exits by lifting away. Serif display type in the app's own face. */
export const Display: React.FC<{ text: string; sec: number; at: number; size: number; out?: number; accent?: string; stagger?: number }> = ({ text, sec, at, size, out, accent = C.signal, stagger = 0.07 }) => {
  const words: { t: string; a: boolean }[] = [];
  for (const p of parts(text)) for (const w of p.t.split(/(\s+)/).filter(Boolean)) words.push({ t: w, a: p.a });
  let k = -1;
  return (
    <div style={{ fontFamily: F.display, fontSize: size, lineHeight: 1.04, letterSpacing: '-0.012em', color: C.chalk, whiteSpace: 'pre', display: 'inline-block' }}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w.t)) return <span key={i}>{w.t}</span>;
        k++;
        const u = sec - at - k * stagger; const e = eoExpo(u / 0.7);
        const q = out === undefined ? 0 : eio((sec - out - k * 0.02) / 0.4);
        return (
          <span key={i} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: size * 0.12, marginBottom: -size * 0.12 }}>
            <span style={{ display: 'inline-block', transform: `translateY(${(1 - e) * 105 - q * 40}%)`, opacity: cl(e * 2.2) * (1 - q), filter: `blur(${((1 - e) * 6 + q * 6).toFixed(1)}px)`, fontStyle: w.a ? 'italic' : 'normal', color: w.a ? accent : C.chalk }}>{w.t}</span>
          </span>
        );
      })}
    </div>
  );
};

/** Top-left scene header: mono step counter with a drawing rule, then the headline. */
export const Headline: React.FC<{ label: string; step: number; of: number; title: string; sec: number; out: number }> = ({ label, step, of, title, sec, out }) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lo = eio((sec - out) / 0.4);
  const rule = eoExpo((sec - 0.05) / 0.9);
  return (
    <div style={{ position: 'absolute', left: 96, top: 12, width: 1300 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: F.mono, fontSize: 17, letterSpacing: '0.16em', color: C.signal, opacity: cl((sec + 0.1) / 0.3) * (1 - lo) }}>
        <span>{pad(step)}<span style={{ color: 'rgba(255,255,255,0.35)' }}> / {pad(of)}</span></span>
        <span style={{ width: 70 * rule, height: 2, background: C.signal, display: 'inline-block' }} />
        <span style={{ color: C.chalk }}>{label}</span>
      </div>
      <div style={{ marginTop: 2 }}><Display text={title} sec={sec} at={0.12} size={58} out={out} /></div>
    </div>
  );
};
