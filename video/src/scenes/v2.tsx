import React from 'react';
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Brand, Eyebrow, Panel, SceneFrame, Sfx, Stamp, SyncedText, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';
import meta from '../../script/meta.json';

const ROLE_NAME: Record<string, string> = {
  signal_collector: 'Signal Collector', evidence_analyst: 'Evidence Analyst', skeptic: 'Skeptic', product_architect: 'Product Architect',
  builder: 'Builder', security_reviewer: 'Security Reviewer', launch_planner: 'Launch Planner',
};
const inOut = Easing.inOut(Easing.cubic);

/* ---------- motif: the company card and the boundary ring ---------- */
export const CompanyCard: React.FC<{ w?: number; fill?: number; lit?: boolean; tilt?: number }> = ({ w = 380, fill = 0.35, lit = false, tilt = 0 }) => {
  const h = w * 0.63;
  return (
    <div style={{ position: 'relative', width: w, height: h, transform: `rotate(${tilt}deg)` }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: w * 0.055, background: `linear-gradient(135deg, ${C.ink3}, ${C.ink1})`, border: `2px solid ${lit ? C.signal : C.lineHi}`, boxShadow: lit ? `0 0 60px ${C.signal}33` : '0 10px 40px #00000066' }} />
      <div style={{ position: 'absolute', left: w * 0.07, top: h * 0.14, width: w * 0.15, height: h * 0.2, borderRadius: 8, border: `2px solid ${C.warn}`, background: `${C.warn}22` }} />
      <div style={{ position: 'absolute', right: w * 0.07, top: h * 0.14 }}><Brand size={w * 0.13} /></div>
      <div style={{ position: 'absolute', left: w * 0.07, top: h * 0.5, fontFamily: F.mono, fontSize: w * 0.052, letterSpacing: '0.18em', color: C.chalk2 }}>AUTONEAR AGENT</div>
      <div style={{ position: 'absolute', left: w * 0.07, right: w * 0.07, bottom: h * 0.12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: w * 0.045, color: C.chalk3, marginBottom: 6 }}><span>LIMIT SET BY OWNER</span><span style={{ color: C.signal }}>{Math.round(fill * 100) >= 0 ? 'CAPPED' : ''}</span></div>
        <div style={{ height: w * 0.025, borderRadius: 99, background: C.ink0 }}><div style={{ height: '100%', width: `${fill * 100}%`, background: C.signal, borderRadius: 99 }} /></div>
      </div>
    </div>
  );
};

export const Ring: React.FC<{ r: number; color?: string; slit?: number; slitAngle?: number; closing?: number }> = ({ r, color = C.signal, slit = 0, slitAngle = 200, closing = 1 }) => {
  const frame = useCurrentFrame();
  const circ = 2 * Math.PI * r;
  const size = r * 2 + 40;
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} style={{ overflow: 'visible' }}>
      <circle r={r} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth="3" strokeDasharray={`${circ * 0.18 * closing + 6} 14`} strokeDashoffset={-frame * 0.8} />
      <circle r={r} fill="none" stroke={color} strokeOpacity={0.9} strokeWidth="5" strokeDasharray={`${circ * closing} ${circ}`} transform={`rotate(-90)`} opacity={closing > 0.98 ? 0.4 : 0.9} />
      {slit > 0 && <circle r={r} fill="none" stroke={C.risk} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${circ * 0.06} ${circ}`} transform={`rotate(${slitAngle})`} opacity={slit} />}
    </svg>
  );
};

/* ============================== NIGHT ============================== */
export const Night: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tLights = at('lights', 0, 0.12), tSpend = at('spend', 0, 0.45), tCard = at('card?', 0, 0.8);
  const screen = ramp(sec, tLights - 0.15, 0.4);
  const note = ramp(sec, tLights + 0.25, 0.45);
  const shake = Math.sin(sec * 60) * 4 * (1 - ramp(sec, tLights + 0.25, 0.4)) * ramp(sec, tLights - 0.1, 0.05);
  return (
    <SceneFrame s={s} glow="#1a2a3a">
      <Sfx s={s} name="tick" at={tLights + 0.2} volume={0.55} />
      <Sfx s={s} name="warn" at={tSpend} volume={0.35} />
      <Sfx s={s} name="tick" at={tCard} volume={0.5} />
      <div style={{ position: 'absolute', left: 250, top: 110, width: 420, height: 800, borderRadius: 60, border: `3px solid ${C.lineHi}`, background: `linear-gradient(${C.ink0}, ${C.ink1})`, boxShadow: `0 0 ${80 * screen}px ${C.mineralHi}33`, transform: `translateX(${shake}px)`, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse at 50% 20%, ${C.mineral}, transparent 70%)`, opacity: screen }} />
        <div style={{ position: 'absolute', top: 120, width: '100%', textAlign: 'center', fontFamily: F.display, fontSize: 130, color: C.chalk, opacity: 0.35 + 0.65 * screen }}>00:00</div>
        <div style={{ position: 'absolute', top: 280, left: 22, right: 22, opacity: note, transform: `translateY(${(1 - note) * -40}px)` }}>
          <Panel style={{ padding: '18px 20px', borderColor: C.warn, boxShadow: `0 0 30px ${C.warn}33` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}><Brand size={34} /><Eyebrow style={{ fontSize: 17 }}>AutoNEAR agent</Eyebrow></div>
            <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 31, color: C.chalk, lineHeight: 1.15 }}>Your agent wants to spend</div>
            <div style={{ fontFamily: F.mono, fontSize: 17, color: C.chalk2, marginTop: 10 }}>NEAR testnet · waiting for you</div>
          </Panel>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 820, top: 150, width: 980 }}>
        <SyncedText s={s} size={78} italic={['card?']} accent={C.signal} />
      </div>
      <div style={{ position: 'absolute', left: 1180, top: 640, opacity: ramp(sec, tCard - 0.2, 0.5), transform: `translateY(${(1 - ramp(sec, tCard - 0.2, 0.5)) * 26}px)` }}>
        <CompanyCard w={340} fill={0.4} />
      </div>
    </SceneFrame>
  );
};

