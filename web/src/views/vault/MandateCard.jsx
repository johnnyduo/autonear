// One vault's mandate card: identity, state chips, budget gauges, expiry, liquidity, allowlisted templates, exact values.
import { Chip, Icon, Led } from '../../ui.jsx';
import { CopyButton, KV } from '../_run-parts.jsx';
import { Addr, Amt, Gauge, Liquidity } from './parts.jsx';
import { ago, chainMeta, secsLabel, span, toBig, toMs, unitOf, vaultFlags, vaultHeadline, when } from './format.js';

export function StateChips({ v, now }) {
  const f = vaultFlags(v, now);
  return (
    <div className="row vt-chips">
      {f.paused && <Chip tone="warn"><Led tone="warn" />vault paused</Chip>}
      {f.revoked && <Chip tone="bad"><Icon name="ban" size={13} />revoked</Chip>}
      {f.expired && !f.revoked && <Chip tone="bad"><Icon name="clock" size={13} />expired</Chip>}
      {f.codeBad && <Chip tone="bad"><Icon name="alert" size={13} />code mismatch</Chip>}
      {!f.hasMandate && <Chip><Icon name="lock" size={13} />no mandate</Chip>}
      {f.readErr && <Chip tone="warn"><Icon name="alert" size={13} />read error</Chip>}
      {v.codeOk === true && <Chip tone="mineral" title="The server compared the runtime code at this address to the attested AgentVault build">code matches attested build</Chip>}
    </div>
  );
}

