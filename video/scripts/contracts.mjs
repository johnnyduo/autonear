// Measure the contract suites instead of typing the numbers: node scripts/contracts.mjs  -> src/data/contracts.json
// (cargo runs a randomised state-machine property test and takes ~4 minutes; forge ~20 s.)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.HOME}/.foundry/bin:${process.env.PATH}` };
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd: resolve(root, cwd), env, encoding: 'utf8', maxBuffer: 1 << 28 }); return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }; };

console.log('cargo test --locked (near-registry) ...');
const c = run('cargo', ['test', '--locked'], 'contracts/near-registry');
const cPassed = [...c.out.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
const near = {
  command: 'cargo test --locked', passed: cPassed.reduce((a, m) => a + Number(m[1]), 0), failed: cPassed.reduce((a, m) => a + Number(m[2]), 0), exit: c.code,
  hasPropertyTest: /test tests::property_\w+ \.\.\. ok/.test(c.out),
  passedNames: [...c.out.matchAll(/test tests::(\w+) \.\.\. ok/g)].map((m) => m[1]),
};

console.log('forge test (evm) ...');
const f = run('forge', ['test'], 'contracts/evm');
const fm = /(\d+) tests passed, (\d+) failed/.exec(f.out);
const inv = [...f.out.matchAll(/\[PASS\] invariant_\w+\(\) \(runs: (\d+), calls: (\d+)/g)];
const evm = {
  command: 'forge test', passed: fm ? Number(fm[1]) : 0, failed: fm ? Number(fm[2]) : 1, exit: f.code,
  invariantTests: inv.length, invariantRuns: inv[0] ? Number(inv[0][1]) : 0, invariantCalls: inv[0] ? Number(inv[0][2]) : 0,
};
const out = { ranAt: new Date().toISOString(), verifiedOn: new Date().toISOString().slice(0, 10), near, evm };
mkdirSync(resolve(root, 'video/src/data'), { recursive: true });
writeFileSync(resolve(root, 'video/src/data/contracts.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ near: { ...near, passedNames: near.passedNames.length }, evm }, null, 2));
if (near.failed || evm.failed || !near.passed || !evm.passed) { console.error('contract suites are not green'); process.exit(1); }
