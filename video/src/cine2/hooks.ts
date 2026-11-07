import { useCurrentFrame } from 'remotion';
import { useAnchors, useNarrationSec } from '../components';
import { FPS, type CScene } from './timeline';
import { stageAt } from './stage';

export const useCine = (s: CScene) => {
  const sec = useNarrationSec(s as any);
  const { at } = useAnchors(s as any);
  const f = useCurrentFrame();
  const st = stageAt((s.from + f) / FPS);
  return { sec, at: at as (phrase: string, nth?: number, frac?: number) => number, st, f, dur: s.durationSec };
};
export const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
