(function () {
  'use strict';
  // Canvas hero mark for the product pages. Reads <canvas data-mark data-seed="<content hash>">. No network, no dependencies.
  // The still SVG under the canvas (drawn by the server from the same maths) stays visible until the first frame is on screen.
  // The block between BEGIN/END is a copy of web/src/app/mark-core.js; mark-core.test.js keeps the two identical.

  // BEGIN markCore
  const TAU = Math.PI * 2;
  const LIME = [198, 244, 50];
  const BLUE = [127, 182, 207];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // A 32-bit number from any text (FNV-1a). A content hash gives the same number on every machine.
  function seedOf(text) {
    let h = 2166136261;
    const s = String(text == null ? '' : text);
    for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Seeded generator (mulberry32): returns numbers in [0, 1).
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function unitVector(r) {
    const y = r() * 2 - 1;
    const th = r() * TAU;
    const rad = Math.sqrt(1 - y * y);
    return [Math.cos(th) * rad, y, Math.sin(th) * rad];
  }

  // Everything the seed decides: tilt, spin, latitude bands, rings, node phases and arc routes.
  function markParams(seed) {
    const r = rng(seed);
    const span = (a, b) => a + (b - a) * r();
    const params = {
      tiltX: span(0.3, 0.55),
      tiltZ: span(-0.35, 0.35),
      spin: span(0.1, 0.17),
      bandK: 2 + Math.floor(r() * 3),
      bandAmp: span(0.06, 0.15),
      bandPhase: span(0, TAU),
      rings: [],
      nodes: [],
      arcs: [],
    };
    const ringCount = r() < 0.5 ? 2 : 3;
    for (let k = 0; k < ringCount; k++) {
      params.rings.push({
        radius: 1.3 + k * 0.14 + span(0, 0.04),
        tiltX: (k % 2 ? -1 : 1) * span(0.55, 1.2),
        tiltZ: span(-0.8, 0.8),
        dots: 72 + Math.floor(r() * 36),
        speed: (k % 2 ? -1 : 1) * span(0.12, 0.26),
        phase: span(0, TAU),
      });
    }
    const nodeCount = 3 + Math.floor(r() * 3);
    for (let k = 0; k < nodeCount; k++) {
      params.nodes.push({ ring: k % ringCount, phase: span(0, TAU), size: span(2.2, 3.2), pulse: span(0, 1) });
    }
    for (let k = 0; k < 4; k++) {
      let a = unitVector(r);
      let b = unitVector(r);
      for (let guard = 0; guard < 20; guard++) {
        const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        if (d < 0.35 && d > -0.6) break;
        b = unitVector(r);
      }
      const period = span(3.4, 5.8);
      params.arcs.push({ a, b, period, offset: span(0, period) });
    }
    return params;
  }

  // Fibonacci sphere with n points. With params the latitudes are bent a little so that dot density shows bands.
  function spherePoints(n, params) {
    const out = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < n; k++) {
      let y = 1 - (2 * (k + 0.5)) / n;
      if (params) y = clamp(y + params.bandAmp * Math.sin(params.bandK * Math.PI * y + params.bandPhase) * (1 - y * y), -0.999, 0.999);
      const rad = Math.sqrt(1 - y * y);
      out.push([Math.cos(golden * k) * rad, y, Math.sin(golden * k) * rad]);
    }
    return out;
  }

  const rotX = (p, a) => { const c = Math.cos(a); const s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
  const rotY = (p, a) => { const c = Math.cos(a); const s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  const rotZ = (p, a) => { const c = Math.cos(a); const s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };

  // Perspective: the camera sits on the +z axis at distance d. Returns [x, y, scale, z]; a point nearer to the camera has a larger scale.
  function project(p, d) {
    const dist = d || 5;
    const k = dist / (dist - p[2]);
    return [p[0] * k, p[1] * k, k, p[2]];
  }

  // A point on a ring at angle a (radians), before the ring's own tilt is applied by the caller's rotation.
  function ringPoint(ring, a) {
    return rotZ(rotX([Math.cos(a) * ring.radius, 0, Math.sin(a) * ring.radius], ring.tiltX), ring.tiltZ);
  }
  function ringPoints(ring, n, turn) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(ringPoint(ring, (k / n) * TAU + (turn || 0)));
    return out;
  }

  // A point at t in [0, 1] along the great-circle arc from a to b, lifted off the surface in the middle of the way.
  function arcPoint(a, b, t, lift) {
    const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
    const w = Math.acos(dot);
    const sw = Math.sin(w) || 1e-6;
    const ka = Math.sin((1 - t) * w) / sw;
    const kb = Math.sin(t * w) / sw;
    const up = 1 + (lift || 0) * Math.sin(Math.PI * t);
    return [(a[0] * ka + b[0] * kb) * up, (a[1] * ka + b[1] * kb) * up, (a[2] * ka + b[2] * kb) * up];
  }

  // Colour from lime (t = 1, near) to mineral blue (t = 0, far).
  function mixColor(t) {
    const u = clamp(t, 0, 1);
    return [Math.round(BLUE[0] + (LIME[0] - BLUE[0]) * u), Math.round(BLUE[1] + (LIME[1] - BLUE[1]) * u), Math.round(BLUE[2] + (LIME[2] - BLUE[2]) * u)];
  }
  // END markCore

  const DEG = Math.PI / 180;
  const SPHERE_DOTS = 900;
  const MIN_DOTS = 300;
  const BUCKETS = 8;
  const LIGHT = [-0.42, 0.5, 0.76];
  const TRAIL = 12;
  const STILL_TIME = 3.1;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function start(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const params = markParams(seedOf(canvas.getAttribute('data-seed') || ''));
    const wrap = canvas.parentElement;
    const view = { yaw: 0, pitch: 0, vyaw: 0, parX: 0, parY: 0, tgtX: 0, tgtY: 0, drag: false, lx: 0, ly: 0, lt: 0 };
    let w = 0;
    let h = 0;
    let dpr = 1;
    let size = 0;
    let count = SPHERE_DOTS;
    let pts = spherePoints(count, params);
    let glowA = null;
    let glowB = null;
    let time = 0;
    let visible = !('IntersectionObserver' in window);
    let raf = 0;
    let last = 0;
    let ema = 16;
    let frames = 0;
    let drawn = false;
    let sx = new Float32Array(0);
    let sy = new Float32Array(0);
    let sr = new Float32Array(0);
    let sb = new Uint8Array(0);

    function layout() {
      const r = canvas.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (r.width * r.height * dpr * dpr > 3000000) dpr = Math.sqrt(3000000 / (r.width * r.height));
      w = r.width;
      h = r.height;
      size = Math.min(w, h);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = size * 0.5;
      glowA = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, c * 0.95);
      glowA.addColorStop(0, 'rgba(127,182,207,0.10)');
      glowA.addColorStop(0.55, 'rgba(127,182,207,0.035)');
      glowA.addColorStop(1, 'rgba(127,182,207,0)');
      glowB = ctx.createRadialGradient(w / 2, h / 2, size * 0.2, w / 2, h / 2, size * 0.27);
      glowB.addColorStop(0, 'rgba(198,244,50,0)');
      glowB.addColorStop(0.7, 'rgba(198,244,50,0.045)');
      glowB.addColorStop(1, 'rgba(198,244,50,0)');
      return true;
    }

    // Rotation of the sphere's own surface (spin and tilt), then the view (drag and pointer). Columns are the images of the unit axes.
    function matrix(fn) {
      const x = fn([1, 0, 0]);
      const y = fn([0, 1, 0]);
      const z = fn([0, 0, 1]);
      return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
    }
    const viewOf = (p) => rotX(rotY(p, view.yaw + view.parX), view.pitch + view.parY);
    const surfaceOf = (p) => viewOf(rotZ(rotX(rotY(p, time * params.spin), params.tiltX), params.tiltZ));

    const dotAt = (x, y, r) => { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); };

    function draw() {
      const cx = w / 2;
      const cy = h / 2;
      const S = size * 0.255;
      const unit = size / 560;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.fillStyle = glowA;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = glowB;
      ctx.fillRect(0, 0, w, h);

      // sphere: bucket every dot by depth and light, then fill one path per bucket
      const m = matrix(surfaceOf);
      const n = pts.length;
      if (sx.length !== n) { sx = new Float32Array(n); sy = new Float32Array(n); sr = new Float32Array(n); sb = new Uint8Array(n); }
      const scan = Math.sin(time * 0.45) * 0.9;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
        const y = m[3] * p[0] + m[4] * p[1] + m[5] * p[2];
        const z = m[6] * p[0] + m[7] * p[1] + m[8] * p[2];
        const q = project([x, y, z], 5);
        const lit = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
        const band = Math.exp(-((y - scan) * (y - scan)) / 0.012) * 0.22;
        const v = clampNum(0.62 * ((z + 1) / 2) + 0.38 * lit + band, 0, 0.999);
        sx[i] = cx + q[0] * S;
        sy[i] = cy - q[1] * S;
        sr[i] = unit * (0.95 + 1.15 * v) * q[2] * 0.95;
        sb[i] = Math.floor(v * BUCKETS);
      }
      for (let b = 0; b < BUCKETS; b++) {
        const t = (b + 0.5) / BUCKETS;
        const c = mixColor((t - 0.28) * 1.75);
        ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        ctx.globalAlpha = 0.07 + 0.93 * Math.pow(t, 1.7);
        ctx.beginPath();
        for (let i = 0; i < n; i++) if (sb[i] === b) dotAt(sx[i], sy[i], sr[i]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(127,182,207,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, S * 1.025, 0, TAU);
      ctx.stroke();

      // rings: dotted, with a brighter stretch that travels along the ring
      for (let k = 0; k < params.rings.length; k++) {
        const ring = params.rings[k];
        const head = ring.phase + time * ring.speed * 2.2;
        for (let j = 0; j < ring.dots; j++) {
          const a = (j / ring.dots) * TAU;
          const q = project(viewOf(ringPoint(ring, a)), 5);
          const sweep = 0.5 + 0.5 * Math.cos(a - head);
          const back = q[3] < 0 ? 0.38 : 1;
          const depth = (q[3] + 1.8) / 3.6;
          const c = mixColor(k === 0 ? depth * 0.35 : depth * 0.8);
          ctx.globalAlpha = (0.3 + 0.7 * Math.pow(sweep, 2.5)) * back;
          ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
          ctx.beginPath();
          dotAt(cx + q[0] * S, cy - q[1] * S, unit * (1.1 + 0.8 * sweep) * q[2]);
          ctx.fill();
        }
      }

      // arcs that travel between two points of the surface
      ctx.lineCap = 'round';
      for (let k = 0; k < params.arcs.length; k++) {
        const arc = params.arcs[k];
        const u = ((time + arc.offset) % arc.period) / arc.period;
        const head = Math.min(1, u / 0.72);
        const fade = u < 0.72 ? 1 : 1 - (u - 0.72) / 0.28;
        const tail = Math.max(0, head - 0.34);
        const steps = 16;
        let prev = null;
        for (let j = 0; j <= steps; j++) {
          const t = tail + ((head - tail) * j) / steps;
          const q = project(surfaceOf(arcPoint(arc.a, arc.b, t, 0.3)), 5);
          const cur = [cx + q[0] * S, cy - q[1] * S, q[3]];
          if (prev) {
            const f = j / steps;
            const c = mixColor((cur[2] + 1.3) / 2.6);
            ctx.strokeStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
            ctx.globalAlpha = Math.pow(f, 1.4) * 0.95 * fade * (cur[2] < -0.2 ? 0.35 : 1);
            ctx.lineWidth = unit * (0.8 + 1.3 * f);
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(cur[0], cur[1]);
            ctx.stroke();
          }
          prev = cur;
        }
        if (prev && fade > 0) {
          ctx.globalAlpha = 0.9 * fade * (prev[2] < -0.2 ? 0.35 : 1);
          ctx.fillStyle = 'rgb(236,233,225)';
          ctx.beginPath();
          dotAt(prev[0], prev[1], unit * 1.9);
          ctx.fill();
        }
        if (u > 0.72) {
          const q = project(surfaceOf(arc.b), 5);
          if (q[3] > -0.1) {
            const e = (u - 0.72) / 0.28;
            ctx.globalAlpha = (1 - e) * 0.5;
            ctx.strokeStyle = 'rgb(198,244,50)';
            ctx.lineWidth = unit;
            ctx.beginPath();
            ctx.arc(cx + q[0] * S, cy - q[1] * S, unit * (3 + 13 * e), 0, TAU);
            ctx.stroke();
          }
        }
      }

      // nodes on the rings: short fading trail, glow, soft pulse
      for (let k = 0; k < params.nodes.length; k++) {
        const node = params.nodes[k];
        const ring = params.rings[node.ring];
        const dir = ring.speed < 0 ? -1 : 1;
        const base = node.phase + time * ring.speed * 2.6;
        let at = null;
        for (let j = TRAIL; j >= 0; j--) {
          const q = project(viewOf(ringPoint(ring, base - dir * j * 0.05)), 5);
          const x = cx + q[0] * S;
          const y = cy - q[1] * S;
          const back = q[3] < 0 ? 0.4 : 1;
          if (j === 0) { at = [x, y, q[2], q[3]]; break; }
          const f = 1 - j / (TRAIL + 1);
          ctx.globalAlpha = f * f * 0.55 * back;
          ctx.fillStyle = 'rgb(198,244,50)';
          ctx.beginPath();
          dotAt(x, y, unit * node.size * 0.45 * f * q[2]);
          ctx.fill();
        }
        const back = at[3] < 0 ? 0.45 : 1;
        const rad = unit * 15 * at[2];
        const g = ctx.createRadialGradient(at[0], at[1], 0, at[0], at[1], rad);
        g.addColorStop(0, 'rgba(198,244,50,0.34)');
        g.addColorStop(1, 'rgba(198,244,50,0)');
        ctx.globalAlpha = back;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(at[0], at[1], rad, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgb(240,252,200)';
        ctx.beginPath();
        dotAt(at[0], at[1], unit * node.size * at[2] * 0.8);
        ctx.fill();
        const e = (time * 0.42 + node.pulse) % 1;
        ctx.globalAlpha = (1 - e) * 0.32 * back;
        ctx.strokeStyle = 'rgb(198,244,50)';
        ctx.lineWidth = unit;
        ctx.beginPath();
        ctx.arc(at[0], at[1], unit * (5 + 22 * e) * at[2], 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (!drawn) { drawn = true; if (wrap) wrap.classList.add('is-live'); }
    }

    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function step(ts) {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
      if (last && ts - last < 200) {
        ema = ema * 0.92 + (ts - last) * 0.08;
        frames++;
        if (frames > 40 && ema > 24 && count > MIN_DOTS) {
          count = Math.max(MIN_DOTS, Math.floor(count * 0.7));
          pts = spherePoints(count, params);
          frames = 0;
          ema = 16;
        }
      }
      last = ts;
      time += dt;
      // drag inertia, return of the pitch, smoothing of the pointer drift
      if (!view.drag) {
        view.yaw += view.vyaw * dt;
        view.vyaw *= Math.exp(-dt * 2.2);
        view.pitch *= Math.exp(-dt * 0.9);
      }
      const k = 1 - Math.exp(-dt * 4);
      view.parX += (view.tgtX - view.parX) * k;
      view.parY += (view.tgtY - view.parY) * k;
      draw();
      raf = window.requestAnimationFrame(step);
    }

    function kick() {
      if (reduced || raf || !visible || document.hidden || !w) return;
      last = 0;
      raf = window.requestAnimationFrame(step);
    }

    function still() { time = STILL_TIME; draw(); }

    layout();
    if (reduced) {
      if (w) still();
    } else {
      canvas.addEventListener('pointerdown', (e) => {
        view.drag = true;
        view.lx = e.clientX;
        view.ly = e.clientY;
        view.lt = e.timeStamp;
        view.vyaw = 0;
        canvas.classList.add('is-drag');
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone */ }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!view.drag) return;
        const dx = e.clientX - view.lx;
        const dy = e.clientY - view.ly;
        const dt = Math.max(1, e.timeStamp - view.lt) / 1000;
        view.yaw += dx * 0.009;
        view.pitch = clampNum(view.pitch + dy * 0.006, -0.7, 0.7);
        view.vyaw = view.vyaw * 0.6 + ((dx * 0.009) / dt) * 0.4;
        view.lx = e.clientX;
        view.ly = e.clientY;
        view.lt = e.timeStamp;
      });
      const release = () => { view.drag = false; canvas.classList.remove('is-drag'); view.vyaw = clampNum(view.vyaw, -6, 6); };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
      window.addEventListener('pointermove', (e) => {
        if (view.drag) return;
        view.tgtX = clampNum((e.clientX / window.innerWidth - 0.5) * 2, -1, 1) * 8 * DEG;
        view.tgtY = clampNum((e.clientY / window.innerHeight - 0.5) * 2, -1, 1) * 5 * DEG;
      }, { passive: true });
      document.addEventListener('visibilitychange', kick);
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((list) => { visible = list[list.length - 1].isIntersecting; kick(); }, { threshold: 0.01 }).observe(canvas);
      }
    }
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => { if (layout()) { if (reduced) still(); else if (!raf) { draw(); kick(); } } }).observe(canvas);
    } else {
      window.addEventListener('resize', () => { if (layout()) { if (reduced) still(); else draw(); } });
    }
    if (!reduced) { if (w) draw(); kick(); }
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('canvas[data-mark]'), start);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
}());
