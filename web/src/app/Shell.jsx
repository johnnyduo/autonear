// The owner app shell: one top bar, four tabs, an Activity drawer. Everything technical is one click away inside Activity, never in the menu.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { setToken, useToken } from '../api.js';
import { CommandPalette, Dialog, ErrorPanel, Icon, SkeletonRows, useToast } from '../ui.jsx';
import { useAppData } from './data.js';
import { APP_ROUTES, goto, href, parseRoute } from './nav.js';
import { ROUTES, T } from './copy.js';
import { shortAddr, signOut, useOwner, verifySession } from './session.js';
import WalletButton from './WalletButton.jsx';
import Landing from './Landing.jsx';
import './app.css';

const Home = lazy(() => import('./Home.jsx'));
const Approvals = lazy(() => import('./Approvals.jsx'));
const Watch = lazy(() => import('./Watch.jsx'));
const VaultPage = lazy(() => import('./VaultPage.jsx'));
const Activity = lazy(() => import('./Activity.jsx'));
// Technical screens kept as deep links (reachable from Activity), not in the menu.
const LEGACY = {
  radar: lazy(() => import('../views/Radar.jsx')), opportunity: lazy(() => import('../views/Opportunity.jsx')), run: lazy(() => import('../views/RunTheater.jsx')),
  studio: lazy(() => import('../views/Studio.jsx')), approval: lazy(() => import('../views/Approval.jsx')), security: lazy(() => import('../views/Security.jsx')),
  engines: lazy(() => import('../views/Engines.jsx')),
  // The evidence constellation: the technical overview (with the embedded panel) and the full-screen app.
  dashboard: lazy(() => import('../views/Overview.jsx')), constellation: lazy(() => import('../views/ConstellationFull.jsx')),
};
const LegacyVault = lazy(() => import('../views/vault/Vault.jsx'));
const PAGES = { home: Home, approvals: Approvals, watch: Watch, vault: VaultPage };

