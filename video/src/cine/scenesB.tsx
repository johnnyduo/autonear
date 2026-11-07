import React from 'react';
import { Img, staticFile } from 'remotion';
import { C, F, H, W } from '../theme';
import { data, meta, prod, tn, type CScene } from './timeline';
import { Cv, glow as glowDot, line as drawLine, rgba, CY, MG, SG, WH } from '../scenes/v3lib';
import { HoldPill } from '../scenes/v3a';
import { Swarm as SwarmV3 } from '../scenes/v3b';
import { Glass, KText, NEON, StretchWord, Tag, Wipe, cl, eio, eoExpo, lerp, rp } from './kinetic';
import { hash, useCine } from './hooks';
import { project, seatAngle } from './stage';
import { Sfx, Stamp } from '../components';

const center: React.CSSProperties = { position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center' };
const hex = (c: number[]) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const STANCE: Record<string, number[]> = { back: [90, 255, 210], abstain: [247, 184, 77], object: [255, 64, 128] };
const VERD: Record<string, number[]> = { go: SG, watch: [247, 184, 77], drop: [140, 145, 153] };

/* ======================= 6 · COUNCIL ======================= */
export const Council: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at, st } = useCine(s);
  const tSeven = at('Seven', 0, 0.1), tSkep = at('skeptic,', 0, 0.3), tRepeat = at('repeats', 0, 0.6), tToday = at('Today,', 0, 0.8), tGo = at('go.', 0, 0.95);
  const all = prod.council as any[]; const winner = all.find((o) => o.id === prod.winner.id);
  const others = all.filter((o) => o.id !== winner.id).sort((a, b) => a.support - b.support);
  const seats = prod.seatNames as { label: string }[];
  const t0 = tSeven - 0.15, winStart = Math.max(t0 + 6 * 0.5, tGo - 1.05);
  const slot = (winStart - t0) / 6;
  const cycles: { start: number; opp: any; dt: number }[] = others.map((o, i) => ({ start: t0 + i * slot, opp: o, dt: Math.min(0.085, slot / 9) }));
  cycles.push({ start: winStart, opp: winner, dt: 0.1 });
  const ord = [...others, winner];
  for (let n = 0; n < 12; n++) cycles.push({ start: tGo + 1.4 + n * 0.8, opp: ord[n % 7], dt: 0.07 });
  let idx = -1; cycles.forEach((c, i) => { if (sec >= c.start) idx = i; });
  const cur = idx >= 0 ? cycles[idx] : null;
  const fireT = (c: { start: number; dt: number }, k: number) => c.start + 0.1 + k * c.dt;
  let Ssum = 0; if (cur) cur.opp.votes.forEach((v: any, k: number) => { if (sec >= fireT(cur, k)) Ssum += v.weight * v.support; });
  const fired = cur ? sec >= fireT(cur, 6) + 0.05 : false;
  const vc = cur ? VERD[cur.opp.verdict] : CY;
  const ctr = project(st, [0, 0, 0]);
  const seatP = seats.map((_, k) => project(st, [Math.cos(seatAngle(k)) * 3.1, 0, Math.sin(seatAngle(k)) * 3.1]));
  const labP = seats.map((_, k) => project(st, [Math.cos(seatAngle(k)) * 4.0, 0, Math.sin(seatAngle(k)) * 4.0]));
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    seats.forEach((_, k) => {
      const p = seatP[k]; let f = -9, stance = 'back'; if (cur) { f = sec - fireT(cur, k); stance = cur.opp.votes[k]?.stance ?? 'back'; }
      const col = STANCE[stance] ?? STANCE.back; const hot = f >= 0 && f < 0.6;
      if (f >= 0) { const b = Math.exp(-f * 4); drawLine(ctx, p.x, p.y, ctr.x, ctr.y, col, 0.12 + 0.88 * b, 2 + 6 * b); }
      glowDot(ctx, p.x, p.y, hot ? 80 : 44, f >= 0 ? col : CY, f >= 0 ? 0.6 : 0.35);
      ctx.fillStyle = rgba(WH, 1); ctx.beginPath(); ctx.arc(p.x, p.y, k === 2 && sec > tSkep ? 13 : 8, 0, 6.28); ctx.fill();
      if (k === 2 && sec > tSkep - 0.1 && sec < tSkep + 2.4) { ctx.strokeStyle = rgba(MG, 0.95); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 30 + 8 * Math.sin(frame * 0.3), 0, 6.28); ctx.stroke(); }
    });
    const R = 120 * ctr.s / 180; ctx.lineWidth = 12; ctx.strokeStyle = rgba(WH, 0.1); ctx.beginPath(); ctx.arc(ctr.x, ctr.y, 175, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = rgba(fired ? vc : CY, 0.95); ctx.beginPath(); ctx.arc(ctr.x, ctr.y, 175, -Math.PI / 2, -Math.PI / 2 + 6.2832 * cl(Ssum)); ctx.stroke();
    const ga = -Math.PI / 2 + 6.2832 * prod.goAt; ctx.strokeStyle = rgba(WH, 0.95); ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(ctr.x + Math.cos(ga) * 158, ctr.y + Math.sin(ga) * 158); ctx.lineTo(ctr.x + Math.cos(ga) * 196, ctr.y + Math.sin(ga) * 196); ctx.stroke();
    void R;
  };
  const events: { t: number; txt: string; color: string; bold?: boolean }[] = [];
  cycles.forEach((c) => { c.opp.votes.forEach((v: any, k: number) => { const t = fireT(c, k); if (sec >= t) events.push({ t, txt: `${c.opp.short.padEnd(9)} ${v.label.padEnd(9)} ${v.support.toFixed(2)}`, color: hex(STANCE[v.stance] ?? STANCE.back) }); }); const tv = fireT(c, 6) + 0.18; if (sec >= tv) events.push({ t: tv, txt: `→ ${c.opp.short.toUpperCase()} ${c.opp.verdict.toUpperCase()} ${(c.opp.support * 100).toFixed(0)}`, color: hex(VERD[c.opp.verdict]), bold: true }); });
  const shown = events.sort((a, b) => b.t - a.t).slice(0, 11);
  const goP = rp(sec, tGo - 0.05, 0.35, eoExpo); const goOut = eio((sec - tGo - 1.0) / 0.8);
  return (
    <>
      {cycles.slice(0, 7).map((c, i) => <Sfx key={i} s={s as any} name="tick" at={fireT(c, 6)} volume={0.16} />)}<Sfx s={s as any} name="approve" at={tGo} volume={0.6} />
      <Cv draw={draw} />
      {seats.map((seat, k) => <div key={k} style={{ position: 'absolute', left: labP[k].x, top: labP[k].y, transform: 'translate(-50%,-50%)', fontFamily: F.mono, fontSize: 21, letterSpacing: '0.12em', color: k === 2 && sec > tSkep ? NEON.mg : C.chalk2, fontWeight: k === 2 ? 700 : 400, opacity: rp(sec, tSeven - 0.2, 0.5) }}>{seat.label.toUpperCase()}</div>)}
      {sec > tSkep - 0.1 && sec < tSkep + 2.4 && <div style={{ position: 'absolute', left: seatP[2].x + 46, top: seatP[2].y + 20, fontFamily: F.mono, fontSize: 19, color: NEON.mg, background: 'rgba(10,12,15,0.85)', border: '1px solid #ff38c866', borderRadius: 8, padding: '6px 12px', opacity: rp(sec, tSkep - 0.1, 0.3) }}>tries to break every idea</div>}
      {cur && <div key={cur.opp.id + idx} style={{ position: 'absolute', left: ctr.x - 500, width: 1000, top: 96, display: 'flex', justifyContent: 'center' }}><KText text={cur.opp.short.toUpperCase()} sec={sec - cur.start} at={0} size={150} grad={fired ? [hex(vc), '#ffffff'] : ['#ffffff', NEON.cy]} dur={0.35} stagger={0.02} /></div>}
      <div style={{ position: 'absolute', left: ctr.x, top: ctr.y, transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
        <div style={{ fontFamily: F.kinetic, fontWeight: 900, fontSize: 96, lineHeight: 1, color: fired ? hex(vc) : C.chalk, fontVariationSettings: "'wdth' 115" }}>{Math.round(Ssum * 100)}</div>
        <div style={{ fontFamily: F.mono, fontSize: 16, letterSpacing: '0.12em', color: C.chalk3 }}>NEEDS {Math.round(prod.goAt * 100)}</div>
      </div>
      <StretchWord text="GO" cx={ctr.x} cy={ctr.y} size={520} from={360} to={880} p={goP} opacity={cl(goP * 2) * (1 - goOut)} fill={NEON.lime} glow={NEON.lime} echo={3} wght={900} />
      {sec > tGo + 0.5 && <div style={{ ...center, top: 880, opacity: rp(sec, tGo + 0.5, 0.4) }}><Stamp label={`${prod.winner.word} · GO`} color={NEON.lime} o={1} size={34} rot={-3} /></div>}
      <div style={{ position: 'absolute', left: 1420, top: 170, width: 440, opacity: rp(sec, tSeven, 0.5) }}>
        <Tag color={NEON.lime} style={{ marginBottom: 10 }}>council stream</Tag>
        <Glass style={{ padding: '10px 16px', height: 480, overflow: 'hidden' }}>
          {shown.map((e, i) => <div key={e.t + '-' + i} style={{ fontFamily: F.mono, fontSize: 17, lineHeight: '38px', whiteSpace: 'pre', color: e.color, opacity: Math.max(0.12, 1 - i * 0.08), fontWeight: e.bold ? 700 : 400 }}>{e.txt}</div>)}
        </Glass>
      </div>
      <div style={{ position: 'absolute', left: 100, top: 880, fontFamily: F.mono, fontSize: 18, letterSpacing: '0.1em', color: C.chalk2, opacity: rp(sec, tRepeat, 0.5) }}>↻ {prod.opportunities} ideas · {prod.seats} seats · repeats with every new record</div>
      <Tag color={C.chalk3} style={{ position: 'absolute', left: 100, top: 160, opacity: rp(sec, 0.1, 0.4) }}>{void tToday}the council</Tag>
    </>
  );
};

/* ======================= 7 · SWARM (the recorded build flow, tilted into the cinematic camera) ======================= */
export const Swarm: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tSwarm = at('swarm.', 0, 0.1); const e = rp(sec, tSwarm - 0.2, 1.2, eoExpo);
  return (
    <>
      <StretchWord text="SWARM" cx={960} cy={500} size={700} from={900} to={1850} p={rp(sec, tSwarm - 0.2, 2.5, eio)} opacity={0.13 * e} fill="none" stroke={NEON.white} wght={900} />
      <div style={{ position: 'absolute', inset: 0, transform: `perspective(1800px) rotateY(${lerp(-14, -3, e)}deg) rotateX(${lerp(8, 1, e)}deg) translateX(${lerp(-80, 0, e)}px) scale(${lerp(0.9, 1, e)})`, transformOrigin: '40% 50%' }}>
        <SwarmV3 s={s as any} />
      </div>
    </>
  );
};

