import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Eyebrow, Panel, SceneFrame, Sfx, Stamp, SyncedText, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';

/* ============================== HOOK ============================== */
const KeyIcon: React.FC<{ color: string; size?: number }> = ({ color, size = 60 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M21 12v2" />
  </svg>
);

export const Hook: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const frame = useCurrentFrame();
  const { at } = useAnchors(s);
  const tTreasury = at('treasury', 0, 0.5);
  const tNo = at('Neither', 0, 0.75);
  const lineIn = ramp(sec, tTreasury - 0.1, 0.5);
  const cut = ramp(sec, tNo, 0.35);
  const lineColor = cut > 0.05 ? C.risk : C.signal;
  const spin = frame * 0.6;
  return (
    <SceneFrame s={s} glow={cut > 0.5 ? '#5a2410' : C.mineral}>
      <Sfx s={s} name="reject" at={tNo + 0.05} volume={0.55} />
      <div style={{ position: 'absolute', left: 140, top: 250, width: 1020 }}>
        <SyncedText s={s} size={132} italic={['neither', 'would', 'we.']} accent={C.risk} breakAfter={/\?$/} />
      </div>
      <svg style={{ position: 'absolute', left: 1180, top: 120, width: 640, height: 780 }} viewBox="0 0 640 780">
        {/* agent */}
        <g transform="translate(320 200)">
          <circle r="150" fill="none" stroke={C.lineHi} strokeDasharray="4 12" transform={`rotate(${spin})`} />
          <circle r="108" fill={C.ink2} stroke={C.mineralHi} strokeWidth="2" />
          <polygon points="0,-52 45,-26 45,26 0,52 -45,26 -45,-26" fill="none" stroke={C.signal} strokeWidth="3" />
          <circle r="9" fill={C.signal} />
          <text y="190" textAnchor="middle" fontFamily={F.mono} fontSize="22" letterSpacing="3" fill={C.chalk3}>AI AGENT</text>
        </g>
        {/* link to treasury */}
        <line x1="320" y1="410" x2="320" y2="548" stroke={lineColor} strokeWidth="4" strokeDasharray="10 10" strokeDashoffset={-frame * 1.2} opacity={lineIn} />
        <g opacity={lineIn} transform="translate(320 640)">
          <rect x="-120" y="-90" width="240" height="180" rx="16" fill={C.ink2} stroke={cut > 0.05 ? C.risk : C.lineHi} strokeWidth="2" />
          <circle cx="-50" cy="-10" r="26" fill="none" stroke={C.warn} strokeWidth="3" />
          <circle cx="0" cy="-10" r="26" fill="none" stroke={C.warn} strokeWidth="3" />
          <circle cx="50" cy="-10" r="26" fill="none" stroke={C.warn} strokeWidth="3" />
          <text y="62" textAnchor="middle" fontFamily={F.mono} fontSize="22" letterSpacing="3" fill={C.chalk2}>TREASURY</text>
        </g>
        {/* the cut */}
        <g opacity={cut} transform={`translate(320 ${480 + (1 - cut) * -20}) scale(${0.6 + 0.4 * cut})`}>
          <circle r="44" fill={C.ink0} stroke={C.risk} strokeWidth="4" />
          <path d="M-18 -18L18 18M18 -18L-18 18" stroke={C.risk} strokeWidth="7" strokeLinecap="round" />
        </g>
      </svg>
    </SceneFrame>
  );
};

/* ============================== PROBLEM ============================== */
const PostCard: React.FC<{ source: string; o: number; y: number; hostile?: boolean; flagged?: number; text?: string }> = ({ source, o, y, hostile, flagged = 0, text }) => (
  <div style={{ position: 'absolute', left: 0, top: y, width: 760, opacity: o, transform: `translateY(${(1 - o) * 24}px)` }}>
    <Panel style={{ padding: '22px 26px', borderColor: hostile && flagged > 0.5 ? C.risk : C.line, boxShadow: hostile && flagged > 0.5 ? `0 0 0 1px ${C.risk}55, 0 0 40px ${C.risk}33` : 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <Eyebrow>{source}</Eyebrow>
        {hostile && <Stamp label="flagged · withheld" color={C.risk} o={flagged} size={20} rot={-3} />}
      </div>
      {text ? (
        <div style={{ fontFamily: F.mono, fontSize: 25, lineHeight: 1.4, color: C.chalk }}>{text}</div>
      ) : (
        <>
          <div style={{ height: 14, width: '86%', background: C.ink3, borderRadius: 4, marginBottom: 12 }} />
          <div style={{ height: 14, width: '62%', background: C.ink3, borderRadius: 4 }} />
        </>
      )}
    </Panel>
  </div>
);

const Pill: React.FC<{ label: string; sub: string; color: string; o: number }> = ({ label, sub, color, o }) => (
  <div style={{ opacity: o, transform: `translateY(${(1 - o) * 18}px)`, border: `2px solid ${color}`, borderRadius: 14, padding: '18px 34px', background: `${color}12`, minWidth: 330 }}>
    <div style={{ fontFamily: F.display, fontSize: 64, color, lineHeight: 1 }}>{label}</div>
    <div style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: '0.1em', color: C.chalk2, marginTop: 8, textTransform: 'uppercase' }}>{sub}</div>
  </div>
);

