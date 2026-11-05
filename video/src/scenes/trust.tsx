import React from 'react';
import { C, F } from '../theme';
import { ramp } from '../lib/anim';
import { Eyebrow, Panel, SceneFrame, Sfx, Stamp, useAnchors, useNarrationSec } from '../components';
import { data, type SceneTiming } from '../lib/timeline';

const ROLE_NAME: Record<string, string> = {
  signal_collector: 'Signal Collector', evidence_analyst: 'Evidence Analyst', skeptic: 'Skeptic', product_architect: 'Product Architect',
  builder: 'Builder', security_reviewer: 'Security Reviewer', launch_planner: 'Launch Planner',
};

/* ============================== PIPELINE ============================== */
export const Pipeline: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const done = (data.run.events as any[]).filter((e) => e.status === 'completed');
  const t0 = 0.35, t1 = Math.max(t0 + 2, at('Code', 0, 0.45) - 0.3);
  const rowT = (i: number) => t0 + (i / (done.length - 1)) * (t1 - t0);
  const tPolicy = at('Code', 0, 0.45);
  const tInject = at('Suspected', 0, 0.78);
  const policy = ramp(sec, tPolicy, 0.5);
  const inj = ramp(sec, tInject, 0.5);
  return (
    <SceneFrame s={s}>
      {done.map((_, i) => <Sfx key={i} s={s} name="tick" at={rowT(i)} volume={0.25} />)}
      <Sfx s={s} name="reject" at={tInject + 0.55} volume={0.4} />
      <div style={{ position: 'absolute', left: 96, top: 160, width: 940 }}>
        <Eyebrow style={{ marginBottom: 16 }}>{data.run.roleCount} roles · hash-linked audit log {data.run.auditChainOk ? 'verified' : 'BROKEN'}</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {done.map((e, i) => {
            const o = ramp(sec, rowT(i), 0.35);
            const flagged = /injection/.test(e.detail);
            return (
              <div key={e.role} style={{ display: 'grid', gridTemplateColumns: '34px 280px 1fr', gap: 16, alignItems: 'start', opacity: o, transform: `translateX(${(1 - o) * -26}px)`, padding: '10px 18px', border: `1px solid ${flagged && inj > 0.2 ? C.risk : C.line}`, borderRadius: 8, background: `${C.ink1}ee` }}>
                <span style={{ marginTop: 8, width: 16, height: 16, borderRadius: 99, background: C.signal, boxShadow: `0 0 12px ${C.signal}88` }} />
                <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 27, color: C.chalk }}>{ROLE_NAME[e.role] ?? e.role}</span>
                <span style={{ fontFamily: F.mono, fontSize: 19, color: C.chalk2, lineHeight: 1.35 }}>{e.detail}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ position: 'absolute', left: 1090, top: 160, width: 734 }}>
        <div style={{ opacity: policy, transform: `translateY(${(1 - policy) * 24}px)` }}>
          <Eyebrow color={C.signal} style={{ marginBottom: 12 }}>src/policy.js · ROLE_POLICY — code, not the model</Eyebrow>
          <Panel style={{ padding: '20px 24px', fontFamily: F.mono, fontSize: 19, lineHeight: 1.6, color: C.chalk2 }}>
            {(data.policyLines as string[]).slice(0, 3).map((l) => {
              const [k, ...rest] = l.split(': ');
              return <div key={l} style={{ marginBottom: 6 }}><span style={{ color: C.mineralHi }}>{k}</span>: <span style={{ color: C.chalk }}>{rest.join(': ').replace(/,$/, '')}</span></div>;
            })}
            <div style={{ marginTop: 10, color: C.warn }}>budget: run-level USD + token ceilings · citations must match evidence ids given</div>
          </Panel>
        </div>
        <div style={{ marginTop: 34, opacity: inj, transform: `translateY(${(1 - inj) * 24}px)` }}>
          <Eyebrow color={C.risk} style={{ marginBottom: 12 }}>hostile fixture record</Eyebrow>
          <Panel style={{ padding: '22px 24px', borderColor: C.risk, boxShadow: `0 0 36px ${C.risk}33` }}>
            <div style={{ fontFamily: F.mono, fontSize: 22, lineHeight: 1.4, color: C.chalk }}>“{data.hostile.text}”</div>
            <div style={{ marginTop: 18, display: 'flex', gap: 14, alignItems: 'center' }}>
              <Stamp label="flagged" color={C.risk} o={ramp(sec, tInject + 0.5, 0.3)} size={20} />
              <Stamp label="withheld from prompts" color={C.warn} o={ramp(sec, tInject + 0.9, 0.3)} size={20} rot={2} />
            </div>
          </Panel>
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== GATE ============================== */
export const Gate: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const d = data.decision as any;
  const attempts = data.attempts as any[];
  const times = [at('nonce', 0, 0.2), at('payload', 0, 0.38), at('signer', 0, 0.54), at('Kill', 0, 0.7), at('Only', 0, 0.84)];
  const rowTime = [times[0], times[1], times[2], times[3], times[4] + 0.15, times[4] + 0.55];
  const tOK = at('gets', 0, 0.92);
  const approved = ramp(sec, tOK, 0.4);
  const rejected = attempts.filter((a) => a.rejected);
  const rows = rejected.slice(0, 6);
  return (
    <SceneFrame s={s}>
      {rows.map((_, i) => <Sfx key={i} s={s} name="reject" at={(rowTime[i] ?? rowTime[5]) + 0.25} volume={0.5} />)}
      <Sfx s={s} name="approve" at={tOK + 0.1} volume={0.6} />
      <div style={{ position: 'absolute', left: 96, top: 160, width: 620 }}>
        <Eyebrow style={{ marginBottom: 14 }}>Decision · one action = one approval</Eyebrow>
        <Panel style={{ padding: '24px 26px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span style={{ fontFamily: F.mono, fontSize: 24, color: C.chalk }}>{d.id}</span>
            <span style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: '0.1em', padding: '5px 14px', borderRadius: 6, color: approved > 0.5 ? C.signalInk : C.warn, background: approved > 0.5 ? C.signal : `${C.warn}22`, border: `1px solid ${approved > 0.5 ? C.signal : C.warn}` }}>{approved > 0.5 ? 'APPROVED' : 'PENDING'}</span>
          </div>
          {[['action', 'deploy_testnet registry'], ['chain', d.chain], ['target', d.target], ['max spend', d.maxSpend], ['payload hash', d.payloadHashPrefix + '…'], ['expires', `${d.expiryHours}h (default)`]].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 21, padding: '9px 0', borderTop: `1px solid ${C.line}` }}>
              <span style={{ color: C.chalk3 }}>{k}</span><span style={{ color: k === 'max spend' ? C.signal : C.chalk }}>{v}</span>
            </div>
          ))}
        </Panel>
        <div style={{ marginTop: 22, opacity: approved, transform: `translateY(${(1 - approved) * 14}px)`, fontFamily: F.mono, fontSize: 19, color: C.chalk2, lineHeight: 1.6 }}>
          phrase: <span style={{ color: C.signal }}>approve {d.id}</span><br />signer: <span style={{ color: C.chalk }}>op.testnet</span> · receipt <span style={{ color: C.chalk }}>{d.receiptPrefix}…</span>
        </div>
      </div>

      <div style={{ position: 'absolute', left: 790, top: 160, width: 1034 }}>
        <Eyebrow style={{ marginBottom: 14, textTransform: 'none' }}>approveDecision() · attempts</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((a, i) => {
            const o = ramp(sec, rowTime[i] ?? rowTime[5], 0.3);
            const stamp = ramp(sec, (rowTime[i] ?? rowTime[5]) + 0.25, 0.2);
            return (
              <div key={a.label} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 20, padding: '11px 22px', border: `1px solid ${C.line}`, borderRadius: 8, background: `${C.ink1}ee`, opacity: o, transform: `translateX(${(1 - o) * 40}px)` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 28, color: C.chalk }}>{a.label}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk3, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 780 }}>code: {a.code} · {a.message}</div>
                </div>
                <Stamp label="rejected" color={C.risk} o={stamp} size={24} rot={-3} />
              </div>
            );
          })}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', padding: '12px 22px', border: `2px solid ${C.signal}`, borderRadius: 8, background: `${C.signal}12`, opacity: approved, transform: `scale(${0.96 + 0.04 * approved})`, boxShadow: `0 0 40px ${C.signal}33` }}>
            <div>
              <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 30, color: C.chalk }}>Exact phrase + named signer + matching hash</div>
              <div style={{ fontFamily: F.mono, fontSize: 18, color: C.chalk2, marginTop: 4 }}>→ status: pending → approved (nothing is deployed yet)</div>
            </div>
            <Stamp label="approved" color={C.signal} o={approved} size={24} rot={2} />
          </div>
        </div>
      </div>
    </SceneFrame>
  );
};

