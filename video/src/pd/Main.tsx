import React from 'react';
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { loadFonts } from '../fonts';
import { C, F } from '../theme';
import { useNarrationSec } from '../components';
import { PdCaptions } from './captions';
import { cl, eio, eoExpo, lerp, sm } from '../cine2/kinetic';
import { FPS, PRE, buildTimeline, mark, said, type PScene } from './timeline';
import { Callout, JellyText } from './jelly';
import { Display, Headline } from './headline';
import { CFG, type Cfg, type Kf } from './config';

loadFonts();
const FW = 1600, FH = 900; // footage is recorded at 1600x900 and shown 1:1 (no resampling = sharp)
const WIN = { x: 160, y: 100, w: FW, h: FH };
const K = WIN.w / FW;

/** Camera: holds a keyframe, then glides to the next one over 0.9 s ending at its time. */
function camAt(kfs: { t: number; fx: number; fy: number; z: number }[], sec: number) {
  let cur = kfs[0];
  let out = { fx: cur.fx, fy: cur.fy, z: cur.z };
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1], b = kfs[i]; const p = sm((sec - (b.t - 0.95)) / 0.95);
    if (sec >= b.t - 0.95) out = { fx: lerp(a.fx, b.fx, p), fy: lerp(a.fy, b.fy, p), z: lerp(a.z, b.z, p) };
  }
  const z = out.z;
  return { z, fx: Math.max(FW / 2 / z, Math.min(FW - FW / 2 / z, out.fx)), fy: Math.max(FH / 2 / z, Math.min(FH - FH / 2 / z, out.fy)) };
}
const resolveKf = (id: string, k: Kf) => {
  let fx = k.fx ?? FW / 2, fy = k.fy ?? FH / 2;
  if (k.m) { const m = mark(id, k.m); fx = m.x + m.w / 2 + (k.dx ?? 0); fy = m.y + m.h / 2 + (k.dy ?? 0); }
  return { t: k.at === undefined ? 0 : typeof k.at === 'number' ? k.at : said(id, k.at), fx, fy, z: k.z ?? 1 };
};

const Window: React.FC<{ s: PScene; cfg: Cfg; sec: number; f: number }> = ({ s, cfg, sec, f }) => {
  const kfs = React.useMemo(() => cfg.cam.map((k) => resolveKf(s.id, k)), [s, cfg]);
  const cam = camAt(kfs, sec);
  const enter = eoExpo(f / 26);
  const sway = Math.sin(f / FPS * 0.55) * 1.6 + (cfg.tilt ?? 0);
  return (
    <div style={{ position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, perspective: 2200, opacity: cl(enter * 1.5) }}>
      <div style={{ position: 'absolute', inset: 0, transform: `rotateY(${sway + (1 - enter) * 9}deg) rotateX(${1.2 + (1 - enter) * -3}deg) scale(${lerp(0.9, 1, enter)})`, transformStyle: 'preserve-3d', borderRadius: 22, boxShadow: '0 50px 120px rgba(0,0,0,0.65), 0 0 0 1.5px rgba(255,255,255,0.18), 0 0 90px rgba(198,244,50,0.10)', overflow: 'hidden', background: '#05070b' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: FW, height: FH, transformOrigin: '0 0', transform: `translate(${WIN.w / 2 - cam.fx * K * cam.z}px, ${WIN.h / 2 - cam.fy * K * cam.z}px) scale(${K * cam.z})` }}>
          <OffthreadVideo src={staticFile(`footage-pd/${s.id}.mp4`)} muted style={{ width: FW, height: FH, display: 'block' }} />
          {cfg.callouts.map((c, i) => {
            const m = mark(s.id, c.m);
            const at = typeof c.at === 'number' ? c.at : said(s.id, c.at);
            const until = c.until === undefined ? undefined : typeof c.until === 'number' ? c.until : said(s.id, c.until);
            const e = c.ex ?? [0, 0, 0, 0];
            return <Callout key={i} x={m.x + e[0]} y={m.y + e[1]} w={m.w - e[0] + e[2]} h={m.h - e[1] + e[3]} text={c.text} sec={sec} at={at} until={until} side={c.side} color={c.color} pad={c.pad} zoom={cam.z} />;
          })}
        </div>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.07) 0%, transparent 32%)', pointerEvents: 'none' }} />
      </div>
    </div>
  );
};

