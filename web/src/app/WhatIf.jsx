// "Try other rules": a simulator that runs in this browser only. It re-weighs the stored votes of one product; it never writes anything and never affects Auto mode.
import { useEffect, useMemo, useState } from 'react';
import { whatIf, normalize } from './whatif.js';

const q = (x) => Math.round(x * 100);
const SEAT = { signal_collector: 'Collector', evidence_analyst: 'Analyst', skeptic: 'Skeptic', product_architect: 'Architect', builder: 'Builder', security_reviewer: 'Security', launch_planner: 'Planner' };
const VD = { go: ['GO', '#c6f432'], watch: ['WATCH', '#f2b84b'], drop: ['DROP', '#8c8b82'] };

export default function WhatIf({ entry, rules }) {
  const real = useMemo(() => Object.fromEntries(Object.entries(rules.weights).map(([k, v]) => [k, Math.round(v * 100)])), [rules]);
  const [w, setW] = useState(real); const [goAt, setGo] = useState(q(rules.goAt)); const [watchAt, setWatch] = useState(q(rules.watchAt));
  useEffect(() => { setW(real); setGo(q(rules.goAt)); setWatch(q(rules.watchAt)); }, [entry.oppId, real, rules]);
  const base = { votes: entry.votes, confidence: entry.confidence ?? 0, buildable: entry.buildable, rules };
  const r = whatIf({ ...base, weights: w, goAt: goAt / 100, watchAt: watchAt / 100 });
  const eff = normalize(w, rules.weights); const same = r.verdict === entry.verdict && q(r.S) === q(entry.support);
  const changed = goAt !== q(rules.goAt) || watchAt !== q(rules.watchAt) || Object.keys(real).some((k) => w[k] !== real[k]);
  const vd = VD[r.verdict];
  return (
    <details className="cn-wi">
      <summary>Try other rules <span className="faint">(a simulator, nothing is saved)</span></summary>
      <p className="faint">Move a slider to see how the answer would change. The seats&rsquo; votes stay as stored; only how much each one counts changes. The real rules are not touched and Auto mode does not follow this.</p>
      <div className="cn-wi-grid">
        {entry.votes.map((v) => (
          <label key={v.role} className="cn-wi-row"><span>{SEAT[v.role]} <small>votes {q(v.support)}</small></span>
            <input type="range" min="0" max="50" step="1" value={w[v.role]} onChange={(e) => setW({ ...w, [v.role]: Number(e.target.value) })} aria-label={`${SEAT[v.role]} weight`} />
            <b>{Math.round(eff[v.role] * 100)}%</b></label>
        ))}
        <label className="cn-wi-row"><span>Needed to BUILD</span><input type="range" min="30" max="95" value={goAt} onChange={(e) => setGo(Number(e.target.value))} aria-label="Score needed to build" /><b>{goAt}</b></label>
        <label className="cn-wi-row"><span>Needed to WATCH</span><input type="range" min="10" max="90" value={watchAt} onChange={(e) => setWatch(Number(e.target.value))} aria-label="Score needed to keep watching" /><b>{watchAt}</b></label>
      </div>
      <div className="cn-wi-out" style={{ '--c': vd[1] }} role="status" aria-live="polite">
        <b>{q(r.S)}</b><span>out of 100 → <em>{vd[0]}</em>{r.vetoes.length ? ` (${r.vetoes.join(' and ')} would veto)` : ''}</span>
        <small>{changed ? (same ? 'Same answer as the real rules.' : `Different from the real rules, which give ${q(entry.support)} → ${entry.verdict.toUpperCase()}.`) : 'These are the real rules.'}</small>
        {changed && <button type="button" className="btn sm" onClick={() => { setW(real); setGo(q(rules.goAt)); setWatch(q(rules.watchAt)); }}>Back to the real rules</button>}
      </div>
    </details>
  );
}
