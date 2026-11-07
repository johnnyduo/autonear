import React from 'react';
import { C, F, H, W } from '../theme';
import { prod, tn, type CScene } from './timeline';
import { Cv, glow as glowDot, line as drawLine, rgba, CY, MG, SG, VI } from '../scenes/v3lib';
import { Glass, KText, NEON, StretchWord, Tag, Wipe, cl, eio, eoExpo, lerp, rp, sm } from './kinetic';
import { FLOOR_Y, IDEAS, PILLAR_R, pillarAngle, pillarHeight, project } from './stage';
import { hash, useCine } from './hooks';
import { Sfx } from '../components';

const center: React.CSSProperties = { position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center' };

/* ======================= 1 · ASK ======================= */
export const Ask: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tWe = at('We', 0, 0.02), tNear = at('NEAR', 0, 0.12), tGrow = at('grow.', 0, 0.2), tBut = at('But', 0, 0.3), tWhich = at('which', 0, 0.35), tWhat = at('What', 0, 0.55), tAnd = at('and', 0, 0.78), tKnow = at('know?', 0, 0.88);
  const w = rp(sec, tWhich - 0.1, 1.0, eoExpo);
  const whichOut = eio((sec - tWhat + 0.1) / 0.5);
  const arrows = Array.from({ length: 14 }, (_, i) => i);
  return (
    <>
      <Sfx s={s as any} name="tick" at={tNear} volume={0.4} /><Sfx s={s as any} name="whoosh" at={tWhich} volume={0.5} /><Sfx s={s as any} name="tick" at={tKnow} volume={0.4} />
      <div style={{ ...center, top: 90, opacity: rp(sec, 0.1, 0.5) }}><Tag color={NEON.cy}>the question</Tag></div>
      <div style={{ ...center, top: 270 }}><KText text="WE ALL WANT" sec={sec} at={tWe} size={84} wght={300} wdth={125} spacing={16} out={tBut - 0.05} /></div>
      <div style={{ ...center, top: 360 }}><KText text="NEAR" sec={sec} at={tNear} size={400} grad={[NEON.cy, NEON.mg]} glow="#26e6ff66" out={tBut - 0.05} stagger={0.08} dur={0.9} /></div>
      <div style={{ ...center, top: 800 }}><KText text="TO GROW" sec={sec} at={tGrow - 0.3} size={84} wght={300} wdth={125} spacing={16} out={tBut - 0.05} mode="rise" /></div>
      {/* the compass of arrows: every direction is possible */}
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
        {arrows.map((i) => {
          const base = (i / arrows.length) * 6.2832; const a = rp(sec, tBut - 0.1 + i * 0.03, 0.5);
          const rot = base + Math.sin(sec * (0.9 + hash(i) * 1.4) + i) * 2.4 * a;
          const R = 430 + 30 * Math.sin(sec * 1.3 + i); const fade = 1 - eio((sec - tKnow - 0.2) / 0.6) * 0.8;
          return <g key={i} transform={`translate(${960 + Math.cos(base) * R},${540 + Math.sin(base) * R * 0.62}) rotate(${(rot * 180) / Math.PI})`} opacity={a * 0.85 * fade}>
            <path d="M-26 0 H22 M8 -14 L24 0 L8 14" fill="none" stroke={i % 3 === 0 ? NEON.lime : i % 3 === 1 ? NEON.cy : NEON.mg} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" /></g>;
        })}
      </svg>
      <StretchWord text="WHICH WAY?" cx={960} cy={500} size={250} from={380} to={1760} p={w} opacity={cl(w * 3) * (1 - whichOut)} grad={[NEON.cy, NEON.mg]} glow="#ff38c866" echo={3} wght={900} wdth={100} />
      <div style={{ ...center, top: 700, opacity: 1 }}><Wipe sec={sec} at={tWhat} dur={0.7}><span style={{ fontFamily: F.display, fontStyle: 'italic', fontSize: 92, color: C.chalk }}>What does the network need right now?</span></Wipe></div>
      <div style={{ ...center, top: 820 }}><KText text="HOW WOULD WE KNOW?" sec={sec} at={tAnd - 0.1} size={118} mode="rise" wght={800} grad={[NEON.white, NEON.lime]} stagger={0.04} /></div>
    </>
  );
};

