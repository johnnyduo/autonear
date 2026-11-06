// "Next step" under the final judgement in the council score box: the owner's way from a verdict to a published product page.
// The only writes are the owner's own clicks (build, publish), both owner-session requests that are saved in the audit log. Reading this block builds nothing.
import { useEffect, useRef, useState } from 'react';
import { api, isFixtureMode } from '../../api.js';
import { useToast } from '../../ui.jsx';
import { useOwner } from '../../app/session.js';
import { T } from '../../app/copy.js';
import { siteFromReply } from '../../app/build-model.js';
import { nextStep, statusRows } from '../../app/journey-step.js';
import DevelopTheater from './DevelopTheater.jsx';

const J = T.journey;
const WORDS = { ...J, readOnly: T.readOnly, demo: T.demoNote, watchWarn: T.build.watchWarn };

export default function NextStep({ entry, journey, reload }) {
  const owner = useOwner(); const toast = useToast();
  const [building, setBuilding] = useState(null); // { at } while the build request runs
  const [theater, setTheater] = useState(null); // { opener } while the theater is open
  const [fresh, setFresh] = useState(null); // the page just built, until the next council read carries it
  const [buildErr, setBuildErr] = useState(''); const [pubErr, setPubErr] = useState('');
  const [pub, setPub] = useState(false);
  const region = useRef(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const jp = journey?.oppId === entry.oppId ? journey.page ?? null : null;
  useEffect(() => { if (fresh && jp?.hash === fresh.hash) setFresh(null); }, [fresh, jp]);
  if (journey?.oppId !== entry.oppId) return null;

  const page = fresh && jp?.hash !== fresh.hash ? fresh : jp;
  const canWrite = owner.isOwner && !isFixtureMode();
  const step = nextStep({ verdict: entry.verdict, owner, canWrite, demo: isFixtureMode(), page, building: Boolean(building) }, WORDS);
  const rows = statusRows({ journey, page, building: Boolean(building) }, WORDS);

  const build = async (e) => {
    const b = step.actions.build; if (!b || building) return;
    const opener = e.currentTarget; setBuildErr(''); setBuilding({ at: Date.now() }); setTheater({ opener });
    try {
      const made = siteFromReply(await api(`/api/sites/${encodeURIComponent(entry.oppId)}/build`, { method: 'POST', body: { override: b.override } }));
      if (alive.current && made?.hash) setFresh({ slug: made.slug, hash: made.hash, published: Boolean(made.published), publishedHash: made.published ? made.hash : null, built: true });
      await reload();
      if (alive.current) toast(`The page for ${entry.title} is built.`);
    } catch (x) { if (alive.current) { setBuildErr(x.message); toast(x.message, 'bad'); } } finally { if (alive.current) setBuilding(null); }
  };

  const publish = async () => {
    if (!page || pub) return;
    setPub(true); setPubErr('');
    try {
      await api(`/api/sites/${encodeURIComponent(page.slug)}/publish`, { method: 'POST', body: { hash: page.hash } });
      await reload();
      if (alive.current) toast('Published.');
    } catch (x) { if (alive.current) { setPubErr(x.message); toast(x.message, 'bad'); } } finally { if (alive.current) setPub(false); }
  };

  const watch = (e) => { setBuildErr(''); setPubErr(''); setTheater({ opener: e.currentTarget }); };
  const status = building ? 'building' : buildErr || !page ? 'error' : 'ready';

  return (
    <>
      <h4 className="co-sc-h" ref={region} tabIndex={-1}>{J.next}</h4>
      <div className="co-sc-next-step" data-kind={step.kind}>
        <p className="co-sc-ns-head">{step.head}</p>
        {step.warn && <p className="co-sc-ns-warn" role="note">{step.warn}</p>}
        {(step.actions.build || step.actions.watch || step.actions.publish) && (
          <div className="co-sc-ns-act">
            {step.actions.build && <button type="button" className="co-sc-btn primary" onClick={build}>{step.actions.build.label}</button>}
            {step.actions.watch && <button type="button" className="co-sc-btn" onClick={watch}>{J.watchAgain}</button>}
            {step.actions.publish && <button type="button" className="co-sc-btn primary" onClick={publish} disabled={pub}>{pub ? J.publishing : J.publish}</button>}
          </div>
        )}
        {step.actions.build && <p className="co-sc-ns-note">{J.approveNote}</p>}
        {step.reason && <p className="co-sc-ns-why">{step.reason}</p>}
        {step.link && <a className="co-sc-ns-link" href={step.link} target="_blank" rel="noopener noreferrer">{step.link}</a>}
        {(buildErr || pubErr) && !theater && <p className="co-sc-ns-err" role="alert">{pubErr || buildErr}</p>}
        <dl className="co-sc-rows">
          {rows.map((r) => <div key={r.key} className={`co-sc-row ${r.tone}`}><dt>{r.label}</dt><dd>{r.text}</dd></div>)}
        </dl>
      </div>
      {theater && (
        <DevelopTheater
          title={entry.title} page={page} status={status} startedAt={building?.at} error={buildErr} notice={pubErr}
          step={step} publishing={pub} onPublish={publish} onClose={() => setTheater(null)}
          opener={theater.opener} fallback={region.current} toast={toast}
        />
      )}
    </>
  );
}
