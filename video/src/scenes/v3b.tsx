import React from 'react';
import { Easing, Img, staticFile } from 'remotion';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Brand, Eyebrow, Panel, SceneFrame, Sfx, Stamp, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';
import meta from '../../script/meta.json';
import { CY, Cv, MG, SG, VI, WH, cl, dotSphere, drawSphere, easeInOut, easeOut, glow, hash, lerp, line, mix, rgba } from './v3lib';
import { HoldPill } from './v3a';
import { Ring } from './v2';

const prod = (data as any).prod;
const tn = (data as any).testnet;
const STANCE: Record<string, [number, number, number]> = { back: [90, 255, 210], abstain: [247, 184, 77], object: [255, 64, 128] };
const VERD: Record<string, [number, number, number]> = { go: SG, watch: [247, 184, 77], drop: [140, 145, 153] };
const hex = (c: number[]) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/* ============================== COUNCIL (the council star: seven seats vote in a loop, full stream) ============================== */
export const Council3: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tSeven = at('Seven', 0, 0.02), tSkeptic = at('skeptic', 0, 0.3), tToday = at('Today', 0, 0.5), tGo = at('go', 0, 0.7), tRepeat = at('repeats', 0, 0.86);
  const seats = prod.seatNames as { role: string; label: string; weight: number }[];
  const all = prod.council as any[];
  const winner = all.find((o) => o.id === prod.winner.id);
  const others = all.filter((o) => o.id !== winner.id).sort((a, b) => a.support - b.support);
  const order = [...others, winner];
  const goAt = prod.goAt as number;
  const t0 = tSeven + 0.15;
  const cyc = Math.max(0.85, (tToday - 0.35 - t0) / others.length);
  const winStart = Math.max(t0 + others.length * 0.85, tToday - 0.35);
  // cycles: n < others.length -> others; n = others.length -> winner; then it keeps looping through all seven
  const cycles: { start: number; opp: any; dt: number }[] = [];
  others.forEach((o, i) => cycles.push({ start: t0 + i * cyc, opp: o, dt: Math.min(0.1, cyc / 9) }));
  cycles.push({ start: winStart, opp: winner, dt: 0.17 });
  for (let n = 0; n < 14; n++) cycles.push({ start: winStart + 2.1 + n * 0.95, opp: order[n % order.length], dt: 0.09 });
  let idx = -1; cycles.forEach((c, i) => { if (sec >= c.start) idx = i; });
  const cur = idx >= 0 ? cycles[idx] : null;
  const fireT = (c: { start: number; dt: number }, k: number) => c.start + 0.12 + k * c.dt;
  // weighted support as seats fire
  let S = 0; if (cur) cur.opp.votes.forEach((v: any, k: number) => { if (sec >= fireT(cur, k)) S += v.weight * v.support; });
  const allFired = cur ? sec >= fireT(cur, 6) + 0.1 : false;
  const SC = { x: 760, y: 470 };
  const seatPos = (k: number, r = 190) => { const a = -Math.PI / 2 + (k / 7) * 6.2832; return { x: SC.x + Math.cos(a) * r, y: SC.y + Math.sin(a) * r * 0.92 }; };
  const crysPos = (k: number) => { const a = -Math.PI / 2 + ((k + 0.5) / 7) * 6.2832; return { x: SC.x + Math.cos(a) * 360 * 1.22, y: SC.y + Math.sin(a) * 360 * 0.78 }; };
  const pts = React.useMemo(() => dotSphere(420, 3), []);
  const oppIndex = (id: string) => all.findIndex((o) => o.id === id);
  // events for the stream
  const events: { t: number; txt: string; color: string; bold?: boolean }[] = [];
  cycles.forEach((c) => {
    c.opp.votes.forEach((v: any, k: number) => { const t = fireT(c, k); if (sec >= t) events.push({ t, txt: `${c.opp.short.padEnd(9)} ${v.label.padEnd(9)} ${v.support.toFixed(2)}`, color: hex(STANCE[v.stance] ?? STANCE.back) }); });
    const tv = fireT(c, 6) + 0.18; if (sec >= tv) events.push({ t: tv, txt: `→ ${c.opp.short.toUpperCase()} ${c.opp.verdict.toUpperCase()}  ${(c.opp.support * 100).toFixed(0)}`, color: hex(VERD[c.opp.verdict]), bold: true });
  });
  const shown = events.sort((a, b) => b.t - a.t).slice(0, 15);
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const open = easeOut(ramp(sec, tSeven - 0.3, 1.0));
    glow(ctx, SC.x, SC.y, 520, VI, 0.15 * open); glow(ctx, SC.x, SC.y, 300, MG, 0.12 * open);
    drawSphere(ctx, pts, SC.x, SC.y, 128, t * 0.3, 0.4, 0.55 * open, frame, false);
    // gauge ring
    const vc = cur ? VERD[cur.opp.verdict] : CY;
    ctx.lineWidth = 9; ctx.strokeStyle = rgba(WH, 0.08); ctx.beginPath(); ctx.arc(SC.x, SC.y, 112, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = rgba(allFired ? vc : CY, 0.95); ctx.beginPath(); ctx.arc(SC.x, SC.y, 112, -Math.PI / 2, -Math.PI / 2 + 6.2832 * cl(S)); ctx.stroke();
    const ga = -Math.PI / 2 + 6.2832 * goAt; ctx.strokeStyle = rgba(WH, 0.9); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(SC.x + Math.cos(ga) * 100, SC.y + Math.sin(ga) * 100); ctx.lineTo(SC.x + Math.cos(ga) * 126, SC.y + Math.sin(ga) * 126); ctx.stroke();
    // crystals: one per idea, with the active link
    all.forEach((o, k) => {
      const p = crysPos(k); const done = cycles.some((c) => c.opp.id === o.id && sec >= fireT(c, 6) + 0.15); const active = cur?.opp.id === o.id;
      const col = done || active ? VERD[o.verdict] : CY;
      if (active) line(ctx, SC.x, SC.y, p.x, p.y, col, 0.5, 2.2);
      glow(ctx, p.x, p.y, active ? 70 : 42, col, active ? 0.55 : 0.28 * open);
      ctx.fillStyle = rgba(WH, 0.9 * open); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); const r = active ? 11 : 8; ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
    });
    // seats + bolts
    seats.forEach((seat, k) => {
      const p = seatPos(k); let f = -9; let stance = 'back';
      if (cur) { f = sec - fireT(cur, k); stance = cur.opp.votes[k]?.stance ?? 'back'; }
      const col = STANCE[stance] ?? STANCE.back; const hot = f >= 0 && f < 0.55;
      if (f >= 0) { const bolt = Math.exp(-f * 4); line(ctx, p.x, p.y, SC.x, SC.y, col, 0.15 + 0.85 * bolt, 1.5 + 4 * bolt); }
      glow(ctx, p.x, p.y, hot ? 62 : 34, f >= 0 ? col : CY, f >= 0 ? 0.55 : 0.3 * open);
      ctx.fillStyle = rgba(WH, open); ctx.beginPath(); ctx.arc(p.x, p.y, k === 2 && sec > tSkeptic ? 11 : 7, 0, 6.28); ctx.fill();
      if (k === 2 && sec > tSkeptic - 0.1 && sec < tSkeptic + 2.2) { ctx.strokeStyle = rgba(MG, 0.9); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 24 + 6 * Math.sin(t * 8), 0, 6.28); ctx.stroke(); }
    });
    // the loop: an orbiting arrow after "repeats"
    const lp = ramp(sec, tRepeat - 0.2, 0.6);
    if (lp > 0) { ctx.strokeStyle = rgba(SG, 0.8 * lp); ctx.lineWidth = 3; ctx.setLineDash([2, 14]); ctx.lineDashOffset = -frame * 1.4; ctx.beginPath(); ctx.ellipse(SC.x, SC.y, 460, 330, 0, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]); }
  };
  const score = Math.round(S * 100);
  return (
    <SceneFrame s={s} glow="#34114d">
      <Cv draw={draw} />
      {cycles.slice(0, 7).map((c, i) => <Sfx key={i} s={s} name="tick" at={fireT(c, 6)} volume={0.18} />)}
      <Sfx s={s} name="approve" at={tGo} volume={0.5} />
      {/* seat names */}
      {seats.map((seat, k) => {
        const p = seatPos(k, 245); const isSk = k === 2;
        return <div key={seat.role} style={{ position: 'absolute', left: p.x, top: p.y, transform: 'translate(-50%,-50%)', fontFamily: F.mono, fontSize: 18, letterSpacing: '0.08em', color: isSk && sec > tSkeptic ? '#ff6ad0' : C.chalk2, opacity: ramp(sec, tSeven, 0.5), fontWeight: isSk ? 700 : 400 }}>{seat.label.toUpperCase()}</div>;
      })}
      {all.map((o, k) => {
        const p = crysPos(k); const done = cycles.some((c) => c.opp.id === o.id && sec >= fireT(c, 6) + 0.15); const active = cur?.opp.id === o.id;
        return (
          <div key={o.id} style={{ position: 'absolute', left: p.x, top: p.y + 26, transform: 'translateX(-50%)', textAlign: 'center', opacity: ramp(sec, tSeven, 0.6) * (active ? 1 : 0.8) }}>
            <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 20, color: active ? C.chalk : C.chalk2, whiteSpace: 'nowrap' }}>{o.short}</div>
            {done && <div style={{ fontFamily: F.mono, fontSize: 17, color: hex(VERD[o.verdict]) }}>{(o.support * 100).toFixed(0)} · {o.verdict}</div>}
          </div>
        );
      })}
      {/* centre readout */}
      <div style={{ position: 'absolute', left: SC.x, top: SC.y, transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontSize: 64, lineHeight: 1, color: allFired && cur ? hex(VERD[cur.opp.verdict]) : C.chalk }}>{score}</div>
        <div style={{ fontFamily: F.mono, fontSize: 14, color: C.chalk3, letterSpacing: '0.08em' }}>NEEDS {Math.round(goAt * 100)}</div>
      </div>
      {allFired && cur && (
        <div style={{ position: 'absolute', left: SC.x, top: SC.y - 280, transform: 'translateX(-50%)' }}>
          <Stamp label={cur.opp.verdict === 'go' ? `${cur.opp.short} · GO` : `${cur.opp.short} · ${cur.opp.verdict}`} color={hex(VERD[cur.opp.verdict])} o={1} size={cur.opp.verdict === 'go' ? 34 : 22} rot={cur.opp.verdict === 'go' ? -3 : 0} />
        </div>
      )}
      {sec > tSkeptic - 0.1 && sec < tSkeptic + 2.4 && (
        <div style={{ position: 'absolute', left: seatPos(2).x + 40, top: seatPos(2).y + 20, fontFamily: F.mono, fontSize: 17, color: '#ff6ad0', background: `${C.ink1}ee`, border: '1px solid #ff6ad066', borderRadius: 8, padding: '6px 12px', opacity: ramp(sec, tSkeptic - 0.1, 0.3) }}>tries to break every idea</div>
      )}
      {/* the vote stream */}
      <div style={{ position: 'absolute', left: 1380, top: 130, width: 450, opacity: ramp(sec, tSeven, 0.5) }}>
        <Eyebrow color={C.signal} style={{ marginBottom: 10 }}>council stream</Eyebrow>
        <Panel style={{ padding: '14px 18px', height: 700, overflow: 'hidden' }}>
          {shown.map((e, i) => (
            <div key={e.t + '-' + i} style={{ fontFamily: F.mono, fontSize: 18, lineHeight: '36px', whiteSpace: 'pre', color: e.color, opacity: Math.max(0.12, 1 - i * 0.07), fontWeight: e.bold ? 700 : 400 }}>{e.txt}</div>
          ))}
        </Panel>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 868, fontFamily: F.mono, fontSize: 17, letterSpacing: '0.08em', color: C.chalk3, opacity: ramp(sec, tRepeat - 0.2, 0.5) }}>↻ {prod.opportunities} ideas · {prod.seats} seats · {prod.seatVotes} votes · repeats with every new record</div>
    </SceneFrame>
  );
};

