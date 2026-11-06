// Vault page, "Payments": what the vault may pay, to whom, what is left, the recent payments, and the owner's "Pay someone" form.
// Shown only when the vault report has a `payouts` block (the payouts build). A vault without it never renders this component.
import { useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Icon, Meter } from '../ui.jsx';
import { secsLabel } from '../views/vault/format.js';
import { P, payError, pfill } from './copy.js';
import { href } from './nav.js';
import { payBody, payFormOff, paymentRows, shortAccount, tokenView, validatePay } from './pay.js';

const tone = (f) => (f > 0.9 ? 'risk' : f > 0.7 ? 'warn' : '');
const Acct = ({ a }) => <span className="acct" title={a}>{shortAccount(a)}</span>;

function Limits({ tv, periodSecs }) {
  const row = (label, lim, bar) => (
    <li>
      <span>{label}</span>
      {lim && <span className="faint">{lim.none ? P.leftNone : pfill(P.left, { x: lim.left })}</span>}
      {lim && <Meter value={lim.frac} tone={tone(lim.frac)} label={bar} />}
    </li>
  );
  return (
    <ul className="lim pay-lim">
      <li><span>{P.atMost} <b>{tv.each.cap}</b> {P.eachPay}</span></li>
      {row(<>{P.atMost} <b>{tv.period.capShort}</b> {periodSecs ? <>{P.every} <b>{secsLabel(periodSecs)}</b></> : P.perPeriodFallback}</>, tv.period, P.usedPeriod)}
      {row(<>{P.atMost} <b>{tv.total.capShort}</b> {P.inTotal}</>, tv.total, P.usedTotal)}
    </ul>
  );
}

