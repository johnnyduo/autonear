// The default build is NEAR testnet only. These run in child processes with ENABLE_EVM unset, so they check the shipped default, not the test environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = (code, env = {}) => {
  const e = { ...process.env, ...env }; if (!('ENABLE_EVM' in env)) delete e.ENABLE_EVM;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: e, encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};

test('by default only NEAR testnet can be targeted', () => {
  const o = run(`import { DECISION_LIMITS } from './src/policy.js'; import { findNetwork, PROTOCOLS } from './src/protocols.js'; import { ALLOWED_HOSTS } from './src/http-client.js';
    console.log(JSON.stringify({ nets: DECISION_LIMITS.allowedNetworks, base: findNetwork('evm:84532'), near: findNetwork('near-testnet')?.id, evm: PROTOCOLS.evm.status, host: ALLOWED_HOSTS.launch.has('sepolia.base.org') }));`);
  assert.deepEqual(o.nets, ['near-testnet']); assert.equal(o.base, null); assert.equal(o.near, 'near-testnet'); assert.equal(o.evm, 'disabled'); assert.equal(o.host, false);
});

test('ENABLE_EVM=1 brings the EVM networks back (development only)', () => {
  const o = run(`import { DECISION_LIMITS } from './src/policy.js'; import { findNetwork } from './src/protocols.js';
    console.log(JSON.stringify({ n: DECISION_LIMITS.allowedNetworks.length, base: findNetwork('evm:84532')?.id }));`, { ENABLE_EVM: '1' });
  assert.ok(o.n > 1); assert.equal(o.base, 'evm:84532');
});
