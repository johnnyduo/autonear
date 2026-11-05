// Original (synthesised) music bed + SFX via ffmpeg. No third-party audio, so no licensing questions.
//   node scripts/audio.mjs   -> public/music/bed.mp3, public/sfx/*.wav
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timing = JSON.parse(readFileSync(resolve(root, 'src/data/timing.json'), 'utf8'));
const total = timing.scenes.reduce((a, s) => a + 0.25 + s.durationSec + 0.4, 0) + 2.6;
mkdirSync(resolve(root, 'public/music'), { recursive: true });
mkdirSync(resolve(root, 'public/sfx'), { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
const D = total.toFixed(2);

// --- music bed: warm drone + soft pulse + airy shimmer, slow build, fades at both ends ---
ff('-f', 'lavfi', '-i', `sine=f=55:d=${D}`, '-f', 'lavfi', '-i', `sine=f=110:d=${D}`, '-f', 'lavfi', '-i', `sine=f=164.81:d=${D}`, '-f', 'lavfi', '-i', `sine=f=220:d=${D}`,
  '-f', 'lavfi', '-i', `aevalsrc=0.9*sin(2*PI*(48+40*exp(-35*mod(t\\,0.6)))*t)*exp(-6*mod(t\\,0.6)):s=44100:d=${D}`,
  '-f', 'lavfi', '-i', `anoisesrc=d=${D}:c=pink:a=0.03`,
  '-filter_complex',
  `[0]volume=0.5[a];[1]volume=0.22,tremolo=f=0.12:d=0.6[b];[2]volume=0.12,tremolo=f=0.2:d=0.5[c];[3]volume=0.07,tremolo=f=0.17:d=0.7[d];` +
  `[4]lowpass=f=140,volume=0.55,volume='min(1,0.35+t/40)':eval=frame[k];[5]highpass=f=3500,lowpass=f=9000,tremolo=f=1.67:d=1,volume=0.5[n];` +
  `[a][b][c][d][k][n]amix=inputs=6:normalize=0,lowpass=f=6000,afade=t=in:d=2.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,loudnorm=I=-24:TP=-3:LRA=7[out]`,
  '-map', '[out]', '-ar', '44100', '-b:a', '192k', resolve(root, 'public/music/bed.mp3'));

// --- SFX ---
const sfx = (name, src, fc) => ff(...src, '-filter_complex', fc, '-map', '[o]', '-ar', '44100', resolve(root, `public/sfx/${name}.wav`));
// stamp / reject: low thunk + short noise burst
sfx('reject', ['-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*(70+90*exp(-40*t))*t)*exp(-14*t):s=44100:d=0.4', '-f', 'lavfi', '-i', 'anoisesrc=d=0.4:c=brown:a=0.5'],
  '[1]lowpass=f=900,afade=t=out:st=0.02:d=0.1,volume=0.5[n];[0][n]amix=inputs=2:normalize=0,alimiter=limit=0.9[o]');
// approve: two-note rising chime
sfx('approve', ['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*659.25*t)*exp(-5*t):s=44100:d=0.9', '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*987.77*t)*exp(-4.5*t):s=44100:d=0.9'],
  '[1]adelay=130|130[b];[0][b]amix=inputs=2:normalize=0,aecho=0.6:0.5:90:0.3,alimiter=limit=0.9[o]');
// tick: UI blip
sfx('tick', ['-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*1760*t)*exp(-60*t):s=44100:d=0.12'], '[0]acopy[o]');
// whoosh: filtered noise sweep
sfx('whoosh', ['-f', 'lavfi', '-i', 'anoisesrc=d=0.7:c=pink:a=0.6'], "[0]bandpass=f=900:w=1.2,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.4,volume=0.5[o]");
// warn: two-tone alert ping
sfx('warn', ['-f', 'lavfi', '-i', 'aevalsrc=0.45*sin(2*PI*440*t)*exp(-6*t):s=44100:d=0.6', '-f', 'lavfi', '-i', 'aevalsrc=0.45*sin(2*PI*349.23*t)*exp(-6*t):s=44100:d=0.6'],
  '[1]adelay=160|160[b];[0][b]amix=inputs=2:normalize=0,aecho=0.5:0.5:70:0.25[o]');
console.log(`bed ${D}s + sfx ok`);
