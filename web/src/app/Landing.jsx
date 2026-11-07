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

// Only standards the code really uses. ERC-8004 is an adapter and is off unless AGENT_PUBLIC_URL is set.
const STANDARDS = [
  ['NEP-518', 'MetaMask signs NEAR', 'An Ethereum wallet signs NEAR transactions; a relayer submits them. The owner never installs a second wallet.'],
  ['EIP-191', 'owner sign-in', 'Signing a plain-text challenge proves control of the owner address. No transaction, no cost.'],
  ['EIP-1193 · 6963', 'wallet connect', 'Injected wallets are discovered and used through the standard provider API. No WalletConnect.'],
  ['NEP-141 · 145', 'agent pays stablecoins', 'The agent pays with ft_transfer through the vault: only to payees the owner allowed, inside the owner caps, after a storage registration check. No card, no API key.'],
  ['NEP-297', 'contract events', 'Every state change in the contracts emits one standard event, so the audit trail can be read from the chain.'],
  ['EIP-1559 · 155 · 55', 'agent EVM signer', 'The agent signs its own EVM transactions (type 2 and legacy) and checks address checksums, with its own key code. No wallet library.'],
  ['Mandate Vault', 'ERC-7710 style limits, native on NEAR', 'Our own contract: the agent gets a budget, a per-draw cap and an expiry that the chain enforces. The same idea as ERC-7710 delegations and ERC-4337 session keys, built for NEAR. It does not implement either standard.'],
  ['ERC-8004', 'agent identity', 'An adapter that can publish the agent registration file. Off unless the operator sets a public URL.'],
];

export default function Landing({ data, connected = false }) {
  const calm = useCalm();
  const heroRef = useRef(null);
  const s = data.status.data;
  const sources = s?.sources ?? [];
  const [ready, setReady] = useState(false);
  const [star, setStar] = useState('evidence'); const [cc, setCc] = useState(null); // the score card belongs to the council star: it shows only while that star is selected
  const [demo] = useState(() => makeLandingDemo()); // made-up data for the picture only, see landing-demo.js
  const ok = sources.filter((x) => x.status === 'ok').length;
  const c = s?.counts;
  const feedList = sources.filter((x) => x.watched && x.subSources?.length).map((x) => `${x.name}: ${x.subSources.join('; ')}`).join('. ');
  const scoreParts = c && c.scores != null ? `${c.evidence} relevance, ${c.seatVotes} seat votes, ${c.opportunities} council` : '';
  const scoreTitle = scoreParts ? `${c.evidence} relevance scores (one per post or commit read), ${c.seatVotes} seat votes (${c.opportunities} scored x ${c.seats} council seats), ${c.opportunities} council scores` : undefined;
  const proof = [...data.ledger].reverse().find((e) => e.kind === 'deploy' && e.status === 'confirmed' && !data.demo);
  return (
    <div className="ln">
      <header className="ln-top">
        <a className="ap-brand" href={href('welcome')} aria-label={`${T.brand} home`}><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1317" stroke="#232c34" /><path d="M8 24V8l16 16V8" fill="none" stroke="#c6f432" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg><b>{T.brand}</b></a>
        <span className="chip warn">{T.testnet}</span>
      </header>
      <section className={`ln-hero co-stagewrap${calm ? '' : ' fx'}`} ref={heroRef} aria-label="Illustration: topics the agent reads, drawn as a sphere of made-up records">
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
          <ul className="ln-std mono" aria-label="Standards AutoNEAR is built on">
            {STANDARDS.map(([id, what, tip]) => <li key={id} title={tip}><b>{id}</b> {what}</li>)}
          </ul>
        </div>
      </section>
      <section className="ln-proof" aria-label="Live numbers">
        <div title={feedList || undefined} aria-describedby={feedList ? 'ln-feeds' : undefined}><b>{s ? (c?.feeds ?? ok) : '–'}</b><span>{c?.feeds != null ? 'feeds being watched' : 'sources being watched'}</span>{s && <small>from {ok} of {sources.length} sources</small>}{feedList && <i className="ln-sr" id="ln-feeds">{feedList}</i>}</div>
        <div><b>{c?.evidence ?? '–'}</b><span>posts and commits read</span></div>
        <div title={scoreTitle}><b>{c?.scores ?? '–'}</b><span>scores computed</span>{scoreParts && <small>{scoreParts}</small>}</div>
        <div><b>{s?.scheduler?.lastTick ? fmt.ago(s.scheduler.lastTick.at) : '–'}</b><span>last check</span></div>
        {proof && <div className="wide"><b>Latest action</b><span>{fmt.ago(proof.time)}: the agent published a contract through its vault{proof.explorerUrl ? <> · <a href={proof.explorerUrl} target="_blank" rel="noreferrer noopener">see it on chain</a></> : null}</span></div>}
      </section>
      <section className="ln-steps">
        {T.steps.map(([h, p], i) => <article key={h}><span className="eyebrow">Step {i + 1}</span><h2>{h}</h2><p>{p}</p></article>)}
      </section>
      <footer className="ln-foot">
        <figure className="ln-quote">
          <blockquote>&ldquo;Every program and every user of the system should operate using the least set of privileges necessary to complete the job.&rdquo;</blockquote>
          <figcaption>Saltzer and Schroeder, <cite>The Protection of Information in Computer Systems</cite>, 1975</figcaption>
        </figure>
      </footer>
    </div>
  );
}
