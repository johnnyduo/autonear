import { FPS } from '../theme';
import timing from '../data/timing.pd.json';
import marksJson from '../data/pd-marks.json';
import { wordTimings, whenSaid } from '../lib/narration.js';

/* Product-demo timeline: same slot logic as the cinematic cut (scene visuals start PRE frames early, overlapping the previous tail). */
export const LEAD_SEC = 0.1;
export const GAP_SEC = 0.2;
export const CLOSE_HOLD_SEC = 2.4;
export const PRE = 14;
export { FPS };
export type PScene = { id: string; file: string; durationSec: number; spoken: string; display: string; tag: string | null; cal?: any; from: number; frames: number; narrationFrom: number };
export type Mark = { name: string; c: number; x: number; y: number; w: number; h: number };
export const marks = (id: string): Mark[] => (marksJson as any)[id] ?? [];
export const mark = (id: string, name: string): Mark => { const m = marks(id).find((k) => k.name === name); if (!m) throw new Error(`mark ${id}/${name} missing: run scripts/pd_record.py`); return m; };

let cache: { scenes: PScene[]; totalFrames: number } | null = null;
export function buildTimeline() {
  if (cache) return cache;
  let cursor = 0;
  const scenes: PScene[] = (timing as any).scenes.map((s: any, i: number, arr: any[]) => {
    const last = i === arr.length - 1;
    const frames = Math.round((LEAD_SEC + s.durationSec + (last ? CLOSE_HOLD_SEC : GAP_SEC)) * FPS);
    const out = { ...s, from: cursor, frames, narrationFrom: Math.round(LEAD_SEC * FPS) };
    cursor += frames;
    return out;
  });
  cache = { scenes, totalFrames: cursor };
  return cache;
}
/** Narration-relative seconds at which `phrase` is spoken in scene `id`. */
export function said(id: string, phrase: string, nth = 0): number {
  const s = buildTimeline().scenes.find((x) => x.id === id)!;
  const wt = wordTimings(s.display, s.durationSec, s.cal);
  for (const suf of ['', '.', ',', '?', ':']) { try { return whenSaid(wt, phrase + suf, nth); } catch { /* try the next punctuation */ } }
  throw new Error(`phrase not spoken in ${id}: "${phrase}"`);
}
