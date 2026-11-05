// Studio: the artifacts a run produced, read straight from the API: brief, treasury rehearsal, attested contract build,
// security dossier (automated checks), and a client-side evidence bundle. Nothing here is generated or mocked.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Chip, Empty, ErrorPanel, Icon, Meter, Panel, SkeletonRows, StaleNote, Status } from '../ui.jsx';
import { Checks, CopyButton, Full, PageHead, Tabs, cap, replaceHash, sha256Text } from './_run-parts.jsx';

const TABS = [['brief', 'Brief'], ['treasury', 'Treasury rehearsal'], ['contract', 'Contract'], ['security', 'Security dossier'], ['bundle', 'Evidence bundle']];
const VERDICT_TONE = { build: 'ok', research_more: 'warn', reject: 'bad' };
const statusTone = (s = '') => (/^mitigated/.test(s) ? 'ok' : /partial/.test(s) ? 'warn' : 'bad');

function initialTab() {
  const m = /[?&]tab=(\w+)/.exec(location.hash);
  return TABS.some(([id]) => id === m?.[1]) ? m[1] : 'brief';
}

export default function Studio({ params }) {
  const arts = useApi('/api/artifacts', { poll: 20000 });
  const [tab, setTab] = useState(initialTab);
  const items = arts.data?.items ?? [];
  const briefRuns = useMemo(() => { const seen = new Set(); return items.filter((a) => a.kind === 'brief' && a.run_id && !seen.has(a.run_id) && seen.add(a.run_id)); }, [items]);
  const runId = params[0] ?? briefRuns[0]?.run_id ?? null;
  const pick = (t) => { setTab(t); replaceHash(`#/studio${runId ? `/${runId}` : ''}?tab=${t}`); };

  if (arts.loading) return <div className="page"><SkeletonRows n={6} /></div>;
  if (arts.error && !arts.data) return <div className="page"><ErrorPanel error={arts.error} onRetry={arts.reload} what="artifacts" /></div>;
  if (!runId) return (
    <div className="page"><PageHead eyebrow="Studio" title="Nothing built" em="yet." />
      <Empty title="No run has produced a brief" action={<a className="btn" href="#/run">Open runs</a>}>Studio shows the artifacts of a run. A brief is written by the Product Architect stage; none exists in this database.</Empty></div>
  );
  return <StudioRun key={runId} runId={runId} tab={tab} pick={pick} briefRuns={briefRuns} allArtifacts={items} stale={arts.stale ? arts.at : 0} />;
}

function StudioRun({ runId, tab, pick, briefRuns, allArtifacts, stale }) {
  const run = useApi(`/api/runs/${runId}`);
  const arts = run.data?.artifacts ?? [];
  const briefMeta = arts.find((a) => a.kind === 'brief'); const dossierMeta = arts.find((a) => a.kind === 'security-dossier');
  const brief = useApi(briefMeta ? `/api/artifacts/${briefMeta.id}` : '', { enabled: Boolean(briefMeta) });
  const dossier = useApi(dossierMeta ? `/api/artifacts/${dossierMeta.id}` : '', { enabled: Boolean(dossierMeta) });
  const decisionId = run.data?.decisions?.[0]?.id;
  const b = brief.data?.content;
  const protocol = b?.integration?.protocol;

  const tabs = TABS.map(([id, label]) => ({ id, label }));
  return (
    <div className="page">
      <PageHead eyebrow="Studio" title={b?.title ?? 'Run artifacts'} aside={run.data && <Status state={run.data.run.state} />}>
        <span className="mono-v">{runId}</span>
        {b && <span className="faint"> · {b.integration?.protocol} · {b.integration?.network}</span>}
      </PageHead>
      <div className="row" style={{ marginBottom: 16, justifyContent: 'space-between' }}>
        <label className="row" style={{ gap: 8 }}><span className="eyebrow">Run</span>
          <select className="select st-select" value={runId} onChange={(e) => { location.hash = `#/studio/${e.target.value}`; }} aria-label="Choose a run with a brief">
            {!briefRuns.some((r) => r.run_id === runId) && <option value={runId}>{runId}</option>}
            {briefRuns.map((r) => <option key={r.run_id} value={r.run_id}>{r.run_id} · {fmt.date(r.created_at)}</option>)}
          </select>
        </label>
        <div className="row">{stale ? <StaleNote at={stale} /> : null}<a className="btn" href={`#/run/${runId}`}><Icon name="run" size={16} />Run theater</a>{decisionId && <a className="btn" href={`#/approval/${decisionId}`}><Icon name="approve" size={16} />Approval</a>}</div>
      </div>
      {run.loading && <SkeletonRows n={4} />}
      {run.error && !run.data && <ErrorPanel error={run.error} onRetry={run.reload} what="the run" />}
      {run.data && (
        <>
          <Tabs tabs={tabs} value={tab} onChange={pick} label="Studio sections" />
          <div className="st-panel" role="tabpanel" tabIndex={-1} aria-label={TABS.find(([i]) => i === tab)[1]}>
            {tab === 'brief' && <BriefTab meta={briefMeta} q={brief} />}
            {tab === 'treasury' && <TreasuryTab meta={briefMeta} q={brief} />}
            {tab === 'contract' && <ContractTab all={allArtifacts} protocol={protocol} decisionId={decisionId} />}
            {tab === 'security' && <SecurityTab meta={dossierMeta} q={dossier} />}
            {tab === 'bundle' && <BundleTab runId={runId} run={run.data} briefQ={brief} dossierQ={dossier} all={allArtifacts} protocol={protocol} />}
          </div>
        </>
      )}
    </div>
  );
}