/* ======================= 2 · CROWD ======================= */
const CARDS = [
  { k: 'POSTS', c: NEON.cy, row: 0, phrase: 'posts,' }, { k: 'ISSUES', c: NEON.mg, row: 1, phrase: 'issues,' }, { k: 'COMMITS', c: NEON.lime, row: 2, phrase: 'commits.' }, { k: 'ON-CHAIN', c: NEON.vi, row: 3, phrase: 'public,' },
];
export const Crowd: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tAns = at('answer', 0, 0.03), tMonths = at('months.', 0, 0.78), tYear = at('year.', 0, 0.94), tStud = at('Studying', 0, 0.62);
  const mW = rp(sec, tMonths - 0.5, 2.3, eio), yW = rp(sec, tYear - 0.2, 2.2, eio);
  const gone = rp(sec, tStud - 0.2, 0.6);
  const months = Math.min(12, Math.floor(rp(sec, tMonths - 0.3, 3.6, (t) => t) * 12.99));
  return (
    <>
      <Sfx s={s as any} name="tick" at={tAns} volume={0.35} /><Sfx s={s as any} name="warn" at={tMonths} volume={0.3} />
      <div style={{ position: 'absolute', left: 120, top: 120, opacity: 1 - gone }}>
        <KText text="THE ANSWER" sec={sec} at={tAns - 0.2} size={150} grad={[NEON.white, NEON.cy]} out={tStud - 0.1} />
        <KText text="IS OUT THERE." sec={sec} at={tAns + 0.2} size={150} grad={[NEON.cy, NEON.mg]} glow="#ff38c844" out={tStud - 0.05} style={{ marginTop: 6 }} />
      </div>
      {/* public signals flying through the camera */}
      <div style={{ position: 'absolute', inset: 0, perspective: 1100, perspectiveOrigin: '50% 60%', opacity: 1 - gone }}>
        {CARDS.map((c) => {
          const t0 = at(c.phrase, 0, 0.3 + c.row * 0.08); const u = (sec - t0 + 0.3) / 3.6; if (u < 0 || u > 1.2) return null;
          const x = lerp(2150, -520, u); const y = 470 + c.row * 125 + Math.sin(u * 5 + c.row) * 18;
          return (
            <div key={c.k} style={{ position: 'absolute', left: x, top: y, width: 430, transform: `translateZ(${-60 + c.row * 40}px) rotateY(-14deg)`, transformStyle: 'preserve-3d' }}>
              <Glass edge={`${c.c}88`} style={{ padding: '14px 22px', display: 'flex', gap: 18, alignItems: 'center' }}>
                <div style={{ width: 54, height: 54, borderRadius: 14, background: `${c.c}28`, border: `2px solid ${c.c}`, display: 'grid', placeItems: 'center', fontFamily: F.mono, fontWeight: 700, fontSize: 24, color: c.c }}>{c.k[0]}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: '0.14em', color: c.c }}>{c.k}</div>
                  {[0.92, 0.64].map((wd, i) => <div key={i} style={{ height: 9, borderRadius: 99, background: 'rgba(255,255,255,0.22)', width: `${wd * (0.7 + 0.3 * hash(c.row * 3 + i)) * 100}%`, marginTop: 9 }} />)}
                </div>
              </Glass>
            </div>
          );
        })}
      </div>
      <StretchWord text="MONTHS" cx={960} cy={470} size={330} from={560} to={1780} p={mW} opacity={rp(sec, tMonths - 0.5, 0.3) * (1 - yW)} grad={[NEON.white, '#6e7480']} echo={2} wght={900} />
      <StretchWord text="A YEAR" cx={960} cy={470} size={330} from={500} to={1800} p={yW} opacity={rp(sec, tYear - 0.2, 0.3)} grad={['#9aa0ab', '#4a505c']} echo={3} wght={900} />
      <div style={{ ...center, top: 760, gap: 12, opacity: rp(sec, tMonths - 0.4, 0.4) }}>
        {Array.from({ length: 12 }, (_, i) => <div key={i} style={{ width: 96, height: 56, borderRadius: 10, border: `2px solid ${i < months ? NEON.risk : 'rgba(255,255,255,0.22)'}`, background: i < months ? 'rgba(255,106,61,0.22)' : 'transparent', display: 'grid', placeItems: 'center', fontFamily: F.mono, fontSize: 18, color: i < months ? NEON.risk : '#6e7480' }}>M{i + 1}</div>)}
      </div>
      <div style={{ ...center, top: 840, opacity: rp(sec, tMonths - 0.2, 0.5) }}><Tag color="#8c8b82">studied by hand</Tag></div>
    </>
  );
};

