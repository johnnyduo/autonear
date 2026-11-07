import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from '../theme';
import { captionTimings } from '../lib/narration.js';
import { useNarrationSec } from '../components';
import { cl, eoExpo } from './kinetic';
import type { CScene } from './timeline';

/** Provenance chip: eases in, and eases out before the scene ends so nothing pops off. */
export const CineProvenance: React.FC<{ tag: string | null; s: CScene }> = ({ tag, s }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  if (!tag) return null;
  const sec = useNarrationSec(s as any);
  const live = /LIVE/.test(tag); const color = live ? C.signal : /VERIFIED|TESTNET/.test(tag) ? C.mineralHi : /ROADMAP/.test(tag) ? '#26e6ff' : C.warn;
  const o = eoExpo((sec - 0.1) / 0.5) * cl((s.frames - f - 6) / 12);
  return (
    <div style={{ position: 'absolute', left: 96, top: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', border: `1px solid ${color}66`, background: 'rgba(10,12,15,0.7)', backdropFilter: 'blur(8px)', borderRadius: 8, opacity: o, transform: `translateY(${(1 - o) * -8}px)` }}>
      <span style={{ width: 10, height: 10, borderRadius: 99, background: color, opacity: live ? 0.6 + 0.4 * Math.sin(sec * 5) : 1, boxShadow: live ? `0 0 14px ${color}` : 'none' }} />
      <span style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.08em', color, textTransform: 'uppercase' }}>{tag}</span>
      <span style={{ display: 'none' }}>{fps}</span>
    </div>
  );
};

/** Captions: each phrase fades up and fades out softly, kept low and compact so it never fights the type. */
export const CineCaptions: React.FC<{ s: CScene }> = ({ s }) => {
  const sec = useNarrationSec(s as any);
  const chunks = React.useMemo(() => captionTimings(s.display, s.durationSec, 7, (s as any).cal), [s]);
  const c = chunks.find((x: any) => sec >= x.start - 0.04 && sec < x.end + 0.1);
  if (!c) return null;
  const o = cl((sec - c.start + 0.04) / 0.16) * cl((c.end + 0.1 - sec) / 0.18);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
      <div style={{ marginBottom: 52, maxWidth: 1400, padding: '10px 26px', background: 'rgba(8,10,14,0.62)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, fontFamily: F.body, fontWeight: 600, fontSize: 40, lineHeight: 1.15, color: C.chalk, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 8}px)`, backdropFilter: 'blur(8px)' }}>{c.text}</div>
    </AbsoluteFill>
  );
};
