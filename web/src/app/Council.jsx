// Council: who decides what gets built. Seven seats vote on every opportunity from stored numbers (rules in src/council.js), the weighted support becomes a verdict,
// and the verdict decides what Auto mode may do. The animation REPLAYS the stored votes; it is not a live vote. The stage strip below shows the real state of the journey.
import { useEffect, useMemo, useState } from 'react';
import { fmt, useApi } from '../api.js';

const COL = { back: '#c6f432', abstain: '#f2b84b', object: '#ff6a3d' };
const SEAT_LABEL = { signal_collector: 'Collector', evidence_analyst: 'Analyst', skeptic: 'Skeptic', product_architect: 'Architect', builder: 'Builder', security_reviewer: 'Security', launch_planner: 'Planner' };
const VERDICT = { go: ['GO', 'Build it', '#c6f432'], watch: ['WATCH', 'Keep watching', '#f2b84b'], drop: ['DROP', 'Not now', '#8c8b82'] };
const reduce = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const CX = 300; const CY = 252; const SR = 240; const GR = 70;
const seatPos = (i) => { const a = Math.PI * (1.06 + (i / 6) * 0.88); return [CX + Math.cos(a) * SR, CY + Math.sin(a) * SR * 0.78]; };
const gaugeAt = (f) => { const a = Math.PI * (1 + f); return [CX + Math.cos(a) * GR, CY + Math.sin(a) * GR]; };

function Chamber({ entry, rules, replayKey }) {
  const [cast, setCast] = useState(0);
  useEffect(() => {
    if (reduce()) { setCast(8); return undefined; }
    setCast(0); const ts = []; for (let i = 1; i <= 8; i++) ts.push(setTimeout(() => setCast(i), 450 + i * 560)); return () => ts.forEach(clearTimeout);
  }, [entry.oppId, replayKey]);
  const partial = entry.votes.slice(0, Math.min(7, cast)).reduce((a, v) => a + v.weight * v.support, 0);
  const done = cast >= 8; const vd = VERDICT[entry.verdict]; const L = Math.PI * GR;
  const arc = `M ${CX - GR} ${CY} A ${GR} ${GR} 0 0 1 ${CX + GR} ${CY}`;
  return (
    <div className="cn-chamber">
      <svg viewBox="0 0 600 305" role="img" aria-label={`Council vote on ${entry.title}: ${vd[1]}. Weighted support ${entry.support.toFixed(2)}.`}>
        <path d={arc} className="cn-track" fill="none" strokeWidth="10" strokeLinecap="round" />
        <path d={arc} fill="none" strokeWidth="10" strokeLinecap="round" stroke={done ? vd[2] : '#c6f432'} strokeDasharray={L} strokeDashoffset={L * (1 - partial)} className="cn-fill" />
        {[rules.watchAt, rules.goAt].map((f, k) => { const [x, y] = gaugeAt(f); const [x2, y2] = [CX + (x - CX) * 1.22, CY + (y - CY) * 1.22]; return <g key={k}><line x1={x} y1={y} x2={x2} y2={y2} stroke="#ece9df" strokeOpacity=".55" /><text x={CX + (x - CX) * 1.42} y={CY + (y - CY) * 1.42 + 3} className="cn-t" textAnchor={k ? 'start' : 'end'}>{k ? 'GO' : 'WATCH'} {f}</text></g>; })}
        <text x={CX} y={CY - 18} className="cn-num" textAnchor="middle">{partial.toFixed(2)}</text>
        <text x={CX} y={CY + 2} className="cn-t" textAnchor="middle">WEIGHTED SUPPORT</text>
        {entry.votes.map((v, i) => {
          const [x, y] = seatPos(i); const on = cast > i; const c = on ? COL[v.stance] : '#3a423f';
          return (
            <g key={v.role} className={on ? 'cn-seat on' : 'cn-seat'}>
              <circle cx={x} cy={y} r="22" fill="#0f1317" stroke={c} strokeWidth={on ? 2.4 : 1.2} />
              {on && <circle cx={x} cy={y} r="22" fill="none" stroke={c} strokeOpacity=".5" className="cn-pulse" />}
              <text x={x} y={y + 4} textAnchor="middle" className="cn-seatn" fill={on ? c : '#8c8b82'}>{on ? v.support.toFixed(2) : '·'}</text>
              <text x={x} y={y + 40} textAnchor="middle" className="cn-t">{SEAT_LABEL[v.role].toUpperCase()}</text>
              <text x={x} y={y + 52} textAnchor="middle" className="cn-t dim">weight {Math.round(v.weight * 100)}%</text>
              {on && cast === i + 1 && !reduce() && <circle key={`${replayKey}-${i}`} r="5" fill={c} className="cn-tok" style={{ '--x0': `${x}px`, '--y0': `${y}px`, '--x1': `${CX}px`, '--y1': `${CY - 8}px` }} />}
            </g>
          );
        })}
      </svg>
      <div className={`cn-stamp${done ? ' on' : ''}`} style={{ '--c': vd[2] }} aria-live="polite">
        <b>{done ? vd[0] : 'VOTING…'}</b><span>{done ? entry.reason : 'Seats vote one after another from stored numbers.'}</span>
      </div>
    </div>
  );
}

