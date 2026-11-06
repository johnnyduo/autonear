// "Add test USDC": for a vault whose payout token is the free TEST token (mock USDC). One wallet signature mints it straight into the vault; the agent can then pay from it, inside the limits.
// Shown only for a token whose own metadata says it is a mock (the contract itself is testnet-only), and usable only with the owner's wallet.
import { useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';
import { isMockToken, mintCheck, MINT_PRESETS } from './vaultView.js';
import { mintTestToken } from './ownerTx.js';

export default function MintCard({ v, tk, owner, canWrite, demo, toast, onDone }) {
  const [mock, setMock] = useState(demo ? true : null); // null = still asking the token who it is
  const [amt, setAmt] = useState('100'); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    if (demo) return undefined; let on = true;
    import('../wallet/nearEth.js').then((n) => n.viewNear({ contract: tk.token, method: 'ft_metadata' })).then((m) => on && setMock(isMockToken(m))).catch(() => on && setMock(false));
    return () => { on = false; };
  }, [tk.token, demo]);
  if (!mock || !Number.isInteger(tk.decimals)) return null;
  const chk = mintCheck(amt, tk.decimals); const sym = tk.symbol ?? 'tokens'; const id = `mint-${tk.token}`;
  const mint = async () => {
    if (chk.base === null || !canWrite || busy) return; setBusy(true); setErr('');
    try {
      await mintTestToken({ account: owner.address, token: tk.token, to: v.address, base: chk.base, decimals: tk.decimals });
      toast(`Added ${amt.trim()} ${sym} to the vault. The balance can take a few seconds to show.`); onDone?.();
    } catch (e) { setErr(/rejected|denied/i.test(e?.message ?? '') ? 'You closed the wallet. Nothing was sent.' : (e?.message ?? 'That did not work.')); }
    finally { setBusy(false); }
  };
  const caps = tk.usable && tk.each?.cap ? ` (at most ${tk.each.cap} each time, ${tk.period.capShort} per period, ${tk.total.capShort} in total)` : '';
  return (
    <div className="vp-mint">
      <div className="vp-mint-h"><Icon name="bolt" size={16} /><b>Add test {sym}</b></div>
      <p>This is a free test token that anyone can mint. It goes straight into the vault, and the agent can then pay from it inside the limits above{caps}.</p>
      {!tk.usable && <p className="vp-err">This token is not approved for payments yet, so the agent could not use what you add.</p>}
      <label className="vp-label" htmlFor={id}>Amount ({sym})</label>
      <div className="vp-field">
        <input id={id} className="input" inputMode="decimal" autoComplete="off" value={amt} onChange={(e) => setAmt(e.target.value)} disabled={!canWrite || busy} aria-invalid={Boolean(chk.error)} aria-describedby={`${id}-h`} />
        {MINT_PRESETS.map((n) => <button key={n} type="button" className="btn sm" disabled={!canWrite || busy} onClick={() => setAmt(String(n))}>{n}</button>)}
      </div>
      <p id={`${id}-h`} className={chk.error || err ? 'vp-err' : 'faint'} role={chk.error || err ? 'alert' : undefined}>{err || chk.error || (canWrite ? 'Up to 10,000 in one go. One signature in your wallet.' : demo ? 'This is illustrated data, so nothing can be added here.' : owner?.address ? 'Only the vault’s owner wallet can add test tokens.' : 'Connect the owner’s wallet to add test tokens.')}</p>
      <button type="button" className="btn primary" disabled={!canWrite || chk.base === null || busy} onClick={mint}>{busy ? 'Check your wallet…' : `Add ${sym} to the vault`}</button>
    </div>
  );
}