/* ============================== SWARM (named cursors build the product page) ============================== */
type El = { id: string; k: 'text' | 'box' | 'media' | 'btn' | 'pill'; x: number; y: number; w: number; h: number; text?: string; size?: number; serif?: boolean; em?: boolean; mute?: boolean; n: number };
const PAGE: El[] = [
  { id: 'nav', k: 'box', x: 0, y: 0, w: 1060, h: 54, n: 0 },
  { id: 'logo', k: 'text', x: 24, y: 12, w: 200, h: 30, text: 'Treasury', size: 24, serif: true, n: 0 },
  { id: 'l1', k: 'text', x: 640, y: 18, w: 90, h: 20, text: 'How it works', size: 15, mute: true, n: 1 },
  { id: 'l2', k: 'text', x: 760, y: 18, w: 90, h: 20, text: 'Limits', size: 15, mute: true, n: 1 },
  { id: 'navbtn', k: 'btn', x: 900, y: 10, w: 140, h: 34, text: 'Open', size: 15, n: 2 },
  { id: 'badge', k: 'pill', x: 40, y: 96, w: 150, h: 34, text: 'TREASURY', size: 14, n: 1 },
  { id: 'h1', k: 'text', x: 40, y: 148, w: 560, h: 130, text: 'Rebalance your treasury inside rules you set.', size: 54, serif: true, em: true, n: 2 },
  { id: 'sub', k: 'text', x: 40, y: 292, w: 520, h: 56, text: 'A policy-bound agent proposes the moves. Your signature approves them.', size: 20, mute: true, n: 3 },
  { id: 'cta', k: 'btn', x: 40, y: 370, w: 230, h: 52, text: 'Try it on testnet', size: 19, n: 4 },
  { id: 'media', k: 'media', x: 650, y: 96, w: 370, h: 330, n: 5 },
  { id: 'f1', k: 'box', x: 40, y: 470, w: 310, h: 150, n: 6 },
  { id: 'f2', k: 'box', x: 375, y: 470, w: 310, h: 150, n: 7 },
  { id: 'f3', k: 'box', x: 710, y: 470, w: 310, h: 150, n: 8 },
  { id: 'f1t', k: 'text', x: 62, y: 492, w: 270, h: 60, text: 'Policy limits', size: 26, serif: true, n: 6 },
  { id: 'f1b', k: 'text', x: 62, y: 536, w: 270, h: 70, text: 'Caps per move and per day, set by you.', size: 16, mute: true, n: 6 },
  { id: 'f2t', k: 'text', x: 397, y: 492, w: 270, h: 60, text: 'Your signature', size: 26, serif: true, n: 7 },
  { id: 'f2b', k: 'text', x: 397, y: 536, w: 270, h: 70, text: 'Every move waits for your approval.', size: 16, mute: true, n: 7 },
  { id: 'f3t', k: 'text', x: 732, y: 492, w: 270, h: 60, text: 'Public trail', size: 26, serif: true, n: 8 },
  { id: 'f3b', k: 'text', x: 732, y: 536, w: 270, h: 70, text: 'Every step is recorded and checkable.', size: 16, mute: true, n: 8 },
];
const AGENTS: { name: string; color: string }[] = [
  { name: 'Copy', color: '#5ae6ff' }, { name: 'Layout', color: '#c6f432' }, { name: 'Style', color: '#ff6ad0' }, { name: 'Media', color: '#f2b84b' }, { name: 'Check', color: '#7cffc4' },
];
export const Swarm: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tSwarm = at('swarm', 0, 0.05), tFive = at('Five', 0, 0.2);
  const tp = [at('Copy.', 0, 0.45), at('Layout.', 0, 0.58), at('Style.', 0, 0.7), at('Media.', 0, 0.82), at('Check.', 0, 0.93)];
  const PW = 1060, PH = 640, PX = 120, PY = 140;
  // each element appears in the phase of its owner: text -> Copy, box/pill/btn outlines -> Layout, fills -> Style, media -> Media, checks -> Check
  const phaseOf = (p: number, d = 0.9) => ramp(sec, tp[p] - 0.25, d, Easing.linear);
  const copyP = phaseOf(0, 1.0), layP = phaseOf(1), styP = phaseOf(2), medP = phaseOf(3), chkP = phaseOf(4);
  const win = ramp(sec, tSwarm - 0.1, 0.6);
  // cursor target: the element being worked by that agent, in document order
  const targets = (a: number): { x: number; y: number }[] => {
    const list = PAGE.filter((e) => (a === 0 ? e.k === 'text' : a === 1 ? e.k === 'box' || e.k === 'pill' || e.k === 'btn' : a === 2 ? e.k !== 'media' : a === 3 ? e.k === 'media' : true));
    return list.map((e) => ({ x: PX + e.x + e.w * 0.7, y: PY + 56 + e.y + e.h * 0.6 }));
  };
  const cursor = (a: number, i: number) => {
    const p = [copyP, layP, styP, medP, chkP][a]; const tg = targets(a);
    const idle = { x: PX + PW + 60 + 16 * i, y: PY + 90 + i * 120 + 12 * Math.sin(sec * 2 + i) };
    const arrive = easeOut(ramp(sec, tFive - 0.4 + i * 0.1, 0.9));
    const start = { x: lerp(1900, idle.x, arrive), y: lerp(100 + i * 200, idle.y, arrive) };
    if (p <= 0 || p >= 1) { const tgt = p >= 1 ? tg[tg.length - 1] : start; return p >= 1 ? { x: lerp(tgt.x, idle.x, easeOut(ramp(sec, tp[a] + 0.7, 0.6))), y: lerp(tgt.y, idle.y, easeOut(ramp(sec, tp[a] + 0.7, 0.6))) } : start; }
    const f = p * (tg.length - 1); const j = Math.max(0, Math.min(tg.length - 2, Math.floor(f))); const u = easeInOut(f - j);
    const pos = tg.length < 2 ? { x: tg[0].x - 60 * Math.sin(p * 6.28), y: tg[0].y + 50 * Math.cos(p * 6.28) } : { x: lerp(tg[j].x, tg[j + 1].x, u), y: lerp(tg[j].y, tg[j + 1].y, u) };
    const into = easeOut(Math.min(1, p * 8));
    return { x: lerp(start.x, pos.x, into), y: lerp(start.y, pos.y, into) };
  };
  const shown = PAGE.filter((e) => e.k !== 'text' || copyP > 0).length;
  return (
    <SceneFrame s={s} glow="#2a1b55">
      <Sfx s={s} name="whoosh" at={tSwarm} volume={0.5} />
      {tp.map((t, i) => <Sfx key={i} s={s} name="tick" at={t} volume={0.35} />)}
      <Sfx s={s} name="approve" at={tp[4] + 0.6} volume={0.4} />
      {/* browser window */}
      <div style={{ position: 'absolute', left: PX, top: PY - 0, width: PW, height: PH + 56, borderRadius: 16, overflow: 'hidden', border: `2px solid ${chkP > 0.98 ? C.signal : C.lineHi}`, background: styP > 0.3 ? '#0e1318' : C.ink1, opacity: win, boxShadow: `0 30px 90px #000000aa, 0 0 ${30 + 60 * chkP}px ${chkP > 0.98 ? C.signal + '55' : '#8f52ff44'}` }}>
        <div style={{ height: 56, background: C.ink2, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 18 }}>
          {['#ff6a3d', '#f2b84b', '#7cffc4'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 99, background: c, opacity: 0.8 }} />)}
          <span style={{ marginLeft: 20, fontFamily: F.mono, fontSize: 15, color: C.chalk3 }}>/develop/{prod.winner.word}</span>
        </div>
        <div style={{ position: 'relative', top: 0 }}>
          {PAGE.map((e) => {
            const own = e.k === 'text' ? copyP : e.k === 'media' ? medP : layP;
            const o = e.k === 'text' ? ramp(sec, tp[0] - 0.1 + (e.n * 0.1), 0.35) * (copyP > 0 ? 1 : 0) : e.k === 'media' ? easeOut(medP * 3) : easeOut(cl(layP * 1.2 - e.n * 0.04) * 1.5);
            const styled = styP * (1 - 0) > 0.05 + e.n * 0.01;
            const pos: React.CSSProperties = { position: 'absolute', left: e.x, top: 56 + e.y - 56 + 0, width: e.w, height: e.h };
            const base: React.CSSProperties = { ...pos, opacity: Math.max(0, Math.min(1, o)) };
            if (e.k === 'text') {
              return <div key={e.id} style={{ ...base, top: e.y, fontFamily: styled && e.serif ? F.display : F.body, fontSize: e.size, lineHeight: 1.08, color: e.mute ? (styled ? C.chalk2 : '#7a7a74') : (styled ? C.chalk : '#b4b4ac'), fontStyle: styled && e.em ? 'italic' : 'normal', letterSpacing: styled && e.serif ? '-0.02em' : 0 }}>{e.text}{copyP > 0 && copyP < 0.98 && e.n === Math.floor(copyP * 3) ? <span style={{ color: AGENTS[0].color }}>▍</span> : null}</div>;
            }
            if (e.k === 'media') {
              return (
                <div key={e.id} style={{ ...base, top: e.y, borderRadius: 14, border: `2px dashed ${AGENTS[3].color}`, background: styled ? 'linear-gradient(145deg,#1b2433,#241636)' : 'transparent', overflow: 'hidden' }}>
                  <svg width={e.w} height={e.h} viewBox={`0 0 ${e.w} ${e.h}`}>
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => { const bh = (40 + 190 * hash(i + 4)) * easeOut(medP * 1.4 - i * 0.07); return <rect key={i} x={30 + i * 48} y={e.h - 30 - bh} width={32} height={bh} rx={6} fill={i % 3 === 0 ? '#c6f432' : i % 3 === 1 ? '#5ae6ff' : '#ff6ad0'} opacity={0.85} />; })}
                    <circle cx={e.w - 80} cy={80} r={44 * easeOut(medP * 1.2)} fill="none" stroke="#f2b84b" strokeWidth={10} strokeDasharray={`${180 * medP} 400`} />
                  </svg>
                </div>
              );
            }
            const fill = styled;
            return (
              <div key={e.id} style={{ ...base, top: e.y, borderRadius: e.k === 'pill' ? 99 : e.k === 'btn' ? 10 : e.k === 'box' && e.id === 'nav' ? 0 : 14, border: `2px dashed ${fill ? 'transparent' : AGENTS[1].color}`, background: fill ? (e.k === 'btn' ? C.signal : e.k === 'pill' ? `${C.signal}22` : e.id === 'nav' ? C.ink2 : '#151d26') : 'transparent', display: 'grid', placeItems: 'center', fontFamily: F.body, fontWeight: 700, fontSize: e.size, color: e.k === 'btn' ? (fill ? C.signalInk : AGENTS[1].color) : C.signal, letterSpacing: e.k === 'pill' ? '0.14em' : 0 }}>{e.k === 'btn' || e.k === 'pill' ? e.text : ''}</div>
            );
          })}
          {/* the check pass: green outlines + ticks */}
          {PAGE.filter((e) => e.k === 'box' && e.id !== 'nav').map((e) => (
            <div key={'c' + e.id} style={{ position: 'absolute', left: e.x, top: e.y, width: e.w, height: e.h, borderRadius: 14, border: `3px solid ${AGENTS[4].color}`, opacity: ramp(sec, tp[4] + (e.n - 6) * 0.12, 0.3) * 0.9 }}>
              <span style={{ position: 'absolute', right: 10, top: 6, fontFamily: F.mono, fontSize: 22, color: AGENTS[4].color, fontWeight: 700 }}>✓</span>
            </div>
          ))}
        </div>
      </div>
      {/* cursors */}
      {AGENTS.map((a, i) => {
        const p = cursor(i, i);
        return (
          <div key={a.name} style={{ position: 'absolute', left: p.x, top: p.y, opacity: ramp(sec, tFive - 0.4 + i * 0.1, 0.4), filter: `drop-shadow(0 0 10px ${a.color})` }}>
            <svg width="30" height="34" viewBox="0 0 30 34"><path d="M2 2 L2 26 L9 20 L14 31 L19 29 L14 18 L24 18 Z" fill={a.color} stroke="#0a0c0f" strokeWidth="2" strokeLinejoin="round" /></svg>
            <div style={{ position: 'absolute', left: 22, top: 26, padding: '2px 10px', borderRadius: 99, background: a.color, color: '#0a0c0f', fontFamily: F.body, fontWeight: 800, fontSize: 18 }}>{a.name}</div>
          </div>
        );
      })}
      {/* roster */}
      <div style={{ position: 'absolute', left: 1330, top: 160, width: 470 }}>
        <Eyebrow color={C.signal} style={{ marginBottom: 12, opacity: ramp(sec, tFive - 0.3, 0.4) }}>the swarm · five cursors</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {AGENTS.map((a, i) => {
            const p = [copyP, layP, styP, medP, chkP][i]; const o = ramp(sec, tFive - 0.2 + i * 0.08, 0.4);
            return (
              <div key={a.name} style={{ opacity: o, display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', padding: '14px 20px', border: `1px solid ${p > 0 && p < 1 ? a.color : C.line}`, borderRadius: 10, background: p > 0 && p < 1 ? `${a.color}18` : C.ink1 }}>
                <div>
                  <div style={{ fontFamily: F.display, fontSize: 40, color: C.chalk, lineHeight: 1 }}>{a.name}</div>
                  <div style={{ height: 6, borderRadius: 99, background: C.ink0, marginTop: 8, width: 300 }}><div style={{ height: '100%', width: `${cl(p) * 100}%`, background: a.color, borderRadius: 99 }} /></div>
                </div>
                <span style={{ fontFamily: F.mono, fontSize: 26, color: a.color }}>{p >= 1 ? '✓' : p > 0 ? '…' : ''}</span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 22, opacity: ramp(sec, tp[4] + 0.5, 0.5) }}><Stamp label="page built" color={C.signal} o={1} size={28} rot={-3} /></div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 868, fontFamily: F.mono, fontSize: 16, letterSpacing: '0.08em', color: C.chalk3, opacity: win }}>{shown} parts placed · replay of the build flow</div>
    </SceneFrame>
  );
};