/* ============================== POISON ============================== */
export const Poison: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tUseful = at('useful', 0, 0.1), tHidden = at('Hidden', 0, 0.32), tTrap = at('trap', 0, 0.85);
  const post = ramp(sec, 0.2, 0.5);
  const hostileIn = ramp(sec, tHidden + 0.1, 0.4);
  const t0 = tHidden + 0.9, travel = 0.9;
  const p = interpolate(sec, [t0, t0 + travel], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: inOut });
  const hit = sec >= t0 + travel;
  const slit = hit ? Math.max(0, 1 - (sec - (t0 + travel)) / 0.9) : 0;
  const drop = ramp(sec, t0 + travel + 0.1, 0.5);
  const chipX = interpolate(p, [0, 1], [330, 1090]) + (hit ? 0 : 0);
  const chipY = interpolate(p, [0, 1], [455, 410]) + drop * 360;
  const text = String(data.hostile.text);
  const chipText = text.length > 36 ? text.slice(0, 33).trimEnd() + '…' : text;
  const ringShake = hit ? Math.sin(sec * 80) * 5 * slit : 0;
  return (
    <SceneFrame s={s} glow={hit ? '#5a2410' : '#3a2a14'}>
      <Sfx s={s} name="tick" at={tUseful} volume={0.35} />
      <Sfx s={s} name="reject" at={t0 + travel + 0.05} volume={0.6} />
      <div style={{ position: 'absolute', left: 120, top: 250, width: 760, opacity: post, transform: `translateY(${(1 - post) * 24}px)` }}>
        <Panel style={{ padding: '24px 28px' }}>
          <Eyebrow style={{ marginBottom: 16 }}>Public post · GitHub issue</Eyebrow>
          <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 30, color: C.chalk, marginBottom: 14 }}>Feature request: treasury rebalancing tools</div>
          <div style={{ height: 13, width: '90%', background: C.ink3, borderRadius: 4, marginBottom: 11 }} />
          <div style={{ height: 13, width: '68%', background: C.ink3, borderRadius: 4, marginBottom: 22 }} />
          <div style={{ fontFamily: F.mono, fontSize: 22, lineHeight: 1.4, color: C.risk, opacity: hostileIn * (p > 0.02 ? 0.25 : 1), borderTop: `1px dashed ${C.risk}66`, paddingTop: 16 }}>“{text}”</div>
        </Panel>
      </div>
      {/* the agent and its boundary ring */}
      <div style={{ position: 'absolute', left: 1330, top: 160, width: 400, height: 520, transform: `translateX(${ringShake}px)` }}>
        <div style={{ position: 'absolute', left: 200, top: 250, transform: 'translate(-50%,-50%)' }}><Ring r={185} color={C.signal} slit={slit} slitAngle={190} /></div>
        <svg style={{ position: 'absolute', left: 0, top: 50, width: 400, height: 400 }} viewBox="-200 -200 400 400">
          <circle r="104" fill={C.ink2} stroke={C.mineralHi} strokeWidth="2" />
          <polygon points="0,-52 45,-26 45,26 0,52 -45,26 -45,-26" fill="none" stroke={C.signal} strokeWidth="3" />
          <circle r="9" fill={C.signal} />
        </svg>
        <div style={{ position: 'absolute', top: 470, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 20, letterSpacing: '0.12em', color: C.chalk3 }}>AGENT · INSIDE THE LIMITS</div>
      </div>
      {/* the hostile instruction travelling to the ring, then falling into the tray */}
      {p > 0.01 && (
        <div style={{ position: 'absolute', left: chipX, top: chipY, transform: `translate(-50%,-50%) rotate(${(1 - p) * -4 + drop * 6}deg)`, opacity: 1 - 0.4 * drop }}>
          <div style={{ fontFamily: F.mono, fontSize: 20, color: C.risk, border: `2px solid ${C.risk}`, background: `${C.risk}18`, borderRadius: 8, padding: '10px 16px', whiteSpace: 'nowrap', boxShadow: `0 0 30px ${C.risk}55` }}>{chipText}</div>
        </div>
      )}
      <div style={{ position: 'absolute', left: 1010, top: 690, width: 740, opacity: ramp(sec, t0 + travel, 0.4) }}>
        <Panel style={{ padding: '16px 24px', borderStyle: 'dashed', borderColor: C.risk, minHeight: 120 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Eyebrow color={C.risk}>Withheld from model prompts</Eyebrow>
            <Stamp label="withheld" color={C.risk} o={ramp(sec, t0 + travel + 0.5, 0.3)} size={22} />
          </div>
        </Panel>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 700, fontFamily: F.display, fontSize: 70, color: C.chalk, opacity: ramp(sec, tTrap - 0.1, 0.4) }}>That is <em style={{ color: C.risk }}>the trap.</em></div>
    </SceneFrame>
  );
};

