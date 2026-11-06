// Connect wallet + sign in. Used by the landing page and by the shell chip. Plain-language errors; wagmi is lazy (see session.js).
import { useState } from 'react';
import { Icon } from '../ui.jsx';
import { T } from './copy.js';
import { connectAndSignIn, listWallets, useOwner } from './session.js';

export default function WalletButton({ big = false }) {
  const o = useOwner();
  const [choices, setChoices] = useState(null);
  const [note, setNote] = useState('');
  const go = async (id) => {
    setNote(''); setChoices(null);
    try { await connectAndSignIn(id); } catch (e) { if (e.message === 'NO_WALLET') setNote(T.noWallet); }
  };
  const click = async () => {
    setNote('');
    const w = await listWallets().catch(() => []);
    if (!w.length) return setNote(T.noWallet);
    if (w.length === 1) return go(w[0].id);
    setChoices(w);
  };
  const err = note || (o.error && o.error !== 'NO_WALLET' ? o.error : '');
  return (
    <div className="wb">
      <button type="button" className={`btn primary${big ? ' lg' : ''}`} onClick={click} disabled={o.busy}>
        <Icon name="wallet" size={big ? 20 : 16} />{o.busy ? T.connecting : T.connect}
      </button>
      {choices && (
        <div className="wb-choices" role="group" aria-label="Choose a wallet">
          {choices.map((c) => <button key={c.id} type="button" className="btn" onClick={() => go(c.id)}>{c.icon && <img src={c.icon} alt="" width="18" height="18" />}{c.name}</button>)}
        </div>
      )}
      {!err && !choices && <p className="wb-hint">{T.signHint}</p>}
      {err && <p className="wb-err" role="alert">{err}</p>}
    </div>
  );
}
