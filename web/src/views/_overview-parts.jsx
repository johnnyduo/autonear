// Overview hero wrapper. The panel reserves its space (CLS 0) and shows a decorative CSS poster; the heavy renderer is a separate lazy chunk
// that is requested only when the panel is near the viewport and the browser is idle, so first paint / LCP never wait for it.
// Honesty rules live in constellation/ConstellationHero.jsx and are repeated in the visible caption below.
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { fmt } from '../api.js';
import { useCalm } from '../ui.jsx';
import { srcColor, srcShort } from './_evidence-parts.jsx';
import { RECENT_MS, isRecent, lastIngest, roleStates } from './constellation/shared.js';
import './constellation/panel.css';

export { RECENT_MS, isRecent, lastIngest, roleStates };
const Hero = lazy(() => import('./constellation/ConstellationHero.jsx'));

const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1800 }) : setTimeout(fn, 250));
const cancelIdle = (h) => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(h) : clearTimeout(h));

export function ConstellationPanel({ status, opps, evidenceCount, full = false, stage = false }) {
  const s = status.data; const src = s?.sources ?? []; const activeRun = s?.activeRun ?? null;
  const calm = useCalm(); const hid = useId(); const wrap = useRef(null);
  const [mount, setMount] = useState(full || stage); const [ready, setReady] = useState(false); const [stats, setStats] = useState(null);

  useEffect(() => {
    const el = wrap.current; if (!el || mount) return undefined; let h = 0;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); h = idle(() => setMount(true)); } }, { rootMargin: '480px 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (h) cancelIdle(h); };
  }, [mount]);

  const total = evidenceCount ?? s?.counts?.evidence; const loaded = stats?.loaded ?? total;
  const oppN = opps?.length ?? s?.counts?.opportunities;
  const recents = src.filter((x) => isRecent(x));
  const detail = (
    <>
        <ul className="co-leg" aria-label="Sources">
          {src.map((x) => (
            <li key={x.id}><i style={{ background: srcColor(x.id) }} aria-hidden="true" /><b>{srcShort(x.id)}</b>
              <span className={isRecent(x) ? 'ok' : x.status !== 'ok' ? 'bad' : 'faint'}>{x.status !== 'ok' ? x.status.replace('_', ' ') : isRecent(x) ? `ingested ${fmt.ago(lastIngest(x))}: pulsing` : `quiet · last ${fmt.ago(lastIngest(x))}`}</span></li>
          ))}
        </ul>
        <p className="faint co-cap-note">
          A source orbit pulses only if that source ingested within 20 minutes{recents.length ? ` (${recents.length} now)` : ' (none now)'}.
          {' '}Agent roles light only while a run&rsquo;s events show them active{activeRun ? `: run ${activeRun.id.slice(0, 12)} is ${activeRun.state}` : '; no run is active, so they stay dark'}.
          {stats?.linkFail ? ` ${stats.linkFail} opportunity link request(s) failed; some links are missing.` : ''}
          {calm ? ' Motion is off (reduced-motion).' : ''}
        </p>
    </>
  );
  return (
    <section className={`panel co-panel${full ? ' co-fullpage' : ''}${stage ? ' co-stagepage' : ''}`} aria-labelledby={hid}>
      <div className="co-stagewrap" ref={wrap}>
        <div className={`co-poster ${ready ? 'gone' : ''}`} aria-hidden="true"><i /></div>
        <header className="co-title" data-reserve>
          <p className="eyebrow">Evidence constellation · from the stored API data</p>
          <h2 id={hid}>Every stored record, <em>fingerprinted</em>.</h2>
          <p className="co-title-s mono">{typeof total === 'number' ? `${total} records` : '…'} · {src.length || '…'} sources · {oppN ?? '…'} opportunities</p>
        </header>
        {mount && (
          <Suspense fallback={null}>
            <Hero status={s} sources={src} activeRun={activeRun} opps={opps} calm={calm} full={full} onReady={() => setReady(true)} onStats={setStats} />
          </Suspense>
        )}
      </div>
      {full ? (
        <footer className="co-full-foot">
          <p className="co-cap-main"><b>Computed from {loaded ?? '…'} stored evidence records; not a simulation.</b> Ribbons, pop-up cards and relation lines come from stored data (the card tour is not a live feed); the nebula, dust, turning rings, shockwaves, sweep and comets are decorative.</p>
          <details className="co-full-more"><summary>Details</summary>
            <div className="co-full-more-in">{detail}</div>
          </details>
          <a className="co-ib co-exit" href="#/">Exit full screen<kbd>Esc</kbd></a>
        </footer>
      ) : (
      <div className="co-caption">
        <p className="co-cap-main"><b>Layout is computed from {loaded ?? '…'} stored evidence records{typeof total === 'number' && loaded < total ? ` (of ${total})` : ''}; not a simulation.</b> Each glyph is a fingerprint of one record&rsquo;s stored content hash; ribbons show how many stored records each source contributed to each topic, and the pop-up cards step through real stored records (a tour, not a live feed). The nebula, dust arms, turning rings, shockwaves, radar sweep, comets and glow are decorative and carry no data. No swarm or prediction engine is running.</p>
        {detail}
      </div>
      )}
    </section>
  );
}