/* ======================= 8 · CONTRACT ======================= */
const CODE = ['pub fn draw(&mut self, amount: U128) {', '  let caller = env::predecessor_account_id();', '  let now = now_secs();', '  let agent = or_abort(self.plan_draw(', '    &caller, amount.0, now, available()));', '  self.apply_spend(now, amount.0);', '  Event::Drawn { agent, amount }.emit();', '}'];
export const Contract: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tComp = at('compiled,', 0, 0.2), tTest = at('tested', 0, 0.3), tFp = at('fingerprint.', 0, 0.45), tPass = at('pass.', 0, 0.7), tOnly = at('only', 0, 0.82);
  const su = (data as any).suites.nearContract; const total = su.passed as number;
  const lines = Math.round(CODE.length * rp(sec, 0.1, Math.max(1, tComp - 0.3), (t) => t));
  const run = rp(sec, tTest - 0.2, Math.max(1, tPass - tTest + 0.4), (t) => t);
  const n = Math.round(total * eio(run)); const sha = (tn.templateSha as string) ?? '';
  const typed = sha.slice(0, Math.round(sha.length * rp(sec, tFp, 0.8, (t) => t)));
  const appr = rp(sec, tOnly - 0.2, 1.0, (t) => t);
  const stage = sec < tTest - 0.1 ? 'COMPILED' : sec < tFp - 0.1 ? 'TESTED' : sec < tOnly - 0.1 ? 'FINGERPRINTED' : 'APPROVED';
  const stageAt0 = sec < tTest - 0.1 ? tComp - 0.5 : sec < tFp - 0.1 ? tTest - 0.1 : sec < tOnly - 0.1 ? tFp - 0.2 : tOnly - 0.1;
  return (
    <>
      <Sfx s={s as any} name="tick" at={tComp} volume={0.35} /><Sfx s={s as any} name="tick" at={tTest} volume={0.35} /><Sfx s={s as any} name="approve" at={tFp + 0.4} volume={0.45} /><Sfx s={s as any} name="approve" at={tOnly + 0.9} volume={0.4} />
      <div style={{ position: 'absolute', left: 90, top: 190, width: 540, opacity: rp(sec, 0, 0.5) }}>
        <Tag color={C.chalk3} style={{ marginBottom: 12 }}>near-vault · agent draw</Tag>
        <Glass style={{ padding: '18px 22px', background: 'rgba(8,12,18,0.82)' }}>{CODE.map((l, i) => <div key={i} style={{ fontFamily: F.mono, fontSize: 17, lineHeight: '30px', whiteSpace: 'pre', color: i < lines ? (l.includes('fn ') ? NEON.lime : l.includes('Event') ? NEON.cy : C.chalk2) : 'transparent' }}>{l}</div>)}</Glass>
        <div style={{ marginTop: 22, height: 8, borderRadius: 99, background: 'rgba(255,255,255,0.1)' }}><div style={{ height: '100%', width: `${rp(sec, tComp - 1.0, 1.0, (t) => t) * 100}%`, background: NEON.lime, borderRadius: 99, boxShadow: `0 0 14px ${NEON.lime}` }} /></div>
        <div style={{ fontFamily: F.mono, fontSize: 16, color: C.chalk2, marginTop: 8 }}>COMPILE → wasm</div>
      </div>
      <div style={{ position: 'absolute', left: 1330, top: 170, width: 500 }}>
        <div style={{ opacity: rp(sec, tTest - 0.4, 0.4), fontFamily: F.mono, fontSize: 16, color: C.chalk3, letterSpacing: '0.1em' }}>cargo test --locked · measured {su.verifiedOn}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, opacity: rp(sec, tTest - 0.4, 0.4) }}>
          <span style={{ fontFamily: F.kinetic, fontWeight: 900, fontSize: 190, lineHeight: 1, color: run >= 1 ? NEON.lime : C.chalk, fontVariationSettings: "'wdth' 110" }}>{n}</span>
          <span style={{ fontFamily: F.display, fontSize: 48, color: C.chalk3 }}>/ {total} pass</span>
        </div>
        <div style={{ marginTop: 30, opacity: rp(sec, tFp - 0.1, 0.5), transform: `translateY(${(1 - rp(sec, tFp - 0.1, 0.5)) * 20}px)` }}>
          <Tag color={NEON.cy} style={{ marginBottom: 10 }}>fingerprint · sha-256</Tag>
          <Glass edge={`${NEON.cy}88`} style={{ padding: '16px 22px' }}><div style={{ fontFamily: F.mono, fontSize: 44, letterSpacing: '0.05em', color: C.chalk }}>{typed}<span style={{ color: NEON.cy, opacity: typed.length < sha.length ? 1 : 0 }}>▍</span>{typed.length >= sha.length ? '…' : ''}</div></Glass>
        </div>
        <div style={{ marginTop: 28, opacity: rp(sec, tOnly - 0.2, 0.5) }}><HoldPill fill={appr} label="Owner approves" w={420} /></div>
      </div>
      <div key={stage} style={{ ...center, top: 800 }}><KText text={stage} sec={sec - stageAt0} at={0} size={118} grad={stage === 'APPROVED' ? [NEON.lime, NEON.white] : [NEON.white, NEON.cy]} glow="#26e6ff44" stagger={0.03} /></div>
    </>
  );
};

