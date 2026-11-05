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
  vault: 'M4 5h16v14H4zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0M7 19v2M17 19v2',
  ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  draw: 'M12 3v11M7.5 10l4.5 4.5 4.5-4.5M4 17v3h16v-3',
  deploy: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9',
  loop: 'M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  bot: 'M5 8h14v10H5zM12 8V4M9.5 13h.01M14.5 13h.01M3 12v3M21 12v3',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
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
/** Who approved a decision. "Approved under mandate:..." (the agent's loop, inside a human-granted mandate) must never look like a human approval. */
export function ApproverBadge({ approver, compact }) {
  if (!approver) return null;
  const m = /^mandate:/.test(approver);
  return m
    ? <span className="chip mandate" title={`Approved by the autonomy loop under ${approver}. No human clicked approve for this decision.`}><Icon name="bot" size={13} />{compact ? 'under mandate' : `approved under ${approver}`}</span>
    : <span className="chip human" title={`Approved by a human: ${approver}`}><Icon name="user" size={13} />{compact ? 'by human' : `approved by human · ${approver}`}</span>;
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
  // Parents pass inline arrows; keeping onClose in a ref means the focus effect runs once per open, not on every parent render
  // (status polling re-rendered the shell every 15 s and yanked focus out of whatever the user was typing in).
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    prev.current = document.activeElement;
    const el = ref.current;
    const focusables = () => [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
    // Initial focus: an explicit [data-autofocus], else the first form control in the body (the palette/token fields), else the first focusable.
    // Without this the Close button, which precedes the content in the DOM, took focus and Ctrl+K then typing went nowhere.
    (el.querySelector('[data-autofocus]') ?? el.querySelector('.dlg-body input:not([disabled]),.dlg-body select:not([disabled]),.dlg-body textarea:not([disabled])') ?? focusables()[0] ?? el).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
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
  }, []);
  const body = (
    <div ref={ref} className={drawer ? 'drawer' : 'dlg'} role="dialog" aria-modal="true" aria-labelledby={tid} tabIndex={-1} style={wide ? { width: 'min(760px,100%)' } : undefined} onClick={(e) => e.stopPropagation()}>
      <div className="row sp" style={{ marginBottom: 16 }}>
        <h2 id={tid} className="h2">{title}</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close dialog"><Icon name="x" size={16} /></button>
      </div>
      <div className="dlg-body">{children}</div>
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
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const emph = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])_(.+?)_(?!\w)/g, '$1<em>$2</em>');
/** Links are cut out first so emphasis never rewrites a URL (snake_case paths), and every attribute value is quote-escaped. */
function inline(s) {
  let out = ''; let last = 0;
  for (const m of s.matchAll(LINK)) { out += emph(s.slice(last, m.index)) + `<a href="${esc(m[2])}" target="_blank" rel="noreferrer noopener">${emph(m[1])}</a>`; last = m.index + m[0].length; }
  return out + emph(s.slice(last));
}
export function Md({ text = '' }) {
  const out = []; let list = null; let k = 0;
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
