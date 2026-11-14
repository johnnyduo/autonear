// The "flight deck" header: loop state, last tick, daily usage, operator controls + the static "leash" copy.
import { useRef } from 'react';
import { Chip, ErrorPanel, Icon, Led, Meter, NeedsOperator, Panel, StaleNote } from '../../ui.jsx';
import { Checks } from '../_run-parts.jsx';
import { LOOP, ago, when } from './format.js';

export function LoopDeck({ data, now, ctl, stale, at, mode }) {
  const l = data.loop ?? {}; const st = LOOP[l.state] ?? { tone: '', word: String(l.state ?? 'unknown'), note: 'The API reported a loop state this console does not know.' };
  const used = Number(l.usedToday ?? 0); const max = Number(l.maxPerDay ?? 0); const health = data.health ?? [];
  const failing = health.filter((h) => !h.ok).length;
  const killed = ctl.kill.paused;
  return (
    <section className={`panel vt-deck ${st.tone === 'bad' ? 'risk' : st.tone === 'ok' ? 'live' : ''}`} aria-labelledby="deck-h">
      <h2 id="deck-h" className="sr">Autonomy loop status</h2>
      {/* polite, atomic, changes only when the state word changes (not every poll) */}
      <div className="sr" role="status" aria-live="polite" aria-atomic="true">{`Autonomy loop ${st.word.toLowerCase()}${killed ? '; global kill switch engaged' : ''}`}</div>
      <div className="vt-deck-g">
        <div className={`vt-state ${st.tone}`}>
          <span className="eyebrow">Autonomy loop</span>
          <div className="vt-state-w"><Led tone={st.tone || 'off'} live={l.state === 'running' && !killed} /><b data-testid="loop-state">{st.word}</b></div>
          <p className="vt-state-n">{st.note}</p>
        </div>
        <dl className="vt-stat">
          <div><dt className="eyebrow">Last tick</dt><dd className="mono-v" title={when(l.lastTickAt)}>{l.lastTickAt ? ago(l.lastTickAt, now) : 'never'}</dd><dd className="help">{l.lastTickAt ? when(l.lastTickAt) : 'the loop has not ticked yet'}</dd></div>
          <div><dt className="eyebrow">Mandate runs today</dt><dd className="mono-v"><b className="vt-big">{used}</b> <span className="faint">of {max || '–'}</span></dd><dd><Meter value={max ? used / max : 0} tone={max && used >= max ? 'risk' : ''} label={`${used} of ${max} runs used today`} /></dd></div>
        </dl>
        <div className="vt-ctl">
          <span className="eyebrow">Operator controls</span>
          <NeedsOperator token={ctl.canOperate ? 'x' : ''} hint={ctl.fixture ? 'Disabled in fixture mode' : 'Operator token required'}>
            <div className="row">
              {l.state === 'paused' || l.state === 'blocked'
                ? <button className="btn primary" onClick={() => ctl.act('resume')} disabled={ctl.busy}><Icon name="play" size={16} />{ctl.busy ? 'Working…' : l.state === 'blocked' ? 'Review done: resume loop' : 'Resume loop'}</button>
                : <button className="btn" onClick={() => ctl.act('pause')} disabled={ctl.busy}><Icon name="pause" size={16} />{ctl.busy ? 'Working…' : 'Pause loop'}</button>}
              <button className={`btn ${killed ? 'primary' : 'danger'}`} onClick={ctl.kill.toggle} disabled={ctl.busy}><Icon name={killed ? 'play' : 'pause'} size={16} />{killed ? 'Release kill switch' : 'Kill switch'}</button>
            </div>
          </NeedsOperator>
          <span className="help">{killed ? 'Global kill switch ENGAGED: the loop stops regardless of its own state.' : 'The kill switch is global: it also stops runs and approvals. It is always in the top bar too.'}</span>
        </div>
      </div>
      {(l.lastError || stale || l.state === 'blocked') && (
        <div className="vt-deck-alerts">
          {l.state === 'blocked' && <div className="banner risk" role="alert"><Icon name="alert" /><div><b>The loop blocked itself.</b> A reading of the chain disagreed with the model or the attested code. That is the leash working: nothing was executed after the mismatch. Read the anomaly in the ledger below, then an operator may resume.</div></div>}
          {l.lastError && <div className="banner warn"><Icon name="alert" /><div><b>Last error</b><div className="mono-v rt-verbatim">{l.lastError}</div></div></div>}
          {stale && <StaleNote at={at} />}
        </div>
      )}
      {health.length > 0 && (
        <details className="vt-health"><summary>Health checks · {health.length - failing}/{health.length} pass{mode === 'fixture' ? ' (fixture)' : ''}</summary><Checks items={health} /></details>
      )}
    </section>
  );
}

