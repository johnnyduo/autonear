// Grant flow for ONE grant_mandate decision: 1 review + typed approval, 2 human signing, 3 server verification.
// Every state below comes from API data (decision, plan, vault read) or from comparisons computed in this browser over that data.
// Nothing simulates a signature or a success.
import { lazy, Suspense, useMemo } from 'react';
import { api, useApi } from '../../api.js';
import { ApproverBadge, Chip, Empty, ErrorPanel, Icon, NeedsOperator, Panel, SkeletonRows, Status, useToast } from '../../ui.jsx';
import { ApprovePanel } from '../Approval.jsx';
import { Checks, CopyButton, KV, PageHead, cap } from '../_run-parts.jsx';
import GrantSummary from './GrantSummary.jsx';
import { Amt } from './parts.jsx';
import { checkTx, coverage, decodeCall } from './decode.js';
import { chainMeta, normChain, protoOfChain, secsLabel, toBig, toSec, when } from './format.js';

const TxSender = lazy(() => import('../../wallet/TxSender.jsx'));
const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const neq = (a, b) => { const x = toBig(a); const y = toBig(b); return x !== null && y !== null && x === y; };

/** Field-by-field: what the human approved vs what the server read from the chain. */
export function compareMandate(vault, d) {
  const p = d.payload ?? {}; const m = p.mandate ?? {}; const rows = [];
  const add = (name, ok, approved, onchain) => rows.push({ name, ok, approved: String(approved ?? '–'), onchain: String(onchain ?? '–') });
  if (!vault) return { rows, vault: null };
  const c = vault.mandate;
  add('vault is attached and code matches the attested build', vault.codeOk === true, 'codeOk: true', `codeOk: ${vault.codeOk}`);
  add('vault is not paused', !vault.paused, 'running', vault.paused ? 'paused' : 'running');
  add('owner', eq(vault.owner, p.vault?.owner), p.vault?.owner, vault.owner);
  add('a mandate is set and not revoked', Boolean(c) && !c.revoked, 'set, active', c ? (c.revoked ? 'revoked' : 'set') : 'none');
  add('agent', eq(c?.agent, p.agent?.address ?? p.agent?.account), p.agent?.address ?? p.agent?.account, c?.agent);
  add('expiry', c ? toSec(c.expiresAt) === toSec(m.expiresAt) : false, when(m.expiresAt), c ? when(c.expiresAt) : '–');
  for (const k of ['perDrawCap', 'periodCap', 'totalCap']) add(k, c ? neq(c[k], m[k]) : false, m[k], c?.[k]);
  add('period length', c ? neq(c.periodSecs, m.periodSecs) : false, `${m.periodSecs}s (${secsLabel(m.periodSecs)})`, c ? `${c.periodSecs}s` : '–');
  add('max deploys', c ? neq(c.maxDeploys, m.maxDeploys) : false, m.maxDeploys, c?.maxDeploys);
  for (const t of p.templates ?? []) { const on = (vault.templates ?? []).find((x) => eq(x.id, t.templateId)); add(`template "${t.label}"`, Boolean(on) && on.label === t.label && neq(on.deposit, t.deposit ?? 0), `${t.templateId}`, on ? on.id : 'not allowlisted'); }
  const extra = (vault.templates ?? []).filter((x) => !(p.templates ?? []).some((t) => eq(t.templateId, x.id)));
  add('no template outside the approved list is allowlisted', !extra.length, 'none extra', extra.length ? extra.map((x) => x.label).join(', ') : 'none extra');
  if (toBig(p.fund?.amount) > 0n) add('vault holds at least the approved funding', toBig(vault.available) >= toBig(p.fund.amount), `>= ${p.fund.amount}`, vault.available);
  return { rows, vault };
}

