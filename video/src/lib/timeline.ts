import { FPS } from '../theme';
import timing from '../data/timing.json';
import captured from '../data/captured.json';
import script from '../../script/script.json';

export const GAP_SEC = 0.4;       // breathing room after each scene's narration
export const LEAD_SEC = 0.25;     // narration starts slightly after the scene fades in
export const CLOSE_HOLD_SEC = 2.6; // end card holds after the last word

export type SceneTiming = {
  id: string; file: string; durationSec: number; spoken: string; display: string; tag: string | null;
  from: number; frames: number; narrationFrom: number; // frames
};

export const data = captured;
export const meta = script;

export function buildTimeline() {
  let cursor = 0;
  const scenes: SceneTiming[] = (timing as any).scenes.map((s: any, i: number, arr: any[]) => {
    const last = i === arr.length - 1;
    const frames = Math.round((LEAD_SEC + s.durationSec + (last ? CLOSE_HOLD_SEC : GAP_SEC)) * FPS);
    const out = { ...s, from: cursor, frames, narrationFrom: Math.round(LEAD_SEC * FPS) };
    cursor += frames;
    return out;
  });
  return { scenes, totalFrames: cursor, mode: (timing as any).mode as string };
}
