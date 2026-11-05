// Command overview: live/paused headline, constellation, source health, active run, opportunities, what changed.
import { useMemo } from 'react';
import { fmt, useApi } from '../api.js';
import { Chip, Empty, ErrorPanel, Icon, Led, Meter, Panel, Skeleton, SkeletonRows, Status, StaleNote } from '../ui.jsx';
import { TOPIC_LABEL, srcColor } from './_evidence-parts.jsx';
import { Constellation, isRecent, lastIngest } from './_overview-parts.jsx';
import './overview.css';

const parseJson = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? d; } catch { return d; } };
const clock = (ts) => (ts ? new Date(ts).toISOString().slice(11, 16) + 'Z' : '–');

function Kpi({ label, value, href, tone }) {
  const body = <><b className={tone === 'bad' ? 'ov-bad' : ''}>{value ?? '–'}</b><span className="eyebrow">{label}</span></>;
  return href ? <a className="kpi ov-kpi" href={href}>{body}</a> : <div className="kpi ov-kpi">{body}</div>;
}

function SourceCard({ s, nextRunAt }) {
  const tone = s.status === 'ok' ? (s.stale ? 'warn' : 'ok') : s.status === 'circuit_open' ? 'bad' : 'bad';
  const r = s.lastRun;
  return (
    <article className={`ov-src ${tone}`} aria-label={`${s.name}: ${s.status}`}>
      <header>
        <span className="ov-src-name"><i style={{ background: srcColor(s.id) }} aria-hidden="true" />{s.name}</span>
        <Status state={s.status === 'ok' && s.stale ? 'skipped' : s.status} />
      </header>
      <dl className="ov-dl">
        <div><dt>Last success</dt><dd>{s.lastSuccess ? <>{fmt.ago(s.lastSuccess)} <span className="faint">· {clock(s.lastSuccess)}</span></> : 'never'}{isRecent(s) && <> <Chip tone="ok"><Led tone="ok" />recent</Chip></>}{s.stale && s.lastSuccess ? <> <Chip tone="warn">stale &gt;6h</Chip></> : null}</dd></div>
        <div><dt>Last error</dt><dd className={s.lastError ? 'ov-err' : 'faint'}>{s.lastError ? <>{s.lastError}<span className="faint"> · {fmt.ago(s.lastErrorAt)}</span></> : 'none recorded'}</dd></div>
        <div><dt>Records, last run</dt><dd className="num">{r ? <>{r.fetched} fetched · <b>+{r.inserted}</b> new · {r.updated} upd · {r.duplicates} dup{r.filtered ? ` · ${r.filtered} filtered` : ''}</> : <span className="faint">no run yet</span>}</dd></div>
        <div><dt>Next run</dt><dd className="num">{s.circuitOpenUntil && s.circuitOpenUntil > Date.now() ? <span className="ov-err">circuit open {fmt.until(s.circuitOpenUntil)}</span> : nextRunAt ? <>{fmt.until(nextRunAt)} <span className="faint">· shared tick</span></> : '–'}</dd></div>
        <div><dt>Rate limit</dt><dd className="dim ov-rate">{s.rateLimit}</dd></div>
      </dl>
      <footer>
        {s.failures > 0 && <Chip tone="bad">{s.failures} consecutive failure{s.failures > 1 ? 's' : ''}</Chip>}
        <a className="ov-doc" href={s.docs} target="_blank" rel="noreferrer noopener">API docs<Icon name="external" size={13} /></a>
      </footer>
    </article>
  );
}

