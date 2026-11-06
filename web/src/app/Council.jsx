// Council: who decides what gets built. Seven seats vote on every opportunity from stored numbers (rules in src/council.js), the weighted support becomes a verdict,
// and the verdict decides what Auto mode may do. The animation REPLAYS the stored votes; it is not a live vote. The stage strip below shows the real state of the journey.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, useApi } from '../api.js';
import { CountUp } from '../views/constellation/shared.js';
import { href } from './nav.js';
import ProofDialog from './CouncilProof.jsx';

const COL = { back: '#c6f432', abstain: '#f2b84b', object: '#ff6a3d' };
const SEAT_LABEL = { signal_collector: 'Collector', evidence_analyst: 'Analyst', skeptic: 'Skeptic', product_architect: 'Architect', builder: 'Builder', security_reviewer: 'Security', launch_planner: 'Planner' };
const VERDICT = { go: ['GO', 'Build it', '#c6f432'], watch: ['WATCH', 'Keep watching', '#f2b84b'], drop: ['DROP', 'Not now', '#8c8b82'] };
const reduce = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const CX = 300; const CY = 262; const SR = 240; const GR = 70;
const seatPos = (i) => { const a = Math.PI * (1.08 + (i / 6) * 0.84); return [CX + Math.cos(a) * SR, CY + Math.sin(a) * SR * 0.82]; };
const gaugeAt = (f) => { const a = Math.PI * (1 + f); return [CX + Math.cos(a) * GR, CY + Math.sin(a) * GR]; };

function Chamber({ entry, rules, replayKey, onSeat, onVerdict }) {
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
      <svg viewBox="0 0 600 318" role="img" aria-label={`Council vote on ${entry.title}: ${vd[1]}. Council score ${q(entry.support)} out of 100.`}>
        <path d={arc} className="cn-track" fill="none" strokeWidth="10" strokeLinecap="round" />
        <path d={arc} fill="none" strokeWidth="10" strokeLinecap="round" stroke={done ? vd[2] : '#c6f432'} strokeDasharray={L} strokeDashoffset={L * (1 - partial)} className="cn-fill" />
        {[rules.watchAt, rules.goAt].map((f, k) => { const [x, y] = gaugeAt(f); const [x2, y2] = [CX + (x - CX) * 1.22, CY + (y - CY) * 1.22]; return <g key={k}><line x1={x} y1={y} x2={x2} y2={y2} stroke="#ece9df" strokeOpacity=".55" /><text x={CX + (x - CX) * 1.42} y={CY + (y - CY) * 1.42 + 3} className="cn-t" textAnchor={k ? 'start' : 'end'}>{k ? 'BUILD' : 'WATCH'} {q(f)}</text></g>; })}
        <text x={CX} y={CY - 18} className="cn-num" textAnchor="middle">{q(partial)}</text>
        <text x={CX} y={CY + 2} className="cn-t" textAnchor="middle">COUNCIL SCORE / 100</text>
        {entry.votes.map((v, i) => {
          const [x, y] = seatPos(i); const on = cast > i; const c = on ? COL[v.stance] : '#3a423f';
          return (
            <g key={v.role} className={on ? 'cn-seat on' : 'cn-seat'} role="button" tabIndex={0} aria-label={`${SEAT_LABEL[v.role]} seat, ${q(v.support)} out of 100. Open the proof.`} onClick={() => onSeat(v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSeat(v); } }}>
              <circle cx={x} cy={y} r="22" fill="#0f1317" stroke={c} strokeWidth={on ? 2.4 : 1.2} />
              {on && <circle cx={x} cy={y} r="22" fill="none" stroke={c} strokeOpacity=".5" className="cn-pulse" />}
              <text x={x} y={y + 4} textAnchor="middle" className="cn-seatn" fill={on ? c : '#8c8b82'}>{on ? q(v.support) : '·'}</text>
              <text x={x} y={y + 40} textAnchor="middle" className="cn-t">{SEAT_LABEL[v.role].toUpperCase()}</text>
              <text x={x} y={y + 52} textAnchor="middle" className="cn-t dim">weight {Math.round(v.weight * 100)}%</text>
              {on && cast === i + 1 && !reduce() && <circle key={`${replayKey}-${i}`} r="5" fill={c} className="cn-tok" style={{ '--x0': `${x}px`, '--y0': `${y}px`, '--x1': `${CX}px`, '--y1': `${CY - 8}px` }} />}
            </g>
          );
        })}
      </svg>
      <div className={`cn-stamp${done ? ' on' : ''}`} style={{ '--c': vd[2] }} aria-live="polite">
        <b>{done ? vd[0] : 'VOTING…'}</b><span>{done ? entry.reason : 'Seats vote one after another from stored numbers.'}</span>
        {done && <button type="button" className="btn sm cn-proofbtn" onClick={onVerdict}>Proof and chain links</button>}
      </div>
    </div>
  );
}