/* ============================== VERIFY ============================== */
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

export const Verify: React.FC<{ s: SceneTiming }> = ({ s }) => {
  const sec = useNarrationSec(s);
  const { at } = useAnchors(s);
  const v = data.verification as any;
  const tSign = at('sign', 0, 0.2);
  const tGood = at('records', 0, 0.38);
  const tBad = at('Wrong', 0, 0.74);
  const tMock = at('Mocked', 0, 0.9);
  const good = v.goodChecks as { name: string; ok: boolean; info?: boolean }[];
  const bad = v.badChecks as { name: string; ok: boolean }[];
  const failed = (v.badFailed ?? []) as { name: string; detail: string }[];
  const step = Math.max(0.07, Math.min(0.2, (tBad - tGood - 0.9) / good.length));
  const doneAt = tGood + good.length * step;
  const flow = [['You sign', 'in your own wallet'], ['tx hash', 'testnet'], ['AutoNEAR verifies', 'against the approved decision']];
  const badO = ramp(sec, tBad, 0.4);
  const passN = bad.filter((c) => c.ok && !(c as any).info).length, totalN = bad.filter((c) => !(c as any).info).length;
  return (
    <SceneFrame s={s}>
      {good.map((_, i) => <Sfx key={`g${i}`} s={s} name="tick" at={tGood + i * step} volume={0.14} />)}
      <Sfx s={s} name="approve" at={doneAt + 0.1} volume={0.55} />
      <Sfx s={s} name="reject" at={tBad + 0.9} volume={0.5} />
      <div style={{ position: 'absolute', left: 96, top: 160, display: 'flex', gap: 18, alignItems: 'center' }}>
        {flow.map(([a, b], i) => (
          <React.Fragment key={a}>
            <div style={{ opacity: ramp(sec, tSign + i * 0.35, 0.4), border: `1px solid ${i === 0 ? C.signal : C.lineHi}`, borderRadius: 10, padding: '12px 24px', background: C.ink1 }}>
              <div style={{ fontFamily: F.display, fontSize: 40, color: C.chalk, lineHeight: 1 }}>{a}</div>
              <div style={{ fontFamily: F.mono, fontSize: 17, color: C.chalk3, marginTop: 4 }}>{b}</div>
            </div>
            {i < flow.length - 1 && <span style={{ color: C.chalk3, fontFamily: F.mono, fontSize: 30, opacity: ramp(sec, tSign + i * 0.35 + 0.2, 0.3) }}>→</span>}
          </React.Fragment>
        ))}
      </div>

      {/* matching build: every check the verifier runs */}
      <div style={{ position: 'absolute', left: 96, top: 290, width: 1010 }}>
        <Eyebrow color={C.signal} style={{ marginBottom: 12, opacity: ramp(sec, tGood - 0.2, 0.4) }}>Matching build · {good.filter((c) => !c.info).length} checks</Eyebrow>
        <Panel style={{ padding: '14px 26px 58px', position: 'relative', borderColor: ramp(sec, tGood, 0.3) > 0.1 ? `${C.signal}88` : C.line }}>
          {good.map((c, i) => <Check key={c.name} name={c.name} ok={c.ok} info={c.info} o={ramp(sec, tGood + i * step, 0.2)} />)}
          <div style={{ position: 'absolute', left: 26, bottom: 20, fontFamily: F.mono, fontSize: 19, color: C.chalk2, opacity: ramp(sec, doneAt + 0.2, 0.3) }}>decision → {data.decision.finalStatus}</div>
          <div style={{ position: 'absolute', right: 26, bottom: 14 }}><Stamp label="recorded" color={C.signal} o={ramp(sec, doneAt + 0.1, 0.3)} size={28} rot={3} /></div>
        </Panel>
      </div>

      {/* wrong build: one check fails, everything else is irrelevant */}
      <div style={{ position: 'absolute', left: 1140, top: 290, width: 684 }}>
        <Eyebrow color={C.risk} style={{ marginBottom: 12, opacity: badO }}>Wrong build · code hash 1111…</Eyebrow>
        <Panel style={{ padding: '26px 30px', minHeight: 480, position: 'relative', borderColor: badO > 0.1 ? `${C.risk}88` : C.line, opacity: 0.2 + 0.8 * badO, transform: `translateY(${(1 - badO) * 20}px)` }}>
          <div style={{ fontFamily: F.display, fontSize: 96, lineHeight: 1, color: C.chalk }}>{passN}<span style={{ color: C.chalk3 }}> / {totalN}</span></div>
          <div style={{ fontFamily: F.mono, fontSize: 20, color: C.chalk2, marginTop: 6 }}>checks pass</div>
          {failed.map((f) => (
            <div key={f.name} style={{ marginTop: 26, border: `2px solid ${C.risk}`, borderRadius: 10, padding: '16px 20px', background: `${C.risk}12`, opacity: ramp(sec, tBad + 0.6, 0.35) }}>
              <div style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 700, color: C.risk }}>✕ {f.name.replace('==', '=')}</div>
              <div style={{ fontFamily: F.mono, fontSize: 16, color: C.chalk2, marginTop: 8, wordBreak: 'break-all', lineHeight: 1.35 }}>{f.detail}</div>
            </div>
          ))}
          <div style={{ position: 'absolute', left: 30, bottom: 26, fontFamily: F.mono, fontSize: 19, color: C.chalk2, opacity: ramp(sec, tBad + 1.1, 0.3) }}>this attempt: nothing recorded, still approved</div>
          <div style={{ position: 'absolute', right: 30, bottom: 70 }}><Stamp label="refused" color={C.risk} o={ramp(sec, tBad + 0.9, 0.3)} size={28} rot={-4} /></div>
        </Panel>
      </div>
      <div style={{ position: 'absolute', left: 96, top: 868, fontFamily: F.mono, fontSize: 19, letterSpacing: '0.06em', color: C.warn, opacity: 0.55 + 0.45 * ramp(sec, tMock, 0.4) }}>
        MOCKED NEAR RPC · FIXTURE BUILD ATTESTATION · NO PUBLIC TRANSACTION IN THIS RECORDING
      </div>
    </SceneFrame>
  );
};
