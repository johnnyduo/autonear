import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt, setToken, useApi, useToken } from './api.js';
import { CommandPalette, Dialog, ErrorPanel, Icon, Led, NeedsOperator, SkeletonRows, ToastProvider, useToast } from './ui.jsx';

// Route table. Views are bundled with the shell (one network hop to first content = better LCP);
// the heavy wallet layer (wagmi/viem) stays lazy inside the Approval view.
import Overview from './views/Overview.jsx';
import Radar from './views/Radar.jsx';
import Opportunity from './views/Opportunity.jsx';
import RunTheater from './views/RunTheater.jsx';
import Studio from './views/Studio.jsx';
import Approval from './views/Approval.jsx';
import Security from './views/Security.jsx';
import Engines from './views/Engines.jsx';
const V = { overview: Overview, radar: Radar, opportunity: Opportunity, run: RunTheater, studio: Studio, approval: Approval, security: Security, engines: Engines };
const NAV = [
  ['overview', 'Overview', 'overview', '#/'],
  ['radar', 'Radar', 'radar', '#/radar'],
  ['opportunity', 'Dossier', 'dossier', '#/opportunity/opp_treasury'],
  ['run', 'Runs', 'run', '#/run'],
  ['studio', 'Studio', 'studio', '#/studio'],
  ['approval', 'Approve', 'approve', '#/approval'],
  ['security', 'Security', 'security', '#/security'],
  ['engines', 'Engines', 'engine', '#/engines'],
];

function parseHash() {
  const h = (location.hash || '#/').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [name = 'overview', ...params] = h;
  return { name: V[name] ? name : 'overview', params };
}

function Shell() {
  const [route, setRoute] = useState(parseHash());
  const token = useToken();
  const toast = useToast();
  const [palette, setPalette] = useState(false);
  const [tokDlg, setTokDlg] = useState(false);
  const status = useApi('/api/status', { poll: 15000 });
  const pending = useApi('/api/decisions', { poll: 30000 });
  const pendingCount = (pending.data?.items ?? []).filter((d) => d.effectiveStatus === 'pending').length;

  useEffect(() => { const f = () => { setRoute(parseHash()); window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { const f = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  useEffect(() => { document.title = `${NAV.find((n) => n[0] === route.name)?.[1] ?? 'AutoNEAR'} · AutoNEAR`; }, [route]);

  const s = status.data;
  const togglePause = useCallback(async () => {
    try { await api(s?.paused ? '/api/security/resume' : '/api/security/pause', { method: 'POST' }); toast(s?.paused ? 'Pipeline resumed' : 'Kill switch engaged: runs and approvals are blocked'); status.reload(); }
    catch (e) { toast(e.message, 'bad'); }
  }, [s, toast, status]);
  const commands = useMemo(() => [
    ...NAV.map(([, label, , href]) => ({ label: `Go to ${label}`, hint: href, run: () => { location.hash = href; } })),
    { label: s?.paused ? 'Resume pipeline' : 'Engage kill switch', hint: 'operator', run: togglePause },
    { label: 'Set operator token', hint: 'auth', run: () => setTokDlg(true) },
    { label: 'Ingest all sources now', hint: 'operator', run: async () => { try { toast('Ingesting…'); await api('/api/ingest', { method: 'POST' }); toast('Ingestion finished'); status.reload(); } catch (e) { toast(e.message, 'bad'); } } },
  ], [s, togglePause, toast, status]);

  const View = V[route.name];
  const src = s?.sources ?? [];
  const bad = src.filter((x) => x.status !== 'ok').length;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="rail" aria-label="Primary">
        <a className="brand" href="#/" aria-label="AutoNEAR home">
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1317" stroke="#232c34" /><path d="M8 24V8l16 16V8" fill="none" stroke="#c6f432" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></svg>
        </a>
        <nav className="nav">
          {NAV.map(([key, label, icon, href]) => (
            <a key={key} href={href} aria-current={route.name === key ? 'page' : undefined}>
              <Icon name={icon} /> {label}
              {key === 'approval' && pendingCount > 0 && <span className="badge-dot" aria-label={`${pendingCount} decision awaiting`} />}
            </a>
          ))}
        </nav>
        <div className="rail-foot"><button className="btn ghost sm" onClick={() => setPalette(true)} aria-label="Open command palette (Ctrl or Command K)"><Icon name="cmd" size={16} /></button></div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row grow" style={{ gap: 12 }} aria-live="polite">
            {!s ? <span className="faint mono">connecting…</span> : <>
              <span className="row" style={{ gap: 6 }}><Led tone={s.paused ? 'bad' : bad ? 'warn' : 'ok'} live={!s.paused && !bad} /><span className="mono">{s.paused ? 'paused' : 'live'}</span></span>
              <span className="mono faint clip">{src.length - bad}/{src.length} sources ok · next collect {fmt.until(s.scheduler?.nextRunAt)}{s.activeRun ? ` · run ${s.activeRun.state}` : ''}</span>
            </>}
          </div>
          <NeedsOperator token={token} hint="Read-only">
            <button className="btn sm danger" onClick={togglePause}><Icon name={s?.paused ? 'play' : 'pause'} size={14} />{s?.paused ? 'Resume' : 'Kill switch'}</button>
          </NeedsOperator>
          <button className="btn sm" onClick={() => setTokDlg(true)}><Icon name="key" size={14} />{token ? 'Operator' : 'Sign in'}</button>
        </header>
        <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
          <Suspense fallback={<div className="page"><SkeletonRows n={5} /></div>}>
            {status.error && !s ? <div className="page"><ErrorPanel error={status.error} onRetry={status.reload} what="system status" /></div> : <View params={route.params} status={status} token={token} />}
          </Suspense>
        </main>
      </div>
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {tokDlg && <TokenDialog onClose={() => setTokDlg(false)} />}
    </div>
  );
}

function TokenDialog({ onClose }) {
  const token = useToken(); const [v, setV] = useState('');
  return (
    <Dialog title="Operator access" onClose={onClose}>
      <p className="dim">Reads are public. Starting runs, approving decisions and the kill switch need the operator token (<span className="mono-v">data/operator.token</span> locally, or the <span className="mono-v">OPERATOR_TOKEN</span> secret). It is kept in this tab's session storage only, never in a URL.</p>
      <form onSubmit={(e) => { e.preventDefault(); setToken(v.trim()); onClose(); }} className="stack">
        <div className="field"><label htmlFor="tok">Operator token</label><input id="tok" className="input mono-i" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={token ? '•••• set for this tab' : 'paste token'} /></div>
        <div className="row"><button className="btn primary" type="submit" disabled={!v.trim()}>Use token</button>{token && <button type="button" className="btn" onClick={() => { setToken(''); onClose(); }}>Sign out</button>}</div>
      </form>
    </Dialog>
  );
}

export default function App() { return <ToastProvider><Shell /></ToastProvider>; }