const OUTC = { shipped: '#c6f432', live: '#66ffcc', failed: '#ff4080', held: '#f2b84b', waiting: '#80d9ff', in_progress: '#f2b84b', ready: '#c6f432', not_started: '#8c8b82' };
const q = (x) => Math.round(x * 100);
const STANCE_WORD = { back: 'backs it', abstain: 'unsure', object: 'objects' };
const WHO = { research: ['System', 'The seven roles read the evidence and write the brief'], build: ['System', 'Builds the contract and checks it'], decision: ['System', 'Writes one request with exact limits'], approve: ['You or the agent', 'Approved by you, or by the agent inside your limits in Auto'], deploy: ['You or the agent', 'The contract is sent to the chain'], verify: ['Chain', 'The receipt is compared with the checked build'], monitor: ['System', 'Re-checked on every scheduled check'] };
const STATE_WORD = { done: 'Done', active: 'Now', blocked: 'Stopped', todo: 'Waiting' };

/** Fades a chapter in once, the first time it scrolls into view. Without IntersectionObserver or with reduced motion it is simply shown. */
function useReveal() {
  const ref = useRef(null); const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ref.current || reduce() || typeof IntersectionObserver !== 'function') { setOn(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } }, { threshold: 0.12 }); io.observe(ref.current); return () => io.disconnect();
  }, []);
  return [ref, on];
}
function Chapter({ id, n, title, lead, children }) {
  const [ref, on] = useReveal();
  return (
    <section id={id} ref={ref} className={`cn-ch${on ? ' in' : ''}`} aria-labelledby={`${id}-h`}>
      <header><span className="cn-n" aria-hidden="true">{n}</span><div><h2 id={`${id}-h`}>{title}</h2><p className="dim">{lead}</p></div></header>
      {children}
    </section>
  );
}

/** The whole story in one line of four stops. The stop where the product is right now pulses; dots flow along the finished links. */
function Story({ stops, here }) {
  return (
    <ol className="cn-story" aria-label="From evidence to outcome">
      {stops.map((s, i) => (
        <li key={s.id} className={`cn-stop${i === here ? ' here' : ''}${i < here ? ' past' : ''}`}>
          <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' }); }}>
            <span className="cn-dotgrid" aria-hidden="true">{Array.from({ length: 25 }, (_, q) => <i key={q} style={{ '--d': `${(q % 5) * 0.12 + Math.floor(q / 5) * 0.12}s`, '--on': s.fill > q / 25 ? 1 : 0.18 }} />)}</span>
            <span className="cn-stop-t"><small>{s.kicker}</small><b>{s.big}</b><em>{s.sub}</em></span>
          </a>
          {i < stops.length - 1 && <span className="cn-link-flow" aria-hidden="true"><i /><i /><i /></span>}
        </li>
      ))}
    </ol>
  );
}

function Rail({ j, mode }) {
  if (!j) return null;
  const stages = [{ id: 'verdict', label: 'Council verdict', state: 'done', detail: 'The council backed it' }, ...j.stages]; const cur = stages.findIndex((x) => x.state === 'active' || x.state === 'blocked'); const upto = cur < 0 ? stages.filter((x) => x.state === 'done').length - 1 : cur;
  return (
    <ol className="cn-rail" aria-label="Execution steps">
      {stages.map((s, i) => {
        const who = WHO[s.id] ?? ['Council', 'The seven seats voted'];
        return (
          <li key={s.id} className={`cn-rs ${s.state}`}>
            <span className="cn-rs-dot" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'blocked' ? '!' : i + 1}</span>
            <div className="cn-rs-b"><b>{s.label}</b><span className="cn-rs-w">{STATE_WORD[s.state]} · {who[0]}</span><p>{s.detail}</p><small className="faint">{who[1]}</small></div>
            {i < stages.length - 1 && <span className="cn-rs-bar" aria-hidden="true"><i style={{ transform: `scaleY(${i < upto ? 1 : 0})` }} />{i === upto && s.state !== 'blocked' && s.state !== 'todo' && <u />}</span>}
          </li>
        );
      })}
      <li className="cn-mode-note"><b>{mode === 'auto' ? 'Auto mode' : 'Manual mode'}</b> {mode === 'auto' ? 'The agent runs the approval and deploy steps itself, but only for a product the council backs and only inside your limits.' : 'Every approval and deploy step waits for you. The council only advises.'}</li>
    </ol>
  );
}

