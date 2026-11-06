// Build: the last mile. The council backs a product, the owner approves, the agents write an example page, the owner publishes it.
// What is real: council scores, the owner approval (a signed session, saved in the audit log), the page text (written once by Gemini from stored evidence).
// What is a show: the swarm of cursors that draws the page. It replays a stored build and is labelled that way.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Empty, Icon, SkeletonRows } from '../ui.jsx';
import { T } from './copy.js';
import { href } from './nav.js';
import {
  approveAction, approveBlock, buildingLine, councilEntry, currentStep, defaultSelection, goAtOf, hasSite, needsText, publishedIsCurrent,
  rankSites, score, seatBars, siteFromReply, siteLinks, stepState, swarmWord, verdictLabel, verdictTone, visibleRows,
} from './build-model.js';
import { SwarmFrame, lessMotion, useSwarmFrame } from './SwarmFrame.jsx';

const B = T.build;
const STANCE_COL = { back: '#c6f432', abstain: '#f2b84b', object: '#ff6a3d' };

function Queue({ ranked, selected, onPick, goAt }) {
  const [all, setAll] = useState(false);
  const rows = visibleRows(ranked, all);
  return (
    <section className="bd-sec" aria-labelledby="bd-q">
      <h2 id="bd-q" className="bd-h">{B.queue}</h2>
      <p className="faint bd-note">{B.queueHelp}</p>
      {!ranked.length ? <p className="dim">{B.queueEmpty}</p> : (
        <ul className="bd-queue">
          {rows.map((s) => (
            <li key={s.opp_id} className={s.opp_id === selected ? 'on' : ''}>
              <span className="bd-title">{s.title}</span>
              <span className="bd-score num" aria-label={`council score ${score(s.support)} out of 100`}>{score(s.support)}</span>
              <span className={`chip ${verdictTone(s.verdict)}`}>{verdictLabel(s.verdict)}</span>
              <span className="faint bd-need">{needsText(s, goAt)}</span>
              {hasSite(s) && <span className="chip">{s.published ? B.pagePublished : B.pageBuilt}</span>}
              <button type="button" className="btn sm" aria-pressed={s.opp_id === selected} onClick={() => onPick(s.opp_id)}>{s.opp_id === selected ? B.selected : B.open}</button>
            </li>
          ))}
        </ul>
      )}
      {ranked.length > 4 && <button type="button" className="btn sm ghost" onClick={() => setAll(!all)}>{all ? B.showFewer : `${B.showAll} (${ranked.length})`}</button>}
    </section>
  );
}

/** Seven seats with their stored scores. The bars grow one after another each time the step is (re)mounted; a new product remounts it via `key`. */
function Seats({ entry, site, goAt }) {
  const bars = seatBars(entry);
  if (!bars.length) return <p className="dim">The stored votes for this product are not available.</p>;
  return (
    <>
      <ul className="bd-seats">
        {bars.map((v, i) => (
          <li key={v.role} style={{ '--i': i }}>
            <span className="bd-seat">{v.label}</span>
            <span className="bd-bar" role="img" aria-label={`${v.label}: ${v.pct} out of 100`}><i style={{ width: `${v.pct}%`, background: STANCE_COL[v.stance] ?? '#8c8b82' }} /></span>
            <span className="num bd-pct">{v.pct}</span>
          </li>
        ))}
      </ul>
      <p className="bd-total"><b className="num">{score(site.support)}</b> of 100 · {verdictLabel(site.verdict)} · build needs {score(goAt)}</p>
      <p className="faint bd-note">{B.voteNote}</p>
    </>
  );
}

function CopyLink({ label, url, path, toast }) {
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast(B.copied); } catch { toast('Copying did not work here. Select the link and copy it by hand.', 'bad'); } };
  return (
    <div className="bd-link">
      <span className="faint">{label}</span>
      <span className="row"><a className="mono-v" href={path} target="_blank" rel="noopener noreferrer">{url}</a><button type="button" className="btn sm" onClick={copy}><Icon name="copy" size={14} />{B.copy}</button></span>
    </div>
  );
}

