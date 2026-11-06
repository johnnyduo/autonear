// Activity drawer: everything that happened, in plain words, with the technical truth one click away. Source health and the technical screens live here, not in the menu.
import { fmt } from '../api.js';
import { Dialog } from '../ui.jsx';
import { fmtAmount, unitOf } from '../views/vault/format.js';
import { historyLine, T } from './copy.js';
import { mainVault } from './data.js';
import { goto, href } from './nav.js';
import run from './testnetRun.json';

const word = (s) => (s.status === 'ok' ? (s.stale ? 'slow' : 'working') : s.status === 'disabled_by_owner' ? 'off' : s.status === 'not_configured' ? 'needs a key' : 'paused, retrying');

export default function Activity({ data, opts, base }) {
  const sources = data.status.data?.sources ?? [];
  const v = mainVault(data.vault); const u = v ? unitOf(v) : null;
  const money = u ? (x) => `${fmtAmount(x, u.decimals, 4)?.text ?? '–'} ${u.symbol}` : undefined;
  // newest first; identical consecutive lines collapse into one with a count
  const items = [];
  for (const e of [...data.ledger].sort((a, b) => toMs(b.time) - toMs(a.time)).slice(0, 60)) {
    const line = historyLine(e, money); const last = items.at(-1);
    if (last && last.line === line) { last.n += 1; last.more.push(e); } else items.push({ e, line, n: 1, more: [] });
  }
  const close = () => goto(base, opts);
  return (
    <Dialog title={T.activity} onClose={close} drawer>
      <section className="act">
        <h3>What happened</h3>
        {items.length ? <ol className="tl">{items.slice(0, 30).map(({ e, line, n }) => (
          <li key={e.id}>
            <div><b>{line}{n > 1 ? ` ×${n}` : ''}</b><time>{fmt.ago(toMs(e.time))}</time></div>
            <details className="tech"><summary>Technical details</summary>
              <dl><dt>Kind</dt><dd>{e.kind} · {e.status}</dd><dt>Note</dt><dd>{e.detail}</dd>{e.txHash && <><dt>Transaction</dt><dd className="mono-v">{e.explorerUrl ? <a href={e.explorerUrl} target="_blank" rel="noreferrer noopener">{e.txHash}</a> : e.txHash}</dd></>}{e.hash && <><dt>Record</dt><dd className="mono-v">{e.hash}</dd></>}</dl>
            </details>
          </li>))}</ol> : <p className="faint">Nothing has happened yet.</p>}
        <h3>Recorded run on NEAR testnet</h3>
        <p className="faint">{run.scope} Run on {new Date(run.startedAt).toISOString().slice(0, 10)}. Steps marked "refused" were meant to be refused by the contract; the chain did refuse them.</p>
        <ol className="tl">{run.txs.map((t) => {
          const refused = !t.ok && /^NEGATIVE/.test(t.label);
          return (
            <li key={t.hash}>
              <div><b>{t.label.replace(/^NEGATIVE\s*/, '')}</b><span className={`chip ${refused || t.ok ? 'ok' : ''}`}>{refused ? 'refused, as intended' : t.ok ? 'done' : 'failed'}</span></div>
              <small className="mono-v"><a href={t.explorer} target="_blank" rel="noreferrer noopener">{t.hash.slice(0, 10)}…{t.hash.slice(-6)}</a> · signed by {t.signer.split('.')[0].slice(0, 22)}</small>
            </li>
          );
        })}</ol>
        <h3>Where it reads</h3>
        <ul className="srcs compact">{sources.map((s) => <li key={s.id}><b>{s.name}</b><span>{word(s)}</span><small>{s.lastSuccess ? fmt.ago(s.lastSuccess) : 'never'}</small></li>)}</ul>
        <h3>Technical screens</h3>
        <p className="faint">For people who want the full detail.</p>
        <div className="row">{[['constellation', 'Evidence constellation'], ['dashboard', 'Technical overview'], ['radar', 'Evidence'], ['run', 'Checks'], ['studio', 'Studio'], ['security', 'Security'], ['engines', 'Engines'], ['approval', 'Approval (classic)']].map(([k, l]) => <a key={k} className="btn sm" href={href(k, opts)}>{l}</a>)}</div>
      </section>
    </Dialog>
  );
}
const toMs = (t) => { const n = Number(t); return n && n < 1e11 ? n * 1000 : n; };