/* ============================== OWNER (real app screenshots, demo data) ============================== */
const SHOTS = [
  { file: 'app/redesign-landing-1440.png', label: 'Landing' },
  { file: 'app/redesign-watch-1440.png', label: 'Watch' },
  { file: 'app/redesign-vault-1440.png', label: 'Vault' },
];
export const Owner: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tName = at('AutoNEAR', 0, 0.1), tWatch = at('watches', 0, 0.38), tLimit = at('limit,', 0, 0.62), tStop = at('stop', 0, 0.86);
  const idx = sec < tWatch - 0.6 ? 0 : sec < tLimit - 0.5 ? 1 : 2;
  const FW = 1000, FH = 740, scale = FW / 1440;
  const items = [
    { k: 'Watch', sub: 'what it reads', t: tWatch, c: C.mineralHi },
    { k: 'Limits', sub: 'what it may spend', t: tLimit, c: C.signal },
    { k: 'Stop', sub: 'one tap, any time', t: tStop, c: C.risk },
  ];
  const hl = (y0: number, y1: number, c: string, o: number) => (
    <div style={{ position: 'absolute', left: 14, right: 14, top: y0 * scale, height: (y1 - y0) * scale, border: `3px solid ${c}`, borderRadius: 12, boxShadow: `0 0 40px ${c}55`, opacity: o }} />
  );
  return (
    <SceneFrame s={s}>
      <Sfx s={s} name="tick" at={tName} volume={0.4} />
      {items.map((it) => <Sfx key={it.k} s={s} name="tick" at={it.t} volume={0.35} />)}
      <div style={{ position: 'absolute', left: 110, top: 180, width: 600 }}>
        <div style={{ fontFamily: F.display, fontSize: 100, lineHeight: 1, color: C.chalk, opacity: ramp(sec, 0.1, 0.5) }}>Here is <em style={{ color: C.signal }}>AutoNEAR.</em></div>
        <div style={{ marginTop: 54, display: 'flex', flexDirection: 'column', gap: 22 }}>
          {items.map((it) => {
            const o = ramp(sec, it.t - 0.1, 0.4);
            return (
              <div key={it.k} style={{ opacity: 0.25 + 0.75 * o, transform: `translateX(${(1 - o) * -30}px)`, borderLeft: `5px solid ${o > 0.5 ? it.c : C.line}`, paddingLeft: 24 }}>
                <div style={{ fontFamily: F.display, fontSize: 72, lineHeight: 1, color: o > 0.5 ? it.c : C.chalk2 }}>{it.k}</div>
                <div style={{ fontFamily: F.mono, fontSize: 21, color: C.chalk3, marginTop: 6, letterSpacing: '0.06em' }}>{it.sub}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 820, top: 120, width: FW, height: FH, borderRadius: 18, border: `2px solid ${C.lineHi}`, overflow: 'hidden', background: C.ink1, boxShadow: `0 30px 80px #000000aa, 0 0 80px ${C.mineralHi}22`, opacity: ramp(sec, 0.15, 0.5), transform: `translateY(${(1 - ramp(sec, 0.15, 0.5)) * 30}px)` }}>
        {SHOTS.map((sh, i) => (
          <Img key={sh.file} src={staticFile(sh.file)} style={{ position: 'absolute', left: 0, top: 0, width: FW, opacity: idx === i ? 1 : 0 }} />
        ))}
        {idx === 2 && hl(448, 805, C.signal, ramp(sec, tLimit, 0.3) * (sec < tStop - 0.1 ? 1 : 0.25))}
        {idx === 2 && hl(822, 1003, C.risk, ramp(sec, tStop, 0.3))}
      </div>
    </SceneFrame>
  );
};

/* ============================== COUNCIL ============================== */
export const Council: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const done = (data.run.events as any[]).filter((e) => e.status === 'completed');
  const tWeigh = at('weighs', 0, 0.15), tSeven = at('Seven', 0, 0.38), tCheck = at('check', 0, 0.68), tLeave = at('leave', 0, 0.78);
  const t1 = Math.max(tSeven + 1.2, tCheck + 0.8);
  const rowT = (i: number) => tSeven + (i / Math.max(1, done.length - 1)) * (t1 - tSeven);
  const d = data.decision as any;
  const req = ramp(sec, tLeave, 0.5);
  return (
    <SceneFrame s={s}>
      {done.map((_, i) => <Sfx key={i} s={s} name="tick" at={rowT(i)} volume={0.25} />)}
      <Sfx s={s} name="approve" at={tLeave + 0.2} volume={0.4} />
      <div style={{ position: 'absolute', left: 96, top: 150, width: 960 }}>
        <Eyebrow style={{ marginBottom: 16, opacity: ramp(sec, tWeigh - 0.2, 0.4) }}>Council · published rules, no model opinion · {data.run.roleCount} roles · hash-linked log {data.run.auditChainOk ? 'verified' : 'BROKEN'}</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {done.map((e, i) => {
            const o = ramp(sec, rowT(i), 0.35);
            return (
              <div key={e.role} style={{ display: 'grid', gridTemplateColumns: '34px 290px 1fr', gap: 16, alignItems: 'start', opacity: o, transform: `translateX(${(1 - o) * -26}px)`, padding: '10px 18px', border: `1px solid ${C.line}`, borderRadius: 8, background: `${C.ink1}ee` }}>
                <span style={{ marginTop: 8, width: 16, height: 16, borderRadius: 99, background: C.signal, boxShadow: `0 0 12px ${C.signal}88` }} />
                <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 27, color: C.chalk }}>{ROLE_NAME[e.role] ?? e.role}</span>
                <span style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, lineHeight: 1.35 }}>{String(e.detail).slice(0, 78)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1130, top: 250, width: 694, opacity: req, transform: `translateY(${(1 - req) * 40}px) scale(${0.96 + 0.04 * req})` }}>
        <Eyebrow color={C.warn} style={{ marginBottom: 14 }}>Request waiting for the owner</Eyebrow>
        <Panel style={{ padding: '26px 30px', borderColor: C.warn, boxShadow: `0 0 50px ${C.warn}2a` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span style={{ fontFamily: F.display, fontSize: 46, color: C.chalk, lineHeight: 1 }}>Publish the registry</span>
            <span style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: '0.1em', padding: '5px 14px', borderRadius: 6, color: C.warn, background: `${C.warn}22`, border: `1px solid ${C.warn}` }}>PENDING</span>
          </div>
          {[['action', 'deploy_testnet'], ['network', d.chain], ['max spend', d.maxSpend], ['expires', `${d.expiryHours}h (default)`]].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 21, padding: '9px 0', borderTop: `1px solid ${C.line}` }}>
              <span style={{ color: C.chalk3 }}>{k}</span><span style={{ color: k === 'max spend' ? C.signal : C.chalk }}>{v}</span>
            </div>
          ))}
        </Panel>
      </div>
    </SceneFrame>
  );
};