/** Vault selector (WAI-ARIA tabs, roving tabindex, arrows/Home/End). A per-vault status chip keeps problems visible without opening each. */
export function VaultTabs({ items, value, onChange, panelId }) {
  const refs = useRef({});
  const idx = items.findIndex((i) => i.id === value);
  const key = (e) => {
    let n = idx;
    if (e.key === 'ArrowRight') n = (idx + 1) % items.length; else if (e.key === 'ArrowLeft') n = (idx - 1 + items.length) % items.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = items.length - 1; else return;
    e.preventDefault(); onChange(items[n].id); refs.current[items[n].id]?.focus();
  };
  return (
    <div className="vt-tabs" role="tablist" aria-label="Vaults" onKeyDown={key}>
      {items.map((i) => (
        <button key={i.id} ref={(el) => { refs.current[i.id] = el; }} id={`vtab-${i.id}`} role="tab" aria-selected={i.id === value} aria-controls={panelId} tabIndex={i.id === value ? 0 : -1} onClick={() => onChange(i.id)} className={`vt-tab ${i.tone}`}>
          <span className="vt-tab-top"><Led tone={i.tone || 'off'} />{i.chain}</span>
          <span className="vt-tab-mid mono-v">{i.short}</span>
          <span className={`vt-tab-st ${i.tone}`}>{i.label}</span>
        </button>
      ))}
    </div>
  );
}

const NEVER = [
  ['lock', 'Change any configuration', 'Owner, pause state and mandate are owner-only calls. The agent key cannot call them.'],
  ['arrow', 'Widen its own budget', 'Caps, period and expiry are fixed in the mandate. Usage only resets when the owner sets a new one.'],
  ['ban', 'Draw to any other address', 'A draw pays the bound agent address only. The vault has no transfer and no arbitrary call. Once drawn, funds sit in the agent\'s own account, outside the vault.'],
  ['deploy', 'Deploy code you did not list', 'Only owner-allowlisted templates: exact bytecode hash (EVM) or wasm hash (NEAR).'],
  ['user', 'Choose owners or init arguments', 'Init material is fixed by the owner when the template is allowed, so the agent cannot pick who owns a deployed registry.'],
  ['loop', 'Upgrade the vault or itself', 'No upgrade path, no delegatecall, no selfdestruct. Replacement means redeploy plus an owner withdraw.'],
  ['key', 'Withdraw', 'Withdraw is owner-only and pays the owner address only.'],
  ['alert', 'Touch mainnet', 'Testnet only. Mainnet is blocked in the backend and not claimed anywhere.'],
];
const OWNER = [['ban', 'Revoke', 'ends the mandate at once'], ['pause', 'Pause', 'blocks the agent, never the owner'], ['wallet', 'Withdraw', 'to the owner address, even while paused'], ['loop', 'Replace', 'set a new mandate, usage resets']];

export function NeverPanel() {
  return (
    <section className="panel vt-never" aria-labelledby="nv-h">
      <div className="ph"><h2 id="nv-h" className="eyebrow" style={{ margin: 0 }}>The leash</h2><Chip tone="mineral">enforced in contract code</Chip></div>
      <div className="pb stack">
        <div>
          <h3 className="vt-h3 bad"><Icon name="ban" size={18} />Through the vault, this agent can never</h3>
          <ul className="vt-never-l">
            {NEVER.map(([ic, t, d]) => <li key={t}><span className="vt-x" aria-hidden="true"><Icon name="x" size={14} /></span><span><b>{t}</b><span className="dim"> {d}</span></span></li>)}
          </ul>
        </div>
        <div>
          <h3 className="vt-h3 ok"><Icon name="key" size={18} />The owner can always</h3>
          <ul className="vt-own-l">
            {OWNER.map(([ic, t, d]) => <li key={t}><span className="vt-ok" aria-hidden="true"><Icon name="check" size={14} /></span><span><b>{t}</b> <span className="dim">{d}</span></span></li>)}
          </ul>
          <p className="help" style={{ margin: '8px 0 0' }}>Owner funds are never trapped. The agent has exactly two verbs: <b>draw</b> gas inside a budget, and <b>deploy</b> a listed template.</p>
        </div>
        <p className="help vt-never-f">The same rules are checked by one shared conformance file across the EVM contract, the NEAR contract and the JS reference model. These are automated checks, not an independent audit: independent audit status is <b>none</b>.</p>
      </div>
    </section>
  );
}