const Chip: React.FC<{ tag: string; sec: number; s: PScene; f: number }> = ({ tag, sec, s, f }) => {
  const o = eoExpo((sec - 0.1) / 0.5) * cl((s.frames - f - 6) / 12);
  const live = /LIVE/.test(tag);
  const color = live ? C.signal : C.mineralHi;
  return (
    <div style={{ position: 'absolute', right: 96, top: 40, display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', border: `1px solid ${color}66`, background: 'rgba(10,12,15,0.7)', backdropFilter: 'blur(8px)', borderRadius: 8, opacity: o, transform: `translateY(${(1 - o) * -8}px)` }}>
      <span style={{ width: 10, height: 10, borderRadius: 99, background: color, opacity: 0.6 + 0.4 * Math.sin(sec * 5), boxShadow: `0 0 14px ${color}` }} />
      <span style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.08em', color, textTransform: 'uppercase' }}>{tag}</span>
    </div>
  );
};

const DemoScene: React.FC<{ s: PScene }> = ({ s }) => {
  const cfg = CFG[s.id]; const f = useCurrentFrame(); const sec = useNarrationSec(s as any);
  const end = (s.durationSec) + 0.25;
  return (
    <AbsoluteFill>
      <Window s={s} cfg={cfg} sec={sec} f={f} />
      <Headline label={cfg.label} step={Math.max(0, Object.keys(CFG).indexOf(s.id)) + 1} of={Object.keys(CFG).length} title={cfg.title} sec={sec} out={end} />
      {s.tag ? <Chip tag={s.tag} sec={sec} s={s} f={f} /> : null}
    </AbsoluteFill>
  );
};

const Close: React.FC<{ s: PScene }> = ({ s }) => {
  const f = useCurrentFrame(); const sec = useNarrationSec(s as any);
  const lines: [string, string, string][] = [['REAL DEMAND IN', 'Research and builds, automated', 'That is AutoNEAR'], ['', '', '']];
  const t = (p: string) => said('close', p);
  const bg = 0.28;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: bg * eoExpo(f / 24), filter: 'blur(14px) saturate(1.2)', transform: 'scale(1.12)' }}><OffthreadVideo src={staticFile('footage-pd/close.mp4')} muted style={{ width: 1920, height: 1080, objectFit: 'cover' }} /></AbsoluteFill>
      <div style={{ position: 'absolute', left: 1040, top: 130, width: 760, height: 428, borderRadius: 20, overflow: 'hidden', boxShadow: '0 40px 100px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(255,255,255,0.2), 0 0 80px rgba(198,244,50,0.15)', transform: `perspective(1800px) rotateY(${-14 + Math.sin(f / 40) * 2}deg) rotateX(3deg) scale(${lerp(0.85, 1, eoExpo(f / 30))})`, opacity: eoExpo(f / 24) }}><OffthreadVideo src={staticFile('footage-pd/close.mp4')} muted style={{ width: 760, height: 428, objectFit: 'cover' }} /></div>
      <div style={{ position: 'absolute', left: 150, top: 110 }}><Display text="AutoNEAR" sec={sec} at={0.05} size={176} /></div>
      <div style={{ position: 'absolute', left: 156, top: 430 }}><Display text="Find demand." sec={sec} at={t('Find demand')} size={92} /></div>
      <div style={{ position: 'absolute', left: 156, top: 535 }}><Display text="*Build within limits.*" sec={sec} at={t('Build within')} size={92} /></div>
      <div style={{ position: 'absolute', left: 160, top: 318, fontFamily: F.body, fontWeight: 600, fontSize: 34, color: C.chalk, opacity: eoExpo((sec - t('It reads')) / 0.5), maxWidth: 820 }}>Reads public NEAR demand, scores the ideas, prepares the builds.</div>
      <div style={{ position: 'absolute', left: 160, top: 700, opacity: eoExpo((sec - t('The code')) / 0.6), transform: `translateY(${(1 - eoExpo((sec - t('The code')) / 0.6)) * 24}px)` }}>
        <Display text="Clone it. Run the tests. *Try the demo.*" sec={sec} at={t('The code')} size={60} />
        <div style={{ marginTop: 22, display: 'flex', gap: 18, fontFamily: F.mono, fontSize: 28, color: C.signal }}>
          <span style={{ padding: '10px 20px', border: `1px solid ${C.signal}88`, borderRadius: 10, background: 'rgba(198,244,50,0.08)' }}>npm test</span>
          <span style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, color: C.chalk }}>github.com/johnnyduo/autonear</span>
          <span style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, color: C.chalk }}>autonear-eight.vercel.app</span>
        </div>
        <div style={{ marginTop: 22, fontFamily: F.mono, fontSize: 26, color: '#26e6ff' }}>#NEARHackathon · @NEARProtocol</div>
      </div>
    </AbsoluteFill>
  );
};

