// Overview building blocks. The Constellation is a canvas of REAL evidence (latest 100 records) with strict honesty rules:
//  - a source ring pulses only if that source ingested successfully in the last 20 minutes;
//  - agent-role nodes light only while status.activeRun exists, and only the role the run events say is working;
//  - nodes never move; nothing animates for ambience.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, useApi } from '../api.js';
import { Empty, ErrorPanel, Skeleton, useCalm } from '../ui.jsx';
import { TOPIC_LABEL, TOPIC_ORDER, srcColor, srcShort } from './_evidence-parts.jsx';

export const RECENT_MS = 20 * 60e3;
const ROLES = [['signal_collector', 'Collector'], ['evidence_analyst', 'Analyst'], ['skeptic', 'Skeptic'], ['product_architect', 'Architect'], ['builder', 'Builder'], ['security_reviewer', 'Security'], ['launch_planner', 'Planner']];
const ROLE_SHORT = { signal_collector: 'COLLECT', evidence_analyst: 'ANALYSE', skeptic: 'SKEPTIC', product_architect: 'DESIGN', builder: 'BUILD', security_reviewer: 'SECURE', launch_planner: 'PLAN' };
const CLUSTERS = [...TOPIC_ORDER, 'untagged'];
const SHORT = { treasury: 'Treasury', intents: 'Intents', signing: 'Signing', wallet_ux: 'Wallet UX', dev_tooling: 'Dev tools', data_indexing: 'Data/RPC', ai_agents: 'AI agents', untagged: 'Untagged' };

export const lastIngest = (s) => Math.max(s.lastSuccess ?? 0, s.lastRun?.status === 'ok' ? (s.lastRun.ended_at ?? 0) : 0);
export const isRecent = (s, now = Date.now()) => { const t = lastIngest(s); return t > 0 && now - t < RECENT_MS; };

const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const unit = (h) => h / 4294967296;

/** role states from the run's real event log: working | done | halted | idle */
export function roleStates(events) {
  const m = Object.fromEntries(ROLES.map(([r]) => [r, 'idle']));
  for (const e of events ?? []) {
    if (!(e.agent_role in m)) continue;
    m[e.agent_role] = e.status === 'started' ? 'working' : e.status === 'completed' ? 'done' : ['failed', 'blocked', 'cancelled', 'dead_letter'].includes(e.status) ? 'halted' : m[e.agent_role];
  }
  return m;
}

function derive(items) {
  const byCluster = Object.fromEntries(CLUSTERS.map((c) => [c, []]));
  const counts = {}; // source -> cluster -> n
  for (const e of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const primary = (e.tags ?? []).find((t) => TOPIC_ORDER.includes(t)) ?? 'untagged';
    byCluster[primary].push(e);
    ((counts[e.source_id] ??= {})[primary] = (counts[e.source_id][primary] ?? 0) + 1);
  }
  return { byCluster, counts };
}

function layout(model, sources, W, H) {
  const narrow = W < 600;
  const M = narrow ? 0 : Math.min(176, W * 0.17);
  const top = narrow ? 64 : 0; const bot = narrow ? 64 : 0;
  const cx = W / 2; const cy = top + (H - top - bot) / 2;
  const rx = narrow ? W * 0.32 : (W - 2 * M) * 0.34; const ry = (H - top - bot) * (narrow ? 0.3 : 0.3);
  const R = Math.max(18, Math.min(rx * (narrow ? 0.38 : 0.32), ry * 0.42));
  const hubs = {}; const nodes = [];
  CLUSTERS.forEach((c, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / CLUSTERS.length;
    const hx = cx + Math.cos(a) * rx; const hy = cy + Math.sin(a) * ry;
    hubs[c] = { x: hx, y: hy, a, n: model.byCluster[c].length };
    const list = model.byCluster[c];
    list.forEach((e, k) => {
      const h = hash(e.id); const ang = k * 2.39996 + unit(h) * 0.7;
      const rad = R * Math.sqrt((k + 0.6) / Math.max(list.length, 1)) * (0.85 + 0.3 * unit(Math.imul(h, 2654435761) >>> 0));
      nodes.push({ e, c, x: hx + Math.cos(ang) * rad, y: hy + Math.sin(ang) * rad, r: 1.8 + (e.relevance ?? 0) * 2, color: srcColor(e.source_id), flagged: Boolean(e.flags?.length) });
    });
  });
  const anchors = {};
  sources.forEach((s, i) => {
    anchors[s.id] = narrow
      ? { x: 28 + (i + 0.5) * ((W - 56) / Math.max(sources.length, 1)) - 14, y: 26, side: 'top' }
      : { x: 26, y: H * (0.2 + (0.6 * (i + 0.5)) / Math.max(sources.length, 1)), side: 'left' };
  });
  const roles = {};
  ROLES.forEach(([r], i) => {
    roles[r] = narrow
      ? { x: 22 + (i + 0.5) * ((W - 44) / ROLES.length) - 11, y: H - 26, side: 'bottom' }
      : { x: W - 26, y: H * (0.14 + (0.72 * (i + 0.5)) / ROLES.length), side: 'right' };
  });
  return { W, H, narrow, M, cx, cy, R, hubs, nodes, anchors, roles };
}