/* ======================= 9 · VAULT ======================= */
const REFUSALS = ['OVER THE CAP', 'TOO MANY DEPLOYS', 'WRONG TEMPLATE', 'MANDATE PAUSED'];
export const Vault: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tOwn = at('own,', 0, 0.12), tGas = at('gas', 0, 0.22), tDeploys = at('deploys', 0, 0.3), tOut = at('out-of-bounds', 0, 0.42);
  const rt = [0, 1, 2, 3].map((i) => at('Refused.', i, 0.55 + i * 0.12));
  const refs = tn.refusals as { what: string; code: string; hash: string }[];
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30; const free = rp(sec, 0.1, 0.8);
    const cx = 960, cy = 540;
    for (let k = 16; k > 0; k--) { const tt = t - k * 0.035; const px = cx + Math.cos(tt * 1.1) * 400, py = cy + Math.sin(tt * 1.1) * 150 + Math.sin(tt * 2.2) * 30; ctx.fillStyle = rgba(CY, 0.045 * (17 - k) * free); ctx.beginPath(); ctx.arc(px, py, 9, 0, 6.28); ctx.fill(); }
    const ax = cx + Math.cos(t * 1.1) * 400, ay = cy + Math.sin(t * 1.1) * 150 + Math.sin(t * 2.2) * 30;
    glowDot(ctx, ax, ay, 70, CY, 0.6 * free); ctx.fillStyle = rgba(WH, free); ctx.beginPath(); ctx.arc(ax, ay, 13, 0, 6.28); ctx.fill();
    const gas = rp(sec, tGas - 0.2, 0.3); if (gas > 0) for (let i = 0; i < 6; i++) { const u = (t * 0.9 + i / 6) % 1; ctx.fillStyle = rgba([90, 230, 255], 0.8 * gas * Math.sin(u * 3.14)); ctx.beginPath(); ctx.arc(lerp(ax - 200 + i * 50, ax, u), lerp(ay - 220, ay, u), 5, 0, 6.28); ctx.fill(); }
    const dp = rp(sec, tDeploys, 0.9, (x) => x); if (dp > 0 && dp < 1) { ctx.strokeStyle = rgba(SG, 1 - dp); ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(ax, ay, 20 + 200 * dp, 0, 6.28); ctx.stroke(); }
    rt.forEach((r, i) => { const u = (sec - (r - 0.45)) / 0.45; if (u < 0 || u > 1.6) return; const ang = [-0.5, 0.4, -2.6, 2.7][i]; const sx = cx + Math.cos(ang) * 900, sy = cy + Math.sin(ang) * 500; const hx = cx + Math.cos(ang) * 420, hy = cy + Math.sin(ang) * 230; const p = Math.min(1, u); const b = Math.max(0, u - 1);
      ctx.fillStyle = rgba([255, 106, 61], 0.95 * (1 - b)); ctx.beginPath(); ctx.arc(lerp(sx, hx, p) + Math.cos(ang) * 200 * b, lerp(sy, hy, p) + Math.sin(ang) * 200 * b, 12, 0, 6.28); ctx.fill();
      if (u > 1 && u < 1.5) { ctx.strokeStyle = rgba([255, 106, 61], 1 - (u - 1) * 2); ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(hx, hy, 20 + 120 * (u - 1), 0, 6.28); ctx.stroke(); } });
  };
  return (
    <>
      {rt.map((r, i) => <Sfx key={i} s={s as any} name="reject" at={r} volume={0.55} />)}<Sfx s={s as any} name="tick" at={tOwn} volume={0.3} /><Sfx s={s as any} name="tick" at={tDeploys} volume={0.35} />
      <Cv draw={draw} />
      <div style={{ position: 'absolute', left: 90, top: 170, width: 430 }}>
        <Tag color={NEON.lime} style={{ opacity: rp(sec, 0.1, 0.4) }}>limits set by the owner</Tag>
        {['per-draw cap', 'total budget', 'expiry', 'one allowed contract'].map((x, i) => <Glass key={x} style={{ marginTop: 12, padding: '12px 20px', opacity: rp(sec, 0.3 + i * 0.15, 0.4), transform: `translateX(${(1 - rp(sec, 0.3 + i * 0.15, 0.4)) * -30}px)`, fontFamily: F.mono, fontSize: 21, color: C.chalk }}>▸ {x}</Glass>)}
        <div style={{ marginTop: 26, fontFamily: F.mono, fontSize: 18, color: NEON.cy, opacity: rp(sec, tGas - 0.1, 0.4) }}>⛽ gas drawn by the agent</div>
        <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 18, color: NEON.lime, opacity: rp(sec, tDeploys, 0.4) }}>✓ approved code deployed</div>
      </div>
      <div style={{ position: 'absolute', left: 1380, top: 170, width: 460 }}>
        <Tag color={NEON.risk} style={{ opacity: rp(sec, tOut - 0.3, 0.4) }}>chain refusals · testnet</Tag>
        {refs.map((r, i) => { const o = rp(sec, rt[i] + 0.05, 0.3, eoExpo); return (
          <Glass key={r.code} edge={`${NEON.risk}88`} style={{ marginTop: 12, padding: '12px 18px', opacity: o, transform: `translateX(${(1 - o) * 50}px)` }}>
            <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 24, color: C.chalk }}>{r.what}</div>
            <div style={{ fontFamily: F.mono, fontSize: 15, color: C.chalk2, marginTop: 3 }}>{r.code} · tx {r.hash.slice(0, 8)}…</div>
          </Glass>); })}
      </div>
      {rt.map((r, i) => { const u = sec - r; if (u < -0.9 || u > 1.5) return null; const p = rp(sec, r - 0.05, 0.3, eoExpo); const out = eio((u - 0.5) / 0.9);
        return <React.Fragment key={i}>
          <div style={{ ...center, top: 96, opacity: rp(sec, r - 0.9, 0.3) * (1 - out) }}><KText text={REFUSALS[i]} sec={sec} at={r - 0.85} size={52} wght={500} wdth={130} spacing={8} color={C.chalk2} mode="rise" /></div>
          <StretchWord text="REFUSED" cx={960} cy={540} size={330} from={380} to={1700} p={p} opacity={cl(p * 2) * (1 - out)} fill={NEON.risk} glow={NEON.risk} echo={2} wght={900} />
        </React.Fragment>; })}
      <div style={{ position: 'absolute', left: 90, top: 880, fontFamily: F.mono, fontSize: 16, letterSpacing: '0.08em', color: C.warn }}>PUBLIC NEAR TESTNET · {tn.owner} · DEMO OWNER KEY · AUTOMATED RUN</div>
    </>
  );
};

