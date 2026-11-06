// Connect wallet + sign in. Used by the landing page and by the shell chip. Plain-language errors; wagmi is lazy (see session.js).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, Icon } from '../ui.jsx';
import { T } from './copy.js';
import { connectAndSignIn, listWallets, useOwner } from './session.js';

export default function WalletButton({ big = false, hint = true }) {
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
      {choices && createPortal( /* a modal on document.body: the landing hero clips and blocks pointer events inside it */
        <Dialog title="Choose a wallet" onClose={() => setChoices(null)}>
          <p className="faint" style={{ margin: '0 0 12px' }}>{T.signHint}</p>
          <div className="wb-list" role="group" aria-label="Wallets">
            {choices.map((c, i) => <button key={c.id} type="button" className="btn lg" data-autofocus={i === 0 ? '' : undefined} onClick={() => go(c.id)}>{c.icon && <img src={c.icon} alt="" width="24" height="24" />}{c.name}</button>)}
          </div>
        </Dialog>, document.body)}
      {hint && !err && !choices && <p className="wb-hint">{T.signHint}</p>}
      {err && <p className="wb-err" role="alert">{err}</p>}
    </div>
  );
}