export default function Payments({ v, data, owner, canWrite, demo, opts, toast, stopped }) {
  const tokens = useMemo(() => v.payouts.tokens.map(tokenView), [v.payouts]);
  const usable = tokens.filter((t) => t.usable);
  const rows = useMemo(() => paymentRows(data.payments, v), [data.payments, v]);
  const off = payFormOff({ owner, demo, vault: v, stopped });
  const formOn = canWrite && off === '';
  const [tokenId, setTokenId] = useState(''); const [payee, setPayee] = useState(''); const [amount, setAmount] = useState('');
  const [note, setNote] = useState(''); const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [sent, setSent] = useState(null);
  const tv = usable.find((t) => t.token === tokenId) ?? usable[0];
  const chk = validatePay({ tv, payee, amount, note, reference });
  const shown = touched ? chk.errors : {};
  const submit = async (e) => {
    e.preventDefault(); setTouched(true); setErr(''); setSent(null);
    if (!chk.ok || !formOn) return;
    setBusy(true);
    try {
      const r = await api('/api/payments', { method: 'POST', body: payBody({ vault: v, token: tv.token, payee, base: chk.base, note, reference }) });
      setSent({ again: r?.created === false }); setAmount(''); setNote(''); setReference(''); setTouched(false); data.reload();
    } catch (x) { setErr(payError(x, { maxPayment: tv?.maxPaymentText })); } finally { setBusy(false); }
  };
  const lock = off || ''; // '' = nothing to explain here; for a read-only wallet or the demo the page already shows its own sentence above
  return (
    <section className="card pay" aria-labelledby="pay-h">
      <div className="row sp"><h2 id="pay-h">{P.title}</h2><span className="chip mineral">{P.testToken}</span></div>
      <p>{P.intro}{data.autonomy?.mode === 'auto' ? P.introAuto : ''}</p>
      {tokens.map((tk) => (
        <div className="pay-tok" key={tk.token}>
          <div className="row sp"><h3><span className="mono-v" title={tk.token}>{tk.symbol ?? shortAccount(tk.token)}</span></h3>
            <span className="pay-bal" title={tk.balanceExact ?? undefined}>{P.balance}: <b>{tk.balance ?? P.balanceUnknown}</b></span></div>
          {tk.usable ? <Limits tv={tk} periodSecs={v.mandate?.periodSecs} /> : <p className="faint">{P.notApproved}</p>}
        </div>
      ))}
      {!tokens.length && <p className="faint">{P.noTokens}</p>}
      <h3>{P.people}</h3>
      {v.payouts.payees.length ? <ul className="chips pay-people">{v.payouts.payees.map((p) => <li key={p.account}><span className="chip"><Acct a={p.account} /></span></li>)}</ul> : <p className="faint">{P.noPeople}</p>}

      <h3>{P.recent}</h3>
      {rows.length ? (
        <table className="tbl stack-sm">
          <thead><tr><th>{P.colWhen}</th><th>{P.colTo}</th><th>{P.colAmount}</th><th>{P.colNote}</th><th>{P.colState}</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td data-label={P.colWhen}>{fmt.ago(Number(r.when))}</td>
              <td data-label={P.colTo}><Acct a={r.payee} /></td>
              <td data-label={P.colAmount}><b>{r.amount}</b></td>
              <td data-label={P.colNote}>{r.note || '–'}</td>
              <td data-label={P.colState}><span className={`chip ${r.done ? 'ok' : r.status === 'pending' ? 'warn' : r.status === 'failed' || r.status === 'rejected' ? 'bad' : ''}`}>{r.state}</span>{r.link && <> <a href={r.link} target="_blank" rel="noreferrer noopener">{P.seeIt}</a></>}</td>
            </tr>))}</tbody>
        </table>
      ) : <p className="faint">{P.noRecent}</p>}

      <h3 id="pay-form-h">{P.formTitle}</h3>
      {lock && <p className="why"><Icon name="lock" size={14} />{lock}</p>}
      <form className="pay-form" onSubmit={submit} noValidate aria-labelledby="pay-form-h" aria-disabled={!formOn}>
        <p className="faint">{P.formHelp}</p>
        <div className="pay-grid">
          {usable.length > 1 && (
            <div className="field"><label htmlFor="pay-token">{P.fToken}</label>
              <select id="pay-token" className="select" value={tv?.token ?? ''} onChange={(e) => setTokenId(e.target.value)} disabled={!formOn}>{usable.map((t) => <option key={t.token} value={t.token}>{t.symbol}</option>)}</select></div>
          )}
          <div className="field"><label htmlFor="pay-to">{P.fPayee}</label>
            <select id="pay-to" className="select" value={payee} onChange={(e) => setPayee(e.target.value)} disabled={!formOn} aria-invalid={Boolean(shown.payee)} aria-describedby={shown.payee ? 'pay-to-e' : undefined}>
              <option value="">{P.fPickPayee}</option>{v.payouts.payees.map((p) => <option key={p.account} value={p.account}>{shortAccount(p.account, 40)}</option>)}</select>
            {shown.payee && <small id="pay-to-e" className="ferr" role="alert">{shown.payee}</small>}</div>
          <div className="field"><label htmlFor="pay-amt">{P.fAmount}{tv ? ` (${tv.symbol})` : ''}</label>
            <input id="pay-amt" className="input" inputMode="decimal" autoComplete="off" placeholder="25" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!formOn} aria-invalid={Boolean(shown.amount)} aria-describedby="pay-amt-h"/>
            {shown.amount ? <small id="pay-amt-h" className="ferr" role="alert">{shown.amount}</small>
              : <small id="pay-amt-h" className="faint">{pfill(P.fAmountHint, { n: tv?.decimals ?? 0 })}{tv?.maxPaymentText ? ` ${pfill(P.maxNow, { x: tv.maxPaymentText })}` : ''}</small>}
            {touched && chk.ok && chk.warn && <small className="faint" role="status">{chk.warn}</small>}</div>
          <div className="field"><label htmlFor="pay-note">{P.fNote}</label>
            <input id="pay-note" className="input" autoComplete="off" placeholder="invoice 42" value={note} onChange={(e) => setNote(e.target.value)} disabled={!formOn} aria-invalid={Boolean(shown.note)} aria-describedby="pay-note-h" />
            {shown.note ? <small id="pay-note-h" className="ferr" role="alert">{shown.note}</small> : <small id="pay-note-h" className="faint">{P.fNoteHint}</small>}</div>
        </div>
        <details className="tech pay-more"><summary>{P.fMore}</summary>
          <div className="field"><label htmlFor="pay-ref">{P.fRef}</label>
            <input id="pay-ref" className="input" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} disabled={!formOn} aria-invalid={Boolean(shown.reference)} />
            {shown.reference && <small className="ferr" role="alert">{shown.reference}</small>}</div>
        </details>
        <div className="row">
          <button type="submit" className="btn primary" disabled={!formOn || busy}>{busy ? P.fSending : P.fSubmit}</button>
        </div>
        {err && <p className="ferr" role="alert"><Icon name="alert" size={14} /> {err}</p>}
        {sent && <p className="pay-sent" role="status"><b>{P.sentTitle}.</b> {sent.again ? P.sentAgain : P.sent} <a className="btn sm primary" href={href('approvals', opts)}>{P.open}</a></p>}
      </form>
    </section>
  );
}