/* ======================= 10 · BRAKE ======================= */
export const Brake: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tFinal = at('final', 0, 0.1), tHold = at('Hold', 0, 0.3), tPause = at('Pause', 0, 0.5), tWrong = at('wrong', 0, 0.68), tRef = at('refused.', 0, 0.82), tBrake = at('brake.', 0, 0.96);
  const fill = rp(sec, tHold, 1.1, (t) => t); const ok = fill >= 1;
  const stop = rp(sec, tPause, 0.5); const refP = rp(sec, tRef - 0.1, 0.25, eoExpo);
  const circ = 2 * Math.PI * 190;
  return (
    <>
      <Sfx s={s as any} name="approve" at={tHold + 1.1} volume={0.5} /><Sfx s={s as any} name="warn" at={tPause} volume={0.35} /><Sfx s={s as any} name="reject" at={tRef - 0.15} volume={0.5} />
      <div style={{ ...center, top: 135 }}><KText text="THE OWNER HAS THE FINAL WORD" sec={sec} at={tFinal - 0.3} size={86} grad={[NEON.white, NEON.cy]} stagger={0.03} /></div>
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
        <circle cx={960} cy={540} r={190} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={12} />
        <circle cx={960} cy={540} r={190} fill="none" stroke={ok ? NEON.lime : NEON.cy} strokeWidth={14} strokeLinecap="round" strokeDasharray={`${circ * fill} ${circ}`} transform="rotate(-90 960 540)" style={{ filter: `drop-shadow(0 0 16px ${ok ? NEON.lime : NEON.cy})` }} />
      </svg>
      <div style={{ position: 'absolute', left: 760, top: 470, width: 400, textAlign: 'center' }}>
        <KText text={ok ? 'APPROVED' : 'HOLD'} sec={sec - (ok ? tHold + 1.0 : tHold - 0.2)} at={0} size={ok ? 48 : 84} wght={900} grad={ok ? [NEON.lime, '#ffffff'] : ['#ffffff', NEON.cy]} align="center" style={{ justifyContent: 'center' }} stagger={0.03} />
      </div>
      <div style={{ position: 'absolute', left: 90, top: 250, width: 560, height: 420, borderRadius: 18, overflow: 'hidden', border: `2px solid ${ok ? NEON.lime : 'rgba(255,255,255,0.2)'}`, opacity: rp(sec, tFinal, 0.6), transform: `perspective(1400px) rotateY(12deg)`, boxShadow: '0 30px 80px rgba(0,0,0,.6)' }}>
        <Img src={staticFile('app/redesign-approvals-1440.png')} style={{ position: 'absolute', left: -30, top: -120, width: 1440 * 0.5 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent 60%, #05070b 100%)' }} />
      </div>
      <div style={{ position: 'absolute', left: 1290, top: 250, width: 540, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ opacity: stop }}>
          <Glass edge={`${stop > 0.9 ? NEON.risk : NEON.warn}aa`} style={{ padding: '18px 28px', display: 'flex', alignItems: 'center', gap: 20 }}>
            <span style={{ fontFamily: F.kinetic, fontWeight: 900, fontSize: 52, color: stop > 0.9 ? NEON.risk : NEON.warn, fontVariationSettings: "'wdth' 120" }}>{stop > 0.9 ? 'PAUSED' : 'PAUSE'}</span>
            <span style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, lineHeight: 1.35 }}>pause or revoke<br />at any moment</span>
          </Glass>
        </div>
        <div style={{ opacity: rp(sec, tWrong - 0.3, 0.4) }}>
          <Glass edge={refP > 0.5 ? `${NEON.risk}aa` : undefined} style={{ position: 'relative', padding: '20px 28px' }}>
            <Tag color={NEON.risk} style={{ marginBottom: 10 }}>receipt check</Tag>
            <div style={{ fontFamily: F.mono, fontSize: 21, color: NEON.risk }}>✕ on-chain code hash ≠ attested sha256</div>
            <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6 }}>wrong fingerprint → refused</div>
            <div style={{ position: 'absolute', right: 24, top: 18 }}><Stamp label="refused" color={NEON.risk} o={refP} size={24} rot={-4} /></div>
          </Glass>
        </div>
      </div>
      <div style={{ ...center, top: 790, opacity: rp(sec, tBrake - 0.8, 0.5) }}><KText text="A HUMAN ON THE BRAKE" sec={sec} at={tBrake - 0.7} size={96} grad={[NEON.lime, '#ffffff']} glow="#c6f43244" stagger={0.035} /></div>
      <div style={{ position: 'absolute', left: 90, top: 700, fontFamily: F.mono, fontSize: 15, letterSpacing: '0.06em', color: C.warn }}>RECORDED RUN · MOCKED NEAR RPC · FIXTURE INPUTS (app screenshot: demo data)</div>
    </>
  );
};

