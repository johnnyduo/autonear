// Home = the evidence constellation (real stored data) as the stage, with a command bar for the human in the loop; details below.
import { useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Icon, Meter } from '../ui.jsx';
import { fmtAmount, ratio, unitOf } from '../views/vault/format.js';
import { ConstellationPanel } from '../views/_overview-parts.jsx';
import { T, homeLine } from './copy.js';
import { mainVault, pendingOf } from './data.js';
import { href } from './nav.js';
import { buildScene } from './scene-model.js';

export default function Home({ data, owner, canWrite, demo, opts, toast }) {
  const s = data.status.data; const sources = s?.sources ?? [];
  const vault = mainVault(data.vault); const pending = pendingOf(data.decisions);
  const mode = data.autonomy?.mode ?? 'manual'; const paused = Boolean(s?.paused);
  const [busy, setBusy] = useState(false);
  const model = useMemo(() => buildScene({ sources, vault, autonomy: data.autonomy, pending, demo, paused }), [sources, vault, data.autonomy, pending, demo, paused]);
  const ok = sources.filter((x) => x.status === 'ok').length;
  const [l1, l2] = homeLine({ demo, paused, mode, pending: pending.length, vaultLive: Boolean(vault) && !demo, sourcesOk: ok, sourcesTotal: sources.length, signing: Boolean(data.vault?.signingSupported && data.vault?.enabled) });
  const why = !owner.address ? 'Connect your wallet to change this.' : !owner.isOwner ? T.readOnly : T.demoNote;

  const setMode = async (m) => {
    if (m === mode || !canWrite) return;
    setBusy(true);
    try { await api('/api/autonomy/mode', { method: 'PUT', body: { mode: m } }); toast(m === 'auto' ? 'Auto mode is on. The agent will act inside your limits.' : 'Manual mode is on. The agent will ask you first.'); data.reloadAutonomy(); }
    catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };

  const u = vault ? unitOf(vault) : null;
  const isNear = String(vault?.chainId ?? '').startsWith('near'); const tu = isNear ? data.autonomy?.topUp?.near : data.autonomy?.topUp?.evm;
  const gasFrac = vault ? ratio(vault.agentBalance, tu?.target ?? (isNear ? '2000000000000000000000000' : '10000000000000000')) : 0;
  const lowGas = model.gas?.low;
  const finds = [...data.opps].sort((a, b) => b.score - a.score).slice(0, 3);
  const watching = !demo && owner.address && !owner.isOwner;
  return (
    <div className="hm hm-first">
      {/* Command bar: the human in the loop. What is happening, what waits for the owner, who decides. */}
      <div className="hm-bar" role="region" aria-label="Owner controls">
        <span className={`chip ${paused ? 'bad' : demo ? 'mineral' : 'ok'}`}>{paused ? 'Stopped' : demo ? T.demoBadge : 'Live'}</span>
        <p className="hm-bar-t"><b>{l1}</b> <span>{l2}</span></p>
        {watching && <span className="chip" title={T.readOnly}><Icon name="lock" size={12} />Watching only</span>}
        <a className={`btn sm ${pending.length ? 'primary' : 'ghost'}`} href={href('approvals', opts)}>{pending.length ? `${pending.length} waiting for you · Review` : 'Nothing needs you'}</a>
        <div className="hm-bar-mode" role="radiogroup" aria-label="Who decides">
          {[['manual', 'Manual'], ['auto', 'Auto']].map(([k, t]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} disabled={busy} aria-disabled={!canWrite} onClick={() => setMode(k)} title={!canWrite ? why : k === 'auto' ? T.modeAutoBody : T.modeManualBody}>{t}</button>
          ))}
        </div>
        {vault && <span className="hm-bar-fuel" title="Agent fuel">Fuel <b>{fmtAmount(vault.agentBalance, u.decimals, 4)?.text ?? '–'}</b> {u.symbol}</span>}
      </div>
      <ConstellationPanel stage status={data.status} opps={data.opps} evidenceCount={s?.counts?.evidence} />
      <div className="ap-wrap hm-rest">
      <section className="hm-cards">
        <article className="card" aria-labelledby="c-mode">
          <h2 id="c-mode">Who decides?</h2>
          <div className="seg" role="radiogroup" aria-label="Who decides">
            {[['manual', T.modeManualTitle, T.modeManualBody], ['auto', T.modeAutoTitle, T.modeAutoBody]].map(([k, t, b]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} disabled={busy} aria-disabled={!canWrite} onClick={() => setMode(k)} title={!canWrite ? why : undefined}>
                <b>{t}</b><span>{b}</span>
              </button>
            ))}
          </div>
          {!canWrite && <p className="why"><Icon name="lock" size={14} />{why}</p>}
        </article>
        <article className="card" aria-labelledby="c-gas">
          <h2 id="c-gas">Agent fuel</h2>
          {vault ? <>
            <div className="big">{fmtAmount(vault.agentBalance, u.decimals, 4)?.text ?? '–'} <small>{u.symbol}</small></div>
            <Meter value={gasFrac} tone={lowGas ? 'risk' : ''} label="Agent fuel" />
            <p>{lowGas ? 'Running low. ' : ''}{mode === 'auto' ? 'It refills itself from the vault when it runs low, never past your limits.' : 'It only refills itself in Auto mode. In Manual mode it can wait for you.'}</p>
          </> : <p>No vault is connected yet. When one is, the agent’s fuel shows here.</p>}
        </article>
        <article className={`card${pending.length ? ' hot' : ''}`} aria-labelledby="c-need">
          <h2 id="c-need">Needs you</h2>
          <div className="big">{pending.length}</div>
          <p>{pending.length ? 'The agent is waiting for your OK.' : T.emptyApprovals}</p>
          <a className="btn sm primary" href={href('approvals', opts)}>{pending.length ? 'Review' : 'Open Approvals'}</a>
        </article>
      </section>
      <section className="hm-finds" aria-labelledby="f-h">
        <div className="row sp"><h2 id="f-h">What it found lately</h2><a href={href('watch', opts)}>Steer what it looks for →</a></div>
        {finds.length ? (
          <ol>{finds.map((o) => (
            <li key={o.id}>
              <div><b>{o.title}</b><span>{o.score_breakdown?.counts?.sources ?? 0} sources agree · updated {fmt.ago(o.updated_at)}{o.warnings?.some((w) => w.startsWith('LOW CONFIDENCE')) ? ' · not enough proof yet' : ''}</span></div>
              <a className="btn sm ghost" href={`#/opportunity/${o.id}`}>Details</a>
            </li>
          ))}</ol>
        ) : <p className="faint">Nothing scored yet. The agent is still reading; this fills in as it learns.</p>}
      </section>
      </div>
    </div>
  );
}