/* ============================== CONTRACT (compiled, tested, fingerprinted) ============================== */
const CODE = [
  'pub fn draw(&mut self, amount: U128) {',
  '    let caller = env::predecessor_account_id();',
  '    let now = now_secs();',
  '    let agent = or_abort(self.plan_draw(',
  '        &caller, amount.0, now, Self::available_yocto()));',
  '    self.apply_spend(now, amount.0);',
  '    Event::Drawn {',
  '        agent: agent.clone(),',
  '        amount,',
  '        total_spent: U128(self.usage.total_spent),',
  '    }.emit();',
  '}',
];
export const Contract3: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tCompiled = at('compiled', 0, 0.2), tTested = at('tested', 0, 0.38), tFp = at('fingerprinted', 0, 0.5), tPass = at('pass', 0, 0.62), tOnly = at('only', 0, 0.76), tApproved = at('approved', 0, 0.86);
  const su = (data as any).suites.nearContract; const total = su.passed as number;
  const names = su.sampleTests as string[];
  const compile = ramp(sec, tCompiled - 0.9, 1.0, Easing.linear);
  const run = easeInOut(ramp(sec, tTested - 0.2, Math.max(1.0, tPass - tTested + 0.5), Easing.linear));
  const n = Math.round(total * run);
  const fp = ramp(sec, tFp - 0.1, 0.5);
  const sha = (tn.templateSha as string) ?? '';
  const typed = sha.slice(0, Math.round(sha.length * ramp(sec, tFp, 0.7, Easing.linear)));
  const lock = ramp(sec, tOnly, 0.6); const appr = ramp(sec, tApproved - 0.3, 0.9, Easing.linear);
  const shownLines = Math.round(CODE.length * ramp(sec, 0.1, Math.max(1, tCompiled - 0.2), Easing.linear));
  return (
    <SceneFrame s={s} glow="#10304a">
      <Sfx s={s} name="tick" at={tCompiled} volume={0.35} />
      <Sfx s={s} name="tick" at={tTested} volume={0.35} />
      <Sfx s={s} name="approve" at={tFp + 0.4} volume={0.45} />
      <Sfx s={s} name="approve" at={tApproved + 0.5} volume={0.4} />
      <div style={{ position: 'absolute', left: 96, top: 150, width: 820, opacity: ramp(sec, 0, 0.4) }}>
        <Eyebrow style={{ marginBottom: 10 }}>contracts/near-vault/src/lib.rs · agent draw</Eyebrow>
        <Panel style={{ padding: '22px 26px', height: 470, background: '#0b0f14' }}>
          {CODE.map((l, i) => (
            <div key={i} style={{ fontFamily: F.mono, fontSize: 21, lineHeight: '34px', whiteSpace: 'pre', color: i < shownLines ? (l.includes('fn ') ? C.signal : l.includes('Event') || l.includes('emit') ? C.mineralHi : C.chalk2) : 'transparent' }}>{l}</div>
          ))}
        </Panel>
        <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 18, color: C.chalk2, marginBottom: 8 }}><span>COMPILE → wasm</span><span style={{ color: compile >= 1 ? C.signal : C.warn }}>{compile >= 1 ? 'built' : 'building…'}</span></div>
          <div style={{ height: 10, borderRadius: 99, background: C.ink1 }}><div style={{ height: '100%', width: `${compile * 100}%`, background: compile >= 1 ? C.signal : C.warn, borderRadius: 99 }} /></div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1000, top: 150, width: 824 }}>
        <Eyebrow style={{ marginBottom: 10, opacity: ramp(sec, tTested - 0.4, 0.4) }}>cargo test --locked · measured {su.verifiedOn}</Eyebrow>
        <div style={{ opacity: ramp(sec, tTested - 0.4, 0.4), display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <span style={{ fontFamily: F.display, fontSize: 150, lineHeight: 1, color: run >= 1 ? C.signal : C.chalk }}>{n}</span>
          <span style={{ fontFamily: F.display, fontSize: 60, color: C.chalk3 }}>/ {total} tests pass</span>
        </div>
        <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 18px', opacity: ramp(sec, tTested - 0.2, 0.4) }}>
          {names.slice(0, 6).map((nm, i) => (
            <div key={nm} style={{ fontFamily: F.mono, fontSize: 16, color: run * 8 > i + 1 ? C.signal : C.chalk3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✓ {nm}</div>
          ))}
        </div>
        <div style={{ marginTop: 34, opacity: fp, transform: `translateY(${(1 - fp) * 20}px)` }}>
          <Eyebrow color={C.mineralHi} style={{ marginBottom: 8 }}>fingerprint · sha-256 of the contract</Eyebrow>
          <Panel style={{ padding: '20px 26px', border: `2px solid ${C.mineralHi}88`, background: `${C.mineral}55` }}>
            <div style={{ fontFamily: F.mono, fontSize: 52, letterSpacing: '0.06em', color: C.chalk }}>{typed}<span style={{ color: C.mineralHi, opacity: typed.length < sha.length ? 1 : 0 }}>▍</span>{typed.length >= sha.length ? '…' : ''}</div>
          </Panel>
        </div>
        <div style={{ marginTop: 28, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center', opacity: lock }}>
          <HoldPill fill={appr} label="Owner approves" w={300} />
          <div style={{ fontFamily: F.body, fontSize: 28, fontWeight: 600, color: C.chalk, lineHeight: 1.2 }}>The agent may deploy <span style={{ color: C.signal }}>only</span> this fingerprint.</div>
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== VAULT (free inside the limits, the chain holds the line) ============================== */
export const Vault3: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tLimits = at('limits', 0, 0.12), tOwn = at('own', 0, 0.3), tGas = at('gas', 0, 0.42), tDeploys = at('deploys', 0, 0.52), tLine = at('line', 0, 0.68);
  const refs = tn.refusals as { what: string; code: string; hash: string }[];
  const rt0 = Math.min(Math.max(tLine + 0.2, tDeploys + 1.0), s.durationSec - 0.7 - 0.45 * refs.length);
  const rstep = Math.max(0.45, Math.min(0.9, (s.durationSec - rt0 - 0.7) / refs.length));
  const rt = (i: number) => rt0 + i * rstep;
  const BX = 130, BY = 190, BW = 800, BH = 560; const cx = BX + BW / 2, cy = BY + BH / 2;
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const o = ramp(sec, 0.0, 0.6);
    // the mandate box
    const wall = ramp(sec, tLimits - 0.2, 0.6);
    const flash = refs.reduce((m, _, i) => Math.max(m, Math.exp(-(sec - rt(i) - 0.25) * 5) * (sec > rt(i) + 0.25 ? 1 : 0)), 0);
    ctx.strokeStyle = rgba(flash > 0.05 ? [255, 106, 61] : SG, (0.35 + 0.5 * wall) * o); ctx.lineWidth = 4 + 6 * flash; ctx.setLineDash([22, 12]); ctx.lineDashOffset = -frame * 0.5;
    ctx.beginPath(); ctx.roundRect(BX, BY, BW, BH, 26); ctx.stroke(); ctx.setLineDash([]);
    glow(ctx, cx, cy, 420, SG, 0.07 * wall * o);
    // the agent roams free inside
    const free = ramp(sec, 0.1, 1.0);
    const ax = cx + Math.cos(t * 0.9) * 230 * Math.sin(t * 0.31 + 1) , ay = cy + Math.sin(t * 1.3) * 150;
    for (let k = 14; k > 0; k--) { const tt = t - k * 0.04; const px = cx + Math.cos(tt * 0.9) * 230 * Math.sin(tt * 0.31 + 1), py = cy + Math.sin(tt * 1.3) * 150; ctx.fillStyle = rgba(CY, 0.04 * (15 - k) * free); ctx.beginPath(); ctx.arc(px, py, 10, 0, 6.28); ctx.fill(); }
    glow(ctx, ax, ay, 70, CY, 0.5 * free); ctx.fillStyle = rgba(WH, free); ctx.beginPath(); ctx.arc(ax, ay, 14, 0, 6.28); ctx.fill();
    // gas drops falling into the agent
    const gas = ramp(sec, tGas - 0.2, 0.3);
    if (gas > 0) for (let i = 0; i < 6; i++) { const u = ((t * 0.9 + i / 6) % 1); ctx.fillStyle = rgba([90, 230, 255], 0.8 * gas * Math.sin(u * Math.PI)); ctx.beginPath(); ctx.arc(lerp(cx - 260 + i * 40, ax, u), lerp(BY + 40, ay, u), 5, 0, 6.28); ctx.fill(); }
    // deploy pulse
    const dp = ramp(sec, tDeploys, 0.9); if (dp > 0 && dp < 1) { ctx.strokeStyle = rgba(SG, 1 - dp); ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(ax, ay, 20 + 220 * dp, 0, 6.28); ctx.stroke(); }
    // attempts crossing the line, refused at the wall
    refs.forEach((r, i) => {
      const u = ramp(sec, rt(i) - 0.35, 0.6, Easing.in(Easing.cubic)); if (u <= 0) return;
      const ang = [-0.5, 0.35, -2.6, 2.7][i % 4]; const sx = cx + Math.cos(ang) * 700, sy = cy + Math.sin(ang) * 420;
      const hx = cx + Math.cos(ang) * (BW / 2 + 6) * 1.0, hy = cy + Math.sin(ang) * (BH / 2 + 6) * 1.0;
      const bounce = ramp(sec, rt(i) + 0.25, 0.5);
      const px = lerp(sx, hx, Math.min(u, 1)) + Math.cos(ang) * 160 * bounce, py = lerp(sy, hy, Math.min(u, 1)) + Math.sin(ang) * 160 * bounce;
      ctx.fillStyle = rgba([255, 106, 61], 0.9 * (1 - bounce)); ctx.beginPath(); ctx.arc(px, py, 11, 0, 6.28); ctx.fill();
      if (bounce > 0 && bounce < 0.4) { ctx.strokeStyle = rgba([255, 106, 61], 1 - bounce * 2.5); ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(hx, hy, 18 + 90 * bounce, 0, 6.28); ctx.stroke(); }
    });
  };
  const budget = 0.35 + 0.0 * sec; const drawn = ramp(sec, tGas, 0.8);
  return (
    <SceneFrame s={s} glow="#26330d">
      <Cv draw={draw} />
      {refs.map((_, i) => <Sfx key={i} s={s} name="reject" at={rt(i) + 0.25} volume={0.4} />)}
      <Sfx s={s} name="tick" at={tOwn} volume={0.3} />
      <Sfx s={s} name="tick" at={tDeploys} volume={0.4} />
      <div style={{ position: 'absolute', left: BX + 24, top: BY + 20, display: 'flex', gap: 14, alignItems: 'center', opacity: ramp(sec, tLimits, 0.5) }}>
        <Eyebrow color={C.signal}>limits set by the owner</Eyebrow>
      </div>
      <div style={{ position: 'absolute', left: BX + 28, top: BY + 64, display: 'flex', flexDirection: 'column', gap: 8, opacity: ramp(sec, tLimits, 0.6) }}>
        {['per-draw cap', 'total budget', 'expiry', 'one allowed contract'].map((x, i) => <span key={x} style={{ fontFamily: F.mono, fontSize: 17, color: C.chalk2, opacity: ramp(sec, tLimits + i * 0.18, 0.4) }}>▸ {x}</span>)}
      </div>
      <div style={{ position: 'absolute', left: BX + 24, top: BY + BH - 160, width: 560, opacity: ramp(sec, tOwn - 0.1, 0.5) }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 17, color: C.chalk2, marginBottom: 6 }}><span>OWN BUDGET</span><span style={{ color: C.signal }}>capped</span></div>
        <div style={{ height: 10, borderRadius: 99, background: C.ink1 }}><div style={{ height: '100%', width: `${(0.7 - 0.25 * drawn) * 100}%`, background: C.signal, borderRadius: 99 }} /></div>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.mineralHi, marginTop: 12, opacity: ramp(sec, tGas, 0.4) }}>⛽ gas drawn by the agent</div>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.signal, marginTop: 6, opacity: ramp(sec, tDeploys, 0.4) }}>✓ deployed · {tn.registry}</div>
      </div>
      <div style={{ position: 'absolute', left: 1010, top: 150, width: 814 }}>
        <Eyebrow color={C.risk} style={{ marginBottom: 14, opacity: ramp(sec, rt0 - 0.3, 0.4) }}>the chain said no · {refs.length} times</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {refs.map((r, i) => {
            const o = ramp(sec, rt(i) + 0.2, 0.35);
            return (
              <div key={r.code} style={{ opacity: o, transform: `translateX(${(1 - o) * 40}px)`, display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center', padding: '16px 24px', border: `1px solid ${C.risk}77`, borderRadius: 10, background: `${C.risk}0f` }}>
                <div>
                  <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 28, color: C.chalk }}>{r.what}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, marginTop: 4 }}>{r.code} · tx {r.hash.slice(0, 8)}… on nearblocks (testnet)</div>
                </div>
                <Stamp label="refused" color={C.risk} o={ramp(sec, rt(i) + 0.3, 0.2)} size={20} rot={-3} />
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 130, top: 800, fontFamily: F.mono, fontSize: 16, letterSpacing: '0.06em', color: C.warn }}>PUBLIC NEAR TESTNET · {tn.owner} · DEMO OWNER KEY · AUTOMATED RUN</div>
    </SceneFrame>
  );
};

