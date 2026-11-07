// Mandate Vault: a flight deck for a leashed autonomous agent. Route: #/vault, #/vault/grant/<decisionId>.
// Lazy-loaded route chunk (App.jsx). Fixture mode is reachable ONLY via the explicit `fixture=1` query inside the hash and is a separate lazy chunk.
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../api.js';
import { Chip, Empty, ErrorPanel, Icon, Panel, Skeleton, SkeletonRows, useToast } from '../../ui.jsx';
import { PageHead, useNow } from '../_run-parts.jsx';
import './vault.css';
import { LoopDeck, NeverPanel, VaultTabs } from './Deck.jsx';
import Grant from './Grant.jsx';
import Ledger from './Ledger.jsx';
import MandateCard from './MandateCard.jsx';
import { ProposeDialog, Teach } from './Propose.jsx';
import Timeline from './Timeline.jsx';
import { ago, chainMeta, fixtureScenario, isFixtureMode, vaultHeadline } from './format.js';

/** Live API, or the lazy fixture. In fixture mode NO vault request is made and every mutation is blocked at the api() layer too. */
function useSource(fixture) {
  const live = !fixture;
  const vault = useApi('/api/vault', { poll: 5000, enabled: live });
  const ledger = useApi('/api/vault/ledger?limit=100', { poll: 5000, enabled: live });
  const decisions = useApi('/api/decisions', { poll: 15000, enabled: live });
  const artifacts = useApi('/api/artifacts', { enabled: live });
  const [fx, setFx] = useState(null); const [fxErr, setFxErr] = useState(null);
  useEffect(() => {
    if (!fixture) return undefined; let on = true;
    import('../../mock/vaultFixture.js').then((m) => on && setFx(m.buildFixture(fixtureScenario(), Date.now()))).catch((e) => on && setFxErr(e));
    return () => { on = false; };
  }, [fixture]);
  return useMemo(() => {
    if (!fixture) return { fixture: false, vault, ledger, decisions, artifacts: artifacts.data?.items?.filter((a) => /^contract-build:/.test(a.kind)) ?? [], grant: null };
    const mk = (data, error) => ({ data, error: error ?? null, loading: !data && !error, stale: false, at: fx?.at ?? 0, reload() {} });
    if (fx?.mode === 'error') return { fixture: true, vault: { ...mk(null, Object.assign(new Error('Fixture: simulated API failure (HTTP 503)'), { status: 503 })) }, ledger: mk(null), decisions: mk(null), artifacts: [], grant: null };
    if (fx?.mode === 'loading') return { fixture: true, vault: mk(null), ledger: mk(null), decisions: mk(null), artifacts: [], grant: null };
    return { fixture: true, vault: mk(fx?.vault, fxErr), ledger: mk(fx?.ledger), decisions: mk(fx ? { items: fx.decisions } : null), artifacts: fx?.artifacts ?? [], grant: fx?.grant ?? null };
  }, [fixture, vault, ledger, decisions, artifacts.data, fx, fxErr]);
}

export function FixtureChrome() {
  useEffect(() => { const t = document.title; document.title = `[FIXTURE] ${t}`; return () => { document.title = t; }; }, []);
  return (
    <>
      <div className="fx-banner" role="note"><Icon name="alert" size={20} /><b>FIXTURE DATA - NOT A REAL VAULT</b><span>Invented values for design review. No API call is made, nothing can be sent or granted.</span></div>
      <div className="fx-mark" aria-hidden="true" />
    </>
  );
}

export default function Vault({ params, status, token }) {
  const fixture = isFixtureMode();
  const source = useSource(fixture);
  const mode = params[0] === 'grant' && params[1] ? 'grant' : 'deck';
  const canOperate = Boolean(token) && !fixture;
  return (
    <div className={`page vt${fixture ? ' is-fixture' : ''}`}>
      {fixture && <FixtureChrome />}
      {mode === 'grant'
        ? <Grant id={params[1]} status={status} token={token} source={source} fixture={fixture} />
        : <Deck source={source} status={status} canOperate={canOperate} fixture={fixture} />}
    </div>
  );
}

