// The heavy half of the Overview hero (lazy chunk). Real data in, computed layout, WebGL2 renderer with automatic Canvas 2D fallback.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmt, useApi } from '../../api.js';
import { Icon } from '../../ui.jsx';
import { FlagChips, srcColor, srcShort, when } from '../_evidence-parts.jsx';
import { buildModel, loadAllEvidence, loadLinks, WELLS } from './data.js';
import { drawOverlay } from './overlay.js';
import { Canvas2DRenderer } from './render-2d.js';
import { GLRenderer } from './render-gl.js';
import { DiscScene } from './disc.js';
import { Scene } from './scene.js';
import { ListView } from './ListView.jsx';
import { ROLES, isRecent, lastIngest, roleStates } from './shared.js';
import './hero.css';

const TIERS = [
  { dpr: 2, dust: 700, prov: true, bloom: 3, fx: 1 }, { dpr: 1.5, dust: 450, prov: true, bloom: 2, fx: 0.6 }, { dpr: 1, dust: 250, prov: false, bloom: 1, fx: 0.3 }, { dpr: 1, dust: 120, prov: false, bloom: 0, fx: 0.12 },
];
const keyStr = (k) => (k ? `${k.t}:${k.i}` : '');
const sameKey = (a, b) => keyStr(a) === keyStr(b);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function Card({ k, model, srcInfo, roleState, runId, pinned, onClose, kb, narrow }) {
  const n = k.t === 'ev' ? model.nodes[k.i] : null;
  if (k.t === 'ev') {
    const e = n.e; const t = when(e);
    return (
      <div className="co-card-in">
        <div className="co-card-h"><span className="co-sw" style={{ background: srcColor(e.source_id) }} aria-hidden="true" /><b>{srcShort(e.source_id)}</b><span className="faint">{e.published_at ? 'published' : 'observed'} {fmt.date(t)}</span></div>
        <p className="co-card-t">{e.title}</p>
        <div className="co-card-m">
          <span className="eyebrow">NEAR relevance</span><span className="co-bar" aria-hidden="true"><i style={{ width: `${Math.round(clamp(e.relevance ?? 0, 0, 1) * 100)}%` }} /></span><b className="num">{(e.relevance ?? 0).toFixed(2)}</b>
        </div>
        {e.flags?.length > 0 && <div className="co-card-f"><FlagChips flags={e.flags} /></div>}
        <div className="co-card-l">
          {n.wells.map((l, j) => <span key={j} className="chip">{model.wells[l.w].label}{l.rel !== 'tag' ? ` · ${l.rel}` : ' · tag'}</span>)}
          {!n.linked && <span className="chip">no stored opportunity link</span>}
        </div>
        <p className="co-card-hint faint">{/^[0-9a-f]{64}$/.test(e.content_hash ?? '') ? `glyph from content_hash ${e.content_hash.slice(0, 12)}…` : 'glyph = fingerprint of record fields'}</p>
        {pinned && (
          <div className="co-card-a">
            <a className="btn sm primary" href={`#/radar/${e.id}`}>Open in Radar</a>
            {e.canonical_url && <a className="btn sm" href={e.canonical_url} target="_blank" rel="noopener noreferrer">Original<Icon name="external" size={13} /></a>}
            <button type="button" className="btn sm ghost" onClick={onClose}>Release<kbd>Esc</kbd></button>
          </div>
        )}
        {!pinned && <p className="co-card-hint faint">{kb ? 'Enter pins this node · Esc releases' : 'Click to pin'}</p>}
      </div>
    );
  }
  if (k.t === 'well') {
    const w = model.wells[k.i]; const o = w.opp;
    return (
      <div className="co-card-in">
        <div className="co-card-h"><span className="co-sw ring" aria-hidden="true" /><b>{o ? 'Opportunity hub' : 'Untagged records'}</b></div>
        <p className="co-card-t">{o ? o.title : 'Stored records with no topic tag and no opportunity link.'}</p>
        {o && <div className="co-card-kv"><span className="eyebrow">score</span><b className="num">{o.score.toFixed(2)}</b><span className="eyebrow">confidence</span><b className="num">{o.confidence.toFixed(2)}</b></div>}
        <div className="co-card-kv"><span className="eyebrow">linked records</span><b className="num">{w.linked}</b>{o && <><span className="eyebrow">updated</span><b className="num">{fmt.ago(o.updated_at)}</b></>}</div>
        {o?.warnings?.some((x) => String(x).startsWith('LOW CONFIDENCE')) && <div className="co-card-f"><span className="chip bad"><Icon name="alert" size={12} />low confidence</span></div>}
        {pinned && (
          <div className="co-card-a">
            {o && <a className="btn sm primary" href={`#/opportunity/${o.id}`}>Open dossier</a>}
            <button type="button" className="btn sm ghost" onClick={onClose}>Release<kbd>Esc</kbd></button>
          </div>
        )}
        {!pinned && <p className="co-card-hint faint">{kb ? 'Enter pins this hub' : 'Click to pin'}</p>}
      </div>
    );
  }
  if (k.t === 'src') {
    const s = model.sources[k.i]; const info = srcInfo[k.i] ?? {};
    return (
      <div className="co-card-in">
        <div className="co-card-h"><span className="co-sw" style={{ background: srcColor(s.id) }} aria-hidden="true" /><b>{s.name ?? srcShort(s.id)}</b></div>
        <p className="co-card-t">{info.bad ? `Source status: ${String(info.status).replace('_', ' ')}.` : info.recent ? `Ingested ${fmt.ago(info.last)}: the ring pulses because this is within 20 minutes.` : info.last ? `Quiet: last successful ingest ${fmt.ago(info.last)} (${fmt.date(info.last)}).` : 'No successful ingest recorded.'}</p>
        <div className="co-card-kv"><span className="eyebrow">stored records</span><b className="num">{model.nodes.filter((x) => x.src === k.i).length}</b>{info.run && <><span className="eyebrow">last run</span><b className="num">+{info.run.inserted} new · {info.run.duplicates} dup</b></>}</div>
        {pinned && <div className="co-card-a">{info.docs && <a className="btn sm" href={info.docs} target="_blank" rel="noopener noreferrer">API docs<Icon name="external" size={13} /></a>}<button type="button" className="btn sm ghost" onClick={onClose}>Release<kbd>Esc</kbd></button></div>}
      </div>
    );
  }
  const [rid, label] = ROLES[k.i]; const st = runId ? roleState[rid] ?? 'idle' : 'idle';
  return (
    <div className="co-card-in">
      <div className="co-card-h"><span className={`co-sw role ${st}`} aria-hidden="true" /><b>{label} agent</b><span className={st === 'idle' ? 'faint' : st === 'halted' ? 'bad' : 'ok'}>{st}</span></div>
      <p className="co-card-t">{runId ? (st === 'idle' ? `No event from run ${runId.slice(0, 14)} reports this role yet.` : `State taken from the stored events of run ${runId.slice(0, 14)}.`) : 'No research run is active, so this role stays dark.'}</p>
      {pinned && <div className="co-card-a">{runId && <a className="btn sm primary" href={`#/run/${runId}`}>Open run</a>}<button type="button" className="btn sm ghost" onClick={onClose}>Release<kbd>Esc</kbd></button></div>}
    </div>
  );
}

