import React from 'react';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Brand, Eyebrow, Panel, SceneFrame, Sfx, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';
import meta from '../../script/meta.json';

/* ============================== PROOF ============================== */
const Stat: React.FC<{ label: string; n: number; cmd: string; note: string; o: number; c: string; t: number; sec: number }> = ({ label, n, cmd, note, o, c, t, sec }) => (
  <div style={{ opacity: o, transform: `translateY(${(1 - o) * 30}px)`, width: 540 }}>
    <Panel style={{ padding: '30px 34px', borderColor: o > 0.6 ? `${c}88` : C.line, height: 420 }}>
      <Eyebrow color={c}>{label}</Eyebrow>
      <div style={{ fontFamily: F.display, fontSize: 190, lineHeight: 1, color: C.chalk, marginTop: 6 }}>{Math.round(n * ramp(sec, t, 1.0))}</div>
      <div style={{ fontFamily: F.mono, fontSize: 22, color: c, marginTop: 4 }}>passing · 0 failed</div>
      <div style={{ fontFamily: F.mono, fontSize: 20, color: C.chalk2, marginTop: 22, lineHeight: 1.45 }}>$ {cmd}</div>
      <div style={{ fontFamily: F.body, fontSize: 21, color: C.chalk3, marginTop: 10, lineHeight: 1.35 }}>{note}</div>
    </Panel>
  </div>
);

export const Proof: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const su = data.suites as any;
  const tNear = at('Rust', 0, 0.2), tEvm = at('Solidity', 0, 0.38), tTests = at('passing', 0, 0.55), tRec = at('record', 0, 0.82);
  return (
    <SceneFrame s={s}>
      {[tNear, tEvm, tEvm + 0.4].map((t, i) => <Sfx key={i} s={s} name="tick" at={t} volume={0.4} />)}
      <div style={{ position: 'absolute', left: 96, top: 150, display: 'flex', gap: 30 }}>
        <Stat label="NEAR registry · Rust" n={su.nearContract.passed} cmd={su.nearContract.command} note={`${su.nearContract.note}.`} o={ramp(sec, tNear, 0.5)} c={C.signal} t={tTests} sec={sec} />
        <Stat label="EVM registry · Solidity" n={su.evmContract.passed} cmd={su.evmContract.command} note={`${su.evmContract.note}.`} o={ramp(sec, tEvm, 0.5)} c={C.mineralHi} t={tTests} sec={sec} />
        <Stat label="App · Node" n={su.node.pass} cmd={su.node.command} note="Policy engine, ingestion, scoring, approval gates, audit chain." o={ramp(sec, tEvm + 0.4, 0.5)} c={C.warn} t={tTests} sec={sec} />
      </div>
      <div style={{ position: 'absolute', left: 96, top: 600, width: 1728 }}>
        <Eyebrow style={{ marginBottom: 12, opacity: ramp(sec, tTests, 0.4) }}>sample of the NEAR negative-case tests</Eyebrow>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {(su.nearContract.sampleTests as string[]).map((t, i) => (
            <span key={t} style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, padding: '7px 14px', border: `1px solid ${C.line}`, borderRadius: 6, background: C.ink1, opacity: ramp(sec, tTests + 0.2 + i * 0.12, 0.3) }}><span style={{ color: C.signal }}>✓</span> {t}</span>
          ))}
        </div>
        <div style={{ marginTop: 26, fontFamily: F.display, fontSize: 54, color: C.chalk, opacity: ramp(sec, tRec, 0.5) }}>
          Registries <em style={{ color: C.signal }}>record</em> approvals. They don’t move funds.
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== CLOSE ============================== */
export const Close: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const lines = [['Evidence in.', at('Evidence', 0, 0.1), C.chalk], ['Human approves.', at('Human', 0, 0.3), C.signal], ['Chain verifies.', at('Chain', 0, 0.5), C.mineralHi]] as const;
  const tCta = at('Clone', 0, 0.75);
  const repo = (meta as any).repoUrl as string | null;
  return (
    <SceneFrame s={s} glow="#26330d">
      {lines.map(([t, at0], i) => <Sfx key={t} s={s} name="tick" at={at0} volume={0.45} />)}
      <Sfx s={s} name="approve" at={tCta} volume={0.5} />
      <div style={{ position: 'absolute', left: 140, top: 150, display: 'flex', alignItems: 'center', gap: 28, opacity: ramp(sec, 0, 0.5) }}>
        <Brand size={96} />
        <span style={{ fontFamily: F.display, fontSize: 120, color: C.chalk, letterSpacing: '-0.02em' }}>AutoNEAR</span>
      </div>
      <div style={{ position: 'absolute', left: 140, top: 340 }}>
        {lines.map(([t, at0, c]) => (
          <div key={t} style={{ fontFamily: F.display, fontSize: 112, lineHeight: 1.05, color: c, opacity: ramp(sec, at0, 0.45), transform: `translateX(${(1 - ramp(sec, at0, 0.45)) * -40}px)` }}>{t}</div>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 120, top: 190, width: 700, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        {[
          [String((data.live as any).total), 'live public records', C.signal],
          [String(data.run.roleCount), 'roles · policy outside the model', C.mineralHi],
          [String((data.attempts as any[]).filter((a) => a.rejected).length), 'gate attempts rejected', C.risk],
          [String((data.suites as any).nearContract.passed + (data.suites as any).evmContract.passed + (data.suites as any).node.pass), 'passing tests · app + 2 registries', C.warn],
        ].map(([n, l, c], i) => (
          <div key={l} style={{ opacity: ramp(sec, 0.4 + i * 0.25, 0.5), transform: `translateY(${(1 - ramp(sec, 0.4 + i * 0.25, 0.5)) * 20}px)` }}>
            <Panel style={{ padding: '22px 26px', height: 190 }}>
              <div style={{ fontFamily: F.display, fontSize: 104, lineHeight: 1, color: c }}>{n}</div>
              <div style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, marginTop: 10, lineHeight: 1.3 }}>{l}</div>
            </Panel>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 140, top: 760, opacity: ramp(sec, tCta, 0.5), transform: `translateY(${(1 - ramp(sec, tCta, 0.5)) * 20}px)` }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <span style={{ fontFamily: F.mono, fontSize: 30, color: C.signalInk, background: C.signal, padding: '12px 24px', borderRadius: 8, fontWeight: 600 }}>npm test</span>
          <span style={{ fontFamily: F.mono, fontSize: 26, color: C.chalk2 }}>{repo ? repo.replace(/^https?:\/\//, '') : 'repo link in this post'}</span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 21, letterSpacing: '0.08em', color: C.chalk3, marginTop: 20 }}>
          contracts: cargo test --locked · forge test<br />{(meta as any).mention} {(meta as any).hashtags} · {(meta as any).track}
        </div>
      </div>
    </SceneFrame>
  );
};
