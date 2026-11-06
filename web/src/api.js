import { useCallback, useEffect, useRef, useState } from 'react';

// ---- operator token: sessionStorage only (cleared with the tab). Wrapped: storage can throw (private mode, blocked). ----
const KEY = 'autonear.operator';
let memToken = '';
const subs = new Set();
export const getToken = () => { try { return sessionStorage.getItem(KEY) || memToken; } catch { return memToken; } };
export const setToken = (t) => { memToken = t; try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } subs.forEach((f) => f()); };
export function useToken() {
  const [t, set] = useState(getToken());
  useEffect(() => { const f = () => set(getToken()); subs.add(f); return () => subs.delete(f); }, []);
  return t;
}

/** Fixture mode (dev/screenshots only) is reachable solely through an explicit `fixture=1` query inside the hash. */
export const isFixtureMode = () => { try { return /[?&]fixture=1(?:&|$)/.test(location.hash || ''); } catch { return false; } };

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

export async function api(path, { method = 'GET', body, idem, signal } = {}) {
  // Safety net: while fixture data is on screen NO mutation can leave the browser, whatever component asks for it.
  if (method !== 'GET' && isFixtureMode()) throw new ApiError('Fixture mode: no request was sent. Nothing can be changed from fixture data.', 0, 'fixture');
  const headers = {};
  const tok = getToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idem) headers['idempotency-key'] = idem;
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError('Network error: the AutoNEAR API is unreachable.', 0, 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data?.code);
  return data;
}

/**
 * GET with caching-by-path, abort on unmount, and visibility-aware polling (no background polling in hidden tabs).
 * Returns { data, error, loading, stale, reload, at }.  `stale` = last fetch failed but older data is still shown.
 */
const cache = new Map();
export function useApi(path, { poll = 0, enabled = true } = {}) {
  const [state, set] = useState(() => ({ data: cache.get(path)?.data ?? null, error: null, loading: enabled && !cache.has(path), at: cache.get(path)?.at ?? 0 }));
  const alive = useRef(true); const pathRef = useRef(path); pathRef.current = path; // an answer for an older path is cached but not shown
  const load = useCallback(async () => {
    if (!enabled || !path) return;
    try {
      const data = await api(path);
      cache.set(path, { data, at: Date.now() });
      if (alive.current && pathRef.current === path) set({ data, error: null, loading: false, at: Date.now() });
      return data;
    } catch (e) { if (alive.current && pathRef.current === path && e.name !== 'AbortError') set((s) => ({ ...s, error: e, loading: false })); }
    return null;
  }, [path, enabled]);
  useEffect(() => {
    alive.current = true;
    set((s) => ({ data: cache.get(path)?.data ?? null, error: null, loading: enabled && !cache.has(path), at: cache.get(path)?.at ?? 0 }));
    load();
    let timer;
    const tick = () => { if (!document.hidden) load(); };
    if (poll) timer = setInterval(tick, poll);
    const vis = () => { if (!document.hidden && poll) load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', vis); };
  }, [path, poll, enabled, load]);
  return { ...state, stale: Boolean(state.error && state.data), reload: load };
}

export const fmt = {
  ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
  },
  until(ts) {
    if (!ts) return '–';
    const s = Math.round((ts - Date.now()) / 1000);
    if (s <= 0) return 'due now'; if (s < 3600) return `in ${Math.ceil(s / 60)}m`; return `in ${Math.round(s / 3600)}h`;
  },
  date: (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '–'),
  short: (h, n = 10) => (h ? (h.length > n * 2 + 1 ? `${h.replace(/^sha256:/, '').slice(0, n)}…${h.slice(-4)}` : h) : '–'),
  pct: (x) => `${Math.round((x ?? 0) * 100)}%`,
  usd: (x) => `$${(x ?? 0).toFixed(4)}`,
};