function Preview({ site, motionOff, frameKey }) {
  const links = siteLinks(site, '');
  const { frame, view, send } = useSwarmFrame(links?.previewPath, frameKey);
  return (
    <section className="bd-sec" aria-labelledby="bd-p">
      <h2 id="bd-p" className="bd-h">{B.preview}</h2>
      {!links?.previewPath ? <div className="bd-empty"><Empty title="No page yet">{B.emptyPreview}</Empty></div> : (
        <>
          <div className="bd-frame">
            <SwarmFrame frame={frame} src={links.previewPath} title={`Preview of the page for ${site.title}`} frameKey={frameKey} />
          </div>
          <div className="bd-ctl">
            <button type="button" className="btn sm" onClick={() => send('play')} disabled={motionOff}><Icon name="play" size={14} />{B.replay}</button>
            <button type="button" className="btn sm" onClick={() => send('skip')} disabled={motionOff}>{B.skip}</button>
            <div className="bd-prog" role="progressbar" aria-label="Replay progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((view?.progress ?? 0) * 100)}><i style={{ width: `${(view?.progress ?? 0) * 100}%` }} /></div>
            <span className="faint bd-state" role="status">{motionOff ? B.reduced : swarmWord(view)}</span>
          </div>
          {view?.phase === 'running' && view.agents.length > 0 && (
            <ul className="bd-agents" aria-label="What each agent is doing">
              {view.agents.map((a) => <li key={a.name}><i style={{ background: a.color }} aria-hidden="true" /><b>{a.name}</b><span className="faint">{a.doing || 'idle'}</span></li>)}
            </ul>
          )}
          <p className="faint bd-note">{B.replayLabel}</p>
        </>
      )}
    </section>
  );
}

