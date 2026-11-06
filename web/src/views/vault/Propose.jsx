// Teach the model in three steps + the propose-a-mandate form (operator only). The form never signs or grants anything: it creates a PENDING decision.
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Chip, Dialog, Icon, NeedsOperator, useToast } from '../../ui.jsx';
import GrantSummary from './GrantSummary.jsx';
import { CHAIN_META, RULES, chainMeta, fmtAmount, parseUnits, protoOfChain } from './format.js';

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const NEAR_ACC = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const PERIOD_UNITS = { min: 60, hour: 3600, day: 86400 };

export function Teach({ onPropose, canOperate, fixture, signingSupported }) {
  const steps = [
    ['1', 'You set the leash', 'Choose a vault, a budget (per draw, per period, in total), a deploy count, an expiry and the exact contract templates the agent may deploy. This is only a proposal: nothing is granted yet.', 'user'],
    ['2', 'You approve, then you sign', 'You approve the exact payload by typing a phrase, then sign the on-chain mandate yourself in your own wallet or CLI. The server turns the loop on only after the chain state equals what you approved, field by field.', 'key'],
    ['3', 'The agent works inside it', 'The agent has its own testnet key and two verbs: draw gas inside the budget and deploy a listed template. Every action, refusal and anomaly lands in a hash-chained ledger. You can revoke, pause or withdraw at any time.', 'bot'],
  ];
  return (
    <section className="panel vt-teach" aria-labelledby="te-h">
      <div className="ph"><h2 id="te-h" className="eyebrow" style={{ margin: 0 }}>Nothing granted yet · how a mandate works</h2><Chip>no mandate</Chip></div>
      <div className="pb stack">
        <ol className="vt-teach-l">
          {steps.map(([n, t, d, ic]) => <li key={n}><span className="vt-teach-n"><Icon name={ic} size={20} /><b>{n}</b></span><h3 className="vt-teach-t">{t}</h3><p className="dim">{d}</p></li>)}
        </ol>
        <div className="row">
          {signingSupported === false
            ? <Chip tone="warn">This API cannot run the loop (see the notice above)</Chip>
            : <NeedsOperator token={canOperate ? 'x' : ''} hint={fixture ? 'Disabled in fixture mode' : 'Operator token required to propose'}><button className="btn primary" onClick={onPropose}><Icon name="vault" size={16} />Propose a mandate</button></NeedsOperator>}
          <span className="help">Testnet only. A proposal creates one pending decision you then approve like any other.</span>
        </div>
      </div>
    </section>
  );
}

function Field({ k, label, children, hint, msg }) { return (<div className="field"><label htmlFor={`pf-${k}`}>{label}</label>{children}{hint && <span className="help">{hint}</span>}{msg}</div>); }

function blank() { return { chainId: 'near-testnet', vault: '', owner: '', hours: '24', perDraw: '', periodN: '1', periodU: 'hour', periodCap: '', totalCap: '', maxDeploys: '3', fund: '', maxPerDay: '3', tpl: {} }; }

