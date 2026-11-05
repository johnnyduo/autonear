// Deterministic layout in 3D. Everything here is COMPUTED from the stored records and their stored links; it is not a simulation of anything real.
//  - wells (topic / opportunity hubs): a Fibonacci sphere relaxed so hubs that share evidence sit closer;
//  - sources: four emitters on an outer shell;
//  - evidence nodes: spring toward the hubs they are linked to + short-range repulsion + a weak pull toward their source.
import { hash32, unit } from './data.js';

const R_WELL = 0.6; const R_SRC = 1.2;

export function wellAnchors(model) {
  const W = model.wells.length; const p = new Float32Array(W * 3);
  for (let i = 0; i < W; i++) { // Fibonacci lattice
    const y = 1 - (2 * (i + 0.5)) / W; const r = Math.sqrt(1 - y * y); const a = i * 2.399963;
    p[i * 3] = Math.cos(a) * r * R_WELL; p[i * 3 + 1] = y * R_WELL * 0.82; p[i * 3 + 2] = Math.sin(a) * r * R_WELL;
  }
  // shared-evidence affinity: how many records link to both hubs
  const aff = new Float32Array(W * W); let maxA = 1;
  for (const n of model.nodes) { if (n.wells.length < 2) continue; for (let a = 0; a < n.wells.length; a++) for (let b = a + 1; b < n.wells.length; b++) { const i = n.wells[a].w; const j = n.wells[b].w; if (i === j) continue; aff[i * W + j]++; aff[j * W + i]++; maxA = Math.max(maxA, aff[i * W + j]); } }
  for (let it = 0; it < 160; it++) {
    for (let i = 0; i < W; i++) for (let j = 0; j < W; j++) {
      if (i === j) continue;
      const dx = p[j * 3] - p[i * 3]; const dy = p[j * 3 + 1] - p[i * 3 + 1]; const dz = p[j * 3 + 2] - p[i * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz + 1e-4; const d = Math.sqrt(d2);
      const f = -0.0022 / d2 + (aff[i * W + j] / maxA) * 0.012 * (d - 0.45);
      p[i * 3] += (dx / d) * f; p[i * 3 + 1] += (dy / d) * f; p[i * 3 + 2] += (dz / d) * f;
    }
    for (let i = 0; i < W; i++) { // keep each hub on its shell
      const l = Math.hypot(p[i * 3], p[i * 3 + 1] * 1.2, p[i * 3 + 2]) || 1; const k = R_WELL / l;
      p[i * 3] *= k; p[i * 3 + 1] *= k; p[i * 3 + 2] *= k;
    }
  }
  return p;
}

export function sourceAnchors(n) {
  const p = new Float32Array(n * 3);
  const T = [[1, 0.9, 1], [1, -0.9, -1], [-1, 0.9, -1], [-1, -0.9, 1]];
  for (let i = 0; i < n; i++) {
    let v;
    if (n === 4) v = T[i];
    else { const y = 1 - (2 * (i + 0.5)) / n; const r = Math.sqrt(1 - y * y); const a = i * 2.399963; v = [Math.cos(a) * r, y, Math.sin(a) * r]; }
    const l = Math.hypot(v[0], v[1], v[2]);
    p[i * 3] = (v[0] / l) * R_SRC; p[i * 3 + 1] = (v[1] / l) * R_SRC; p[i * 3 + 2] = (v[2] / l) * R_SRC;
  }
  return p;
}

/** Node state. `prev` (Map id -> [x,y,z]) keeps existing nodes where they were when the model is rebuilt after a poll. */
export function createNodes(model, wp, sp, prev) {
  const N = model.nodes.length; const pos = new Float32Array(N * 3); const vel = new Float32Array(N * 3); const fresh = new Uint8Array(N);
  model.nodes.forEach((n, i) => {
    const old = prev?.get(n.id);
    if (old) { pos.set(old, i * 3); return; }
    fresh[i] = 1;
    const s = n.src * 3; const j = (k) => (unit(hash32(`${n.id}:${k}`)) - 0.5) * 0.16;
    pos[i * 3] = sp[s] * 0.96 + j(0); pos[i * 3 + 1] = sp[s + 1] * 0.96 + j(1); pos[i * 3 + 2] = sp[s + 2] * 0.96 + j(2);
  });
  model.nodes.forEach((n, i) => { n.rest = 0.1 + 0.1 * (1 - Math.min(1, n.rel)) + 0.06 * unit(n.h); });
  return { pos, vel, fresh, N };
}

export function stepNodes(model, st, wp, sp, alpha) {
  const { pos, vel, N } = st; const nodes = model.nodes; const W = model.wells.length;
  const CUT2 = 0.26 * 0.26;
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; let fx = 0; let fy = 0; let fz = 0; const ix = i * 3;
    const x = pos[ix]; const y = pos[ix + 1]; const z = pos[ix + 2];
    const nl = n.wells.length;
    for (let k = 0; k < nl; k++) {
      const w = n.wells[k].w * 3; const dx = wp[w] - x; const dy = wp[w + 1] - y; const dz = wp[w + 2] - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5; const rest = nl > 1 ? n.rest * 0.6 : n.rest;
      const f = ((d - rest) / d) * (0.07 / nl);
      fx += dx * f; fy += dy * f; fz += dz * f;
    }
    const s = n.src * 3; fx += (sp[s] - x) * 0.006; fy += (sp[s + 1] - y) * 0.006; fz += (sp[s + 2] - z) * 0.006;
    for (let w = 0; w < W; w++) { // hubs repel records that are not theirs (soft), and keep a clear core
      const dx = x - wp[w * 3]; const dy = y - wp[w * 3 + 1]; const dz = z - wp[w * 3 + 2]; const d2 = dx * dx + dy * dy + dz * dz + 1e-6;
      if (d2 < 0.0049) { const d = Math.sqrt(d2); const f = (0.07 - d) * 0.5 / d; fx += dx * f; fy += dy * f; fz += dz * f; }
    }
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const dx = x - pos[j * 3]; const dy = y - pos[j * 3 + 1]; const dz = z - pos[j * 3 + 2]; const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > CUT2) continue;
      const f = 0.00045 / (d2 + 0.0008);
      fx += dx * f; fy += dy * f; fz += dz * f;
    }
    vel[ix] = (vel[ix] + fx * alpha) * 0.8; vel[ix + 1] = (vel[ix + 1] + fy * alpha) * 0.8; vel[ix + 2] = (vel[ix + 2] + fz * alpha) * 0.8;
  }
  for (let i = 0; i < N * 3; i++) pos[i] += vel[i];
}

export const roleRing = (i, n, t) => { // outer ring, tilted; angular drift is ambient only
  const a = (i / n) * Math.PI * 2 + t * 0.09; const r = 1.55; const tilt = 0.42;
  const x = Math.cos(a) * r; const z0 = Math.sin(a) * r;
  return [x, z0 * Math.sin(tilt), z0 * Math.cos(tilt)];
};
