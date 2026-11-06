// Finishing an approved grant on a NEAR vault: each on-chain step is signed in the owner's wallet, one signature per step, in order.
// The wallet is an Ethereum wallet (MetaMask) on the NEAR EVM network; see ../wallet/nearEth.js. Progress is kept for the session so a reload does not lose it.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon, SkeletonRows } from '../ui.jsx';
import { T } from './copy.js';
import { sendNearTx, sendSetupSigned } from './ownerTx.js';
import OnboardHelp from './OnboardHelp.jsx';
import { payoutsNeedNote } from './vaultView.js';

const KEY = (id) => `autonear.nearsteps.${id}`;
const load = (id) => { try { return JSON.parse(sessionStorage.getItem(KEY(id)) || '{}'); } catch { return {}; } };
const save = (id, v) => { try { sessionStorage.setItem(KEY(id), JSON.stringify(v)); } catch { /* storage may throw */ } };

/** Plain words for one plan step. */
export function stepWords(step, vault) {
  const c = step.call; if (!c) return { title: step.title, note: '' };
  if (c.method === 'allow_template') return { title: 'Choose which contract the agent may publish', note: 'The vault will only publish this exact, checked contract.' };
  if (c.method === 'set_mandate') return { title: 'Set the agent’s spending limits', note: 'How much it may take, how often, and until when.' };
  if (!c.method && c.receiverId === vault) return { title: 'Put test funds into the vault', note: 'The pool the agent may use inside its limits. You can take it back any time.' };
  if (!c.method) return { title: 'Give the agent a little gas to start', note: 'It needs a small balance to pay for its first action.' };
  return { title: step.title, note: '' };
}

export default function NearSteps({ d, owner, onDone }) {
  const [plan, setPlan] = useState(null); const [err, setErr] = useState(''); const [setup, setSetup] = useState(null);
  const [prog, setProg] = useState(() => load(d.id)); const [busy, setBusy] = useState(-1); const [stage, setStage] = useState(''); const [verdict, setVerdict] = useState(null); const [on, setOn] = useState(null);
  const vault = d.payload?.vault?.address ?? d.target;
  useEffect(() => { let on = true; api(`/api/vault/plan?decisionId=${d.id}`).then((p) => on && setPlan(p)).catch((e) => on && setErr(e.message)); return () => { on = false; }; }, [d.id]);
  if (err) return <p className="why" role="alert">{err}</p>;
  if (!plan) return <SkeletonRows n={3} />;
  const steps = plan.steps.filter((s) => s.who === 'human' && s.call);
  const ownerOk = owner.address && String(d.payload?.vault?.owner ?? '').toLowerCase() === owner.address.toLowerCase();
  if (!ownerOk) return <p className="why"><Icon name="lock" size={14} />This vault belongs to {d.payload?.vault?.owner ?? 'another account'}. Connect that wallet to finish the steps.</p>;
  const next = steps.findIndex((_, i) => !prog[i]);
  const run = async (i) => {
    const s = steps[i]; setBusy(i); setErr('');
    try {
      const c = s.call;
      const r = await sendNearTx({ account: owner.address, receiver: c.receiverId, method: c.method || null, args: c.args ?? {}, deposit: BigInt(c.deposit ?? 0), gas: c.gas ? BigInt(c.gas) : undefined, onStage: setStage });
      const p = { ...prog, [i]: { hash: r.hash, explorer: r.explorer } }; setProg(p); save(d.id, p);
      if (i === steps.length - 1 || !steps.some((_, j) => j > i && !p[j])) { try {
        const v = await api(`/api/vault/verify?decisionId=${d.id}`); setVerdict(v);
        if (v.ok || v.fieldsOk) setOn(await api('/api/vault/activate', { method: 'POST', body: { decisionId: d.id } }).catch((e) => ({ activated: false, reason: e.message })));
        onDone?.();
      } catch (e) { setErr(e.message); } }
    } catch (e) { if (e?.onboard) setSetup(e.onboard); setErr(/rejected|denied/i.test(e.message) ? 'You closed the wallet. Nothing was sent.' : e.message); }
    finally { setBusy(-1); setStage(''); }
  };
  return (
    <div className="finish near-steps">
      <p className="why"><Icon name="wallet" size={14} />{T.nearStepsIntro}</p>
      {payoutsNeedNote(d.payload) && <p className="vp-warnline"><Icon name="info" size={16} />{payoutsNeedNote(d.payload)}</p>}
      <ol className="ap-steps">
        {steps.map((s, i) => { const w = stepWords(s, vault); const done = prog[i]; return (
          <li key={i} className={done ? 'done' : i === next ? 'now' : ''}>
            <b>{i + 1}. {w.title}</b>{w.note && <span className="faint"> {w.note}</span>}
            {done ? <span className="chip ok">Done</span> : <button type="button" className="btn sm primary" disabled={i !== next || busy >= 0} onClick={() => run(i)}>{busy === i ? (stage === 'wait' ? 'Waiting for the network…' : 'Check your wallet…') : 'Sign in your wallet'}</button>}
            {done && <a className="faint" href={done.explorer} target="_blank" rel="noreferrer noopener">see it on the network</a>}
          </li>
        ); })}
      </ol>
      {err && <p className="why" role="alert">{err}</p>}
      {setup && <OnboardHelp setup={setup} onClose={() => setSetup(null)} onSign={() => sendSetupSigned({ account: owner.address })} />}
      {verdict && <p role="status">{verdict.ok || verdict.fieldsOk ? 'Checked on the network: the limits match what you approved.' : 'The network does not match what you approved yet. Wait a minute and check again.'}</p>}
      {on && <p role="status">{on.activated ? T.nearOn : `${T.nearNotOn} ${on.reason ?? ''}`.trim()}</p>}
    </div>
  );
}