export default function ConstellationHero({ status, sources, activeRun, opps, calm, full = false, onReady, onStats }) {
  const stage = useRef(null); const glCv = useRef(null); const ovCv = useRef(null); const tip = useRef(null);
  const sceneRef = useRef(null); const scenes = useRef({ disc: null, graph: null }); const latest = useRef({}); const rt = useRef({ hover: null, pinned: null, focus: null, pointer: null, engaged: false, touch: false, tier: undefined, fps: 0 });
  const [rk, setRk] = useState('gl');
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  const [model, setModel] = useState(null);
  const [view, setView] = useState('disc');
  const [hoverK, setHoverK] = useState(null); const [pinnedK, setPinnedK] = useState(null); const [focusK, setFocusK] = useState(null);
  const [filter, setFilter] = useState({ srcOff: new Set(), topicOff: new Set() });
  const [replay, setReplay] = useState({ active: false, playing: false, pos: 0, mode: 'ingest', cur: null });
  const [auto, setAuto] = useState(!calm);
  const [announce, setAnnounce] = useState('');
  const modelReady = Boolean(model);
  const [narrow, setNarrow] = useState(false);
  const known = useRef(null);
  const total = status?.counts?.evidence;

  // run events -> role states (REAL events only; idle when there is no active run)
  const ev = useApi(activeRun ? `/api/runs/${activeRun.id}/events` : '', { poll: 4000, enabled: Boolean(activeRun) });
  const roles = useMemo(() => roleStates(activeRun ? ev.data?.events : null), [activeRun, ev.data]);

  const srcInfo = useMemo(() => (model?.sources ?? []).map((m) => {
    const s = (sources ?? []).find((x) => x.id === m.id); if (!s) return {};
    return { status: s.status, bad: s.status !== 'ok', recent: isRecent(s), last: lastIngest(s), run: s.lastRun, docs: s.docs };
  }), [model, sources]);

  /* ---------- data: all stored evidence + stored links; reloaded when the stored count really changes ---------- */
  const oppKey = (opps ?? []).map((o) => o.id).join(',');
  const load = useCallback(async (fresh) => {
    try {
      const ids = oppKey ? oppKey.split(',') : [];
      const bust = fresh === true ? String(Date.now()) : '';
      const [evidence, lk] = await Promise.all([loadAllEvidence(bust), loadLinks(ids, bust)]);
      setData({ evidence, links: lk.links, linkFail: lk.failed, at: Date.now() }); setErr(null);
    } catch (e) { setErr(e); }
  }, [oppKey]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (data && typeof total === 'number' && total !== data.evidence.length && total !== known.current) { known.current = total; load(true); } }, [total, data, load]);

  const sourceKey = (sources ?? []).map((s) => s.id).join(',');
  const syncScene = useCallback((sc) => { const L = latest.current; if (!sc || !L.model) return; sc.setSources(L.srcInfo ?? []); sc.setRoles(L.roles ?? {}, L.oppId, L.active); sc.setFilter(L.filter ?? { srcOff: new Set(), topicOff: new Set() }); sc.auto = L.auto && !calm; }, [calm]);
  useEffect(() => {
    if (!data) return;
    const m = buildModel({ evidence: data.evidence, opps, links: data.links, sources: (sources ?? []).map((s) => ({ id: s.id, name: s.name })) });
    const first = !latest.current.model; latest.current.model = m;
    const sc = sceneRef.current;
    if (sc && sc.model) {
      const born = sc.setModel(m);
      for (const k of Object.keys(scenes.current)) if (scenes.current[k] !== sc) scenes.current[k] = null; // the other view is rebuilt on demand
      if (born.length) {
        born.forEach((i) => sc.spark(i, sc.t));
        const by = {}; born.forEach((i) => { const s = srcShort(m.nodes[i].e.source_id); by[s] = (by[s] ?? 0) + 1; });
        setAnnounce(`${born.length} new evidence record${born.length > 1 ? 's' : ''} stored: ${Object.entries(by).map(([s, n]) => `${n} from ${s}`).join(', ')}.`);
      }
      syncScene(sc);
    }
    setModel(m);
    onStats?.({ loaded: m.nodes.length, links: m.linkCount, linkFail: data.linkFail });
    if (first) onReady?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sourceKey]);
  useEffect(() => { // opportunity scores refresh without moving anything
    if (!model) return; model.wells.forEach((w) => { w.opp = (opps ?? []).find((o) => o.id === `opp_${w.id}`) ?? w.opp; });
    sceneRef.current?.computeStats?.();
  }, [opps, model]);
  useEffect(() => { Object.assign(latest.current, { srcInfo, roles, oppId: activeRun?.opportunity_id, active: Boolean(activeRun), filter, auto }); syncScene(sceneRef.current); }, [srcInfo, roles, activeRun, filter, auto, model, syncScene]);
  useEffect(() => { const s = sceneRef.current; if (s) { s.pinned = pinnedK; s.focus = focusK; } }, [pinnedK, focusK]);
  useEffect(() => { if (view === 'list') { setHoverK(null); rt.current.hover = null; } }, [view]);

  /* ---------- render loop ---------- */
  useEffect(() => {
    if (view === 'list' || !modelReady || !stage.current) return undefined;
    let teardown = null; const timer = setTimeout(() => { teardown = start(); }, sceneRef.current?.model ? 0 : 90); // yield once so scene layout and GL setup are separate tasks (keeps long tasks short)
    return () => { clearTimeout(timer); teardown?.(); };
    function start() {
    const R = rt.current; const st = stage.current;
    let sc = scenes.current[view];
    if (!sc) { sc = view === 'disc' ? new DiscScene({ calm }) : new Scene({ calm }); sc.setModel(latest.current.model); scenes.current[view] = sc; }
    sceneRef.current = sc; R.pinned = null; R.hover = null; R.focus = null; R.sized = false; setPinnedK(null); setFocusK(null); setHoverK(null); syncScene(sc);
    let renderer;
    try { renderer = rk === 'gl' ? new GLRenderer(glCv.current, { onLost: () => setRk('2d') }) : new Canvas2DRenderer(glCv.current); } catch { if (rk === 'gl') { setRk('2d'); return undefined; } setErr(new Error('Canvas is unavailable in this browser.')); return undefined; }
    const ovx = ovCv.current.getContext('2d');
    let W = 0; let H = 0; const forceTier = Number.isInteger(window.__coTier); /* test hook: pins the quality tier so headless software GL cannot step it down */ let tier = forceTier ? window.__coTier : R.tier ?? (st.clientWidth < 640 || matchMedia('(pointer: coarse)').matches ? 1 : 0); let reserved = []; let raf = 0; let last = 0; let ema = 16.7; let nF = 0; let visible = true; let stopped = false; let fpsT = 0; let fpsN = 0; let uiT = 0; let resT = 0; let cooldown = 0;
    const apply = () => {
      const T = TIERS[tier]; const dpr = Math.min(T.dpr, window.devicePixelRatio || 1);
      renderer.resize(W, H, dpr); renderer.bloom = rk === 'gl' ? T.bloom : (tier === 0 ? 1 : 0);
      ovCv.current.width = Math.round(W * dpr); ovCv.current.height = Math.round(H * dpr); R.dpr = dpr;
      sc.setQuality({ dust: calm ? Math.min(T.dust, 500) : T.dust, prov: T.prov, flat: rk !== 'gl', fx: rk === 'gl' ? T.fx : Math.min(T.fx, 0.3) }); R.tier = tier; st.dataset.tier = String(tier);
    };
    const measure = () => {
      const r = st.getBoundingClientRect(); W = Math.max(2, Math.round(r.width)); H = Math.max(2, Math.round(r.height));
      sc.resize(W, H); sc.onResize(); setNarrow(W < 640);
      if (R.touch && tier === 0) tier = 1;
      apply(); readReserved(); drawNow(performance.now() / 1000, 0);
    };
    const readReserved = () => {
      const wrapEl = st.closest('.co-stagewrap') ?? st; const r0 = st.getBoundingClientRect();
      reserved = [...wrapEl.querySelectorAll('[data-reserve]')].map((el) => { const b = el.getBoundingClientRect(); return { x: b.left - r0.left - 6, y: b.top - r0.top - 4, w: b.width + 12, h: b.height + 8 }; });
    };
    const drawNow = (now, dt) => {
      sc.hover = R.hover; sc.pinned = R.pinned; sc.focus = R.focus; sc.ptr = R.pointer && !R.touch ? R.pointer : null;
      sc.frame(now, dt);
      renderer.draw({ P: sc.P, nP: sc.np, L: sc.L, nL: sc.nl, t: calm ? 0 : sc.fxT ?? now, layerKey: renderer.kind === 'canvas2d' ? sc.layerKey : null, pixStart: sc.pixStart, pixEnd: sc.pixEnd });
      sc.drawOverlay(ovx, { W, H, dpr: R.dpr, reserved, calm, narrow: W < 640 });
      positionTip();
    };
    const positionTip = () => {
      const el = tip.current; if (!el) return; const k = R.pinned ?? R.hover ?? R.focus; if (!k) return;
      if (W < 640) { el.style.transform = ''; return; }
      const p = sc.screenOf(k); if (!p) return; const cw = el.offsetWidth || 300; const ch = el.offsetHeight || 160;
      let x = p.x + p.r + 18; if (x + cw > W - 10) x = p.x - p.r - 18 - cw; x = clamp(x, 10, W - cw - 10);
      let y = clamp(p.y - 28, 64, H - ch - 56); el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    };
    const loop = (ms) => {
      if (stopped) return; raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) { last = 0; return; }
      if (calm && last && ms - last < (R.dragging || R.pointer || sc.replay.active ? 40 : 600)) return; // reduced motion: a still image that only refreshes when something changes or labels' clocks tick
      const now = ms / 1000; const dtMs = last ? ms - last : 16.7; last = ms; const dt = Math.min(0.05, dtMs / 1000);
      // hover pick (mouse only)
      if (R.pointer && !R.dragging && !R.touch) { const k = sc.pick(R.pointer.x, R.pointer.y, false); if (!sameKey(k, R.hover)) { R.hover = k; setHoverK(k); } }
      drawNow(now, dt);
      // adaptive quality: step down when the smoothed frame time stays above ~24 ms (< 42 fps)
      ema = ema * 0.94 + dtMs * 0.06; nF++; fpsN++; if (ms - fpsT > 1000) { R.fps = Math.round((fpsN * 1000) / (ms - fpsT)); st.dataset.fps = String(R.fps); fpsT = ms; fpsN = 0; }
      if (!forceTier && nF > 90 && ema > 24 && tier < TIERS.length - 1 && ms > cooldown) { tier++; cooldown = ms + 2500; apply(); ema = 16.7; nF = 0; }
      if (ms - uiT > 130 && sc.replay.active) { uiT = ms; const cur = sc.replayCurrent(); setReplay((r) => ({ ...r, playing: sc.replay.playing, pos: sc.replay.pos, cur: cur ? { src: srcShort(cur.e.source_id), t: sc.replay.mode === 'ingest' ? cur.t : cur.p, title: cur.e.title } : null })); }
      if (ms - resT > 700) { resT = ms; readReserved(); }
    };
    const ro = new ResizeObserver(() => measure()); ro.observe(st);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); io.observe(st);
    st.dataset.renderer = renderer.kind;
    measure();
    raf = requestAnimationFrame(loop);
    const onVis = () => { last = 0; }; document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); renderer.destroy(); };
    }
  }, [view, modelReady, rk, calm]);

  /* ---------- pointer / wheel / keyboard ---------- */
  useEffect(() => {
    const st = stage.current; if (view === 'list' || !st || !modelReady) return undefined;
    const R = rt.current; const S = () => sceneRef.current; const ptrs = new Map(); let pinch = 0; let moved = 0; let down = null;
    const local = (e) => { const b = st.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top, w: b.width, h: b.height }; };
    const ui = (e) => e.target.closest?.('[data-ui]');
    const pin = (k) => { const sc = S(); R.pinned = k; setPinnedK(k); setFocusK(null); R.focus = null; if (k && sc.focusOn && sc.cam.zoom < 4) { sc.focusOn(k); R.autoZoom = true; } };
    const unpin = () => { const sc = S(); R.pinned = null; setPinnedK(null); if (R.autoZoom) { sc.resetView?.(); R.autoZoom = false; } };
    R.pin = pin; R.unpin = unpin;
    const onDown = (e) => {
      if (ui(e)) return; R.touch = e.pointerType === 'touch'; R.engaged = true;
      st.setPointerCapture?.(e.pointerId); const p = local(e); ptrs.set(e.pointerId, p); moved = 0; down = { ...p }; S().ripple?.(p.x, p.y);
      if (ptrs.size === 1) { S().dragging = true; R.dragging = true; } else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    };
    const onMove = (e) => {
      const sc = S(); const p = local(e);
      if (e.pointerType !== 'touch') { R.pointer = p; sc.pointer((p.x / p.w - 0.5) * 2, (p.y / p.h - 0.5) * 2); }
      if (!ptrs.has(e.pointerId)) return; const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, p);
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) sc.zoom(pinch / d, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch = d; moved += 10; return; }
      const dx = p.x - prev.x; const dy = p.y - prev.y; moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) { if (e.pointerType === 'touch' && sc.kind === 'graph') sc.drag(dx, 0); else sc.drag(dx, dy); }
    };
    const onUp = (e) => {
      const sc = S(); if (ui(e) && !ptrs.has(e.pointerId)) return; const was = ptrs.size; ptrs.delete(e.pointerId); pinch = 0;
      if (ptrs.size === 0) { sc.dragging = false; R.dragging = false; }
      if (was === 1 && moved <= 5 && down) {
        const k = sc.pick(down.x, down.y, e.pointerType === 'touch');
        if (k) { pin(k); if (e.pointerType === 'touch') { R.hover = null; setHoverK(null); } } else unpin();
      }
    };
    const onLeave = (e) => { if (e.pointerType === 'touch') return; R.pointer = null; R.hover = null; setHoverK(null); S().pointer(0, 0); R.engaged = false; };
    const onWheel = (e) => { if (!(e.ctrlKey || e.metaKey || R.engaged)) return; e.preventDefault(); const p = local(e); S().zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0014)), p.x, p.y); R.autoZoom = false; };
    const onKey = (e) => {
      const sc = S(); if (ui(e) && e.target !== st) return;
      const s = 0.12;
      if (e.key === 'ArrowLeft') sc.rotateBy(-s, 0); else if (e.key === 'ArrowRight') sc.rotateBy(s, 0); else if (e.key === 'ArrowUp') sc.rotateBy(0, s * 0.7); else if (e.key === 'ArrowDown') sc.rotateBy(0, -s * 0.7);
      else if (e.key === '+' || e.key === '=') sc.zoom(0.85); else if (e.key === '-' || e.key === '_') sc.zoom(1.18); else if (e.key === 'Home' || e.key === '0') sc.resetView();
      else if (e.key === 'Escape') { unpin(); R.focus = null; setFocusK(null); return; } else return;
      e.preventDefault();
    };
    st.addEventListener('pointerdown', onDown); st.addEventListener('pointermove', onMove); st.addEventListener('pointerup', onUp); st.addEventListener('pointercancel', onUp); st.addEventListener('pointerleave', onLeave);
    st.addEventListener('wheel', onWheel, { passive: false }); st.addEventListener('keydown', onKey);
    return () => { st.removeEventListener('pointerdown', onDown); st.removeEventListener('pointermove', onMove); st.removeEventListener('pointerup', onUp); st.removeEventListener('pointercancel', onUp); st.removeEventListener('pointerleave', onLeave); st.removeEventListener('wheel', onWheel); st.removeEventListener('keydown', onKey); };
  }, [view, modelReady]);

  useEffect(() => { rt.current.pinned = pinnedK; }, [pinnedK]);
  useEffect(() => { rt.current.focus = focusK; }, [focusK]);
  useEffect(() => { rt.current.hover = hoverK; }, [hoverK]);

  /* ---------- keyboard proxies: the most relevant nodes, tabbable ---------- */
  const proxies = useMemo(() => {
    if (!model) return [];
    const out = model.wells.map((w, i) => ({ k: { t: 'well', i }, label: w.opp ? `Opportunity hub: ${w.opp.title}, score ${w.opp.score.toFixed(2)}` : `Untagged records hub, ${w.linked} records` })).filter((_, i) => model.wells[i].opp || model.wells[i].linked);
    model.sources.forEach((s, i) => out.push({ k: { t: 'src', i }, label: `Source: ${s.name ?? srcShort(s.id)}` }));
    const top = model.nodes.map((n, i) => [i, n]).sort((a, b) => b[1].rel - a[1].rel || b[1].p - a[1].p).slice(0, 24);
    top.forEach(([i, n]) => out.push({ k: { t: 'ev', i }, label: `Evidence, relevance ${n.rel.toFixed(2)}, ${srcShort(n.e.source_id)}: ${n.e.title}` }));
    return out;
  }, [model]);

  const toggle = (set, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n; };
  const startReplay = () => { const sc = sceneRef.current; if (!sc) return; setPinnedK(null); sc.startReplay(replay.mode); setReplay((r) => ({ ...r, active: true, playing: true, pos: 0, cur: null })); };
  const rp = (fn) => () => { const sc = sceneRef.current; if (sc) fn(sc); };
  const shown = pinnedK ?? hoverK ?? focusK;
  const kbFocus = !pinnedK && !hoverK && Boolean(focusK);
  const N = model?.nodes.length ?? 0;
  const counts = useMemo(() => {
    if (!model) return { src: {}, top: {} };
    const src = {}; const top = {};
    for (const n of model.nodes) { const s = model.sources[n.src]?.id; src[s] = (src[s] ?? 0) + 1; const w = WELLS[n.primary]; top[w] = (top[w] ?? 0) + 1; }
    return { src, top };
  }, [model]);

  if (err && !model) return <div className="co-hero-msg" role="alert"><b>Could not load the constellation.</b><span className="dim">{err.message}</span><button type="button" className="btn sm" onClick={() => load(true)}>Retry</button></div>;
  if (!model) return <div className="co-hero-msg" role="status"><span className="eyebrow">Computing layout from stored evidence…</span></div>;
  if (!N) return <div className="co-hero-msg"><b>No evidence stored yet</b><span className="dim">The constellation draws real stored evidence only. It appears after the first collection.</span></div>;

  const modeLabel = replay.mode === 'ingest' ? 'ingest order (observed_at)' : 'publication order (published_at)';
  return (
    <div className="co-hero" data-view={view}>
      <div className="co-tools" data-ui data-reserve>
        <div className="co-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'disc'} onClick={() => setView('disc')}>Glyph disc</button>
          <button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>3D graph</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>View as list</button>
        </div>
        <a className="co-ib sq co-fs" href={full ? '#/' : '#/constellation'} aria-label={full ? 'Exit full screen' : 'Open full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{full ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}</svg>
        </a>
        {view !== 'list' && (
          <>
            <button type="button" className="co-ib" aria-pressed={replay.active} onClick={replay.active ? () => { sceneRef.current?.stopReplay(); setReplay((r) => ({ ...r, active: false, playing: false })); } : startReplay}><Icon name="loop" size={15} />{replay.active ? 'Exit replay' : 'Replay ingestion'}</button>
            <div className="co-cam" role="group" aria-label="Camera">
              <button type="button" className="co-ib sq" aria-label={auto ? 'Pause camera orbit' : 'Resume camera orbit'} aria-pressed={auto} onClick={() => setAuto(!auto)} disabled={calm}><Icon name={auto ? 'pause' : 'play'} size={15} /></button>
              <button type="button" className="co-ib sq" aria-label="Zoom in" onClick={rp((s) => s.zoom(0.85))}><span aria-hidden="true">+</span></button>
              <button type="button" className="co-ib sq" aria-label="Zoom out" onClick={rp((s) => s.zoom(1.18))}><span aria-hidden="true">&minus;</span></button>
              <button type="button" className="co-ib" onClick={rp((s) => s.resetView())}>Reset view</button>
            </div>
          </>
        )}
      </div>

      {view === 'list' ? (
        <ListView model={model} srcInfo={srcInfo} filter={filter} />
      ) : (
        <div className={`co-stage ${view}`} ref={stage} tabIndex={0} role="group" aria-roledescription={view === 'disc' ? 'glyph disc' : '3D evidence graph'} aria-label={`Evidence constellation, ${N} stored records. Drag to ${view === 'disc' ? 'pan' : 'rotate'}, Ctrl and wheel or pinch to zoom, arrow keys move, plus and minus zoom, Home resets, Escape releases a pinned node. The list view shows the same data as a table.`}>
          <canvas key={rk} ref={glCv} className="co-cv" role="img" aria-label={`Evidence constellation: ${N} stored evidence records from ${model.sources.length} sources, grouped by ${model.wells.filter((w) => w.linked).length} topics and linked to ${model.wells.filter((w) => w.opp).length} opportunities.`} />
          <canvas ref={ovCv} className="co-cv co-ov" aria-hidden="true" />
          <ul className="co-kb" aria-label="Most relevant nodes. Tab moves through them, Enter pins one, Escape releases it.">
            {proxies.map((p) => (
              <li key={keyStr(p.k)}>
                <button type="button" tabIndex={0} aria-label={p.label}
                  onFocus={() => { setFocusK(p.k); }} onBlur={() => setFocusK((f) => (sameKey(f, p.k) ? null : f))}
                  onClick={() => rt.current.pin?.(p.k)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); rt.current.unpin?.(); setFocusK(null); } }} />
              </li>
            ))}
          </ul>
          {shown && (
            <aside ref={tip} className={`co-card ${pinnedK ? 'pinned' : ''} ${kbFocus ? 'kb' : ''}`} data-ui aria-label={pinnedK ? 'Pinned node details' : 'Node details'}>
              <Card k={shown} model={model} srcInfo={srcInfo} roleState={roles} runId={activeRun?.id} pinned={Boolean(pinnedK) && sameKey(shown, pinnedK)} kb={kbFocus} narrow={narrow}
                onClose={() => rt.current.unpin?.()} />
            </aside>
          )}
          {replay.active && (
            <div className="co-replay" data-ui role="group" aria-label="Replay of stored records">
              <span className="co-badge">REPLAY</span>
              <button type="button" className="co-ib sq" aria-label={replay.playing ? 'Pause replay' : 'Play replay'} onClick={() => { const sc = sceneRef.current; if (sc.replay.pos >= N) sc.seek(0); sc.replay.playing = !sc.replay.playing; setReplay((r) => ({ ...r, playing: sc.replay.playing })); }}><Icon name={replay.playing ? 'pause' : 'play'} size={15} /></button>
              <input type="range" min={0} max={N} step={1} value={Math.floor(replay.pos)} aria-label="Replay position" aria-valuetext={`${Math.floor(replay.pos)} of ${N} stored records`}
                onChange={(e) => { const sc = sceneRef.current; sc.replay.playing = false; sc.seek(Number(e.target.value)); setReplay((r) => ({ ...r, playing: false, pos: Number(e.target.value), cur: (() => { const c = sc.replayCurrent(); return c ? { src: srcShort(c.e.source_id), t: sc.replay.mode === 'ingest' ? c.t : c.p, title: c.e.title } : null; })() })); }} />
              <span className="num co-replay-n">{Math.floor(replay.pos)} / {N}</span>
              <div className="co-seg sm" role="group" aria-label="Replay order">
                <button type="button" aria-pressed={replay.mode === 'ingest'} onClick={() => { const sc = sceneRef.current; sc.setReplayMode('ingest'); setReplay((r) => ({ ...r, mode: 'ingest' })); }}>Ingest order</button>
                <button type="button" aria-pressed={replay.mode === 'published'} onClick={() => { const sc = sceneRef.current; sc.setReplayMode('published'); setReplay((r) => ({ ...r, mode: 'published' })); }}>Publication order</button>
              </div>
              <p className="co-replay-t faint">Replays the stored records in {modeLabel} order. Gaps between records are shortened.{replay.cur ? <> Now: <b>{replay.cur.src}</b> · {fmt.date(replay.cur.t)}</> : null}</p>
            </div>
          )}
        </div>
      )}

      <div className="co-chips" data-ui data-reserve aria-label="Filters">
        <div className="co-chiprow" role="group" aria-label="Filter by source">
          {model.sources.map((s, si) => { const off = filter.srcOff.has(s.id); return (
            <button type="button" key={s.id} className="chip co-chip" aria-pressed={!off} onMouseEnter={() => view !== 'list' && setFocusK({ t: 'src', i: si })} onMouseLeave={() => setFocusK((f) => (f?.t === 'src' && f.i === si ? null : f))} onClick={() => setFilter((f) => ({ ...f, srcOff: toggle(f.srcOff, s.id) }))}><i style={{ background: srcColor(s.id) }} aria-hidden="true" />{srcShort(s.id)}<span className="num">{counts.src[s.id] ?? 0}</span></button>
          ); })}
        </div>
        <div className="co-chiprow" role="group" aria-label="Filter by topic">
          {model.wells.map((w, wi) => { const off = filter.topicOff.has(w.id); return (
            <button type="button" key={w.id} className="chip co-chip" aria-pressed={!off} onMouseEnter={() => view === 'disc' && setFocusK({ t: 'well', i: wi })} onMouseLeave={() => setFocusK((f) => (f?.t === 'well' && f.i === wi ? null : f))} onClick={() => setFilter((f) => ({ ...f, topicOff: toggle(f.topicOff, w.id) }))}>{w.label}<span className="num">{counts.top[w.id] ?? 0}</span></button>
          ); })}
        </div>
      </div>
      {view !== 'list' && (
        <details className="co-legend" data-ui data-reserve>
          <summary>How to read this</summary>
          {view === 'disc' ? (
            <ul>
              <li><b>Glyph:</b> one stored record. The pixel pattern comes from its content hash. Colour is the source, brightness is NEAR relevance, a red ring marks a bot, duplicate or injection flag.</li>
              <li><b>Sectors:</b> primary topic. The arc on the rim fills to that opportunity&rsquo;s score. Newer records sit closer to the rim.</li>
              <li><b>Orbits:</b> sources. The satellite&rsquo;s angle is the UTC time of day of that source&rsquo;s last ingest, and it pulses if that was under 20 minutes ago.</li>
              <li><b>Ribbons:</b> from each source to the topics it fed. Width is the record count.</li>
              <li><b>Pop-up cards:</b> cycle through stored records, most relevant first, one source after another. They are not live events.</li>
              <li><b>Hover or pin a glyph</b> to see its source and every stored opportunity link (colour is the relation). Hover a source or topic chip to see its records and counts.</li>
              <li><b>Gauges:</b> top opportunity score (solid) and confidence (dashed), records per source, share of records with relevance 0.95 or higher.</li>
              <li><b>Agent roles</b> light up only while a run reports them active.</li>
              <li><b>Decoration only:</b> nebula, dust arms, turning rings, hash ring, shockwaves, sweep, comets and cursor sparks carry no data.</li>
            </ul>
          ) : (
            <ul>
              <li><b>Node:</b> one stored record. Size is NEAR relevance, colour is the source, a red ring is a flag. <b>Hub</b> rings: outer arc is the opportunity score, inner arc is confidence.</li>
              <li><b>Edges:</b> stored opportunity links (red contradicts, amber competitor, lime usage) and the source of each record. Positions come from a force layout. The dust is decoration.</li>
            </ul>
          )}
        </details>
      )}
      <div className="sr" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}
