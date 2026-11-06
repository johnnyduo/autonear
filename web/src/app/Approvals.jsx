// Approvals: what the agent wants to do, in plain words. Hold to approve. Approved items that still need the owner's wallet are finished inline.
import { lazy, Suspense, useState } from 'react';
import { api, fmt } from '../api.js';
import { Empty, Icon, SkeletonRows } from '../ui.jsx';
import { STATUS_WORD, T, describeDecision } from './copy.js';
import { pendingOf } from './data.js';
import { href } from './nav.js';
import HoldButton from './HoldButton.jsx';

const WalletPanel = lazy(() => import('../wallet/WalletPanel.jsx'));

function Technical({ d }) {
  return <details className="tech"><summary>Technical details</summary><dl><dt>Request</dt><dd className="mono-v">{d.id}</dd><dt>Network</dt><dd className="mono-v">{d.chain_id}</dd><dt>Fingerprint</dt><dd className="mono-v">{d.payload_hash}</dd></dl></details>;
}

function Finish({ d, reload, opts, toast }) {
  const [rc, setRc] = useState({ busy: false, msg: '' });
  const evm = String(d.chain_id).startsWith('evm:');
  const submit = async (txHash) => {
    setRc({ busy: true, msg: '' });
    try { const r = await api(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash: String(txHash).trim() } }); setRc({ busy: false, msg: r.recorded ? 'Recorded and checked on chain.' : 'The chain did not confirm it yet. Try again in a minute.' }); if (r.recorded) { toast('Done: checked on chain.'); reload(); } }
    catch (e) { setRc({ busy: false, msg: e.message }); }
  };
  if (d.action === 'grant_mandate') return <p className="why">Approved. Now send the on-chain steps from your wallet. <a className="btn sm primary" href={href(`vault/grant/${d.id}`, opts)}>Continue</a></p>;
  if (!evm) return <p className="why">Approved. This network is finished from the command line. <a className="btn sm" href={href('approval', opts)}>Show me how</a></p>;
  return (
    <div className="finish">
      <p className="why"><Icon name="wallet" size={14} />Approved. One last step: publish it from your own wallet. We check the result on chain.</p>
      <Suspense fallback={<SkeletonRows n={2} />}><WalletPanel decision={d} token="owner" onHash={submit} receiptBusy={rc.busy} /></Suspense>
      {rc.msg && <p role="status">{rc.msg}</p>}
    </div>
  );
}

export default function Approvals({ data, owner, canWrite: canOwn, opts, toast }) {
  const canWrite = canOwn && !data.demoDecisions; // example requests cannot be approved
  const [busy, setBusy] = useState('');
  const pending = pendingOf(data.decisions);
  const approved = data.decisions.filter((d) => d.effectiveStatus === 'approved' && !String(d.approver ?? '').startsWith('mandate:'));
  const past = data.decisions.filter((d) => ['executed', 'rejected', 'expired', 'failed'].includes(d.effectiveStatus)).slice(0, 8);
  const why = !owner.address ? 'Connect your wallet to decide.' : !owner.isOwner ? T.readOnly : T.demoNote;
  const act = async (d, kind) => {
    setBusy(d.id);
    try {
      if (kind === 'approve') await api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: owner.address } });
      else await api(`/api/decisions/${d.id}/reject`, { method: 'POST', body: { reason: 'Rejected by the owner' } });
      toast(kind === 'approve' ? 'Approved.' : 'Rejected. The agent will not do this.'); data.reload();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(''); }
  };
  return (
    <div className="ap-wrap">
      <h1 className="pg">Approvals</h1>
      <p className="pg-sub">{data.autonomy?.mode === 'auto' ? 'Auto mode is on: the agent handles what it safely can. You only see what it left for you.' : 'Manual mode: nothing is published unless you approve it here.'}</p>
      {!canWrite && <p className="why"><Icon name="lock" size={14} />{why}</p>}
      {!pending.length && !approved.length && <Empty title={T.emptyApprovals}>{T.emptyApprovalsHelp}</Empty>}
      <ul className="req">
        {pending.map((d) => { const t = describeDecision(d); return (
          <li key={d.id} className="card hot">
            <div className="row sp"><h2>{t.title}</h2><span className="chip warn">{STATUS_WORD.pending}</span></div>
            <p>{t.why}</p>
            <p className="faint">Cost: {t.cost} · Expires {fmt.until(d.expiry)}</p>
            <div className="row">
              <HoldButton disabled={!canWrite} busy={busy === d.id} onComplete={() => act(d, 'approve')} />
              <button type="button" className="btn" disabled={!canWrite || busy === d.id} onClick={() => act(d, 'reject')}>{T.reject}</button>
            </div>
            <Technical d={d} />
          </li>
        ); })}
        {approved.map((d) => (
          <li key={d.id} className="card live">
            <div className="row sp"><h2>{describeDecision(d).title}</h2><span className="chip ok">{STATUS_WORD.approved}</span></div>
            {canWrite ? <Finish d={d} reload={data.reload} opts={opts} toast={toast} /> : <p className="why">{why}</p>}
            <Technical d={d} />
          </li>
        ))}
      </ul>
      {past.length > 0 && <>
        <h2 className="sec">Earlier</h2>
        <ul className="hist">{past.map((d) => <li key={d.id}><span>{describeDecision(d).title}</span><span className={`chip ${d.effectiveStatus === 'executed' ? 'ok' : ''}`}>{STATUS_WORD[d.effectiveStatus] ?? d.effectiveStatus}</span><time>{fmt.ago(d.decided_at ?? d.created_at)}</time></li>)}</ul>
      </>}
    </div>
  );
}