/* ======================= 3 · REVEAL ======================= */
export const Reveal: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tR = at('AutoNEAR.', 0, 0.15), tRead = at('reading', 0, 0.4), tRank = at('ranks', 0, 0.55), tMove = at('moves', 0, 0.7), tLim = at('limits.', 0, 0.9);
  const ghost = rp(sec, tR - 0.1, 1.4, eoExpo);
  const steps: [string, string, number, string][] = [['01', 'LISTEN', tRead, NEON.cy], ['02', 'RANK', tRank, NEON.mg], ['03', 'BUILD', tMove, NEON.vi], ['', 'OWNER SETS THE LIMITS', tLim, NEON.lime]];
  return (
    <>
      <Sfx s={s as any} name="approve" at={tR} volume={0.55} />
      <StretchWord text="AUTONEAR" cx={960} cy={540} size={430} from={700} to={1840} p={ghost} opacity={0.2 * rp(sec, tR - 0.1, 0.3)} fill="none" stroke={NEON.white} wght={900} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 120, display: 'flex', justifyContent: 'center', gap: 22 }}>
        {steps.map(([n, l, t, c], i) => {
          const o = rp(sec, t - 0.15, 0.5, eoExpo);
          return (
            <div key={i} style={{ opacity: o, transform: `translateY(${(1 - o) * 40}px) scale(${0.9 + 0.1 * o})` }}>
              <Glass edge={`${c}aa`} style={{ padding: '16px 30px', display: 'flex', alignItems: 'center', gap: 16, boxShadow: `0 0 40px ${c}33, 0 30px 80px rgba(0,0,0,0.5)` }}>
                {n && <span style={{ fontFamily: F.mono, fontSize: 24, color: c }}>{n}</span>}
                <span style={{ fontFamily: F.kinetic, fontWeight: 800, fontSize: 40, letterSpacing: '0.04em', color: C.chalk, fontVariationSettings: "'wdth' 112" }}>{l}</span>
              </Glass>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 690, display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 6 }}>
        <KText text="AUTO" sec={sec} at={tR} size={250} wght={200} wdth={85} color={C.chalk} stagger={0.07} />
        <KText text="NEAR" sec={sec} at={tR + 0.25} size={250} wght={900} grad={[NEON.lime, NEON.cy]} glow="#c6f43255" stagger={0.07} />
      </div>
    </>
  );
};

/* ======================= 4 · SIGNALS ======================= */
export const Signals: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const t13 = at('Thirteen', 0, 0.03), t49 = at('Forty-nine', 0, 0.22), t424 = at('Four', 0, 0.4), tEach = at('each', 0, 0.62), tEvery = at('Every', 0, 0.78);
  const names = (prod.sourceNames as { name: string }[]).map((x) => x.name.split(' · ')[0].replace(/\s*\(.*\)/, ''));
  const num = (t: number, v: number, dur = 0.9) => Math.round(v * rp(sec, t, dur, eoExpo));
  const rows: [string, string, number, number, string, string][] = [
    [`${num(t13, prod.sourcesOk)}/${prod.sourcesTotal}`, 'SOURCES CHECKED IN', t13, 0, NEON.lime, NEON.cy], [String(num(t49, prod.feeds)), 'FEEDS WATCHED', t49, 1, NEON.cy, NEON.vi], [String(num(t424, prod.evidence, 1.3)), 'RECORDS, EACH WITH ITS SOURCE', t424, 2, NEON.mg, NEON.vi],
  ];
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    names.forEach((_, i) => {
      const ti = t13 + 0.1 + i * 0.12; const u = (sec - ti) / 1.4; if (u < 0) return;
      const y0 = 160 + i * 52, x0 = 1440; const loop = (u * 0.8) % 1;
      drawLine(ctx, x0, y0, 960 + 250, 540, CY, 0.06 + 0.06 * Math.sin(sec * 3 + i), 1.2);
      const px = lerp(x0, 1210, loop), py = lerp(y0, 540, loop); glowDot(ctx, px, py, 26, i % 2 ? MG : CY, 0.8 * Math.sin(loop * 3.14));
    });
  };
  return (
    <>
      <Sfx s={s as any} name="tick" at={t13} volume={0.4} /><Sfx s={s as any} name="tick" at={t49} volume={0.4} /><Sfx s={s as any} name="tick" at={t424} volume={0.4} /><Sfx s={s as any} name="approve" at={tEvery + 0.6} volume={0.4} />
      <Cv draw={draw} />
      <div style={{ position: 'absolute', left: 100, top: 150, display: 'flex', flexDirection: 'column', gap: 34 }}>
        {rows.map(([n, l, t, i, c1, c2]) => (
          <div key={i} style={{ opacity: rp(sec, t - 0.1, 0.3) }}>
            <KText text={n} sec={sec} at={t} size={190} grad={[c1, c2]} glow={`${c2}55`} stagger={0.03} />
            <div style={{ fontFamily: F.mono, fontSize: 22, letterSpacing: '0.16em', color: C.chalk2, marginTop: 4, opacity: rp(sec, t + 0.3, 0.4) }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 1450, top: 120, width: 400 }}>
        {names.map((n, i) => {
          const o = rp(sec, t13 + 0.1 + i * 0.12, 0.35);
          return <div key={i} style={{ height: 52, display: 'flex', alignItems: 'center', gap: 12, opacity: o, transform: `translateX(${(1 - o) * 40}px)`, fontFamily: F.mono, fontSize: 21, color: C.chalk }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: NEON.lime, boxShadow: `0 0 12px ${NEON.lime}` }} /><span style={{ whiteSpace: 'nowrap' }}>{n}</span><span style={{ marginLeft: 'auto', color: NEON.lime, fontSize: 16 }}>OK</span></div>;
        })}
      </div>
      <div style={{ ...center, top: 800, flexDirection: 'column', alignItems: 'center', opacity: rp(sec, tEvery - 0.1, 0.4) }}>
        <KText text="EVERY RECORD" sec={sec} at={tEvery} size={60} wght={300} wdth={130} spacing={10} mode="rise" style={{ color: C.chalk2 }} />
        <KText text="BECOMES A POINT OF LIGHT" sec={sec} at={tEvery + 0.25} size={92} grad={[NEON.white, NEON.cy]} glow="#26e6ff55" stagger={0.03} />
      </div>
    </>
  );
};