/* ======================= 11 · COMMUNITY (roadmap) ======================= */
export const Community: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at, st } = useCine(s);
  const tNext = at('Next,', 0, 0.02), tJoin = at('joins', 0, 0.3), tTest = at('test', 0, 0.5), tConf = at('confirm', 0, 0.7), tLive = at('live.', 0, 0.92);
  const c0 = project(st, [0, 0, 0]);
  const NP = 28;
  const draw = (ctx: CanvasRenderingContext2D, frame: number) => {
    const t = frame / 30;
    for (let i = 0; i < NP; i++) {
      const a = (i / NP) * 6.2832 + t * 0.1; const x = c0.x + Math.cos(a) * 560, y = c0.y + 40 + Math.sin(a) * 190;
      const show = rp(sec, tJoin - 0.2 + i * 0.03, 0.4); if (show <= 0) continue;
      const tested = sec > tTest + i * 0.04; const conf = sec > tConf + i * 0.035;
      glowDot(ctx, x, y, 34, conf ? SG : tested ? CY : MG, 0.5 * show);
      ctx.fillStyle = rgba(WH, show); ctx.beginPath(); ctx.arc(x, y, 7, 0, 6.28); ctx.fill();
      if (conf) { ctx.strokeStyle = rgba(SG, 0.95); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 7, y - 20); ctx.lineTo(x - 2, y - 14); ctx.lineTo(x + 8, y - 28); ctx.stroke(); }
    }
  };
  const gate = rp(sec, tLive - 0.1, 0.8, eio);
  return (
    <>
      <Sfx s={s as any} name="tick" at={tTest} volume={0.35} /><Sfx s={s as any} name="approve" at={tConf + 0.3} volume={0.45} /><Sfx s={s as any} name="whoosh" at={tLive} volume={0.5} />
      <Cv draw={draw} />
      <div style={{ ...center, top: 110, opacity: rp(sec, tNext, 0.5) }}><span style={{ display: 'inline-flex', gap: 14, alignItems: 'center', padding: '10px 24px', border: `2px dashed ${NEON.cy}`, borderRadius: 14, background: 'rgba(38,230,255,0.08)', fontFamily: F.mono, fontSize: 22, letterSpacing: '0.16em', color: NEON.cy }}>NEXT · ON THE ROADMAP</span></div>
      <div style={{ ...center, top: 190 }}><KText text="THE COMMUNITY" sec={sec} at={tJoin - 0.4} size={170} grad={[NEON.white, NEON.mg]} glow="#ff38c844" stagger={0.045} /></div>
      <div style={{ position: 'absolute', left: 140, top: 760, opacity: rp(sec, tTest - 0.1, 0.4) }}><KText text="TESTS" sec={sec} at={tTest - 0.1} size={130} grad={[NEON.cy, NEON.white]} /></div>
      <div style={{ position: 'absolute', right: 140, top: 760, opacity: rp(sec, tConf - 0.1, 0.4) }}><KText text="CONFIRMS" sec={sec} at={tConf - 0.1} size={130} grad={[NEON.lime, NEON.white]} /></div>
      <div style={{ ...center, top: 830, opacity: rp(sec, tLive - 0.9, 0.5) }}><div style={{ width: 760, height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.14)', position: 'relative' }}><div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${gate * 100}%`, background: NEON.lime, borderRadius: 99, boxShadow: `0 0 18px ${NEON.lime}` }} /><div style={{ position: 'absolute', right: -90, top: -18, fontFamily: F.mono, fontSize: 20, color: gate >= 1 ? NEON.lime : C.chalk2, letterSpacing: '0.12em' }}>{gate >= 1 ? 'LIVE' : 'GATE'}</div></div></div>
    </>
  );
};

