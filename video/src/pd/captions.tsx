import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F } from '../theme';
import { captionTimings } from '../lib/narration.js';
import { useNarrationSec } from '../components';
import { cl } from '../cine2/kinetic';
import type { PScene } from './timeline';

/** Captions sit in the strip under the app window, so they never cover the footage. */
export const PdCaptions: React.FC<{ s: PScene }> = ({ s }) => {
  const sec = useNarrationSec(s as any);
  const chunks = React.useMemo(() => captionTimings(s.display, s.durationSec, 8, (s as any).cal), [s]);
  const c = chunks.find((x: any) => sec >= x.start - 0.04 && sec < x.end + 0.1);
  if (!c) return null;
  const o = cl((sec - c.start + 0.04) / 0.16) * cl((c.end + 0.1 - sec) / 0.18);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
      <div style={{ marginBottom: 14, maxWidth: 1500, fontFamily: F.body, fontWeight: 600, fontSize: 38, lineHeight: 1.1, color: C.chalk, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 6}px)`, textShadow: '0 2px 14px rgba(0,0,0,0.8)' }}>{c.text}</div>
    </AbsoluteFill>
  );
};
