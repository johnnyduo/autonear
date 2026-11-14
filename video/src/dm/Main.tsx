import React from 'react';
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { loadFonts } from '../fonts';
import { C, F } from '../theme';
import { useNarrationSec } from '../components';
import { captionTimings } from '../lib/narration.js';
import { cl, eio, eoExpo, lerp, sm } from '../cine2/kinetic';
import { FPS, OFF_SEC, PRE, buildTimeline, rectAt, said, type PScene } from './timeline';
import { Display } from '../pd/headline';
import { Hl } from './Hl';
import { CFG, type Cfg, type Kf } from './config';

loadFonts();
/* Stage: the real app, full width, exactly as recorded (1920x1012 CSS px, footage is 1.5x that, so camera pushes stay sharp). Bottom bar: step, plain-language label, captions, data tag. */
const FW = 1920, FH = 1012, BAR = 68;

function camAt(kfs: { t: number; fx: number; fy: number; z: number }[], sec: number) {
  let out = { fx: kfs[0].fx, fy: kfs[0].fy, z: kfs[0].z };
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1], b = kfs[i]; const dur = 1.3; const p = sm((sec - (b.t - dur)) / dur);
    if (sec >= b.t - dur) out = { fx: lerp(a.fx, b.fx, p), fy: lerp(a.fy, b.fy, p), z: lerp(a.z, b.z, p) };
  }
  const z = out.z;
  return { z, fx: Math.max(FW / 2 / z, Math.min(FW - FW / 2 / z, out.fx)), fy: Math.max(FH / 2 / z, Math.min(FH - FH / 2 / z, out.fy)) };
}
const T = (id: string, v: number | string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const [ph, off] = v.split('|');
  return said(id, ph) + (off ? Number(off) : 0);
};
const resolveKf = (id: string, k: Kf) => {
  let fx = k.fx ?? FW / 2, fy = k.fy ?? FH / 2;
  const t = T(id, k.at) ?? 0;
  if (k.m) { const m = rectAt(id, k.m, t + OFF_SEC); fx = m.x + m.w / 2 + (k.dx ?? 0); fy = m.y + m.h / 2 + (k.dy ?? 0); }
  return { t, fx, fy, z: k.z ?? 1 };
};

const Stage: React.FC<{ s: PScene; cfg: Cfg; sec: number; f: number }> = ({ s, cfg, sec, f }) => {
  const kfs = React.useMemo(() => cfg.cam.map((k) => resolveKf(s.id, k)), [s, cfg]);
  const cam = camAt(kfs, sec);
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: FW, height: FH, overflow: 'hidden', background: '#05070b' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: FW, height: FH, transformOrigin: '0 0', transform: `translate(${FW / 2 - cam.fx * cam.z}px, ${FH / 2 - cam.fy * cam.z}px) scale(${cam.z})` }}>
        <OffthreadVideo src={staticFile(`footage-dm/${s.id}.mp4`)} muted style={{ width: FW, height: FH, display: 'block' }} />
        {cfg.callouts.map((c, i) => {
          const m = rectAt(s.id, c.m, f / FPS);
          const at = T(s.id, c.at)!; const until = T(s.id, c.until);
          const e = c.ex ?? [0, 0, 0, 0];
          return <Hl key={i} x={m.x + e[0]} y={m.y + e[1]} w={m.w - e[0] + e[2]} h={m.h - e[1] + e[3]} text={c.text} sec={sec} at={at} until={until} side={c.side} color={c.color} pad={c.pad} zoom={cam.z} />;
        })}
      </div>
    </div>
  );
};

