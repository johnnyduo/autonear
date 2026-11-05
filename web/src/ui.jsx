// Shared primitives. Every component documents the states it supports: loading / empty / error / stale / disabled / permission.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { fmt } from './api.js';

/* ---------- icons: inline SVG, 24px grid, currentColor (no emoji, no icon font) ---------- */
const P = {
  overview: 'M3 12l9-8 9 8M5 10v10h14V10',
  radar: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l6-6',
  dossier: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  run: 'M5 4v16l14-8z',
  studio: 'M4 5h16v11H4zM8 20h8M12 16v4',
  approve: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12.5l2.5 2.5 4.5-5',
  security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16v.5',
  engine: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4v16l13-8z',
  cmd: 'M9 9h6v6H9zM9 9V6a3 3 0 1 0-3 3h3M15 9h3a3 3 0 1 0-3-3M9 15H6a3 3 0 1 0 3 3M15 15v3a3 3 0 1 0 3-3',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V6a2 2 0 0 1 2-2h11M17 14h.5',
  key: 'M14 10a4 4 0 1 0-3 3.9L13 16h2v2h2v2h3v-3l-6.1-6.1',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9 9h11v11H9zM5 15V4h11',
};
export function Icon({ name, size = 20, label, className }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={P[name] ?? P.alert} />
    </svg>
  );
}

/* ---------- atoms ---------- */
export const Led = ({ tone = 'off', live }) => <span className={`led ${tone} ${live ? 'live' : ''}`} aria-hidden="true" />;
export const Chip = ({ tone, children, title, onClick, ...r }) => {
  const C = onClick ? 'button' : 'span';
  return <C className={`chip ${tone ?? ''}`} title={title} onClick={onClick} {...r}>{children}</C>;
};
export function Status({ state }) {
  const map = { ok: ['ok', 'ok'], succeeded: ['ok', 'succeeded'], completed: ['ok', 'completed'], approved: ['ok', 'approved'], executed: ['ok', 'executed'], verified: ['ok', 'verified'], awaiting_approval: ['warn', 'awaiting you'], pending: ['warn', 'pending'], running: ['ok', 'running'], queued: ['warn', 'queued'], blocked: ['bad', 'blocked'], failed: ['bad', 'failed'], error: ['bad', 'error'], circuit_open: ['bad', 'circuit open'], rejected: ['bad', 'rejected'], expired: ['bad', 'expired'], dead_letter: ['bad', 'dead letter'], cancelled: ['warn', 'cancelled'], budget_exceeded: ['bad', 'over budget'], skipped: ['warn', 'skipped'], unknown: ['', 'unknown'], planned: ['', 'planned'], implemented: ['ok', 'implemented'], not_installed: ['', 'not installed'] };
  const [tone, label] = map[state] ?? ['', state ?? '–'];
  return <Chip tone={tone}><Led tone={tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'off'} live={state === 'running'} />{label}</Chip>;
}
export function Meter({ value = 0, tone, label }) {
  const v = Math.max(0, Math.min(1, value));
  return <div className={`meter ${tone ?? (v < 0.35 ? 'risk' : v < 0.6 ? 'warn' : '')}`} role="meter" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><i style={{ width: `${v * 100}%` }} /></div>;
}
export const CostChip = ({ cost = 0, tokens = 0 }) => <Chip title="Estimated list price; tokens may be approximate">{cost ? fmt.usd(cost) : '$0'} · {tokens} tok</Chip>;
export const Hash = ({ h, n = 8 }) => <span className="mono-v" title={h}>{fmt.short(h, n)}</span>;

export function Panel({ title, aside, tone, children, pad = true, id }) {
  const hid = useId();
  return (
    <section className={`panel ${tone ?? ''}`} aria-labelledby={title ? hid : undefined} id={id}>
      {title && <div className="ph"><h2 id={hid} className="eyebrow" style={{ margin: 0 }}>{title}</h2>{aside}</div>}
      {pad ? <div className="pb">{children}</div> : children}
    </section>
  );
}
export const Skeleton = ({ h = 16, w = '100%', style }) => <div className="skel" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
export function SkeletonRows({ n = 4 }) { return <div className="stack-s" role="status" aria-label="Loading">{Array.from({ length: n }, (_, i) => <Skeleton key={i} h={44} />)}</div>; }
export function Empty({ title, children, action }) { return <div className="empty"><b>{title}</b><span>{children}</span>{action}</div>; }
export function ErrorPanel({ error, onRetry, what = 'data' }) {
  return (
    <div className="banner risk" role="alert">
      <Icon name="alert" />
      <div className="stack-s" style={{ flex: 1 }}>
        <b>Could not load {what}</b>
        <span className="dim">{error?.message ?? 'Unknown error'}{error?.status ? ` (HTTP ${error.status})` : ''}</span>
        {onRetry && <div><button className="btn sm" onClick={onRetry}>Retry</button></div>}
      </div>
    </div>
  );
}
export const StaleNote = ({ at }) => <span className="chip warn" title="The last refresh failed; showing older data">stale · {fmt.ago(at)}</span>;
/** Render children only for an operator; otherwise explain why the control is unavailable (permission state). */
export function NeedsOperator({ token, children, hint = 'Operator token required' }) {
  return token ? children : <span className="chip" title={hint}><Icon name="key" size={14} /> {hint}</span>;
}