function Journey({ j }) {
  if (!j) return null;
  return (
    <ol className="cn-steps" aria-label="From verdict to a deployed product">
      <li className="cn-step done"><i /><b>Council</b><small>verdict</small></li>
      {j.stages.map((s) => <li key={s.id} className={`cn-step ${s.state}`}><i /><b>{s.label}</b><small>{s.detail}</small></li>)}
    </ol>
  );
}

export default function Council({ data }) {
  const api = useApi('/api/council', { poll: 30000 });
  const [pick, setPick] = useState(null); const [replay, setReplay] = useState(0);
  const council = api.data?.council; const journey = api.data?.journey; const mode = api.data?.mode ?? data.autonomy?.mode ?? 'manual';
  const list = council?.opportunities ?? [];
  const entry = useMemo(() => list.find((o) => o.oppId === pick) ?? list.find((o) => o.oppId === journey?.oppId) ?? list[0], [list, pick, journey]);
  if (api.error && !council) return <div className="ap-wrap"><p role="alert">Could not load the council. <button type="button" className="btn sm" onClick={api.reload}>Retry</button></p></div>;
  if (!council) return <div className="ap-wrap"><p className="faint" role="status">Counting the votes…</p></div>;
  if (!entry) return <div className="ap-wrap"><h1 className="ap-h1">Council</h1><p className="dim">No opportunity has been scored yet. The council convenes after the first collection.</p></div>;
  const next = entry.verdict === 'go'
    ? (mode === 'auto' ? 'The council backs this one. In Auto the agent researches it, builds and checks the contract, and acts only inside your limits. Anything it cannot check is left for you.' : 'The council backs this one. You are in manual mode, so it will wait for you at every step and nothing is executed without your approval.')
    : entry.verdict === 'watch'
      ? (entry.buildable ? 'Not strong enough yet. The agent keeps collecting and the council votes again on the next check. In Auto nothing is executed for this one.' : 'A real trend, but nothing can be built and verified for this topic yet. It is flagged for you to decide whether to add a build template. In Auto nothing is executed.')
      : 'Not now. The evidence does not clear the bar. In Auto nothing is executed; the council keeps looking.';
  return (
    <div className="ap-wrap cn">
      <header className="cn-head">
        <div><h1 className="ap-h1">Council</h1><p className="dim">Seven seats vote on every opportunity. Their weighted support decides what the agent is allowed to build and run on its own.</p></div>
        <div className="cn-mode"><span className="eyebrow">Mode</span><b>{mode === 'auto' ? 'Auto: acts only on a GO' : 'Manual: you approve everything'}</b></div>
      </header>

      <section className="cn-card" aria-label="Vote chamber">
        <div className="cn-row"><div><span className="eyebrow">Voting on</span><h2>{entry.title}</h2></div><button type="button" className="btn sm" onClick={() => setReplay(replay + 1)}>Replay the vote</button></div>
        <Chamber entry={entry} rules={council.rules} replayKey={replay} />
        <p className="faint cn-note">Each vote is computed from stored data by published rules, and the reason is quoted below. The animation replays those stored votes; it is not a live vote and no AI opinion is involved.</p>
        <ul className="cn-reasons">
          {entry.votes.map((v) => <li key={v.role}><i style={{ background: COL[v.stance] }} aria-hidden="true" /><b>{SEAT_LABEL[v.role]}</b><span className="num">{v.support.toFixed(2)}</span><span className="dim">{v.reason}</span></li>)}
        </ul>
        {entry.vetoes.length > 0 && <p className="cn-veto" role="note">Veto from {entry.vetoes.join(' and ')}: this blocks a GO on its own.</p>}
      </section>

      <section className="cn-card" aria-label="What happens next">
        <h2>What happens next</h2><p>{next}</p>
        {entry.oppId === journey?.oppId ? <Journey j={journey} /> : <p className="faint">Pick the top opportunity to see the live journey.</p>}
      </section>

      <section className="cn-card" aria-label="Ranking">
        <h2>Ranking</h2>
        <table className="cn-table"><thead><tr><th>Opportunity</th><th>Support</th><th>Trend</th><th>Can be built</th><th>Verdict</th></tr></thead>
          <tbody>{list.map((o) => { const vd = VERDICT[o.verdict]; return (
            <tr key={o.oppId} aria-selected={o.oppId === entry.oppId} onClick={() => { setPick(o.oppId); setReplay((r) => r + 1); }}>
              <td><button type="button" className="cn-link" onClick={() => { setPick(o.oppId); setReplay((r) => r + 1); }}>{o.title}</button></td>
              <td className="num">{o.support.toFixed(2)}</td>
              <td className="num" title={`${o.recent} records in the last ${council.rules.trendWindowDays} days, ${o.prior} before`}>{o.momentum > 0.55 ? '▲ rising' : o.momentum < 0.45 ? '▼ cooling' : '● steady'}</td>
              <td>{o.buildable ? 'yes' : 'not yet'}</td>
              <td><span className="chip" style={{ borderColor: vd[2], color: vd[2] }}>{vd[0]}</span></td>
            </tr>); })}</tbody></table>
        <p className="faint cn-note">Last counted {fmt.ago(council.at)}. A GO needs support of {council.rules.goAt} or more, confidence of {council.rules.minConfidence} or more, no veto, and a contract template that can be built and checked.</p>
      </section>
    </div>
  );
}
