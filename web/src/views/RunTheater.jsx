// Run Theater: what the agents ACTUALLY did. Every node, row, chip and number below is read from run_events / runs.
// Nothing is animated for a live run except the arrival of real events; replay exists only for finished runs and is labelled.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Chip, CostChip, Empty, ErrorPanel, Icon, Led, Meter, NeedsOperator, Panel, SkeletonRows, StaleNote, Status, useToast } from '../ui.jsx';
import { PageHead, cap, dur, sha256Text, useNow } from './_run-parts.jsx';

const ROLES = [
  ['signal_collector', 'Signal Collector', 'collect'],
  ['evidence_analyst', 'Evidence Analyst', 'analyse'],
  ['skeptic', 'Skeptic', 'challenge'],
  ['product_architect', 'Product Architect', 'design'],
  ['builder', 'Builder', 'build'],
  ['security_reviewer', 'Security Reviewer', 'secure'],
  ['launch_planner', 'Launch Planner', 'plan'],
];
const ROLE_LABEL = Object.fromEntries(ROLES.map(([k, l]) => [k, l]));
const LIVE = new Set(['queued', 'running']);
const RETRYABLE = new Set(['failed', 'blocked', 'dead_letter', 'budget_exceeded', 'cancelled']);

export default function RunTheater({ params, status, token }) {
  const id = params[0];
  if (!id) return <RunList status={status} />;
  if (!/^run_\w+$/.test(id)) return <div className="page"><Empty title="Not a run id" action={<a className="btn" href="#/run">All runs</a>}>"{id}" is not a valid run identifier.</Empty></div>;
  return <RunDetail key={id} id={id} status={status} token={token} />;
}