/* ============================== BRAKE (the owner decides, can stop, a wrong fingerprint is refused) ============================== */
export const Brake: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tDecides = at('decides', 0, 0.1), tStop = at('stop', 0, 0.3), tWrong = at('wrong', 0, 0.55), tRefused = at('refused', 0, 0.72), tBrake = at('brake', 0, 0.94);
  const FW = 860, FH = 700, sc = FW / 860;
  const fill = ramp(sec, tDecides, 0.9, Easing.linear); const approved = fill >= 1;
  const stop = ramp(sec, tStop, 0.5);
  const ring = ramp(sec, tBrake - 0.8, 0.8);
  return (
    <SceneFrame s={s} glow="#26330d">
      <Sfx s={s} name="approve" at={tDecides + 0.9} volume={0.5} />
      <Sfx s={s} name="warn" at={tStop} volume={0.35} />
      <Sfx s={s} name="reject" at={tRefused - 0.2} volume={0.5} />
      <Sfx s={s} name="approve" at={tBrake} volume={0.4} />
      <div style={{ position: 'absolute', left: 96, top: 130, width: FW, height: FH, borderRadius: 18, border: `2px solid ${approved ? C.signal : C.lineHi}`, overflow: 'hidden', background: C.ink1, boxShadow: `0 30px 80px #000000aa, 0 0 ${approved ? 70 : 30}px ${approved ? C.signal : C.mineralHi}33`, opacity: ramp(sec, 0, 0.5) }}>
        <Img src={staticFile('app/redesign-approvals-1440.png')} style={{ position: 'absolute', left: 0, top: 0, width: 1440 * sc }} />
        <div style={{ position: 'absolute', left: 117 * sc, top: 424 * sc, width: 155 * sc, height: 47 * sc, borderRadius: 99, overflow: 'hidden', border: `2px solid ${C.signal}`, background: C.ink1 }}>
          <div style={{ position: 'absolute', inset: 0, background: C.signal, width: `${fill * 100}%`, opacity: 0.9 }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: F.body, fontWeight: 700, fontSize: 18 * sc, whiteSpace: 'nowrap', color: fill > 0.55 ? C.signalInk : C.chalk }}>{approved ? 'Approved' : 'Hold to approve'}</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1020, top: 130, width: 804, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ opacity: ramp(sec, tDecides - 0.1, 0.4) }}>
          <Panel style={{ padding: '18px 26px', border: `2px solid ${approved ? C.signal : C.line}` }}>
            <div style={{ fontFamily: F.display, fontSize: 48, color: C.chalk, lineHeight: 1 }}>The owner decides</div>
            <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6 }}>exact request · exact scope · expiry</div>
          </Panel>
        </div>
        <div style={{ opacity: ramp(sec, tStop - 0.2, 0.4), display: 'flex', alignItems: 'center', gap: 22 }}>
          <div style={{ padding: '14px 34px', borderRadius: 99, border: `3px solid ${stop > 0.9 ? C.risk : C.warn}`, color: stop > 0.9 ? C.risk : C.warn, fontFamily: F.body, fontWeight: 800, fontSize: 30, letterSpacing: '0.08em', background: stop > 0.9 ? `${C.risk}18` : 'transparent', transform: `scale(${1 - 0.06 * Math.sin(stop * 3.14)})` }}>{stop > 0.9 ? 'STOPPED' : 'STOP'}</div>
          <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, lineHeight: 1.4 }}>pause or revoke the budget<br />at any time</div>
        </div>
        <div style={{ opacity: ramp(sec, tWrong - 0.3, 0.4) }}>
          <Panel style={{ position: 'relative', padding: '18px 26px', border: `2px solid ${ramp(sec, tRefused - 0.1, 0.2) > 0.5 ? C.risk : C.line}` }}>
            <Eyebrow color={C.risk} style={{ marginBottom: 10 }}>receipt check</Eyebrow>
            <div style={{ fontFamily: F.mono, fontSize: 21, color: C.risk, display: 'flex', gap: 12, alignItems: 'center' }}><span style={{ fontWeight: 700 }}>✕</span> on-chain code hash = attested wasm sha256</div>
            <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6 }}>wrong hash → not recorded</div>
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 16, opacity: ramp(sec, tRefused + 0.5, 0.4) }}>
              <span style={{ fontFamily: F.mono, fontSize: 21, color: C.signal }}><b>✓</b> matching hash → recorded</span>
            </div>
            <div style={{ position: 'absolute', right: 30, top: 24 }}><Stamp label="refused" color={C.risk} o={ramp(sec, tRefused - 0.1, 0.2)} size={26} rot={-4} /></div>
          </Panel>
        </div>
        <div style={{ position: 'relative', height: 150, opacity: ramp(sec, tBrake - 0.8, 0.5) }}>
          <div style={{ position: 'absolute', left: 80, top: 70, transform: 'translate(-50%,-50%) scale(0.45)' }}><Ring r={160} color={C.signal} closing={ring} /></div>
          <div style={{ position: 'absolute', left: 200, top: 38, fontFamily: F.display, fontSize: 64, color: C.chalk, fontStyle: 'italic' }}>That is the brake.</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 96, top: 868, fontFamily: F.mono, fontSize: 16, letterSpacing: '0.06em', color: C.warn }}>RECORDED RUN · MOCKED NEAR RPC · FIXTURE INPUTS (app screenshot: demo data)</div>
    </SceneFrame>
  );
};

