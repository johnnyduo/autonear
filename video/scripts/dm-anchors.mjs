// Word start times per scene of the product demo, so the app recorder can time every cursor move to what is being said.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordTimings } from '../src/lib/narration.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(resolve(root, 'src/data/timing.dm.json'), 'utf8'));
const out = {};
for (const s of t.scenes) out[s.id] = { dur: s.durationSec, words: wordTimings(s.display, s.durationSec, s.cal).map((w) => ({ w: w.word, t: +w.start.toFixed(3) })) };
writeFileSync(resolve(root, 'src/data/dm-words.json'), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([k, v]) => `${k} ${v.dur}s`).join(' | '));
