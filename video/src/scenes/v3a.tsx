import React from 'react';
import { Easing, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Brand, Eyebrow, Panel, SceneFrame, Sfx, SyncedText, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';
import { CY, Cv, MG, SG, VI, WH, cl, dotSphere, drawSphere, easeInOut, easeOut, glow, hash, lerp, line, mix, rgba } from './v3lib';

const prod = (data as any).prod;

/* The brake: a hold-to-approve pill, the motif that returns in the reveal, the brake scene and the close. */
export const HoldPill: React.FC<{ fill: number; label?: string; w?: number }> = ({ fill, label = 'Hold to approve', w = 330 }) => (
  <div style={{ position: 'relative', width: w, height: w * 0.2, borderRadius: 99, overflow: 'hidden', border: `2px solid ${C.signal}`, background: C.ink1, boxShadow: `0 0 ${20 + fill * 40}px ${C.signal}${fill > 0.5 ? '55' : '22'}` }}>
    <div style={{ position: 'absolute', inset: 0, width: `${cl(fill) * 100}%`, background: C.signal, opacity: 0.92 }} />
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: F.body, fontWeight: 700, fontSize: w * 0.072, color: fill > 0.52 ? C.signalInk : C.chalk, whiteSpace: 'nowrap' }}>{fill >= 1 ? 'Approved' : label}</div>
  </div>
);