/* ============================== APPROVAL ============================== */
export const Approval: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tReview = at('reviews', 0, 0.1), tHold = at('holds', 0, 0.3), tDecision = at('decision.', 0, 0.55), tChecks = at('checks.', 0, 0.82);
  const FW = 940, FH = 740, sc = FW / 860; // crop: only the cards column (left 860px of the 1440px screenshot), shown larger
  const holdDur = Math.max(1.0, Math.min(1.6, tDecision - tHold));
  const fill = ramp(sec, tHold, holdDur, Easing.linear);
  const approved = fill >= 1;
  const attempts = (data.attempts as any[]).filter((a) => a.rejected);
  const rows = attempts.slice(0, 7);
  const step2 = ramp(sec, tChecks - 0.9, 0.5);
  return (
    <SceneFrame s={s}>
      <Sfx s={s} name="tick" at={tReview} volume={0.35} />
      <Sfx s={s} name="approve" at={tHold + holdDur} volume={0.55} />
      <Sfx s={s} name="tick" at={tChecks - 0.8} volume={0.4} />
      {rows.map((_, i) => <Sfx key={i} s={s} name="reject" at={tReview + 0.3 + i * 0.35} volume={0.22} />)}
      <div style={{ position: 'absolute', left: 96, top: 120, width: FW, height: FH, borderRadius: 18, border: `2px solid ${approved ? C.signal : C.lineHi}`, overflow: 'hidden', background: C.ink1, boxShadow: `0 30px 80px #000000aa, 0 0 ${approved ? 70 : 30}px ${approved ? C.signal : C.mineralHi}33`, opacity: ramp(sec, 0.1, 0.5) }}>
        <Img src={staticFile('app/redesign-approvals-1440.png')} style={{ position: 'absolute', left: 0, top: 0, width: 1440 * sc }} />
        <div style={{ position: 'absolute', left: 117 * sc, top: 424 * sc, width: 155 * sc, height: 47 * sc, borderRadius: 99, overflow: 'hidden', border: `2px solid ${C.signal}`, background: C.ink1 }}>
          <div style={{ position: 'absolute', inset: 0, background: C.signal, width: `${fill * 100}%`, opacity: 0.9 }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: F.body, fontWeight: 700, fontSize: 18 * sc, whiteSpace: 'nowrap', color: fill > 0.55 ? C.signalInk : C.chalk }}>{approved ? 'Approved' : 'Hold to approve'}</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1100, top: 120, width: 724 }}>
        <Eyebrow color={C.risk} style={{ marginBottom: 12, opacity: ramp(sec, tReview - 0.1, 0.4) }}>{attempts.length} wrong tries, rejected first</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {rows.map((a, i) => {
            const o = ramp(sec, tReview + 0.3 + i * 0.35, 0.3);
            return (
              <div key={a.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 18px', border: `1px solid ${C.line}`, borderRadius: 8, background: `${C.ink1}ee`, opacity: o, transform: `translateX(${(1 - o) * 30}px)` }}>
                <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 25, color: C.chalk }}>{a.label}</span>
                <Stamp label="rejected" color={C.risk} o={ramp(sec, tReview + 0.45 + i * 0.35, 0.2)} size={18} rot={-3} />
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 34, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ border: `2px solid ${approved ? C.signal : C.line}`, borderRadius: 12, padding: '16px 24px', background: approved ? `${C.signal}12` : C.ink1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><div style={{ fontFamily: F.display, fontSize: 42, color: C.chalk, lineHeight: 1 }}>1 · The owner decides</div><div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6 }}>exact request · exact phrase · named signer</div></div>
            <Stamp label="approved" color={C.signal} o={approved ? 1 : 0} size={20} rot={2} />
          </div>
          <div style={{ border: `2px solid ${step2 > 0.5 ? C.mineralHi : C.line}`, borderRadius: 12, padding: '16px 24px', background: C.ink1, opacity: 0.3 + 0.7 * step2 }}>
            <div style={{ fontFamily: F.display, fontSize: 42, color: C.chalk, lineHeight: 1 }}>2 · The checks still run</div>
            <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6 }}>approval is not execution · nothing is deployed yet</div>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== REFUSAL (wrong build refused, then the matching one) ============================== */