function Pod({ oc }) {
  const col = OUTC[oc?.state ?? 'not_started']; const n = 100; const lit = Math.round(((oc?.progress?.done ?? 0) / Math.max(1, oc?.progress?.total ?? 1)) * n);
  return (
    <svg className="cn-pod" viewBox="0 0 120 120" role="img" aria-label={`Outcome: ${oc?.headline ?? 'nothing in flight'}. ${oc?.progress?.done ?? 0} of ${oc?.progress?.total ?? 0} steps done.`}>
      <defs><radialGradient id="cn-pg"><stop offset="0" stopColor={col} stopOpacity=".28" /><stop offset="1" stopColor={col} stopOpacity="0" /></radialGradient></defs>
      <circle cx="60" cy="60" r="58" fill="url(#cn-pg)" />
      {Array.from({ length: n }, (_, q) => { const x = (q % 10) - 4.5; const y = Math.floor(q / 10) - 4.5; if (x * x + y * y > 21) return null; const rank = (9 - Math.floor(q / 10)) * 10 + (q % 10); const on = rank < lit; return <circle key={q} cx={60 + x * 10} cy={60 + y * 10} r={on ? 3.2 : 1.9} fill={on ? col : '#4a4f55'} opacity={on ? 1 : 0.5} className={on ? 'cn-pd on' : 'cn-pd'} style={{ animationDelay: `${(q % 10) * 0.08}s` }} />; })}
    </svg>
  );
}

