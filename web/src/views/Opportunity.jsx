// Opportunity dossier: thesis, published score decomposition, evidence graph, competitor map, unknowns, decision history, start-run control.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Chip, Empty, ErrorPanel, Icon, Led, Meter, NeedsOperator, Panel, Skeleton, SkeletonRows, Status, StaleNote, useToast } from '../ui.jsx';
import { EvidenceDrawer, FlagChips, Freshness, SourceTag, TOPIC_LABEL } from './_evidence-parts.jsx';
import './opportunity.css';

const REL = [
  ['supports', 'Supporting', 'ok', 'Friction or demand signals that back the thesis'],
  ['contradicts', 'Contradicting', 'bad', 'Text that suggests the need is already addressed'],
  ['competitor', 'Competitor mentions', 'mineral', 'Records that mention an existing product'],
  ['usage', 'On-chain usage', 'mineral', 'Direct observations of related on-chain activity'],
];
const COMP = {
  independent_demand: ['Independent demand', 'Distinct authors and sources among clean demand records'],
  recency: ['Recency', 'Exponential decay (45-day scale) over clean records'],
  onchain_corroboration: ['On-chain corroboration', 'Any usage observation for this topic (0 or 1)'],
  friction_severity: ['Friction severity', 'Share of clean records using friction language'],
  competition_gap: ['Competition gap', 'One minus the best curated competitor coverage'],
  near_fit: ['NEAR fit', 'Human judgement of how well NEAR primitives fit'],
  feasibility: ['Feasibility', 'Human judgement of build feasibility'],
  evidence_quality: ['Evidence quality', 'Mean relevance times the share of clean records'],
};
const SEG = ['#5fa3c2', '#d9a6e8', '#f0c27b', '#7fd6c4', '#e58fa0', '#a3b8f0', '#c9d98a', '#f0a37b'];
const f3 = (x) => (x ?? 0).toFixed(3);
const f2 = (x) => (x ?? 0).toFixed(2);