export const Problem: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const tHide = at('hide', 0, 0.3);
  const tRule = at('agents', 0, 0.62);
  const tHum = at('Humans', 0, 0.8);
  return (
    <SceneFrame s={s} glow={'#3a2a14'}>
      <Sfx s={s} name="reject" at={tHide + 1.15} volume={0.4} />
      <Sfx s={s} name="tick" at={tRule + 0.1} />
      <Sfx s={s} name="approve" at={tHum + 0.15} volume={0.35} />
      <div style={{ position: 'absolute', left: 140, top: 190 }}>
        <Eyebrow style={{ marginBottom: 20 }}>Public posts · GitHub · forum · Hacker News</Eyebrow>
        <div style={{ position: 'relative', width: 760, height: 520 }}>
          <PostCard source="gov.near.org" o={ramp(sec, 0.2)} y={0} />
          <PostCard source="GitHub issue" o={ramp(sec, 0.55)} y={150} />
          <PostCard source="test record · hostile fixture" o={ramp(sec, tHide, 0.5)} y={300} hostile flagged={ramp(sec, tHide + 0.9, 0.35)} text={`“${data.hostile.text}”`} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1000, top: 230, width: 800 }}>
        <div style={{ fontFamily: F.display, fontSize: 96, lineHeight: 1, color: C.chalk, opacity: ramp(sec, tRule - 0.2, 0.5), transform: `translateY(${(1 - ramp(sec, tRule - 0.2, 0.5)) * 18}px)` }}>
          The rule<span style={{ color: C.signal }}>.</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 44 }}>
          <Pill label="Agents propose" sub="find the idea · draft the action" color={C.mineralHi} o={ramp(sec, tRule, 0.45)} />
          <Pill label="Humans approve" sub="exact phrase · named signer" color={C.signal} o={ramp(sec, tHum, 0.45)} />
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== SOLUTION ============================== */
const NODES = [
  { k: 'EVIDENCE', sub: () => `${data.live.total} public records`, who: 'agent' },
  { k: 'SCORE', sub: () => 'open formula · warnings', who: 'agent' },
  { k: 'PROPOSE', sub: () => 'testnet deploy · spend cap 0', who: 'agent' },
  { k: 'HUMAN APPROVES', sub: () => 'nonce · hash · phrase · signer', who: 'human' },
  { k: 'CHAIN VERIFIES', sub: () => 'signer · account · code hash', who: 'human' },
] as const;

export const Solution: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const times = [at('collects', 0, 0.2), at('scores', 0, 0.38), at('prepares', 0, 0.55), at('human', 0, 0.82), s.durationSec - 0.7];
  const NW = 300, GAP = 54, X0 = 96;
  return (
    <SceneFrame s={s}>
      {times.map((t, i) => <Sfx key={i} s={s} name="tick" at={t} volume={0.4} />)}
      <div style={{ position: 'absolute', left: 96, top: 210, right: 96 }}>
        <SyncedText s={s} text="This is AutoNEAR." size={110} italic={['autonear']} />
      </div>
      {/* brackets */}
      {[{ x: 0, n: 3, label: 'AGENT · UNTRUSTED', c: C.mineralHi }, { x: 3, n: 2, label: 'HUMAN + CHAIN · AUTHORITY', c: C.signal }].map((b, i) => (
        <div key={i} style={{ position: 'absolute', left: X0 + b.x * (NW + GAP), top: 500, width: b.n * NW + (b.n - 1) * GAP, opacity: ramp(sec, i ? times[3] - 0.2 : times[0] - 0.1, 0.5) }}>
          <Eyebrow color={b.c} style={{ marginBottom: 10 }}>{b.label}</Eyebrow>
          <div style={{ height: 3, background: b.c, borderRadius: 2 }} />
        </div>
      ))}
      {NODES.map((n, i) => {
        const o = ramp(sec, times[i], 0.45);
        const human = n.who === 'human';
        const col = human ? C.signal : C.mineralHi;
        return (
          <React.Fragment key={n.k}>
            <div style={{ position: 'absolute', left: X0 + i * (NW + GAP), top: 560, width: NW, height: 250, opacity: 0.25 + 0.75 * o, transform: `translateY(${(1 - o) * 26}px)` }}>
              <Panel style={{ height: '100%', padding: 24, borderColor: o > 0.5 ? col : C.line, boxShadow: o > 0.5 ? `0 0 40px ${col}22` : 'none', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <Eyebrow color={col}>{String(i + 1).padStart(2, '0')}</Eyebrow>
                <div>
                  <div style={{ fontFamily: F.display, fontSize: 46, lineHeight: 1, color: C.chalk }}>{n.k}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, marginTop: 12, lineHeight: 1.35 }}>{n.sub()}</div>
                </div>
              </Panel>
            </div>
            {i < NODES.length - 1 && (
              <div style={{ position: 'absolute', left: X0 + i * (NW + GAP) + NW, top: 670, width: GAP, display: 'flex', justifyContent: 'center', opacity: ramp(sec, times[i + 1] - 0.2, 0.3), color: i === 2 ? C.warn : C.chalk3, fontFamily: F.mono, fontSize: 34 }}>
                {i === 2 ? '⛨' : '→'}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </SceneFrame>
  );
};
