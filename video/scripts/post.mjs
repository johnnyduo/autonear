// Draft the X post from the same data as the video: node scripts/post.mjs  -> out/post.txt
// (HACKATHON.md tips: first line understandable to a stranger; one complete moment; NEAR's role concrete; end with a next step.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const d = rd('src/data/captured.json'), m = rd('script/meta.json');
const repo = m.repoUrl ?? '<PUBLIC REPO URL>';
const post = `AI agents can find what to build on NEAR. They shouldn't be able to touch a treasury.

AutoNEAR: public evidence → open scoring → ONE allowed action (testnet deploy, spend cap 0) → human approves → chain verifies.

${repo}
${m.mention} ${m.hashtags}`;
const reply = `Honest scope: the scoring snapshot is live (${d.live.total} records); the approval gate + receipt check run on fixtures with a mocked NEAR RPC (no public tx yet). Contracts: Rust/NEAR ${d.suites.nearContract.passed} tests, Solidity ${d.suites.evmContract.passed}. What approval rule would you add? Track: ${m.track}.`;
mkdirSync(resolve(root, 'out'), { recursive: true });
writeFileSync(resolve(root, 'out/post.txt'), `--- POST (${post.length} chars; URLs count as 23 on X) ---\n${post}\n\n--- REPLY (${reply.length} chars) ---\n${reply}\n`);
console.log(readFileSync(resolve(root, 'out/post.txt'), 'utf8'));
