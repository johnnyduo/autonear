import React from 'react';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Eyebrow, Panel, SceneFrame, Sfx, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';

const SRC_LABEL: Record<string, string> = { 'gov-near': 'gov.near.org', 'github-near': 'GitHub · near/*', 'hn-algolia': 'Hacker News', 'near-rpc-mainnet': 'NEAR mainnet RPC' };
const COMP_LABEL: Record<string, string> = {
  independent_demand: 'independent demand', recency: 'recency', onchain_corroboration: 'on-chain corroboration', friction_severity: 'friction severity',
  competition_gap: 'competition gap', near_fit: 'NEAR fit (prior)', feasibility: 'feasibility (prior)', evidence_quality: 'evidence quality',
};

export const Evidence: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const live = data.live as any;
  const tScore = at('Treasury', 0, 0.3);
  const tBut = at('But', 0, 0.62);
  const tFlag = at('flags', 0, 0.74);
  const tTrust = at('tells', 0, 0.9);
  const countUp = Math.round(live.total * ramp(sec, 0.2, 1.4));
  const maxN = Math.max(...live.bySource.map((b: any) => b.n));
  const detail = ramp(sec, tScore, 0.6); // 0 = overview, 1 = treasury breakdown
  const tre = live.treasury;
  const comps = Object.entries(tre.breakdown.components) as [string, number][];
  const warnO = ramp(sec, tFlag - 0.1, 0.4);
  const pulse = 0.6 + 0.4 * Math.sin(sec * 6);

  return (
    <SceneFrame s={s} glow="#26330d">
      <Sfx s={s} name="warn" at={tFlag} volume={0.5} />
      <Sfx s={s} name="tick" at={tScore} volume={0.4} />
      {/* left: counter + sources */}
      <div style={{ position: 'absolute', left: 96, top: 170, width: 620 }}>
        <Eyebrow>Real records ingested</Eyebrow>
        <div style={{ fontFamily: F.display, fontSize: 210, lineHeight: 0.95, color: C.chalk, letterSpacing: '-0.03em' }}>{countUp}</div>
        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {live.bySource.map((b: any, i: number) => (
            <div key={b.id} style={{ opacity: ramp(sec, 0.6 + i * 0.18, 0.4) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 22, color: C.chalk2, marginBottom: 6 }}>
                <span>{SRC_LABEL[b.id] ?? b.id}</span><span style={{ color: C.chalk }}>{b.n}</span>
              </div>
              <div style={{ height: 10, background: C.ink2, borderRadius: 5, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(2, (b.n / maxN) * 100) * ramp(sec, 0.7 + i * 0.18, 0.8)}%`, background: b.kind === 'usage' ? C.mineralHi : C.signal, borderRadius: 5 }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* right: ranking (dims) -> treasury breakdown */}
      <div style={{ position: 'absolute', left: 820, top: 150, width: 1004, opacity: Math.max(0, 1 - 1.6 * detail), transform: `translateY(${detail * -10}px)`, pointerEvents: 'none' }}>
        <Eyebrow style={{ marginBottom: 14 }}>Opportunities · ranked by published formula</Eyebrow>
        <Panel style={{ padding: '12px 0' }}>
          {live.opportunities.map((o: any, i: number) => {
            const isT = o.id === 'opp_treasury';
            return (
              <div key={o.id} style={{ display: 'grid', gridTemplateColumns: '1fr 320px 70px', alignItems: 'center', gap: 20, padding: '13px 28px', opacity: ramp(sec, 0.9 + i * 0.1, 0.35), background: isT ? `${C.signal}12` : 'transparent', borderLeft: `4px solid ${isT ? C.signal : 'transparent'}` }}>
                <span style={{ fontFamily: F.body, fontSize: 28, fontWeight: 500, color: isT ? C.chalk : C.chalk2 }}>{o.title}</span>
                <div style={{ height: 10, background: C.ink3, borderRadius: 5 }}><div style={{ height: '100%', width: `${o.score * 100 * ramp(sec, 1.1 + i * 0.1, 0.7)}%`, background: isT ? C.signal : C.lineHi, borderRadius: 5 }} /></div>
                <span style={{ fontFamily: F.mono, fontSize: 26, color: isT ? C.signal : C.chalk2, textAlign: 'right' }}>{o.score.toFixed(2)}</span>
              </div>
            );
          })}
        </Panel>
      </div>

      <div style={{ position: 'absolute', left: 820, top: 150, width: 1004, opacity: detail, transform: `translateY(${(1 - detail) * 30}px)` }}>
        <Eyebrow style={{ marginBottom: 14 }}>Treasury tooling · score breakdown</Eyebrow>
        <Panel style={{ padding: '26px 30px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 26 }}>
            <span style={{ fontFamily: F.display, fontSize: 130, lineHeight: 0.9, color: C.signal }}>{tre.score.toFixed(2)}</span>
            <span style={{ fontFamily: F.mono, fontSize: 24, color: C.chalk2 }}>score</span>
            <span style={{ fontFamily: F.display, fontSize: 70, lineHeight: 0.9, color: C.chalk, marginLeft: 20 }}>{tre.confidence.toFixed(2)}</span>
            <span style={{ fontFamily: F.mono, fontSize: 24, color: C.chalk2 }}>confidence</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 40px', marginTop: 26 }}>
            {comps.map(([k, v], i) => {
              const prior = /prior/.test(COMP_LABEL[k]);
              return (
                <div key={k}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 19, color: prior ? C.warn : C.chalk2, marginBottom: 5 }}><span>{COMP_LABEL[k]}</span><span>{v.toFixed(2)}</span></div>
                  <div style={{ height: 8, background: C.ink3, borderRadius: 4 }}><div style={{ height: '100%', width: `${v * 100 * ramp(sec, tScore + 0.3 + i * 0.07, 0.6)}%`, background: prior ? C.warn : C.mineralHi, borderRadius: 4 }} /></div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 26, fontFamily: F.mono, fontSize: 21, color: C.chalk2, flexWrap: 'wrap' }}>
            {[['posts', tre.breakdown.counts.demand], ['author handles', tre.breakdown.counts.authors], ['demand sources', tre.breakdown.counts.sources], ['on-chain reading', tre.breakdown.counts.usage]].map(([l, n], i) => (
              <span key={String(l)} style={{ padding: '6px 14px', border: `1px solid ${l === 'demand sources' && sec > tBut ? C.warn : C.line}`, borderRadius: 6, color: l === 'demand sources' && sec > tBut ? C.warn : C.chalk2 }}><b style={{ color: C.chalk }}>{n}</b> {l}</span>
            ))}
          </div>
        </Panel>
        <div style={{ marginTop: 22, opacity: warnO, transform: `translateY(${(1 - warnO) * 16}px)`, border: `2px solid ${C.warn}`, borderRadius: 10, padding: '18px 26px', background: `${C.warn}${Math.round(18 + 14 * pulse).toString(16).padStart(2, '0')}`, boxShadow: `0 0 ${30 * pulse}px ${C.warn}44` }}>
          <div style={{ fontFamily: F.mono, fontSize: 24, fontWeight: 700, color: C.warn, letterSpacing: '0.06em' }}>⚠ {tre.breakdown.warnings[0]}</div>
          <div style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, marginTop: 8, opacity: ramp(sec, tTrust, 0.4) }}>{tre.breakdown.warnings[1]}</div>
        </div>
      </div>
    </SceneFrame>
  );
};