const Missing = ({ what, why }) => <Empty title={`No ${what}`}>{why}</Empty>;
function Load({ q, what, children }) {
  if (q.loading) return <SkeletonRows n={4} />;
  if (q.error && !q.data) return <ErrorPanel error={q.error} onRetry={q.reload} what={what} />;
  return q.data ? children(q.data) : null;
}
const Cite = ({ id }) => <a className="cite" href={`#/radar/${id}`} title={`Open evidence ${id} in Radar (provenance)`}>{id.replace(/^ev_/, '').slice(0, 8)}</a>;
const Cites = ({ ids, gap }) => (ids?.length ? <span className="cites" aria-label={`${ids.length} citation${ids.length === 1 ? '' : 's'}`}>{ids.map((c) => <Cite key={c} id={c} />)}</span> : <span className="cites"><Chip tone={gap ? '' : 'warn'} title={gap ? 'A recorded gap: it names what is missing, so there is no source to cite' : 'This claim has no evidence behind it'}>{gap ? 'gap: nothing to cite' : 'uncited claim'}</Chip></span>);

/* =============================== brief =============================== */
function BriefTab({ meta, q }) {
  if (!meta) return <Missing what="brief artifact" why="This run did not reach the Product Architect stage, or its brief is stored under an earlier run with an identical hash." />;
  return <Load q={q} what="the brief">{(a) => <Brief b={a.content} hash={a.hash} />}</Load>;
}
function Brief({ b, hash }) {
  const v = b.decision;
  return (
    <div className="stack">
      <section className={`st-verdict ${VERDICT_TONE[v.verdict] ?? ''}`} aria-label="Decision verdict">
        <div className="eyebrow">Skeptic verdict</div>
        <div className="st-verdict-w">{cap(v.verdict)}</div>
        <p className="dim st-verdict-r">{v.rationale}</p>
        <div className="row">
          <span className="mono-v">confidence after skeptic <b>{fmt.pct(v.confidenceAfterSkeptic)}</b></span>
          <Chip tone={b.provenance?.analystSource?.startsWith('llm') ? 'mineral' : 'warn'}>analysis: {b.provenance?.analystSource ?? 'unknown'}</Chip>
          <span className="faint help">This is a pre-build screening verdict, not evidence of market demand.</span>
        </div>
      </section>

      <div className="grid">
        <div className="span-7 stack" style={{ alignContent: 'start' }}>
          <Panel title="Problem">
            <p style={{ margin: 0 }}>{b.problemStatement}</p>
            <hr className="rule" />
            <dl className="kv"><dt>Affected user</dt><dd>{b.affectedUser}</dd><dt>Promise</dt><dd>{b.promise}</dd><dt>First use case</dt><dd>{b.firstUseCase}</dd></dl>
          </Panel>
          <Panel title={`Evidence claims · ${b.evidence?.length ?? 0}`}>
            <ol className="st-claims">{(b.evidence ?? []).map((f, i) => <li key={i}><span>{f.claim}</span><Cites ids={f.citations} /></li>)}</ol>
            <p className="help" style={{ marginBottom: 0 }}>Each chip opens the source record in Radar. A claim without a source would be flagged "uncited claim".</p>
          </Panel>
          <Panel title={`Counterevidence and gaps · ${b.counterevidence?.length ?? 0}`}>
            <ul className="st-claims bad-list">{(b.counterevidence ?? []).map((f, i) => <li key={i}><span>{f.claim}</span><Cites ids={f.citations} gap /></li>)}</ul>
          </Panel>
        </div>
        <div className="span-5 stack" style={{ alignContent: 'start' }}>
          <Panel title="Existing solutions">
            {(b.existingSolutions ?? []).length ? (
              <ul className="list st-list">{b.existingSolutions.map((c) => (
                <li key={c.name} className="li">
                  <div className="row sp"><b>{c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.name}<span className="sr"> (opens in a new tab)</span></a> : c.name}</b><span className="mono-v">coverage {fmt.pct(c.coverage)}</span></div>
                  <Meter value={c.coverage} tone="warn" label={`${c.name} coverage of the problem`} />
                  <span className="dim">{c.note}</span>
                  <span className="mono faint">{c.source}{c.reviewed ? ` · reviewed ${c.reviewed}` : ''}</span>
                </li>))}</ul>
            ) : <p className="faint">No competitor listed for this topic.</p>}
          </Panel>
          <Panel title="Scope">
            <div className="eyebrow">MVP</div><ul className="st-ul">{b.mvp?.map((x) => <li key={x}>{x}</li>)}</ul>
            <div className="eyebrow">Non-goals</div><ul className="st-ul">{b.nonGoals?.map((x) => <li key={x}>{x}</li>)}</ul>
            <div className="eyebrow">Open questions</div><ul className="st-ul">{b.unresolvedQuestions?.map((x) => <li key={x}>{x}</li>)}</ul>
          </Panel>
        </div>
      </div>

      <Panel title={`Threat model · ${b.threatModel?.length ?? 0} threats`} pad={false}>
        <div className="scroll-x"><table className="tbl st-threats"><thead><tr><th scope="col">Threat</th><th scope="col">Mitigation</th><th scope="col">Status</th></tr></thead>
          <tbody>{(b.threatModel ?? []).map((t) => <tr key={t.threat}><th scope="row" className="st-th">{t.threat}</th><td className="dim">{t.mitigation}</td><td><Chip tone={statusTone(t.status)}>{t.status}</Chip></td></tr>)}</tbody></table></div>
      </Panel>
      <p className="help" style={{ margin: 0, overflowWrap: 'anywhere' }}>Brief sha256 <span className="mono-v">{hash}</span></p>
    </div>
  );
}

