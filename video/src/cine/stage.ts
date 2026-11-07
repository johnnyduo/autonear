import { FPS, H, W } from '../theme';
import { buildTimeline, anchor, prod } from './timeline';
import { cl, eo3, eoBack, lerp, sm } from './kinetic';

/** One continuous "world state". Every scene supplies a function of its own time; the world blends neighbouring scenes so the camera never cuts. */
export type St = {
  az: number; el: number; dist: number; lx: number; ly: number; lz: number; fov: number;
  hVis: number; hx: number; hy: number; hz: number; hs: number; hn: number; hnoise: number; hspin: number;
  pVis: number; pSize: number; wCloud: number; wSphere: number; wField: number; wRing: number; wPillar: number; wCube: number;
  sphR: number; phase: number; ringR: number; cubeS: number; pGrow: number;
  tint: number; warn: number; mirror: number; shock: number; shake: number; flash: number;
};
export const ZERO: St = {
  az: 0, el: 0.1, dist: 11, lx: 0, ly: 0, lz: 0, fov: 38,
  hVis: 0, hx: 0, hy: 0, hz: 0, hs: 1, hn: 2, hnoise: 0.1, hspin: 0,
  pVis: 0.8, pSize: 1, wCloud: 0, wSphere: 0, wField: 0, wRing: 0, wPillar: 0, wCube: 0,
  sphR: 2.6, phase: 0, ringR: 3, cubeS: 2, pGrow: 1,
  tint: 0, warn: 0, mirror: 0, shock: 0, shake: 0, flash: 0,
};
const S = (p: Partial<St>): St => ({ ...ZERO, ...p });
export const FLOOR_Y = -3.1;
export const IDEAS: { id: string; short: string; support: number; verdict: string }[] = [...prod.council].sort((a: any, b: any) => b.support - a.support);
export const pillarAngle = (c: number) => Math.PI / 2 + (c / 7) * Math.PI * 2;
export const pillarHeight = (c: number) => 1.2 + (IDEAS[c].support - 0.6) * 20;
export const PILLAR_R = 3.7;
export const seatAngle = (k: number) => -Math.PI / 2 + (k / 7) * Math.PI * 2;

const A = anchor;
const decay = (t: number, t0: number, k = 4) => (t < t0 ? 0 : Math.exp(-(t - t0) * k));
const flowPhase = (t: number, tM: number) => { let a = 0; for (let x = 0; x < t; x += 0.1) a += 0.1 * 1.5 * (1 - 0.88 * sm((x - tM + 0.2) / 1.0)); return a; };

