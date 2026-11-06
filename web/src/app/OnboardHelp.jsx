// Shown when MetaMask refuses the one-time relayer setup from a website. It lists exactly what to enter in MetaMask's own Send screen. Nothing here sends anything.
import { useState } from 'react';
import { onboardRows, ONBOARD_STEPS } from './onboardHelp.js';

export default function OnboardHelp({ setup, onClose, onSign }) {
  const rows = onboardRows(setup); const [copied, setCopied] = useState('');
  const [sig, setSig] = useState({ s: 'idle', msg: '' }); // the alternative: one raw-hash signature instead of typing the values
  const sign = async () => { setSig({ s: 'busy', msg: '' }); try { const r = await onSign(); setSig({ s: 'done', msg: r?.already ? 'This wallet was already set up. Close this and press the button again.' : 'Done. The setup is on the network. Close this and press the button again.' }); } catch (e) { setSig({ s: 'err', msg: /rejected|denied/i.test(e?.message ?? '') ? 'You closed the wallet. Nothing was sent.' : (e?.message ?? 'That did not work.') }); } };
  if (!rows) return null;
  const copy = async (k, text) => { try { await navigator.clipboard.writeText(text); setCopied(k); setTimeout(() => setCopied(''), 1500); } catch { setCopied('manual'); } };
  return (
    <div className="card" role="region" aria-label="One-time wallet setup" style={{ marginTop: 12 }}>
      <h2>One step to do inside MetaMask</h2>
      <p>MetaMask will not let a website send this one-time setup to your own address. Do it from MetaMask's own Send screen instead. It is needed once for this wallet.</p>
      <ol>{ONBOARD_STEPS.map((t) => <li key={t}>{t}</li>)}</ol>
      {onSign && (
        <details className="vp-alt">
          <summary>No “Hex data” box in your MetaMask? Sign once instead</summary>
          <p>Turn on <b>Settings → Advanced → Eth_sign requests</b> in MetaMask, then press the button. MetaMask will warn that it is signing a raw hash. This signs exactly the one-time setup for this wallet and nothing else. Turn the setting off again afterwards.</p>
          <button type="button" className="btn" disabled={sig.s === 'busy' || sig.s === 'done'} onClick={sign}>{sig.s === 'busy' ? 'Check your wallet…' : 'Set up with one signature'}</button>
          {sig.msg && <p className={sig.s === 'err' ? 'vp-err' : 'faint'} role={sig.s === 'err' ? 'alert' : 'status'}>{sig.msg}</p>}
        </details>
      )}
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr max-content', gap: '6px 12px', alignItems: 'center', wordBreak: 'break-all' }}>
        {rows.map((r) => (<div key={r.key} style={{ display: 'contents' }}>
          <dt className="faint">{r.label}</dt><dd style={{ margin: 0, fontFamily: 'var(--f-mono, monospace)', fontSize: 13 }}>{r.value}</dd>
          {r.copy ? <button type="button" className="btn sm" onClick={() => copy(r.key, r.copy)}>{copied === r.key ? 'Copied' : 'Copy'}</button> : <span />}
        </div>))}
      </dl>
      {copied === 'manual' && <p className="faint" role="status">Your browser would not copy. Select the value and copy it by hand.</p>}
      <p className="faint">These values are for this wallet right now. If you wait a long time, press the button again to get fresh ones.</p>
      {onClose && <button type="button" className="btn sm" onClick={onClose}>Close</button>}
    </div>
  );
}