export default function MandateCard({ v, now, decisions, fixture }) {
  const unit = unitOf(v); const meta = chainMeta(v.chainId); const m = v.mandate; const u = v.usage ?? {}; const b = v.budget ?? {};
  const head = vaultHeadline(v, now); const f = vaultFlags(v, now);
  const exp = m ? toMs(m.expiresAt) : 0; const reset = u.periodResetsAt ? toMs(u.periodResetsAt) : 0;
  const dec = v.mandateDecisionId ? decisions?.find((d) => d.id === v.mandateDecisionId) : null;
  const gaugesLive = f.hasMandate;
  const exact = m ? [
    ['perDrawCap', m.perDrawCap, unit.base], ['periodCap', m.periodCap, unit.base], ['totalCap', m.totalCap, unit.base],
    ['periodSecs', m.periodSecs, 'seconds'], ['maxDeploys', m.maxDeploys, 'count'], ['expiresAt', m.expiresAt, 'chain time'],
    ['spent this period', u.periodSpent, unit.base], ['spent in total', u.totalSpent, unit.base], ['deploys used', u.deploys, 'count'],
    ['remaining this period', b.remainingPeriod, unit.base], ['remaining in total', b.remainingTotal, unit.base], ['max draw right now', b.maxDraw, unit.base],
    ['vault available', v.available, unit.base], ['agent balance', v.agentBalance, unit.base],
  ] : [['vault available', v.available, unit.base], ['agent balance', v.agentBalance, unit.base]];

  return (
    <article className={`panel vt-card ${head.tone === 'bad' ? 'risk' : f.active ? 'live' : ''}`} aria-labelledby={`vc-${v.id}`}>
      <div className="ph vt-card-h">
        <div className="vt-card-t">
          <h2 id={`vc-${v.id}`} className="eyebrow" style={{ margin: 0 }}>Mandate · {meta?.label ?? v.network ?? v.chainId}</h2>
          <span className="vt-card-big"><Icon name="vault" size={22} />{head.label}</span>
        </div>
        <StateChips v={v} now={now} />
      </div>
      <div className="pb vt-card-b">
        <p className="vt-why dim">{head.why}</p>
        {v.readError && <div className="banner warn" role="status"><Icon name="alert" /><div><b>The last read of this vault failed</b><div className="mono-v rt-verbatim">{v.readError}</div><span className="help">Everything below is from the last successful read ({ago(v.readAt, now)}).</span></div></div>}
        {v.codeOk === false && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>The code at this address is not the attested vault build.</b> The loop will not act on this vault. Do not fund it.</div></div>}

        <KV rows={[
          ['Vault', <Addr key="va" v={v.address} chainId={v.chainId} what="vault address" />],
          ['Owner (human)', <Addr key="ow" v={v.owner} chainId={v.chainId} what="owner address" />],
          ['Agent (bound)', m ? <Addr key="ag" v={m.agent} chainId={v.chainId} what="agent address" /> : <span key="ag" className="faint">no mandate: no agent is bound</span>],
          ['Approved by', v.mandateDecisionId ? (fixture ? <span key="md" className="mono-v" title="fixture decision">{v.mandateDecisionId}</span> : <a key="md" className="mono-v" href={`#/approval/${v.mandateDecisionId}`}>{v.mandateDecisionId}{dec?.approver ? ` · ${dec.approver}` : ''}</a>) : <span key="md" className="faint">not linked to a decision</span>],
          ['Chain read', <span key="rd" className="mono-v" title={when(v.readAt)}>{ago(v.readAt, now)}{m ? ` · mandate epoch ${m.epoch}` : ''}</span>],
        ]} />

        {gaugesLive && (
          <>
            <div className="vt-gauges" role="group" aria-label="Budget remaining">
              <Gauge label="Per draw" name="Per-draw allowance (what the agent may draw right now)" remaining={b.maxDraw} cap={m.perDrawCap} unit={unit} sub="" foot={(toBig(b.maxDraw) ?? 0n) < (toBig(m.perDrawCap) ?? 0n) ? 'limited by remaining budget' : 'at its cap'} />
              <Gauge label="This period" remaining={b.remainingPeriod} cap={m.periodCap} spent={u.periodSpent} unit={unit} foot={reset ? (reset <= now ? 'resets now' : `resets in ${span(reset - now)}`) : `${secsLabel(m.periodSecs)} window`} />
              <Gauge label="Total" remaining={b.remainingTotal} cap={m.totalCap} spent={u.totalSpent} unit={unit} foot="never resets" />
              <Gauge label="Deploys" name="Deploys" count remaining={String(b.remainingDeploys ?? 0)} cap={String(m.maxDeploys)} sub={`${u.deploys ?? 0} used`} foot={Number(m.maxDeploys) === 0 ? 'draw-only mandate' : 'allowlisted only'} />
            </div>
            <div className={`vt-expiry ${f.expired ? 'bad' : exp - now < 36e5 ? 'warn' : ''}`}>
              <Icon name="clock" size={18} />
              <span className="mono-v">{f.revoked ? 'Revoked by the owner' : f.expired ? `Expired ${span(now - exp)} ago` : <>Mandate expires in <b data-testid="expiry">{span(exp - now)}</b></>}</span>
              <span className="mono-v faint">{when(m.expiresAt)}</span>
              {b.blocked ? <Chip tone="bad" title="The vault would refuse an agent call right now">agent blocked: {typeof b.blocked === 'string' ? b.blocked : 'yes'}</Chip> : <Chip tone="ok">agent can act</Chip>}
            </div>
          </>
        )}

        <Liquidity agentBalance={v.agentBalance} available={v.available} maxDraw={b.maxDraw} unit={unit} />

        <section aria-label="Allowlisted templates" className="vt-tpl">
          <h3 className="eyebrow">Allowlisted templates · {v.templates?.length ?? 0}</h3>
          {!v.templates?.length ? <p className="faint">No template is allowlisted: the agent cannot deploy anything on this vault.</p> : (
            <ul className="vt-tpl-list">
              {v.templates.map((t) => (
                <li key={t.id} className="vt-tpl-i">
                  <div className="vt-tpl-main">
                    <b>{t.label}</b>
                    <span className="mono-v faint vt-tpl-id" title={t.id}>{t.id.length > 26 ? `${t.id.slice(0, 14)}…${t.id.slice(-8)}` : t.id}</span>
                    <CopyButton text={t.id} label="Copy id" aria={`Copy template id of ${t.label}`} />
                  </div>
                  <div className="vt-tpl-meta">
                    <span>deposit <Amt v={t.deposit} unit={unit} /></span>
                    {t.matches
                      ? <Chip tone="ok" title={t.artifactHash}><Icon name="check" size={13} />matches attested artifact {String(t.artifactHash ?? '').replace(/^sha256:/, '').slice(0, 8)}</Chip>
                      : <Chip tone="warn" title="No attested artifact maps to this template id, so the agent will leave such deploy decisions for a human"><Icon name="alert" size={13} />no attested artifact: humans only</Chip>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="vt-exact">
          <summary>Exact values (base units: {unit.base})</summary>
          <div className="scroll-x"><table className="tbl"><thead><tr><th scope="col">Field</th><th scope="col">Shown as</th><th scope="col">Exact</th></tr></thead>
            <tbody>{exact.map(([k, val, base]) => (
              <tr key={k}><th scope="row" className="vt-rowh">{k}</th><td>{base === unit.base ? <Amt v={val} unit={unit} /> : base === 'seconds' ? secsLabel(val) : base === 'chain time' ? when(val) : String(val ?? '–')}</td><td className="mono-v">{String(val ?? '–')} <span className="faint">{base}</span> {val != null && <CopyButton text={String(val)} label={`Copy ${k}`} />}</td></tr>
            ))}</tbody></table></div>
        </details>
        {fixture && <p className="help" style={{ margin: 0 }}>Fixture vault: the addresses above are placeholders and do not exist on any chain.</p>}
      </div>
    </article>
  );
}
