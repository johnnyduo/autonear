// Render review stills: node scripts/stills.mjs [sceneId[:frac,frac]] ...   -> out/stills/<scene>-<pct>.png
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const V = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1];
const timing = JSON.parse(readFileSync(resolve(root, `src/data/timing${V ? '.' + V : ''}.json`), 'utf8'));
const FPS = 30, LEAD = V ? 0.1 : 0.25, GAP = V ? 0.2 : 0.4, HOLD = V ? 2.2 : 2.6;
const spans = []; let cur = 0;
timing.scenes.forEach((s, i, a) => { const f = Math.round((LEAD + s.durationSec + (i === a.length - 1 ? HOLD : GAP)) * FPS); spans.push({ id: s.id, from: cur, frames: f, dur: s.durationSec }); cur += f; });

const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = (want.length ? want : spans.map((s) => s.id)).flatMap((w) => {
  const [id, fr] = w.split(':'); const sp = spans.find((s) => s.id === id); if (!sp) throw new Error(`unknown scene ${id}`);
  return (fr ? fr.split(',').map(Number) : [0.3, 0.65, 0.97]).map((f) => ({ id, f, frame: sp.from + Math.round((LEAD + sp.dur * f) * FPS) }));
});
mkdirSync(resolve(root, 'out/stills'), { recursive: true });
const serveUrl = await bundle({ entryPoint: resolve(root, 'src/index.ts'), onProgress: () => {} });
const comp = await selectComposition({ serveUrl, id: V === 'cine2' ? 'Cinematic2' : V ? 'Cinematic' : 'Main', chromiumOptions: { gl: 'angle' } });
for (const t of targets) {
  const out = resolve(root, `out/stills/${V ? V + '-' : ''}${t.id}-${Math.round(t.f * 100)}.png`);
  await renderStill({ composition: comp, serveUrl, frame: Math.min(t.frame, comp.durationInFrames - 1), output: out, imageFormat: 'png' });
  console.log(out);
}