/* =============================== treasury =============================== */
function TreasuryTab({ meta, q }) {
  if (!meta) return <Missing what="brief artifact" why="The treasury rehearsal lives inside the brief, which this run did not produce." />;
  return <Load q={q} what="the brief">{(a) => <Treasury t={a.content.treasuryRehearsal} />}</Load>;
}
function Treasury({ t }) {
  if (!t) return <Missing what="treasury rehearsal" why="This opportunity is not a treasury topic, so the Product Architect did not compare quotes." />;
  const live = t.mode === 'live';
  const mixed = t.quotes.some((x) => (x.kind === 'live') !== live);
  return (
    <div className="stack">
      <div className={`banner ${live ? 'ok' : 'risk'} st-mode`} role="note" data-testid="quote-mode">
        <Icon name={live ? 'check' : 'alert'} />
        <div>
          <b className="st-mode-w">{live ? 'LIVE QUOTE' : 'SYNTHETIC FIXTURES'}</b>
          <div className="dim">{live ? 'A real dry-run quote was obtained from the NEAR Intents 1Click API for this rehearsal. It is advisory and nothing was executed.' : (t.note || 'No live executable quote was available. Route quotes below are invented for the policy rehearsal. They are not market quotes.')}</div>
          {mixed && <div className="err-t">Warning: per-quote provenance disagrees with the overall mode. Trust the per-quote label.</div>}
        </div>
      </div>
      <div className="grid">
        <div className="span-8 stack" style={{ alignContent: 'start' }}>
          {t.quotes.map((x) => (
            <Panel key={x.route} tone={x.pass ? '' : 'risk'} title={x.route} aside={<span className="row"><Chip tone={x.kind === 'live' ? 'ok' : 'warn'}>{x.kind === 'live' ? 'live' : 'synthetic fixture'}</Chip><Chip tone={x.pass ? 'ok' : 'bad'}>{x.pass ? 'policy pass' : 'policy fail'}</Chip>{t.best?.route === x.route && <Chip tone="mineral">best passing</Chip>}</span>}>
              <dl className="kv st-q"><dt>Trade</dt><dd className="mono-v">{x.amountIn} {x.from} → {x.amountOut} {x.to}</dd><dt>Slippage</dt><dd className="mono-v">{x.slippageBps} bps</dd><dt>Fee</dt><dd className="mono-v">{x.feeBps} bps</dd><dt>Notional</dt><dd className="mono-v">${Number(x.notionalUsd).toFixed(2)}</dd></dl>
              <div className="eyebrow" style={{ margin: '12px 0 6px' }}>Policy checks</div>
              <Checks items={x.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.value }))} />
            </Panel>
          ))}
          {!t.quotes.length && <Empty title="No quotes">The rehearsal ended with no quotes to evaluate.</Empty>}
        </div>
        <aside className="span-4 stack" style={{ alignContent: 'start' }}>
          <Panel title={`Attempts · ${t.attempts.length}`}>
            {t.attempts.length ? <ul className="st-att">{t.attempts.map((a, i) => <li key={i}><Chip tone={a.ok ? 'ok' : 'bad'}>{a.ok ? 'ok' : 'failed'}</Chip> <span>{a.what}</span>{a.error && <div className="mono-v rt-verbatim">{a.error}</div>}</li>)}</ul> : <p className="faint">No external request was attempted.</p>}
            <p className="help" style={{ marginBottom: 0 }}>Reference price: {t.referencePrices?.wNEAR != null ? `wNEAR ${t.referencePrices.wNEAR}, USDC ${t.referencePrices.USDC} (live token catalogue)` : 'unavailable, fallback mid-price used'}</p>
          </Panel>
          <Panel title={t.policy.name}>
            <dl className="kv"><dt>Max slippage</dt><dd className="mono-v">{t.policy.maxSlippageBps} bps</dd><dt>Max fee</dt><dd className="mono-v">{t.policy.maxFeeBps} bps</dd><dt>Max trade</dt><dd className="mono-v">${t.policy.maxTradeUsd}</dd><dt>Assets</dt><dd className="mono-v">{t.policy.allowedAssets.join(', ')}</dd><dt>Human approval</dt><dd>{t.policy.requireHumanApproval ? 'always required' : 'not required'}</dd><dt>Scope</dt><dd>{t.policy.network}</dd></dl>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* =============================== contract =============================== */
