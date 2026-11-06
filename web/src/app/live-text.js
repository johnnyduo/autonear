// Pure helpers for the constellation's live text (typewriter timing, agent feed lines, scheduler tick numbers).
// Plain JS, no imports: tested with `npm run test:web`. Everything here only reformats stored data; nothing is invented.

/** Characters visible after `elapsedMs` at `cps` characters per second, clamped to the text length. */
export function typedCount(len, elapsedMs, cps = 55) {
  if (!(len > 0)) return 0;
  return Math.max(0, Math.min(len, Math.floor((Math.max(0, elapsedMs) * cps) / 1000)));
}

export const pad2 = (n) => String(n).padStart(2, '0');
/** hh:mm:ss in the viewer's local time. */
export function clock(ts) {
  if (!Number.isFinite(ts)) return '--:--:--';
  const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** mm:ss until `at` (clamped at 00:00); '--:--' when there is no scheduled time. */
export function countdown(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '--:--';
  const s = Math.max(0, Math.ceil((at - now) / 1000)); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Stored excerpt as shown on a card: whitespace collapsed, trimmed. */
export const excerptOf = (e) => clean(e?.body_excerpt);

/** Numbers of the last scheduler tick: sources ok / fresh (not refetched) / error, ideas rescored, whether it started a run. */
export function tickNumbers(tick) {
  if (!tick || !Array.isArray(tick.sources)) return null;
  const src = tick.sources; const fresh = src.filter((s) => s.status === 'fresh').length; const err = src.filter((s) => s.status === 'error').length;
  return { total: src.length, ok: src.length - err, fresh, err, rescored: tick.opportunities ?? 0, seconds: Math.round((tick.ms ?? 0) / 1000), started: Boolean(tick.auto?.started), reason: clean(tick.auto?.reason), trigger: tick.trigger ?? 'tick', at: tick.at, ms: tick.ms ?? 0 };
}
/** 'held: cooldown' from 'no material change (cooldown active)': the bracketed text if any, else the start of the reason. */
export function shortReason(reason) {
  const r = clean(reason); if (!r) return 'held: no reason stored';
  const m = r.match(/\(([^)]*?)(?:\s+active)?\)/); return `held: ${(m ? m[1] : r).slice(0, 14)}`;
}
export function tickText(tick) {
  const n = tickNumbers(tick); if (!n) return '';
  const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  return `tick (${n.trigger}, ${n.seconds} s): ${plural(n.total, 'source')}, ${n.ok} ok${n.fresh ? ` (${n.fresh} not refetched)` : ''}, ${plural(n.err, 'error')}, ${plural(n.rescored, 'idea')} rescored`;
}

export function eventLine(ev, roleLabel) {
  const who = roleLabel ?? String(ev.agent_role ?? 'agent').replace(/_/g, ' ');
  const d = clean(ev.detail);
  return `${who} ${ev.status}${d ? `: ${d}` : ''}`;
}
/** Second line of an agent card event: `completed · gemini-3 · 1200 tokens · $0.0120`. */
export function eventMeta(ev) {
  const cost = Number.isFinite(ev.cost) ? ev.cost.toFixed(4) : '0.0000';
  return `${ev.status} · ${ev.model || 'no model'} · ${ev.tokens ?? 0} tokens · $${cost}`;
}
export const eventId = (ev) => `ev:${ev.id ?? `${ev.run_id ?? ''}:${ev.stage}:${ev.agent_role}:${ev.status}:${ev.time}`}`;

/**
 * Feed lines from stored data only, oldest first: [{ id, ts, text }].
 * events: run events (newest last), tick: scheduler.lastTick, sources: /api/status sources,
 * roleLabel: role id -> label, srcLabel: source id -> short name, lastIngestOf: source -> ms of its last successful ingest.
 */
export function buildFeedLines({ events, tick, sources, roleLabel, lastIngestOf, srcLabel, maxSources = 4 } = {}) {
  const out = [];
  for (const ev of events ?? []) out.push({ id: eventId(ev), ts: ev.time, text: eventLine(ev, roleLabel?.(ev.agent_role)) });
  if (tick && Number.isFinite(tick.at)) out.push({ id: `tick:${tick.at}`, ts: tick.at, text: tickText(tick) });
  const recent = (sources ?? []).map((s) => [s, lastIngestOf ? lastIngestOf(s) : (s.lastSuccess ?? 0)]).filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).slice(0, maxSources);
  for (const [s, last] of recent) {
    const r = s.lastRun; const nums = r && Number.isFinite(r.inserted) ? `: ${r.fetched ?? 0} fetched, ${r.inserted} new, ${r.duplicates ?? 0} duplicate` : '';
    out.push({ id: `src:${s.id}:${last}`, ts: last, text: `${srcLabel ? srcLabel(s.id) : s.id} ingest ok${nums}` });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
export const feedText = (l) => `${clock(l.ts)} ${l.text}`;

/** 'working' | 'done' | 'halted' | 'idle' for one role id, from run events (a later event wins). */
export function chipState(events, role) {
  let st = 'idle';
  for (const e of events ?? []) if (e.agent_role === role) st = e.status === 'started' ? 'working' : e.status === 'completed' ? 'done' : ['failed', 'blocked', 'cancelled', 'dead_letter'].includes(e.status) ? 'halted' : st;
  return st;
}