/* ---------- dialog: focus trap, Esc closes, focus restored, labelled ---------- */
export function Dialog({ title, onClose, children, wide, drawer }) {
  const ref = useRef(null); const tid = useId(); const prev = useRef(null);
  useEffect(() => {
    prev.current = document.activeElement;
    const el = ref.current;
    const focusables = () => [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
    (focusables()[0] ?? el).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return;
        const first = f[0]; const last = f.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = ''; prev.current?.focus?.(); };
  }, [onClose]);
  const body = (
    <div ref={ref} className={drawer ? 'drawer' : 'dlg'} role="dialog" aria-modal="true" aria-labelledby={tid} tabIndex={-1} style={wide ? { width: 'min(760px,100%)' } : undefined} onClick={(e) => e.stopPropagation()}>
      <div className="row sp" style={{ marginBottom: 16 }}>
        <h2 id={tid} className="h2">{title}</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close dialog"><Icon name="x" size={16} /></button>
      </div>
      {children}
    </div>
  );
  return drawer ? <><div className="scrim" onClick={onClose} style={{ zIndex: 54 }} />{body}</> : <div className="scrim" onClick={onClose}>{body}</div>;
}

/* ---------- toasts ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, set] = useState([]);
  const push = useCallback((msg, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    set((x) => [...x.slice(-3), { id, msg, tone }]);
    setTimeout(() => set((x) => x.filter((t) => t.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------- tiny markdown (headings, lists, links, bold): enough for briefs; escapes everything else ---------- */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export function Md({ text = '' }) {
  const out = []; let list = null; let k = 0;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  const flush = () => { if (list) { out.push(<ul key={k++} dangerouslySetInnerHTML={{ __html: list.map((i) => `<li>${inline(i)}</li>`).join('') }} />); list = null; } };
  for (const line of text.split('\n')) {
    if (/^# /.test(line)) { flush(); out.push(<h1 key={k++}>{line.slice(2)}</h1>); }
    else if (/^## /.test(line)) { flush(); out.push(<h2 key={k++}>{line.slice(3)}</h2>); }
    else if (/^(- |\d+\. )/.test(line)) { (list ??= []).push(line.replace(/^(- |\d+\. )/, '')); }
    else if (line.trim()) { flush(); out.push(<p key={k++} className="dim" dangerouslySetInnerHTML={{ __html: inline(line) }} />); }
  }
  flush();
  return <div className="md">{out}</div>;
}

/* ---------- command palette (Cmd/Ctrl+K) ---------- */
export function CommandPalette({ commands, onClose }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0);
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const run = (c) => { onClose(); c.run(); };
  return (
    <Dialog title="Command palette" onClose={onClose}>
      <div className="field">
        <label htmlFor="pal">Jump to or run</label>
        <input id="pal" className="input" value={q} autoComplete="off" placeholder="radar, approval, pause…" onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } if (e.key === 'Enter' && list[i]) run(list[i]); }}
          role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={list[i] ? `pal-${i}` : undefined} />
      </div>
      <div className="pal-list" id="pal-list" role="listbox">
        {list.map((c, n) => <button key={c.label} id={`pal-${n}`} role="option" aria-selected={n === i} className="pal-item" onMouseEnter={() => setI(n)} onClick={() => run(c)}><span>{c.label}</span><span className="mono faint">{c.hint}</span></button>)}
        {!list.length && <Empty title="No match">Try another word.</Empty>}
      </div>
    </Dialog>
  );
}

/** Reduced motion + low-power signal for animated visuals. */
export function useCalm() {
  const [calm, set] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const m = matchMedia('(prefers-reduced-motion: reduce)'); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return calm;
}