/* ============================== ASK ============================== */
export const Ask: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tGrow = at('grow', 0, 0.2), tWay = at('way', 0, 0.38), tKnow = at('know', 0, 0.9);
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const cx = 1180, cy = 400;
    // the crowd: faint dots drifting
    for (let i = 0; i < 170; i++) {
      const a = hash(i) * 6.28 + t * (0.03 + hash(i + 9) * 0.05); const r = 120 + hash(i + 3) * 760;
      const x = cx + Math.cos(a) * r * 1.25, y = cy + Math.sin(a) * r * 0.62;
      ctx.fillStyle = rgba(WH, 0.08 + 0.2 * hash(i + 5) * (0.6 + 0.4 * Math.sin(t * 1.4 + i)));
      ctx.beginPath(); ctx.arc(x, y, 1.2 + hash(i + 7) * 2.2, 0, 6.28); ctx.fill();
    }
    // NEAR: one steady star
    const grow = easeOut(ramp(sec, tGrow - 0.4, 1.2));
    glow(ctx, cx, cy, 150 + 60 * grow, VI, 0.22 * grow + 0.05);
    ctx.strokeStyle = rgba(SG, 0.85); ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, 34 + 22 * grow, 0, 6.28); ctx.stroke();
    ctx.fillStyle = rgba(WH, 0.95); ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 6.28); ctx.fill();
    // which way? six directions, each a possible answer
    const o = ramp(sec, tWay - 0.2, 0.7);
    for (let i = 0; i < 6; i++) {
      const a = -1.2 + i * 1.05 + Math.sin(t * 0.6 + i) * 0.04; const on = 0.5 + 0.5 * Math.sin(t * 2.6 + i * 1.7);
      const r0 = 90, r1 = 250 + 60 * hash(i + 2);
      const k = cl(o * 1.4 - i * 0.08);
      const x1 = cx + Math.cos(a) * (r0 + (r1 - r0) * k), y1 = cy + Math.sin(a) * (r0 + (r1 - r0) * k);
      line(ctx, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, x1, y1, SG, 0.2 + 0.5 * on * k, 2);
      ctx.fillStyle = rgba(SG, 0.3 + 0.6 * on * k); ctx.beginPath(); ctx.arc(x1, y1, 7, 0, 6.28); ctx.fill();
      ctx.save(); ctx.translate(x1 + Math.cos(a) * 34, y1 + Math.sin(a) * 34); ctx.fillStyle = rgba(WH, 0.75 * k); ctx.font = `600 40px 'Instrument Serif', serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', 0, 0); ctx.restore();
    }
  };
  return (
    <SceneFrame s={s} glow="#2a1b55">
      <Cv draw={draw} />
      <Sfx s={s} name="tick" at={tWay} volume={0.3} />
      <div style={{ position: 'absolute', left: 120, top: 640, width: 1200, opacity: ramp(sec, 0, 0.5) }}>
        <SyncedText s={s} size={76} italic={['way', 'need', 'know']} accent={C.signal} />
      </div>
    </SceneFrame>
  );
};

/* ============================== CROWD ============================== */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const Crowd: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tCrowd = at('crowd', 0, 0.12), tDemand = at('demand', 0, 0.3), tMonths = at('months', 0, 0.6), tMoves = at('moves', 0, 0.86);
  const gather = easeInOut(ramp(sec, 0.1, Math.max(1, tDemand - 0.1), Easing.linear));
  const drift = easeInOut(ramp(sec, tMoves - 0.3, 1.6, Easing.linear)); // the target leaves
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const bx = 760, by = 470; // the crowd's centre
    const tx = bx + 40 + 760 * drift, ty = by - 30 - 140 * drift; // the target ("what NEAR needs") drifts away
    for (let i = 0; i < 300; i++) {
      const a = hash(i) * 6.28; const r0 = 500 + hash(i + 1) * 700; const r1 = Math.sqrt(hash(i + 2)) * 250;
      const rr = lerp(r0, r1, gather);
      const x = bx + Math.cos(a + t * 0.05 * gather) * rr * 1.2, y = by + Math.sin(a + t * 0.05 * gather) * rr * 0.9;
      const warm = mix(WH, SG, hash(i + 4) * 0.5);
      ctx.fillStyle = rgba(warm, 0.25 + 0.55 * gather * (0.6 + 0.4 * Math.sin(t * 2 + i)));
      ctx.beginPath(); ctx.arc(x, y, 2 + hash(i + 6) * 2.6, 0, 6.28); ctx.fill();
    }
    glow(ctx, bx, by, 300 * gather + 10, SG, 0.1 * gather);
    // the target
    const to = ramp(sec, tDemand, 0.6);
    ctx.strokeStyle = rgba(MG, 0.9 * to); ctx.lineWidth = 3; ctx.setLineDash([10, 9]); ctx.lineDashOffset = -frame * 0.6; ctx.beginPath(); ctx.arc(tx, ty, 62, 0, 6.28); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = rgba(MG, 0.9 * to); ctx.beginPath(); ctx.arc(tx, ty, 8, 0, 6.28); ctx.fill();
    if (drift > 0.02) for (let k = 1; k < 7; k++) { ctx.strokeStyle = rgba(MG, 0.12 * (1 - k / 7) * to); ctx.beginPath(); ctx.arc(tx - k * 46 * drift, ty + k * 8 * drift, 62, 0, 6.28); ctx.stroke(); }
  };
  const run = ramp(sec, tMonths - 0.2, Math.max(1.2, tMoves - tMonths + 0.4), Easing.linear);
  return (
    <SceneFrame s={s} glow="#33300a">
      <Cv draw={draw} />
      <Sfx s={s} name="tick" at={tDemand} volume={0.3} />
      <Sfx s={s} name="warn" at={tMoves} volume={0.3} />
      <div style={{ position: 'absolute', left: 560, top: 690, opacity: ramp(sec, tCrowd, 0.5) }}><Eyebrow color={C.signal}>real demand · real people</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, right: 120, top: 750, opacity: ramp(sec, tMonths - 0.3, 0.5) }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {MONTHS.map((m, i) => {
            const lit = run * 12 > i;
            return <div key={m} style={{ flex: 1, textAlign: 'center', padding: '12px 0', fontFamily: F.mono, fontSize: 22, letterSpacing: '0.1em', color: lit ? C.warn : C.chalk3, border: `1px solid ${lit ? C.warn + '88' : C.line}`, borderRadius: 8, background: lit ? `${C.warn}14` : C.ink1 }}>{m}</div>;
          })}
        </div>
        <Eyebrow color={C.warn} style={{ marginTop: 12 }}>research takes time · the question keeps moving</Eyebrow>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 120, width: 1500, opacity: 0.0 + ramp(sec, 0.2, 0.5) }}>
        <SyncedText s={s} size={58} italic={['crowd', 'demand', 'moves']} accent={C.signal} />
      </div>
    </SceneFrame>
  );
};

/* ============================== REVEAL ============================== */
const STAR_POS = (k: number, n: number, cx: number, cy: number) => {
  const a = -Math.PI / 2 + (k / n) * 6.2832; const rr = 300 + 30 * Math.sin(k * 2.1);
  return { x: cx + Math.cos(a) * rr * 1.25, y: cy + Math.sin(a) * rr * 0.8 };
};
export const Reveal: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tName = at('AutoNEAR', 0, 0.06), tListen = at('listens', 0, 0.28), tRank = at('ranks', 0, 0.52), tBuild = at('building', 0, 0.7), tBrake = at('brake', 0, 0.93);
  const opps = prod.council as any[];
  const pts = React.useMemo(() => dotSphere(520, 11), []);
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const cx = 960, cy = 470; const t = frame / 30;
    const a = easeOut(ramp(sec, tName - 0.2, 1.4));
    glow(ctx, cx, cy, 520, VI, 0.16 * a); glow(ctx, cx, cy, 300, MG, 0.12 * a);
    drawSphere(ctx, pts, cx, cy, 150 * (0.6 + 0.4 * a), t * 0.35, 0.4, a, frame);
    const n = opps.length;
    for (let k = 0; k < n; k++) {
      const p = STAR_POS(k, n, cx, cy); const o = easeOut(ramp(sec, tListen + k * 0.12, 0.7));
      const q = STAR_POS((k + 1) % n, n, cx, cy);
      line(ctx, cx, cy, lerp(cx, p.x, o), lerp(cy, p.y, o), CY, 0.25 * o, 1.2);
      if (sec > tRank) line(ctx, p.x, p.y, q.x, q.y, VI, 0.4 * ramp(sec, tRank + k * 0.08, 0.5), 1.4);
      glow(ctx, p.x, p.y, 34, k === 0 && sec > tBuild ? SG : CY, 0.5 * o);
      ctx.fillStyle = rgba(WH, 0.95 * o); ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, 6.28); ctx.fill();
    }
  };
  const brake = ramp(sec, tBrake - 0.1, 0.9, Easing.linear);
  const chip = (label: string, t0: number, c: string) => (
    <div style={{ opacity: ramp(sec, t0, 0.4), transform: `translateY(${(1 - ramp(sec, t0, 0.4)) * 16}px)`, padding: '10px 24px', borderRadius: 99, border: `2px solid ${c}`, color: c, fontFamily: F.mono, fontWeight: 700, fontSize: 28, letterSpacing: '0.14em', background: `${C.ink1}dd` }}>{label}</div>
  );
  return (
    <SceneFrame s={s} glow="#34114d">
      <Cv draw={draw} />
      <Sfx s={s} name="approve" at={tName} volume={0.4} />
      <Sfx s={s} name="tick" at={tListen} volume={0.3} />
      <Sfx s={s} name="tick" at={tRank} volume={0.3} />
      <Sfx s={s} name="tick" at={tBuild} volume={0.3} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 70, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, opacity: ramp(sec, tName, 0.5) }}>
        <Brand size={84} /><span style={{ fontFamily: F.display, fontSize: 130, color: C.chalk, letterSpacing: '-0.02em' }}>AutoNEAR</span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 790, display: 'flex', justifyContent: 'center', gap: 22 }}>
        {chip('LISTEN', tListen, C.mineralHi)}{chip('RANK', tRank, C.warn)}{chip('BUILD', tBuild, C.signal)}
      </div>
      <div style={{ position: 'absolute', right: 120, top: 820, opacity: ramp(sec, tBrake - 0.4, 0.5) }}><HoldPill fill={brake} label="Your hand on the brake" w={420} /></div>
    </SceneFrame>
  );
};

/* ============================== SIGNALS (the constellation + the mirror world) ============================== */
const short = (name: string) => name.split(' · ')[0].replace('NEAR mainnet RPC', 'NEAR RPC').replace('Sputnik DAO treasuries', 'Sputnik DAOs').replace('NEAR Governance Forum', 'gov.near forum').replace('GitHub issues', 'GitHub').replace('Hacker News', 'Hacker News');
export const Signals: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tSources = at('sources', 0, 0.05), tFeeds = at('feeds', 0, 0.3), tPosts = at('posts', 0, 0.5), tLinked = at('linked', 0, 0.8);
  const names = (prod.sourceNames as any[]).map((x) => short(x.name));
  const opps = prod.council as any[];
  const pts = React.useMemo(() => dotSphere(760, 5), []);
  const HOR = 660; // horizon: the mirror plane
  const CX = 1010, CY0 = 440;
  const src = (i: number) => ({ x: 150, y: 150 + i * (HOR - 190) / (names.length - 1) });
  const draw = (ctx: CanvasRenderingContext2D, frame: number, W: number, H: number) => {
    const t = frame / 30;
    // 1) draw the constellation to an offscreen canvas (the "world")
    const off = document.createElement('canvas'); off.width = W; off.height = HOR; const o = off.getContext('2d')!;
    const open = easeOut(ramp(sec, tSources - 0.3, 1.2));
    glow(o, CX, CY0, 520, VI, 0.16 * open); glow(o, CX, CY0, 300, MG, 0.12 * open);
    // sources -> particles -> the star
    names.forEach((_, i) => {
      const p = src(i); const on = ramp(sec, tSources + i * 0.05, 0.4);
      o.fillStyle = rgba(SG, 0.95 * on); o.beginPath(); o.arc(p.x, p.y, 6, 0, 6.28); o.fill(); glow(o, p.x, p.y, 26, SG, 0.35 * on);
      for (let k = 0; k < 7; k++) {
        const u = ((t * (0.22 + 0.04 * hash(i)) + k / 7 + hash(i * 7)) % 1);
        const e = easeInOut(u); const bend = Math.sin(e * Math.PI) * (i % 2 ? -70 : 70) * (1 - Math.abs(i - 6) / 8);
        const x = lerp(p.x, CX - 120 * Math.cos(0), e) , y = lerp(p.y, CY0, e) + bend;
        o.fillStyle = rgba(mix(SG, CY, e), 0.75 * on * Math.sin(u * Math.PI)); o.beginPath(); o.arc(x, y, 2.4, 0, 6.28); o.fill();
      }
    });
    drawSphere(o, pts, CX, CY0, 190 * (0.7 + 0.3 * open), t * 0.4, 0.4, open, frame);
    // 7 ideas condense and orbit
    const ideas = easeOut(ramp(sec, tPosts + 0.4, 1.0));
    opps.forEach((op, k) => {
      const a = -Math.PI / 2 + (k / opps.length) * 6.2832 + t * 0.05; const R = 300 * ideas;
      const x = CX + Math.cos(a) * R * 1.3, y = CY0 + Math.sin(a) * R * 0.78;
      line(o, CX, CY0, x, y, MG, 0.25 * ideas, 1.2);
      glow(o, x, y, 30 + 30 * op.support, k === 0 ? SG : MG, 0.55 * ideas);
      o.fillStyle = rgba(WH, ideas); o.beginPath(); o.arc(x, y, 5, 0, 6.28); o.fill();
    });
    ctx.drawImage(off, 0, 0);
    // 2) the mirror world: reflected, rippled, tinted, fading away from the horizon
    const refl = 270;
    for (let y = 0; y < refl; y += 2) {
      const sy = HOR - 1 - y; const fade = Math.pow(1 - y / refl, 1.1) * 1.0;
      const dx = Math.sin(y * 0.09 + t * 2.2) * (2 + y * 0.05);
      ctx.globalAlpha = fade; ctx.drawImage(off, 0, sy - 1, W, 2, dx, HOR + y, W, 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter'; const g = ctx.createLinearGradient(0, HOR, 0, HOR + refl); g.addColorStop(0, rgba(MG, 0.14 * open)); g.addColorStop(1, rgba(VI, 0)); ctx.fillStyle = g; ctx.fillRect(0, HOR, W, refl); ctx.globalCompositeOperation = 'source-over';
    const hg = ctx.createLinearGradient(0, 0, W, 0); hg.addColorStop(0, rgba(CY, 0)); hg.addColorStop(0.5, rgba(WH, 0.5 * open)); hg.addColorStop(1, rgba(CY, 0)); ctx.fillStyle = hg; ctx.fillRect(0, HOR - 1, W, 2);
  };
  const roll = (to: number, t0: number, d = 1.1) => Math.round(to * easeOut(ramp(sec, t0, d)));
  const stats: [string, string, string][] = [
    [`${roll(prod.sourcesOk, tSources)} / ${prod.sourcesTotal}`, 'sources live', C.signal],
    [String(roll(prod.feeds, tFeeds)), 'feeds watched', C.mineralHi],
    [String(roll(prod.evidence, tPosts, 1.4)), 'posts and commits read', C.chalk],
    [String(roll(prod.scores, tLinked, 1.2)), 'scores computed', C.warn],
  ];
  return (
    <SceneFrame s={s} glow="#34114d">
      <Cv draw={draw} />
      <Sfx s={s} name="tick" at={tFeeds} volume={0.3} />
      <Sfx s={s} name="tick" at={tPosts} volume={0.3} />
      <Sfx s={s} name="approve" at={tLinked} volume={0.3} />
      {names.map((n, i) => {
        const p = src(i); const on = ramp(sec, tSources + i * 0.05, 0.4);
        return <div key={i} style={{ position: 'absolute', left: p.x + 18, top: p.y - 12, fontFamily: F.mono, fontSize: 17, color: C.chalk2, opacity: on, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{n}</div>;
      })}
      <div style={{ position: 'absolute', right: 96, top: 120, width: 340, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {stats.map(([n, l, c], i) => {
          const o = ramp(sec, [tSources, tFeeds, tPosts, tLinked][i] - 0.1, 0.4);
          return (
            <div key={l} style={{ opacity: o, transform: `translateX(${(1 - o) * 30}px)` }}>
              <Panel style={{ padding: '12px 22px' }}>
                <div style={{ fontFamily: F.display, fontSize: 70, lineHeight: 1, color: c }}>{n}</div>
                <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, marginTop: 4 }}>{l}</div>
              </Panel>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 150, top: HOR + 70, fontFamily: F.mono, fontSize: 15, letterSpacing: '0.12em', color: rgba(CY, 0.7) as string, opacity: ramp(sec, tPosts, 0.6) }}>MIRROR WORLD</div>
    </SceneFrame>
  );
};
