// Watch: steer what the agent hunts. Add words to look for, words to ignore, switch sources on or off, and teach it from what it found.
import { useState } from 'react';
import { api, fmt } from '../api.js';
import { Icon } from '../ui.jsx';
import { T } from './copy.js';

function Chips({ label, help, items, onChange, disabled, placeholder }) {
  const [v, setV] = useState('');
  const add = (e) => { e.preventDefault(); const t = v.trim().toLowerCase(); if (t.length >= 2 && !items.includes(t)) onChange([...items, t]); setV(''); };
  return (
    <div className="field wt-field">
      <label>{label}</label>
      {help && <p className="faint">{help}</p>}
      <ul className="chips">{items.map((k) => <li key={k}><span className="chip">{k}</span>{!disabled && <button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(items.filter((x) => x !== k))}><Icon name="x" size={12} /></button>}</li>)}{!items.length && <li className="faint">None yet</li>}</ul>
      <form className="row" onSubmit={add}><input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} disabled={disabled} maxLength={60} aria-label={`Add to ${label}`} /><button className="btn sm" disabled={disabled || v.trim().length < 2}>Add</button></form>
    </div>
  );
}

const tone = (s) => (s.status === 'ok' ? (s.stale ? ['warn', 'slow'] : ['ok', 'working']) : s.status === 'disabled_by_owner' ? ['', 'off'] : s.status === 'not_configured' ? ['', 'needs a key'] : ['bad', 'having trouble']);

export default function Watch({ data, owner, canWrite, demo, toast }) {
  const w = data.watch ?? { keywords: [], excludes: [], hackathons: [], sources: {} };
  const [busy, setBusy] = useState(false);
  const sources = data.status.data?.sources ?? [];
  const why = !owner.address ? 'Connect your wallet to change this.' : !owner.isOwner ? T.readOnly : T.demoNote;
  const save = async (patch, okMsg = 'Saved. The agent uses this from its next check.') => {
    setBusy(true);
    try { await api('/api/watch', { method: 'PUT', body: { keywords: w.keywords, excludes: w.excludes, hackathons: w.hackathons, sources: w.sources, ...patch } }); toast(okMsg); data.reloadWatch(); }
    catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const lock = !canWrite || busy;
  const finds = [...data.opps].sort((a, b) => b.score - a.score).slice(0, 6);
  const topicWord = (o) => String(o.topic ?? o.title).replace(/_/g, ' ').toLowerCase().slice(0, 40);
  return (
    <div className="ap-wrap">
      <h1 className="pg">Watch</h1>
      <p className="pg-sub">Tell the agent what matters. It reads around the clock and will rank and tag what matches. It never lowers its own standards for you.</p>
      {!canWrite && <p className="why"><Icon name="lock" size={14} />{why}</p>}
      <div className="wt-grid">
        <section className="card"><h2>What to look for</h2>
          <Chips label="Words and topics" help="Such as: intents, treasury, a protocol name." items={w.keywords} disabled={lock} placeholder="add a word…" onChange={(keywords) => save({ keywords })} />
          <Chips label="Hackathons and events" help="Names of events to keep an eye on." items={w.hackathons} disabled={lock} placeholder="add an event…" onChange={(hackathons) => save({ hackathons })} />
          <Chips label="Ignore anything about" help="Posts that mention these are skipped." items={w.excludes} disabled={lock} placeholder="add a phrase to ignore…" onChange={(excludes) => save({ excludes })} />
        </section>
        <section className="card"><h2>Where it looks</h2>
          <ul className="srcs">{sources.map((s) => { const [t, word] = tone(s); const off = w.sources?.[s.id] === false; return (
            <li key={s.id}>
              <div><b>{s.name}</b><span className={`chip ${t}`}>{word}</span><small>{s.lastSuccess ? `last read ${fmt.ago(s.lastSuccess)}` : 'not read yet'}</small></div>
              <button type="button" role="switch" aria-checked={!off} aria-label={`Read ${s.name}`} className={`sw${off ? '' : ' on'}`} disabled={lock} onClick={() => save({ sources: { ...w.sources, [s.id]: off } }, off ? `${s.name} is on.` : `${s.name} is off.`)}><i /></button>
            </li>); })}
          </ul>
        </section>
      </div>
      <section className="card"><h2>Teach it from what it found</h2>
        {finds.length ? <ul className="teach">{finds.map((o) => (
          <li key={o.id}><div><b>{o.title}</b><small>{o.score_breakdown?.counts?.sources ?? 0} sources · updated {fmt.ago(o.updated_at)}</small></div>
            <div className="row"><button type="button" className="btn sm" disabled={lock} onClick={() => save({ keywords: [...new Set([...w.keywords, topicWord(o)])] }, `Looking for more like “${topicWord(o)}”.`)}>More like this</button>
              <button type="button" className="btn sm ghost" disabled={lock} onClick={() => save({ excludes: [...new Set([...w.excludes, topicWord(o)])] }, `Ignoring “${topicWord(o)}”.`)}>Ignore</button></div></li>))}</ul>
          : <p className="faint">Nothing found yet. Once it has, you can steer it from here.</p>}
      </section>
    </div>
  );
}