type Fn = (t: number, d: number) => St;
const STAGES: Record<string, Fn> = {
  ask: (t) => S({ az: 0.3 - 0.04 * t, el: 0.1, dist: 12 - 0.3 * t, pVis: 0.6, wCloud: 1 }),
  crowd: (t) => { const tM = A('crowd', 'months.', 0, 0.75); return S({ az: -0.6 + 0.12 * t, el: 0.22, dist: 10.5 - 0.08 * t, pVis: 0.95, wField: 1, phase: flowPhase(t, tM), pSize: 1.1 }); },
  reveal: (t) => {
    const tR = A('reveal', 'AutoNEAR.', 0, 0.2); const g = sm((t - (tR - 1.4)) / 1.6);
    return S({ az: 0.55 - 0.16 * t, el: 0.15, dist: lerp(12.5, 8.6, eo3((t - tR + 0.4) / 1.4)) - 0.04 * t, wCloud: 1 - g, wSphere: g, sphR: 2.7, pVis: 0.9, hVis: sm((t - tR) / 0.2), hs: 1.45 * eoBack((t - tR) / 0.9), hnoise: 0.07 + 0.3 * (1 - sm((t - tR) / 3)), hspin: 0.4, flash: decay(t, tR, 5) });
  },
  signals: (t) => S({ az: -0.1 + 0.11 * t, el: 0.05 + 0.02 * t, dist: 9.2, ly: 0.2, wSphere: 1, sphR: 2.7, pVis: 1, pSize: 1.2, hVis: 1, hs: lerp(1.45, 0.9, sm(t / 1)), hnoise: 0.07, hspin: 0.3, mirror: 1, flash: decay(t, A('signals', 'light.', 0, 0.9), 2.2) * 0.6 }),
  rank: (t) => { const g = sm(t / 1.3); return S({ az: 0.2 + 0.1 * t, el: 0.3 + 0.02 * t, dist: 11.6, ly: 1.9, wSphere: 1 - g, wPillar: g, pGrow: eo3(t / 1.8), sphR: 2.7, pVis: 1, pSize: 1.15, hVis: 0.7, hs: 0.55, hy: 0.8, hnoise: 0.05, mirror: 0.9 }); },
  council: (t) => {
    const tGo = A('council', 'go.', 0, 0.9); const g = sm(t / 1.2);
    return S({ lx: 1.5, az: 0.1 * t, el: 1.12 - 0.05 * sm((t - tGo) / 1.5), dist: 10.5 - 1.2 * decayUp(t, tGo), wPillar: 1 - g, wRing: g, ringR: 3.1, pVis: 1, pSize: 1.1, hVis: 1, hs: 0.95, hnoise: 0.06, hspin: 0.5, tint: sm((t - tGo) / 0.5), shock: decay(t, tGo, 1.1) , flash: decay(t, tGo, 6) });
  },
  swarm: (t) => S({ az: 0.45 - 0.05 * t, el: 0.1, dist: 12, pVis: 0.45, wCloud: 0.7, wField: 0.3, pSize: 0.8, phase: t * 0.5, tint: 0.5 }),
  contract: (t) => {
    const g = sm(t / 1.2); const tFp = A('contract', 'fingerprint.', 0, 0.55);
    return S({ az: 0.4 + 0.12 * t, el: 0.24, dist: 8.8, wCloud: 1 - g, wCube: g, cubeS: 2.3, pVis: 1, hVis: 1, hn: 7, hs: 1.15, hnoise: 0.015, hspin: 0.35, tint: sm((t - tFp) / 0.6) * 0.8 });
  },
  vault: (t) => {
    const r = [0, 1, 2, 3].map((i) => A('vault', 'Refused.', i, 0.5 + i * 0.12)); const w = Math.max(...r.map((x) => decay(t, x, 3.2)));
    return S({ az: -0.4 + 0.12 * t, el: 0.2, dist: 9.8 - 0.35 * w, wCube: 1, cubeS: 3.1, pVis: 1, hVis: 1, hn: 10, hs: 1.5, hnoise: 0.01, hspin: 0.2, warn: w, shake: w, tint: 0.35 * (1 - w) });
  },
  brake: (t) => { const tB = A('brake', 'brake.', 0, 0.9); return S({ az: 0.05 * t, el: 0.02, dist: 8.3, wRing: 1, ringR: 2.15, pVis: 1, hVis: 0.5, hs: 0.5, hn: 2, hnoise: 0.03, tint: sm((t - A('brake', 'approve.', 0, 0.3)) / 0.9) * 0.9 + 0.1 * sm((t - tB) / 0.5) }); },
  community: (t) => S({ az: 0.2 + 0.14 * t, el: 0.5, dist: 12.5, wRing: 0.85, wCube: 0.15, ringR: 4.5, cubeS: 1.1, pVis: 1, pSize: 1.15, hVis: 0.9, hn: 7, hs: 0.8, hnoise: 0.02, hspin: 0.3, tint: 0.6 }),
  close: (t, d) => { const g = sm(t / 1.4); return S({ az: -0.3 + 0.1 * t, el: 0.1, dist: lerp(8.4, 12.5, sm(t / d)), ly: 0.4, wCube: 0.0, wSphere: g, wRing: 1 - g, ringR: 4.5, sphR: 2.4, pVis: 1, pSize: 1.2, hVis: 1, hs: 0.95, hnoise: 0.07, hspin: 0.3, mirror: sm(t / 2), tint: 0.35 }); },
};
function decayUp(t: number, t0: number) { return t < t0 ? 0 : Math.exp(-(t - t0) * 1.5) * Math.min(1, (t - t0) * 6); }

const TR = 1.0;
const keys = Object.keys(ZERO) as (keyof St)[];
export function stageAt(tg: number): St {
  const sc = buildTimeline().scenes;
  let j = sc.findIndex((s) => tg < (s.from + s.frames) / FPS);
  if (j < 0) j = sc.length - 1;
  const ev = (k: number) => { const s = sc[k]; return STAGES[s.id](Math.max(-1.5, tg - s.from / FPS), s.frames / FPS); };
  const a = ev(j);
  const end = (sc[j].from + sc[j].frames) / FPS;
  const w = j < sc.length - 1 ? sm((tg - (end - TR)) / TR) : 0;
  if (w <= 0) return a;
  const b = ev(j + 1); const out = { ...a };
  for (const k of keys) out[k] = lerp(a[k], b[k], w) as never;
  return out;
}

export type Cam = Pick<St, 'az' | 'el' | 'dist' | 'lx' | 'ly' | 'lz' | 'fov'>;
export function project(st: Cam, p: [number, number, number]): { x: number; y: number; s: number; z: number } {
  const cp = [st.lx + st.dist * Math.cos(st.el) * Math.sin(st.az), st.ly + st.dist * Math.sin(st.el), st.lz + st.dist * Math.cos(st.el) * Math.cos(st.az)];
  let f = [st.lx - cp[0], st.ly - cp[1], st.lz - cp[2]]; const fl = Math.hypot(f[0], f[1], f[2]); f = f.map((v) => v / fl);
  let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[1], r[2]); r = r.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const v = [p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]];
  const z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2]; const x = v[0] * r[0] + v[1] * r[1] + v[2] * r[2]; const y = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
  const tn = Math.tan((st.fov * Math.PI) / 360); const k = H / 2 / tn / z;
  return { x: W / 2 + x * k, y: H / 2 - y * k, s: k, z };
}
export { cl };