/* ============================== CLOSE (public demand in, a product on the table, a human on the brake) ============================== */
export const Close3: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tNext = at('Next', 0, 0.02), tCommunity = at('community', 0, 0.12), tLive = at('live.', 0, 0.3), tName = at('AutoNEAR:', 0, 0.4), tDemand = at('demand', 0, 0.5), tProduct = at('product', 0, 0.62), tHuman = at('human', 0, 0.74), tJudges = at('Judges:', 0, 0.88);
  const repo = (meta as any).repoUrl as string | null;
  const pts = React.useMemo(() => dotSphere(420, 21), []);
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const cx = 1500, cy = 330; const a = easeOut(ramp(sec, tName - 0.4, 1.4));
    glow(ctx, cx, cy, 460, VI, 0.15 * a); glow(ctx, cx, cy, 260, MG, 0.12 * a);
    drawSphere(ctx, pts, cx, cy, 130, t * 0.35, 0.4, a, frame);
    (prod.council as any[]).forEach((o, k) => {
      const ang = -Math.PI / 2 + (k / 7) * 6.2832 + t * 0.05; const x = cx + Math.cos(ang) * 250, y = cy + Math.sin(ang) * 200;
      line(ctx, cx, cy, x, y, CY, 0.2 * a, 1.2); glow(ctx, x, y, 28, o.id === prod.winner.id ? SG : CY, 0.5 * a); ctx.fillStyle = rgba(WH, a); ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 6.28); ctx.fill();
    });
  };
  const line1 = ramp(sec, tDemand - 0.1, 0.45), line2 = ramp(sec, tProduct - 0.1, 0.45), line3 = ramp(sec, tHuman - 0.1, 0.45);
  const brake = ramp(sec, tHuman, 0.9, Easing.linear);
  const st = (data as any).suites;
  const tiles: [string, string, string][] = [
    [`${prod.sourcesOk}/${prod.sourcesTotal}`, 'sources live', C.signal],
    [String(prod.evidence), 'posts and commits read', C.mineralHi],
    [String(st.nearContract.passed), 'contract tests pass', C.warn],
    [String(tn.refusalCount), 'chain refusals on testnet', C.risk],
  ];
  return (
    <SceneFrame s={s} glow="#26330d">
      <Cv draw={draw} />
      <Sfx s={s} name="tick" at={tNext} volume={0.3} />
      <Sfx s={s} name="approve" at={tName} volume={0.4} />
      <Sfx s={s} name="approve" at={tJudges} volume={0.5} />
      <div style={{ position: 'absolute', left: 120, top: 92, display: 'flex', alignItems: 'center', gap: 22, opacity: ramp(sec, tName - 0.2, 0.5) }}>
        <Brand size={72} /><span style={{ fontFamily: F.display, fontSize: 92, color: C.chalk, letterSpacing: '-0.02em' }}>AutoNEAR</span>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 230, width: 1100 }}>
        <div style={{ fontFamily: F.display, fontSize: 104, lineHeight: 1.04, color: C.chalk, opacity: line1, transform: `translateX(${(1 - line1) * -40}px)` }}>Public demand in.</div>
        <div style={{ fontFamily: F.display, fontSize: 104, lineHeight: 1.04, color: C.chalk, opacity: line2, transform: `translateX(${(1 - line2) * -40}px)` }}>A product on the table.</div>
        <div style={{ fontFamily: F.display, fontStyle: 'italic', fontSize: 104, lineHeight: 1.04, color: C.signal, opacity: line3, transform: `translateX(${(1 - line3) * -40}px)` }}>A human on the brake.</div>
      </div>
      <div style={{ position: 'absolute', left: 1240, top: 560, opacity: ramp(sec, tHuman - 0.1, 0.5) }}><HoldPill fill={brake} label="Hold to approve" w={360} /></div>
      {/* the next gate, shown as next */}
      <div style={{ position: 'absolute', left: 120, top: 640, opacity: ramp(sec, tNext, 0.5) }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 16, padding: '14px 26px', border: `2px dashed ${C.mineralHi}`, borderRadius: 14, background: `${C.mineral}33` }}>
          <span style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.12em', color: C.mineralHi }}>NEXT</span>
          <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 30, color: C.chalk }}>community tests every build, then it goes live</span>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 770, opacity: ramp(sec, tJudges, 0.5), transform: `translateY(${(1 - ramp(sec, tJudges, 0.5)) * 20}px)` }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <span style={{ fontFamily: F.mono, fontSize: 30, color: C.signalInk, background: C.signal, padding: '12px 24px', borderRadius: 8, fontWeight: 600 }}>npm test</span>
          <span style={{ fontFamily: F.mono, fontSize: 26, color: C.chalk2 }}>{repo ? repo.replace(/^https?:\/\//, '') : 'repo link in this post'}</span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.08em', color: C.chalk3, marginTop: 14, maxWidth: 820, lineHeight: 1.4 }}>{(meta as any).mention} {(meta as any).hashtags} · {(meta as any).track}</div>
      </div>
      <div style={{ position: 'absolute', left: 1000, top: 770, display: 'flex', gap: 14 }}>
        {tiles.map(([n, l, c], i) => {
          const o = ramp(sec, tDemand + i * 0.15, 0.5);
          return <div key={l} style={{ opacity: o, transform: `translateY(${(1 - o) * 16}px)` }}><Panel style={{ padding: '10px 16px', width: 200, height: 112 }}><div style={{ fontFamily: F.display, fontSize: 48, lineHeight: 1, color: c }}>{n}</div><div style={{ fontFamily: F.mono, fontSize: 14, color: C.chalk2, marginTop: 5, lineHeight: 1.25 }}>{l}</div></Panel></div>;
        })}
      </div>
    </SceneFrame>
  );
};
