import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

/* Shared helpers for the v3 (constellation) scenes. Canvas drawing is a pure function of the frame, so renders are deterministic. */
export const CY: [number, number, number] = [38, 230, 255];
export const MG: [number, number, number] = [255, 56, 200];
export const VI: [number, number, number] = [143, 82, 255];
export const SG: [number, number, number] = [198, 244, 50];
export const WH: [number, number, number] = [250, 246, 255];
export const rgba = (c: number[], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
export const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const cl = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const easeOut = (t: number) => 1 - Math.pow(1 - cl(t), 3);
export const easeInOut = (t: number) => { const x = cl(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/** A full-frame 2D canvas. draw(ctx, frame, w, h) runs on every frame. */
export const Cv: React.FC<{ draw: (ctx: CanvasRenderingContext2D, frame: number, w: number, h: number) => void; style?: React.CSSProperties }> = ({ draw, style }) => {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  React.useLayoutEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    draw(ctx, frame, width, height);
  });
  return <canvas ref={ref} width={width} height={height} style={{ position: 'absolute', inset: 0, ...style }} />;
};

/** Golden-spiral dot sphere: x,y,z in [-1,1], tier 0..3 (size), phase. */
export const dotSphere = (n: number, seed: number) => {
  const out: { x: number; y: number; z: number; tier: number; ph: number }[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2; const rr = Math.sqrt(1 - y * y); const ph = i * 2.399963229728653; const u = hash(i + seed);
    out.push({ x: rr * Math.cos(ph), y, z: rr * Math.sin(ph), tier: u < 0.5 ? 0 : u < 0.8 ? 1 : u < 0.955 ? 2 : 3, ph: hash(i * 3 + seed) * 6.28 });
  }
  return out;
};

/** Draw a rotating glowing dot sphere. */
export const drawSphere = (ctx: CanvasRenderingContext2D, pts: ReturnType<typeof dotSphere>, cx: number, cy: number, R: number, yaw: number, pit: number, alpha: number, frame: number, scan = true) => {
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
  const SZ = [1.5, 2.1, 3.2, 5];
  const proj = pts.map((p) => { const x1 = cyw * p.x + syw * p.z; const z1 = -syw * p.x + cyw * p.z; const y2 = cp * p.y - sp * z1; const z2 = sp * p.y + cp * z1; return { p, x: x1, y: y2, z: z2 }; }).sort((a, b) => a.z - b.z);
  const sweep = Math.sin(frame * 0.035) * 0.95;
  for (const q of proj) {
    const depth = 0.5 + 0.5 * q.z; const k = 1 / (1 - q.z * 0.18);
    const sx = cx + q.x * R * k, sy = cy - q.y * R * k;
    const band = scan ? Math.exp(-Math.pow((q.y - sweep) * 5, 2)) : 0;
    const col = mix(CY, MG, cl(0.5 - q.y * 0.5 + 0.1));
    const a = alpha * (0.18 + 0.55 * depth + 0.5 * band) * (0.8 + 0.2 * Math.sin(frame * 0.08 + q.p.ph));
    ctx.fillStyle = rgba(mix(col, WH, band * 0.6), a);
    const sz = SZ[q.p.tier] * (0.7 + 0.5 * depth) * (R / 150);
    if (q.p.tier === 3) { ctx.shadowColor = rgba(col, 0.9); ctx.shadowBlur = 14; }
    ctx.beginPath(); ctx.arc(sx, sy, sz, 0, 6.2832); ctx.fill();
    if (q.p.tier === 3) ctx.shadowBlur = 0;
  }
};

export const glow = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: number[], a: number) => {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
};

export const line = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, c: number[], a: number, w = 1.5) => {
  ctx.strokeStyle = rgba(c, a); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
};
