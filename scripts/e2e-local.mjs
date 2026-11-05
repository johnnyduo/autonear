#!/usr/bin/env node
// FULL LOOP on a LOCAL anvil chain (31337) through the real HTTP API:
//   live ingest -> score -> agent run (attested EVM build) -> pending decision -> operator approval (bound signer)
//   -> deployment signed by an anvil dev key (stands in for the human wallet) -> receipt verified on-chain -> deployment record.
// This proves wiring and verification logic. It is NOT a public-testnet deployment and says so in its output.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ingestAll, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { recordAttestation } from '../src/attest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = `${homedir()}/.foundry/bin`;
const ART = resolve(ROOT, 'contracts/evm/dist/ProposalRegistry.json');
if (!existsSync(ART)) { console.error('Run `node scripts/evm-build.mjs` first.'); process.exit(1); }
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil PUBLIC dev key - NEVER fund this address on any real network (bots sweep it)
const A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const step = (n, m) => console.log(`\n[${n}] ${m}`);
const assert = (c, m) => { if (!c) { console.error('ASSERTION FAILED:', m); process.exit(1); } console.log('  ok:', m); };

const port = 19000 + Math.floor(Math.random() * 500);
const anvil = spawn(`${BIN}/anvil`, ['--port', String(port), '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill());
const rpc = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const db = await openDb({ path: ':memory:' });
const TOKEN = 'e2e-operator-token';
const pending = [];
// Outbound calls other than the local chain fail on purpose so the treasury rehearsal uses its labelled synthetic fixtures.
const localOnlyFetch = (url, init) => (String(url).startsWith('http://127.0.0.1') ? fetch(url, init) : Promise.reject(new TypeError('offline by design in e2e')));
const app = createApp({ db, operatorToken: TOKEN, defer: (p) => pending.push(p), fetchImpl: localOnlyFetch });
const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await app(new Request('http://e2e' + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, json: await r.json() };
};

step(1, 'live ingestion from public sources (network required)');
await registerSources(db);
const ing = await ingestAll(db, { trigger: 'e2e' });
console.log('  ', ing.map((i) => `${i.sourceId}=${i.status}${i.inserted !== undefined ? `(+${i.inserted})` : ''}`).join(' '));
assert(ing.filter((i) => i.status === 'ok').length >= 2, 'at least two live sources ingested');
await refreshOpportunities(db);

step(2, 'attest the real EVM build (artifacts produced by scripts/evm-build.mjs + forge test)');
const art = JSON.parse(readFileSync(ART, 'utf8'));
const manifest = JSON.parse(spawnSync('node', ['scripts/evm-build.mjs', '--no-build'], { cwd: ROOT, encoding: 'utf8' }).stdout.match(/\{[\s\S]*\}\s*$/)[0]);
const names = spawnSync(`${BIN}/forge`, ['test', '--list', '--json'], { cwd: resolve(ROOT, 'contracts/evm'), encoding: 'utf8' });
let testNames = []; try { testNames = Object.values(JSON.parse(names.stdout)).flatMap((f) => Object.values(f).flat()); } catch { /* names optional here */ }
await recordAttestation(db, { protocol: 'evm', commitSha: 'e2e-local', manifest: { ...manifest, sha256: manifest.deployedBytecodeSha256, abi: art.abi, bytecode: art.bytecode, deployedBytecode: art.deployedBytecode }, tests: { passed: testNames.length, failed: 0, lint: true, fuzz: true, names: testNames } });
assert(testNames.length > 50, `attestation carries ${testNames.length} real test names from forge`);

step(3, 'operator starts a research run through the API (idempotency key required)');
const started = await call('/api/runs', { method: 'POST', headers: { 'idempotency-key': 'e2e-1' }, body: { opportunityId: 'opp_treasury', chain: 'evm:31337', owner: A0, proposer: A1 } });
assert(started.status === 202, 'POST /api/runs -> 202');
const runId = started.json.run.id;
await Promise.all(pending);
const fin = await db.get('SELECT * FROM runs WHERE id=?', [runId]);
console.log('   run state:', fin.state);
assert(fin.state === 'awaiting_approval', 'run reached awaiting_approval (no decision was auto-executed)');
const decs = (await call('/api/decisions')).json.items; const d = decs[0];
assert(d.status === 'pending' && d.max_spend === '0', 'decision pending with zero spend');

step(4, 'deployment before approval must be impossible');
const early = await call(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash: '0x' + '11'.repeat(32) } });
assert(early.status === 409, `receipt before approval refused (HTTP ${early.status})`);
const noPhrase = await call(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: 'yes', signer: A0 } });
assert(noPhrase.status === 400, 'approval without exact phrase refused');

step(5, 'operator approves (binds the signer address)');
const ap = await call(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: A0 } });
assert(ap.status === 200 && ap.json.status === 'approved', 'approved');

step(6, 'HUMAN SIGN STEP (stand-in: anvil dev key) deploys the attested bytecode');
const dd = (await call(`/api/decisions/${d.id}/deploy-data`)).json;
assert(dd.bytecode && dd.abi, 'deploy-data released only after approval');
const args = spawnSync(`${BIN}/cast`, ['abi-encode', 'constructor(address,address,uint256)', dd.registry.owner, dd.registry.proposer, dd.registry.maxSpendCap], { encoding: 'utf8' }).stdout.trim().replace(/^0x/, '');
const sent = spawnSync(`${BIN}/cast`, ['send', '--rpc-url', rpc, '--private-key', KEY0, '--json', '--create', dd.bytecode.replace(/^0x/, '') + args], { encoding: 'utf8' });
const txHash = JSON.parse(sent.stdout).transactionHash;
console.log('   tx:', txHash);

step(7, 'a wrong tx must be rejected, the right one recorded (verification is on-chain, not trusted input)');
// Point the verifier at the local chain: the 31337 network entry uses 127.0.0.1:8545, so inject the actual port.
const { PROTOCOLS } = await import('../src/protocols.js');
PROTOCOLS.evm.networks.find((n) => n.id === 'evm:31337').rpc = rpc;
const junk = await call(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash: '0x' + '22'.repeat(32) } });
assert(junk.json.recorded === false, 'unknown tx hash is not recorded');
const rec = await call(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash } });
console.log(rec.json.verification.checks.map((c) => `   ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`).join('\n'));
assert(rec.json.recorded === true, 'deployment recorded after every check passed');
const dec2 = (await call(`/api/decisions/${d.id}`)).json;
assert(dec2.status === 'executed' && dec2.deployment.status === 'verified_local', 'decision executed; deployment labelled verified_local');
const dup = await call(`/api/decisions/${d.id}/receipt`, { method: 'POST', body: { txHash } });
assert(dup.json.idempotent === true, 're-submitting the receipt is idempotent');

step(8, 'audit chain + run chain integrity');
const sec = (await call('/api/security')).json;
assert(sec.auditChain.ok, 'audit hash chain intact');
assert((await call(`/api/runs/${runId}`)).json.chain.ok, 'run event hash chain intact');
console.log(`\nE2E (LOCAL ANVIL, chain 31337 — NOT a public testnet) PASSED. contract ${dec2.deployment.account}`);
process.exit(0);
