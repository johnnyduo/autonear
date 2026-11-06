// Shown when MetaMask refuses the one-time relayer setup from a website. It lists exactly what to enter in MetaMask's own Send screen. Nothing here sends anything.
import { useState } from 'react';
import { onboardRows, ONBOARD_STEPS } from './onboardHelp.js';

export default function OnboardHelp({ setup, onClose }) {
  const rows = onboardRows(setup); const [copied, setCopied] = useState('');
  if (!rows) return null;
  const copy = async (k, text) => { try { await navigator.clipboard.writeText(text); setCopied(k); setTimeout(() => setCopied(''), 1500); } catch { setCopied('manual'); } };
  return (
    <div className="card" role="region" aria-label="One-time wallet setup" style={{ marginTop: 12 }}>
      <h2>One step to do inside MetaMask</h2>
      <p>MetaMask will not let a website send this one-time setup to your own address. Do it from MetaMask's own Send screen instead. It is needed once for this wallet.</p>
      <ol>{ONBOARD_STEPS.map((t) => <li key={t}>{t}</li>)}</ol>
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
