// Vault: how much is there, what the agent may do with it, and the red button. Limits are shown as sentences, not fields.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Icon, Meter } from '../ui.jsx';
import { chainMeta, fmtAmount, ratio, secsLabel, toMs, unitOf } from '../views/vault/format.js';
import { budgetUse, fuelState, maxText, shortAddr, vaultStatus, withdrawCheck } from './vaultView.js';
import { T, chainName } from './copy.js';
import { mainVault } from './data.js';
import { href } from './nav.js';
import { readNearVault, sendNearTx, sendSetupSigned, sendVaultTx } from './ownerTx.js';
import OnboardHelp from './OnboardHelp.jsx';
import HoldButton from './HoldButton.jsx';
import Payments from './Payments.jsx';
import PayBudget from './PayBudget.jsx';

const tn = (f) => (f > 0.9 ? 'risk' : f > 0.7 ? 'warn' : '');

export default function VaultPage({ data, owner, canWrite: canOwn, demo, opts, toast }) {
  const canWrite = canOwn && !demo; // a made-up vault cannot be changed
  const list = data.vault?.vaults ?? []; // more than one vault: pick which one this page shows (the choice is remembered for the session)
  const [pick, setPick] = useState(() => { try { return sessionStorage.getItem('autonear.vault.pick'); } catch { return null; } });
  const choose = (a) => { setPick(a); try { sessionStorage.setItem('autonear.vault.pick', a); } catch { /* private window */ } };
  const v = list.find((x) => x.address === pick) ?? mainVault(data.vault); const s = data.status.data; const stopped = Boolean(s?.paused);
  const [busy, setBusy] = useState(''); const [amt, setAmt] = useState('');
  const why = !owner.address ? 'Connect your wallet to change this.' : !owner.isOwner ? T.readOnly : demo ? T.demoNote : '';
  const evm = String(v?.chainId ?? '').startsWith('evm:'); const chainNum = evm ? Number(String(v.chainId).slice(4)) : null;
  const near = String(v?.chainId ?? '').startsWith('near'); const mine = (a) => Boolean(a && owner.address && String(a).toLowerCase() === owner.address.toLowerCase());
  const [setup, setSetup] = useState(null); // the one-time wallet setup values, when MetaMask refused to let the page send it
  const [cfg, setCfg] = useState(null); // the vault's own owner / pending owner / paused flag, read from NEAR
  useEffect(() => { if (!near || !v?.address) return undefined; let on = true; readNearVault(v.address).then((c) => on && setCfg(c)).catch(() => {}); return () => { on = false; }; }, [near, v?.address, v?.owner, v?.paused, busy]);
  const nearOwner = near && mine(cfg?.owner ?? v?.owner); const nearPending = near && mine(cfg?.pending_owner);
  const nearTx = (method, args = {}) => sendNearTx({ account: owner.address, receiver: v.address, method, args });
  const run = async (key, fn, ok) => { setBusy(key); try { await fn(); toast(ok); data.reload(); return true; } catch (e) { if (e?.onboard) setSetup(e.onboard); toast(/rejected|denied/i.test(e.message) ? 'You closed the wallet. Nothing was sent.' : e.message, 'bad'); return false; } finally { setBusy(''); } };

  if (!v) return <div className="ap-wrap"><h1 className="pg">Vault</h1><div className="card"><h2>No vault yet</h2><p>A vault holds the test funds the agent may use, inside limits you set. Set one up with the advanced tools, or look at the demo.</p><div className="row"><a className="btn primary" href={href('vault/advanced', opts)}>Set up a vault</a><a className="btn" href={href('vault', { demo: true })}>{T.demo}</a></div></div></div>;

  const u = unitOf(v); const m = v.mandate; const live = m && !m.revoked;
  const money = (x) => `${fmtAmount(x, u.decimals, 4)?.text ?? '–'} ${u.symbol}`;
  // Two parts, reported separately: the server stop is immediate; the on-chain pause needs the owner's wallet. Never claim the second when only the first happened.
  const stop = async () => {
    setBusy('stop');
    try { await api('/api/security/pause', { method: 'POST' }); await api('/api/vault/loop/pause', { method: 'POST' }).catch(() => {}); }
    catch (e) { toast(e.message, 'bad'); setBusy(''); return; }
    if (near && nearOwner && !(cfg?.paused ?? v.paused)) {
      try { await nearTx('pause'); toast('The agent is stopped and the vault is paused on chain.'); }
      catch (e) { toast(`The agent is stopped on the server, but the vault is NOT paused on chain. Until you pause it, the agent’s own key could still use it. ${/rejected|denied/i.test(e.message) ? 'You closed the wallet.' : e.message}`, 'bad'); }
    } else if (near && nearOwner) toast('The agent is stopped. The vault was already paused on chain.');
    else if (!evm) toast('The agent is stopped on the server. Pausing the vault on chain needs the vault owner’s wallet.');
    else if (v.paused) toast('The agent is stopped. The vault was already paused on chain.');
    else {
      try { await sendVaultTx({ chainId: chainNum, address: v.address, fn: 'pause', expect: owner.address }); toast('The agent is stopped and the vault is paused on chain.'); }
      catch (e) { toast(`The agent is stopped on the server, but the vault is NOT paused on chain. Until you pause it, the agent’s own key could still use it. ${/rejected|denied/i.test(e.message) ? 'You closed the wallet.' : e.message}`, 'bad'); }
    }
    data.reload(); setBusy('');
  };
  const start = () => run('start', async () => { await api('/api/security/resume', { method: 'POST' }); await api('/api/vault/loop/resume', { method: 'POST' }).catch(() => {}); }, 'The agent can work again.');
  const protocol = near ? 'near' : evm ? 'evm' : '';
  const pausedNow = near ? Boolean(cfg?.paused ?? v.paused) : Boolean(v.paused);
  const status = vaultStatus({ pendingMine: near && nearPending, paused: pausedNow, stopped, live: Boolean(live), demo });
  const ctlOff = !canWrite || (near && !nearOwner && !nearPending); // who may press the controls; the reason is written out below
  const ctlReason = !canWrite ? why : near && !nearOwner && !nearPending ? (owner.address ? T.nearOwnerOnly : 'Connect the owner’s wallet to use these controls.') : '';
  const fuel = fuelState(v, protocol); const use = budgetUse(v);
  const wd = withdrawCheck(amt, v.available, u.decimals); const wdBusy = busy === 'wd';
  const ownerNow = cfg?.owner ?? v.owner; const pendingNow = cfg?.pending_owner ?? null;
  const explorer = chainMeta(v.chainId)?.addr ? `${chainMeta(v.chainId).addr}${v.address}` : '';
  const copyAddr = async () => { try { await navigator.clipboard.writeText(v.address); toast('Address copied.'); } catch { toast('Your browser would not copy. Select the address and copy it by hand.', 'bad'); } };
  const togglePause = () => (evm
    ? run('pause', () => sendVaultTx({ chainId: chainNum, address: v.address, fn: pausedNow ? 'unpause' : 'pause', expect: owner.address }), pausedNow ? 'Vault un-paused on chain.' : 'Vault paused on chain.')
    : run('pause', () => nearTx(pausedNow ? 'unpause' : 'pause'), pausedNow ? 'Vault un-paused on chain.' : 'Vault paused on chain.'));
  const takeBack = () => { if (wd.base === null) return; return run('wd', () => (evm ? sendVaultTx({ chainId: chainNum, address: v.address, fn: 'withdraw', args: [wd.base], expect: owner.address }) : nearTx('withdraw', { amount: String(wd.base) })), 'Withdrawn to your wallet.').then((done) => { if (done) setAmt(''); }); };
  const onBanner = () => { if (status.action === 'accept') return run('accept', () => nearTx('accept_ownership'), 'You are now the owner of this vault.'); if (status.action === 'unpause') return togglePause(); if (status.action === 'start') return start(); return undefined; };
  const bannerLabel = { accept: busy === 'accept' ? 'Check your wallet…' : T.nearAccept, unpause: busy === 'pause' ? 'Check your wallet…' : 'Un-pause the vault', start: busy === 'start' ? 'Starting…' : T.resume }[status.action];
  const toneIcon = { ok: 'check', warn: 'alert', bad: 'pause' }[status.tone];

  return (
    <div className="ap-wrap vp">
      {list.length > 1 && (
        <div className="vp-tabs" role="group" aria-label="Choose a vault">
          {list.map((x) => <button key={x.address} type="button" className={`vp-tab${x.address === v.address ? ' on' : ''}`} aria-pressed={x.address === v.address} onClick={() => choose(x.address)}>
            <span className="vp-addr">{shortAddr(x.address, 10, 6)}</span>{x.payouts && <span className="chip mineral">Pays tokens</span>}
          </button>)}
        </div>
      )}
      <header className="vp-head">
        <div>
          <h1 className="pg">Vault</h1>
          <div className="vp-meta">
            <span className="chip mineral">{chainName(v.chainId)}</span>
            <span className="vp-addr" title={v.address}>{shortAddr(v.address, 10, 6)}</span>
            <button type="button" className="btn sm ghost" onClick={copyAddr} aria-label="Copy the vault address"><Icon name="copy" size={14} />Copy</button>
            {explorer && <a className="btn sm ghost" href={explorer} target="_blank" rel="noreferrer noopener"><Icon name="external" size={14} />Explorer</a>}
          </div>
          <div className="vp-meta faint">
            <Icon name="key" size={14} />
            <span>Owner: <b>{mine(ownerNow) ? 'You' : shortAddr(ownerNow) || 'unknown'}</b></span>
            {pendingNow && <span>· Waiting to accept: <b>{mine(pendingNow) ? 'You' : shortAddr(pendingNow)}</b></span>}
          </div>
        </div>
        <span className={`chip ${status.tone}`}>{status.chip}</span>
      </header>

      <section className={`vp-banner ${status.tone}`} role="status" aria-live="polite">
        <span className="vp-banner-ic" aria-hidden="true"><Icon name={toneIcon} size={22} /></span>
        <div className="vp-banner-tx"><h2>{status.title}</h2><p>{status.text}</p></div>
        {status.action === 'limits' && <a className="btn primary" href={href('vault/advanced', opts)}>Set the agent’s limits</a>}
        {['accept', 'unpause', 'start'].includes(status.action) && <button type="button" className="btn primary" disabled={ctlOff || ['accept', 'pause', 'start'].includes(busy)} onClick={onBanner}>{bannerLabel}</button>}
      </section>
      {ctlReason && <p className="why vp-why"><Icon name="lock" size={14} />{ctlReason}</p>}
      {near && setup && <OnboardHelp setup={setup} onClose={() => setSetup(null)} onSign={() => sendSetupSigned({ account: owner.address })} />}

      <div className="vp-tiles">
        <section className="vp-tile">
          <h2>In the vault</h2>
          <div className="big">{money(v.available)}</div>
          <p>Test funds the owner can still hand to the agent or take back.</p>
        </section>
        <section className={`vp-tile ${fuel === 'low' ? 'warn' : ''}`}>
          <h2>Agent fuel {fuel === 'low' && <span className="chip warn">Running low</span>}</h2>
          <div className="big">{money(v.agentBalance)}</div>
          <p>{fuel === 'low' ? 'Under 0.05 NEAR. The agent may not be able to pay for its next action.' : 'What the agent holds to pay for its own actions.'}</p>
        </section>
        <section className="vp-tile">
          <h2>Budget used</h2>
          {use ? <><div className="big">{Math.round(use.ratio * 100)}<small> %</small></div><Meter value={use.ratio} tone={tn(use.ratio)} label="Share of the total budget used" /><p>{money(use.used)} of {money(use.total)} in total.</p></>
            : <><div className="big vp-none">None</div><p>No limits are on, so there is no budget to use.</p></>}
        </section>
      </div>

      <section className="card vp-card">
        <div className="vp-cardhead"><h2>The agent’s limits</h2><a className="btn sm" href={href('vault/advanced', opts)}>Change limits (advanced)</a></div>
        {live ? <>
          <ul className="vp-lim">
            <li><span className="vp-k">Each time</span><b>{money(m.perDrawCap)}</b><small>at most, per action</small></li>
            <li><span className="vp-k">Every {secsLabel(m.periodSecs)}</span><b>{money(m.periodCap)}</b><Meter value={ratio(v.usage?.periodSpent, m.periodCap)} tone={tn(ratio(v.usage?.periodSpent, m.periodCap))} label="Used this period" /><small>{money(v.usage?.periodSpent)} used this period</small></li>
            <li><span className="vp-k">In total</span><b>{money(m.totalCap)}</b><Meter value={ratio(v.usage?.totalSpent, m.totalCap)} tone={tn(ratio(v.usage?.totalSpent, m.totalCap))} label="Used in total" /><small>{money(v.usage?.totalSpent)} used so far</small></li>
            <li><span className="vp-k">Publishes</span><b>{m.maxDeploys}</b><small>{v.usage?.deploys ?? 0} used</small></li>
            <li><span className="vp-k">Valid until</span><b className="vp-date">{fmt.date(toMs(m.expiresAt))}</b><small>then it stops by itself</small></li>
          </ul>
          <p className="faint vp-note"><Icon name="lock" size={13} />These limits live on the blockchain. Even the agent’s own server cannot go past them.</p>
        </> : <div className="vp-empty"><Icon name="vault" size={28} /><p>No limits are set. The agent cannot take anything from this vault until you set them.</p></div>}
      </section>

      {v.payouts && (!live || (v.payouts.tokens ?? []).some((t) => !t.symbol)) && <PayBudget v={v} owner={owner} canWrite={canWrite} demo={demo} opts={opts} toast={toast} />}
      {v.payouts && <Payments v={v} data={data} owner={owner} canWrite={canWrite} demo={demo} opts={opts} toast={toast} stopped={stopped} />}

      <div className="vp-two">
        <section className="card vp-card" aria-labelledby="vp-take">
          <h2 id="vp-take">Take funds back</h2>
          <p className="vp-sub">Move test funds from the vault to your own wallet. This works even when the limits are off.</p>
          <label className="vp-label" htmlFor="vp-amt">Amount ({u.symbol})</label>
          <div className="vp-field">
            <input id="vp-amt" className="input" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} disabled={ctlOff} aria-invalid={Boolean(wd.error)} aria-describedby="vp-amt-help" />
            <button type="button" className="btn" disabled={ctlOff || !maxText(v.available, u.decimals)} onClick={() => setAmt(maxText(v.available, u.decimals))}>Max</button>
          </div>
          <p id="vp-amt-help" className={wd.error ? 'vp-err' : 'faint'} role={wd.error ? 'alert' : undefined}>{wd.error || `Available: ${money(v.available)}`}</p>
          <button type="button" className="btn primary vp-wide" disabled={ctlOff || wd.base === null || wdBusy} onClick={takeBack}>{wdBusy ? 'Check your wallet…' : 'Take back to my wallet'}</button>
        </section>

        <section className="card danger-zone vp-card" aria-labelledby="vp-stop">
          <h2 id="vp-stop">Emergency controls</h2>
          <p className="vp-sub">For when something looks wrong. Each one can be undone later.</p>
          <ul className="vp-ctl">
            <li>
              <div><b>{stopped ? 'The agent is stopped' : 'Stop the agent'}</b><p>{stopped ? 'It will not act until you start it again.' : T.stopHelp}</p></div>
              {stopped ? <button type="button" className="btn" disabled={ctlOff || busy === 'start'} onClick={start}>{T.resume}</button>
                : <HoldButton disabled={ctlOff} busy={busy === 'stop'} onComplete={stop}>{T.stop}</HoldButton>}
            </li>
            {(near || evm) && <li>
              <div><b>{pausedNow ? 'The vault is paused' : 'Pause the vault'}</b><p>{pausedNow ? 'Nothing can leave it until you un-pause.' : 'Freezes the vault itself, so even the agent’s own key cannot use it. Needs your wallet.'}</p></div>
              <button type="button" className="btn" disabled={ctlOff || busy === 'pause'} onClick={togglePause}>{busy === 'pause' ? 'Check your wallet…' : pausedNow ? 'Un-pause on chain' : 'Pause on chain'}</button>
            </li>}
            {near && <li>
              <div><b>Switch the limits off</b><p>{live ? 'Ends the agent’s budget on chain. The funds stay in the vault and you can set new limits later.' : 'There are no limits on, so there is nothing to switch off.'}</p></div>
              <HoldButton disabled={ctlOff || !live} busy={busy === 'revoke'} onComplete={() => run('revoke', () => nearTx('revoke'), 'The agent’s limits are switched off.')}>Switch the limits off</HoldButton>
            </li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
