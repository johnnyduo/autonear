import { useEffect, useRef, useState } from 'react';
import { typedCount } from '../../app/live-text.js';
// Tiny, dependency-free helpers shared by the Overview shell (main bundle) and the lazy constellation chunk.
export const RECENT_MS = 20 * 60e3;

/** [role id as stored in run_events.agent_role, label, short label] */
export const ROLES = [
  ['signal_collector', 'Collector', 'COLLECT'], ['evidence_analyst', 'Analyst', 'ANALYSE'], ['skeptic', 'Skeptic', 'SKEPTIC'], ['product_architect', 'Architect', 'DESIGN'],
  ['builder', 'Builder', 'BUILD'], ['security_reviewer', 'Security', 'SECURE'], ['launch_planner', 'Planner', 'PLAN'],
];

export const lastIngest = (s) => Math.max(s.lastSuccess ?? 0, s.lastRun?.status === 'ok' ? (s.lastRun.ended_at ?? 0) : 0);
export const isRecent = (s, now = Date.now()) => { const t = lastIngest(s); return t > 0 && now - t < RECENT_MS; };

/** Role states from the run's REAL event log: working | done | halted | idle. */
export function roleStates(events) {
  const m = Object.fromEntries(ROLES.map(([r]) => [r, 'idle']));
  for (const e of events ?? []) {
    if (!(e.agent_role in m)) continue;
    m[e.agent_role] = e.status === 'started' ? 'working' : e.status === 'completed' ? 'done' : ['failed', 'blocked', 'cancelled', 'dead_letter'].includes(e.status) ? 'halted' : m[e.agent_role];
  }
  return m;
}

/** Eases a whole number from its previous value to `value` (reduced motion: shows it straight away). */
export function CountUp({ value, ms = 900 }) {
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(calm || typeof value !== 'number' ? value : 0); const from = useRef(0);
  useEffect(() => {
    if (typeof value !== 'number' || calm) { setShown(value); return undefined; }
    const a = from.current; const t0 = performance.now(); let raf = 0;
    const step = (now) => { const u = Math.min(1, (now - t0) / ms); const e = 1 - (1 - u) ** 3; const v = Math.round(a + (value - a) * e); from.current = v; setShown(v); if (u < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [value, ms, calm]);
  return shown;
}

export const prefersCalm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Typewriter: returns the visible prefix of `text`. Restarts when `key` changes; shows everything at once when `calm`
 * (default: the reduced-motion setting) or when there is nothing to type. Ticks at about 30 fps and stops on unmount.
 */
export function useTyped(text, { key, cps = 55, calm } = {}) {
  const s = text ?? ''; const instant = calm ?? prefersCalm();
  const [st, setSt] = useState({ k: key, n: instant ? s.length : 0 });
  const t0 = useRef({ k: key, at: 0 });
  useEffect(() => {
    if (instant || !s) { setSt({ k: key, n: s.length }); return undefined; }
    if (t0.current.k !== key || !t0.current.at) t0.current = { k: key, at: performance.now() };
    const step = () => { const n = typedCount(s.length, performance.now() - t0.current.at, cps); setSt((p) => (p.k === key && p.n === n ? p : { k: key, n })); return n >= s.length; };
    if (step()) return undefined;
    const id = setInterval(() => { if (step()) clearInterval(id); }, 33);
    return () => clearInterval(id);
  }, [key, s, instant, cps]);
  if (instant || !s) return s;
  return s.slice(0, st.k === key ? Math.min(st.n, s.length) : 0);
}
