// Pure maths for the hero mark on the product pages (no DOM, no canvas). The mark is a dot sphere with orbit rings, orbiting nodes and arcs
// between surface points. web/public/mark.js (the canvas script) is a static file that cannot import, so it carries a copy of the block
// between the BEGIN/END markers; the server renderer imports this module to draw the same mark as a still SVG.
// mark-core.test.js checks the two copies are identical.
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

export { seedOf, rng, markParams, spherePoints, rotX, rotY, rotZ, project, ringPoint, ringPoints, arcPoint, mixColor, TAU };