function ContractTab({ all, protocol, decisionId }) {
  const builds = all.filter((a) => a.kind.startsWith('contract-build:') && (!protocol || a.kind === `contract-build:${protocol}`));
  const dec = useApi(decisionId ? `/api/decisions/${decisionId}` : '', { enabled: Boolean(decisionId) });
  const [sel, setSel] = useState(null);
  const want = dec.data?.artifact_hash;
  const chosen = builds.find((a) => a.id === sel) ?? builds.find((a) => a.hash === want) ?? builds[0];
  const q = useApi(chosen ? `/api/artifacts/${chosen.id}` : '', { enabled: Boolean(chosen) });
  if (!builds.length) return <Missing what="attested build" why={`No contract-build artifact${protocol ? ` for "${protocol}"` : ''} has been recorded. The Builder stage blocks until a real build is attested (npm run attest, or POST /api/artifacts from CI). The server cannot compile contracts itself.`} />;
  const m = q.data?.content ?? {}; const t = q.data?.test_results ?? {};
  const skip = new Set(['abi', 'bytecode', 'constructorArgs']);
  return (
    <div className="stack">
      <div className="row sp">
        <div className="row"><Chip tone="mineral">{chosen.kind}</Chip>{want && chosen.hash === want && <Chip tone="ok">matches the decision's artifact hash</Chip>}{want && chosen.hash !== want && <Chip tone="bad">does NOT match the decision's artifact hash</Chip>}</div>
        {builds.length > 1 && <label className="row" style={{ gap: 8 }}><span className="eyebrow">Build</span><select className="select st-select" value={chosen.id} onChange={(e) => setSel(e.target.value)}>{builds.map((a) => <option key={a.id} value={a.id}>{fmt.short(a.hash, 8)} · {fmt.date(a.created_at)}</option>)}</select></label>}
      </div>
      <Load q={q} what="the build">{() => (
        <div className="grid">
          <div className="span-6 stack" style={{ alignContent: 'start' }}>
            <Panel title="Attested build">
              <dl className="kv">
                <dt>Artifact hash</dt><dd><Full v={q.data.hash} copy /></dd>
                <dt>Commit</dt><dd className="mono-v">{q.data.commit_sha ?? 'not recorded'}</dd>
                <dt>Recorded</dt><dd className="mono-v">{fmt.date(q.data.created_at)}</dd>
                {Object.entries(m).filter(([k, v]) => !skip.has(k) && v != null).map(([k, v]) => (
                  <Pair key={k} k={k} v={v} />
                ))}
              </dl>
              <p className="help" style={{ marginBottom: 0 }}>Recorded as an attestation of a build made outside this server (it is not rebuilt here) and cross-checked against the chain on deploy. The creation bytecode and ABI are withheld here and released only to the operator at signing time.</p>
            </Panel>
          </div>
          <div className="span-6 stack" style={{ alignContent: 'start' }}>
            <Panel title="Tests (from the attestation)" aside={<Chip tone={t.failed === 0 && t.passed > 0 ? 'ok' : 'bad'}>{t.failed === 0 && t.passed > 0 ? 'all passing' : 'failing or empty'}</Chip>}>
              <div className="st-tests">
                <div className="kpi"><b>{t.passed ?? '–'}</b><span className="eyebrow">passed</span></div>
                <div className="kpi"><b>{t.failed ?? '–'}</b><span className="eyebrow">failed</span></div>
                <div className="kpi"><b className="mono-big">{t.lint === true ? 'clean' : t.lint === false ? 'dirty' : '–'}</b><span className="eyebrow">lint</span></div>
                <div className="kpi"><b className="mono-big">{t.fuzz ? 'yes' : 'no'}</b><span className="eyebrow">fuzz/property</span></div>
              </div>
              {Array.isArray(t.names) && t.names.length > 0 ? (
                <details className="st-names"><summary>{t.names.length} named tests</summary><ul className="st-ul mono-v">{t.names.map((n) => <li key={n}>{n}</li>)}</ul></details>
              ) : <p className="faint help">The attestation carries no test names, so negative-case coverage cannot be confirmed from names.</p>}
            </Panel>
          </div>
        </div>
      )}</Load>
    </div>
  );
}
function Pair({ k, v }) {
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return <><dt>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd className="mono-v">{text.length > 400 ? `${text.slice(0, 400)}…` : text}</dd></>;
}

