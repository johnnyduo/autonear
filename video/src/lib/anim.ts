import { Easing, interpolate } from 'remotion';

/** 0 -> 1 ramp starting at `at` seconds lasting `dur` seconds, eased out. */
export const ramp = (sec: number, at: number, dur = 0.45, ease = Easing.out(Easing.cubic)) =>
  interpolate(sec, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const fmt = (n: number, d = 2) => n.toFixed(d);