const Check: React.FC<{ name: string; ok: boolean; info?: boolean; o: number }> = ({ name, ok, info, o }) => {
  const color = info ? C.warn : ok ? C.chalk : C.risk;
  const short = info ? 'human confirms the contract account’s full-access keys' : name.replace('on-chain code hash == attested wasm sha256', 'on-chain code hash = attested wasm sha256');
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontFamily: F.mono, fontSize: 19, height: 28, opacity: o, transform: `translateX(${(1 - o) * -16}px)`, color }}>
      <span style={{ width: 22, height: 22, borderRadius: 5, display: 'grid', placeItems: 'center', background: info ? `${C.warn}22` : ok ? `${C.signal}22` : `${C.risk}22`, color: info ? C.warn : ok ? C.signal : C.risk, fontWeight: 700, fontSize: 16 }}>{info ? 'i' : ok ? '✓' : '✕'}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{short}</span>
    </div>
  );
};

export const Refusal: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const v = data.verification as any;
  const tFlow = at('result', 0, 0.08), tBad = at('wrong', 0, 0.2), tRefuse = at('refuses', 0, 0.5), tGood = at('matching', 0, 0.82);
  const good = v.goodChecks as { name: string; ok: boolean; info?: boolean }[];
  const bad = v.badChecks as { name: string; ok: boolean }[];
  const failed = (v.badFailed ?? []) as { name: string; detail: string }[];
  const step = Math.max(0.05, Math.min(0.12, (s.durationSec - tGood - 0.6) / good.length));
  const doneAt = tGood + good.length * step;
  const badO = ramp(sec, tBad, 0.4);
  const passN = bad.filter((c) => c.ok && !(c as any).info).length, totalN = bad.filter((c) => !(c as any).info).length;
  const flow = [['A result comes back', 'a deployment on testnet'], ['AutoNEAR verifies', 'against the approved request']];
  return (
    <SceneFrame s={s}>
      {good.map((_, i) => <Sfx key={`g${i}`} s={s} name="tick" at={tGood + i * step} volume={0.12} />)}
      <Sfx s={s} name="approve" at={doneAt + 0.05} volume={0.55} />
      <Sfx s={s} name="reject" at={tRefuse + 0.1} volume={0.6} />
      <div style={{ position: 'absolute', left: 96, top: 150, display: 'flex', gap: 18, alignItems: 'center' }}>
        {flow.map(([a, b], i) => (
          <React.Fragment key={a}>
            <div style={{ opacity: ramp(sec, tFlow + i * 0.4, 0.4), border: `1px solid ${C.lineHi}`, borderRadius: 10, padding: '12px 24px', background: C.ink1 }}>
              <div style={{ fontFamily: F.display, fontSize: 38, color: C.chalk, lineHeight: 1 }}>{a}</div>
              <div style={{ fontFamily: F.mono, fontSize: 17, color: C.chalk3, marginTop: 4 }}>{b}</div>
            </div>
            {i < flow.length - 1 && <span style={{ color: C.chalk3, fontFamily: F.mono, fontSize: 30 }}>→</span>}
          </React.Fragment>
        ))}
      </div>
      {/* wrong build */}
      <div style={{ position: 'absolute', left: 96, top: 290, width: 684 }}>
        <Eyebrow color={C.risk} style={{ marginBottom: 12, opacity: badO }}>Wrong code · hash 1111…</Eyebrow>
        <Panel style={{ padding: '26px 30px', minHeight: 500, position: 'relative', borderColor: badO > 0.1 ? `${C.risk}88` : C.line, opacity: 0.2 + 0.8 * badO, transform: `translateY(${(1 - badO) * 20}px)` }}>
          <div style={{ fontFamily: F.display, fontSize: 96, lineHeight: 1, color: C.chalk }}>{passN}<span style={{ color: C.chalk3 }}> / {totalN}</span></div>
          <div style={{ fontFamily: F.mono, fontSize: 20, color: C.chalk2, marginTop: 6 }}>checks pass</div>
          {failed.map((f) => (
            <div key={f.name} style={{ marginTop: 26, border: `2px solid ${C.risk}`, borderRadius: 10, padding: '16px 20px', background: `${C.risk}12`, opacity: ramp(sec, tBad + 0.5, 0.35) }}>
              <div style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 700, color: C.risk }}>✕ {f.name.replace('==', '=')}</div>
              <div style={{ fontFamily: F.mono, fontSize: 16, color: C.chalk2, marginTop: 8, wordBreak: 'break-all', lineHeight: 1.35 }}>{f.detail}</div>
            </div>
          ))}
          <div style={{ position: 'absolute', left: 30, bottom: 26, fontFamily: F.mono, fontSize: 19, color: C.chalk2, opacity: ramp(sec, tRefuse + 0.5, 0.3) }}>this attempt: nothing recorded</div>
          <div style={{ position: 'absolute', right: 30, bottom: 70 }}><Stamp label="refused" color={C.risk} o={ramp(sec, tRefuse, 0.3)} size={28} rot={-4} /></div>
        </Panel>
      </div>
      {/* matching build */}
      <div style={{ position: 'absolute', left: 814, top: 290, width: 1010 }}>
        <Eyebrow color={C.signal} style={{ marginBottom: 12, opacity: ramp(sec, tGood - 0.2, 0.4) }}>Matching code · {good.filter((c) => !c.info).length} checks</Eyebrow>
        <Panel style={{ padding: '14px 26px 58px', position: 'relative', borderColor: ramp(sec, tGood, 0.3) > 0.1 ? `${C.signal}88` : C.line, opacity: 0.2 + 0.8 * ramp(sec, tGood - 0.3, 0.4) }}>
          {good.map((c, i) => <Check key={c.name} name={c.name} ok={c.ok} info={c.info} o={ramp(sec, tGood + i * step, 0.2)} />)}
          <div style={{ position: 'absolute', left: 26, bottom: 20, fontFamily: F.mono, fontSize: 19, color: C.chalk2, opacity: ramp(sec, doneAt + 0.1, 0.3) }}>decision → {data.decision.finalStatus}</div>
          <div style={{ position: 'absolute', right: 26, bottom: 14 }}><Stamp label="recorded" color={C.signal} o={ramp(sec, doneAt, 0.3)} size={28} rot={3} /></div>
        </Panel>
      </div>
      <div style={{ position: 'absolute', left: 96, top: 868, fontFamily: F.mono, fontSize: 19, letterSpacing: '0.06em', color: C.warn, opacity: 0.8 }}>
        MOCKED NEAR RPC · FIXTURE BUILD ATTESTATION · THIS PART IS A RECORDED REPLAY
      </div>
    </SceneFrame>
  );
};

