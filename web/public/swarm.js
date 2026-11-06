/* AutoNEAR swarm replay. Written for this project; no third-party code, no network access, no dependencies.
 *
 * The server renders a finished page. Every buildable element carries data-sw="box|text|button|line|media" and
 * optionally data-sw-agent="Copy|Layout|Style|Media|Check". This script measures them, hides them, and lets five
 * named cursors bring them back one by one in document order. It is a REPLAY of a stored build, not a model working
 * live, and it says so on screen. It only changes visibility and opacity, never layout.
 *
 * Control: ?still=1 or prefers-reduced-motion show the page as it is. window.AutoSwarm.{play,skip,state}() and
 * postMessage({type:'swarm', cmd:'play'|'skip'|'still'}) from the same origin. State goes to the parent window as
 * {type:'swarm-state', phase:'still'|'running'|'done', progress:0..1, agents:[{name,color,doing}]}.
 */
(function () {
  'use strict';
  const doc = document;
  const win = window;
  const root = doc.documentElement;

  const AGENTS = [
    // `name` is the key used in data-sw-agent and by the planner; `label` is what the page shows (names of the council's agents, colours of the app theme)
    { name: 'Copy', label: 'Analyst', color: '#80d9ff' },
    { name: 'Layout', label: 'Architect', color: '#c6f432' },
    { name: 'Style', label: 'Builder', color: '#f2b84b' },
    { name: 'Media', label: 'Planner', color: '#59ffd1' },
    { name: 'Check', label: 'Security', color: '#ff6b8b' },
  ];
  const NAMES = AGENTS.map((a) => a.name);
  const TASK_MS = 8200; // the build tasks finish inside this window; with the short end it is about 10 s
  const IDLE = 900; // cursors follow the pointer after the build
  const FADE = 400;
  const WATCHDOG = 40000; // the page is never left blank longer than this
  const NOTES = [523.25, 587.33, 659.25, 783.99, 880];

  // The scheduling is pure and tested; the copy below is checked against it by web/src/app/swarm-plan.test.js.
  // BEGIN planTasks (a copy of the block in web/src/app/swarm-plan.js; a test keeps them identical)
  function planTasks(elements, opts) {
    const agents = opts && opts.agents && opts.agents.length ? opts.agents.slice() : ['Copy', 'Layout', 'Style', 'Media', 'Check'];
    const totalMs = opts && opts.totalMs > 0 ? opts.totalMs : 16800;
    const steal = !(opts && opts.steal === false);
    const MIN = 120;
    const MAX = 1800;
    const KIND_AGENT = { text: 'Copy', box: 'Layout', line: 'Style', media: 'Media', button: 'Layout' };
    const BASE = { box: 1, text: 1, button: 0.8, line: 0.7, media: 1.3 };
    const index = {};
    const items = elements.map((el, i) => {
      index[el.id] = i;
      const kind = Object.prototype.hasOwnProperty.call(BASE, el.kind) ? el.kind : 'box';
      let owner = el.agent && agents.indexOf(el.agent) >= 0 ? el.agent : KIND_AGENT[kind];
      if (agents.indexOf(owner) < 0) owner = agents[i % agents.length];
      const len = kind === 'text' ? Math.max(0, el.len || 0) : 0;
      const weight = BASE[kind] + Math.min(len, 400) / 40;
      const parent = el.parent != null && index[el.parent] !== undefined && index[el.parent] < i ? index[el.parent] : -1;
      return { id: el.id, kind, owner, ownerIdx: agents.indexOf(owner), weight, parent, len };
    });
    const n = items.length;
    const queues = agents.map(() => []);
    items.forEach((it, i) => queues[it.ownerIdx].push(i));

    function simulate(unit) {
      const dur = items.map((it) => Math.round(Math.min(MAX, Math.max(MIN, it.weight * unit))));
      const free = agents.map(() => 0);
      const start = new Array(n).fill(-1);
      const end = new Array(n).fill(-1);
      const by = new Array(n).fill(-1);
      const ready = (i) => items[i].parent < 0 || start[items[i].parent] >= 0;
      const ready0 = (i) => (items[i].parent < 0 ? 0 : end[items[i].parent]);
      let left = n;
      let makespan = 0;
      while (left > 0) {
        let best = null;
        const consider = (a, i, stolen) => {
          const s = Math.max(free[a], ready0(i));
          if (!best || s < best.s || (s === best.s && (stolen ? 1 : 0) < (best.stolen ? 1 : 0)) || (s === best.s && stolen === best.stolen && i < best.i)) best = { a, i, s, stolen };
        };
        for (let a = 0; a < agents.length; a++) {
          const q = queues[a];
          let own = -1;
          for (let k = 0; k < q.length; k++) if (start[q[k]] < 0) { own = q[k]; break; }
          if (own >= 0 && ready(own)) consider(a, own, false);
          if (!steal) continue;
          for (let b = 0; b < agents.length; b++) {
            if (b === a) continue;
            for (let k = 0; k < queues[b].length; k++) {
              const i = queues[b][k];
              if (start[i] >= 0 || !ready(i)) continue;
              // help only when this agent can start it strictly earlier than its owner could
              if (Math.max(free[a], ready0(i)) < Math.max(free[b], ready0(i))) consider(a, i, true);
              break;
            }
          }
        }
        if (!best) break;
        start[best.i] = best.s;
        end[best.i] = best.s + dur[best.i];
        by[best.i] = best.a;
        free[best.a] = end[best.i];
        if (end[best.i] > makespan) makespan = end[best.i];
        left--;
      }
      return { dur, start, by, makespan };
    }

    let sim = simulate(MAX / 0.7 + 1);
    if (sim.makespan > totalMs) {
      sim = simulate(0);
      if (sim.makespan > totalMs) {
        // even the shortest allowed tasks do not fit: keep the clamp, the plan runs long
      } else {
        let lo = 0;
        let hi = MAX / 0.7 + 1;
        for (let k = 0; k < 32; k++) {
          const mid = (lo + hi) / 2;
          if (simulate(mid).makespan <= totalMs) lo = mid; else hi = mid;
        }
        sim = simulate(lo);
      }
    }
    return items.map((it, i) => ({
      id: it.id,
      agent: agents[sim.by[i]],
      owner: it.owner,
      start: sim.start[i],
      duration: sim.dur[i],
      kind: it.kind,
      deps: it.parent >= 0 ? [items[it.parent].id] : [],
      stolen: agents[sim.by[i]] !== it.owner,
      len: it.len,
    }));
  }
  // END planTasks

  // ---------- state ----------
  let run = null; // the replay in progress, or null
  let phase = 'still';
  let progress = 0;
  let lastPost = 0;
  let watchdog = 0;
  let styleEl = null;
  let allEls = [];
  const audio = { on: false, ctx: null, noise: null, last: 0, wake: null };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const easeBack = (x) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

  // ---------- messaging ----------
  function post(force) {
    const now = win.performance.now();
    if (!force && now - lastPost < 200) return;
    lastPost = now;
    if (win.parent === win) return;
    try {
      const agents = run ? run.cursors.map((c) => ({ name: c.label, color: c.color, doing: c.doing })) : AGENTS.map((a) => ({ name: a.label, color: a.color, doing: '' }));
      win.parent.postMessage({ type: 'swarm-state', phase, progress: Math.round(progress * 1000) / 1000, agents }, win.location.origin);
    } catch (e) { /* opaque origin or detached parent: nothing to tell */ }
  }
  function setPhase(p) {
    phase = p;
    if (p !== 'running') progress = p === 'done' ? 1 : 0;
    post(true);
  }

  // ---------- styles ----------
  function injectStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = doc.createElement('style');
    styleEl.textContent = [
      'html.sw-on [data-sw]:not(.sw-v){visibility:hidden}',
      '.sw-f{animation:sw-fade .35s ease backwards}',
      '.sw-p{animation:sw-pop .3s ease backwards}',
      '@keyframes sw-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes sw-pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}',
      '.sw-ov{position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:2147483000;transition:opacity ' + FADE + 'ms ease}',
      '.sw-world{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}',
      '.sw-cur{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}',
      '.sw-cur svg{position:absolute;left:0;top:0;width:24px;height:24px;overflow:visible;transform-origin:0 0}',
      '.sw-lab{position:absolute;left:12px;top:15px;padding:2px 7px;border-radius:4px;border:1px solid;background:rgba(8,11,14,.9);font:600 10.5px/14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}',
      '.sw-g{position:absolute;box-sizing:border-box;pointer-events:none}',
      '.sw-caret{position:absolute;width:2px;pointer-events:none}',
      '.sw-tag{position:absolute;left:12px;bottom:12px;padding:5px 10px;border-radius:99px;background:rgba(10,12,15,.82);color:#ece9df;font:500 11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(255,255,255,.18)}',
    ].join('\n');
    (doc.head || root).appendChild(styleEl);
  }

  // ---------- sound (on; a browser keeps it silent until the visitor's first click, tap or key press) ----------
  function audioReady() { return audio.on && audio.ctx && audio.ctx.state === 'running'; }
  function startAudio() {
    if (audio.ctx) return;
    try {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      audio.ctx = new Ctx(); audio.on = true;
      const n = Math.floor(audio.ctx.sampleRate * 0.03);
      audio.noise = audio.ctx.createBuffer(1, n, audio.ctx.sampleRate);
      const d = audio.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const wake = () => { if (audio.ctx && audio.ctx.state === 'suspended') { const r = audio.ctx.resume(); if (r && r.catch) r.catch(() => {}); } };
      wake();
      ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => win.addEventListener(ev, wake, { passive: true }));
      audio.wake = wake;
    } catch (e) { audio.on = false; audio.ctx = null; }
  }
  function tick() {
    if (!audioReady()) return;
    const c = audio.ctx;
    const t = c.currentTime;
    if (t - audio.last < 0.045) return;
    audio.last = t;
    const src = c.createBufferSource();
    src.buffer = audio.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200 + Math.random() * 1800;
    f.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    src.connect(f); f.connect(g); g.connect(c.destination);
    src.start(t);
  }
  function note(i) {
    if (!audioReady()) return;
    const c = audio.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = NOTES[i % NOTES.length];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + 0.45);
  }

  // ---------- cursors ----------
  function svgEl(tag, attrs) {
    const e = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function makeCursor(agent, i) {
    const el = doc.createElement('div');
    el.className = 'sw-cur';
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    const shapes = {
      arrow: svgEl('path', { d: 'M0 0 L0 17 L4.5 13 L7.5 20 L10 19 L7 12 L13 12 Z', fill: agent.color, stroke: '#0a0c0f', 'stroke-width': '1', 'stroke-linejoin': 'round' }),
      cross: svgEl('g', {}),
      ibeam: svgEl('g', {}),
      pen: svgEl('path', { d: 'M0 0 L2 -8 L9 -15 L13 -11 L6 -4 Z', fill: agent.color, stroke: '#0a0c0f', 'stroke-width': '1', 'stroke-linejoin': 'round' }),
    };
    shapes.cross.appendChild(svgEl('path', { d: 'M-9 0 H9 M0 -9 V9', stroke: '#0a0c0f', 'stroke-width': '3.5', 'stroke-opacity': '.6' }));
    shapes.cross.appendChild(svgEl('path', { d: 'M-9 0 H9 M0 -9 V9', stroke: agent.color, 'stroke-width': '1.5' }));
    shapes.ibeam.appendChild(svgEl('path', { d: 'M-3.5 -9 H3.5 M0 -9 V9 M-3.5 9 H3.5', stroke: '#0a0c0f', 'stroke-width': '4', 'stroke-opacity': '.6' }));
    shapes.ibeam.appendChild(svgEl('path', { d: 'M-3.5 -9 H3.5 M0 -9 V9 M-3.5 9 H3.5', stroke: agent.color, 'stroke-width': '1.6' }));
    for (const k in shapes) svg.appendChild(shapes[k]);
    const lab = doc.createElement('span');
    lab.className = 'sw-lab';
    lab.textContent = agent.label;
    lab.style.color = agent.color; lab.style.borderColor = agent.color; lab.style.boxShadow = '0 0 10px ' + agent.color + '55';
    el.appendChild(svg);
    el.appendChild(lab);
    const c = { name: agent.name, label: agent.label, color: agent.color, i, el, svg, shapes, shape: '', scale: 1, x: 0, y: 0, vx: 0, vy: 0, doing: 'idle', busy: false };
    setShape(c, 'arrow');
    return c;
  }
  function setShape(c, s) {
    if (c.shape === s) return;
    c.shape = s;
    for (const k in c.shapes) c.shapes[k].setAttribute('display', k === s ? 'inline' : 'none');
  }
  function drawCursor(c) {
    c.el.style.transform = 'translate3d(' + c.x.toFixed(1) + 'px,' + c.y.toFixed(1) + 'px,0)';
    c.svg.style.transform = c.scale === 1 ? '' : 'scale(' + c.scale.toFixed(3) + ')';
  }
  function spring(c, tx, ty, k, dt) {
    const f = 1 - Math.exp(-k * dt);
    c.x += (tx - c.x) * f;
    c.y += (ty - c.y) * f;
  }

  // ---------- tasks ----------
  const VERB = { box: 'drawing a box', text: 'typing text', line: 'drawing a line', button: 'placing a button', media: 'filling an image' };
  function reveal(el, pop) { el.classList.add('sw-v'); el.classList.add(pop ? 'sw-p' : 'sw-f'); }
  function ghostBox(T, extra) {
    const g = doc.createElement('div');
    g.className = 'sw-g';
    g.style.left = T.r.x + 'px';
    g.style.top = T.r.y + 'px';
    if (extra) for (const k in extra) g.style[k] = extra[k];
    run.world.insertBefore(g, run.curLayer);
    return g;
  }
  function removeGhost(T) { if (T.ghost && T.ghost.parentNode) T.ghost.parentNode.removeChild(T.ghost); T.ghost = null; }

  function begin(T) {
    const c = T.cur;
    T.fx = c.x; T.fy = c.y;
    c.busy = true; c.task = T;
    c.doing = T.kind === 'text' ? 'typing "' + T.text.slice(0, 24) + (T.text.length > 24 ? '...' : '') + '"' : VERB[T.kind];
    follow(T.r);
    const col = c.color;
    if (T.kind === 'box') {
      T.ghost = ghostBox(T, { width: '0px', height: '0px', border: '1px solid ' + col });
    } else if (T.kind === 'line') {
      const horiz = T.r.w >= T.r.h;
      T.ghost = ghostBox(T, { background: col, width: horiz ? '0px' : '2px', height: horiz ? '2px' : '0px' });
      if (horiz) T.ghost.style.top = (T.r.y + T.r.h / 2 - 1) + 'px'; else T.ghost.style.left = (T.r.x + T.r.w / 2 - 1) + 'px';
      T.horiz = horiz;
    } else if (T.kind === 'button') {
      T.ghost = ghostBox(T, { width: T.r.w + 'px', height: T.r.h + 'px', border: '2px solid ' + col, borderRadius: '10px', opacity: '0' });
    } else if (T.kind === 'media') {
      T.ghost = ghostBox(T, { width: T.r.w + 'px', height: T.r.h + 'px', background: 'linear-gradient(135deg,' + col + ',transparent 85%)', clipPath: 'polygon(0 0,0 0,0 0)', opacity: '0.6' });
    } else {
      const cs = T.cs;
      const g = ghostBox(T, {
        width: T.r.w + 'px', fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, textTransform: cs.textTransform, textAlign: cs.textAlign,
        color: cs.color, lineHeight: cs.lineHeight, whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap,
        padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
        border: cs.borderTopWidth + ' solid transparent', textIndent: cs.textIndent,
      });
      T.typed = doc.createElement('span');
      T.rest = doc.createElement('span');
      T.rest.style.visibility = 'hidden'; // the untyped part still takes its space, so lines wrap as they will in the end
      T.rest.textContent = T.text;
      g.appendChild(T.typed); g.appendChild(T.rest);
      T.caret = doc.createElement('div');
      T.caret.className = 'sw-caret';
      T.caret.style.background = col;
      T.caret.style.left = T.r.x + 'px';
      T.caret.style.top = T.r.y + 'px';
      T.caret.style.height = '16px';
      run.world.insertBefore(T.caret, run.curLayer);
      T.ghost = g; T.n = -1; T.cx = T.r.x; T.cy = T.r.y; T.ch = 16;
    }
  }

  function setText(T, n) {
    T.n = n;
    T.typed.textContent = T.text.slice(0, n);
    T.rest.textContent = T.text.slice(n);
    const gb = T.ghost.getBoundingClientRect();
    let rect = null;
    if (n < T.text.length) { const rs = T.rest.getClientRects(); rect = rs[0] ? { x: rs[0].left, y: rs[0].top, h: rs[0].height } : null; }
    if (!rect) { const ts = T.typed.getClientRects(); const l = ts[ts.length - 1]; if (l) rect = { x: l.right, y: l.top, h: l.height }; }
    if (rect) { T.cx = T.r.x + rect.x - gb.left; T.cy = T.r.y + rect.y - gb.top; T.ch = Math.max(8, rect.h); }
    T.caret.style.left = T.cx + 'px';
    T.caret.style.top = T.cy + 'px';
    T.caret.style.height = T.ch + 'px';
  }

  function update(T, p, t) {
    const c = T.cur;
    const r = T.r;
    if (T.kind === 'box') {
      const tr = seg(p, 0, 0.22);
      const e = easeOut(seg(p, 0.22, 0.85));
      if (p < 0.22) { c.x = lerp(T.fx, r.x, easeInOut(tr)); c.y = lerp(T.fy, r.y, easeInOut(tr)); setShape(c, tr > 0.6 ? 'cross' : 'arrow'); } else {
        setShape(c, 'cross');
        T.ghost.style.width = (r.w * e) + 'px'; T.ghost.style.height = (r.h * e) + 'px';
        c.x = r.x + r.w * e; c.y = r.y + r.h * e;
      }
      if (p >= 0.85 && !T.shown) { T.shown = true; reveal(T.el); }
      if (T.ghost) T.ghost.style.opacity = String(1 - seg(p, 0.85, 1));
    } else if (T.kind === 'text') {
      const tr = easeInOut(seg(p, 0, 0.15));
      const ty = seg(p, 0.15, 0.92);
      const n = Math.min(T.text.length, Math.floor(T.text.length * ty));
      if (n !== T.n) { const had = T.n; setText(T, n); if (n > 0 && n !== had && (n % 2 === 0 || n === T.text.length)) tick(); }
      setShape(c, 'ibeam');
      const hx = T.cx + 7; const hy = T.cy + T.ch * 0.5 + 3;
      c.x = p < 0.15 ? lerp(T.fx, hx, tr) : hx;
      c.y = p < 0.15 ? lerp(T.fy, hy, tr) : hy;
      T.caret.style.opacity = ty > 0 && ty < 1 ? '1' : (Math.floor(t / 450) % 2 ? '0' : '1');
    } else if (T.kind === 'line') {
      const e = easeOut(seg(p, 0.2, 0.85));
      setShape(c, 'pen');
      if (p < 0.2) { const tr = easeInOut(p / 0.2); c.x = lerp(T.fx, r.x, tr); c.y = lerp(T.fy, r.y + r.h / 2, tr); } else if (T.horiz) {
        T.ghost.style.width = (r.w * e) + 'px'; c.x = r.x + r.w * e; c.y = r.y + r.h / 2 + Math.sin(p * 40) * 1.5;
      } else { T.ghost.style.height = (r.h * e) + 'px'; c.x = r.x + r.w / 2 + Math.sin(p * 40) * 1.5; c.y = r.y + r.h * e; }
      if (p >= 0.85 && !T.shown) { T.shown = true; reveal(T.el); }
      if (T.ghost) T.ghost.style.opacity = String(1 - seg(p, 0.85, 1));
    } else if (T.kind === 'button') {
      const tr = seg(p, 0, 0.5);
      const hx = r.x + r.w * 0.55; const hy = r.y + r.h * 0.6;
      c.x = lerp(T.fx, hx, easeInOut(tr));
      c.y = lerp(T.fy, hy, easeBack(tr)); // a small overshoot reads as the cursor dropping onto the button
      setShape(c, 'arrow');
      const press = seg(p, 0.5, 0.66);
      c.scale = 1 - 0.18 * Math.sin(press * Math.PI);
      if (p >= 0.6 && !T.shown) { T.shown = true; reveal(T.el, true); }
      const ring = seg(p, 0.6, 1);
      if (T.ghost) { T.ghost.style.opacity = String(ring > 0 ? 0.8 * (1 - ring) : 0); T.ghost.style.transform = 'scale(' + (1 + 0.12 * ring) + ')'; }
    } else if (T.kind === 'media') {
      const e = easeInOut(seg(p, 0.15, 0.8));
      const k = 220 * e;
      T.ghost.style.clipPath = 'polygon(0 0,' + k + '% 0,0 ' + k + '%)';
      setShape(c, 'arrow');
      const f = clamp(k / 200, 0, 1);
      c.x = r.x + r.w * f; c.y = r.y + r.h * f;
      if (p < 0.15) { const tr = easeInOut(p / 0.15); c.x = lerp(T.fx, r.x, tr); c.y = lerp(T.fy, r.y, tr); }
      if (p >= 0.8 && !T.shown) { T.shown = true; reveal(T.el); }
      T.ghost.style.opacity = String(0.6 * (1 - seg(p, 0.8, 1)));
    }
  }

  function finish(T) {
    if (!T.shown) { T.shown = true; reveal(T.el, T.kind === 'button'); }
    removeGhost(T);
    if (T.caret && T.caret.parentNode) T.caret.parentNode.removeChild(T.caret);
    T.caret = null;
    if (T.cur.task === T) { T.cur.busy = false; T.cur.doing = 'idle'; T.cur.scale = 1; T.cur.task = null; }
    if (T.kind === 'box') note(T.cur.i);
  }

  // ---------- following the work ----------
  function follow(r) {
    if (!run || run.userScrolled) return;
    const vh = win.innerHeight;
    const sy = win.pageYOffset;
    if (r.y + Math.min(r.h, 60) > sy + 24 && r.y < sy + vh - 80) return;
    const max = Math.max(0, root.scrollHeight - vh);
    run.goal = clamp(r.y - vh * 0.3, 0, max);
  }

  // ---------- the loop ----------
  function drift(c, t, dt) {
    const sx = win.pageXOffset; const sy = win.pageYOffset;
    const a = t * 0.0007 + c.i * (Math.PI * 2 / 5);
    spring(c, sx + win.innerWidth / 2 + Math.cos(a) * (100 + 30 * (c.i % 2)), sy + win.innerHeight * 0.5 + Math.sin(a) * 70, 2.5, dt);
    setShape(c, 'arrow');
    c.scale = 1;
  }
  function flock(t, dt) {
    const sx = win.pageXOffset; const sy = win.pageYOffset;
    const hasPtr = run.px !== null && t - run.pt < 2500;
    const tx = hasPtr ? run.px + sx : sx + win.innerWidth / 2;
    const ty = hasPtr ? run.py + sy : sy + win.innerHeight * 0.5;
    run.cursors.forEach((c, i) => {
      const a = t * 0.0021 + i * (Math.PI * 2 / 5);
      const rad = 34 + i * 9;
      spring(c, tx + Math.cos(a) * rad, ty + Math.sin(a) * rad, 3 + i * 0.8, dt);
      for (let j = 0; j < run.cursors.length; j++) { // keep them from sitting on top of each other
        if (j === i) continue;
        const o = run.cursors[j]; const dx = c.x - o.x; const dy = c.y - o.y; const d = Math.hypot(dx, dy);
        if (d < 22 && d > 0.01) { c.x += (dx / d) * (22 - d) * 0.12; c.y += (dy / d) * (22 - d) * 0.12; }
      }
      setShape(c, 'arrow'); c.scale = 1; c.doing = 'idle';
    });
  }

  function frame(now) {
    if (!run) return;
    const r = run;
    r.raf = 0;
    try {
      const t = now - r.t0;
      const dt = clamp((now - r.last) / 1000, 0.001, 0.05);
      r.last = now;
      r.world.style.transform = 'translate3d(' + (-win.pageXOffset) + 'px,' + (-win.pageYOffset) + 'px,0)';
      if (r.goal !== null && !r.userScrolled) {
        const sy = win.pageYOffset;
        const ny = sy + (r.goal - sy) * (1 - Math.exp(-4.5 * dt));
        win.scrollTo(win.pageXOffset, Math.abs(r.goal - ny) < 1 ? r.goal : ny);
        if (Math.abs(r.goal - ny) < 1) r.goal = null;
      }
      if (r.stage === 'build') {
        const bt = t;
        for (let k = r.active.length - 1; k >= 0; k--) { // finish what is due first, so a cursor can start its next task in the same frame
          const T = r.active[k];
          const p = clamp((bt - T.start) / T.duration, 0, 1);
          if (p >= 1) { update(T, 1, t); finish(T); r.active.splice(k, 1); } else update(T, p, t);
        }
        while (r.next < r.tasks.length && r.tasks[r.next].start <= bt) {
          const T = r.tasks[r.next++];
          begin(T); r.active.push(T); update(T, clamp((bt - T.start) / T.duration, 0, 0.999), t);
        }
        r.cursors.forEach((c) => { if (!c.busy) drift(c, t, dt); });
        progress = r.span > 0 ? clamp(bt / r.span, 0, 1) : 1;
        if (r.next >= r.tasks.length && r.active.length === 0) {
          r.stage = 'idle'; r.idleAt = t; progress = 1;
          if (r.tag) r.tag.style.display = 'none';
        }
      } else if (r.stage === 'idle') {
        if (!r.ptrOn) { r.ptrOn = true; doc.addEventListener('pointermove', r.onPointer, { passive: true }); }
        flock(t, dt);
        if (t - r.idleAt > IDLE) { r.stage = 'fade'; r.fadeAt = t; r.ov.style.opacity = '0'; }
      } else if (r.stage === 'fade') {
        flock(t, dt);
        if (t - r.fadeAt > FADE) { finishAll('done'); return; }
      }
      r.cursors.forEach(drawCursor);
      post(false);
      r.raf = win.requestAnimationFrame(frame);
    } catch (e) { fail(e); }
  }

  // ---------- start and stop ----------
  function stopRun() {
    if (!run) return;
    const r = run;
    run = null;
    if (r.raf) win.cancelAnimationFrame(r.raf);
    doc.removeEventListener('keydown', r.onKey, true);
    doc.removeEventListener('pointermove', r.onPointer);
    win.removeEventListener('resize', r.onResize);
    win.removeEventListener('wheel', r.onUser);
    win.removeEventListener('touchstart', r.onUser);
    if (r.ov && r.ov.parentNode) r.ov.parentNode.removeChild(r.ov);
    if (audio.wake) { ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => win.removeEventListener(ev, audio.wake)); audio.wake = null; }
    if (audio.ctx) { try { const c = audio.ctx.close(); if (c && c.catch) c.catch(() => {}); } catch (e) { /* already closed */ } audio.ctx = null; audio.on = false; }
  }
  function revealAll() {
    root.classList.remove('sw-on');
    allEls.forEach((el) => { el.classList.remove('sw-v', 'sw-f', 'sw-p'); });
  }
  function finishAll(next) {
    stopRun();
    revealAll();
    win.clearTimeout(watchdog);
    setPhase(next);
  }
  function fail(e) {
    if (win.console && win.console.warn) win.console.warn('swarm: showing the page as it is (' + (e && e.message ? e.message : 'error') + ')');
    finishAll('still');
  }

  function onWatchdog() { if (phase === 'running') finishAll('done'); else revealAll(); }

  function plainText(el, cs) {
    const raw = el.textContent || '';
    return /^pre/.test(cs.whiteSpace) ? raw : raw.replace(/\s+/g, ' ').trim();
  }

  function start() {
    stopRun();
    const els = Array.prototype.slice.call(doc.querySelectorAll('[data-sw]'));
    allEls = els;
    if (!els.length) { revealAll(); setPhase('still'); return; }
    injectStyle();
    els.forEach((el) => el.classList.remove('sw-v', 'sw-f', 'sw-p'));
    root.classList.add('sw-on'); // from here on every [data-sw] without sw-v is hidden
    const sx = win.pageXOffset; const sy = win.pageYOffset;
    const idx = new Map();
    const items = [];
    const meta = [];
    els.forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) { el.classList.add('sw-v'); return; } // not rendered: nothing to build
      let kind = el.getAttribute('data-sw');
      if (kind !== 'box' && kind !== 'text' && kind !== 'button' && kind !== 'line' && kind !== 'media') kind = 'box';
      const cs = win.getComputedStyle(el);
      const text = kind === 'text' ? plainText(el, cs) : '';
      let parent = null;
      for (let p = el.parentElement; p; p = p.parentElement) { const q = p.closest('[data-sw]'); if (!q) break; if (idx.has(q)) { parent = idx.get(q); break; } p = q; }
      const id = 't' + items.length;
      idx.set(el, id);
      const agent = el.getAttribute('data-sw-agent');
      items.push({ id, kind, agent: agent && NAMES.indexOf(agent) >= 0 ? agent : null, parent, len: text.length });
      const fonts = kind === 'text' ? { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, textTransform: cs.textTransform, textAlign: cs.textAlign, color: cs.color, lineHeight: cs.lineHeight, whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap, paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft, borderTopWidth: cs.borderTopWidth, textIndent: cs.textIndent } : null;
      meta.push({ el, kind, text, cs: fonts, r: { x: b.left + sx, y: b.top + sy, w: b.width, h: b.height } });
    });
    if (!items.length) { revealAll(); setPhase('still'); return; }
    const plan = planTasks(items, { agents: NAMES, totalMs: TASK_MS });
    const cursors = AGENTS.map(makeCursor);
    // the cursors start spread along the top of the view and go straight to their first task
    cursors.forEach((c, i) => { c.x = win.pageXOffset + win.innerWidth * (0.28 + 0.11 * i); c.y = win.pageYOffset + 24; });
    const tasks = plan.map((p, i) => Object.assign({ cur: cursors[NAMES.indexOf(p.agent)], shown: false, ghost: null }, meta[i], { start: p.start, duration: p.duration }));
    tasks.sort((a, b) => a.start - b.start);

    const ov = doc.createElement('div');
    ov.className = 'sw-ov';
    ov.setAttribute('data-swarm-overlay', '');
    const world = doc.createElement('div');
    world.className = 'sw-world';
    const curLayer = doc.createElement('div');
    curLayer.className = 'sw-world';
    cursors.forEach((c) => curLayer.appendChild(c.el));
    world.appendChild(curLayer);
    const tag = doc.createElement('div');
    tag.className = 'sw-tag';
    tag.textContent = 'Replay of a stored build';
    ov.appendChild(world);
    ov.appendChild(tag);
    (doc.body || root).appendChild(ov);

    const startW = win.innerWidth;
    const now0 = win.performance.now();
    const r = {
      ov, world, curLayer, tag, cursors, tasks, active: [], next: 0, stage: 'build', t0: now0, last: now0, raf: 0, goal: null, userScrolled: false,
      span: tasks.reduce((m, T) => Math.max(m, T.start + T.duration), 0), px: null, py: 0, pt: 0, ptrOn: false, idleAt: 0, fadeAt: 0,
      onKey: (e) => { if (e.key === 'Escape') skip(); else if (e.key === ' ' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') r.userScrolled = true; },
      onPointer: (e) => { r.px = e.clientX; r.py = e.clientY; r.pt = win.performance.now() - r.t0; },
      onResize: () => { if (win.innerWidth !== startW) skip(); },
      onUser: () => { r.userScrolled = true; },
    };
    const cx = sx + win.innerWidth / 2; const cy = sy + win.innerHeight * 0.45;
    cursors.forEach((c, i) => { c.x = cx + Math.cos(i * 1.256) * 220; c.y = cy + Math.sin(i * 1.256) * 160; drawCursor(c); });
    run = r;
    startAudio();
    doc.addEventListener('keydown', r.onKey, true);
    win.addEventListener('resize', r.onResize);
    win.addEventListener('wheel', r.onUser, { passive: true });
    win.addEventListener('touchstart', r.onUser, { passive: true });
    win.clearTimeout(watchdog);
    watchdog = win.setTimeout(onWatchdog, WATCHDOG);
    setPhase('running');
    r.raf = win.requestAnimationFrame(frame);
  }

  // ---------- public control ----------
  function play() { try { start(); } catch (e) { fail(e); } }
  function skip() { if (run) finishAll('done'); else if (phase === 'running') finishAll('done'); }
  function still() { finishAll('still'); }

  win.AutoSwarm = {
    play,
    skip,
    state: () => ({ phase, progress, agents: run ? run.cursors.map((c) => ({ name: c.label, color: c.color, doing: c.doing })) : AGENTS.map((a) => ({ name: a.label, color: a.color, doing: '' })) }),
  };

  win.addEventListener('message', (e) => {
    if (e.origin !== win.location.origin) return;
    const m = e.data;
    if (!m || m.type !== 'swarm') return;
    if (m.cmd === 'play') play(); else if (m.cmd === 'skip') skip(); else if (m.cmd === 'still') still();
  });

  // ---------- boot ----------
  let wantStill = false;
  try {
    wantStill = new URLSearchParams(win.location.search).get('still') === '1' || (win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { wantStill = false; }

  function boot() {
    if (wantStill || !doc.querySelector('[data-sw]')) { root.classList.remove('sw-on'); setPhase('still'); return; }
    play();
  }
  if (!wantStill) {
    // Hide before the first paint when the script runs early; boot() removes this again if there is nothing to build.
    try { injectStyle(); root.classList.add('sw-on'); } catch (e) { /* ignore */ }
    watchdog = win.setTimeout(onWatchdog, WATCHDOG);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
}());