function Deck({ source, status, canOperate, fixture }) {
  const toast = useToast(); const now = useNow(1000);
  const { vault: vq, ledger: lq, decisions: dq } = source;
  const data = vq.data; const vaults = data?.vaults ?? [];
  const [sel, setSel] = useState(null); const [propose, setPropose] = useState(false); const [busy, setBusy] = useState(false);
  const current = vaults.find((v) => v.id === sel) ?? vaults[0];
  const killed = Boolean(status.data?.paused); const canPropose = canOperate || fixture; // fixture: the form opens for review, submit stays disabled

  const act = async (which) => {
    setBusy(true);
    try { await api(`/api/vault/loop/${which}`, { method: 'POST' }); toast(which === 'pause' ? 'Loop paused' : 'Loop resume requested'); vq.reload(); }
    catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const toggleKill = async () => {
    setBusy(true);
    try { await api(killed ? '/api/security/resume' : '/api/security/pause', { method: 'POST' }); toast(killed ? 'Pipeline resumed' : 'Kill switch engaged: runs and approvals are blocked'); status.reload(); vq.reload(); }
    catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const ctl = { canOperate, fixture, busy, act, kill: { paused: killed, toggle: toggleKill } };
  const tabs = vaults.map((v) => { const h = vaultHeadline(v, now); return { id: v.id, chain: chainMeta(v.chainId)?.short ?? v.network ?? v.chainId, short: v.address.length > 18 ? `${v.address.slice(0, 8)}…${v.address.slice(-4)}` : v.address, tone: h.tone, label: h.label }; });
  const agent = data?.agent;

  return (
    <>
      <PageHead eyebrow="Mandate vault · testnet" title="An agent with its own gas." em="On a leash."
        aside={<div className="vt-head-a"><span className="vt-live mono-v" role="status">{fixture ? <><span className="led warn" aria-hidden="true" />fixture · not polling</> : vq.error && !data ? <><span className="led bad" aria-hidden="true" />offline</> : vq.stale ? <><span className="led warn" aria-hidden="true" />stale · {ago(vq.at, now)}</> : data ? <><span className="led ok live" aria-hidden="true" />live · updated {ago(vq.at, now)}</> : <><span className="led" aria-hidden="true" />loading…</>}</span>
          {data?.enabled && data.signingSupported !== false && vaults.length > 0 && canPropose && <button className="btn" onClick={() => setPropose(true)}><Icon name="vault" size={16} />Propose a mandate</button>}</div>}>
        The agent holds its own testnet key and may do exactly two things: draw gas inside a budget, and deploy contract templates you pre-approved. Everything runs under a mandate you grant, and you can revoke it at any time.
      </PageHead>

      {vq.loading && !data && <div className="stack" role="status" aria-label="Loading vault"><Skeleton h={168} /><Skeleton h={88} /><Skeleton h={420} /></div>}
      {vq.error && !data && <ErrorPanel error={vq.error} onRetry={vq.reload} what="the vault" />}

      {data && !data.enabled && (
        <Empty title="The vault is not enabled on this API" action={<a className="btn" href="#/security">Open security</a>}>This API reports <span className="mono-v">enabled: false</span>. Nothing below is guessed: when the backend enables the Mandate Vault, its state appears here.</Empty>
      )}

      {data?.enabled && (
        <div className="stack">
          {data.signingSupported === false && (
            <div className="banner warn" role="note"><Icon name="info" /><div><b>This API cannot run the autonomy loop.</b> It runs on a runtime without agent signing support (such as a Cloudflare Worker), so no key is held here and nothing is signed. The loop runs on a Node host (<span className="mono-v">npm run agent:loop</span> or the scheduler tick). You are looking at <b>read-only</b> data.</div></div>
          )}
          <LoopDeck data={data} now={now} ctl={ctl} stale={vq.stale} at={vq.at} mode={fixture ? 'fixture' : 'live'} />

          {!vaults.length ? (
            <Teach onPropose={() => setPropose(true)} canOperate={canPropose} fixture={fixture} signingSupported={data.signingSupported} />
          ) : (
            <>
              {vaults.length > 1 && <VaultTabs items={tabs} value={current.id} onChange={setSel} panelId="vt-panel" />}
              <div className="grid vt-main" id="vt-panel" role={vaults.length > 1 ? 'tabpanel' : undefined} aria-labelledby={vaults.length > 1 ? `vtab-${current.id}` : undefined}>
                <div className="span-8 stack" style={{ alignContent: 'start' }}>
                  <MandateCard key={current.id} v={current} now={now} decisions={dq.data?.items} fixture={fixture} />
                  {canPropose && !current.mandate && <div><button className="btn primary" onClick={() => setPropose(true)}>Propose a mandate for a vault</button></div>}
                </div>
                <div className="span-4 stack" style={{ alignContent: 'start' }}>
                  <NeverPanel />
                  {(agent?.evm || agent?.near) && (
                    <Panel title="Agent identity">
                      <dl className="kv">
                        {agent.evm && <><dt>EVM</dt><dd className="mono-v">{agent.evm.address}</dd></>}
                        {agent.near && <><dt>NEAR</dt><dd className="mono-v">{agent.near.account}</dd><dt>Public key</dt><dd className="mono-v">{agent.near.publicKey}</dd></>}
                      </dl>
                      <p className="help" style={{ marginBottom: 0 }}>Only the public identity is shown. The key never leaves the Node host.</p>
                    </Panel>
                  )}
                </div>
              </div>
            </>
          )}

          {(vaults.length > 0 || (lq.data?.items?.length ?? 0) > 0) && <Timeline items={lq.data?.items ?? []} decisions={dq.data?.items ?? []} now={now} fixture={fixture} error={dq.error} />}

          {lq.loading && !lq.data && <SkeletonRows n={4} />}
          {lq.error && !lq.data && <ErrorPanel error={lq.error} onRetry={lq.reload} what="the ledger" />}
          {lq.data && (vaults.length > 0 || lq.data.items?.length > 0) && <Ledger items={lq.data.items ?? []} chainOk={lq.data.chainOk} vaults={vaults} now={now} fixture={fixture} />}
          {lq.stale && <Chip tone="warn">ledger refresh failed: showing older rows</Chip>}
        </div>
      )}
      {propose && <ProposeDialog onClose={() => setPropose(false)} agent={agent} artifacts={source.artifacts} fixture={fixture} canOperate={canOperate} />}
    </>
  );
}