/* ------------------------------------------------------------------ pieces */
function OppIndex({ items, current, loading, error, reload }) {
  return (
    <nav className="op-index" aria-label="All opportunities">
      <p className="eyebrow">Opportunities, ranked</p>
      {loading && !items && <SkeletonRows n={4} />}
      {error && !items && <ErrorPanel error={error} onRetry={reload} what="opportunities" />}
      {items && !items.length && <Empty title="No opportunities yet">They appear once the collector stores tagged evidence.</Empty>}
      {items && items.length > 0 && (
        <ul className="op-idx-list">
          {items.map((o) => (
            <li key={o.id}>
              <a className="op-idx" href={`#/opportunity/${o.id}`} aria-current={o.id === current ? 'page' : undefined}>
                <span className="op-idx-t">{o.title}</span>
                <span className="op-idx-m"><b className="num">{f2(o.score)}</b><span className="faint">score</span>
                  <Meter value={o.confidence} label={`confidence ${f2(o.confidence)}`} /><span className="faint num">{f2(o.confidence)} conf.</span>
                  {o.warnings?.some((w) => w.startsWith('LOW CONFIDENCE')) && <Chip tone="bad">low conf.</Chip>}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function Decomposition({ sb, score }) {
  const comps = sb.components ?? {}; const w = sb.weights ?? {}; const priors = new Set(sb.priors ?? []);
  const keys = Object.keys(w);
  const rows = keys.map((k, i) => ({ k, w: w[k], v: comps[k] ?? 0, c: (w[k] ?? 0) * (comps[k] ?? 0), prior: priors.has(k), color: SEG[i % SEG.length] }));
  const sum = rows.reduce((a, r) => a + r.c, 0);
  return (
    <Panel title="Score decomposition" aside={<span className="num faint">published formula · 8 weighted components</span>}>
      <div className="op-score-head">
        <div className="kpi"><b>{f3(score)}</b><span className="eyebrow">score, 0 to 1</span></div>
        <p className="dim op-formula">Each component is in [0,1]. Contribution is weight times value. Hatched parts are curated priors that nobody measured; the rest is computed from stored evidence.</p>
      </div>
      <div className="op-stack" role="img" aria-label={`Score ${f3(score)} built from ${rows.map((r) => `${COMP[r.k]?.[0] ?? r.k} ${f3(r.c)}`).join(', ')}`}>
        {rows.map((r) => <i key={r.k} className={r.prior ? 'prior' : ''} style={{ width: `${r.c * 100}%`, '--c': r.color }} />)}
      </div>
      <div className="op-stack-scale mono" aria-hidden="true"><span>0</span><span>unused headroom to 1.0</span></div>
      <table className="tbl op-tbl">
        <thead><tr><th scope="col">Component</th><th scope="col" className="r">Weight</th><th scope="col">Value</th><th scope="col" className="r">Contribution</th><th scope="col">Basis</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <th scope="row" data-l="Component"><span className="op-sw" style={{ '--c': r.color }} aria-hidden="true" /><span>{COMP[r.k]?.[0] ?? r.k}<small>{COMP[r.k]?.[1]}</small></span></th>
              <td className="num r" data-l="Weight">{f2(r.w)}</td>
              <td data-l="Value"><span className="op-val"><Meter value={r.v} tone={r.prior ? 'warn' : ''} label={`${COMP[r.k]?.[0]} value ${f2(r.v)}`} /><b className="num">{f2(r.v)}</b></span></td>
              <td className="num r" data-l="Contribution">{f3(r.c)}</td>
              <td data-l="Basis">{r.prior ? <Chip tone="warn" title="Curated prior from a human, not measured from evidence"><Icon name="key" size={12} />curated prior</Chip> : <Chip tone="ok">measured</Chip>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th scope="row" data-l="Component">Sum of contributions</th><td className="r" /><td /><td className="num r" data-l="Contribution"><b>{f3(sum)}</b></td><td className="faint mono-v" data-l="Basis">{Math.abs(sum - score) < 0.002 ? 'matches stored score' : `stored score ${f3(score)}`}</td></tr></tfoot>
      </table>
    </Panel>
  );
}

function Confidence({ opp }) {
  const sb = opp.score_breakdown ?? {}; const c = sb.counts ?? {};
  const low = (opp.warnings ?? []).some((w) => w.startsWith('LOW CONFIDENCE'));
  return (
    <Panel title="Confidence" tone={low ? 'risk' : undefined} aside={<Chip tone={low ? 'bad' : 'ok'}>{low ? 'low confidence' : 'adequate breadth'}</Chip>}>
      <div className="op-conf">
        <div className="kpi"><b>{f2(opp.confidence)}</b><span className="eyebrow">trust in the score</span></div>
        <div className="stack-s" style={{ flex: 1, minWidth: 200 }}>
          <Meter value={opp.confidence} label={`Confidence ${f2(opp.confidence)}`} />
          <p className="help">Confidence is not the score. It measures how much evidence breadth sits behind it: 35% sources (target 3), 25% distinct authors (target 8), 15% any on-chain usage, 25% evidence quality.</p>
        </div>
      </div>
      <dl className="op-counts">
        <div><dt>Sources</dt><dd className={`num ${c.sources < 3 ? 'bad' : ''}`}>{c.sources ?? 0}<span className="faint"> / 3 needed</span></dd></div>
        <div><dt>Authors</dt><dd className={`num ${c.authors < 8 ? 'warn' : ''}`}>{c.authors ?? 0}<span className="faint"> / 8 target</span></dd></div>
        <div><dt>Demand records</dt><dd className="num">{c.demand ?? 0}<span className="faint"> ({c.clean ?? 0} clean)</span></dd></div>
        <div><dt>Usage records</dt><dd className={`num ${c.usage ? '' : 'warn'}`}>{c.usage ?? 0}</dd></div>
        <div><dt>Friction language</dt><dd className="num">{c.friction ?? 0}</dd></div>
      </dl>
    </Panel>
  );
}

function EvidenceGraph({ opp, groups, total, onOpen }) {
  const W = 720; const H = 440; const cx = W / 2; const cy = H / 2;
  const pos = { supports: [150, 125], contradicts: [570, 125], competitor: [150, 315], usage: [570, 315] };
  const jump = (rel) => { const el = document.getElementById(`op-rel-${rel}`); el?.scrollIntoView({ block: 'start' }); el?.querySelector('button, a')?.focus({ preventScroll: true }); };
  const summary = REL.map(([k, l]) => `${l}: ${groups[k].length}`).join('; ');
  return (
    <Panel title="Evidence graph" aside={<span className="faint mono">{total} linked records</span>}>
      <svg className="op-graph" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Evidence graph for ${opp.title}. ${summary}. The lists below contain the same records.`}>
        {REL.map(([k, , tone]) => {
          const [x, y] = pos[k]; const n = groups[k].length;
          return <line key={k} x1={cx} y1={cy} x2={x} y2={y} className={`g-edge ${tone}`} strokeWidth={n ? 1 + Math.min(4, Math.log2(n + 1)) : 1} strokeDasharray={n ? undefined : '3 5'} />;
        })}
        {REL.map(([k, label, tone]) => {
          const [x, y] = pos[k]; const items = groups[k]; const shown = items.slice(0, 36);
          return (
            <g key={k}>
              <g aria-hidden="true">
                {shown.map((e, i) => {
                  const a = i * 2.39996; const r = 40 + 5.2 * Math.sqrt(i + 1) * 1.6;
                  const dx = x + Math.cos(a) * r; const dy = y + Math.sin(a) * r * 0.82;
                  return (
                    <circle key={e.id + k} cx={dx} cy={dy} r={e.flags?.length ? 5.5 : 4.5} className={`g-dot ${tone} ${e.flags?.length ? 'flag' : ''}`} onClick={() => onOpen(e)}>
                      <title>{e.title}</title>
                    </circle>
                  );
                })}
              </g>
              <g className="g-hub" role="button" tabIndex={0} aria-label={`${label}: ${items.length} records. Jump to list.`} onClick={() => jump(k)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jump(k); } }}>
                <circle cx={x} cy={y} r="28" className={`g-hub-c ${tone}`} />
                <text x={x} y={y + 6} textAnchor="middle" className="g-n">{items.length}</text>
              </g>
              <text x={x} y={y < cy ? 24 : H - 24} textAnchor="middle" className="g-l" aria-hidden="true">{label.toUpperCase()}</text>
              {items.length > shown.length && <text x={x} y={y < cy ? 40 : H - 8} textAnchor="middle" className="g-s" aria-hidden="true">showing {shown.length} of {items.length}</text>}
            </g>
          );
        })}
        <g aria-hidden="true">
          <circle cx={cx} cy={cy} r="52" className="g-core" />
          <text x={cx} y={cy - 2} textAnchor="middle" className="g-core-n">{f2(opp.score)}</text>
          <text x={cx} y={cy + 18} textAnchor="middle" className="g-s">score</text>
        </g>
      </svg>
      <p className="help">Dots are evidence records; click one for its provenance. Ringed dots carry a bot, duplicate or injection flag. Each count also appears as a list below.</p>
    </Panel>
  );
}

function EvRow({ e, onOpen }) {
  return (
    <li>
      <button type="button" className="li op-ev" onClick={() => onOpen(e)}>
        <span className="op-ev-t">{e.title}</span>
        <span className="op-ev-m"><SourceTag id={e.source_id} /><Freshness e={e} /><FlagChips flags={e.flags} />
          <span className="cite" aria-hidden="true">{e.id.slice(0, 11)}…</span></span>
        {e.link_note && <span className="faint op-ev-n">{e.link_note}</span>}
      </button>
    </li>
  );
}

function EvidenceLists({ groups, onOpen }) {
  const [more, setMore] = useState({});
  return (
    <div className="op-lists">
      {REL.map(([k, label, tone, help]) => {
        const items = groups[k]; const all = more[k]; const shown = all ? items : items.slice(0, 6);
        return (
          <Panel key={k} title={`${label} · ${items.length}`} id={`op-rel-${k}`} tone={k === 'contradicts' && items.length ? 'risk' : undefined} pad={false}>
            <p className="help op-lh">{help}</p>
            {items.length === 0 ? <Empty title={`No ${label.toLowerCase()} records`}>{k === 'usage' ? 'No on-chain observation is linked to this topic.' : 'Nothing is linked under this relation.'}</Empty> : (
              <>
                <ul className="list">{shown.map((e) => <EvRow key={e.id + k} e={e} onOpen={onOpen} />)}</ul>
                {items.length > 6 && <div className="op-more"><button className="btn sm" onClick={() => setMore((m) => ({ ...m, [k]: !all }))} aria-expanded={Boolean(all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button></div>}
              </>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/** Finds the latest brief for this opportunity: newest run that has a `brief` artifact. */
function useBrief(runs, oppId) {
  const [s, set] = useState({ loading: true, brief: null, run: null, error: null });
  const key = (runs ?? []).map((r) => r.id).join(',');
  useEffect(() => {
    let alive = true;
    if (!runs) return undefined;
    if (!runs.length) { set({ loading: false, brief: null, run: null, error: null }); return undefined; }
    set((x) => ({ ...x, loading: true, error: null }));
    (async () => {
      try {
        for (const r of runs.slice(0, 5)) {
          const d = await api(`/api/runs/${r.id}`);
          const art = d.artifacts?.find((a) => a.kind === 'brief');
          if (art) { const a = await api(`/api/artifacts/${art.id}`); if (alive) set({ loading: false, brief: a.content, run: r, error: null }); return; }
        }
        if (alive) set({ loading: false, brief: null, run: null, error: null });
      } catch (e) { if (alive) set({ loading: false, brief: null, run: null, error: e }); }
    })();
    return () => { alive = false; };
  }, [key, oppId]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

function CompetitorMap({ b, nMentions }) {
  return (
    <Panel title="Competitor map" aside={b.brief?.existingSolutions?.length ? <span className="faint mono">from run {b.run.id.slice(0, 12)}</span> : null}>
      {b.loading && <div className="stack-s" role="status" aria-label="Loading competitor map"><Skeleton h={44} /><Skeleton h={44} /></div>}
      {b.error && <div className="banner risk" role="alert"><Icon name="alert" /><span>Could not read the latest brief: {b.error.message}</span></div>}
      {!b.loading && !b.error && !b.brief && (
        <Empty title="No competitor analysis yet">The Skeptic builds this map during a research run from a curated registry. No run for this opportunity has produced a brief, so nothing is shown rather than a guess.{nMentions ? ` ${nMentions} evidence record(s) already mention an existing product (see the competitor list).` : ''}</Empty>
      )}
      {b.brief && (
        b.brief.existingSolutions?.length ? (
          <>
            <ul className="op-comp">
              {b.brief.existingSolutions.map((c) => (
                <li key={c.name}>
                  <div className="op-comp-h"><a href={c.url} target="_blank" rel="noreferrer noopener">{c.name}<Icon name="external" size={13} /></a><span className="num">{Math.round(c.coverage * 100)}% covered</span></div>
                  <Meter value={c.coverage} tone={c.coverage >= 0.6 ? 'risk' : c.coverage >= 0.4 ? 'warn' : ''} label={`${c.name} covers about ${Math.round(c.coverage * 100)} percent`} />
                  <p className="dim">{c.note}</p>
                </li>
              ))}
            </ul>
            <p className="help">Coverage is a curated judgement ({b.brief.existingSolutions[0]?.source ?? 'registry'}, reviewed {b.brief.existingSolutions[0]?.reviewed ?? 'date unknown'}), not a measurement. Higher coverage lowers the competition-gap component.</p>
          </>
        ) : <Empty title="No known competitors recorded">The brief lists no existing solutions for this topic, which may mean the registry has no entry rather than that none exist.</Empty>
      )}
    </Panel>
  );
}

function Unknowns({ opp, brief }) {
  const items = [];
  for (const w of opp.warnings ?? []) if (!w.startsWith('LOW CONFIDENCE')) items.push([w, 'score warning']);
  for (const c of brief?.counterevidence ?? []) if (!c.citations?.length) items.push([c.claim, 'skeptic']);
  for (const q of brief?.unresolvedQuestions ?? []) items.push([q, 'architect']);
  return (
    <Panel title="Unknowns" aside={<span className="faint mono">{items.length} open</span>}>
      {items.length ? <ul className="op-unk">{items.map(([t, from], i) => <li key={i}><Chip>{from}</Chip><span>{t}</span></li>)}</ul> : <Empty title="No open unknowns recorded">Absence of warnings is not proof of validity.</Empty>}
      {!brief && <p className="help">Run the research pipeline to add the Skeptic&rsquo;s gaps and the Architect&rsquo;s open questions.</p>}
    </Panel>
  );
}

function History({ runs, brief }) {
  return (
    <Panel title="Decision history" aside={<span className="faint mono">{runs.length} run{runs.length === 1 ? '' : 's'}</span>}>
      {brief?.decision && (
        <div className="banner" role="note"><Icon name="check" /><div><b>Latest skeptic verdict: {brief.decision.verdict?.replace('_', ' ')}</b><div className="dim">{brief.decision.rationale}</div></div></div>
      )}
      {runs.length === 0 ? <Empty title="No research runs yet">Nothing has been decided about this opportunity. Start a run below (operator only).</Empty> : (
        <ul className="op-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <a className="op-run" href={`#/run/${r.id}`}>
                <Status state={r.state} />
                <span className="mono-v">{r.id}</span>
                <span className="faint">{r.trigger} · {fmt.ago(r.started_at)}{r.ended_at ? ` · ${Math.max(1, Math.round((r.ended_at - r.started_at) / 1000))}s` : ' · in progress'}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function StartRun({ oppId, token, status }) {
  const protos = useApi('/api/protocols');
  const toast = useToast();
  const [chain, setChain] = useState('near-testnet'); const [owner, setOwner] = useState(''); const [proposer, setProposer] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const idem = useRef(null);
  const groups = useMemo(() => Object.entries(protos.data?.protocols ?? {})
    .filter(([, p]) => p.status === 'implemented')
    .map(([k, p]) => [k, p.label, p.networks.filter((n) => !n.mainnet && !/mainnet/i.test(`${n.id} ${n.label}`))])
    .filter(([, , n]) => n.length), [protos.data]);
  const planned = Object.values(protos.data?.protocols ?? {}).filter((p) => p.status !== 'implemented').map((p) => p.label.split(' ')[0]);
  const paused = status?.data?.paused; const active = status?.data?.activeRun;
  const valid = groups.some(([, , n]) => n.some((x) => x.id === chain));

  const submit = async (e) => {
    e.preventDefault(); if (busy || !valid) return;
    setBusy(true); setErr(null);
    idem.current ??= crypto.randomUUID();
    try {
      const body = { opportunityId: oppId, chain };
      if (owner.trim()) body.owner = owner.trim();
      if (proposer.trim()) body.proposer = proposer.trim();
      const res = await api('/api/runs', { method: 'POST', body, idem: idem.current });
      idem.current = null;
      toast(res.created ? 'Research run started' : 'That request was already submitted; opening the existing run');
      status?.reload?.();
      location.hash = `#/run/${res.run.id}`;
    } catch (x) {
      if (x.status !== 0) idem.current = null; // keep the key only when the outcome is unknown (network drop)
      setErr(x); toast(x.message, 'bad');
    } finally { setBusy(false); }
  };

  return (
    <Panel title="Start a research run" tone={undefined}>
      <NeedsOperator token={token} hint="Operator token required to start runs">
        <form onSubmit={submit} className="op-form" noValidate>
          <div className="field">
            <label htmlFor="sr-chain">Target network</label>
            <select id="sr-chain" className="select" value={chain} onChange={(e) => setChain(e.target.value)} disabled={busy || !groups.length}>
              {groups.map(([k, label, nets]) => <optgroup key={k} label={label}>{nets.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>)}
            </select>
            <span className="help">Testnets only. Mainnet is not offered by this console and no run can deploy.{planned.length ? ` Planned, no code yet: ${planned.join(', ')}.` : ''}</span>
          </div>
          <div className="field">
            <label htmlFor="sr-owner">Owner account (optional)</label>
            <input id="sr-owner" className="input mono-i" value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={128} placeholder="alice.testnet" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="sr-prop">Proposer account (optional)</label>
            <input id="sr-prop" className="input mono-i" value={proposer} onChange={(e) => setProposer(e.target.value)} maxLength={128} placeholder="bob.testnet" autoComplete="off" spellCheck={false} />
          </div>
          <div className="op-form-act">
            <button className="btn primary" type="submit" disabled={busy || !valid || paused}>{busy ? 'Starting…' : <><Icon name="play" size={16} />Start research run</>}</button>
            <span className="help">Budget is capped per run. Runs only collect, analyse and draft; a human approves every consequential step.</span>
          </div>
          {paused && <div className="banner risk" role="status"><Icon name="alert" /><span>Kill switch is engaged: new runs are blocked until it is released.</span></div>}
          {!paused && active && <div className="banner warn" role="status"><Icon name="alert" /><span>Run <a href={`#/run/${active.id}`}>{active.id}</a> is already {active.state}. A new run will queue alongside it.</span></div>}
          {protos.error && !protos.data && <ErrorPanel error={protos.error} onRetry={protos.reload} what="network list" />}
          {err && <div className="banner risk" role="alert"><Icon name="alert" /><span>{err.status === 401 ? 'The API refused this token. Sign in again from the top bar.' : err.message}</span></div>}
        </form>
      </NeedsOperator>
    </Panel>
  );
}

/* ------------------------------------------------------------------ view */
export default function Opportunity({ params, status, token }) {
  const id = /^\w+$/.test(params[0] ?? '') ? params[0] : 'opp_treasury';
  const list = useApi('/api/opportunities', { poll: 60000 });
  const one = useApi(`/api/opportunities/${id}`, { poll: 60000 });
  const [open, setOpen] = useState(null);
  useEffect(() => setOpen(null), [id]);
  const o = one.data;
  const brief = useBrief(o?.runs, id);
  const groups = useMemo(() => {
    const g = { supports: [], contradicts: [], competitor: [], usage: [] };
    for (const e of o?.evidence ?? []) (g[e.relation] ?? (g[e.relation] = [])).push(e);
    return g;
  }, [o]);
  const notFound = one.error?.status === 404;
  const low = o?.warnings?.find((w) => w.startsWith('LOW CONFIDENCE'));

  return (
    <div className="page op">
      <div className="op-layout">
        <aside className="op-side">
          <OppIndex items={list.data?.items} current={id} loading={list.loading} error={list.error} reload={list.reload} />
        </aside>
        <div className="op-body">
          {one.loading && !o && <div className="stack"><Skeleton h={72} w="70%" /><Skeleton h={140} /><Skeleton h={320} /></div>}
          {notFound && <Empty title="Opportunity not found" action={<a className="btn" href="#/opportunity/opp_treasury">Open the treasury dossier</a>}>No opportunity has the id <span className="mono-v">{id}</span>. Pick one from the list.</Empty>}
          {one.error && !notFound && !o && <ErrorPanel error={one.error} onRetry={one.reload} what="this dossier" />}
          {o && (
            <>
              <header className="op-head">
                <p className="eyebrow">Opportunity dossier · {TOPIC_LABEL[o.topic] ?? o.topic}{one.stale && <> · <StaleNote at={one.at} /></>}</p>
                <h1 className="display op-h1">{o.title}</h1>
                <div className="row op-head-m"><Chip tone="mineral">{o.status}</Chip><span className="mono-v faint">{o.id}</span><span className="mono-v faint">updated {fmt.ago(o.updated_at)}</span></div>
              </header>

              {low && (
                <div className="banner risk op-low" role="alert">
                  <Icon name="alert" />
                  <div><b>LOW CONFIDENCE</b><div>{low.replace(/^LOW CONFIDENCE:\s*/, '')}</div><div className="dim">Treat the score as a lead to check, not a finding. The Skeptic will discount it further during a run.</div></div>
                </div>
              )}

              <section className="op-brief" aria-label="Thesis, problem and audience">
                <div><h2 className="eyebrow">Thesis</h2><p>{o.thesis}</p></div>
                <div><h2 className="eyebrow">Problem</h2><p>{o.problem}</p></div>
                <div><h2 className="eyebrow">Audience</h2><p>{o.audience}</p></div>
              </section>

              <div className="stack">
                <Decomposition sb={o.score_breakdown} score={o.score} />
                <Confidence opp={o} />
                <EvidenceGraph opp={o} groups={groups} total={o.evidence.length} onOpen={(e) => setOpen(e)} />
                {o.evidenceTotal > o.evidence.length && <div className="banner warn" role="note"><Icon name="alert" /><span>The API returns the {o.evidence.length} most recent of {o.evidenceTotal} linked records. Counts and lists show that window only.</span></div>}
                <EvidenceLists groups={groups} onOpen={(e) => setOpen(e)} />
                <div className="op-two">
                  <CompetitorMap b={brief} nMentions={groups.competitor.length} />
                  <Unknowns opp={o} brief={brief.brief} />
                </div>
                <History runs={o.runs ?? []} brief={brief.brief} />
                <StartRun oppId={o.id} token={token} status={status} />
              </div>
            </>
          )}
        </div>
      </div>
      {open && <EvidenceDrawer id={open.id} preview={open} token={token} onClose={() => setOpen(null)} />}
    </div>
  );
}
