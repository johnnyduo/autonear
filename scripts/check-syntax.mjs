// `node --check` over every .js/.mjs/.cjs under src/, scripts/ and tests/. Exits non-zero on the first batch of failures.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'target', 'out', 'cache', 'dist', '.wrangler']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(m?js|cjs)$/.test(name)) yield p;
  }
}

const files = ['src', 'scripts', 'tests'].flatMap((d) => { try { return [...walk(join(root, d))]; } catch { return []; } });
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`FAIL ${f.slice(root.length + 1)}\n${r.stderr}`); }
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