function paint(ctx, L, S, t, animate, col) {
  const { W, H } = L; const now = Date.now();
  ctx.clearRect(0, 0, W, H);
  ctx.font = `500 ${L.narrow ? 9.5 : 10.5}px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,Menlo,monospace`;
  ctx.textBaseline = 'middle';
  const maxN = Math.max(1, ...Object.values(S.model.counts).flatMap((o) => Object.values(o)));

  // source -> cluster bundles (alpha = share of that source's records in that topic)
  for (const s of S.sources) {
    const a = L.anchors[s.id]; if (!a) continue;
    for (const [c, n] of Object.entries(S.model.counts[s.id] ?? {})) {
      const h = L.hubs[c]; if (!h) continue;
      ctx.strokeStyle = srcColor(s.id); ctx.globalAlpha = 0.05 + 0.3 * (n / maxN); ctx.lineWidth = 0.6 + 1.6 * (n / maxN);
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      const mx = (a.x + h.x) / 2; ctx.bezierCurveTo(mx, a.y, mx, h.y, h.x, h.y); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // node -> hub and cross-topic links
  ctx.lineWidth = 0.5;
  for (const n of L.nodes) {
    const h = L.hubs[n.c];
    ctx.strokeStyle = col.chalk; ctx.globalAlpha = 0.08; ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(n.x, n.y); ctx.stroke();
    for (const t2 of (n.e.tags ?? []).slice(1)) {
      const h2 = L.hubs[t2]; if (!h2 || t2 === n.c) continue;
      ctx.globalAlpha = 0.04; ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(h2.x, h2.y); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // hubs + labels
  for (const c of CLUSTERS) {
    const h = L.hubs[c]; const active = S.activeTopic === c;
    ctx.beginPath(); ctx.arc(h.x, h.y, active ? 5 : 3, 0, 7); ctx.fillStyle = active ? col.signal : col.line; ctx.fill();
    ctx.strokeStyle = active ? col.signal : col.dim; ctx.lineWidth = 1; ctx.stroke();
    const lab = `${SHORT[c].toUpperCase()} ${h.n}`;
    const tw = ctx.measureText(lab).width; const below = Math.sin(h.a) > 0.3;
    const lx = Math.max(tw / 2 + 4, Math.min(W - tw / 2 - 4, h.x));
    ctx.textAlign = 'center'; ctx.fillStyle = active ? col.signal : col.dim; const off = (h.n ? L.R * 1.2 : 0) + 12; ctx.fillText(lab, lx, Math.max(10, Math.min(L.H - 10, below ? h.y + off + 2 : h.y - off)));
  }
  // evidence nodes
  for (const n of L.nodes) {
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fillStyle = n.color; ctx.globalAlpha = 0.92; ctx.fill();
    if (n.flagged) { ctx.globalAlpha = 1; ctx.strokeStyle = col.risk; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2, 0, 7); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;

  // active-run flow: hub of the run's topic -> roles (solid = done, dashed moving = working)
  const hub = S.activeTopic && L.hubs[S.activeTopic];
  if (S.active && hub) {
    for (const [r] of ROLES) {
      const st = S.roles[r]; if (st === 'idle') continue;
      const p = L.roles[r];
      ctx.beginPath(); ctx.moveTo(hub.x, hub.y); const mx = (hub.x + p.x) / 2; ctx.bezierCurveTo(mx, hub.y, mx, p.y, p.x, p.y);
      ctx.strokeStyle = st === 'halted' ? col.risk : col.signal; ctx.lineWidth = st === 'working' ? 1.6 : 1; ctx.globalAlpha = st === 'working' ? 0.9 : 0.35;
      ctx.setLineDash(st === 'working' ? [6, 6] : []); ctx.lineDashOffset = st === 'working' && animate ? -t / 40 : 0; ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // source anchors
  for (const s of S.sources) {
    const a = L.anchors[s.id]; if (!a) continue;
    const recent = isRecent(s, now); const bad = s.status !== 'ok';
    if (recent) {
      ctx.strokeStyle = col.signal; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(a.x, a.y, 11, 0, 7); ctx.stroke();
      if (animate) { const ph = (t / 2400) % 1; ctx.globalAlpha = 0.7 * (1 - ph); ctx.beginPath(); ctx.arc(a.x, a.y, 11 + 12 * ph, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    } else { ctx.strokeStyle = bad ? col.risk : col.dim; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(a.x, a.y, 10, 0, 7); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(a.x, a.y, 5.5, 0, 7); ctx.fillStyle = srcColor(s.id); ctx.fill();
    const when = lastIngest(s);
    const l1 = srcShort(s.id).toUpperCase(); const l2 = bad ? s.status : when ? `${fmt.ago(when)}${s.lastRun?.status === 'ok' ? ` +${s.lastRun.inserted}` : ''}` : 'never';
    if (a.side === 'left') { ctx.textAlign = 'left'; ctx.fillStyle = col.chalk; ctx.fillText(l1, a.x + 20, a.y - 7); ctx.fillStyle = recent ? col.signal : bad ? col.risk : col.dim; ctx.fillText(l2, a.x + 20, a.y + 8); }
    else { ctx.textAlign = 'center'; ctx.fillStyle = col.chalk; ctx.fillText(l1.length > 9 ? l1.slice(0, 8) + '.' : l1, a.x, a.y + 22); }
  }
  // agent roles
  for (const [r, label] of ROLES) {
    const p = L.roles[r]; const st = S.active ? S.roles[r] : 'idle';
    const lit = st === 'working' || st === 'done'; const tone = st === 'halted' ? col.risk : col.signal;
    if (st === 'working' && animate) { const ph = (t / 1600) % 1; ctx.strokeStyle = tone; ctx.globalAlpha = 0.7 * (1 - ph); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 8 + 10 * ph, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.beginPath(); ctx.rect(p.x - 5, p.y - 5, 10, 10); ctx.fillStyle = lit || st === 'halted' ? tone : col.panel; ctx.fill();
    ctx.strokeStyle = lit || st === 'halted' ? tone : col.dim; ctx.lineWidth = st === 'working' ? 2 : 1; ctx.stroke();
    if (p.side === 'right') { ctx.textAlign = 'right'; ctx.fillStyle = lit ? col.chalk : col.dim; ctx.fillText(label.toUpperCase(), p.x - 16, p.y - (st !== 'idle' ? 7 : 0)); if (st !== 'idle') { ctx.fillStyle = tone; ctx.fillText(st === 'working' ? 'working' : st === 'done' ? 'done' : 'halted', p.x - 16, p.y + 8); } }
    else { ctx.textAlign = 'center'; ctx.fillStyle = lit ? col.chalk : col.dim; ctx.fillText(ROLE_SHORT[r], p.x, p.y - 17); }
  }
}

export function Constellation({ items, sources, activeRun, loading, error, onRetry }) {
  const wrap = useRef(null); const cv = useRef(null); const calm = useCalm();
  const [size, setSize] = useState({ w: 0, h: 0 }); const [visible, setVisible] = useState(true); const [hidden, setHidden] = useState(document.hidden);
  const ev = useApi(activeRun ? `/api/runs/${activeRun.id}/events` : '', { poll: 4000, enabled: Boolean(activeRun) });
  const roles = useMemo(() => roleStates(activeRun ? ev.data?.events : null), [activeRun, ev.data]);
  const model = useMemo(() => derive(items ?? []), [items]);
  const topic = activeRun?.opportunity_id?.replace(/^opp_/, '');
  const S = useRef({}); S.current = { model, sources: sources ?? [], active: Boolean(activeRun), roles, activeTopic: topic };
  const lay = useRef(null); const raf = useRef(0);

  useEffect(() => {
    const el = wrap.current; if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) })); ro.observe(el);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting)); io.observe(el);
    const vis = () => setHidden(document.hidden); document.addEventListener('visibilitychange', vis);
    return () => { ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, [loading, items?.length]);

  const anyRecent = (sources ?? []).some((s) => isRecent(s));
  const anyWorking = Boolean(activeRun) && Object.values(roles).includes('working');
  const animate = !calm && visible && !hidden && (anyRecent || anyWorking);

  useEffect(() => {
    const c = cv.current; if (!c || !size.w || !size.h) return undefined;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(c);
    const g = (n) => cs.getPropertyValue(n).trim();
    const col = { signal: g('--signal'), risk: g('--risk'), chalk: g('--chalk'), dim: g('--chalk-3'), line: g('--line-hi'), panel: g('--ink-0') };
    lay.current = layout(S.current.model, S.current.sources, size.w, size.h);
    let last = 0; let stop = false;
    const frame = (ts) => {
      if (stop) return;
      if (!animate) { paint(ctx, lay.current, S.current, ts, false, col); return; }
      if (ts - last >= 33) { last = ts; paint(ctx, lay.current, S.current, ts, true, col); } // ~30fps cap
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
    document.fonts?.ready.then(() => { if (!stop && !animate) requestAnimationFrame((ts) => paint(ctx, lay.current, S.current, ts, false, col)); });
    return () => { stop = true; cancelAnimationFrame(raf.current); };
  }, [size, animate, model, sources, activeRun, roles, calm]);

  const sum = useMemo(() => {
    const n = items?.length ?? 0;
    const cl = CLUSTERS.map((c) => [c, model.byCluster[c].length]).filter(([, k]) => k);
    return { n, cl };
  }, [items, model]);

  if (loading && !items) return <Skeleton h={420} />;
  if (error && !items) return <ErrorPanel error={error} onRetry={onRetry} what="evidence for the constellation" />;
  if (!items?.length) return <Empty title="No evidence stored yet">The constellation draws real stored evidence only. It appears after the first collection.</Empty>;

  const src = sources ?? [];
  const recents = src.filter((s) => isRecent(s)); const working = Object.entries(roles).filter(([, v]) => v === 'working').map(([r]) => ROLES.find((x) => x[0] === r)[1]);
  const aria = `Evidence constellation: ${sum.n} latest evidence records from ${src.length} sources grouped into ${sum.cl.length} topic clusters. ${recents.length ? `${recents.length} source${recents.length > 1 ? 's' : ''} ingested in the last 20 minutes.` : 'No source has ingested in the last 20 minutes.'} ${activeRun ? `A research run is ${activeRun.state}.` : 'No research run is active.'}`;

  return (
    <figure className="ov-const">
      <div className="constellation ov-canvas" ref={wrap}>
        <canvas ref={cv} role="img" aria-label={aria} />
      </div>
      <div className="sr">
        <p>{aria}</p>
        <ul>
          {sum.cl.map(([c, k]) => <li key={c}>{TOPIC_LABEL[c] ?? c}: {k} records</li>)}
          {src.map((s) => <li key={s.id}>{srcShort(s.id)}: status {s.status}, last ingest {fmt.ago(lastIngest(s))}{isRecent(s) ? ', recent' : ''}</li>)}
          {activeRun ? <li>Active run {activeRun.id} on {topic}: {working.length ? `${working.join(', ')} working` : 'no agent role reported as working'}</li> : <li>No active run: agent roles idle</li>}
        </ul>
      </div>
      <figcaption className="ov-legend">
        <ul className="ov-leg-src" aria-label="Sources">
          {src.map((s) => (
            <li key={s.id}><i style={{ background: srcColor(s.id) }} aria-hidden="true" /><b>{srcShort(s.id)}</b>
              <span className={isRecent(s) ? 'ok' : s.status !== 'ok' ? 'bad' : 'faint'}>{s.status !== 'ok' ? s.status : isRecent(s) ? `ingested ${fmt.ago(lastIngest(s))}: ring pulses` : `quiet · last ${fmt.ago(lastIngest(s))}`}</span></li>
          ))}
        </ul>
        <p className="faint ov-leg-note">
          Dots are the latest {sum.n} stored records, placed by a fixed hash of their id inside their primary topic; size is NEAR relevance; a red ring marks a bot, duplicate or injection flag.
          A source ring pulses only if it ingested within 20 minutes. Agent roles light only while a run is active{activeRun ? `: ${working.length ? working.join(', ') + ' working now' : 'run is ' + activeRun.state + ', no role reported working'}` : ' (none now)'}.
          {calm && ' Motion is off (reduced-motion).'}
        </p>
      </figcaption>
    </figure>
  );
}