/** Pure validation: returns { errors, payload|null }. Client rules mirror the contract (docs/agent-vault-spec.md); the server stays the authority. */
export function validate(f, agent, artifacts) {
  const meta = chainMeta(f.chainId); const proto = protoOfChain(f.chainId); const e = {}; const warn = {};
  const U = (s) => parseUnits(s, meta.decimals);
  const vaultOk = proto === 'evm' ? EVM_ADDR.test(f.vault) : NEAR_ACC.test(f.vault) && f.vault.length <= 64;
  const ownerOk = proto === 'evm' ? EVM_ADDR.test(f.owner) : NEAR_ACC.test(f.owner) && f.owner.length <= 64;
  if (!vaultOk) e.vault = proto === 'evm' ? 'Enter the vault contract address (0x + 40 hex).' : 'Enter the vault account id (such as vault.you.testnet).';
  if (!ownerOk) e.owner = proto === 'evm' ? 'Enter the owner address (0x + 40 hex): the human who will sign the mandate.' : 'Enter the owner account id.';
  const agentId = agent?.address ?? agent?.account;
  if (!agentId) e.agent = `The agent has no ${proto === 'evm' ? 'EVM' : 'NEAR'} key on this API yet (run the agent init script on the Node host).`;
  const hours = Number(f.hours); if (!Number.isInteger(hours) || hours < 1 || hours > RULES.maxExpiryHours) e.hours = `Whole hours, 1 to ${RULES.maxExpiryHours} (30 days max).`;
  const per = U(f.perDraw); const pc = U(f.periodCap); const tc = U(f.totalCap);
  if (!per || per <= 0n) e.perDraw = 'A positive amount, at most the period cap.';
  if (!pc || pc <= 0n) e.periodCap = 'A positive amount, at most the total cap.';
  if (!tc || tc <= 0n) e.totalCap = 'A positive amount.';
  if (per && pc && per > pc) e.perDraw = 'Per-draw cap cannot exceed the period cap.';
  if (pc && tc && pc > tc) e.periodCap = 'Period cap cannot exceed the total cap.';
  const ceil = BigInt(RULES.defaultTotalCeiling[proto]);
  if (tc && tc > ceil) warn.totalCap = `Above the default server ceiling (${fmtAmount(ceil, meta.decimals).text} ${meta.symbol}, env VAULT_MAX_TOTAL_CAP). The server will most likely refuse this.`;
  const secs = Number(f.periodN) * PERIOD_UNITS[f.periodU];
  if (!Number.isInteger(Number(f.periodN)) || !(secs >= RULES.minPeriodSecs && secs <= RULES.maxPeriodSecs)) e.period = 'Between 60 seconds and 30 days.';
  const md = Number(f.maxDeploys); if (!Number.isInteger(md) || md < 0 || md > RULES.maxDeploys) e.maxDeploys = '0 (draw-only) to 1000.';
  const fund = f.fund === '' ? 0n : U(f.fund); if (fund === null) e.fund = 'A decimal amount (0 allowed).';
  const mpd = Number(f.maxPerDay); if (!Number.isInteger(mpd) || mpd < 1 || mpd > 100) e.maxPerDay = 'Whole number, 1 to 100.';
  const chosen = artifacts.filter((a) => f.tpl[a.hash]?.on);
  if (md > 0 && !chosen.length) e.tpl = 'A mandate that can deploy needs at least one template. Set max deploys to 0 for draw-only.';
  const templates = chosen.map((a) => { const t = f.tpl[a.hash]; const dep = proto === 'near' ? U(t.deposit || '0') : 0n; if (proto === 'near' && dep === null) e[`dep-${a.hash}`] = 'A decimal NEAR amount.'; if (!t.label?.trim() || new TextEncoder().encode(t.label).length > 64) e[`lab-${a.hash}`] = 'Label required, at most 64 bytes.'; return { artifactHash: a.hash, label: t.label?.trim(), deposit: String(dep ?? 0n) }; });
  if (Object.keys(e).length) return { errors: e, warn, payload: null };
  return { errors: e, warn, payload: { kind: 'grant_mandate', chainId: f.chainId, vault: { chainId: f.chainId, address: f.vault, owner: f.owner }, agent: proto === 'evm' ? { address: agentId } : { account: agentId }, mandate: { expiresAt: Math.floor(Date.now() / 1000) + hours * 3600, perDrawCap: per.toString(), periodSecs: secs, periodCap: pc.toString(), totalCap: tc.toString(), maxDeploys: md }, templates, fund: { amount: fund.toString() }, loop: { maxPerDay: mpd } } };
}

