// Live ledger: the hash-chained feed of everything the agent did AND everything it was refused. Refusals and anomalies are the proof the leash works.
import { useMemo, useState } from 'react';
import { Chip, Empty, Icon, Led } from '../../ui.jsx';
import { Amt } from './parts.jsx';
import { ago, chainMeta, toMs, unitOf, when } from './format.js';

const KIND = {
  draw: { icon: 'draw', label: 'Draw' }, deploy: { icon: 'deploy', label: 'Deploy' }, refused: { icon: 'ban', label: 'Refused' },
  anomaly: { icon: 'alert', label: 'Anomaly' }, activate: { icon: 'check', label: 'Activated' }, loop: { icon: 'loop', label: 'Loop' },
};
const FILTERS = [['all', 'All'], ['draw', 'Draws'], ['deploy', 'Deploys'], ['refused', 'Refusals'], ['anomaly', 'Anomalies'], ['other', 'Activation & loop']];
const inFilter = (k, f) => f === 'all' || k === f || (f === 'other' && (k === 'activate' || k === 'loop'));
const sub = (k) => ({ refused: 'the leash held: this was not executed', anomaly: 'integrity mismatch: the loop stopped itself', draw: 'gas drawn to the agent address only', deploy: 'allowlisted template deployed by the vault', activate: 'mandate verified on-chain, loop enabled for this vault', loop: 'operator action' }[k] ?? '');

export function summarize(items) {
  const c = { draw: 0, deploy: 0, refused: 0, anomaly: 0 }; for (const i of items) if (i.kind in c) c[i.kind] += 1; return c;
}

