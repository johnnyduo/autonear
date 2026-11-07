// "Let the agent pay people": the whole grant for a vault that can pay tokens, in three short parts (what, how much, who). It only PROPOSES: nothing is granted and no money moves
// until the owner approves it on the Approvals page and signs the on-chain steps. The agent's own small NEAR allowance (for fuel) is fixed, not a choice.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui.jsx';
import { href } from './nav.js';
import { PAY_DEFAULTS, PAY_FUEL, payBudgetCheck } from './vaultView.js';

export default function PayBudget({ v, owner, canWrite, demo, opts, toast }) {
  const onChain = v.payouts?.tokens ?? [];
  const [f, setF] = useState(() => ({ token: onChain[0]?.token ?? '', ...PAY_DEFAULTS, people: (v.payouts?.payees ?? []).map((p) => (typeof p === 'string' ? p : p?.account)).filter(Boolean).join('\n') })); // the report lists payees as { account, matches }
  const [meta, setMeta] = useState(null); // { symbol, decimals } read from the token itself, or { error }
  const [artifact, setArtifact] = useState(''); const [touched, setTouched] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ownerNow = v.owner;

  useEffect(() => { // an attested build is required by the server, even for a grant that only pays
    if (demo) return undefined; let on = true;
    api('/api/artifacts').then((r) => { const a = (r?.items ?? []).find((x) => x.kind === 'contract-build:near'); if (on) setArtifact(a?.hash ?? ''); }).catch(() => {});
    return () => { on = false; };
  }, [demo]);
  useEffect(() => { // what the token calls itself and how many decimals it has: from the token, never typed
    const t = f.token.trim().toLowerCase(); if (demo || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(t)) { setMeta(null); return undefined; }
    let on = true; setMeta(null);
    const timer = setTimeout(() => import('../wallet/nearEth.js').then((n) => n.viewNear({ contract: t, method: 'ft_metadata' })).then((m) => on && setMeta(Number.isInteger(m?.decimals) && m.symbol ? { symbol: m.symbol, decimals: m.decimals } : { error: 'This account does not look like a token.' })).catch(() => on && setMeta({ error: 'Could not read this token. Check the account.' })), 350);
    return () => { on = false; clearTimeout(timer); };
  }, [f.token, demo]);

  const chk = useMemo(() => payBudgetCheck(f, { decimals: meta?.decimals, vault: v.address, chainId: v.chainId, owner: ownerNow, artifactHash: artifact, agent: v.mandate?.agent }), [f, meta, v.address, v.chainId, ownerNow, artifact, v.mandate?.agent]);
  const e = touched ? chk.errors : {}; const off = !canWrite || demo;
  const submit = async (ev) => {
    ev.preventDefault(); setTouched(true); setErr('');
    if (!chk.body || off || busy) return;
    setBusy(true);
    try { const r = await api('/api/vault/mandates/propose', { method: 'POST', body: chk.body }); setDone({ id: r?.id ?? r?.decision?.id ?? null }); toast('Proposal created. Nothing is granted until you approve it.'); }
    catch (x) { setErr(x?.message ?? 'That did not work.'); } finally { setBusy(false); }
  };
  const sym = meta?.symbol ?? 'tokens'; const days = PAY_FUEL.days;

  if (done) return (
    <section className="card vp-card vp-pb" aria-labelledby="pb-h">
      <h2 id="pb-h">Proposal created</h2>
      <p className="vp-sub">Nothing is granted yet. Next, approve it, then sign the few steps it needs in your wallet. After that the agent can pay the people you listed, inside these limits.</p>
      <a className="btn primary" href={href('approvals', opts)}>Go to Approvals<Icon name="arrow" size={16} /></a>
    </section>
  );
  return (
    <section className="card vp-card vp-pb" aria-labelledby="pb-h">
      <h2 id="pb-h">Let the agent pay people</h2>
      <p className="vp-sub">Pick a token, set how much it may pay and who it may pay. This only creates a proposal. You approve it next, and nothing moves before that.</p>
      <form onSubmit={submit} noValidate>
        <div className="vp-step"><span className="vp-n">1</span><label className="vp-label" htmlFor="pb-token">Token it pays with</label></div>
        <input id="pb-token" className="input" autoComplete="off" spellCheck="false" value={f.token} onChange={set('token')} disabled={off} aria-invalid={Boolean(e.token)} aria-describedby="pb-token-h" placeholder="usdc.you.testnet" />
        <p id="pb-token-h" className={e.token || meta?.error ? 'vp-err' : 'faint'} role={e.token || meta?.error ? 'alert' : undefined}>{e.token || meta?.error || (meta ? `${meta.symbol}, ${meta.decimals} decimals. Read from the token itself.` : 'The token’s own account.')}</p>

        <div className="vp-step"><span className="vp-n">2</span><span className="vp-label">How much it may pay ({sym})</span></div>
        <div className="vp-row3">
          {[['each', 'Each payment'], ['day', 'Per day'], ['total', 'In total']].map(([k, label]) => (
            <div key={k}><label className="vp-sublabel" htmlFor={`pb-${k}`}>{label}</label>
              <input id={`pb-${k}`} className="input" inputMode="decimal" autoComplete="off" value={f[k]} onChange={set(k)} disabled={off} aria-invalid={Boolean(e[k])} aria-describedby={e[k] ? `pb-${k}-e` : undefined} />
              {e[k] && <p id={`pb-${k}-e`} className="vp-err" role="alert">{e[k]}</p>}</div>
          ))}
        </div>

        <div className="vp-step"><span className="vp-n">3</span><label className="vp-label" htmlFor="pb-people">People it may pay</label></div>
        <textarea id="pb-people" className="input vp-ta" rows={3} spellCheck="false" value={f.people} onChange={set('people')} disabled={off} aria-invalid={Boolean(e.people)} aria-describedby="pb-people-h" placeholder={'alice.testnet\nbob.testnet'} />
        <p id="pb-people-h" className={e.people ? 'vp-err' : 'faint'} role={e.people ? 'alert' : undefined}>{e.people || 'One NEAR account per line. It can pay nobody else.'}</p>

        <p className="vp-fuelnote"><Icon name="bolt" size={14} />The agent also gets a small NEAR allowance for its own fuel: up to 0.1 each time and 0.5 in total, for {days} days.</p>
        {e.setup && <p className="vp-err" role="alert">{e.setup}</p>}
        {err && <p className="vp-err" role="alert">{err}</p>}
        <button type="submit" className="btn primary" disabled={off || busy}>{busy ? 'Creating…' : 'Create the proposal'}</button>
        {off && <p className="faint vp-offnote">{demo ? 'This is illustrated data, so nothing can be proposed here.' : owner?.address ? 'Only the vault’s owner wallet can propose this.' : 'Connect the owner’s wallet to propose this.'}</p>}
      </form>
    </section>
  );
}
