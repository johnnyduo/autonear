import React from 'react';
import { AbsoluteFill, Easing, Html5Audio, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from './theme';
import { ramp } from './lib/anim';
import { captionTimings, wordTimings, whenSaid } from './lib/narration.js';
import type { SceneTiming } from './lib/timeline';

/* ---------- anchors: resolve "when is this phrase spoken" against the scene's narration ---------- */
export function useAnchors(s: SceneTiming) {
  const words = React.useMemo(() => wordTimings(s.display, s.durationSec, (s as any).cal), [s]);
  const at = (phrase: string, nth = 0, fallbackFrac = 0.5) => {
    try { return whenSaid(words, phrase, nth) as number; } catch { return s.durationSec * fallbackFrac; }
  };
  return { words, at };
}

/** Seconds since the scene's narration started (negative during the lead-in). */
export function useNarrationSec(s: SceneTiming) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (frame - s.narrationFrom) / fps;
}

/* ---------- background ---------- */
export const Stage: React.FC<{ glow?: string; children?: React.ReactNode }> = ({ glow = C.mineral, children }) => {
  const frame = useCurrentFrame();
  const drift = (frame * 0.25) % 64;
  return (
    <AbsoluteFill style={{ background: C.ink0, overflow: 'hidden' }}>
      <AbsoluteFill style={{ backgroundImage: `linear-gradient(${C.line}55 1px, transparent 1px), linear-gradient(90deg, ${C.line}55 1px, transparent 1px)`, backgroundSize: '64px 64px', backgroundPosition: `${drift}px ${drift}px`, maskImage: 'radial-gradient(ellipse at 50% 45%, #000 0%, transparent 72%)', WebkitMaskImage: 'radial-gradient(ellipse at 50% 45%, #000 0%, transparent 72%)' }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 50% at 70% 30%, ${glow}66, transparent 70%)` }} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, #000000aa 100%)' }} />
      {children}
      <Grain />
    </AbsoluteFill>
  );
};

const Grain: React.FC = () => (
  <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.07, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" /><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0" /></filter>
    <rect width="100%" height="100%" filter="url(#grain)" />
  </svg>
);

/* ---------- scene wrapper: soft in/out ---------- */
/** The cinematic cut renders scenes over its own persistent 3D world: inside this context SceneFrame draws no background and no fade. */
export const BareCtx = React.createContext(false);
export const SceneFrame: React.FC<{ s: SceneTiming; children: React.ReactNode; glow?: string }> = ({ s, children, glow }) => {
  const bare = React.useContext(BareCtx);
  const frame = useCurrentFrame();
  const inn = interpolate(frame, [0, 9], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const out = interpolate(frame, [s.frames - 8, s.frames], [1, 0], { extrapolateLeft: 'clamp' });
  const scale = interpolate(frame, [0, s.frames], [1.0, 1.015]);
  if (bare) return <AbsoluteFill>{children}</AbsoluteFill>;
  return (
    <AbsoluteFill>
      <Stage glow={glow} />
      <AbsoluteFill style={{ opacity: Math.min(inn, out), transform: `scale(${scale})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ---------- provenance chip (top-left): every non-illustrative scene says what it is ---------- */
export const Provenance: React.FC<{ tag: string | null; s: SceneTiming }> = ({ tag, s }) => {
  const sec = useNarrationSec(s);
  if (!tag) return null;
  const live = /LIVE/.test(tag);
  const color = live ? C.signal : /VERIFIED|TESTNET/.test(tag) ? C.mineralHi : C.warn;
  const pulse = 0.55 + 0.45 * Math.sin(sec * 5);
  return (
    <div style={{ position: 'absolute', left: 96, top: 64, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', border: `1px solid ${color}66`, background: `${C.ink1}dd`, borderRadius: 6, opacity: ramp(sec, 0.1, 0.4), transform: `translateY(${(1 - ramp(sec, 0.1, 0.4)) * -8}px)` }}>
      <span style={{ width: 10, height: 10, borderRadius: 99, background: color, opacity: live ? pulse : 1, boxShadow: live ? `0 0 14px ${color}` : 'none' }} />
      <span style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: '0.08em', color, textTransform: 'uppercase' }}>{tag}</span>
    </div>
  );
};

/* ---------- captions: muted autoplay on X means captions ARE the audio for many viewers ---------- */
export const Captions: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const chunks = React.useMemo(() => captionTimings(s.display, s.durationSec, 7, (s as any).cal), [s]);
  const idx = chunks.findIndex((c) => sec >= c.start && sec < c.end);
  const c = chunks[idx];
  if (!c) return null;
  const local = sec - c.start;
  const o = ramp(local, 0, 0.12);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ maxWidth: 1500, padding: '14px 30px', background: '#0a0c0fd9', border: `1px solid ${C.line}`, borderRadius: 10, fontFamily: F.body, fontWeight: 600, fontSize: 46, lineHeight: 1.15, color: C.chalk, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 10}px)`, backdropFilter: 'blur(6px)' }}>
        {c.text}
      </div>
    </div>
  );
};

/* ---------- word-synced headline ---------- */
export const SyncedText: React.FC<{ s: SceneTiming; text?: string; size?: number; italic?: string[]; accent?: string; breakAfter?: RegExp; style?: React.CSSProperties }> = ({ s, text, size = 120, italic = [], accent = C.signal, breakAfter, style }) => {
  const sec = useNarrationSec(s);
  const t = text ?? s.display;
  const wt = React.useMemo(() => wordTimings(t, s.durationSec, text ? undefined : (s as any).cal), [t, s]);
  return (
    <div style={{ fontFamily: F.display, fontSize: size, lineHeight: 0.98, letterSpacing: '-0.02em', color: C.chalk, ...style }}>
      {wt.map((w: { word: string; start: number }, i: number) => {
        const o = ramp(sec, w.start - 0.05, 0.28);
        const afterBreak = !breakAfter || wt.slice(0, i).some((p: { word: string }) => breakAfter.test(p.word));
        const em = afterBreak && italic.some((x) => w.word.toLowerCase().includes(x));
        return (
          <React.Fragment key={i}>
            <span style={{ display: 'inline-block', marginRight: '0.24em', opacity: o, transform: `translateY(${(1 - o) * 22}px)`, color: em ? accent : C.chalk, fontStyle: em ? 'italic' : 'normal', filter: `blur(${(1 - o) * 6}px)` }}>{w.word}</span>
            {breakAfter && breakAfter.test(w.word) && i < wt.length - 1 ? <br /> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/* ---------- small primitives ---------- */
export const Panel: React.FC<{ style?: React.CSSProperties; children?: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: `${C.ink1}f2`, border: `1px solid ${C.line}`, borderRadius: 12, ...style }}>{children}</div>
);

export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = C.chalk3, style }) => (
  <div style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: '0.1em', textTransform: 'uppercase', color, ...style }}>{children}</div>
);

export const Stamp: React.FC<{ label: string; color: string; o: number; rot?: number; size?: number }> = ({ label, color, o, rot = -4, size = 26 }) => (
  <span style={{ display: 'inline-block', fontFamily: F.mono, fontWeight: 700, fontSize: size, letterSpacing: '0.12em', color, border: `3px solid ${color}`, borderRadius: 6, padding: '4px 14px', opacity: o, transform: `rotate(${rot}deg) scale(${1.5 - 0.5 * o})`, textTransform: 'uppercase', background: `${color}14` }}>{label}</span>
);

export const Brand: React.FC<{ size?: number }> = ({ size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill={C.ink0} stroke={C.lineHi} /><path d="M8 24V8l16 16V8" fill="none" stroke={C.signal} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg>
);

/** One-shot sound effect placed at `at` seconds after the scene's narration starts (matches an on-screen event). */
export const Sfx: React.FC<{ s: SceneTiming; name: 'reject' | 'approve' | 'tick' | 'whoosh' | 'warn'; at: number; volume?: number }> = ({ s, name, at, volume = 0.5 }) => {
  const { fps } = useVideoConfig();
  const from = Math.max(0, Math.round(s.narrationFrom + at * fps));
  return (
    <Sequence from={from} durationInFrames={Math.round(fps * 1.5)} layout="none">
      <Html5Audio src={staticFile(`sfx/${name}.wav`)} volume={volume} />
    </Sequence>
  );
};