export default function Shell() {
  const [route, setRoute] = useState(parseRoute());
  const [palette, setPalette] = useState(false);
  const owner = useOwner(); const toast = useToast(); const data = useAppData(); const token = useToken(); const [tokDlg, setTokDlg] = useState(false);
  useEffect(() => { const f = () => { setRoute(parseRoute()); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { const f = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  useEffect(() => { verifySession(); }, []);
  useEffect(() => { document.title = `${ROUTES[route.name] ?? 'Details'} · ${T.brand}`; window.scrollTo(0, 0); }, [route.name]);

  const demo = route.demo || data.demo;
  const connected = Boolean(owner.address);
  const canWrite = owner.isOwner && !route.demo; // the preview (?fixture=1) can never write; "no vault yet" demo data only blocks vault-bound actions (pages check `demo`)
  const pending = useMemo(() => data.decisions.filter((d) => d.effectiveStatus === 'pending').length, [data.decisions]);
  const opts = { demo: route.demo };
  const commands = useMemo(() => [
    ...APP_ROUTES.map((r) => ({ label: `Go to ${ROUTES[r]}`, hint: '', run: () => goto(r === 'home' ? '' : r, opts) })),
    { label: 'Open Activity', hint: '', run: () => goto(route.name === 'home' ? '' : route.name, { ...opts, activity: true }) },
    { label: 'Open the evidence constellation (full screen)', hint: 'constellation', run: () => goto('constellation', opts) },
    ...['dashboard', 'radar', 'run', 'studio', 'security', 'engines'].map((r) => ({ label: `Technical: ${r}`, hint: 'details', run: () => goto(r, opts) })),
    { label: 'Operator access (token)', hint: 'ops', run: () => setTokDlg(true) },
  ], [route.name, route.demo]); // eslint-disable-line react-hooks/exhaustive-deps

  const advancedVault = route.name === 'vault' && ['grant', 'advanced'].includes(route.params[0]);
  const isApp = APP_ROUTES.includes(route.name) && !advancedVault;
  if (isApp && !connected && !route.demo) return <Landing data={data} />;

  const Legacy = LEGACY[route.name] ?? (advancedVault ? LegacyVault : null);
  const Page = PAGES[route.name];
  const props = { data, owner, canWrite, demo, opts, toast };
  const status = data.status;
  const base = route.name === 'home' ? '' : route.name;
  return (
    <div className={`ap${demo ? ' is-demo' : ''}`}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="ap-top">
        <a className="ap-brand" href={href('', opts)} aria-label={`${T.brand} home`}>
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1317" stroke="#232c34" /><path d="M8 24V8l16 16V8" fill="none" stroke="#c6f432" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg>
          <b>{T.brand}</b>
        </a>
        <nav className="ap-tabs" aria-label="Main">
          {APP_ROUTES.map((r) => (
            <a key={r} href={href(r === 'home' ? '' : r, opts)} aria-current={route.name === r ? 'page' : undefined}>
              {ROUTES[r]}{r === 'approvals' && pending > 0 && <span className="ap-count" aria-label={`${pending} waiting`}>{pending}</span>}
            </a>
          ))}
        </nav>
        <div className="ap-right">
          <a className="btn sm ghost" href={href(base, { ...opts, activity: true })}><Icon name="clock" size={16} />{T.activity}</a>
          {connected
            ? <WalletChip owner={owner} />
            : <WalletButton hint={false} />}
        </div>
      </header>
      {demo && <div className="ap-demo" role="note"><b>{T.demoBadge}</b><span>{route.demo ? T.demoNote : T.demoNoVault}</span>{route.demo && <a href={href(base)} onClick={() => { /* leaving the preview */ }}>Leave the demo</a>}</div>}
      <main id="main" tabIndex={-1} className="ap-main">
        <Suspense fallback={<div className="ap-wrap"><SkeletonRows n={5} /></div>}>
          {status.error && !status.data && !route.demo ? <div className="ap-wrap"><ErrorPanel error={status.error} onRetry={status.reload} what="the agent’s status" /></div>
            : Legacy ? <div className="ap-legacy"><a className="btn sm ghost" href={href('', opts)}>← Back to {T.brand}</a><Legacy params={route.params} status={status} token={token} /></div>
              : Page ? <Page {...props} /> : null}
        </Suspense>
      </main>
      <nav className="ap-bottom" aria-label="Main (mobile)">
        {APP_ROUTES.map((r) => <a key={r} href={href(r === 'home' ? '' : r, opts)} aria-current={route.name === r ? 'page' : undefined}>{ROUTES[r]}{r === 'approvals' && pending > 0 && <span className="ap-count">{pending}</span>}</a>)}
      </nav>
      {route.activity && <Suspense fallback={null}><Activity data={data} opts={opts} base={base} canWrite={canWrite} /></Suspense>}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {tokDlg && <TokenDialog token={token} onClose={() => setTokDlg(false)} />}
    </div>
  );
}

function WalletChip({ owner }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ap-chip">
      <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`ap-dot ${owner.isOwner ? 'ok' : 'off'}`} aria-hidden="true" />{shortAddr(owner.address)}<small>{owner.isOwner ? 'Owner' : 'View only'}</small>
      </button>
      {open && (
        <div className="ap-pop" role="dialog" aria-label="Wallet">
          <p>{owner.isOwner ? 'You are signed in as the vault owner.' : 'This wallet is not the vault owner, so you can look but not change anything.'}</p>
          <button type="button" className="btn sm" onClick={() => { setOpen(false); signOut(); }}>{T.signOut}</button>
        </div>
      )}
    </div>
  );
}

function TokenDialog({ token, onClose }) {
  const [v, setV] = useState('');
  return (
    <Dialog title="Operator access" onClose={onClose}>
      <p className="dim">For the person running the server. Owners do not need this: signing in with the wallet is enough. The token is kept in this tab only.</p>
      <form onSubmit={(e) => { e.preventDefault(); setToken(v.trim()); onClose(); }} className="stack">
        <div className="field"><label htmlFor="tok">Operator token</label><input id="tok" className="input mono-i" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={token ? '•••• set for this tab' : 'paste token'} /></div>
        <div className="row"><button className="btn primary" type="submit" disabled={!v.trim()}>Use token</button>{token && <button type="button" className="btn" onClick={() => { setToken(''); onClose(); }}>Clear</button>}</div>
      </form>
    </Dialog>
  );
}
