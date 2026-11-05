// Approval room. Approval is a human decision about ONE scoped action; it is NOT execution.
// Step 1 review -> step 2 approve (typed phrase + acknowledgement + bound signer) -> step 3 YOU sign in your own wallet/CLI
// -> step 4 the API verifies the transaction on-chain and only then records the deployment.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Chip, Dialog, Empty, ErrorPanel, Icon, NeedsOperator, Panel, SkeletonRows, StaleNote, Status, useToast } from '../ui.jsx';
import { Checks, CopyButton, Full, KV, PageHead, cap, countdown, sha256Text, useNow } from './_run-parts.jsx';

const WalletPanel = lazy(() => import('../wallet/WalletPanel.jsx'));
const SIGNER_RE = { near: /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, evm: /^0x[0-9a-fA-F]{40}$/ };
const protoOf = (d) => d.payload?.protocol ?? (String(d.chain_id).startsWith('evm:') ? 'evm' : 'near');

export default function Approval({ params, status, token }) {
  return params[0] ? <Detail key={params[0]} id={params[0]} status={status} token={token} /> : <List />;
}

/* =============================== list =============================== */
function List() {
  const q = useApi('/api/decisions', { poll: 10000 });
  const now = useNow(1000);
  const items = q.data?.items ?? [];
  const order = { pending: 0, approved: 1, executing: 1, executed: 2, rejected: 3, expired: 3 };
  const sorted = [...items].sort((a, b) => (order[a.effectiveStatus] ?? 9) - (order[b.effectiveStatus] ?? 9) || b.created_at - a.created_at);
  const waiting = items.filter((d) => d.effectiveStatus === 'pending').length;
  return (
    <div className="page">
      <PageHead eyebrow="Approval room" title={waiting ? `${waiting} decision${waiting === 1 ? '' : 's'}` : 'No decision'} em={waiting ? 'awaiting you.' : 'awaiting you.'}>
        One consequential action per decision, bound to an exact payload hash and a nonce. Approving authorizes; it never executes.
      </PageHead>
      {q.loading && <SkeletonRows n={4} />}
      {q.error && !q.data && <ErrorPanel error={q.error} onRetry={q.reload} what="decisions" />}
      {q.stale && <StaleNote at={q.at} />}
      {q.data && !items.length && <Empty title="No decisions yet" action={<a className="btn" href="#/run">Open runs</a>}>The Launch Planner creates a decision only when a run has an attested build, passing automated checks and a "build" verdict. See the last run's Launch Planner event for why none exists.</Empty>}
      {items.length > 0 && (
        <Panel title="Decisions" pad={false}>
          <ul className="list" aria-label="Decisions">
            {sorted.map((d) => (
              <li key={d.id}>
                <a className="li ap-li" href={`#/approval/${d.id}`}>
                  <span className="mono-v ap-li-id">{d.id}</span>
                  <span><Status state={d.effectiveStatus} /></span>
                  <span className="ap-li-what">{cap(d.action)} <span className="faint">on</span> {d.payload?.networkLabel ?? d.chain_id}</span>
                  <span className="mono-v faint">artifact {fmt.short(d.artifact_hash, 8)}</span>
                  <span className="mono-v ap-li-exp">{d.effectiveStatus === 'pending' ? `expires in ${countdown(d.expiry, now)}` : d.effectiveStatus === 'expired' ? `expired ${fmt.ago(d.expiry)}` : `decided ${fmt.ago(d.decided_at ?? d.created_at)}`}</span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/* =============================== detail =============================== */
function Detail({ id, status, token }) {
  const toast = useToast();
  const [poll, setPoll] = useState(0);
  const dec = useApi(`/api/decisions/${id}`, { poll });
  const d = dec.data;
  useEffect(() => { setPoll(d && ['approved', 'executing'].includes(d.effectiveStatus) ? 4000 : 0); }, [d?.effectiveStatus]); // eslint-disable-line
  const now = useNow(1000);
  const run = useApi(d?.run_id ? `/api/runs/${d.run_id}` : '', { enabled: Boolean(d?.run_id) });
  const dossierMeta = run.data?.artifacts?.find((a) => a.kind === 'security-dossier'); const briefMeta = run.data?.artifacts?.find((a) => a.kind === 'brief');
  const dossier = useApi(dossierMeta ? `/api/artifacts/${dossierMeta.id}` : '', { enabled: Boolean(dossierMeta) });
  const brief = useApi(briefMeta ? `/api/artifacts/${briefMeta.id}` : '', { enabled: Boolean(briefMeta) });
  const sec = useApi('/api/security', { poll: 20000 });
  const arts = useApi('/api/artifacts');
  const deps = useApi('/api/deployments', { poll: d?.effectiveStatus === 'executed' ? 15000 : 0 });
  const [hashCheck, setHashCheck] = useState(null);
  useEffect(() => { if (d) sha256Text(JSON.stringify(d.payload)).then((h) => setHashCheck(h === d.payload_hash)); }, [d]);

  if (dec.loading) return <div className="page"><SkeletonRows n={6} /></div>;
  if (dec.error?.status === 404) return <div className="page"><Empty title="Decision not found" action={<a className="btn" href="#/approval">All decisions</a>}>No decision with id {id}.</Empty></div>;
  if (dec.error && !d) return <div className="page"><ErrorPanel error={dec.error} onRetry={dec.reload} what="the decision" /></div>;

  const p = d.payload ?? {}; const reg = p.registry ?? {}; const proto = protoOf(d);
  const st = d.effectiveStatus; const paused = status.data?.paused;
  const expired = st === 'expired';
  const stepIdx = st === 'pending' || expired ? 0 : st === 'approved' || st === 'executing' ? 2 : st === 'executed' ? 3 : 1;
  const myDeps = (deps.data?.items ?? []).filter((x) => x.decision_id === d.id);
  const deployment = d.deployment ?? myDeps[0] ?? null;
  const reload = () => { dec.reload(); deps.reload(); sec.reload(); };

  // policy checks, evaluated in this browser against the limits the server publishes (the server re-checks at approve)
  const lim = sec.data?.decisionLimits;
  const policy = lim ? [
    { name: 'action is enabled in this build', ok: lim.allowedActions.includes(d.action), detail: `${d.action} (enabled: ${lim.allowedActions.join(', ')})` },
    { name: 'network is allowlisted, mainnet blocked', ok: lim.allowedNetworks.includes(d.chain_id), detail: d.chain_id },
    { name: `expiry within ${Math.round(lim.maxExpiryMs / 864e5)} days`, ok: d.expiry - Date.now() <= lim.maxExpiryMs, detail: `${countdown(d.expiry, now)} remaining` },
    { name: 'max spend does not exceed the ceiling', ok: (() => { try { return BigInt(d.max_spend) <= BigInt(lim.maxSpendCeiling); } catch { return false; } })(), detail: `${d.max_spend} vs ceiling ${lim.maxSpendCeiling}` },
    { name: 'payload hash recomputed in this browser matches', ok: hashCheck === true, detail: hashCheck == null ? 'computing…' : fmt.short(d.payload_hash, 12) },
    { name: 'artifact hash is an attested contract build', ok: (arts.data?.items ?? []).some((a) => a.hash === d.artifact_hash && a.kind.startsWith('contract-build:')), detail: fmt.short(d.artifact_hash, 12) },
    { name: 'kill switch is not engaged', ok: !paused, detail: paused ? 'ENGAGED: approval is blocked' : 'released' },
  ] : [];

  const checks = dossier.data?.content?.output?.checks ?? [];
  const unresolved = dossier.data?.content?.output?.unresolved ?? [];
  const threats = (brief.data?.content?.threatModel ?? []).filter((t) => !/^mitigated/.test(t.status));
  const quoteMode = brief.data?.content?.treasuryRehearsal?.mode;

  return (
    <div className="page">
      <PageHead eyebrow={<><a href="#/approval" className="rh-back">Approval</a> / {d.id}</>} title={cap(d.action).replace(/^./, (c) => c.toUpperCase())} em={`on ${d.chain_id}`} aside={<Status state={st} />}>
        <span className="faint mono-v">{d.run_id && <a href={`#/run/${d.run_id}`}>run {d.run_id}</a>} · created {fmt.date(d.created_at)}</span>
      </PageHead>

      <Stepper idx={stepIdx} st={st} />

      <div className="grid" style={{ marginTop: 24 }}>
        <div className="span-8 stack" style={{ alignContent: 'start' }}>
          {(st === 'approved' || st === 'executing') && <SignPanel d={d} proto={proto} token={token} reload={reload} />}
          {(st === 'executed' || deployment) && <Monitoring d={d} deployment={deployment} />}

          <Panel title="The exact action you are authorizing" tone={st === 'pending' ? 'live' : ''}>
            <KV rows={[
              ['Action', <b key="a">{d.action}</b>],
              ['Network', <span key="n">{p.networkLabel ?? '–'} <span className="mono-v faint">({d.chain_id})</span></span>],
              ['Artifact hash', <Full key="h" v={d.artifact_hash} copy />],
              ['Commit', <span key="c" className="mono-v">{p.commitSha ?? 'not recorded'}</span>],
              ['Registry owner', <Full key="o" v={reg.owner} />],
              ['Registry proposer', <Full key="pr" v={reg.proposer} />],
              proto === 'near' ? ['Contract account', <Full key="ca" v={reg.contractAccount} />] : null,
              ['Max spend cap', <span key="ms" className="mono-v">{reg.maxSpendCap ?? '0'} <span className="faint">(registry never holds funds)</span></span>],
              ['Max spend (decision)', <span key="md" className="mono-v">{d.max_spend}</span>],
              ['Allowlist', reg.allowlist?.length ? <ul key="al" className="st-ul">{reg.allowlist.map((a) => <li key={a.target + a.method} className="mono-v">{a.target}.{a.method} <span className="faint">{a.note}</span></li>)}</ul> : <span key="al">empty</span>],
              ['Estimated cost', p.estimatedCost ? <span key="ec" className="mono-v">{p.estimatedCost.amount} {p.estimatedCost.unit} <span className="faint">({p.estimatedCost.kind}: {p.estimatedCost.basis})</span></span> : '–'],
              ['Expires', <span key="ex"><span className="mono-v">{fmt.date(d.expiry)}</span> · <b className={`ap-cd ${expired ? 'bad' : ''}`} data-testid="countdown">{st === 'pending' ? countdown(d.expiry, now) : expired ? 'expired' : 'n/a (decided)'}</b></span>],
              ['Nonce', <Full key="nc" v={d.nonce} copy />],
              ['Payload hash', <Full key="ph" v={d.payload_hash} copy />],
              ['Bound signer', d.bound_signer ? <Full key="bs" v={d.bound_signer} /> : <span key="bs" className="faint">not bound yet: set when you approve</span>],
              ['Brief hash', <Full key="bh" v={p.briefHash} />],
            ].filter(Boolean)} />
          </Panel>

          <Panel title="Rollback path"><p style={{ margin: 0 }}>{p.rollback ?? 'No rollback path recorded.'}</p></Panel>

          <Panel title={`Policy checks · ${policy.filter((c) => c.ok).length}/${policy.length} pass`} aside={sec.loading ? <span className="faint">loading…</span> : null}>
            {sec.error && !sec.data ? <ErrorPanel error={sec.error} onRetry={sec.reload} what="decision limits" /> : <Checks items={policy} />}
            <p className="help" style={{ marginBottom: 0 }}>Evaluated here against the limits published by /api/security. The server repeats every check when you approve.</p>
          </Panel>

          <Panel title={`Automated security checks · ${checks.filter((c) => c.ok).length}/${checks.length} pass`} aside={<Chip tone="bad">independent audit: none</Chip>}>
            {dossier.loading && <SkeletonRows n={3} />}
            {!dossierMeta && !run.loading && <p className="faint">No security dossier is attached to this decision's run.</p>}
            {checks.length > 0 && <details className="ap-det" open={checks.some((c) => !c.ok)}><summary>{checks.some((c) => !c.ok) ? `${checks.filter((c) => !c.ok).length} check(s) FAILED: show all` : 'Show all automated checks'}</summary><Checks items={checks} /></details>}
            <p className="help" style={{ marginBottom: 0 }}>These are automated checks over this run's artifacts, not an audit. <a href={`#/studio/${d.run_id}?tab=security`}>Open the full dossier</a>.</p>
          </Panel>

          <Panel title="Risks you are accepting">
            <ul className="st-ul ap-risks">
              {unresolved.map((u) => <li key={u}>{u}</li>)}
              {threats.map((t) => <li key={t.threat}><b>{t.threat}</b> <Chip tone="warn">{t.status}</Chip> <span className="dim">{t.mitigation}</span></li>)}
              {quoteMode && quoteMode !== 'live' && <li>Treasury quotes in the brief are <b>synthetic fixtures</b>, not market quotes.</li>}
              {!unresolved.length && !threats.length && !(quoteMode && quoteMode !== 'live') && <li className="faint">No risk list could be loaded for this decision's run.</li>}
            </ul>
          </Panel>

          <AuditTrail d={d} q={sec} />
        </div>

        <aside className="span-4 stack ap-aside" aria-label="Decision controls">
          <ApprovePanel d={d} proto={proto} token={token} paused={paused} expired={expired} reload={reload} toast={toast} policyOk={policy.length > 0 && policy.every((c) => c.ok)} />
        </aside>
      </div>
    </div>
  );
}

function Stepper({ idx, st }) {
  const steps = ['Review', 'Approve', 'Sign it yourself', 'Verified on-chain'];
  const dead = st === 'rejected' || st === 'expired';
  return (
    <ol className="ap-steps" aria-label="Decision progress">
      {steps.map((s, i) => (
        <li key={s} className={dead ? (i === 0 ? 'cur' : '') : i < idx ? 'done' : i === idx ? 'cur' : ''} aria-current={!dead && i === idx ? 'step' : undefined}>
          <span className="ap-step-n">{!dead && i < idx ? <Icon name="check" size={14} /> : i + 1}</span><span>{s}</span>
        </li>
      ))}
      {dead && <li className="dead"><span className="ap-step-n"><Icon name="x" size={14} /></span><span>{st === 'expired' ? 'Expired: nothing was authorized' : 'Rejected: nothing was authorized'}</span></li>}
    </ol>
  );
}

/* =============================== approve / reject =============================== */
function ApprovePanel({ d, proto, token, paused, expired, reload, toast, policyOk }) {
  const [confirm, setConfirm] = useState(''); const [ack, setAck] = useState(false); const [signer, setSigner] = useState('');
  const [dlg, setDlg] = useState(false); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState(''); const [rej, setRej] = useState(false);
  const st = d.effectiveStatus;
  const phraseOk = confirm === d.confirmPhrase;
  const signerOk = SIGNER_RE[proto]?.test(signer.trim()) && signer.trim().length <= 64;
  const reg = d.payload?.registry ?? {};
  const why = expired ? 'This decision has expired.' : paused ? 'Kill switch engaged: approvals are blocked.' : null;
  const canOpen = phraseOk && ack && signerOk && !why;

  const fromWallet = async () => {
    try { const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' }); setSigner(a); setErr(null); } catch (e) { setErr(e.message ?? 'Wallet request failed'); }
  };
  const approve = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm, signer: signer.trim() } }); setDlg(false); toast('Approved. Nothing has been deployed: sign it yourself next.'); reload(); }
    catch (e) { setErr(e.message); setDlg(false); } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/decisions/${d.id}/reject`, { method: 'POST', body: { reason: reason.trim() } }); toast('Decision rejected'); setRej(false); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (st === 'executed') return <Panel title="Decision closed" tone="live"><p style={{ margin: 0 }}>Executed and verified. Bound signer <span className="mono-v">{fmt.short(d.bound_signer, 8)}</span>. Approved by {d.approver ?? '–'} {fmt.ago(d.decided_at)}.</p></Panel>;
  if (st === 'rejected' || st === 'expired') return <Panel title="Decision closed" tone="risk"><p style={{ margin: 0 }}>{st === 'expired' ? 'This decision expired before it was approved. A new run is needed to propose again.' : `Rejected by ${d.approver ?? 'operator'} ${fmt.ago(d.decided_at)}.`}</p></Panel>;

  return (
    <Panel title={st === 'pending' ? 'Approve or reject' : 'Withdraw'} tone={st === 'pending' ? 'live' : ''}>
      <NeedsOperator token={token} hint="Operator token required to approve or reject">
        <div className="stack">
          {st === 'pending' && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (canOpen) setDlg(true); }} noValidate>
              <div className="banner warn"><Icon name="alert" /><div><b>Approval is not execution.</b> It records your authorization for exactly the payload above. You then sign the deployment yourself, and it is recorded only after on-chain verification.</div></div>
              <div className="field">
                <label htmlFor="signer">{proto === 'near' ? 'NEAR account that will sign' : 'EVM address that will sign'}</label>
                <input id="signer" className="input mono-i" value={signer} onChange={(e) => setSigner(e.target.value)} autoComplete="off" spellCheck={false} placeholder={proto === 'near' ? 'deployer.testnet' : '0x…'} aria-invalid={signer !== '' && !signerOk} aria-describedby="signer-h" />
                <span id="signer-h" className={signer && !signerOk ? 'err-t' : 'help'}>{signer && !signerOk ? `Not a valid ${proto === 'near' ? 'NEAR account id' : 'EVM address (0x + 40 hex)'}.` : 'Bound to this decision. Only a deployment from this signer will verify.'}</span>
                <div className="row">
                  {reg.owner && <button type="button" className="btn sm" onClick={() => setSigner(reg.owner)}>Use registry owner</button>}
                  {proto === 'evm' && typeof window !== 'undefined' && window.ethereum && <button type="button" className="btn sm" onClick={fromWallet}><Icon name="wallet" size={14} />Fill from browser wallet</button>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="phrase">Type the confirmation phrase</label>
                <div className="ap-phrase mono-v" aria-hidden="true">{d.confirmPhrase}</div>
                <input id="phrase" className="input mono-i" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="phrase-h" aria-invalid={confirm !== '' && !phraseOk} />
                <span id="phrase-h" className={confirm && !phraseOk ? 'err-t' : 'help'}>{confirm && !phraseOk ? 'Does not match yet.' : 'The exact phrase is shown above; pasting is allowed, but read it first.'}</span>
              </div>
              <label className="ap-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I understand that approving does not execute anything, that I will sign the transaction myself, and that this is a testnet-only action.</span></label>
              {why && <p className="err-t" role="alert">{why}</p>}
              {!policyOk && <p className="help" style={{ margin: 0 }}>One or more policy checks above did not pass or are still loading; the server will refuse an out-of-policy approval.</p>}
              <button className="btn primary" type="submit" disabled={!canOpen}>Review final confirmation</button>
            </form>
          )}
          {err && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>The API refused this</b><div className="mono-v rt-verbatim">{err}</div></div></div>}
          <div className="stack-s">
            <button className="btn danger" onClick={() => setRej((r) => !r)} aria-expanded={rej}>{st === 'approved' ? 'Withdraw approval (reject)' : 'Reject this decision'}</button>
            {rej && (
              <div className="field"><label htmlFor="reason">Reason (optional, recorded in the audit trail)</label>
                <input id="reason" className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                <div><button className="btn danger" onClick={reject} disabled={busy}>{busy ? 'Rejecting…' : 'Confirm rejection'}</button></div></div>
            )}
          </div>
        </div>
      </NeedsOperator>
      {dlg && (
        <Dialog title="Final confirmation" onClose={() => setDlg(false)}>
          <div className="stack">
            <p className="dim" style={{ margin: 0 }}>You are authorizing one testnet action. <b>Nothing is deployed by this click.</b></p>
            <KV rows={[['Action', d.action], ['Network', d.payload?.networkLabel ?? d.chain_id], ['Artifact', <span key="a" className="mono-v">{fmt.short(d.artifact_hash, 12)}</span>], ['Bound signer', <span key="s" className="mono-v" style={{ overflowWrap: 'anywhere' }}>{signer.trim()}</span>], ['Max spend', d.max_spend]]} />
            <div className="row"><button className="btn primary" onClick={approve} disabled={busy}>{busy ? 'Approving…' : 'Approve decision'}</button><button className="btn" onClick={() => setDlg(false)}>Go back</button></div>
          </div>
        </Dialog>
      )}
    </Panel>
  );
}

/* =============================== step 3: sign =============================== */
// Env names are those documented in scripts/near-deploy.sh (read when this view was written). The script only PRINTS the near-cli-rs
// command; it signs and sends nothing. MAX_SPEND_CAP is deliberately omitted: the script requires a positive integer, the payload says '0'.
function nearEnv(d) {
  const r = d.payload?.registry ?? {}; const net = d.chain_id === 'near-testnet' ? 'testnet' : d.chain_id;
  return [`NEAR_NETWORK=${net}`, `NEAR_DEPLOY_ACCOUNT=${r.contractAccount ?? '<contract account missing in payload>'}`, `OWNER_ID=${r.owner ?? ''}`, `PROPOSER_ID=${r.proposer ?? ''}`].join(' \\\n  ') + ' \\\n  bash scripts/near-deploy.sh';
}

function SignPanel({ d, proto, token, reload }) {
  const [rc, setRc] = useState({ busy: false, result: null, error: null });
  const [tx, setTx] = useState('');
  const submit = async (txHash) => {
    setRc({ busy: true, result: null, error: null });
    try { const r = await api(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash: txHash.trim() } }); setRc({ busy: false, result: r, error: null }); if (r.recorded) reload(); }
    catch (e) { setRc({ busy: false, result: null, error: e }); }
  };
  const evmHash = useMemo(() => (hash) => submit(hash), [d.id]); // eslint-disable-line
  const executing = d.effectiveStatus === 'executing';
  return (
    <Panel title="Step 3 · Sign it yourself" tone="live" aside={<Chip tone="mineral">you sign, we verify</Chip>}>
      <div className="stack">
        <p className="dim" style={{ margin: 0 }}>This decision is approved but <b>not executed</b>. AutoNEAR holds no wallet key. Deploy with your own key, then the API checks the chain and records the deployment only if every check passes. Bound signer: <span className="mono-v">{d.bound_signer}</span>.</p>
        {executing && <div className="banner" role="status"><Icon name="clock" /><div>The API is recording a verified deployment right now (status "executing"). This clears on its own.</div></div>}
        {!token ? <NeedsOperator token={token} hint="Operator token required to sign and record" /> : proto === 'evm' ? (
          <Suspense fallback={<SkeletonRows n={3} />}><WalletPanel decision={d} token={token} onHash={evmHash} receiptBusy={rc.busy} /></Suspense>
        ) : (
          <div className="stack-s">
            <div className="eyebrow">Run this on your machine</div>
            <ol className="st-ul ap-near-steps">
              <li>Build the wasm if you have not: <span className="mono-v">scripts/near-build.sh</span>. Its sha256 must equal the artifact hash <span className="mono-v">{fmt.short(d.artifact_hash, 10)}</span>.</li>
              <li>Run this to <b>print</b> the deploy command (it holds no keys and sends nothing):</li>
            </ol>
            <pre className="code" tabIndex={0} aria-label="Environment for scripts/near-deploy.sh">{nearEnv(d)}</pre>
            <CopyButton text={nearEnv(d)} label="Copy command" />
            <ol className="st-ul ap-near-steps" start={3}>
              <li>Review the printed near-cli-rs command, then run it yourself and sign with the key of <span className="mono-v">{d.bound_signer}</span> (the signer bound at approval).</li>
              <li>Paste the resulting transaction hash below.</li>
            </ol>
            <p className="help" style={{ margin: 0 }}>The API compares the on-chain code hash to the attested wasm and refuses a deployment to any account other than <span className="mono-v">{d.payload?.registry?.contractAccount ?? 'the contract account in the payload'}</span> or from any other signer.</p>
          </div>
        )}
        {token && (
          <form className="stack-s ap-tx" onSubmit={(e) => { e.preventDefault(); submit(tx); }}>
            <h3 className="wp-h" style={{ margin: 0 }}>{proto === 'evm' ? 'Signed elsewhere? Paste the transaction hash' : 'Paste the transaction hash'}</h3>
            <div className="field"><label htmlFor="txh">Transaction hash</label>
              <input id="txh" className="input mono-i" value={tx} onChange={(e) => setTx(e.target.value)} autoComplete="off" spellCheck={false} placeholder={proto === 'evm' ? '0x… (64 hex)' : 'base58 transaction hash'} /></div>
            <div><button className="btn primary" type="submit" disabled={!tx.trim() || rc.busy}>{rc.busy ? 'Verifying on-chain…' : 'Verify and record'}</button></div>
          </form>
        )}
        <Receipt rc={rc} />
      </div>
    </Panel>
  );
}

function Receipt({ rc }) {
  if (rc.busy) return <p className="faint" role="status">Asking the API to verify the transaction against the chain RPC…</p>;
  if (rc.error) return <div className="banner risk" role="alert"><Icon name="alert" /><div><b>Not recorded</b><div className="mono-v rt-verbatim">{rc.error.message}{rc.error.status ? ` (HTTP ${rc.error.status})` : ''}</div>{rc.error.status >= 500 && <div className="help">The API could not complete verification (for example the chain RPC was unreachable or did not know this transaction). Nothing was recorded; check the hash and network, then try again.</div>}</div></div>;
  const r = rc.result; if (!r) return null;
  return (
    <div className="stack-s" role="status">
      <div className={`banner ${r.recorded ? 'ok' : 'risk'}`}><Icon name={r.recorded ? 'check' : 'alert'} /><div><b>{r.recorded ? 'Verified and recorded' : 'Verification FAILED: nothing was recorded'}</b>{r.recorded && r.deployment && <div className="mono-v">{r.deployment.account}{r.deployment.explorer && <> · <a href={r.deployment.explorer} target="_blank" rel="noreferrer noopener">explorer<span className="sr"> (opens in a new tab)</span></a></>}</div>}</div></div>
      <Checks items={r.verification?.checks ?? []} empty="The verifier returned no checks." />
    </div>
  );
}

/* =============================== step 4: monitoring =============================== */
function Monitoring({ d, deployment }) {
  const v = deployment?.verification ?? {};
  return (
    <Panel title="Deployment record" tone="live" aside={deployment ? <Status state={deployment.status === 'verified_local' ? 'verified' : deployment.status} /> : null}>
      {!deployment ? <Empty title="No deployment recorded">A deployment appears here only after its transaction passes on-chain verification.</Empty> : (
        <div className="stack">
          {deployment.status === 'verified_local' && <div className="banner warn"><Icon name="alert" /><div>Verified against a <b>local</b> chain, not a public network.</div></div>}
          <KV rows={[
            ['Network', <span key="n" className="mono-v">{deployment.network}</span>],
            [protoOf(d) === 'near' ? 'Account' : 'Contract address', <Full key="a" v={deployment.account} copy />],
            ['Transaction', <Full key="t" v={deployment.transaction_hash} copy />],
            ['Artifact hash', <Full key="h" v={deployment.artifact_hash} />],
            ['Recorded', <span key="r" className="mono-v">{fmt.date(deployment.time)}</span>],
            ['Explorer', deployment.explorer_url ? <a key="e" href={deployment.explorer_url} target="_blank" rel="noreferrer noopener">{deployment.explorer_url}<span className="sr"> (opens in a new tab)</span></a> : <span key="e" className="faint">none for this network</span>],
          ]} />
          <div className="eyebrow">Verification checks{v.observedAt ? ` · observed ${fmt.date(v.observedAt)}` : ''}</div>
          <Checks items={v.checks ?? []} empty="No verification checks stored." />
          <p className="help" style={{ margin: 0 }}>The registry is attestation-only: it holds no funds and executes nothing. Its on-chain code was compared byte-for-byte to the attested build.</p>
        </div>
      )}
    </Panel>
  );
}

/* =============================== audit trail =============================== */
function AuditTrail({ d, q }) {
  const rows = (q.data?.audit ?? []).filter((a) => a.detail?.id === d.id || (d.run_id && a.detail?.id === d.run_id));
  return (
    <Panel title={`Audit trail · ${rows.length}`} pad={false} aside={q.data?.auditChain ? <Chip tone={q.data.auditChain.ok ? 'ok' : 'bad'}>{q.data.auditChain.ok ? 'audit chain intact' : 'audit chain BROKEN'}</Chip> : null}>
      {q.loading && <div style={{ padding: 16 }}><SkeletonRows n={2} /></div>}
      {q.error && !q.data && <div style={{ padding: 16 }}><ErrorPanel error={q.error} onRetry={q.reload} what="the audit log" /></div>}
      {q.data && !rows.length && <Empty title="No entries for this decision yet">Entries appear when it is approved, rejected, or a deployment is verified or refused.</Empty>}
      {rows.length > 0 && (
        <ol className="ap-audit">
          {rows.map((a) => (
            <li key={a.id}>
              <span className="mono-v faint">{fmt.date(a.time)}</span>
              <b className="mono-v">{a.action}</b>
              <span className="mono-v faint">by {a.actor}</span>
              <span className="mono-v ap-audit-d">{Object.entries(a.detail ?? {}).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</span>
              <span className="mono-v faint" title={a.hash}>#{a.id} {fmt.short(a.hash, 6)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="help" style={{ margin: 0, padding: '8px 16px 12px' }}>From the most recent 40 audit entries exposed by /api/security.</p>
    </Panel>
  );
}
