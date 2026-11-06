// One page, one promise, one button. Real numbers only.
import { Fragment, lazy, Suspense, useRef, useState } from 'react';
import { makeLandingDemo } from './landing-demo.js';
import { fmt } from '../api.js';
import { useCalm } from '../ui.jsx';
import { T } from './copy.js';
import { href } from './nav.js';
import '../views/constellation/panel.css';
import WalletButton from './WalletButton.jsx';
import LandingCard from './LandingCard.jsx';
import LandingFx from './LandingFx.jsx';

const Hero = lazy(() => import('../views/constellation/ConstellationHero.jsx'));

const HEAD_A = 'An agent that works for you,'; const HEAD_B = 'on a leash you hold.';
// each word sits in a mask and rises into it; the heading stays one sentence for screen readers (aria-label on the h1)
const Words = ({ text, from }) => text.split(' ').map((w, i, all) => <Fragment key={w + i}><span className="ln-word" aria-hidden="true" style={{ '--i': from + i }}><span>{w}</span></span>{i < all.length - 1 ? ' ' : null}</Fragment>);

export default function Landing({ data, connected = false }) {
  const calm = useCalm();
  const heroRef = useRef(null);
  const s = data.status.data;
  const sources = s?.sources ?? [];
  const [ready, setReady] = useState(false);
  const [star, setStar] = useState('evidence'); const [cc, setCc] = useState(null); // the score card belongs to the council star: it shows only while that star is selected
  const [demo] = useState(() => makeLandingDemo()); // example data for the picture only, see landing-demo.js
  const ok = sources.filter((x) => x.status === 'ok').length;
  const proof = [...data.ledger].reverse().find((e) => e.kind === 'deploy' && e.status === 'confirmed' && !data.demo);
  return (
    <div className="ln">
      <header className="ln-top">
        <a className="ap-brand" href={href('welcome')} aria-label={`${T.brand} home`}><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1317" stroke="#232c34" /><path d="M8 24V8l16 16V8" fill="none" stroke="#c6f432" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg><b>{T.brand}</b></a>
        <span className="chip warn">{T.testnet}</span>
      </header>
      <section className={`ln-hero co-stagewrap${calm ? '' : ' fx'}`} ref={heroRef} aria-label="Illustration: topics the agent reads, drawn as a sphere of example records">
        <div className={`ln-poster ${ready ? 'gone' : ''}`} aria-hidden="true"><i /></div>
        <div className={`ln-bg${ready || calm ? ' in' : ''}`}>
          <Suspense fallback={null}>
            <Hero status={null} sources={demo.sources} activeRun={null} opps={demo.opps} demo={demo} demoCouncil={cc} onStar={setStar} calm={calm} onReady={() => setReady(true)} />
          </Suspense>
        </div>
        <LandingFx heroRef={heroRef} calm={calm} />
        {star === 'council' && <LandingCard onStory={setCc} />}
        <div className="ln-copy" data-reserve>
          <h1 aria-label={`${HEAD_A} ${HEAD_B}`}><Words text={HEAD_A} from={0} />{' '}<em><Words text={HEAD_B} from={HEAD_A.split(' ').length} /></em></h1>
          <p className="ln-sub">{T.tagline}</p>
          <div className="ln-cta">
            {connected ? <a className="btn primary lg" href={href('')}>Open the app</a> : <WalletButton big hint={false} />}
            <a className="btn lg" href={href('', { demo: true })}>{T.demo}</a>
            <a className="btn lg" href={href('constellation')}>See the real evidence</a>
          </div>
          {!connected && <p className="ln-hint">{T.signHint}</p>}
          <p className="ln-live mono">Illustration: made-up records and scores. Click the pink orb to open the council card. Real data is in the app.</p>
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