/* ============================== TESTNET (real public-testnet run, demo owner key) ============================== */
export const Testnet: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tn = (data as any).testnet;
  const tRan = at('testnet.', 0, 0.12), tCapped = at('capped', 0, 0.3), tDeployed = at('deployed', 0, 0.5);
  const steps = [
    { t: tRan, k: 'Owner sets up a vault', sub: `${tn.vault}`, c: C.mineralHi },
    { t: tCapped, k: 'Owner caps the agent', sub: 'per-draw cap · total · expiry · one allowed contract', c: C.signal },
    { t: tCapped + 0.9, k: 'Vault locked', sub: 'no access keys: its code cannot be swapped', c: C.signal },
    { t: tDeployed, k: 'Agent deploys through the vault', sub: `${tn.registry}`, c: C.signal },
  ];
  const refs = tn.refusals as { what: string; code: string; hash: string }[];
  const rt0 = Math.max(tDeployed + 0.6, tCapped + 1.6);
  const rstep = Math.max(0.4, Math.min(0.85, (s.durationSec - rt0 - 0.6) / Math.max(1, refs.length)));
  const rt = (i: number) => rt0 + i * rstep;
  return (
    <SceneFrame s={s}>
      {steps.map((st, i) => <Sfx key={i} s={s} name="tick" at={st.t} volume={0.3} />)}
      {refs.map((_, i) => <Sfx key={`r${i}`} s={s} name="reject" at={rt(i) + 0.1} volume={0.4} />)}
      <div style={{ position: 'absolute', left: 96, top: 150, width: 800 }}>
        <Eyebrow style={{ marginBottom: 14 }}>{tn.network} · owner {tn.owner}</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {steps.map((st, i) => {
            const o = ramp(sec, st.t - 0.1, 0.4);
            return (
              <div key={st.k} style={{ opacity: 0.15 + 0.85 * o, transform: `translateX(${(1 - o) * -30}px)`, display: 'grid', gridTemplateColumns: '44px 1fr', gap: 18, alignItems: 'start', padding: '16px 22px', border: `1px solid ${o > 0.5 ? st.c + '88' : C.line}`, borderRadius: 10, background: C.ink1 }}>
                <span style={{ width: 34, height: 34, borderRadius: 99, display: 'grid', placeItems: 'center', background: `${st.c}22`, color: st.c, fontWeight: 700, fontFamily: F.mono, fontSize: 20 }}>{o > 0.5 ? '✓' : i + 1}</span>
                <div><div style={{ fontFamily: F.display, fontSize: 44, color: C.chalk, lineHeight: 1 }}>{st.k}</div><div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 6, wordBreak: 'break-all' }}>{st.sub}</div></div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 960, top: 150, width: 864 }}>
        <Eyebrow color={C.risk} style={{ marginBottom: 14, opacity: ramp(sec, rt0 - 0.2, 0.4) }}>The chain said no · {tn.refusalCount} real refusals</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {refs.map((r, i) => {
            const o = ramp(sec, rt(i), 0.35);
            return (
              <div key={r.code} style={{ opacity: o, transform: `translateX(${(1 - o) * 40}px)`, display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center', padding: '14px 22px', border: `1px solid ${C.risk}66`, borderRadius: 10, background: `${C.risk}0d` }}>
                <div>
                  <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 28, color: C.chalk }}>Agent tried: {r.what}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, marginTop: 4 }}>{r.code} · tx {r.hash.slice(0, 8)}… on nearblocks (testnet)</div>
                </div>
                <Stamp label="refused" color={C.risk} o={ramp(sec, rt(i) + 0.2, 0.2)} size={20} rot={-3} />
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 96, top: 868, fontFamily: F.mono, fontSize: 19, letterSpacing: '0.06em', color: C.warn }}>
        PUBLIC NEAR TESTNET · OWNER KEY IS A DEMO KEY HELD ON THE AGENT MACHINE · AUTOMATED, NOT A HUMAN WALLET
      </div>
    </SceneFrame>
  );
};

