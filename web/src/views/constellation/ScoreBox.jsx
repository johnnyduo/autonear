// The council's scoring box (HTML, right side of the council star view). Big readable numbers instead of canvas text.
// Everything shown is stored data from GET /api/council: the seven seat votes (0 to 100), their weights, the weighted council score, the verdict and the final judgement.
// The seat rows light up in step with the replay on the star (the replay itself is an illustration of the stored votes, not a live vote).
import { useEffect, useState } from 'react';
import { CountUp } from './shared.js';
import { focusEntry } from './council-star.js';

const q = (x) => Math.round(x * 100);
const NAMES = ['Collector', 'Analyst', 'Skeptic', 'Architect', 'Builder', 'Security', 'Planner'];
const ASKS = ['Is there real demand?', 'Is the evidence strong?', 'Any strong objections?', 'Does it fit NEAR?', 'Can it be built?', 'Is the evidence clean?', 'Is it speeding up?'];
const STANCE = { back: ['backs it', '#59ffd1'], abstain: ['unsure', '#f2b84b'], object: ['objects', '#ff4080'] };
const VERDICT = { go: ['GO', 'The council backs building this', '#c6f432'], watch: ['WATCH', 'Not strong enough to build yet', '#f2b84b'], drop: ['DROP', 'Not now', '#8c8b82'] };
const OUT = { shipped: '#c6f432', live: '#66ffcc', failed: '#ff4080', held: '#f2b84b', waiting: '#80d9ff', in_progress: '#f2b84b', ready: '#c6f432', not_started: '#8c8b82' };

export default function ScoreBox({ data, sceneRef, wide }) {
  const e = focusEntry(data); const oc = data?.journey?.outcome; const rules = data?.council?.rules ?? { goAt: 0.62, watchAt: 0.48 };
  const [cyc, setCyc] = useState(14);
  useEffect(() => { const id = setInterval(() => { const c = sceneRef.current?.council?.cycle; if (typeof c === 'number') setCyc(Math.round(c * 6) / 6); }, 160); return () => clearInterval(id); }, [sceneRef]);
  if (!e) return null;
  const vd = VERDICT[e.verdict]; const fired = (i) => cyc >= 1.4 + i * 1.05; const partial = e.votes.reduce((a, v, i) => a + (fired(i) ? v.weight * v.support : 0), 0); const done = cyc >= 10.3;
  return (
    <aside className="co-score" data-ui data-reserve aria-label="Council scoring box">
      <details open={wide}>
        <summary><span className="co-sc-eye">COUNCIL SCORE</span><b className="co-sc-sum" style={{ color: vd[2] }}>{q(e.support)} / 100 · {vd[0]}</b></summary>
        <p className="co-sc-title">{e.title}</p>
        <div className="co-sc-top">
          <div className="co-sc-num"><b><CountUp value={q(e.support)} ms={700} /></b><span>/ 100</span></div>
          <div className="co-sc-verdict" style={{ '--c': vd[2] }}><b>{vd[0]}</b><span>{vd[1]}</span></div>
        </div>
        <div className="co-sc-meter" role="img" aria-label={`Council score ${q(e.support)} out of 100. ${q(rules.watchAt)} keeps it on watch, ${q(rules.goAt)} builds it.`}>
          <i style={{ width: `${Math.min(100, partial * 100)}%`, background: vd[2] }} />
          <u style={{ left: `${rules.watchAt * 100}%` }}><em>{q(rules.watchAt)}</em></u><u style={{ left: `${rules.goAt * 100}%` }}><em>{q(rules.goAt)}</em></u>
        </div>
        <p className="co-sc-legend"><span>under {q(rules.watchAt)}: not now</span><span>{q(rules.watchAt)}+: watch</span><span>{q(rules.goAt)}+: build</span></p>

        <h4 className="co-sc-h">How the seven seats voted</h4>
        <ul className="co-sc-seats">
          {e.votes.map((v, i) => { const on = fired(i); const [word, col] = STANCE[v.stance]; return (
            <li key={v.role} className={on ? 'on' : ''} title={`${ASKS[i]} ${v.reason}`}>
              <span className="co-sc-name">{NAMES[i]}<small>{ASKS[i]}</small></span>
              <span className="co-sc-bar"><i style={{ width: on ? `${q(v.support)}%` : '0%', background: col }} /></span>
              <span className="co-sc-val" style={{ color: on ? col : undefined }}>{on ? q(v.support) : '–'}</span>
              <span className="co-sc-w">{Math.round(v.weight * 100)}%</span>
            </li>); })}
        </ul>
        <p className="co-sc-note">Each seat scores 0 to 100. The grey % is how much that seat counts. Not a chance of success.</p>

        <h4 className="co-sc-h">Final judgement</h4>
        <div className="co-sc-final" style={{ '--c': OUT[oc?.state ?? 'not_started'] }}>
          <b>{oc ? oc.headline : 'Not started'}</b>
          {oc && <p>{oc.detail}</p>}
          {oc && <p className="co-sc-next"><em>Next</em>{oc.next}</p>}
          {oc && <span className="co-sc-prog" aria-label={`${oc.progress.done} of ${oc.progress.total} steps done`}>{Array.from({ length: oc.progress.total }, (_, k) => <i key={k} className={k < oc.progress.done ? 'on' : ''} />)}</span>}
        </div>
        <a className="co-sc-more" href="#/council">Open the full story ›</a>
        {!done && <span className="co-sc-replay">replaying the stored votes</span>}
      </details>
    </aside>
  );
}
