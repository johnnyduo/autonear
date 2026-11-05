import { api, fmt, useApi } from '../api.js';
import { Chip, Empty, ErrorPanel, Icon, Led, NeedsOperator, Panel, SkeletonRows, StaleNote, Status, useToast } from '../ui.jsx';

export default function Security({ token, status }) {
  const sec = useApi('/api/security', { poll: 20000 });
  const toast = useToast();
  const d = sec.data;
  const paused = d?.paused ?? status.data?.paused;
  const toggle = async () => {
    try { await api(paused ? '/api/security/resume' : '/api/security/pause', { method: 'POST' }); toast(paused ? 'Pipeline resumed' : 'Kill switch engaged'); sec.reload(); status.reload(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <div className="page">
      <header className="stack-s">
        <span className="eyebrow">Security center</span>
        <h1 className="display">Policy lives <em>outside</em> the model.</h1>
        <p className="dim" style={{ maxWidth: 720 }}>Tool allowlists, host allowlists, budgets, schema checks and decision limits are enforced in code. A prompt cannot widen them. Everything below is read from the running system, not described from memory.</p>
      </header>
      {sec.error && !d ? <ErrorPanel error={sec.error} onRetry={sec.reload} what="security state" /> : !d ? <SkeletonRows n={6} /> : (
        <div className="grid">
          <div className="span-4 stack">
            <Panel title="Emergency control" tone={paused ? 'risk' : undefined} aside={sec.stale && <StaleNote at={sec.at} />}>
              <div className="row" style={{ marginBottom: 12 }}><Led tone={paused ? 'bad' : 'ok'} live={!paused} /><b>{paused ? 'Kill switch ENGAGED' : 'Pipeline live'}</b></div>
              <p className="dim">While engaged: new runs, in-flight stages, approvals and deployment records are refused. Ingestion of public evidence continues. Releasing is a deliberate operator action.</p>
              <NeedsOperator token={token}><button className={`btn ${paused ? 'primary' : 'danger'}`} onClick={toggle}><Icon name={paused ? 'play' : 'pause'} size={16} />{paused ? 'Release kill switch' : 'Engage kill switch'}</button></NeedsOperator>
            </Panel>
            <Panel title="Audit chain">
              <div className="row"><Led tone={d.auditChain.ok ? 'ok' : 'bad'} /><b>{d.auditChain.ok ? 'Hash chain intact' : `BROKEN at #${d.auditChain.brokenAt}`}</b></div>
              <p className="help" style={{ marginTop: 8 }}>Every audit row commits to its predecessor; a rewritten or deleted row breaks verification. Append-only by construction, not by trust.</p>
            </Panel>
            <Panel title="Key scopes">
              <ul className="list">{d.keyScopes.map((k) => <li key={k.key} className="li"><span className="row sp"><b className="mono-v">{k.key}</b><Chip tone={k.scope.startsWith('NONE') ? 'ok' : ''}>{k.holder}</Chip></span><span className="dim">{k.scope}</span></li>)}</ul>
            </Panel>
          </div>
          <div className="span-8 stack">
            <Panel title="Role permissions (enforced by assertTool)" pad={false}>
              <div className="scroll-x"><table className="tbl"><thead><tr><th>Role</th><th>Tools</th><th>LLM</th></tr></thead>
                <tbody>{Object.entries(d.rolePolicy).map(([r, p]) => <tr key={r}><td className="mono-v">{r}</td><td>{p.tools.map((t) => <Chip key={t}>{t}</Chip>)}</td><td>{p.llm ? <Chip tone="mineral">may call</Chip> : <Chip>never</Chip>}</td></tr>)}</tbody></table></div>
            </Panel>
            <div className="grid">
              <div className="span-6"><Panel title="Outbound host allowlist">
                {Object.entries(d.hostAllowlist).map(([role, hosts]) => <div key={role} className="stack-s" style={{ marginBottom: 12 }}><span className="mono">{role}</span><div className="row">{hosts.map((h) => <Chip key={h}>{h}</Chip>)}</div></div>)}
                <p className="help">HTTPS only. Any other host is refused before a socket opens.</p>
              </Panel></div>
              <div className="span-6"><Panel title="Decision limits & budgets">
                <dl className="kv">
                  <dt>Actions enabled</dt><dd>{d.decisionLimits.allowedActions.map((a) => <Chip key={a} tone="ok">{a}</Chip>)}</dd>
                  <dt>Disabled</dt><dd className="dim">upgrade · treasury spend · liquidity · outreach · anything on mainnet</dd>
                  <dt>Networks</dt><dd className="row">{d.decisionLimits.allowedNetworks.map((n) => <Chip key={n}>{n}</Chip>)}</dd>
                  <dt>Max expiry</dt><dd>{Math.round(d.decisionLimits.maxExpiryMs / 864e5)} days</dd>
                  <dt>Spend ceiling</dt><dd className="mono-v">{d.decisionLimits.maxSpendCeiling} (registry never moves funds)</dd>
                  <dt>Per-run budget</dt><dd className="mono-v">${d.budget.usd} · {d.budget.tokens} tokens</dd>
                </dl>
              </Panel></div>
            </div>
            <Panel title="Incident history (audit trail)" pad={false}>
              {!d.audit.length ? <Empty title="No audit events yet">Events appear as the system acts.</Empty> : (
                <ul className="list">{d.audit.map((a) => (
                  <li key={a.id} className="li"><span className="row sp"><span className="row"><Status state={/error|rejected|engage|dead/.test(a.action) ? 'error' : /approved|recorded|attested|ok/.test(a.action) ? 'ok' : 'unknown'} /><b className="mono-v">{a.action}</b></span><span className="mono faint">{fmt.date(a.time)}</span></span>
                    <span className="mono-v faint clip">{a.actor} · {JSON.stringify(a.detail).slice(0, 140)}</span></li>))}</ul>
              )}
            </Panel>
            <p className="help">Runbook: <span className="mono-v">{d.runbook}</span>. "Automated checks passed" is never worded as "audited"; independent audit status is <b>none</b> until a named reviewer and report exist.</p>
          </div>
        </div>
      )}
    </div>
  );
}