export default function Build({ data, owner, canWrite, demo, opts, toast }) {
  const sitesApi = useApi('/api/sites');
  const councilApi = useApi('/api/council', { poll: 30000 });
  const [pick, setPick] = useState(null);
  const [building, setBuilding] = useState(null); // { oppId, at } while a build request is running
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState({ oppId: null, msg: '' });
  const [pub, setPub] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const ranked = useMemo(() => rankSites(sitesApi.data), [sitesApi.data]);
  const selectedId = defaultSelection(ranked, pick);
  const site = ranked.find((s) => s.opp_id === selectedId) ?? null;
  const entry = councilEntry(councilApi.data, selectedId);
  const goAt = goAtOf(councilApi.data);
  const busyHere = building && building.oppId === selectedId;
  const step = currentStep({ site, building: busyHere });
  const action = approveAction(site);
  const block = approveBlock({ owner, canWrite, demo, site, building: Boolean(building) }, { connect: B.connect, readOnly: T.readOnly, demo: T.demoNote, pick: B.pick, building: B.busy });
  const links = siteLinks(site, location.origin);
  const here = err.oppId === selectedId ? err.msg : '';

  useEffect(() => { if (!building) return undefined; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [building]);

  const build = useCallback(async () => {
    if (!site || block) return;
    const oppId = site.opp_id;
    setErr({ oppId: null, msg: '' });
    setBuilding({ oppId, at: Date.now() }); // the Build step starts the moment the owner approves
    try {
      const r = await api(`/api/sites/${encodeURIComponent(oppId)}/build`, { method: 'POST', body: { override: action.override } });
      const made = siteFromReply(r);
      await sitesApi.reload();
      if (alive.current) { setPick(oppId); setFrameKey((k) => k + 1); toast(`The page for ${made?.title ?? site.title} is built.`); }
    } catch (e) { if (alive.current) { setErr({ oppId, msg: e.message }); toast(e.message, 'bad'); } } finally { if (alive.current) setBuilding(null); }
  }, [site, block, action.override, sitesApi, toast]);

  const publish = async (un) => {
    if (!site?.slug) return;
    setPub(true); setErr({ oppId: null, msg: '' });
    try {
      await api(`/api/sites/${encodeURIComponent(site.slug)}/${un ? 'unpublish' : 'publish'}`, { method: 'POST', body: un ? {} : { hash: site.hash } });
      await sitesApi.reload();
      toast(un ? 'The page is no longer public.' : 'Published.');
    } catch (e) { setErr({ oppId: site.opp_id, msg: e.message }); toast(e.message, 'bad'); } finally { if (alive.current) setPub(false); }
  };

  if (sitesApi.error && !sitesApi.data) return <div className="ap-wrap"><h1 className="pg">Build</h1><p role="alert">{B.loadFail} {sitesApi.error.message} <button type="button" className="btn sm" onClick={sitesApi.reload}>Retry</button></p></div>;
  if (sitesApi.loading && !sitesApi.data) return <div className="ap-wrap"><h1 className="pg">Build</h1><SkeletonRows n={4} /></div>;

  const state = (i) => stepState(i, step, site);
  const stepCls = (i) => `bd-step ${state(i)}`;
  const current = (i) => (state(i) === 'now' ? 'step' : undefined);
  return (
    <div className="ap-wrap bd">
      <h1 className="pg">Build</h1>
      <p className="pg-sub">{B.intro}</p>
      <Queue ranked={ranked} selected={selectedId} onPick={(id) => { setPick(id); setErr({ oppId: null, msg: '' }); }} goAt={goAt} />

      {site && (
        <ol className="bd-steps" aria-label={`Steps for ${site.title}`}>
          <li className={stepCls(1)} aria-current={current(1)}>
            <header><span className="bd-n" aria-hidden="true">1</span><h3>{B.steps[0]}</h3><span className="faint">{site.title}</span></header>
            {councilApi.loading && !councilApi.data ? <SkeletonRows n={3} /> : <Seats key={site.opp_id} entry={entry} site={site} goAt={goAt} />}
          </li>
          <li className={stepCls(2)} aria-current={current(2)}>
            <header><span className="bd-n" aria-hidden="true">2</span><h3>{B.steps[1]}</h3></header>
            {action.warn && <p className="bd-warn" role="note"><Icon name="alert" size={14} />{B.watchWarn}</p>}
            <div className="row">
              <button type="button" className="btn primary" disabled={Boolean(block)} aria-describedby="bd-why" onClick={build}>{action.label}</button>
            </div>
            <p id="bd-why" className="faint bd-note">{block ? <><Icon name="lock" size={14} /> {block}</> : B.ownerHelp}</p>
          </li>
          <li className={stepCls(3)} aria-current={current(3)}>
            <header><span className="bd-n" aria-hidden="true">3</span><h3>{B.steps[2]}</h3></header>
            {busyHere ? <p role="status" className="bd-run"><span className="bd-spin" aria-hidden="true" />{buildingLine(now - building.at)}</p>
              : hasSite(site) ? <p className="dim">{B.buildDone} Written by {site.model ?? 'Gemini'}{site.tokens ? `, ${site.tokens} tokens` : ''}{site.cost ? `, ${fmt.usd(site.cost)}` : ''}{site.built_at ? `, ${fmt.ago(site.built_at)}` : ''}.{site.override ? ' Built on the owner’s call.' : ''}</p>
                : <p className="dim">{B.buildIdle}</p>}
            {here && <p className="bd-err" role="alert"><Icon name="alert" size={14} />{here}</p>}
          </li>
          <li className={stepCls(4)} aria-current={current(4)}>
            <header><span className="bd-n" aria-hidden="true">4</span><h3>{B.steps[3]}</h3></header>
            {!hasSite(site) ? <p className="dim">{B.needBuild}</p> : (
              <>
                <p className="faint bd-note">{B.publishHelp}</p>
                <div className="row">
                  <button type="button" className="btn primary" disabled={!owner.isOwner || !canWrite || demo || pub || publishedIsCurrent(site)} onClick={() => publish(false)}>{pub ? B.publishing : B.publish}</button>
                  {site.published && <button type="button" className="btn" disabled={!owner.isOwner || !canWrite || demo || pub} onClick={() => publish(true)}>{B.unpublish}</button>}
                  {!owner.isOwner && <span className="faint"><Icon name="lock" size={14} /> {owner.address ? T.readOnly : B.connect}</span>}
                </div>
                {site.published && <CopyLink label={B.linkPublic} url={links.publicUrl} path={links.publicPath} toast={toast} />}
                <CopyLink label={B.linkExact} url={links.exactUrl} path={links.exactPath} toast={toast} />
              </>
            )}
          </li>
        </ol>
      )}

      {site ? <Preview site={site} motionOff={lessMotion()} frameKey={frameKey} />
        : <section className="bd-sec"><div className="bd-empty"><Empty title="No page yet">{B.emptyPreview}</Empty></div></section>}
      <p className="faint bd-note"><a href={href('council', opts)}>Back to the Council</a></p>
    </div>
  );
}