const Shell: React.FC<{ s: PScene; pre: number; children: React.ReactNode }> = ({ s, pre, children }) => {
  const f = useCurrentFrame();
  const inn = eoExpo(f / (pre + 12));
  const outStart = s.frames + pre - (PRE + 8);
  const out = eio((f - outStart) / (PRE + 8));
  return <AbsoluteFill style={{ opacity: cl(inn * 1.4) * (1 - out), transform: `scale(${lerp(1.06, 1, inn) * lerp(1, 0.95, out)})`, filter: `blur(${((1 - inn) * 8 + out * 7).toFixed(1)}px)` }}>{children}</AbsoluteFill>;
};

export const PdMain: React.FC = () => {
  const tl = buildTimeline(); const frame = useCurrentFrame();
  const t = frame / FPS;
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 40%, #0d1626 0%, #05070b 72%)' }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ position: 'absolute', left: `${[12, 70, 40][i] + Math.sin(t * 0.25 + i * 2) * 5}%`, top: `${[75, 20, 90][i] + Math.cos(t * 0.2 + i) * 4}%`, width: 520, height: 520, borderRadius: 999, background: ['rgba(198,244,50,0.10)', 'rgba(38,230,255,0.10)', 'rgba(255,56,200,0.08)'][i], filter: 'blur(90px)', transform: 'translate(-50%,-50%)' }} />
      ))}
      <Html5Audio src={staticFile('music/bed-pd.mp3')} volume={0.28} />
      {tl.scenes.map((s) => {
        const pre = s.from > 0 ? PRE : 0;
        const s2: PScene = { ...s, from: s.from - pre, frames: s.frames + pre, narrationFrom: s.narrationFrom + pre };
        return (
          <React.Fragment key={s.id}>
            <Sequence name={s.id} from={s.from - pre} durationInFrames={s.frames + pre} layout="none">
              <Shell s={s} pre={pre}>{s.id === 'close' ? <Close s={s2} /> : <DemoScene s={s2} />}</Shell>
              {s.id === 'close' ? null : <PdCaptions s={s2 as any} />}
            </Sequence>
            <Sequence from={s.from + s.narrationFrom} layout="none"><Html5Audio src={staticFile(s.file)} /></Sequence>
          </React.Fragment>
        );
      })}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 58%, rgba(0,0,0,0.6) 100%)', pointerEvents: 'none' }} />
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.05, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
        <filter id="gp"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 5} /><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0" /></filter>
        <rect width="100%" height="100%" filter="url(#gp)" />
      </svg>
    </AbsoluteFill>
  );
};
