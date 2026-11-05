// Autonomy timeline: ONE deploy decision followed approved -> draw -> deploy -> verified, from ledger rows + the decision record. Nothing is inferred beyond those two sources.
import { ApproverBadge, Chip, Empty, Icon } from '../../ui.jsx';
import { ago, when } from './format.js';

const NODE_ICON = { done: 'check', failed: 'x', refused: 'ban', current: 'clock', pending: null, skipped: 'arrow' };

export function buildPaths(items, decisions) {
  const by = new Map();
  for (const it of [...items].sort((a, b) => a.id - b.id)) {
    if (!it.decisionId || !['draw', 'deploy', 'refused', 'anomaly'].includes(it.kind)) continue;
    if (!by.has(it.decisionId)) by.set(it.decisionId, []);
    by.get(it.decisionId).push(it);
  }
  const paths = [...by.entries()].map(([id, es]) => {
    const dec = decisions.find((d) => d.id === id) ?? null;
    if (dec && dec.action && dec.action !== 'deploy_testnet') return null;
    const draw = es.find((e) => e.kind === 'draw'); const dep = es.find((e) => e.kind === 'deploy'); const stops = es.filter((e) => e.kind === 'refused' || e.kind === 'anomaly');
    const mandate = /^mandate:/.test(dec?.approver ?? '');
    const nodes = [
      { key: 'approved', title: dec?.approver ? (mandate ? 'Approved under mandate' : 'Approved by a human') : dec ? 'Awaiting approval' : 'Approval not in the decision list',
        state: dec?.approver ? 'done' : 'pending', detail: dec?.approver ? `${dec.approver}${dec.decided_at ? ` · ${when(dec.decided_at)}` : ''}` : dec ? `status ${dec.effectiveStatus}` : 'the decision record could not be loaded', approver: dec?.approver, mandate },
      { key: 'draw', title: 'Draw gas', state: draw ? (draw.status === 'confirmed' ? 'done' : draw.status === 'failed' ? 'failed' : 'current') : dep ? 'skipped' : 'pending', detail: draw ? `${when(draw.time)}` : dep ? 'not needed: the agent balance already covered the fee' : 'only if the agent balance is too low', entry: draw },
      { key: 'deploy', title: 'Deploy template', state: dep ? (dep.status === 'confirmed' ? 'done' : dep.status === 'failed' ? 'failed' : 'current') : 'pending', detail: dep ? `${when(dep.time)}` : 'from the vault, allowlisted code only', entry: dep },
      { key: 'verified', title: 'Verified on-chain', state: dec?.effectiveStatus === 'executed' ? 'done' : dep?.status === 'confirmed' ? 'current' : 'pending', detail: dec?.effectiveStatus === 'executed' ? 'receipt checked against the attested build, then recorded' : dep?.status === 'confirmed' ? 'waiting for the server to verify the deployment' : 'receipt proof, then recorded' },
    ];
    if (stops.length) { const i = nodes.findIndex((n) => n.state === 'pending' || n.state === 'current'); if (i >= 0) nodes[i] = { ...nodes[i], title: 'Refused: not executed', state: 'refused', detail: stops.at(-1).detail || 'refused', entry: stops.at(-1) }; }
    const last = es.at(-1);
    const result = nodes.at(-1).state === 'done' ? 'verified' : nodes.some((n) => n.state === 'refused') ? 'refused' : nodes.some((n) => n.state === 'failed') ? 'failed' : 'in progress';
    return { id, dec, nodes, result, last, mandate };
  }).filter(Boolean);
  // paths that reached a deploy first (the full story), then refusals; newest first inside each group
  const reached = (x) => (x.nodes.find((n) => n.key === 'deploy')?.state !== 'pending' ? 1 : 0);
  return paths.sort((a, b) => reached(b) - reached(a) || b.last.id - a.last.id);
}

function Path({ p, now, fixture }) {
  const tone = p.result === 'verified' ? 'ok' : p.result === 'in progress' ? 'warn' : 'bad';
  return (
    <li className="tl-path">
      <div className="tl-path-h">
        <span className="row">{fixture ? <span className="mono-v tl-id" title="fixture decision: it does not exist on any API">{p.id}</span> : <a className="mono-v tl-id" href={`#/approval/${p.id}`}>{p.id}</a>}<ApproverBadge approver={p.dec?.approver} /></span>
        <Chip tone={tone}>{p.result}</Chip>
      </div>
      <ol className="tl-track" aria-label={`Steps for decision ${p.id}`}>
        {p.nodes.map((n, i) => (
          <li key={n.key} className={`tl-n ${n.state} ${n.key === 'approved' && n.mandate ? 'm' : n.key === 'approved' && n.approver ? 'h' : ''}`} aria-current={n.state === 'current' ? 'step' : undefined}>
            <span className="tl-dot" aria-hidden="true">{n.key === 'approved' && n.approver ? <Icon name={n.mandate ? 'bot' : 'user'} size={17} /> : NODE_ICON[n.state] ? <Icon name={NODE_ICON[n.state]} size={16} /> : <i />}</span>
            <div className="tl-body">
              <b>{n.title}</b>
              <span className={`tl-st ${n.state}`}>{n.state === 'current' ? 'in progress' : n.state}</span>
              <span className="mono-v faint tl-d">{n.detail}</span>
              {n.entry?.txHash && <span className="mono-v faint tl-d">tx {String(n.entry.txHash).slice(0, 12)}…{fixture ? ' (fixture)' : ''}</span>}
            </div>
            {i < p.nodes.length - 1 && <span className="tl-link" aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </li>
  );
}

export default function Timeline({ items, decisions, now, fixture, error }) {
  const paths = buildPaths(items, decisions ?? []).slice(0, 3);
  return (
    <section className="panel vt-timeline" aria-labelledby="tl-h">
      <div className="ph"><h2 id="tl-h" className="eyebrow" style={{ margin: 0 }}>Autonomy timeline · one decision, end to end</h2></div>
      <div className="pb stack">
        <div className="tl-legend" role="group" aria-label="Two kinds of approval">
          <span className="chip human"><Icon name="user" size={13} />approved by human</span><span className="help">a person typed the phrase and bound their own signer.</span>
          <span className="chip mandate"><Icon name="bot" size={13} />approved under mandate:vault:epoch</span><span className="help">the loop approved inside a mandate a human granted earlier; the human decision <i>is</i> the mandate.</span>
        </div>
        {error && <p className="help">Decision records could not be loaded ({error.message}); approvals below may show as unknown.</p>}
        {!paths.length
          ? <Empty title="No autonomous deploy yet">When the loop picks a pending deploy decision whose artifact matches an allowlisted template, its path from approval to verification is drawn here from the ledger.</Empty>
          : <ul className="tl-paths">{paths.map((p) => <Path key={p.id} p={p} now={now} fixture={fixture} />)}</ul>}
      </div>
    </section>
  );
}