export function ProposeDialog({ onClose, agent, artifacts, fixture, canOperate }) {
  const toast = useToast(); const [f, setF] = useState(blank); const [touched, setTouched] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const meta = chainMeta(f.chainId); const proto = protoOfChain(f.chainId);
  const arts = useMemo(() => artifacts ?? [], [artifacts]);
  const agentId = proto === 'evm' ? agent?.evm : agent?.near;
  const v = useMemo(() => validate(f, agentId, arts), [f, agentId, arts]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setTpl = (hash, patch) => setF((x) => ({ ...x, tpl: { ...x.tpl, [hash]: { on: false, label: 'registry-v1', deposit: proto === 'near' ? '5' : '0', ...x.tpl[hash], ...patch } } }));
  const show = (k) => (touched && v.errors[k] ? <span id={`pe-${k}`} className="err-t">{v.errors[k]}</span> : v.warn[k] ? <span id={`pe-${k}`} className="help vt-warn">{v.warn[k]}</span> : null);
  const submit = async (e) => {
    e.preventDefault(); setTouched(true); if (!v.payload) return;
    setBusy(true); setErr(null);
    try {
      const body = { chainId: v.payload.chainId, vault: { address: v.payload.vault.address, owner: v.payload.vault.owner }, agent: v.payload.agent, mandate: v.payload.mandate, templates: v.payload.templates, fund: v.payload.fund, loop: v.payload.loop };
      const r = await api('/api/vault/mandates/propose', { method: 'POST', body });
      const id = r?.id ?? r?.decision?.id; toast('Proposal created: a pending decision. Nothing is granted yet.'); onClose();
      if (id) location.hash = `#/vault/grant/${id}`;
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Propose a mandate" onClose={onClose} wide>
      <form className="stack vt-form" onSubmit={submit} noValidate>
        <div className="banner" role="note"><Icon name="info" /><div>This creates a <b>pending decision</b>. It grants nothing and moves no funds. You approve it next, then sign the on-chain mandate yourself. <b>Testnet only.</b></div></div>
        {fixture && <div className="banner warn" role="note"><Icon name="alert" /><div><b>Fixture mode:</b> submitting is disabled; no request can be sent.</div></div>}
        <div className="vt-form-g">
          <Field msg={show('chainId')} k="chainId" label="Network (testnets only)">
            <select id="pf-chainId" className="select" value={f.chainId} onChange={(e) => setF({ ...blank(), chainId: e.target.value })}>{Object.entries(CHAIN_META).filter(([, m]) => m.kind === 'near').map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}</select>
          </Field>
          <Field msg={show('agent')} k="agent" label="Agent (bound, read from the API)">
            <div className="mono-v vt-ro" id="pf-agent">{agentId?.address ?? agentId?.account ?? 'none on this network'}</div>
          </Field>
          <Field msg={show('vault')} k="vault" label={proto === 'evm' ? 'Vault contract address' : 'Vault account'} hint="Deploy it first (npm run contract:evm:build / near-vault scripts); the server verifies its code before the loop ever runs.">
            <input id="pf-vault" className="input mono-i" value={f.vault} onChange={set('vault')} autoComplete="off" spellCheck={false} aria-invalid={touched && Boolean(v.errors.vault)} aria-describedby={v.errors.vault ? 'pe-vault' : undefined} placeholder={proto === 'evm' ? '0x…' : 'vault.you.testnet'} />
          </Field>
          <Field msg={show('owner')} k="owner" label="Owner (the human who signs)" hint="Use a multisig for anything that matters. Only this owner can revoke, pause or withdraw.">
            <input id="pf-owner" className="input mono-i" value={f.owner} onChange={set('owner')} autoComplete="off" spellCheck={false} aria-invalid={touched && Boolean(v.errors.owner)} aria-describedby={v.errors.owner ? 'pe-owner' : undefined} placeholder={proto === 'evm' ? '0x…' : 'you.testnet'} />
          </Field>
          <Field msg={show('perDraw')} k="perDraw" label={`Per-draw cap (${meta.symbol})`} hint="Most it may pull in one call."><input id="pf-perDraw" className="input mono-i" inputMode="decimal" value={f.perDraw} onChange={set('perDraw')} aria-invalid={touched && Boolean(v.errors.perDraw)} aria-describedby={v.errors.perDraw ? 'pe-perDraw' : undefined} placeholder="0.005" /></Field>
          <Field msg={show('periodCap')} k="periodCap" label={`Period cap (${meta.symbol})`} hint="At least the per-draw cap."><input id="pf-periodCap" className="input mono-i" inputMode="decimal" value={f.periodCap} onChange={set('periodCap')} aria-invalid={touched && Boolean(v.errors.periodCap)} aria-describedby={v.errors.periodCap ? 'pe-periodCap' : undefined} placeholder="0.015" /></Field>
          <div className="field">
            <label htmlFor="pf-periodN">Period length</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="pf-periodN" className="input mono-i" inputMode="numeric" value={f.periodN} onChange={set('periodN')} aria-invalid={touched && Boolean(v.errors.period)} aria-describedby={v.errors.period ? 'pe-period' : undefined} />
              <select className="select" aria-label="Period unit" value={f.periodU} onChange={set('periodU')}>{Object.keys(PERIOD_UNITS).map((u) => <option key={u}>{u}</option>)}</select>
            </div>
            <span className="help">60 seconds to 30 days. The period budget resets each window.</span>{show('period')}
          </div>
          <Field msg={show('totalCap')} k="totalCap" label={`Total cap (${meta.symbol})`} hint={`Server ceiling by default: ${proto === 'evm' ? '0.5 ETH' : '20 NEAR'} (VAULT_MAX_TOTAL_CAP), never above a compiled-in maximum.`}><input id="pf-totalCap" className="input mono-i" inputMode="decimal" value={f.totalCap} onChange={set('totalCap')} aria-invalid={touched && Boolean(v.errors.totalCap)} aria-describedby={v.errors.totalCap ? 'pe-totalCap' : undefined} placeholder="0.1" /></Field>
          <Field msg={show('maxDeploys')} k="maxDeploys" label="Max deploys" hint="0 = draw-only. At most 1000."><input id="pf-maxDeploys" className="input mono-i" inputMode="numeric" value={f.maxDeploys} onChange={set('maxDeploys')} aria-invalid={touched && Boolean(v.errors.maxDeploys)} aria-describedby={v.errors.maxDeploys ? 'pe-maxDeploys' : undefined} /></Field>
          <Field msg={show('hours')} k="hours" label="Expires in (hours)" hint="1 to 720 (30 days). After this the agent can do nothing."><input id="pf-hours" className="input mono-i" inputMode="numeric" value={f.hours} onChange={set('hours')} aria-invalid={touched && Boolean(v.errors.hours)} aria-describedby={v.errors.hours ? 'pe-hours' : undefined} /></Field>
          <Field msg={show('fund')} k="fund" label={`Fund the vault with (${meta.symbol})`} hint="Sent by you from your wallet. 0 allowed if already funded."><input id="pf-fund" className="input mono-i" inputMode="decimal" value={f.fund} onChange={set('fund')} aria-invalid={touched && Boolean(v.errors.fund)} aria-describedby={v.errors.fund ? 'pe-fund' : undefined} placeholder="0.05" /></Field>
          <Field msg={show('maxPerDay')} k="maxPerDay" label="Loop limit per day" hint="Autonomous deploy approvals per day."><input id="pf-maxPerDay" className="input mono-i" inputMode="numeric" value={f.maxPerDay} onChange={set('maxPerDay')} aria-invalid={touched && Boolean(v.errors.maxPerDay)} aria-describedby={v.errors.maxPerDay ? 'pe-maxPerDay' : undefined} /></Field>
        </div>
        <fieldset className="vt-fs"><legend className="eyebrow">Templates the agent may deploy (attested builds only)</legend>
          {!arts.length && <p className="faint">No attested contract build is available yet. A draw-only mandate (max deploys 0) needs none.</p>}
          {arts.map((a) => { const t = f.tpl[a.hash] ?? { on: false, label: 'registry-v1', deposit: proto === 'near' ? '5' : '0' }; return (
            <div key={a.hash} className="vt-tpl-pick">
              <label className="ap-ack"><input type="checkbox" checked={Boolean(t.on)} onChange={(e) => setTpl(a.hash, { on: e.target.checked })} /><span><b className="mono-v">{a.kind}</b> <span className="mono-v faint">{String(a.hash).replace(/^sha256:/, '').slice(0, 16)}…</span></span></label>
              {t.on && <div className="vt-form-g">
                <div className="field"><label htmlFor={`pl-${a.hash}`}>Label</label><input id={`pl-${a.hash}`} className="input" value={t.label} maxLength={64} onChange={(e) => setTpl(a.hash, { label: e.target.value })} />{touched && v.errors[`lab-${a.hash}`] && <span className="err-t">{v.errors[`lab-${a.hash}`]}</span>}</div>
                <div className="field"><label htmlFor={`pd-${a.hash}`}>Deposit per deploy ({meta.symbol})</label><input id={`pd-${a.hash}`} className="input mono-i" value={proto === 'near' ? t.deposit : '0'} disabled={proto !== 'near'} onChange={(e) => setTpl(a.hash, { deposit: e.target.value })} /><span className="help">{proto === 'near' ? 'Storage money forwarded to the new sub-account.' : 'EVM templates carry no deposit (must be 0).'}</span></div>
              </div>}
            </div>); })}
          {touched && v.errors.tpl && <span className="err-t">{v.errors.tpl}</span>}
        </fieldset>
        <section aria-label="Preview of the decision"><h3 className="eyebrow">Preview · what you will be asked to approve</h3>
          {v.payload ? <GrantSummary payload={v.payload} chainId={v.payload.chainId} /> : <p className="faint">{touched ? 'Fix the highlighted fields to see the preview.' : 'Fill in the form to see exactly what the decision will say.'}</p>}
          <p className="help">Preview only. The server recomputes template ids from the attested build and applies its own ceilings; the pending decision it returns is the real record.</p>
        </section>
        {err && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>The API refused this proposal</b><div className="mono-v rt-verbatim">{err.message}{err.status ? ` (HTTP ${err.status})` : ''}</div></div></div>}
        <div className="row"><button className="btn primary" type="submit" disabled={busy || fixture || !canOperate}>{busy ? 'Proposing…' : 'Create pending decision'}</button><button className="btn" type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}