function RunPanel({ status, runs }) {
  const s = status.data; const a = s?.activeRun; const b = a ? parseJson(a.budget, {}) : null;
  const last = runs.data?.items?.[0];
  return (
    <Panel title="Run" tone={a ? 'live' : undefined} aside={a ? <Status state={a.state} /> : <Chip>idle</Chip>}>
      {a ? (
        <div className="stack-s">
          <a className="ov-run-id" href={`#/run/${a.id}`}>{a.id}</a>
          <p className="dim">On <a href={`#/opportunity/${a.opportunity_id}`}>{TOPIC_LABEL[a.opportunity_id.replace('opp_', '')] ?? a.opportunity_id}</a>, triggered by {a.trigger}, started {fmt.ago(a.started_at)}.</p>
        </div>
      ) : (
        <div className="stack-s">
          <p className="dim">No research run is in progress. The agent roles in the constellation stay dark.</p>
          {last && <p className="faint">Latest: <a href={`#/run/${last.id}`} className="mono-v">{last.id.slice(0, 16)}</a> <Status state={last.state} /> {fmt.ago(last.started_at)}</p>}
          {runs.error && !runs.data && <p className="faint">Run history unavailable.</p>}
        </div>
      )}
      <hr className="rule" />
      <p className="eyebrow">Per-run budget cap</p>
      <div className="ov-budget">
        <div><span className="num">{a ? fmt.usd(a.spent_usd) : '$0.0000'}</span><span className="faint"> of ${s?.budget?.perRunUsd ?? '–'}</span><Meter value={a && (b?.usd ?? s?.budget?.perRunUsd) ? a.spent_usd / (b?.usd ?? s.budget.perRunUsd) : 0} label="Spend against the per-run cost cap" /></div>
        <div><span className="num">{a?.spent_tokens ?? 0}</span><span className="faint"> of {s?.budget?.perRunTokens ?? '–'} tokens</span><Meter value={a && (b?.tokens ?? s?.budget?.perRunTokens) ? a.spent_tokens / (b?.tokens ?? s.budget.perRunTokens) : 0} label="Tokens against the per-run cap" /></div>
      </div>
      <p className="help">{s?.llm?.enabled ? 'An LLM provider is configured; spend counts against the cap.' : 'No LLM provider is configured: roles run deterministic logic at $0.'}</p>
    </Panel>
  );
}

function Schedule({ s }) {
  const sc = s?.scheduler;
  return (
    <Panel title="Next collection" aside={<Chip>{sc?.mode ?? '–'}</Chip>}>
      {s?.paused ? <div className="banner risk" role="status"><Icon name="alert" /><span>Kill switch engaged. Runs and approvals are blocked until it is released.</span></div> : null}
      <div className="kpi" style={{ marginTop: s?.paused ? 12 : 0 }}>
        <b className="mono-big">{sc?.nextRunAt ? fmt.until(sc.nextRunAt) : 'not scheduled'}</b>
        <span className="eyebrow">{sc?.nextRunAt ? fmt.date(sc.nextRunAt) : 'no tick recorded yet'}</span>
      </div>
      <p className="help">{sc?.intervalMs ? `Every ${Math.round(sc.intervalMs / 60000)} minutes.` : ''} {sc?.lastTick ? `Last tick ${fmt.ago(sc.lastTick.at)} took ${(sc.lastTick.ms / 1000).toFixed(1)}s.` : 'No tick has run yet.'} {sc?.note}</p>
    </Panel>
  );
}

