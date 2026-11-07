import React from 'react';
import { AbsoluteFill, Html5Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { loadFonts } from '../fonts';
import { C } from '../theme';
import { BareCtx, Captions, Provenance, Sfx } from '../components';
import { FPS, PRE, buildTimeline, type CScene } from './timeline';
import { WorldLayer } from './world';
import { CINE_SCENES } from './scenes';
import { cl, eio, eoExpo, lerp } from './kinetic';
import { stageAt } from './stage';

loadFonts();

/** Scene shell: push-through entrance (zoom-in + blur clearing) and exit (scale away + blur), overlapped with the neighbouring scene. */
const Shell: React.FC<{ s: CScene; pre: number; children: React.ReactNode }> = ({ s, pre, children }) => {
  const f = useCurrentFrame();
  const inn = eoExpo(f / (pre + 14));
  const outStart = s.frames + pre - (PRE + 8);
  const out = eio((f - outStart) / (PRE + 8));
  const st = stageAt((s.from - pre + f) / FPS);
  const sway = Math.sin(f / FPS * 0.5) * 0.9;
  const sc = lerp(1.12, 1, inn) * lerp(1, 0.93, out);
  const bl = (1 - inn) * 10 + out * 8;
  return (
    <AbsoluteFill style={{ opacity: cl(inn * 1.4) * (1 - out), transform: `perspective(1900px) rotateY(${sway + (1 - inn) * 5}deg) rotateX(${(1 - inn) * -2}deg) scale(${sc}) translate(${Math.sin(f * 3.1) * st.shake * 7}px, ${Math.cos(f * 2.3) * st.shake * 6}px)`, filter: bl > 0.3 ? `blur(${bl.toFixed(1)}px)` : undefined }}>
      {children}
    </AbsoluteFill>
  );
};

export const CineMain: React.FC = () => {
  const tl = buildTimeline();
  const frame = useCurrentFrame();
  const st = stageAt(frame / FPS);
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, #0b1220 0%, #05070b 70%)' }}>
      <Html5Audio src={staticFile('music/bed-cine.mp3')} volume={0.3} />
      <WorldLayer />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, rgba(255,255,255,${(st.flash * 0.35).toFixed(3)}), transparent 60%)`, mixBlendMode: 'screen', pointerEvents: 'none' }} />
      <BareCtx.Provider value={true}>
        {tl.scenes.map((s) => {
          const Scene = CINE_SCENES[s.id];
          const pre = s.from > 0 ? PRE : 0;
          const s2: CScene = { ...s, from: s.from - pre, frames: s.frames + pre, narrationFrom: s.narrationFrom + pre };
          return (
            <React.Fragment key={s.id}>
              <Sequence name={s.id} from={s.from - pre} durationInFrames={s.frames + pre} layout="none">
                <Shell s={s} pre={pre}>
                  {Scene ? <Scene s={s2 as any} /> : null}
                </Shell>
                <Provenance tag={s.tag} s={s2 as any} />
                <Captions s={s2 as any} />
                {s.from > 0 ? <Sfx s={{ ...(s2 as any), narrationFrom: pre }} name="whoosh" at={0} volume={0.8} /> : null}
              </Sequence>
              <Sequence from={s.from + s.narrationFrom} layout="none"><Html5Audio src={staticFile(s.file)} /></Sequence>
            </React.Fragment>
          );
        })}
      </BareCtx.Provider>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.65) 100%)', pointerEvents: 'none' }} />
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.06, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
        <filter id="g2"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 5} /><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0" /></filter>
        <rect width="100%" height="100%" filter="url(#g2)" />
      </svg>
    </AbsoluteFill>
  );
};
export { C };
