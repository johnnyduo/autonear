// One page, one promise, one button. Real numbers only.
import { lazy, Suspense, useState } from 'react';
import { fmt } from '../api.js';
import { useCalm } from '../ui.jsx';
import { T } from './copy.js';
import { href } from './nav.js';
import '../views/constellation/panel.css';
import WalletButton from './WalletButton.jsx';

const Hero = lazy(() => import('../views/constellation/ConstellationHero.jsx'));

export default function Landing({ data }) {
  const calm = useCalm();
  const s = data.status.data;
  const sources = s?.sources ?? [];
  const [ready, setReady] = useState(false);
  const ok = sources.filter((x) => x.status === 'ok').length;
  const proof = [...data.ledger].reverse().find((e) => e.kind === 'deploy' && e.status === 'confirmed' && !data.demo);
  return (
    <div className="ln">
      <header className="ln-top">
        <span className="ap-brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1317" stroke="#232c34" /><path d="M8 24V8l16 16V8" fill="none" stroke="#c6f432" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg><b>{T.brand}</b></span>
        <span className="chip warn">{T.testnet}</span>
      </header>
      <section className="ln-hero co-stagewrap" aria-label="The agent, its sources and your limits">
        <div className={`ln-poster ${ready ? 'gone' : ''}`} aria-hidden="true"><i /></div>
        <div className="ln-bg">
          <Suspense fallback={null}>
            <Hero status={s} sources={sources} activeRun={s?.activeRun ?? null} opps={data.opps} calm={calm} onReady={() => setReady(true)} />
          </Suspense>
        </div>
        <div className="ln-copy" data-reserve>
          <h1>An agent that works for you, <em>on a leash you hold.</em></h1>
          <p className="ln-sub">{T.tagline}</p>
          <div className="ln-cta">
            <WalletButton big hint={false} />
            <a className="btn lg" href={href('', { demo: true })}>{T.demo}</a>
            <a className="btn lg" href={href('constellation')}>Open it full screen</a>
          </div>
          <p className="ln-hint">{T.signHint}</p>
          <p className="ln-live mono">{typeof s?.counts?.evidence === 'number' ? `${s.counts.evidence} real records on screen. Drag it, hover a glyph, click one.` : 'Loading real records…'}</p>
        </div>
      </section>
      <section className="ln-proof" aria-label="Live numbers">
        <div><b>{s ? `${ok}/${sources.length}` : '–'}</b><span>sources being watched</span></div>
        <div><b>{s?.counts?.evidence ?? '–'}</b><span>posts and commits read</span></div>
        <div><b>{s?.counts?.opportunities ?? '–'}</b><span>ideas scored</span></div>
        <div><b>{s?.scheduler?.lastTick ? fmt.ago(s.scheduler.lastTick.at) : '–'}</b><span>last check</span></div>
        {proof && <div className="wide"><b>Latest action</b><span>{fmt.ago(proof.time)}: the agent published a contract through its vault{proof.explorerUrl ? <> · <a href={proof.explorerUrl} target="_blank" rel="noreferrer noopener">see it on chain</a></> : null}</span></div>}
      </section>
      <section className="ln-steps">
        {T.steps.map(([h, p], i) => <article key={h}><span className="eyebrow">Step {i + 1}</span><h2>{h}</h2><p>{p}</p></article>)}
      </section>
      <footer className="ln-foot">Test network only. No real money. The agent holds its own small key; your wallet key never leaves your wallet.</footer>
    </div>
  );
}