export default function Council({ data, opts }) {
  const api = useApi('/api/council', { poll: 30000 });
  const [pick, setPick] = useState(null); const [replay, setReplay] = useState(0); const [proof, setProof] = useState(null);
  const council = api.data?.council; const journey = api.data?.journey; const mode = api.data?.mode ?? data.autonomy?.mode ?? 'manual';
  const list = council?.opportunities ?? [];
  const entry = useMemo(() => list.find((o) => o.oppId === pick) ?? list.find((o) => o.oppId === journey?.oppId) ?? list[0], [list, pick, journey]);
  if (api.error && !council) return <div className="ap-wrap"><p role="alert">Could not load the council. <button type="button" className="btn sm" onClick={api.reload}>Retry</button></p></div>;
  if (!council) return <div className="ap-wrap"><p className="faint" role="status">Counting the votes…</p></div>;
  if (!entry) return <div className="ap-wrap"><h1 className="ap-h1">Council</h1><p className="dim">No opportunity has been scored yet. The council convenes after the first collection.</p></div>;
  const rules = council.rules; const live = entry.oppId === journey?.oppId; const oc = live ? journey.outcome : null; const stages = live ? journey.stages : [];
  const records = data.status?.data?.counts?.evidence; const srcs = data.status?.data?.sources ?? []; const srcOk = srcs.filter((x) => x.status === 'ok').length;
  const cur = stages.findIndex((x) => x.state === 'active' || x.state === 'blocked'); const doneN = stages.filter((x) => x.state === 'done').length;
  const here = !live ? 1 : oc && ['shipped', 'live', 'failed'].includes(oc.state) ? 3 : cur >= 0 || doneN > 0 || ['waiting', 'held', 'in_progress'].includes(oc?.state) ? 2 : 1;
  const stops = [
    { id: 'ch-seen', kicker: '1 · SEEN', big: <CountUp value={records ?? 0} />, sub: `records from ${srcOk || srcs.length || 0} sources`, fill: 1 },
    { id: 'ch-voted', kicker: '2 · VOTED', big: entry.verdict.toUpperCase(), sub: `score ${q(entry.support)} of ${q(rules.goAt)} needed`, fill: entry.support },
    { id: 'ch-next', kicker: '3 · EXECUTING', big: live ? `${doneN} of ${stages.length}` : '—', sub: live ? 'steps done' : 'pick the top product', fill: live ? doneN / Math.max(1, stages.length) : 0 },
    { id: 'ch-out', kicker: '4 · OUTCOME', big: oc ? oc.headline : 'Not started', sub: oc ? oc.next : '', fill: oc ? oc.progress.done / Math.max(1, oc.progress.total) : 0 },
  ];
  const checks = [
    [`The council score, ${q(entry.support)} out of 100, reaches the ${q(rules.goAt)} needed`, entry.support >= rules.goAt], [`The evidence is trusted enough: ${q(entry.confidence ?? 0)} out of 100, ${q(rules.minConfidence)} needed`, (entry.confidence ?? 0) >= rules.minConfidence],
    [entry.vetoes.length ? `${entry.vetoes.join(' and ')} vetoed it` : 'Neither the Skeptic nor Security vetoed it', entry.vetoes.length === 0], [entry.buildable ? 'A contract template exists, so it can be built and checked' : 'No contract template exists for this topic yet', entry.buildable],
  ];
  const vd = VERDICT[entry.verdict];
  return (
    <div className="ap-wrap cn">
      <header className="cn-head">
        <div><h1 className="ap-h1">Council</h1><p className="dim">One product, one story: what the agent saw, who voted, what was decided, and where it stands on the way to a deployed contract.</p></div>
        <div className="row"><a className="btn sm primary" href={href('build', opts)}>Build a product page</a><a className="btn sm" href="#/constellation">See it in the constellation</a></div>
      </header>
      <p className="cn-now" role="status"><span className="cn-pulse-dot" style={{ background: vd[2] }} aria-hidden="true" /><b>{entry.title}</b> · {vd[1].toLowerCase()}. {oc ? `${oc.headline}. ${oc.next}` : 'Pick the top opportunity in the ranking to follow it all the way.'}</p>
      <Story stops={stops} here={here} />

      <Chapter id="ch-seen" n="1" title="What did it see?" lead="Public posts, on-chain activity and official sources, stored with a link back to the original.">
        <div className="cn-seen">
          <div className="cn-big"><b><CountUp value={records ?? 0} /></b><span>stored records</span></div>
          <div className="cn-big"><b>{srcOk || srcs.length}</b><span>sources working{srcs.length ? ` of ${srcs.length}` : ''}</span></div>
          <div className="cn-bars" role="img" aria-label="Records in the last 14 days against the 14 days before, per product">
            {list.map((o) => { const m = Math.max(1, ...list.map((x) => Math.max(x.recent, x.prior))); return (
              <div key={o.oppId} className="cn-bar-row"><span>{o.title}</span><span className="cn-pair"><i style={{ width: `${(o.recent / m) * 100}%` }} className="now" /><i style={{ width: `${(o.prior / m) * 100}%` }} className="was" /></span><em className="num">{o.recent} / {o.prior}</em></div>); })}
            <p className="faint cn-note">Bright bar: records in the last {rules.trendWindowDays} days. Dim bar: the {rules.trendWindowDays} days before. A longer bright bar means the topic is speeding up.</p>
          </div>
        </div>
      </Chapter>

      <Chapter id="ch-voted" n="2" title="Who voted, and how?" lead="Seven seats, each with its own question. A vote is a number from stored data, with the reason beside it.">
        <div className="cn-row"><div><span className="eyebrow">Voting on</span><h3>{entry.title}</h3></div><button type="button" className="btn sm" onClick={() => setReplay(replay + 1)}>Replay the vote</button></div>
        <Chamber entry={entry} rules={rules} replayKey={replay} onSeat={(v) => setProof(v)} onVerdict={() => setProof('verdict')} />
        <ul className="cn-reasons">{entry.votes.map((v) => <li key={v.role}><i style={{ background: COL[v.stance] }} aria-hidden="true" /><b>{SEAT_LABEL[v.role]}</b><span className="num">{q(v.support)}</span><span className="dim">{v.reason}</span></li>)}</ul>
        <p className="faint cn-note">Each seat gives a number from 0 to 100 for its own question. The animation replays the stored votes; it is not a live vote and no AI opinion is involved. Click a seat or the verdict to see its proof and the chain links.</p>
      </Chapter>

      <Chapter id="ch-decide" n="3" title="What did it decide?" lead="Four plain checks. All four must pass for a GO.">
        <div className="cn-explain"><b>What does the council score mean?</b><p>Each seat answers one question about this product with a number from 0 to 100, such as &ldquo;is there real demand?&rdquo; or &ldquo;can it be built safely?&rdquo;. The council score is their average, with more weight on the questions that matter most. It is <em>not</em> a chance of success. It says how strongly the stored evidence supports building this now.</p><ul><li><b>{q(rules.goAt)} or more</b> and no veto: build it</li><li><b>{q(rules.watchAt)} to {q(rules.goAt) - 1}</b>: keep watching</li><li><b>Under {q(rules.watchAt)}</b>: not now</li></ul></div>
        <div className="cn-decide">
          <div className="cn-verdict" style={{ '--c': vd[2] }}><b>{vd[0]}</b><span>{vd[1]}</span></div>
          <ul className="cn-checks">{checks.map(([t, ok]) => <li key={t} className={ok ? 'ok' : 'no'}><i aria-hidden="true">{ok ? '✓' : '✗'}</i>{t}</li>)}</ul>
        </div>
        <h3 className="cn-sub">Every product, ranked</h3>
        <ul className="cn-rank">
          {list.map((o) => { const v = VERDICT[o.verdict]; return (
            <li key={o.oppId} aria-current={o.oppId === entry.oppId} onClick={() => { setPick(o.oppId); setReplay((r) => r + 1); }}>
              <button type="button" className="cn-link" onClick={() => { setPick(o.oppId); setReplay((r) => r + 1); }}>{o.title}</button>
              <span className="cn-meter" aria-label={`council score ${q(o.support)} out of 100`}><i style={{ width: `${o.support * 100}%`, background: v[2] }} /><u style={{ left: `${rules.watchAt * 100}%` }} /><u style={{ left: `${rules.goAt * 100}%` }} /></span>
              <span className="cn-dots" aria-label="seat votes">{o.votes.map((x) => <i key={x.role} title={`${SEAT_LABEL[x.role]}: ${q(x.support)} out of 100, ${STANCE_WORD[x.stance]}`} style={{ background: COL[x.stance] }} />)}</span>
              <span className="chip" style={{ borderColor: v[2], color: v[2] }}>{v[0]}</span>
              <small className="faint">{o.momentum > 0.55 ? '▲ rising' : o.momentum < 0.45 ? '▼ cooling' : '● steady'}{o.buildable ? '' : ' · cannot be built yet'}</small>
            </li>); })}
        </ul>
        <p className="faint cn-note">Bars show each product&rsquo;s council score out of 100. The thin marks are {q(rules.watchAt)} (keep watching) and {q(rules.goAt)} (build). Dots are the seven seats: green backs it, amber unsure, red objects. Counted {fmt.ago(council.at)}.</p>
      </Chapter>

      <Chapter id="ch-next" n="4" title="What happens next?" lead="From a GO to a contract on the chain. Each step shows who does it and where it stands.">
        {live ? <Rail j={journey} mode={mode} /> : <p className="dim">The live journey is shown for the top product. Pick it in the ranking above.</p>}
      </Chapter>

      <Chapter id="ch-out" n="5" title="Where does it end up?" lead="The final judgement is read from stored runs, requests, deployments and checks. Nothing here is guessed.">
        <div className="cn-outcome" style={{ '--c': OUTC[oc?.state ?? 'not_started'] }}>
          <Pod oc={oc} />
          <div><b className="cn-out-h">{oc ? oc.headline : 'Not started'}</b><p>{oc ? oc.detail : 'No product is in flight for this one.'}</p>{oc && <p className="dim">Next: {oc.next}</p>}
            {journey?.deployment?.explorer && <a className="btn sm" href={journey.deployment.explorer} target="_blank" rel="noopener noreferrer">View on the explorer</a>}</div>
        </div>
      </Chapter>
      {proof && <ProofDialog entry={entry} seat={proof === 'verdict' ? null : proof} council={council} journey={journey} onClose={() => setProof(null)} />}
    </div>
  );
}