/* ======================= 12 · CLOSE ======================= */
export const Close: React.FC<{ s: CScene }> = ({ s }) => {
  const { sec, at } = useCine(s);
  const tName = at('AutoNEAR.', 0, 0.02), tPub = at('Public', 0, 0.12), tProd = at('product', 0, 0.35), tHum = at('human', 0, 0.55), tJudges = at('Judges,', 0, 0.75);
  const repo = (meta as any).repoUrl as string | null; const st2 = (data as any).suites;
  const lines: [string, number, [string, string]][] = [['PUBLIC SIGNALS IN', tPub, [NEON.white, NEON.cy]], ['A PRODUCT YOU CAN INSPECT', tProd, [NEON.white, NEON.mg]], ['A HUMAN ON THE BRAKE', tHum, [NEON.lime, NEON.white]]];
  const fin = rp(sec, tJudges - 0.1, 0.6); const linesOut = tJudges - 0.15;
  const tiles: [string, string, string][] = [[`${prod.sourcesOk}/${prod.sourcesTotal}`, 'sources live', NEON.lime], [String(prod.evidence), 'records read', NEON.cy], [String(st2.nearContract.passed), 'contract tests pass', NEON.warn], [String(tn.refusalCount), 'chain refusals on testnet', NEON.risk]];
  return (
    <>
      <Sfx s={s as any} name="approve" at={tName} volume={0.5} /><Sfx s={s as any} name="approve" at={tJudges} volume={0.55} />
      <div style={{ ...center, top: 70, alignItems: 'baseline', gap: 4 }}>
        <KText text="AUTO" sec={sec} at={tName - 0.1} size={230} wght={200} wdth={85} color={C.chalk} stagger={0.06} />
        <KText text="NEAR" sec={sec} at={tName + 0.15} size={230} wght={900} grad={[NEON.lime, NEON.cy]} glow="#c6f43255" stagger={0.06} />
      </div>
      {lines.map(([t, ta, g], i) => <div key={t} style={{ ...center, top: 640 + i * 100 }}><KText text={t} sec={sec} at={ta - 0.1} size={78} grad={g} out={linesOut} stagger={0.03} /></div>)}
      <div style={{ ...center, top: 560, flexDirection: 'column', alignItems: 'center', opacity: fin }}>
        <KText text="CLONE IT. RUN THE TESTS." sec={sec} at={tJudges - 0.1} size={116} grad={[NEON.lime, NEON.cy]} glow="#26e6ff44" stagger={0.03} />
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', marginTop: 34 }}>
          <span style={{ fontFamily: F.mono, fontSize: 32, color: C.signalInk, background: NEON.lime, padding: '12px 26px', borderRadius: 8, fontWeight: 600 }}>npm test</span>
          <span style={{ fontFamily: F.mono, fontSize: 28, color: C.chalk }}>{repo ? repo.replace(/^https?:\/\//, '') : 'repo link in this post'}</span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.08em', color: C.chalk3, marginTop: 16 }}>{(meta as any).mention} {(meta as any).hashtags} · {(meta as any).track}</div>
      </div>
      {tiles.map(([n, l, c], i) => { const o = rp(sec, tJudges + 0.1 + i * 0.12, 0.5); const left = i < 2; return (
        <div key={l} style={{ position: 'absolute', [left ? 'left' : 'right']: 90, top: 270 + (i % 2) * 150, opacity: o, transform: `translateX(${(1 - o) * (left ? -40 : 40)}px)` }}>
          <Glass style={{ padding: '14px 22px', width: 270 }}><div style={{ fontFamily: F.kinetic, fontWeight: 900, fontSize: 64, lineHeight: 1, color: c, fontVariationSettings: "'wdth' 115" }}>{n}</div><div style={{ fontFamily: F.mono, fontSize: 15, color: C.chalk2, marginTop: 5 }}>{l}</div></Glass>
        </div>); })}
    </>
  );
};
export { hash, H, Wipe };
