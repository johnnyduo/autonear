// Shared building blocks for RunTheater / Studio / Approval. Prefixed with "_" so it is never mistaken for a routed view.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon, useToast } from '../ui.jsx';
import './run.css';

/** Wall-clock tick for countdowns. Real time only; stops when the tab is hidden. */
export function useNow(ms = 1000) {
  const [t, set] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => { if (!document.hidden) set(Date.now()); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ms]);
  return t;
}

export const dur = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '–';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(a)}ms`;
  if (a < 60_000) return `${(a / 1000).toFixed(a < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(a / 60_000); const s = Math.round((a % 60_000) / 1000);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const countdown = (ts, now) => {
  const ms = ts - now;
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
};
export const cap = (s) => String(s ?? '').replace(/_/g, ' ');

export function PageHead({ eyebrow, title, em, children, aside }) {
  return (
    <header className="rh">
      <div className="rh-main">
        {eyebrow && <div className="eyebrow rh-eye">{eyebrow}</div>}
        <h1 className="display">{title}{em && <> <em>{em}</em></>}</h1>
        {children && <div className="rh-sub">{children}</div>}
      </div>
      {aside && <div className="rh-aside">{aside}</div>}
    </header>
  );
}

export function CopyButton({ text, label = 'Copy', aria }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch { toast('Clipboard is not available here: select the text and copy it manually.', 'bad'); }
  };
  return <button type="button" className="btn sm copy-btn" onClick={copy} aria-label={`${aria ?? label}${done ? ' (copied)' : ''}`}><Icon name={done ? 'check' : 'copy'} size={14} />{done ? 'Copied' : label}</button>;
}

/** A value shown in full (wrapping), never truncated: hashes and addresses are only useful complete. */
export function Full({ v, copy }) {
  if (v == null || v === '') return <span className="faint">–</span>;
  return <span className="full"><span className="mono-v">{v}</span>{copy && <CopyButton text={String(v)} />}</span>;
}

/** Pass/fail list. Never colour alone: every row carries an icon AND the words pass / fail. */
export function Checks({ items, empty = 'No checks recorded.' }) {
  if (!items?.length) return <p className="faint">{empty}</p>;
  return (
    <ul className="checks">
      {items.map((c, i) => (
        <li key={`${c.name}-${i}`} className={c.ok ? 'ok' : 'bad'}>
          <span className="chk-ic"><Icon name={c.ok ? 'check' : 'x'} size={14} /><span className="chk-w">{c.ok ? 'pass' : 'fail'}</span></span>
          <span className="chk-body"><span>{c.name}</span>{c.detail || c.value ? <span className="mono-v faint chk-d">{c.detail || c.value}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

/** Accessible tabs (WAI-ARIA tabs pattern: roving tabindex, Arrow/Home/End). */
export function Tabs({ tabs, value, onChange, label }) {
  const id = useId(); const refs = useRef({});
  const idx = tabs.findIndex((t) => t.id === value);
  const key = (e) => {
    let n = idx;
    if (e.key === 'ArrowRight') n = (idx + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1; else return;
    e.preventDefault(); onChange(tabs[n].id); refs.current[tabs[n].id]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={key}>
      {tabs.map((t) => (
        <button key={t.id} id={`${id}-t-${t.id}`} ref={(el) => { refs.current[t.id] = el; }} role="tab" aria-selected={t.id === value} aria-controls={`${id}-p-${t.id}`} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}>
          {t.label}{t.badge != null && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
/** Update the hash without firing `hashchange` (the shell scrolls to top on it). */
export function replaceHash(h) { try { history.replaceState(null, '', h); } catch { /* ignore */ } }

export async function sha256Text(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Inline definition list; hides rows with no value only when `hide` is set. */
export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.filter((r) => r && !r.hide).map(([k, v]) => <div className="kv-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function useStableCallback(fn) {
  const ref = useRef(fn); ref.current = fn;
  return useCallback((...a) => ref.current(...a), []);
}