export default function Ledger({ items, chainOk, vaults, now, fixture }) {
  const [f, setF] = useState('all'); const [limit, setLimit] = useState(20);
  const sorted = useMemo(() => [...items].sort((a, b) => b.id - a.id), [items]);
  const broken = useMemo(() => { const s = new Set(); sorted.forEach((it, i) => { const nx = sorted[i + 1]; if (nx && it.prevHash !== nx.hash) s.add(it.id); }); return s; }, [sorted]);
  const counts = summarize(sorted);
  const shown = sorted.filter((i) => inFilter(i.kind, f));
  const vmap = Object.fromEntries((vaults ?? []).map((v) => [v.id, v]));
  const links = Math.max(0, sorted.length - 1);
  return (
    <section className="panel vt-ledger" aria-labelledby="lg-h">
      <div className="ph vt-lg-h">
        <h2 id="lg-h" className="eyebrow" style={{ margin: 0 }}>Live ledger · hash-chained</h2>
        <div className="row">
          {chainOk === undefined || chainOk === null ? null : <Chip tone={chainOk ? 'ok' : 'bad'} title="The server verified that every ledger row commits to the hash of the previous one"><Icon name={chainOk ? 'check' : 'alert'} size={13} />{chainOk ? 'chain intact' : 'chain BROKEN'}</Chip>}
          <Chip tone={broken.size ? 'bad' : 'mineral'} title="Checked in this browser: each row's prevHash equals the hash of the row before it, within the rows loaded">{broken.size ? `${broken.size} broken link${broken.size === 1 ? '' : 's'} here` : `${links} link${links === 1 ? '' : 's'} re-checked here`}</Chip>
        </div>
      </div>
      <div className="vt-lg-sum" role="group" aria-label="Ledger summary">
        {[['draw', 'draws'], ['deploy', 'deploys'], ['refused', 'refusals'], ['anomaly', 'anomalies']].map(([k, w]) => (
          <div key={k} className={`vt-lg-c ${k} ${counts[k] ? 'has' : ''}`}><b className="num">{counts[k]}</b><span className="eyebrow">{w}</span></div>
        ))}
        <p className="help vt-lg-note"><b>Refusals and anomalies are the proof.</b> Each one is a moment the agent (or the loop on its behalf) tried something the mandate, the chain preview or an integrity check did not allow, and nothing happened.</p>
      </div>
      <div className="vt-filters" role="group" aria-label="Filter the ledger">
        {FILTERS.map(([k, l]) => <button key={k} type="button" className="vt-fb" aria-pressed={f === k} onClick={() => { setF(k); setLimit(20); }}>{l}{k !== 'all' && k !== 'other' ? ` ${counts[k]}` : ''}</button>)}
      </div>
      {!shown.length ? <Empty title="Nothing in this filter yet">Entries appear here as the loop works. Nothing is ever shown that is not in the ledger.</Empty> : (
        <ol className="lg-list" aria-label="Ledger entries, newest first">
          {shown.slice(0, limit).map((it) => {
            const k = KIND[it.kind] ?? { icon: 'info', label: it.kind }; const v = vmap[it.vaultId]; const unit = v ? unitOf(v) : null;
            const tone = it.status === 'failed' || it.kind === 'anomaly' ? 'bad' : it.status === 'refused' || it.kind === 'refused' ? 'mineral' : it.status === 'confirmed' ? 'ok' : '';
            return (
              <li key={it.id} className={`lg-i ${it.kind} ${tone}${broken.has(it.id) ? ' broken' : ''}`}>
                <span className="lg-rail" aria-hidden="true"><i className="lg-dot"><Icon name={k.icon} size={15} /></i></span>
                <div className="lg-time"><time dateTime={new Date(toMs(it.time)).toISOString()} className="mono-v">{when(it.time).slice(5, 19).replace(' ', ' · ')}</time><span className="mono-v faint">{ago(it.time, now)}</span></div>
                <div className="lg-main">
                  <div className="lg-title"><b>{k.label}</b>
                    <Chip tone={tone}><Led tone={['ok', 'bad', 'warn'].includes(tone) ? tone : 'off'} />{it.status}</Chip>
                    {v && <span className="chip" title={v.address}>{chainMeta(v.chainId)?.short ?? v.network}</span>}
                  </div>
                  <p className="lg-detail">{it.detail || <span className="faint">no detail recorded</span>}</p>
                  <p className="lg-sub help">{sub(it.kind)}</p>
                  <div className="lg-hash mono-v faint" title={`hash ${it.hash}\nprev ${it.prevHash ?? ''}`}>#{it.id} · {String(it.hash).slice(0, 10)}… ← {it.prevHash ? `${String(it.prevHash).slice(0, 10)}…` : 'genesis'}{broken.has(it.id) && <b className="lg-bk"> · LINK BROKEN: prevHash does not match the previous row</b>}</div>
                </div>
                <div className="lg-amt">{it.amount != null && it.amount !== '' && unit ? <Amt v={it.amount} unit={unit} strong /> : null}</div>
                <div className="lg-links">
                  {it.decisionId && (fixture ? <span className="mono-v faint" title="fixture decision">{it.decisionId}</span> : <a className="mono-v" href={`#/approval/${it.decisionId}`}>{it.decisionId.length > 18 ? `${it.decisionId.slice(0, 16)}…` : it.decisionId}</a>)}
                  {it.txHash && (it.explorerUrl && !fixture
                    ? <a className="mono-v" href={it.explorerUrl} target="_blank" rel="noreferrer noopener" aria-label={`Open transaction ${String(it.txHash).slice(0, 10)} in the explorer (opens in a new tab)`}>tx {String(it.txHash).slice(0, 10)}…<Icon name="external" size={12} /></a>
                    : <span className="mono-v faint" title={fixture ? 'Fixture transaction: it does not exist on any chain' : it.txHash}>tx {String(it.txHash).slice(0, 10)}…{fixture ? ' (fixture)' : ''}</span>)}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {shown.length > limit && <div className="vt-more"><button className="btn" onClick={() => setLimit((n) => n + 20)}>Show {Math.min(20, shown.length - limit)} more</button></div>}
    </section>
  );
}
