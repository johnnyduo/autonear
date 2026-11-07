import { FPS } from '../theme';
import timing from '../data/timing.cine2.json';
import captured from '../data/captured.json';
import metaJson from '../../script/meta.json';
import { wordTimings, whenSaid } from '../lib/narration.js';

/* Timeline of the cinematic cut. Same scene-slot logic as the default cut but tighter: scene visuals start PRE frames early and overlap the previous tail. */
export const LEAD_SEC = 0.1;
export const GAP_SEC = 0.2;
export const CLOSE_HOLD_SEC = 2.2;
export const PRE = 14;
export { FPS };

export type CScene = {
  id: string; file: string; durationSec: number; spoken: string; display: string; tag: string | null; cal?: any;
  from: number; frames: number; narrationFrom: number;
};
export const data: any = captured;
export const meta: any = metaJson;
export const prod = (captured as any).prod;
export const tn = (captured as any).testnet;

let cache: { scenes: CScene[]; totalFrames: number } | null = null;
export function buildTimeline() {
  if (cache) return cache;
  let cursor = 0;
  const scenes: CScene[] = (timing as any).scenes.map((s: any, i: number, arr: any[]) => {
    const last = i === arr.length - 1;
    const frames = Math.round((LEAD_SEC + s.durationSec + (last ? CLOSE_HOLD_SEC : GAP_SEC)) * FPS);
    const out = { ...s, from: cursor, frames, narrationFrom: Math.round(LEAD_SEC * FPS) };
    cursor += frames;
    return out;
  });
  cache = { scenes, totalFrames: cursor };
  return cache;
}

/** Seconds (relative to the scene slot start, i.e. s.from) at which `phrase` is spoken. Falls back to a fraction of the scene. */
export function anchor(id: string, phrase: string, nth = 0, fallback = 0.5): number {
  const s = buildTimeline().scenes.find((x) => x.id === id)!;
  try { return s.narrationFrom / FPS + whenSaid(wordTimings(s.display, s.durationSec, s.cal), phrase, nth); } catch { return s.narrationFrom / FPS + s.durationSec * fallback; }
}
export const sceneStart = (id: string) => buildTimeline().scenes.find((x) => x.id === id)!.from / FPS;
export const sceneDur = (id: string) => { const s = buildTimeline().scenes.find((x) => x.id === id)!; return s.frames / FPS; };