/* ======================= 5 · RANK ======================= */
export const Rank: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at, st } = useCine(s);
  const tScores = at('scores', 0, 0.1), tCon = at('constellation', 0, 0.55), tSeven = at('seven', 0, 0.82);
  const score = Math.round(prod.scores * rp(sec, 0.2, 1.4, eoExpo));
  const tops = IDEAS.map((_, c) => { const h = pillarHeight(c) * st.pGrow; return project(st, [Math.cos(pillarAngle(c)) * PILLAR_R, FLOOR_Y + 0.05 + h + 0.35, Math.sin(pillarAngle(c)) * PILLAR_R]); });
  const lineP = rp(sec, tCon - 0.2, 1.1, eio);
  const order = [0, 1, 2, 3, 4, 5, 6];
  const pts = order.map((c) => `${tops[c].x},${tops[c].y - 30}`);
  return (
    <>
      <Sfx s={s as any} name="tick" at={tScores} volume={0.4} /><Sfx s={s as any} name="approve" at={tSeven} volume={0.4} />
      <div style={{ position: 'absolute', left: 100, top: 150 }}>
        <KText text={String(score)} sec={sec} at={0.1} size={230} grad={[NEON.white, NEON.mg]} glow="#ff38c844" stagger={0.04} />
        <div style={{ fontFamily: F.mono, fontSize: 24, letterSpacing: '0.18em', color: C.chalk2, marginTop: 6, opacity: rp(sec, 0.6, 0.4) }}>SCORES COMPUTED</div>
      </div>
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <polyline points={pts.join(' ')} fill="none" stroke={NEON.cy} strokeWidth={2.5} strokeOpacity={0.8} strokeDasharray="1400" strokeDashoffset={1400 * (1 - lineP)} style={{ filter: `drop-shadow(0 0 8px ${NEON.cy})` }} />
        {order.map((c) => { const o = rp(sec, tCon + c * 0.1, 0.4); return <circle key={c} cx={tops[c].x} cy={tops[c].y - 30} r={7 + (c === 0 ? 4 : 0)} fill={c === 0 ? NEON.lime : NEON.white} opacity={o} style={{ filter: `drop-shadow(0 0 12px ${c === 0 ? NEON.lime : NEON.cy})` }} />; })}
      </svg>
      {order.map((c) => {
        const o = rp(sec, tCon + 0.1 + c * 0.1, 0.5, eoExpo); const win = c === 0; const col = win ? NEON.lime : C.chalk;
        return (
          <div key={c} style={{ position: 'absolute', left: tops[c].x, top: tops[c].y - 100, transform: `translate(-50%, -100%) translateY(${(1 - o) * 24}px)`, opacity: o, textAlign: 'center' }}>
            <div style={{ fontFamily: F.kinetic, fontWeight: 900, fontSize: win ? 52 : 38, color: col, fontVariationSettings: "'wdth' 120", textShadow: win ? `0 0 24px ${NEON.lime}88` : 'none' }}>{(IDEAS[c].support * 100).toFixed(0)}</div>
            <div style={{ fontFamily: F.mono, fontSize: win ? 24 : 19, letterSpacing: '0.12em', color: win ? NEON.lime : C.chalk2 }}>{IDEAS[c].short.toUpperCase()}</div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', right: 100, top: 150, textAlign: 'right' }}><KText text="SEVEN IDEAS" sec={sec} at={tSeven - 0.2} size={110} grad={[NEON.white, NEON.cy]} glow="#26e6ff44" stagger={0.035} align="right" /><KText text="RANKED" sec={sec} at={tSeven + 0.1} size={110} grad={[NEON.cy, NEON.lime]} stagger={0.035} align="right" /></div>
    </>
  );
};
export { tn, rgba, CY, MG, SG, VI, sm };
