// What a grant_mandate decision authorises, as tables: mandate, templates, funding, loop limits. Shared by the Approval room and the Vault grant flow.
import { Chip } from '../../ui.jsx';
import { Full, KV } from '../_run-parts.jsx';
import { Amt } from './parts.jsx';
import './vault.css';
import { chainMeta, normChain, secsLabel, span, toMs, when } from './format.js';

export default function GrantSummary({ payload, chainId }) {
  const p = payload ?? {}; const m = p.mandate ?? {}; const meta = chainMeta(chainId ?? p.vault?.chainId);
  if (!meta) return <p className="err-t" role="alert">This decision is for chain "{String(chainId ?? p.vault?.chainId ?? 'unknown')}", which this console has no unit for. Amounts cannot be shown safely, so none are.</p>;
  const unit = { symbol: meta.symbol, decimals: meta.decimals, base: meta.base }; const exp = toMs(m.expiresAt);
  return (
    <div className="stack">
      <section aria-label="Vault">
        <h3 className="eyebrow gs-h">Vault</h3>
        <KV rows={[
          ['Network', <span key="n">{meta.label} <span className="mono-v faint">({normChain(chainId ?? p.vault?.chainId)})</span></span>],
          ['Vault address', <Full key="v" v={p.vault?.address} copy />],
          ['Owner (signs on-chain)', <Full key="o" v={p.vault?.owner} />],
          ['Agent (bound)', <Full key="a" v={p.agent?.address ?? p.agent?.account} />],
        ]} />
      </section>
      <section aria-label="Mandate">
        <h3 className="eyebrow gs-h">Mandate: the whole leash</h3>
        <div className="scroll-x"><table className="tbl gs-t"><thead><tr><th scope="col">Limit</th><th scope="col">Value</th><th scope="col">Meaning</th></tr></thead>
          <tbody>
            <tr><th scope="row" className="vt-rowh">Per draw</th><td><Amt v={m.perDrawCap} unit={unit} strong /></td><td className="dim">most the agent may pull in one call</td></tr>
            <tr><th scope="row" className="vt-rowh">Per period</th><td><Amt v={m.periodCap} unit={unit} strong /> <span className="faint">per {secsLabel(m.periodSecs)}</span></td><td className="dim">draws and deploy deposits share this window budget</td></tr>
            <tr><th scope="row" className="vt-rowh">In total</th><td><Amt v={m.totalCap} unit={unit} strong /></td><td className="dim">lifetime ceiling for this mandate</td></tr>
            <tr><th scope="row" className="vt-rowh">Deploys</th><td><b className="num">{m.maxDeploys}</b> <span className="faint">{Number(m.maxDeploys) === 0 ? '(draw-only)' : 'at most'}</span></td><td className="dim">contract deployments from allowlisted templates</td></tr>
            <tr><th scope="row" className="vt-rowh">Expires</th><td className="mono-v">{when(m.expiresAt)}{exp ? <span className="faint"> · in {span(exp - Date.now())}</span> : null}</td><td className="dim">after this the agent can do nothing</td></tr>
          </tbody></table></div>
      </section>
      <section aria-label="Allowlisted templates">
        <h3 className="eyebrow gs-h">Templates the agent may deploy · {(p.templates ?? []).length}</h3>
        {!(p.templates ?? []).length ? <p className="faint">None: this is a draw-only mandate.</p> : (
          <ul className="gs-tpl">{p.templates.map((t) => (
            <li key={t.templateId ?? t.artifactHash}><b>{t.label}</b>
              <span className="mono-v faint gs-id">template {t.templateId ?? 'computed by the server'}</span>
              <span className="mono-v faint gs-id">artifact {t.artifactHash ?? '–'}</span>
              <span>deposit <Amt v={t.deposit ?? '0'} unit={unit} /></span></li>
          ))}</ul>
        )}
      </section>
      <section aria-label="Funding and loop limits">
        <h3 className="eyebrow gs-h">Funding and loop limits</h3>
        <KV rows={[
          ['Fund the vault with', <span key="f"><Amt v={p.fund?.amount ?? '0'} unit={unit} strong /> <Chip tone="mineral">from your wallet, not the agent</Chip></span>],
          ['Loop limit', <span key="l"><b className="num">{p.loop?.maxPerDay ?? '–'}</b> autonomous deploy approvals per day</span>],
        ]} />
      </section>
    </div>
  );
}
