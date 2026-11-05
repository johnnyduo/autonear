// Signal radar: live evidence feed with source filter, debounced search, cursor pagination and provenance drawer.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import { Chip, Empty, ErrorPanel, Icon, Led, SkeletonRows, StaleNote } from '../ui.jsx';
import { EvidenceDrawer, FlagChips, Freshness, Relevance, SourceTag, TOPIC_LABEL, hostOf, srcColor, srcShort, when } from './_evidence-parts.jsx';
import './radar.css';

const PAGE = 40;
const qs = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function useDebounced(v, ms) {
  const [d, set] = useState(v);
  useEffect(() => { const t = setTimeout(() => set(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function Row({ e, onOpen, fresh }) {
  const host = hostOf(e.canonical_url);
  return (
    <li className="rd-li">
      <button type="button" className={`rd-row ${fresh ? 'is-new' : ''}`} data-row onClick={() => onOpen(e)} aria-label={`Open provenance for ${e.title}`}>
        <span className="rd-bar" style={{ background: srcColor(e.source_id) }} aria-hidden="true" />
        <span className="rd-src"><SourceTag id={e.source_id} /><span className="faint mono-v clip">{host}</span></span>
        <span className="rd-main">
          <span className="rd-title">{e.title}</span>
          {e.body_excerpt && <span className="rd-ex">{e.body_excerpt.replace(/\s+/g, ' ').slice(0, 220)}</span>}
          <span className="rd-tags">
            {fresh && <Chip tone="ok">new</Chip>}
            <FlagChips flags={e.flags} />
            {e.tags?.slice(0, 3).map((t) => <Chip key={t}>{TOPIC_LABEL[t] ?? t}</Chip>)}
            {e.tags?.length > 3 && <Chip>+{e.tags.length - 3}</Chip>}
          </span>
        </span>
        <span className="rd-rel"><Relevance value={e.relevance} /></span>
        <span className="rd-when"><Freshness e={e} /><span className="faint mono-v">{e.author ? `by ${e.author}` : ''}</span></span>
      </button>
    </li>
  );
}

export default function Radar({ params, status, token }) {
  const [qRaw, setQRaw] = useState('');
  const q = useDebounced(qRaw.trim(), 300);
  const [source, setSource] = useState('');
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState({ loading: true, error: null, more: false, moreError: null, at: 0 });
  const [fresh, setFresh] = useState(() => new Set());
  const [open, setOpen] = useState(params?.[0] ? { id: params[0] } : null);
  useEffect(() => { if (params?.[0]) setOpen({ id: params[0] }); }, [params]);
  const reqId = useRef(0);
  const cursorRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const filterKey = `${q}|${source}`;

  const load = useCallback(async (reset) => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: reset ? true : s.loading, more: !reset, moreError: null, error: reset ? null : s.error }));
    try {
      const res = await api(`/api/evidence?${qs({ limit: PAGE, q, source, cursor: reset ? '' : cursorRef.current })}`);
      if (id !== reqId.current) return;
      setItems((cur) => (reset ? res.items : [...cur, ...res.items.filter((x) => !cur.some((c) => c.id === x.id))]));
      setCursor(res.nextCursor); cursorRef.current = res.nextCursor;
      setState({ loading: false, error: null, more: false, moreError: null, at: Date.now() });
      if (reset) setFresh(new Set());
    } catch (x) {
      if (id !== reqId.current) return;
      setState((s) => (reset ? { ...s, loading: false, more: false, error: x } : { ...s, more: false, moreError: x }));
    }
  }, [q, source]);

  useEffect(() => { setItems([]); setCursor(null); cursorRef.current = null; load(true); }, [filterKey, load]);

  // Live head refresh: only while the tab is visible; new rows are prepended and marked "new".
  const itemsRef = useRef(items); itemsRef.current = items;
  useEffect(() => {
    const tick = async () => {
      if (document.hidden || state.loading || !itemsRef.current.length) return;
      try {
        const res = await api(`/api/evidence?${qs({ limit: PAGE, q, source })}`);
        const have = new Set(itemsRef.current.map((x) => x.id));
        const add = res.items.filter((x) => !have.has(x.id));
        if (add.length) { setItems((cur) => [...add, ...cur]); setFresh((f) => new Set([...f, ...add.map((x) => x.id)])); }
        setState((s) => ({ ...s, error: null, at: Date.now() }));
      } catch (x) { setState((s) => ({ ...s, error: x })); }
    };
    const t = setInterval(tick, 60000);
    return () => clearInterval(t);
  }, [q, source, state.loading]);

  // Keyboard: j/k or arrows move between rows, "/" focuses search.
  useEffect(() => {
    const f = (ev) => {
      const t = ev.target;
      const typing = t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (ev.key === '/' && !typing && !ev.metaKey && !ev.ctrlKey && !document.querySelector('[role=dialog]')) { ev.preventDefault(); searchRef.current?.focus(); return; }
      if (typing || ev.metaKey || ev.ctrlKey || ev.altKey || document.querySelector('[role=dialog]')) return;
      const dir = ev.key === 'j' || ev.key === 'ArrowDown' ? 1 : ev.key === 'k' || ev.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      const rows = [...(listRef.current?.querySelectorAll('[data-row]') ?? [])];
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement);
      if (i === -1 && !listRef.current.contains(document.activeElement) && ev.key.startsWith('Arrow')) return; // don't hijack page scrolling
      ev.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + dir))];
      next.focus(); next.scrollIntoView({ block: 'nearest' });
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);

  const sources = status?.data?.sources ?? [];
  const total = status?.data?.counts?.evidence;
  const filtered = Boolean(q || source);
  const stale = Boolean(state.error && items.length);
  const bySource = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s])), [sources]);
  const newest = items.length ? Math.max(...items.map(when)) : null;

  return (
    <div className="page rd">
      <header>
        <p className="eyebrow">Signal radar</p>
        <h1 className="display">Everything the ecosystem <em>said</em>, with receipts.</h1>
        <p className="dim rd-lede">Each row is a stored excerpt of a public post, issue or on-chain observation. Open one to see where it came from, its hash, and the stored reasons it counts as NEAR Protocol.</p>
      </header>

      <div className="rd-controls" role="search">
        <div className="field rd-search">
          <label htmlFor="rd-q">Search titles and excerpts</label>
          <div className="rd-input">
            <Icon name="search" size={18} />
            <input id="rd-q" ref={searchRef} className="input" type="search" value={qRaw} onChange={(e) => setQRaw(e.target.value)} placeholder="intents, multisig, near-sdk…  ( / to focus )" autoComplete="off" maxLength={100} />
          </div>
        </div>
        <div className="rd-chips" role="group" aria-label="Filter by source">
          <button type="button" className="rd-chip" aria-pressed={!source} onClick={() => setSource('')}>All sources{total != null && <span className="num faint">{total}</span>}</button>
          {sources.map((s) => (
            <button type="button" key={s.id} className="rd-chip" aria-pressed={source === s.id} onClick={() => setSource(source === s.id ? '' : s.id)} title={s.status !== 'ok' ? `status ${s.status}${s.lastError ? `: ${s.lastError}` : ''}` : `last success ${fmt.ago(s.lastSuccess)}`}>
              <i style={{ background: srcColor(s.id) }} aria-hidden="true" />{srcShort(s.id)}
              <Led tone={s.status === 'ok' ? (s.stale ? 'warn' : 'ok') : 'bad'} />
              <span className="sr">{s.status === 'ok' ? (s.stale ? 'stale' : 'healthy') : s.status}</span>
              <span className="num faint">{fmt.ago(s.lastSuccess)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rd-status mono" aria-live="polite">
        {state.loading ? 'Loading…' : `${items.length}${cursor ? '+' : ''} record${items.length === 1 ? '' : 's'}${filtered ? ' match' : ' loaded'}`}
        {newest && !state.loading && <> · newest {fmt.ago(newest)}</>}
        {stale && <> · <StaleNote at={state.at} /></>}
        {!stale && state.at > 0 && <> · refreshed {fmt.ago(state.at)}</>}
        {filtered && <button type="button" className="btn sm ghost" onClick={() => { setQRaw(''); setSource(''); }}>Clear filters</button>}
      </div>

      {state.loading && !items.length && <SkeletonRows n={6} />}
      {state.error && !items.length && <ErrorPanel error={state.error} onRetry={() => load(true)} what="evidence" />}
      {!state.loading && !state.error && !items.length && (
        filtered
          ? <Empty title="No records match" action={<button className="btn" onClick={() => { setQRaw(''); setSource(''); }}>Clear filters</button>}>Nothing stored for {q ? <>&ldquo;{q}&rdquo;</> : 'this filter'}{source ? <> from {srcShort(source)}</> : null}. Search covers titles and excerpts only.</Empty>
          : <Empty title="No evidence collected yet">The collector has not stored any records. Check source health on the overview, or ask an operator to ingest now.</Empty>
      )}

      {items.length > 0 && (
        <>
          <div className="rd-head" aria-hidden="true"><span>Source</span><span>Record</span><span>NEAR relevance</span><span>Freshness</span></div>
          <ul className="rd-list panel" ref={listRef} aria-label="Evidence records, newest first">
            {items.map((e) => <Row key={e.id} e={e} fresh={fresh.has(e.id)} onOpen={(x) => setOpen(x)} />)}
          </ul>
          <div className="rd-more">
            {state.moreError && <div className="banner risk" role="alert"><Icon name="alert" /><span>Could not load more: {state.moreError.message}</span></div>}
            {cursor ? (
              <button className="btn" onClick={() => load(false)} disabled={state.more}>{state.more ? 'Loading…' : `Load ${PAGE} older`}</button>
            ) : <p className="faint mono">End of stored records{filtered ? ' for this filter' : ''}.</p>}
          </div>
        </>
      )}

      {open && <EvidenceDrawer id={open.id} preview={open} token={token} onClose={() => setOpen(null)} />}
    </div>
  );
}