function Opps({ opps }) {
  const items = (opps.data?.items ?? []).slice().sort((a, b) => b.score - a.score);
  return (
    <Panel title="Opportunities" pad={false} aside={items.length ? <a className="faint mono" href={`#/opportunity/${items[0].id}`}>open dossiers</a> : null}>
      {opps.loading && !opps.data && <div className="pb"><SkeletonRows n={4} /></div>}
      {opps.error && !opps.data && <div className="pb"><ErrorPanel error={opps.error} onRetry={opps.reload} what="opportunities" /></div>}
      {opps.data && !items.length && <Empty title="No opportunities scored yet">Opportunities appear when tagged evidence has been stored and scored.</Empty>}
      {items.length > 0 && (
        <ol className="ov-opps list">
          {items.slice(0, 6).map((o, i) => {
            const low = o.warnings?.some((w) => w.startsWith('LOW CONFIDENCE'));
            return (
              <li key={o.id}>
                <a className="li ov-opp" href={`#/opportunity/${o.id}`}>
                  <span className="ov-rank num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="ov-opp-t"><b>{o.title}</b>
                    <span className="faint mono-v">{o.score_breakdown?.counts?.sources ?? 0} sources · {o.score_breakdown?.counts?.authors ?? 0} authors · updated {fmt.ago(o.updated_at)}</span>
                    {low && <span><Chip tone="bad"><Icon name="alert" size={12} />low confidence</Chip></span>}
                  </span>
                  <span className="ov-opp-s"><b className="num">{o.score.toFixed(2)}</b><span className="eyebrow">score</span></span>
                  <span className="ov-opp-c"><Meter value={o.confidence} label={`Confidence ${o.confidence.toFixed(2)}`} /><span className="num faint">conf. {o.confidence.toFixed(2)}</span></span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

const ACTION = {
  'server.started': ['Server started', ''], 'run.finished': ['Run finished', ''], 'kill_switch.engage': ['Kill switch engaged', 'bad'], 'kill_switch.release': ['Kill switch released', 'ok'],
  'run.cancel_requested': ['Run cancel requested', 'warn'],
};
function describe(a) {
  const [label, tone] = ACTION[a.action] ?? [a.action.replace(/[._]/g, ' '), ''];
  const d = a.detail ?? {};
  const bits = Object.entries(d).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k} ${String(v).slice(0, 28)}`);
  const t = a.action === 'run.finished' ? (d.state === 'failed' || d.state === 'blocked' ? 'bad' : d.state === 'succeeded' || d.state === 'awaiting_approval' ? 'ok' : 'warn') : tone;
  return { label, tone: t, text: bits.join(' · ') };
}

function Changes({ s, sec }) {
  const feed = useMemo(() => {
    const out = [];
    for (const src of s?.sources ?? []) {
      const r = src.lastRun; if (!r) continue;
      out.push({ k: `i${r.id}`, time: r.ended_at ?? r.started_at, kind: 'ingest', tone: r.status === 'ok' ? (r.inserted ? 'ok' : '') : 'bad', label: `${src.name}`,
        text: r.status === 'ok' ? `${r.inserted ? `+${r.inserted} new` : 'nothing new'} · ${r.duplicates} duplicate · ${r.fetched} fetched` : `ingest ${r.status}${r.error ? `: ${r.error}` : ''}` });
    }
    for (const a of sec.data?.audit ?? []) { if (a.action === 'source.ok') continue; const d = describe(a); out.push({ k: `a${a.id}`, time: a.time, kind: a.actor, tone: d.tone, label: d.label, text: d.text }); }
    return out.sort((x, y) => y.time - x.time).slice(0, 12);
  }, [s, sec.data]);
  return (
    <Panel title="What changed" pad={false} aside={sec.stale ? <StaleNote at={sec.at} /> : <span className="faint mono">latest {feed.length}</span>}>
      {sec.loading && !sec.data && !feed.length && <div className="pb"><SkeletonRows n={4} /></div>}
      {sec.error && !sec.data && <div className="pb"><ErrorPanel error={sec.error} onRetry={sec.reload} what="the audit log" /></div>}
      {feed.length === 0 && !sec.loading && !sec.error && <Empty title="Nothing has happened yet">Ingest results and audit entries appear here.</Empty>}
      {feed.length > 0 && (
        <ol className="ov-feed">
          {feed.map((f) => (
            <li key={f.k} className={f.tone}>
              <span className="ov-feed-t num">{clock(f.time)}<small>{fmt.ago(f.time)}</small></span>
              <span className="ov-feed-b"><b>{f.label}</b><span className="dim">{f.text}</span></span>
              <Chip tone={f.tone === 'ok' ? 'ok' : f.tone === 'bad' ? 'bad' : f.tone === 'warn' ? 'warn' : undefined}>{f.kind}</Chip>
            </li>
          ))}
        </ol>
      )}
      <p className="help ov-feed-n">Ingest rows show each source&rsquo;s most recent run; audit rows come from the tamper-evident log.</p>
    </Panel>
  );
}

export default function Overview({ status }) {
  const s = status.data;
  const evidence = useApi('/api/evidence?limit=100', { poll: 60000 });
  const opps = useApi('/api/opportunities', { poll: 60000 });
  const runs = useApi('/api/runs', { poll: 30000 });
  const sec = useApi('/api/security', { poll: 30000 });
  const src = s?.sources ?? [];
  const bad = src.filter((x) => x.status !== 'ok').length;
  const stale = src.filter((x) => x.status === 'ok' && x.stale).length;
  const recent = src.filter((x) => isRecent(x)).length;

  // The loading headline must be one line like the final one: a two-line placeholder shifted the whole page by 45px at 360px.
  let head; let sub;
  if (!s) { head = <>Reading <em>status</em>…</>; sub = 'Connecting to the AutoNEAR API.'; }
  else if (s.paused) { head = <>AutoNEAR is <em className="ov-paused">paused</em>.</>; sub = 'The kill switch is engaged: new research runs and approvals are blocked until an operator releases it.'; }
  else { head = <>AutoNEAR is <em>live</em>.</>; sub = bad ? `${bad} of ${src.length} sources need attention.` : stale ? `${stale} source${stale > 1 ? 's are' : ' is'} stale; the rest are healthy.` : `All ${src.length} sources are reporting.`; }

  return (
    <div className="page ov">
      <header className="ov-hero">
        <p className="eyebrow">Command overview · {s ? fmt.date(s.now) : '…'} {status.stale && <StaleNote at={status.at} />}</p>
        <h1 className="display">{head}</h1>
        <p className="ov-sub">{sub}{s && <> {recent ? `${recent} ingested within 20 minutes.` : 'No source has ingested within 20 minutes.'}{s.activeRun ? ` Run ${s.activeRun.id.slice(0, 12)} is ${s.activeRun.state}.` : ' No run is active.'}</>}</p>
        <div className="ov-kpis">
          <Kpi label="evidence records" value={s?.counts?.evidence} href="#/radar" />
          <Kpi label="opportunities" value={s?.counts?.opportunities} href="#/opportunity/opp_treasury" />
          <Kpi label="research runs" value={s?.counts?.runs} href="#/run" />
          <Kpi label="awaiting your decision" value={s?.counts?.pending_decisions} href="#/approval" tone={s?.counts?.pending_decisions ? 'bad' : undefined} />
        </div>
      </header>

      <div className="stack">
        <Panel title="Evidence constellation" pad={false} aside={<a className="faint mono" href="#/radar">open radar</a>}>
          <div className="ov-const-wrap">
            <Constellation items={evidence.data?.items} sources={src} activeRun={s?.activeRun} loading={evidence.loading || !s} error={evidence.error} onRetry={evidence.reload} />
          </div>
        </Panel>

        <div className="grid">
          <div className="span-8 stack">
            <Panel title="Source health" aside={<span className="faint mono">{src.length - bad} of {src.length} ok</span>}>
              {!s && <div className="ov-srcs"><Skeleton h={190} /><Skeleton h={190} /></div>}
              {s && !src.length && <Empty title="No sources registered">The collector has no configured sources.</Empty>}
              <div className="ov-srcs">{src.map((x) => <SourceCard key={x.id} s={x} nextRunAt={s.scheduler?.nextRunAt} />)}</div>
            </Panel>
            <Opps opps={opps} />
          </div>
          <div className="span-4 stack">
            <Schedule s={s} />
            <RunPanel status={status} runs={runs} />
            <Changes s={s} sec={sec} />
          </div>
        </div>
      </div>
    </div>
  );
}