/* =============================== list =============================== */
function RunList({ status }) {
  const runs = useApi('/api/runs', { poll: 5000 });
  const items = runs.data?.items ?? [];
  const llm = status.data?.llm;
  return (
    <div className="page">
      <PageHead eyebrow="Run theater" title="Every stage," em="on the record.">
        Each run is a chain of hash-linked events written by the coordinator as it happens. Open a run to see which agent did what, with what model, at what cost.
      </PageHead>
      <div className="row" style={{ marginBottom: 16 }}>
        <Chip tone={llm?.enabled ? 'mineral' : ''} title={llm?.reason}>{llm ? (llm.enabled ? `LLM ${llm.provider} · ${llm.model}` : 'LLM off · deterministic baseline') : 'LLM status unknown'}</Chip>
        {runs.stale && <StaleNote at={runs.at} />}
        <span className="mono faint">{items.length} most recent</span>
      </div>
      {runs.loading && <SkeletonRows n={5} />}
      {runs.error && !runs.data && <ErrorPanel error={runs.error} onRetry={runs.reload} what="runs" />}
      {runs.data && !items.length && <Empty title="No runs yet">A run starts from an opportunity dossier (operator) or from the scheduler when evidence changes materially.<a className="btn" href="#/opportunity/opp_treasury">Open the treasury dossier</a></Empty>}
      {items.length > 0 && (
        <Panel pad={false} title="Recent runs">
          <ul className="list" aria-label="Recent runs">
            {items.map((r) => {
              const b = typeof r.budget === 'string' ? safeParse(r.budget) : r.budget;
              const end = r.ended_at ?? null;
              return (
                <li key={r.id}>
                  <a className="li run-li" href={`#/run/${r.id}`}>
                    <span className="run-li-id mono-v">{r.id}</span>
                    <span className="run-li-st"><Status state={r.state} /></span>
                    <span className="faint mono-v run-li-opp">{r.opportunity_id} · {r.trigger}</span>
                    <span className="mono-v run-li-when" title={fmt.date(r.started_at)}>{fmt.ago(r.started_at)}{end ? ` · ${dur(end - r.started_at)}` : ''}</span>
                    <span className="mono-v run-li-cost">{fmt.usd(r.spent_usd)} · {r.spent_tokens} tok{b?.usd ? ` / $${b.usd}` : ''}</span>
                    {r.error && <span className="err-t run-li-err">{r.error}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* =============================== events feed =============================== */
/** Reads GET /runs/:id/events?after=<lastId>. Polls ~1.5s only while non-terminal and the tab is visible. */
function useEvents(runId) {
  const [s, set] = useState({ events: [], terminal: false, state: null, error: null, loading: true, at: 0 });
  const last = useRef(0); const alive = useRef(true); const timer = useRef(null); const busy = useRef(false);
  const pull = useCallback(async () => {
    if (busy.current) return false; busy.current = true;
    try {
      let terminal = false; let state = null; const fresh = [];
      for (let guard = 0; guard < 20; guard++) {
        const r = await api(`/api/runs/${runId}/events?after=${last.current}`);
        terminal = r.terminal; state = r.state;
        if (r.events.length) { fresh.push(...r.events); last.current = r.events.at(-1).id; }
        if (r.events.length < 200) break;
      }
      if (alive.current) set((p) => ({ events: fresh.length ? [...p.events, ...fresh] : p.events, terminal, state, error: null, loading: false, at: Date.now() }));
      return terminal;
    } catch (e) {
      if (alive.current) set((p) => ({ ...p, error: e, loading: false }));
      return false;
    } finally { busy.current = false; }
  }, [runId]);
  useEffect(() => {
    alive.current = true; last.current = 0;
    set({ events: [], terminal: false, state: null, error: null, loading: true, at: 0 });
    let stopped = false;
    const loop = async () => {
      clearTimeout(timer.current);
      if (stopped) return;
      if (document.hidden) { timer.current = setTimeout(loop, 1500); return; }
      const terminal = await pull();
      if (!stopped && !terminal) timer.current = setTimeout(loop, 1500);
    };
    const vis = () => { if (!document.hidden && !stopped) loop(); };
    document.addEventListener('visibilitychange', vis);
    loop();
    return () => { alive.current = false; stopped = true; clearTimeout(timer.current); document.removeEventListener('visibilitychange', vis); };
  }, [runId, pull]);
  return { ...s, reload: pull };
}

/** Client-side linkage check of the stored chain (prev_hash of each event equals hash of the one before). The server's chain.ok is authoritative. */
function useLinkCheck(runId, events) {
  const [res, set] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      if (!events.length) return set(null);
      let prev = await sha256Text(runId); let broken = null;
      for (const e of events) { if (e.prev_hash !== prev) { broken = e.id; break; } prev = e.hash; }
      if (live) set({ ok: !broken, brokenAt: broken, n: events.length });
    })();
    return () => { live = false; };
  }, [runId, events]);
  return res;
}

/* =============================== detail =============================== */
function RunDetail({ id, status, token }) {
  const toast = useToast();
  const ev = useEvents(id);
  const live = !ev.terminal;
  const detail = useApi(`/api/runs/${id}`, { poll: live ? 3000 : 0 });
  const wasLive = useRef(live);
  const reloadDetail = detail.reload;
  useEffect(() => { if (wasLive.current && !live) reloadDetail(); wasLive.current = live; }, [live, reloadDetail]);
  const link = useLinkCheck(id, ev.events);
  const now = useNow(1000);

  // ---- replay (finished runs only) ----
  const [replay, setReplay] = useState(null); // null = off, else position in ms from first event
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('fit');
  const t0 = ev.events[0]?.time ?? 0; const span = ev.events.length ? ev.events.at(-1).time - t0 : 0;
  const rate = speed === 'fit' ? Math.max(span / 8000, 0.0001) : Number(speed);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return undefined;
    let prev = performance.now();
    const step = (t) => {
      const dt = t - prev; prev = t;
      let done = false;
      setReplay((p) => { const n = (p ?? 0) + dt * rate; if (n >= span) { done = true; return span; } return n; });
      if (done) setPlaying(false); else raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, rate, span]);
  const shown = useMemo(() => (replay == null ? ev.events : ev.events.filter((e) => e.time - t0 <= replay)), [ev.events, replay, t0]);

  const run = detail.data?.run; const artifacts = detail.data?.artifacts ?? []; const decisions = detail.data?.decisions ?? [];
  const state = run?.state ?? ev.state;

  if (ev.loading && detail.loading) return <div className="page"><SkeletonRows n={6} /></div>;
  if (detail.error?.status === 404 || (!detail.data && ev.state === null && !ev.loading && !detail.loading && !ev.error)) return <div className="page"><Empty title="Run not found" action={<a className="btn" href="#/run">All runs</a>}>No run with id {id}.</Empty></div>;
  if (detail.error && !detail.data) return <div className="page"><ErrorPanel error={detail.error} onRetry={detail.reload} what="the run" /></div>;

  const models = [...new Set(ev.events.map((e) => e.model).filter(Boolean))];
  const analystDone = ev.events.find((e) => e.agent_role === 'evidence_analyst' && e.status !== 'started');
  const cost = ev.events.reduce((a, e) => a + (e.cost || 0), 0); const tokens = ev.events.reduce((a, e) => a + (e.tokens || 0), 0);
  const b = run?.budget ?? {};
  const elapsed = (run?.ended_at ?? (LIVE.has(state) ? now : ev.events.at(-1)?.time ?? now)) - (run?.started_at ?? t0);
  const artByRef = new Map(artifacts.map((a) => [a.immutable_ref, a]));

  return (
    <div className="page">
      <PageHead eyebrow={<><a href="#/run" className="rh-back">Runs</a> / {id}</>} title={cap(state ?? 'run').replace(/^./, (c) => c.toUpperCase())} em={LIVE.has(state) ? 'now' : null}
        aside={<Status state={state} />}>
        <span className="mono-v">{run?.opportunity_id}</span> <span className="faint">· triggered by {run?.trigger ?? '–'} · started {fmt.date(run?.started_at)}</span>
      </PageHead>

      {/* integrity + provenance */}
      <div className="stack" style={{ marginBottom: 16 }}>
        {run?.error && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>Run {cap(state)}</b><div className="mono-v rt-verbatim">{run.error}</div></div></div>}
        {state === 'cancelled' && !run?.error && <div className="banner warn"><Icon name="alert" /><div>Cancelled by the operator between stages. Stages after the cancel point did not run.</div></div>}
        <LlmBanner models={models} analystDone={analystDone} events={ev.events} llm={status.data?.llm} state={state} />
      </div>

      <div className="grid">
        <div className="span-8 stack" style={{ alignContent: 'start' }}>
          <Panel title="Agent graph" aside={replay != null ? <Chip tone="warn">replay of recorded events</Chip> : live ? <Chip tone="ok"><Led tone="ok" live />live · from run_events</Chip> : null}>
            <Graph events={shown} />
          </Panel>

          {!live && ev.events.length > 1 && (
            <ReplayBar span={span} replay={replay} playing={playing} speed={speed} rate={rate} count={shown.length} total={ev.events.length}
              onSeek={(v) => { setPlaying(false); setReplay(v); }}
              onPlay={() => { if (replay == null || replay >= span) setReplay(0); setPlaying((p) => !p); }}
              onSpeed={setSpeed} onExit={() => { setPlaying(false); setReplay(null); }} />
          )}

          <Panel title="Event timeline" aside={<span className="mono faint" aria-live="polite">{shown.length}{replay != null ? ` / ${ev.events.length}` : ''} events{live ? ' · polling 1.5s' : ''}</span>} pad={false}>
            {ev.error && <div style={{ padding: 16 }}><ErrorPanel error={ev.error} onRetry={ev.reload} what="events" />{ev.events.length > 0 && <StaleNote at={ev.at} />}</div>}
            {!ev.events.length && !ev.error && <Empty title={live ? 'Waiting for the first event' : 'No events were recorded'}>{live ? 'The coordinator has not emitted anything yet.' : 'This run ended without writing events.'}</Empty>}
            <ol className="timeline rt-tl" aria-label="Run events in order">
              {shown.map((e) => <Event key={e.id} e={e} t0={t0} art={artByRef.get(e.output_ref)} runId={id} />)}
            </ol>
          </Panel>
        </div>

        <aside className="span-4 stack" style={{ alignContent: 'start' }} aria-label="Run summary and controls">
          <Panel title="Totals">
            <dl className="kv">
              <dt>Elapsed</dt><dd className="mono-v">{dur(elapsed)}{LIVE.has(state) ? ' (running)' : ''}</dd>
              <dt>Cost</dt><dd><CostChip cost={cost} tokens={tokens} /></dd>
              <dt>Events</dt><dd className="mono-v">{ev.events.length}</dd>
              <dt>Spend vs budget</dt>
              <dd>
                <div className="stack-s">
                  <Meter value={b.usd ? (run?.spent_usd ?? 0) / b.usd : 0} tone="" label="USD budget used" />
                  <span className="mono-v">{fmt.usd(run?.spent_usd)} of ${b.usd ?? '–'} · <b>{b.usd != null ? fmt.usd(Math.max(0, b.usd - (run?.spent_usd ?? 0))) : '–'}</b> left</span>
                  <Meter value={b.tokens ? (run?.spent_tokens ?? 0) / b.tokens : 0} tone="" label="Token budget used" />
                  <span className="mono-v">{run?.spent_tokens ?? 0} of {b.tokens ?? '–'} tok · <b>{b.tokens != null ? Math.max(0, b.tokens - (run?.spent_tokens ?? 0)) : '–'}</b> left</span>
                </div>
              </dd>
            </dl>
          </Panel>

          <Panel title="Integrity">
            <div className="stack-s">
              {detail.data?.chain ? (detail.data.chain.ok
                ? <div className="row"><Chip tone="ok"><Icon name="check" size={12} />hash chain intact</Chip><span className="faint help">verified by the server</span></div>
                : <div className="banner risk" role="alert"><Icon name="alert" /><div><b>Hash chain BROKEN</b> at event #{detail.data.chain.brokenAt}. Treat this run as untrusted.</div></div>)
                : <Chip>chain: not yet verified</Chip>}
              {link && <div className="row"><Chip tone={link.ok ? 'ok' : 'bad'}>{link.ok ? 'prev-hash links consistent' : `link mismatch at #${link.brokenAt}`}</Chip><span className="faint help">checked in this browser</span></div>}
              <p className="help" style={{ margin: 0 }}>The server hash covers each event body; the browser check only confirms that every event points at the hash of the one before it.</p>
            </div>
          </Panel>

          <Panel title="Operator">
            <NeedsOperator token={token} hint="Operator token required to cancel or retry">
              <div className="stack-s">
                <div className="row">
                  {LIVE.has(state) && <button className="btn danger" disabled={run?.cancel_requested === 1} onClick={async () => { try { await api(`/api/runs/${id}/cancel`, { method: 'POST' }); toast('Cancel requested: takes effect at the next stage boundary'); detail.reload(); } catch (e) { toast(e.message, 'bad'); } }}>{run?.cancel_requested === 1 ? 'Cancel requested' : 'Cancel run'}</button>}
                  {RETRYABLE.has(state) && <button className="btn primary" onClick={async () => { try { const r = await api(`/api/runs/${id}/retry`, { method: 'POST' }); toast(`New run ${r.run.id} started`); location.hash = `#/run/${r.run.id}`; } catch (e) { toast(e.message, 'bad'); } }}>Retry as new run</button>}
                  {!LIVE.has(state) && !RETRYABLE.has(state) && <span className="faint help">No operator action applies in state "{cap(state)}".</span>}
                </div>
                {LIVE.has(state) && <p className="help" style={{ margin: 0 }}>Cancel is cooperative: the coordinator checks between stages, so an in-flight stage finishes first.</p>}
                {RETRYABLE.has(state) && <p className="help" style={{ margin: 0 }}>Retry creates a fresh run on the same opportunity with the same parameters; this run's record is kept unchanged.</p>}
              </div>
            </NeedsOperator>
          </Panel>

          <Panel title="Outputs">
            <div className="stack-s">
              {decisions.map((d) => <a key={d.id} className="btn" href={`#/approval/${d.id}`}><Icon name="approve" size={16} />Decision {d.id.slice(0, 12)}… <Status state={d.status} /></a>)}
              {!decisions.length && <p className="faint help" style={{ margin: 0 }}>{LIVE.has(state) ? 'No decision yet: the Launch Planner runs last.' : 'No decision was created by this run (see the Launch Planner event for why).'}</p>}
              {artifacts.map((a) => <div key={a.id} className="row sp"><span className="chip mineral">{a.kind}</span><span className="mono-v faint" title={a.hash}>{fmt.short(a.hash, 8)}</span></div>)}
              {artifacts.some((a) => a.kind === 'brief') && <a className="btn" href={`#/studio/${id}`}><Icon name="studio" size={16} />Open in Studio</a>}
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* =============================== provenance banner =============================== */
function LlmBanner({ models, analystDone, events, llm, state }) {
  if (models.length) {
    const toks = events.filter((e) => e.model).reduce((a, e) => a + e.tokens, 0);
    return <div className="banner ok" data-testid="llm-banner"><Icon name="check" /><div><b>LLM used</b> in this run: <span className="mono-v">{models.join(', ')}</span>. <span className="dim">Output was schema-validated and every citation checked against the evidence it was given. {toks} tokens billed to this run's budget.</span></div></div>;
  }
  if (analystDone) {
    return (
      <div className="banner warn" data-testid="llm-banner"><Icon name="alert" /><div>
        <b>LLM was NOT used: deterministic baseline.</b> <span className="dim">Every analysis stage in this run came from rule-based code, not a language model.</span>
        <div className="mono-v rt-verbatim">{analystDone.detail}</div>
        {llm && <div className="help">Server LLM configuration right now: {llm.enabled ? `${llm.provider} · ${llm.model}` : llm.reason}</div>}
      </div></div>
    );
  }
  return <div className="banner" data-testid="llm-banner"><Icon name="clock" /><div>{LIVE.has(state) ? 'Whether an LLM is used is decided at the Evidence Analyst stage, which has not completed yet.' : 'The Evidence Analyst stage never completed, so no model call was recorded.'}</div></div>;
}

/* =============================== graph =============================== */
function Graph({ events }) {
  const by = new Map();
  for (const e of events) { const a = by.get(e.agent_role) ?? { first: null, last: null, tokens: 0, cost: 0, model: null }; a.first ??= e; a.last = e; a.tokens += e.tokens; a.cost += e.cost; a.model = e.model ?? a.model; by.set(e.agent_role, a); }
  return (
    <ol className="nodes rt-nodes" aria-label="Pipeline stages and their recorded state">
      {ROLES.map(([role, label, stage], i) => {
        const a = by.get(role); const st = a ? a.last.status : 'idle';
        const took = a && a.last.status !== 'started' ? a.last.time - a.first.time : null;
        return (
          <li key={role} className={`node ${st}`} data-state={st} data-role={role}>
            <span className="mono faint">{String(i + 1).padStart(2, '0')} · {stage}</span>
            <b className="rt-node-name">{label}</b>
            <span><NodeState st={st} /></span>
            <span className="mono-v faint">{a ? (a.model ? a.model : a.last.status === 'started' ? 'working' : 'no model call') : 'not reached'}</span>
            {a && (a.tokens > 0 || took != null) && <span className="mono-v faint">{took != null ? dur(took) : ''}{a.tokens > 0 ? ` · ${a.tokens} tok · ${fmt.usd(a.cost)}` : ''}</span>}
          </li>
        );
      })}
    </ol>
  );
}
function NodeState({ st }) {
  const tone = st === 'completed' ? 'ok' : st === 'started' ? 'ok' : st === 'idle' ? '' : st === 'cancelled' ? 'warn' : 'bad';
  return <Chip tone={tone}><Led tone={tone || 'off'} live={st === 'started'} />{cap(st)}</Chip>;
}

/* =============================== replay =============================== */
function ReplayBar({ span, replay, playing, speed, rate, count, total, onSeek, onPlay, onSpeed, onExit }) {
  const pos = replay ?? span;
  return (
    <section className="panel rt-replay" aria-label="Replay of recorded events">
      <div className="ph"><h2 className="eyebrow" style={{ margin: 0 }}>Replay of recorded events</h2><Chip tone="warn" title="Replays stored timestamps; this run already finished">finished run · not live</Chip></div>
      <div className="pb stack-s">
        <p className="help" style={{ margin: 0 }}>Steps through the timestamps stored with each event. Nothing here is generated; scrubbing only reveals more of what was already recorded.</p>
        <div className="rt-replay-row">
          <button className="btn" onClick={onPlay} aria-pressed={playing}><Icon name={playing ? 'pause' : 'play'} size={16} />{playing ? 'Pause' : replay == null || replay >= span ? 'Replay' : 'Resume'}</button>
          <label className="rt-scrub"><span className="sr">Replay position</span>
            <input type="range" min={0} max={Math.max(1, Math.round(span))} step={1} value={Math.round(pos)} onChange={(e) => onSeek(Number(e.target.value))}
              aria-valuetext={`+${dur(pos)} of ${dur(span)}, ${count} of ${total} events`} />
          </label>
          <span className="mono-v rt-scrub-t">+{dur(pos)} / {dur(span)}</span>
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6 }}><span className="eyebrow">Speed</span>
            <select className="select" style={{ width: 'auto', minHeight: 44 }} value={speed} onChange={(e) => onSpeed(e.target.value)}>
              <option value="fit">fit to 8s</option><option value="1">1× (recorded)</option><option value="10">10×</option><option value="100">100×</option>
            </select>
          </label>
          <span className="mono-v faint">time scale ×{rate < 0.1 ? rate.toFixed(3) : rate.toFixed(1)} · showing {count} of {total}</span>
          {replay != null && <button className="btn ghost" onClick={onExit}>Show all events</button>}
        </div>
      </div>
    </section>
  );
}

/* =============================== event row =============================== */
function Event({ e, t0, art, runId }) {
  const [open, setOpen] = useState(false);
  const [pv, setPv] = useState(null);
  const loadPreview = async () => {
    if (pv) { setPv(null); return; }
    setPv({ loading: true });
    try { const a = await api(`/api/artifacts/${art.id}`); setPv({ data: a.content ?? a }); } catch (err) { setPv({ error: err.message }); }
  };
  const tone = e.status === 'completed' ? 'ok' : e.status === 'started' ? 'ok' : e.status === 'cancelled' ? 'warn' : 'bad';
  return (
    <li className={`ev ${e.status}`} data-event={e.id} data-status={e.status} data-role={e.agent_role}>
      <span className="dot" aria-hidden="true" />
      <div className="rt-ev-body">
        <div className="row" style={{ gap: 8 }}>
          <b>{ROLE_LABEL[e.agent_role] ?? cap(e.agent_role)}</b>
          <span className="mono faint">{e.stage}</span>
          <Chip tone={tone}>{cap(e.status)}</Chip>
          {e.model ? <Chip tone="mineral" title="Model recorded for this stage">{e.model}</Chip> : e.status !== 'started' && ROLES.some(([r]) => r === e.agent_role) ? <Chip title="No model call was recorded for this stage">no LLM</Chip> : null}
          {(e.tokens > 0 || e.cost > 0) && <CostChip cost={e.cost} tokens={e.tokens} />}
        </div>
        {e.detail && <p className={`rt-detail ${['failed', 'blocked', 'dead_letter', 'cancelled'].includes(e.status) ? 'rt-detail-bad' : 'dim'}`}>{e.detail}</p>}
        {e.output_ref && (
          <div className="row rt-out">
            <span className="eyebrow">output</span>
            <span className="mono-v" title={e.output_ref}>{fmt.short(e.output_ref, 10)}</span>
            {art ? <button className="btn sm" onClick={loadPreview} aria-expanded={Boolean(pv)}>{pv ? 'Hide' : `Preview ${art.kind}`}</button> : <span className="faint help">content-addressed blob; the API exposes it only through artifacts</span>}
            {art && (art.kind === 'brief' || art.kind === 'security-dossier') && <a className="btn sm ghost" href={`#/studio/${runId}?tab=${art.kind === 'brief' ? 'brief' : 'security'}`}>Open in Studio</a>}
          </div>
        )}
        {pv?.loading && <p className="faint">Loading artifact…</p>}
        {pv?.error && <p className="err-t" role="alert">{pv.error}</p>}
        {pv?.data && <pre className="code rt-pre" tabIndex={0} aria-label="Artifact preview">{JSON.stringify(pv.data, null, 2).slice(0, 6000)}</pre>}
        <button className="rt-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide chain details' : 'Chain details'}</button>
        {open && (
          <dl className="kv rt-chain">
            <dt>Event id</dt><dd className="mono-v">{e.id}</dd>
            <dt>Hash</dt><dd className="mono-v">{e.hash}</dd>
            <dt>Prev hash</dt><dd className="mono-v">{e.prev_hash}</dd>
            <dt>Inputs</dt><dd className="mono-v">{e.input_refs?.length ? e.input_refs.map((r) => fmt.short(r, 8)).join(', ') : 'none'}</dd>
          </dl>
        )}
      </div>
      <span className="mono-v faint rt-time" title={fmt.date(e.time)}>+{dur(e.time - t0)}</span>
    </li>
  );
}