/* ============================== CLOSE ============================== */
export const Close2: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tA = at('agent', 0, 0.05), tB = at('You', 0, 0.38), tCta = at('Judges:', 0, 0.62);
  const repo = (meta as any).repoUrl as string | null;
  const su = data.suites as any;
  const total = su.nearContract.passed + su.evmContract.passed + su.node.pass;
  const tiles = [
    [String((data.live as any).total), 'live public records', C.signal],
    [String((data as any).testnet.refusalCount), 'real chain refusals on testnet', C.risk],
    [String((data.attempts as any[]).filter((a) => a.rejected).length), 'wrong approvals rejected', C.warn],
    [String(total), 'passing tests · app + contracts', C.mineralHi],
  ];
  const ring = ramp(sec, tB - 0.2, 0.9);
  return (
    <SceneFrame s={s} glow="#26330d">
      <Sfx s={s} name="tick" at={tA} volume={0.45} />
      <Sfx s={s} name="tick" at={tB} volume={0.45} />
      <Sfx s={s} name="approve" at={tCta} volume={0.5} />
      <div style={{ position: 'absolute', left: 120, top: 110, display: 'flex', alignItems: 'center', gap: 22, opacity: ramp(sec, 0, 0.5) }}>
        <Brand size={72} /><span style={{ fontFamily: F.display, fontSize: 84, color: C.chalk, letterSpacing: '-0.02em' }}>AutoNEAR</span>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 250, width: 1180 }}>
        <div style={{ fontFamily: F.display, fontSize: 96, lineHeight: 1.05, color: C.chalk, opacity: ramp(sec, tA, 0.45), transform: `translateX(${(1 - ramp(sec, tA, 0.45)) * -40}px)` }}>The agent has a company card.</div>
        <div style={{ fontFamily: F.display, fontStyle: 'italic', fontSize: 110, lineHeight: 1.05, color: C.signal, marginTop: 6, opacity: ramp(sec, tB, 0.45), transform: `translateX(${(1 - ramp(sec, tB, 0.45)) * -40}px)` }}>You set the limit.</div>
      </div>
      <div style={{ position: 'absolute', left: 1560, top: 360, transform: 'translate(-50%,-50%)', opacity: ramp(sec, tA, 0.5) }}>
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }}><Ring r={230} color={C.signal} closing={ring} /></div>
        <div style={{ position: 'relative' }}><CompanyCard w={330} fill={0.4} lit={ring > 0.9} tilt={-4} /></div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 560, opacity: ramp(sec, tCta, 0.5), transform: `translateY(${(1 - ramp(sec, tCta, 0.5)) * 20}px)` }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <span style={{ fontFamily: F.mono, fontSize: 30, color: C.signalInk, background: C.signal, padding: '12px 24px', borderRadius: 8, fontWeight: 600 }}>npm test</span>
          <span style={{ fontFamily: F.mono, fontSize: 26, color: C.chalk2 }}>{repo ? repo.replace(/^https?:\/\//, '') : 'repo link in this post'}</span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: '0.08em', color: C.chalk3, marginTop: 18, lineHeight: 1.5 }}>
          contracts: cargo test --locked · forge test<br />{(meta as any).mention} {(meta as any).hashtags} · {(meta as any).track}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 740, display: 'flex', gap: 20 }}>
        {tiles.map(([n, l, c], i) => {
          const o = ramp(sec, 0.5 + i * 0.25, 0.5);
          return (
            <div key={l} style={{ opacity: o, transform: `translateY(${(1 - o) * 20}px)` }}>
              <Panel style={{ padding: '14px 22px', width: 340, height: 130 }}>
                <div style={{ fontFamily: F.display, fontSize: 64, lineHeight: 1, color: c as string }}>{n}</div>
                <div style={{ fontFamily: F.mono, fontSize: 17, color: C.chalk2, marginTop: 6, lineHeight: 1.3 }}>{l}</div>
              </Panel>
            </div>
          );
        })}
      </div>
    </SceneFrame>
  );
};