/* =============================== security dossier =============================== */
function SecurityTab({ meta, q }) {
  if (!meta) return <Missing what="security dossier" why="The Security Reviewer stage did not complete for this run." />;
  return <Load q={q} what="the dossier">{(a) => <Dossier d={a.content.output} hash={a.hash} />}</Load>;
}
function Dossier({ d, hash }) {
  const checks = d.checks ?? []; const fails = checks.filter((c) => !c.ok);
  return (
    <div className="stack">
      <div className={`banner ${fails.length ? 'risk' : 'warn'}`}><Icon name={fails.length ? 'alert' : 'security'} />
        <div><b>Automated checks, not an audit.</b> <span className="dim">{d.wording} These are scripted assertions over this run's own artifacts. They cannot find design flaws a human reviewer would.</span></div>
      </div>
      <div className="grid">
        <div className="span-8 stack" style={{ alignContent: 'start' }}>
          <Panel title={`Automated checks · ${checks.length - fails.length}/${checks.length} pass`} aside={<Chip tone={fails.length ? 'bad' : 'ok'}>{fails.length ? `${fails.length} failed` : 'all passed'}</Chip>}>
            <Checks items={checks} />
          </Panel>
        </div>
        <aside className="span-4 stack" style={{ alignContent: 'start' }}>
          <Panel title="Independent audit"><div className="row"><Chip tone="bad">independentAudit: {d.independentAudit?.status ?? 'none'}</Chip></div><p className="dim" style={{ margin: '8px 0 0' }}>Reviewer: {d.independentAudit?.reviewer ?? 'none'}. Report: {d.independentAudit?.report ?? 'none'}.</p></Panel>
          <Panel title={`Unresolved · ${d.unresolved?.length ?? 0}`}><ul className="st-ul">{(d.unresolved ?? []).map((u) => <li key={u}>{u}</li>)}</ul></Panel>
          <p className="help" style={{ margin: 0 }}>Dossier sha256 <span className="mono-v">{fmt.short(hash, 12)}</span></p>
        </aside>
      </div>
    </div>
  );
}

