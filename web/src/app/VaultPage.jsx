// Vault: how much is there, what the agent may do with it, and the red button. Limits are shown as sentences, not fields.
import { useState } from 'react';
import { api, fmt } from '../api.js';
import { Icon, Meter } from '../ui.jsx';
import { chainMeta, fmtAmount, ratio, secsLabel, toMs, unitOf } from '../views/vault/format.js';
import { T, chainName } from './copy.js';
import { mainVault } from './data.js';
import { href } from './nav.js';
import { sendVaultTx } from './ownerTx.js';
import HoldButton from './HoldButton.jsx';

const tn = (f) => (f > 0.9 ? 'risk' : f > 0.7 ? 'warn' : '');

export default function VaultPage({ data, owner, canWrite: canOwn, demo, opts, toast }) {
  const canWrite = canOwn && !demo; // an example vault cannot be changed
  const v = mainVault(data.vault); const s = data.status.data; const stopped = Boolean(s?.paused);
  const [busy, setBusy] = useState(''); const [amt, setAmt] = useState('');
  const why = !owner.address ? 'Connect your wallet to change this.' : !owner.isOwner ? T.readOnly : demo ? T.demoNote : '';
  const evm = String(v?.chainId ?? '').startsWith('evm:'); const chainNum = evm ? Number(String(v.chainId).slice(4)) : null;
  const run = async (key, fn, ok) => { setBusy(key); try { await fn(); toast(ok); data.reload(); } catch (e) { toast(/rejected|denied/i.test(e.message) ? 'You closed the wallet. Nothing was sent.' : e.message, 'bad'); } finally { setBusy(''); } };

  if (!v) return <div className="ap-wrap"><h1 className="pg">Vault</h1><div className="card"><h2>No vault yet</h2><p>A vault holds the test funds the agent may use, inside limits you set. Set one up with the advanced tools, or look at the demo.</p><div className="row"><a className="btn primary" href={href('vault/advanced', opts)}>Set up a vault</a><a className="btn" href={href('vault', { demo: true })}>{T.demo}</a></div></div></div>;

  const u = unitOf(v); const m = v.mandate; const live = m && !m.revoked;
  const money = (x) => `${fmtAmount(x, u.decimals, 4)?.text ?? '–'} ${u.symbol}`;
  const stop = () => run('stop', async () => { await api('/api/security/pause', { method: 'POST' }); await api('/api/vault/loop/pause', { method: 'POST' }).catch(() => {}); }, 'The agent is stopped.');
  const start = () => run('start', async () => { await api('/api/security/resume', { method: 'POST' }); await api('/api/vault/loop/resume', { method: 'POST' }).catch(() => {}); }, 'The agent can work again.');
  const wei = (() => { try { const [i, f = ''] = String(amt).trim().split('.'); return BigInt(i || '0') * 10n ** BigInt(u.decimals) + BigInt((f + '0'.repeat(u.decimals)).slice(0, u.decimals) || '0'); } catch { return 0n; } })();
  return (
    <div className="ap-wrap">
      <div className="row sp"><h1 className="pg">Vault</h1><span className={`chip ${v.paused || stopped ? 'bad' : live ? 'ok' : 'warn'}`}>{v.paused ? 'Paused on chain' : stopped ? 'Agent stopped' : live ? 'Limits are on' : 'No limits set'}</span></div>
      <p className="pg-sub">{chainName(v.chainId)} · {chainMeta(v.chainId)?.addr ? <a href={`${chainMeta(v.chainId).addr}${v.address}`} target="_blank" rel="noreferrer noopener">{`${v.address.slice(0, 8)}…${v.address.slice(-4)}`}</a> : `${v.address.slice(0, 8)}…${v.address.slice(-4)}`}</p>
      {!canWrite && <p className="why"><Icon name="lock" size={14} />{why}</p>}
      <div className="vt-grid">
        <section className="card"><h2>In the vault</h2><div className="big">{money(v.available)}</div><p>Test funds you can still hand to the agent.</p></section>
        <section className="card"><h2>Agent fuel</h2><div className="big">{money(v.agentBalance)}</div><p>What the agent holds to pay for its own actions.</p></section>
      </div>
      <section className="card">
        <h2>The agent’s limits</h2>
        {live ? <>
          <ul className="lim">
            <li>At most <b>{money(m.perDrawCap)}</b> each time</li>
            <li>At most <b>{money(m.periodCap)}</b> every <b>{secsLabel(m.periodSecs)}</b> <Meter value={ratio(v.usage?.periodSpent, m.periodCap)} tone={tn(ratio(v.usage?.periodSpent, m.periodCap))} label="Used this period" /></li>
            <li>At most <b>{money(m.totalCap)}</b> in total <Meter value={ratio(v.usage?.totalSpent, m.totalCap)} tone={tn(ratio(v.usage?.totalSpent, m.totalCap))} label="Used in total" /></li>
            <li>At most <b>{m.maxDeploys}</b> publishes ({v.usage?.deploys ?? 0} used)</li>
            <li>Until <b>{fmt.date(toMs(m.expiresAt))}</b></li>
          </ul>
          <p className="faint">These limits live on the blockchain. Even the agent’s own server cannot go past them.</p>
        </> : <p>No limits are set, so the agent cannot take anything from the vault.</p>}
        <a className="btn sm" href={href('vault/advanced', opts)}>Change limits (advanced tools)</a>
      </section>
      <section className="card danger-zone">
        <h2>Stop and take back</h2>
        <div className="row">
          {stopped ? <button type="button" className="btn" disabled={!canWrite || busy === 'start'} onClick={start}>{T.resume}</button>
            : <HoldButton disabled={!canWrite} busy={busy === 'stop'} onComplete={stop}>{T.stop}</HoldButton>}
          <small className="faint">{T.stopHelp}</small>
        </div>
        {evm && <div className="row own">
          <button type="button" className="btn sm" disabled={!canWrite || busy === 'pause'} onClick={() => run('pause', () => sendVaultTx({ chainId: chainNum, address: v.address, fn: v.paused ? 'unpause' : 'pause' }), v.paused ? 'Vault un-paused on chain.' : 'Vault paused on chain.')}>{v.paused ? 'Un-pause on chain' : 'Pause on chain (wallet)'}</button>
          <input className="input" inputMode="decimal" placeholder={`Amount in ${u.symbol}`} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount to take back" disabled={!canWrite} />
          <button type="button" className="btn sm" disabled={!canWrite || wei <= 0n || busy === 'wd'} onClick={() => run('wd', () => sendVaultTx({ chainId: chainNum, address: v.address, fn: 'withdraw', args: [wei] }), 'Withdrawn to your wallet.')}>Take back to my wallet</button>
        </div>}
        {!evm && <p className="faint">On NEAR, pausing and withdrawing are done with the command-line steps in the advanced tools.</p>}
      </section>
    </div>
  );
}