export default function Grant({ id, status, token, source, fixture }) {
  const toast = useToast();
  const live = !fixture;
  const dq = useApi(`/api/decisions/${id}`, { poll: 8000, enabled: live });
  const fxd = source.grant;
  const d = fixture ? fxd?.decision : dq.data;
  const st = d?.effectiveStatus;
  const wantPlan = live && d && !['pending', 'rejected', 'expired'].includes(st);
  const pq = useApi(`/api/vault/plan?decisionId=${id}`, { enabled: wantPlan });
  const plan = fixture ? fxd?.plan : pq.data;
  const vq = source.vault; const vaults = vq.data?.vaults ?? [];
  const reload = () => { dq.reload(); pq.reload(); vq.reload(); };

  const p = d?.payload ?? {}; const meta = chainMeta(d?.chain_id ?? p.vault?.chainId); const proto = protoOfChain(d?.chain_id ?? p.vault?.chainId);
  const vault = useMemo(() => vaults.find((v) => eq(v.address, p.vault?.address)), [vaults, p.vault?.address]); // eslint-disable-line
  const cmp = useMemo(() => (d && st && !['pending', 'rejected', 'expired'].includes(st) ? compareMandate(vault, d) : { rows: [], vault: null }), [vault, d, st]);
  const allOk = cmp.rows.length > 0 && cmp.rows.every((r) => r.ok);
  const activated = Boolean(vault) && vault.mandateDecisionId === id;
  const idx = !d ? 0 : st === 'pending' ? 0 : ['rejected', 'expired'].includes(st) ? 0 : activated && allOk ? 3 : 1;
  const unit = meta ? { symbol: meta.symbol, decimals: meta.decimals, base: meta.base } : null;

  if (live && dq.loading) return <div className="vt-sub"><SkeletonRows n={6} /></div>;
  if (live && dq.error?.status === 404) return <Empty title="Decision not found" action={<a className="btn" href="#/vault">Back to the vault</a>}>No decision with id {id}.</Empty>;
  if (live && dq.error && !d) return <ErrorPanel error={dq.error} onRetry={dq.reload} what="the grant decision" />;
  if (!d) return <div className="vt-sub"><SkeletonRows n={6} /></div>;
  if (d.action !== 'grant_mandate') return <Empty title="Not a mandate grant" action={<a className="btn" href={`#/approval/${id}`}>Open in the approval room</a>}>Decision {id} is a {cap(d.action)} decision. The grant flow only handles grant_mandate.</Empty>;

  return (
    <div className="vt-grant stack">
      <PageHead eyebrow={<><a href="#/vault" className="rh-back">Vault</a> / grant / {d.id}</>} title="Grant a mandate" em={`on ${meta?.short ?? d.chain_id}`} aside={<span className="row"><Status state={st} /><ApproverBadge approver={d.approver} /></span>}>
        <span className="faint">approval is not activation: you approve the payload, you sign it on-chain yourself, and the server turns the loop on only after it has read the chain</span>
      </PageHead>

      <ol className="ap-steps" aria-label="Grant progress">
        {['Review and approve', 'Sign on-chain yourself', 'Server verification'].map((s, i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''} aria-current={i === idx && idx < 3 ? 'step' : undefined}><span className="ap-step-n">{i < idx ? <Icon name="check" size={14} /> : i + 1}</span><span>{s}</span></li>
        ))}
        {['rejected', 'expired'].includes(st) && <li className="dead"><span className="ap-step-n"><Icon name="x" size={14} /></span><span>{st === 'expired' ? 'Expired: nothing was authorised' : 'Rejected: nothing was authorised'}</span></li>}
      </ol>

      <div className="grid">
        <div className="span-8 stack" style={{ alignContent: 'start' }}>
          <Panel title="Step 1 · Review exactly what you are authorising" tone={st === 'pending' ? 'live' : ''}>
            <GrantSummary payload={p} chainId={d.chain_id} />
            <p className="help" style={{ marginBottom: 0 }}>Payload hash <span className="mono-v">{d.payload_hash}</span> · nonce <span className="mono-v">{d.nonce}</span>. The full policy checks and audit trail are on the <a href={`#/approval/${d.id}`}>decision page</a>.</p>
          </Panel>

          <Panel title="Step 2 · Sign the on-chain mandate yourself" tone={st === 'approved' && !allOk ? 'live' : ''} aside={<Chip tone="mineral">you sign, the agent cannot</Chip>}>
            {st === 'pending' && <Empty title="Locked until you approve">Approve the decision in step 1. The exact transactions to sign appear here only for an approved decision.</Empty>}
            {['rejected', 'expired'].includes(st) && <Empty title="Nothing to sign">This decision is {st}.</Empty>}
            {wantPlan && pq.loading && <SkeletonRows n={3} />}
            {wantPlan && pq.error && !plan && <ErrorPanel error={pq.error} onRetry={pq.reload} what="the signing plan" />}
            {Boolean(plan) && (!fixture || !['pending', 'rejected', 'expired'].includes(st)) && <PlanView plan={plan} d={d} proto={proto} unit={unit} fixture={fixture} token={token} />}
          </Panel>

          <Panel title="Step 3 · Server verification" tone={activated && allOk ? 'live' : ''} aside={vault ? <span className="mono-v faint">read {when(vault.readAt)}</span> : null}>
            {['pending', 'rejected', 'expired'].includes(st) ? <Empty title="Not started">Verification begins once the decision is approved and you have signed.</Empty> : (
              <Verify cmp={cmp} d={d} vault={vault} activated={activated} allOk={allOk} source={source} fixture={fixture} token={token} onChanged={reload} toast={toast} />
            )}
          </Panel>
        </div>
        <aside className="span-4 stack ap-aside" aria-label="Decision controls">
          <ApprovePanel d={d} proto={proto} token={fixture ? 'fixture' : token} paused={status?.data?.paused} expired={st === 'expired'} reload={reload} toast={toast} />
          <Panel title="Who does what">
            <ul className="vt-who">
              <li><Chip tone="ok"><Icon name="user" size={13} />human</Chip><span>approves the payload, signs the mandate, funds the vault</span></li>
              <li><Chip tone="mandate"><Icon name="bot" size={13} />agent</Chip><span>after activation: draws gas and deploys listed templates only</span></li>
              <li><Chip tone="mineral"><Icon name="check" size={13} />server</Chip><span>reads the chain, compares it to what you approved, enables the loop</span></li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- step 2 ---------------- */
function PlanView({ plan, d, proto, unit, fixture, token }) {
  const steps = plan?.steps ?? [];
  const chainNumeric = proto === 'evm' ? Number(String(normChain(d.chain_id)).replace('evm:', '')) : null;
  const rows = steps.map((s, i) => {
    if (!s.tx) return { s, i };
    const decoded = decodeCall(s.tx.data, s.tx.value, unit ?? { symbol: 'units', decimals: 0, base: 'base units' });
    return { s, i, decoded, checks: checkTx(s.tx, decoded, d.payload, chainNumeric) };
  });
  const txRows = rows.filter((r) => r.decoded);
  const cover = proto === 'evm' && unit ? coverage(txRows, d.payload, unit) : [];
  const allChecks = [...txRows.flatMap((r) => r.checks), ...cover];
  const safe = txRows.length > 0 && allChecks.every((c) => c.ok);
  if (!steps.length) return <Empty title="The plan has no steps">The API returned an empty signing plan for this decision.</Empty>;
  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>These are the exact steps the API built for this decision. For EVM, each calldata is decoded and compared with the approved decision <b>in your browser</b> before the send button is enabled.</p>
      <ol className="vt-plan">
        {rows.map(({ s, i, decoded, checks }) => (
          <li key={i} className={`vt-ps ${s.who}`}>
            <div className="vt-ps-h"><span className="vt-ps-n">{i + 1}</span><b>{s.title}</b><Chip tone={s.who === 'human' ? 'ok' : s.who === 'agent' ? 'mandate' : 'mineral'}><Icon name={s.who === 'human' ? 'user' : s.who === 'agent' ? 'bot' : 'check'} size={13} />{s.who}</Chip></div>
            {s.note && <p className="dim vt-ps-note">{s.note}</p>}
            {s.tx && <TxCard tx={s.tx} decoded={decoded} checks={checks} fixture={fixture} />}
            {s.cli && (
              <div className="stack-s">
                <div className="eyebrow">Run this on your machine, then review before you sign</div>
                <pre className="code" tabIndex={0} aria-label={`Command for step ${i + 1}`}>{s.cli}</pre>
                <div><CopyButton text={s.cli} label="Copy command" /></div>
                <p className="help" style={{ margin: 0 }}>Compare the vault, agent, caps, expiry and templates in this command with the table in step 1. The server will refuse to activate anything that differs.</p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {proto === 'evm' && (
        <section className="vt-send" aria-label="Sign in your wallet">
          <h3 className="wp-h"><span className="wp-n">A</span> Cross-check against the approved decision · {allChecks.filter((c) => c.ok).length}/{allChecks.length} pass</h3>
          <Checks items={cover} empty="Nothing to cover." />
          {!safe && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>Do not sign.</b> At least one transaction differs from, or is not part of, the decision you approved. Sending is disabled.</div></div>}
          <h3 className="wp-h"><span className="wp-n">B</span> Sign in your own wallet</h3>
          {fixture
            ? <div className="banner warn" role="note"><Icon name="alert" /><div><b>Fixture mode:</b> the wallet layer is not loaded and nothing can be sent. These transactions are placeholders.</div></div>
            : <Suspense fallback={<SkeletonRows n={2} />}><TxSender txs={txRows.map((r) => ({ key: r.i, title: r.s.title, tx: r.s.tx, ok: r.checks.every((c) => c.ok) && safe }))} decision={d} /></Suspense>}
        </section>
      )}
    </div>
  );
}

function TxCard({ tx, decoded, checks }) {
  return (
    <div className="vt-tx">
      <div className="vt-tx-w" role="note"><span className="eyebrow">What this does, in words</span><p className={decoded.ok ? '' : 'err-t'}>{decoded.words}</p></div>
      <details className="vt-raw" open={checks.some((c) => !c.ok)}><summary>Cross-check with the approved decision · {checks.filter((c) => c.ok).length}/{checks.length} pass</summary><Checks items={checks} /></details>
      <details className="vt-raw"><summary>Raw transaction · {decoded.name}</summary>
        {decoded.sig && <p className="mono-v faint" style={{ margin: '4px 0' }}>{decoded.sig}</p>}
        <KV rows={[['to', <span key="t" className="mono-v">{tx.to}</span>], ['chainId', <span key="c" className="mono-v">{tx.chainId}</span>], ['value', <span key="v" className="mono-v">{tx.value ?? '0'}</span>]]} />
        <pre className="code" tabIndex={0} aria-label="Raw calldata">{tx.data || '0x'}</pre>
        <CopyButton text={tx.data || '0x'} label="Copy calldata" />
      </details>
    </div>
  );
}

/* ---------------- step 3 ---------------- */
function Verify({ cmp, d, vault, activated, allOk, source, fixture, token, onChanged, toast }) {
  const attach = async () => {
    try { await api('/api/vault/attach', { method: 'POST', body: { chainId: d.chain_id, address: d.payload?.vault?.address } }); toast('Vault attached: the server verified its code and config'); onChanged(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  if (!vault) return (
    <div className="stack">
      <div className="banner warn" role="status"><Icon name="alert" /><div><b>The server does not know this vault yet.</b> It has to verify the vault's code and config on-chain before it will read a mandate from it.</div></div>
      <NeedsOperator token={fixture ? '' : token} hint={fixture ? 'Disabled in fixture mode' : 'Operator token required to attach'}><button className="btn primary" onClick={attach}><Icon name="vault" size={16} />Attach vault {String(d.payload?.vault?.address).slice(0, 10)}…</button></NeedsOperator>
    </div>
  );
  return (
    <div className="stack" aria-live="polite">
      <div className={`banner ${activated && allOk ? 'ok' : allOk ? 'warn' : 'risk'}`} role="status">
        <Icon name={activated && allOk ? 'check' : 'alert'} />
        <div><b>{allOk ? 'On-chain state equals the approved mandate: yes' : 'On-chain state equals the approved mandate: NO'}</b>
          <div className="dim">{activated && allOk ? 'The server linked this decision to the vault. The loop may act on it.' : allOk ? 'Every field matches. Waiting for the server to link the decision and enable the loop on its next tick.' : 'Fields that differ are listed below. Until every one matches, the loop will not act on this vault. This is not an error: it is the check doing its job.'}</div></div>
      </div>
      <div className="scroll-x"><table className="tbl vt-cmp"><thead><tr><th scope="col">Field</th><th scope="col">Approved by you</th><th scope="col">On-chain (as read by the server)</th><th scope="col">Result</th></tr></thead>
        <tbody>{cmp.rows.map((r) => (
          <tr key={r.name} className={r.ok ? 'ok' : 'bad'}><th scope="row" className="vt-rowh">{r.name}</th><td className="mono-v">{r.approved}</td><td className="mono-v">{r.onchain}</td><td><span className={`vt-res ${r.ok ? 'ok' : 'bad'}`}><Icon name={r.ok ? 'check' : 'x'} size={14} />{r.ok ? 'match' : 'differs'}</span></td></tr>
        ))}</tbody></table></div>
      <p className="help" style={{ margin: 0 }}>Compared in this browser against the server's latest chain read of the vault ({when(vault.readAt)}); the page refreshes every few seconds. Server activation: <b>{activated ? 'linked to this decision' : 'not yet linked'}</b>{vault.readError ? ` · last read error: ${vault.readError}` : ''}.</p>
    </div>
  );
}