/* =============================== evidence bundle =============================== */
function BundleTab({ runId, run, briefQ, dossierQ, all, protocol }) {
  const [st, setSt] = useState({ phase: 'idle' });
  const [url, setUrl] = useState(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const build = async () => {
    setSt({ phase: 'building' });
    try {
      const events = []; let after = 0;
      for (let g = 0; g < 50; g++) { const r = await api(`/api/runs/${runId}/events?after=${after}`); events.push(...r.events); if (r.events.length < 200) break; after = r.events.at(-1).id; }
      const decisions = await Promise.all(run.decisions.map((d) => api(`/api/decisions/${d.id}`)));
      const deps = await api('/api/deployments');
      const deployments = deps.items.filter((d) => decisions.some((x) => x.id === d.decision_id));
      const buildHash = decisions[0]?.artifact_hash;
      const cbMeta = all.find((a) => a.kind.startsWith('contract-build:') && (buildHash ? a.hash === buildHash : protocol ? a.kind.endsWith(protocol) : true));
      const contractBuild = cbMeta ? await api(`/api/artifacts/${cbMeta.id}`) : null;
      const bundle = {
        schema: 'autonear.evidence-bundle/1', generatedAt: new Date().toISOString(), generatedBy: 'AutoNEAR console (assembled in the browser from the public API)', origin: location.origin,
        note: 'Contains only what the API returned. Contract creation bytecode and operator-only data are not included.',
        run: run.run, hashChain: run.chain, events,
        artifacts: run.artifacts.map(({ id, kind, hash, immutable_ref }) => ({ id, kind, hash, immutable_ref })),
        brief: briefQ.data ?? null, securityDossier: dossierQ.data ?? null, contractBuild, decisions, deployments,
      };
      const text = JSON.stringify(bundle, null, 2);
      const digest = await sha256Text(text);
      const blob = new Blob([text], { type: 'application/json' });
      setUrl(URL.createObjectURL(blob));
      setSt({ phase: 'ready', bytes: blob.size, digest, counts: { events: events.length, decisions: decisions.length, deployments: deployments.length, artifacts: bundle.artifacts.length } });
    } catch (e) { setSt({ phase: 'error', error: e }); }
  };
  return (
    <div className="stack">
      <Panel title="Evidence bundle">
        <p className="dim" style={{ marginTop: 0 }}>One JSON file you can archive or hand to a reviewer: the run, every hash-chained event, the brief, the security dossier, the attested build record, the decision(s) with their approval state and any verified deployment, plus all artifact hashes. It is assembled in your browser from the public API.</p>
        <dl className="kv">
          <dt>Run</dt><dd className="mono-v">{runId} · {run.run.state}</dd>
          <dt>Hash chain</dt><dd>{run.chain.ok ? <Chip tone="ok">intact</Chip> : <Chip tone="bad">broken at #{run.chain.brokenAt}</Chip>}</dd>
          <dt>Artifacts</dt><dd className="mono-v">{run.artifacts.map((a) => `${a.kind} ${fmt.short(a.hash, 6)}`).join(' · ') || 'none'}</dd>
          <dt>Decisions</dt><dd className="mono-v">{run.decisions.map((d) => `${d.id} (${d.status})`).join(', ') || 'none'}</dd>
        </dl>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={build} disabled={st.phase === 'building'}>{st.phase === 'building' ? 'Assembling…' : 'Assemble evidence bundle'}</button>
          {st.phase === 'ready' && <a className="btn" href={url} download={`autonear-evidence-${runId}.json`}><Icon name="external" size={16} />Download evidence bundle</a>}
        </div>
        <div aria-live="polite">
          {st.phase === 'ready' && <p className="mono-v" style={{ margin: '12px 0 0' }}>{(st.bytes / 1024).toFixed(1)} KiB · {st.counts.events} events · {st.counts.artifacts} artifacts · {st.counts.decisions} decision(s) · {st.counts.deployments} deployment(s)<br />sha256 <span style={{ overflowWrap: 'anywhere' }}>{st.digest}</span> <CopyButton text={st.digest} label="Copy hash" /></p>}
          {st.phase === 'error' && <div style={{ marginTop: 12 }}><ErrorPanel error={st.error} onRetry={build} what="the evidence bundle" /></div>}
        </div>
      </Panel>
    </div>
  );
}