const Bar: React.FC<{ s: PScene; cfg: Cfg; step: number; of: number; sec: number }> = ({ s, cfg, step, of, sec }) => {
  const chunks = React.useMemo(() => captionTimings(s.display, s.durationSec, 9, (s as any).cal), [s]);
  const c = chunks.find((x: any) => sec >= x.start - 0.04 && sec < x.end + 0.1);
  const o = c ? cl((sec - c.start + 0.04) / 0.14) * cl((c.end + 0.1 - sec) / 0.16) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const live = s.tag ? /LIVE/.test(s.tag) : false; const tc = live ? C.signal : C.mineralHi;
  return (
    <div style={{ position: 'absolute', left: 0, top: FH, width: FW, height: BAR, background: '#070a0f', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
      <div style={{ position: 'absolute', left: 36, top: 0, bottom: 0, width: 520, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
        <div style={{ fontFamily: F.mono, fontSize: 17, letterSpacing: '0.14em', color: C.signal }}>{pad(step)}<span style={{ color: 'rgba(255,255,255,0.35)' }}> / {pad(of)}</span><span style={{ color: C.chalk, marginLeft: 14 }}>{cfg.label}</span></div>
        <div style={{ fontFamily: F.body, fontSize: 19, color: C.chalk3, whiteSpace: 'nowrap' }}>{cfg.sub}</div>
      </div>
      <div style={{ position: 'absolute', left: 560, right: 560, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: F.body, fontWeight: 600, fontSize: 31, lineHeight: 1.1, color: C.chalk, opacity: o }}>{c?.text}</div>
      {s.tag ? <div style={{ position: 'absolute', right: 36, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 10, fontFamily: F.mono, fontSize: 16, letterSpacing: '0.08em', color: tc, textTransform: 'uppercase' }}>
        <span style={{ width: 9, height: 9, borderRadius: 99, background: tc, boxShadow: `0 0 10px ${tc}` }} />{s.tag}
      </div> : null}
    </div>
  );
};

const DemoScene: React.FC<{ s: PScene; step: number; of: number }> = ({ s, step, of }) => {
  const cfg = CFG[s.id]; const sec = useNarrationSec(s as any); const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#05070b' }}>
      <Stage s={s} cfg={cfg} sec={sec} f={f} />
      <Bar s={s} cfg={cfg} step={step} of={of} sec={sec} />
    </AbsoluteFill>
  );
};

const Close: React.FC<{ s: PScene }> = ({ s }) => {
  const f = useCurrentFrame(); const sec = useNarrationSec(s as any);
  const t = (p: string) => said('close', p);
  return (
    <AbsoluteFill style={{ background: '#05070b' }}>
      <AbsoluteFill style={{ opacity: 0.55 * eoExpo(f / 20), overflow: 'hidden' }}><div style={{ width: 1920, height: 1012, transformOrigin: '78% 50%', transform: 'scale(1.7) translateY(34px)' }}><OffthreadVideo src={staticFile('footage-dm/close.mp4')} muted style={{ width: 1920, height: 1012 }} /></div></AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(5,7,11,0.92) 0%, rgba(5,7,11,0.78) 50%, rgba(5,7,11,0.35) 100%)' }} />
      <div style={{ position: 'absolute', left: 150, top: 170 }}><Display text="AutoNEAR" sec={sec} at={0.05} size={150} /></div>
      <div style={{ position: 'absolute', left: 160, top: 372, fontFamily: F.body, fontWeight: 500, fontSize: 32, color: C.chalk2, opacity: eoExpo((sec - t('It reads')) / 0.5), whiteSpace: 'nowrap' }}>Reads public NEAR demand, scores the ideas, prepares the builds.</div>
      <div style={{ position: 'absolute', left: 156, top: 460 }}><Display text="Find demand." sec={sec} at={t('Find demand')} size={104} /></div>
      <div style={{ position: 'absolute', left: 156, top: 580 }}><Display text="*Build within limits.*" sec={sec} at={t('Build within')} size={104} /></div>
      <div style={{ position: 'absolute', left: 160, top: 770, opacity: eoExpo((sec - t('The code')) / 0.6) }}>
        <div style={{ display: 'flex', gap: 18, fontFamily: F.mono, fontSize: 28, color: C.signal }}>
          <span style={{ padding: '10px 20px', border: `1px solid ${C.signal}88`, borderRadius: 10, background: 'rgba(198,244,50,0.08)' }}>npm test</span>
          <span style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, color: C.chalk }}>github.com/johnnyduo/autonear</span>
          <span style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, color: C.chalk }}>autonear-eight.vercel.app</span>
        </div>
        <div style={{ marginTop: 22, fontFamily: F.mono, fontSize: 26, color: '#26e6ff' }}>#NEARHackathon · @NEARProtocol</div>
      </div>
    </AbsoluteFill>
  );
};

/** Scenes overlap by PRE frames: the next scene opens on the same picture the previous one ends on, so a short cross-fade is all the transition needed. */
const Shell: React.FC<{ pre: number; children: React.ReactNode }> = ({ pre, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: pre ? cl(f / Math.max(1, pre - 2)) : 1 }}>{children}</AbsoluteFill>;
};

export const DmMain: React.FC = () => {
  const tl = buildTimeline();
  const ids = Object.keys(CFG);
  return (
    <AbsoluteFill style={{ background: '#05070b' }}>
      <Html5Audio src={staticFile('music/bed-pd.mp3')} volume={0.16} loop />
      {tl.scenes.map((s) => {
        const pre = PRE;
        const s2: PScene = { ...s, from: s.from - pre, frames: s.frames + pre, narrationFrom: s.narrationFrom + pre };
        const step = Math.max(0, ids.indexOf(s.id)) + 1;
        return (
          <React.Fragment key={s.id}>
            <Sequence name={s.id} from={s.from - pre} durationInFrames={s.frames + pre} layout="none">
              <Shell pre={pre}>{s.id === 'close' ? <Close s={s2} /> : <DemoScene s={s2} step={step} of={ids.length} />}</Shell>
            </Sequence>
            <Sequence from={s.from + s.narrationFrom} layout="none"><Html5Audio src={staticFile(s.file)} /></Sequence>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
