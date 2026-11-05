import { Fragment } from 'react';
import { useApi } from '../api.js';
import { Chip, ErrorPanel, Panel, SkeletonRows, Status } from '../ui.jsx';

const FIELDS = ['enabled', 'version', 'last_run', 'cost', 'latency', 'result', 'error', 'evidence_id'];

export default function Engines() {
  const eng = useApi('/api/engines');
  const proto = useApi('/api/protocols');
  return (
    <div className="page">
      <header className="stack-s">
        <span className="eyebrow">Engine registry</span>
        <h1 className="display">Named engines, <em>honestly</em> reported.</h1>
        <p className="dim" style={{ maxWidth: 720 }}>Pythia, MiroFish and Kronos are optional adapters, not agents and not the orchestrator. The roles that actually run are our own. Each adapter reports the same eight fields, and why it was or was not invoked.</p>
      </header>
      {eng.error && !eng.data ? <ErrorPanel error={eng.error} onRetry={eng.reload} what="engines" /> : !eng.data ? <SkeletonRows n={3} /> : (
        <div className="stack">
          <Panel title="LLM provider" aside={<Status state={eng.data.llm.enabled ? 'ok' : 'not_installed'} />}>
            <dl className="kv"><dt>Provider</dt><dd className="mono-v">{eng.data.llm.provider}</dd><dt>Model</dt><dd className="mono-v">{eng.data.llm.model ?? '–'}</dd><dt>Status</dt><dd>{eng.data.llm.reason}</dd></dl>
            {!eng.data.llm.enabled && <p className="help" style={{ marginTop: 12 }}>No LLM credential is configured, so Analyst and Skeptic run their deterministic baselines. Add a key (see .env.example) and the same roles will call the model; invalid or uncited model output is rejected and the baseline is used.</p>}
          </Panel>
          <div className="grid">
            {eng.data.engines.map((e) => (
              <div key={e.id} className="span-4"><Panel title={e.name} aside={<Status state={e.status} />}>
                <p className="dim">{e.role}</p>
                <p><b>Why {e.enabled ? 'enabled' : 'not invoked'}.</b> <span className="dim">{e.why}</span></p>
                <dl className="kv">
                  {FIELDS.map((f) => <Fragment key={f}><dt>{f}</dt><dd className="mono-v">{String(e[f] ?? '–')}</dd></Fragment>)}
                  <dt>license</dt><dd>{e.license}</dd>
                </dl>
                <p style={{ marginTop: 12 }}><a href={e.upstream} target="_blank" rel="noreferrer noopener">Upstream repository</a></p>
              </Panel></div>
            ))}
          </div>
          <Panel title="Contract protocols" aside={proto.data && <span className="mono faint">{Object.values(proto.data.protocols).filter((p) => p.status === 'implemented').length} implemented</span>} pad={false}>
            {proto.data ? (
              <div className="scroll-x"><table className="tbl"><thead><tr><th>Protocol</th><th>Status</th><th>Toolchain</th><th>Networks</th></tr></thead>
                <tbody>{Object.entries(proto.data.protocols).map(([k, p]) => (
                  <tr key={k}><td><b>{p.label}</b></td><td><Status state={p.status} /></td><td className="mono-v">{p.toolchain}</td>
                    <td>{p.networks.length ? p.networks.map((n) => <Chip key={n.id} tone={n.mainnet ? 'bad' : n.local ? 'mineral' : ''} title={n.mainnet ? 'mainnet: blocked by policy' : ''}>{n.label}{n.mainnet ? ' (blocked)' : ''}</Chip>) : <span className="faint">none: planned only, no code in this repo</span>}</td></tr>))}</tbody></table></div>
            ) : <SkeletonRows n={2} />}
          </Panel>
        </div>
      )}
    </div>
  );
}
