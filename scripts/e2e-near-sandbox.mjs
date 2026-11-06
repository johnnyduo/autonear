#!/usr/bin/env node
// REAL end-to-end of the NEAR Mandate Vault against a LOCAL nearcore SANDBOX (near-sandbox 2.13.4, chain_id "localnet").
// This is NOT testnet and proves nothing about testnet gas, limits or RPC behaviour. It does prove, against a real nearcore runtime:
//   - our src/agent/near-admin.js serialisation (CreateAccount / DeployContract / AddKey / DeleteKey / FunctionCall+deposit) is accepted,
//   - our src/agent/near-signer.js (the agent's key from src/agent/keystore.js) signs `draw` and `deploy` that the vault accepts,
//   - src/vault/near.js (readState / verifyVaultCode / expectedTemplate / buildCall / verifyDeploy) agrees with what the chain did,
//   - the negatives are rejected by the chain and/or the adapter (over budget, revoked, paused, wrong template, tampered name, failed callback ...).
// The sandbox node is started from Node by this script on free ports, in a throw-away home dir, and killed on exit.
// Binary: $NEAR_SANDBOX_BIN_PATH, else the one `cargo test` in contracts/near-vault/integration downloaded (near-sandbox crate build dir),
// else ~/.near/near-sandbox-*/near-sandbox. Exit codes: 0 all passed, 1 a check failed, 2 prerequisites missing (nothing was run).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeystore } from '../src/agent/keystore.js';
import { generateSeed, formatSecretKey, formatPublicKey, ed25519PublicKey } from '../src/agent/near-signer.js';
import { createNearAdmin, deleteKey } from '../src/agent/near-admin.js';
import { adapter, VAULT_WASM_PATH, REGISTRY_WASM_PATH, sha256Hex } from '../src/vault/near.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nearStr = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;

// ---------- reporting (PASS/FAIL counts, e2e-local style) ----------
const R = { pass: 0, fail: 0, failed: [] };
const step = (n, m) => console.log(`\n[${n}] ${m}`);
function t(name, ok, detail = '') {
  if (ok) { R.pass++; console.log(`   PASS  ${name}${detail ? `  (${detail})` : ''}`); } else { R.fail++; R.failed.push(name); console.log(`   FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  return ok;
}
const showChecks = (v, only = 'failed') => { for (const c of v.checks) if (only === 'all' || !c.ok) console.log(`          ${c.ok ? 'ok  ' : 'BAD '} ${c.name}${c.detail ? ` :: ${String(c.detail).slice(0, 110)}` : ''}`); };
const failedNames = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);
const hasFailed = (v, re) => failedNames(v).some((n) => re.test(n));

// ---------- sandbox process management ----------
function findSandboxBin() {
  if (process.env.NEAR_SANDBOX_BIN_PATH && existsSync(process.env.NEAR_SANDBOX_BIN_PATH)) return process.env.NEAR_SANDBOX_BIN_PATH;
  const build = join(ROOT, 'contracts/near-vault/integration/target/debug/build');
  try {
    for (const d of readdirSync(build)) {
      if (!d.startsWith('near-sandbox-')) continue;
      const base = join(build, d, 'out/.near');
      if (!existsSync(base)) continue;
      for (const v of readdirSync(base)) { const p = join(base, v, 'near-sandbox'); if (existsSync(p)) return p; }
    }
  } catch { /* fall through */ }
  try { for (const v of readdirSync(join(homedir(), '.near'))) { const p = join(homedir(), '.near', v, 'near-sandbox'); if (v.startsWith('near-sandbox-') && existsSync(p)) return p; } } catch { /* none */ }
  return null;
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const rpcNorm = (j) => (j?.result && typeof j.result === 'object' && typeof j.result.error === 'string' ? { jsonrpc: j.jsonrpc, id: j.id, error: { message: j.result.error } } : j); // fastnear answers a failed query as { result: { error } }
async function rpcRaw(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return rpcNorm(await r.json());
}

let CHILD = null; let HOME = null;
const running = () => CHILD && CHILD.exitCode === null && CHILD.signalCode === null;
/** Last-resort synchronous cleanup (process 'exit' / signals): hard-kill the node, remove the throw-away home. */
function cleanup() {
  if (running()) { try { CHILD.kill('SIGKILL'); } catch { /* gone */ } }
  if (HOME && !process.env.KEEP_SANDBOX_HOME) { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } }
}
/** Normal shutdown: SIGTERM, wait for the node to exit (SIGKILL after 15 s), then remove its home so nothing writes into it any more. */
async function stopSandbox() {
  if (running()) {
    const exited = new Promise((r) => CHILD.once('exit', r));
    CHILD.kill('SIGTERM');
    await Promise.race([exited, sleep(15_000)]);
    if (running()) CHILD.kill('SIGKILL');
  }
  cleanup();
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function startSandbox(bin) {
  HOME = mkdtempSync(join(tmpdir(), 'autonear-near-sandbox-'));
  const init = spawnSync(bin, ['--home', HOME, 'init', '--fast', '--chain-id', 'localnet'], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`sandbox init failed: ${String(init.stderr).slice(-300)}`);
  const cfgPath = join(HOME, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.rpc.limits_config.json_payload_max_size = 64 * 1024 * 1024; // the vault wasm and registry wasm travel inside transactions
  cfg.store.max_open_files = 3000;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const validator = JSON.parse(readFileSync(join(HOME, 'validator_key.json'), 'utf8')); // root account "test.near"; local temp state only
  const rpcPort = await freePort(); const netPort = await freePort();
  const logFd = openSync(join(HOME, 'node.log'), 'a');
  CHILD = spawn(bin, ['--home', HOME, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`], { stdio: ['ignore', logFd, logFd], env: { ...process.env, RUST_LOG: 'warn' } });
  closeSync(logFd);
  const url = `http://127.0.0.1:${rpcPort}`;
  for (let i = 0; i < 200; i++) {
    if (CHILD.exitCode !== null) throw new Error(`sandbox exited early (${CHILD.exitCode}); see ${join(HOME, 'node.log')}`);
    try { const s = (await rpcRaw(url, 'status')).result; if (s?.sync_info?.latest_block_height > 2 && !s.sync_info.syncing) return { url, rootId: validator.account_id, rootKey: validator.secret_key, chainId: s.chain_id, version: s.version?.version }; } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('sandbox did not become ready in 30 s');
}

// ---------- main ----------
const bin = findSandboxBin();
if (!bin) {
  console.error('near-sandbox binary not found. Set NEAR_SANDBOX_BIN_PATH, or run `cd contracts/near-vault/integration && cargo test` once (it downloads near-sandbox 2.13.4 from build.nearprotocol.com).');
  process.exit(2);
}
for (const [what, p] of [['vault wasm (scripts/near-vault-build.sh)', VAULT_WASM_PATH], ['registry wasm (scripts/near-build.sh)', REGISTRY_WASM_PATH]]) {
  if (!existsSync(p)) { console.error(`missing ${what}: ${p}`); process.exit(2); }
}
const vaultWasm = new Uint8Array(readFileSync(VAULT_WASM_PATH));
const registryWasm = new Uint8Array(readFileSync(REGISTRY_WASM_PATH));
const registrySha = sha256Hex(registryWasm);
const vaultSha = sha256Hex(vaultWasm);

console.log('AutoNEAR Mandate Vault: NEAR end-to-end on a LOCAL nearcore SANDBOX (chain_id "localnet"). NOT testnet. Nothing here touches a public network.');
console.log(`sandbox binary: ${bin}`);
const sb = await startSandbox(bin);
console.log(`sandbox up: ${sb.url}  chain_id=${sb.chainId}  nearcore ${sb.version}  home=${HOME}`);
try {
const net = { id: 'near-sandbox-local', protocol: 'near', rpc: sb.url, explorer: '', mainnet: false, local: true, networkId: sb.chainId };
const mk = (accountId, secretKey) => createNearAdmin({ rpcUrl: sb.url, accountId, secretKey, networkId: sb.chainId });

const VAULT = `vault.${sb.rootId}`; const OWNER = `owner.${sb.rootId}`; const OTHER = `other.${sb.rootId}`;
const root = mk(sb.rootId, sb.rootKey);

step(1, 'setup through OUR serialisation (src/agent/near-admin.js): accounts, vault wasm + init, funding');
const seedOf = () => generateSeed();
const keyFor = (seed) => ({ seed, sk: formatSecretKey(seed), pk: formatPublicKey(ed25519PublicKey(seed)) });
const kOwner = keyFor(seedOf()); const kVault = keyFor(seedOf()); const kOther = keyFor(seedOf());
const mkSub = async (id, k, near) => { const r = await root.createSubAccount(id, k.pk, near * NEAR); return r; };
const r1 = await mkSub(OWNER, kOwner, 60n);
t('CreateAccount + Transfer + AddKey(FullAccess) in one tx accepted by nearcore', r1.ok, r1.txHash);
await mkSub(OTHER, kOther, 20n); await mkSub(VAULT, kVault, 10n);
const ownerKeys = await root.keys(OWNER);
t('new account has exactly the key we added (AddKey bytes round-trip)', ownerKeys.length === 1 && ownerKeys[0].public_key === kOwner.pk && ownerKeys[0].access_key.permission === 'FullAccess');
const owner = mk(OWNER, kOwner.sk); const vaultAdmin = mk(VAULT, kVault.sk); const other = mk(OTHER, kOther.sk);

const init = await vaultAdmin.deploy(VAULT, vaultWasm, { method: 'new', args: { owner: OWNER, network_id: 'localnet' }, gas: 30n * TGAS });
t('DeployContract + FunctionCall(new) of the vault wasm accepted (our bytes)', init.ok, init.txHash);
t('vault on-chain code hash == base58(sha256(dist/autonear_vault.wasm))', (await adapter.verifyVaultCode({ net, vault: VAULT })).ok, `sha256 ${vaultSha.slice(0, 16)}...`);
await owner.transfer(VAULT, 40n * NEAR);
const fl = await owner.view(VAULT, 'available');
t('owner funds the vault with a plain transfer; available() reflects it', BigInt(fl) > 40n * NEAR && BigInt(fl) < 50n * NEAR, nearStr(fl));

// the agent key comes from OUR keystore (no key file; env-style injection), its account is the implicit account of its public key
const keystore = loadKeystore({ path: join(HOME, 'no-such-agent.keys.json'), env: { AGENT_NEAR_PRIVATE_KEY: formatSecretKey(seedOf()) } });
const AGENT = keystore.near.accountId;
t('agent account is the 64-hex implicit account of its ed25519 key', /^[0-9a-f]{64}$/.test(AGENT) && AGENT === Buffer.from(keystore.near.publicKey).toString('hex'));
await root.transfer(AGENT, 1n * NEAR); // first gas money: an implicit account does not exist until it receives a transfer
const agentAcct = await root.account(AGENT);
t('implicit agent account created by a plain Transfer (gets its key automatically)', BigInt(agentAcct.amount) === 1n * NEAR);

const manifest = { sha256: registrySha, bytes: registryWasm.length };
const approved = { action: 'deploy_testnet', protocol: 'near', network: 'localnet', registry: { owner: OWNER, proposer: AGENT, maxSpendCap: '0', networkId: 'localnet', contractAccount: `reg1.${VAULT}` } };
const exp = adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT });
t('expectedTemplate: templateId == sha256(registry wasm), init material = registry `new` args', exp.templateId === registrySha && exp.initMaterial.owner_id === OWNER && exp.initMaterial.proposer_id === AGENT && exp.initMaterial.network_id === 'localnet' && !('max_spend_cap' in exp.initMaterial), JSON.stringify(exp.initMaterial).slice(0, 60) + '...');
console.log(`   derived deposit ${nearStr(exp.deposit)} (storage minimum ${nearStr(exp.minDeposit)} for ${exp.code.length} bytes)`);

step(2, 'owner (our FunctionCall bytes) allowlists the attested registry wasm with FIXED init args, then grants the mandate');
const al = await owner.call(VAULT, 'allow_template', exp.allowTemplateArgs);
t('owner allow_template(registry id, init_args, deposit) accepted', al.ok, al.txHash);
const blk = (await rpcRaw(sb.url, 'block', { finality: 'final' })).result.header;
const nowS = Math.floor(Number(BigInt(blk.timestamp_nanosec) / 1_000_000_000n));
const MANDATE = { agent: AGENT, expires_at: String(nowS + 3600), per_draw_cap: String(1n * NEAR), period_secs: '3600', period_cap: String(10n * NEAR), total_cap: String(10n * NEAR), max_deploys: 3 };
await owner.call(VAULT, 'set_mandate', MANDATE);
let st = await adapter.readState({ net, vault: VAULT, now: nowS, previews: { draw: [String(NEAR / 2n), String(2n * NEAR)], deploy: [{ template: registrySha, name: 'reg1' }, { template: registrySha, name: 'Bad.Name' }] } });
t('readState: config / mandate / usage / templates match what the owner set', st.config.owner === OWNER && st.config.epoch === 1 && !st.config.paused && st.mandate?.agent === AGENT && st.mandate.perDrawCap === MANDATE.per_draw_cap && st.mandate.totalCap === MANDATE.total_cap && st.mandate.maxDeploys === 3 && st.mandate.active && st.usage.totalSpent === '0' && st.templates.length === 1 && st.templates[0].id === registrySha && st.templates[0].deposit === exp.deposit && JSON.stringify(st.templates[0].initArgs) === JSON.stringify(Object.fromEntries(Object.entries(exp.initMaterial).sort())));
t('readState: agentBalance (view_account of the mandate agent) = 1 NEAR, blockTime near wall clock', st.agentBalance === String(NEAR) && Math.abs(st.blockTime - Math.floor(Date.now() / 1000)) < 120, `blockTime ${st.blockTime}`);
t('readState previews = chain preview_*: draw 0.5 ok, draw 2 PerDrawCap, deploy reg1 ok, deploy "Bad.Name" BadName', st.previews.draw[String(NEAR / 2n)] === '' && st.previews.draw[String(2n * NEAR)] === 'PerDrawCap' && st.previews.deploy[`${registrySha}:reg1`] === '' && st.previews.deploy[`${registrySha}:Bad.Name`] === 'BadName', JSON.stringify(st.previews).slice(0, 90));
t('readState: period_state at `now` is period 0 with the full period cap remaining', st.period?.index === 0 && st.period.remaining === String(10n * NEAR));

t('adapter.attested.sha256 == sha256(dist/autonear_vault.wasm)', adapter.attested.sha256 === vaultSha);
{
  const ok = adapter.checkTemplate({ state: st, expected: exp });
  t('checkTemplate: on-chain init_args / deposit / init_gas == the approved material', ok.ok, ok.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
  const evilExp = adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, owner: OTHER } } });
  const bad = adapter.checkTemplate({ state: st, expected: evilExp });
  t('checkTemplate: same template id but a DIFFERENT approved owner is caught (template id alone does not bind init args on NEAR)', !bad.ok && bad.checks.some((c) => !c.ok && /init_args/.test(c.name)));
}

step(3, 'vault code verification: right hash accepted, wrong hash and a non-vault account refused');
let vc = await adapter.verifyVaultCode({ net, vault: VAULT, attested: { sha256: vaultSha } });
t('verifyVaultCode(attested = real vault build) ok', vc.ok); showChecks(vc);
vc = await adapter.verifyVaultCode({ net, vault: VAULT, attested: { sha256: registrySha } });
t('verifyVaultCode(attested = other wasm) refused', !vc.ok && hasFailed(vc, /code hash/));
vc = await adapter.verifyVaultCode({ net, vault: OWNER, attested: { sha256: vaultSha } });
t('verifyVaultCode(an account with no contract) refused', !vc.ok);

// ---------- the agent, through OUR signer ----------
const limits = { maxFeePerTx: (NEAR / 10n).toString(), allowedTargets: [VAULT] };
const signer = keystore.signer('near', adapter.signerOptions({ net, extra: { pollMs: 250, timeoutMs: 90_000 } }));
const settle = async (txHash, sender) => { await rpcRaw(sb.url, 'tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }); };
const agentRun = async (spec) => { const r = await signer.signAndSend(spec, limits); if (r.txHash) await settle(r.txHash, AGENT).catch(() => {}); return r; };
const refusedWith = async (spec, re) => { try { await signer.signAndSend(spec, limits); return { threw: false }; } catch (e) { return { threw: true, matches: re.test(String(e.message)), message: String(e.message).slice(0, 100) }; } };

step(4, 'AGENT signs `draw` with src/agent/near-signer.js; the real vault accepts it');
const before = await adapter.readState({ net, vault: VAULT, now: nowS });
const drawAmt = NEAR / 2n;
const feeEst = await adapter.estimateFee({ net, vault: VAULT, agent: AGENT, call: adapter.buildCall('draw', { vault: VAULT, amount: drawAmt }) });
const dr = await agentRun(adapter.buildCall('draw', { vault: VAULT, amount: drawAmt }));
t('adapter.estimateFee == the signer\'s own worst-case bound (same gas x price x 1.5)', BigInt(dr.maxFeeBound) <= feeEst.worstCaseFee * 11n / 10n && BigInt(dr.maxFeeBound) >= feeEst.worstCaseFee * 9n / 10n, `est ${nearStr(feeEst.worstCaseFee)} signer ${nearStr(dr.maxFeeBound)}`);
t('draw tx signed by our signer: ok / success', dr.ok && dr.status === 'success', `${dr.txHash} gas burnt tokens ${dr.tokensBurnt}`);
st = await adapter.readState({ net, vault: VAULT, now: nowS });
// the vault earns 30% of the gas burnt in its own calls (nearcore contract reward), so `available` falls by the draw MINUS a small reward
const fell = BigInt(before.available) - BigInt(st.available);
t('usage.totalSpent == draw amount; vault available fell by the draw (less a < 0.01 NEAR gas reward)', st.usage.totalSpent === String(drawAmt) && fell <= drawAmt && fell > drawAmt - NEAR / 100n, `fell ${nearStr(fell)}`);
t('agent balance rose by the draw minus its own gas fee', BigInt(st.agentBalance) > BigInt(before.agentBalance) && BigInt(st.agentBalance) < BigInt(before.agentBalance) + drawAmt, `${nearStr(before.agentBalance)} -> ${nearStr(st.agentBalance)}`);

t('adapter.preview at the very block readState pinned (blockTag) agrees with the chain at that block', (await adapter.preview('draw', { net, vault: VAULT, amount: '1', block: st.blockTag })) === '' && (await adapter.preview('deploy', { net, vault: VAULT, template: registrySha, nameOrSalt: 'reg1', block: st.blockTag })) === '', `block ${st.blockTag}`);
const tgt = adapter.deployTarget({ decision: { id: 'dec_x', payload: JSON.stringify(approved) }, vault: VAULT, expected: exp });
t('deployTarget takes the name from the approved contractAccount', tgt.nameOrSalt === 'reg1' && tgt.predicted === `reg1.${VAULT}`);
step(5, 'AGENT signs `deploy` of the attested registry wasm through the vault (name reg1); adapter.verifyDeploy proves it');
const dspec = adapter.buildCall('deploy', { vault: VAULT, template: exp.templateId, code: exp.code, nameOrSalt: 'reg1' });
const dep = await agentRun(dspec);
t('deploy tx signed by our signer: all receipts succeeded', dep.ok && dep.status === 'success', `${dep.txHash} ${dep.finality}`);
console.log(`   agent paid ${nearStr(dep.tokensBurnt)} for the deploy tx (signer's worst-case bound ${nearStr(dep.maxFeeBound)}, ${Number(BigInt(dep.attachedGas) / TGAS)} Tgas prepaid)`);
if (process.env.E2E_DUMP_TX) writeFileSync(process.env.E2E_DUMP_TX, JSON.stringify((await rpcRaw(sb.url, 'EXPERIMENTAL_tx_status', { tx_hash: dep.txHash, sender_account_id: AGENT, wait_until: 'FINAL' })).result));
const decision = { payload: JSON.stringify(approved) };
const vd = await adapter.verifyDeploy({ net, txHash: dep.txHash, vault: VAULT, agent: AGENT, decision, manifest, expected: { ...exp, name: 'reg1' } });
showChecks(vd, 'all');
t(`verifyDeploy ok (${vd.checks.length} checks, account ${vd.account})`, vd.ok && vd.account === `reg1.${VAULT}`);
const vd2 = await adapter.verifyDeploy({ net, txHash: dep.txHash, vault: VAULT, agent: AGENT, decision, manifest });
t('verifyDeploy without `expected`/`name` derives both from attestation + approved contractAccount: ok', vd2.ok);
st = await adapter.readState({ net, vault: VAULT, now: nowS });
t('usage after deploy: deploys 1, totalSpent = draw + template deposit', st.usage.deploys === 1 && st.usage.totalSpent === String(drawAmt + BigInt(exp.deposit)));
const sub = await root.account(`reg1.${VAULT}`);
t('deployed registry holds >= its storage requirement (derived deposit is sufficient)', BigInt(sub.amount) >= BigInt(exp.deposit) && sub.storage_usage > 200_000, `balance ${nearStr(sub.amount)}, ${sub.storage_usage} bytes stored`);

step(6, 'adapter negatives on the REAL successful deploy tx (each must be refused for the named reason)');
const base = { net, txHash: dep.txHash, vault: VAULT, agent: AGENT, decision, manifest, expected: { ...exp, name: 'reg1' } };
let v = await adapter.verifyDeploy({ ...base, agent: OTHER });
t('wrong signer (expect another agent) refused', !v.ok && hasFailed(v, /signer|found and verifiable/), failedNames(v)[0]);
v = await adapter.verifyDeploy({ ...base, vault: OTHER });
t('wrong receiver (expect another vault) refused', !v.ok);
v = await adapter.verifyDeploy({ ...base, expected: { ...exp, name: 'reg2' }, decision: { payload: JSON.stringify({ ...approved, registry: { ...approved.registry, contractAccount: `reg2.${VAULT}` } }) } });
t('tampered name (tx deployed reg1, expected reg2) refused', !v.ok && hasFailed(v, /name/), failedNames(v).filter((n) => /name/.test(n))[0]);
v = await adapter.verifyDeploy({ ...base, decision: { payload: JSON.stringify({ ...approved, registry: { ...approved.registry, contractAccount: `evil.${VAULT}` } }) } });
t('approved contractAccount differs from where the vault deployed: refused', !v.ok && hasFailed(v, /approved contractAccount/));
v = await adapter.verifyDeploy({ ...base, decision: { payload: JSON.stringify({ ...approved, registry: { ...approved.registry, owner: OTHER } }) }, expected: adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, owner: OTHER } } }) });
t('wrong owner in the approved payload (chain has owner = OWNER): refused', !v.ok && hasFailed(v, /owner|init material|exactly the owner-fixed/), failedNames(v)[0]);
v = await adapter.verifyDeploy({ ...base, decision: { payload: JSON.stringify({ ...approved, registry: { ...approved.registry, proposer: OTHER } }) }, expected: adapter.expectedTemplate({ manifest, payload: { ...approved, registry: { ...approved.registry, proposer: OTHER } } }) });
t('wrong proposer in the approved payload: refused', !v.ok && hasFailed(v, /proposer|init material|exactly the owner-fixed/));
const other_exp = adapter.expectedTemplate({ manifest: { sha256: vaultSha }, payload: approved, vault: VAULT, wasmPath: VAULT_WASM_PATH });
v = await adapter.verifyDeploy({ ...base, manifest: { sha256: vaultSha }, expected: { ...other_exp, name: 'reg1' } });
t('wrong code (expect a different attested wasm): template/code hash checks refuse', !v.ok && hasFailed(v, /template|code/), failedNames(v).slice(0, 2).join(' | '));
v = await adapter.verifyDeploy({ ...base, txHash: dr.txHash });
t('a `draw` tx hash is refused (not a deploy)', !v.ok && hasFailed(v, /deploy/));
v = await adapter.verifyDeploy({ ...base, txHash: '11111111111111111111111111111111111111111111' });
t('unknown tx hash refused (verification failure, not a throw)', !v.ok);
v = await adapter.verifyDeploy({ ...base, net: { ...net, mainnet: true } });
t('network flagged mainnet refused outright', !v.ok && hasFailed(v, /mainnet/));

step(7, 'FAILED CALLBACK: batch fails on-chain (deposit below storage), `on_deployed` itself succeeds and reverses; verifyDeploy must NOT pass');
await owner.call(VAULT, 'allow_template', { ...exp.allowTemplateArgs, deposit: String(1n * NEAR) }); // re-allowing updates the template: now too small to hold 210 KB
const preBad = await adapter.readState({ net, vault: VAULT, now: nowS });
const bad = await agentRun(adapter.buildCall('deploy', { vault: VAULT, template: exp.templateId, code: exp.code, nameOrSalt: 'regbad' }));
console.log(`   signer view of the bad deploy: ok=${bad.ok} status=${bad.status} failure=${String(bad.failure).slice(0, 110)}`);
const rawBad = (await rpcRaw(sb.url, 'tx', { tx_hash: bad.txHash, sender_account_id: AGENT, wait_until: 'FINAL' })).result;
t('premise: top-level status of the failed-batch tx is SUCCESS (the callback handled the failure) while a batch receipt Failed', rawBad.status?.SuccessValue !== undefined && rawBad.receipts_outcome.some((o) => o.outcome.status.Failure), JSON.stringify(rawBad.receipts_outcome.find((o) => o.outcome.status.Failure)?.outcome.status.Failure ?? null).slice(0, 80));
t('our signer reports it as NOT ok (it scans every receipt, so it does not mistake this for a deploy)', bad.ok === false);
const badApproved = { ...approved, registry: { ...approved.registry, contractAccount: `regbad.${VAULT}` } };
v = await adapter.verifyDeploy({ net, txHash: bad.txHash, vault: VAULT, agent: AGENT, decision: { payload: JSON.stringify(badApproved) }, manifest, expected: { ...exp, deposit: String(1n * NEAR), name: 'regbad' } });
showChecks(v);
t('verifyDeploy refuses: failed receipt + deploy_failed + no confirmation + no sub-account', !v.ok && hasFailed(v, /failed receipt/) && hasFailed(v, /deploy_failed/) && hasFailed(v, /callback emitted `deploy_confirmed`/) && hasFailed(v, /sub-account exists/));
st = await adapter.readState({ net, vault: VAULT, now: nowS });
t('vault reversed the optimistic charge (usage restored, available back up to the refund + a < 0.01 NEAR gas reward; name released)', st.usage.deploys === preBad.usage.deploys && st.usage.totalSpent === preBad.usage.totalSpent && BigInt(st.available) >= BigInt(preBad.available) && BigInt(st.available) - BigInt(preBad.available) < NEAR / 100n, `deploys ${st.usage.deploys}, spent ${nearStr(st.usage.totalSpent)}`);
let gone = false; try { await root.account(`regbad.${VAULT}`); } catch { gone = true; }
t('no sub-account was left behind', gone);
await owner.call(VAULT, 'allow_template', exp.allowTemplateArgs); // restore the right deposit

step(8, 'chain-level negatives for the agent (real E_* codes) and signer-level refusals');
const stSpent = (await adapter.readState({ net, vault: VAULT, now: nowS })).usage;
let r = await agentRun({ method: 'draw', target: VAULT, args: { amount: String(2n * NEAR) } });
t('over per-draw cap: E_PerDrawCap', !r.ok && /E_PerDrawCap/.test(r.failure ?? ''), String(r.failure).slice(-70));
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: registrySha, name: 'reg1', code: registryWasm } });
t('same name again: E_AddressTaken', !r.ok && /E_AddressTaken/.test(r.failure ?? ''));
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: registrySha, name: 'wrongcode', code: vaultWasm } });
t('wrong template (template id of registry, vault wasm bytes): E_CodeMismatch', !r.ok && /E_CodeMismatch/.test(r.failure ?? ''));
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: vaultSha, name: 'unlisted', code: vaultWasm } });
t('template not allowlisted (the vault wasm itself): E_TemplateNotAllowed', !r.ok && /E_TemplateNotAllowed/.test(r.failure ?? ''));
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: registrySha, name: 'Bad.Name', code: registryWasm } });
t('tampered / invalid name "Bad.Name" on-chain: E_BadName', !r.ok && /E_BadName/.test(r.failure ?? ''));
let thrown = false; try { adapter.buildCall('deploy', { vault: VAULT, template: registrySha, code: vaultWasm, nameOrSalt: 'x' }); } catch { thrown = true; }
t('adapter.buildCall refuses code whose sha256 != template (before anything is signed)', thrown);
thrown = false; try { adapter.buildCall('deploy', { vault: VAULT, template: registrySha, code: registryWasm, nameOrSalt: 'a.b' }); } catch { thrown = true; }
t('adapter.buildCall refuses a dotted name', thrown);
let x = await refusedWith({ method: 'draw', target: OWNER, args: { amount: '1' } }, /target_not_permitted/);
t('signer refuses a target that is not the vault', x.threw && x.matches, x.message);
x = await refusedWith({ method: 'allow_template', target: VAULT, args: { amount: '1' } }, /method_not_permitted/);
t('signer refuses any method other than draw/deploy', x.threw && x.matches, x.message);
const after = (await adapter.readState({ net, vault: VAULT, now: nowS })).usage;
t('none of the failed calls changed usage', after.totalSpent === stSpent.totalSpent && after.deploys === stSpent.deploys);
const oth = await other.call(VAULT, 'draw', { amount: '1' }, { allowFail: true });
t('a non-agent account calling draw: E_Unauthorized', !oth.ok && /E_Unauthorized/.test(JSON.stringify(oth.failure)));
t('agent cannot even sign an owner method (set_mandate)', await signer.signAndSend({ method: 'set_mandate', target: VAULT, args: {} }, limits).then(() => false, () => true));

step(9, 'second deploy (reg2) succeeds; a third exceeds the period cap (over budget)');
const approved2 = { ...approved, registry: { ...approved.registry, contractAccount: `reg2.${VAULT}` } };
const dep2 = await agentRun(adapter.buildCall('deploy', { vault: VAULT, template: exp.templateId, code: exp.code, nameOrSalt: 'reg2' }));
const vd3 = await adapter.verifyDeploy({ net, txHash: dep2.txHash, vault: VAULT, agent: AGENT, decision: { payload: JSON.stringify(approved2) }, manifest });
t('second deploy verified by the adapter', dep2.ok && vd3.ok, `${vd3.checks.length} checks`);
const pv = await adapter.previewDeploy({ net, vault: VAULT, template: registrySha, name: 'reg3' });
t('chain preview for a third deploy says PeriodCap (0.5 + 3.8 + 3.8 + 3.8 > 10)', pv === 'PeriodCap', pv);
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: registrySha, name: 'reg3', code: registryWasm } });
t('third deploy over the period/total budget: E_PeriodCap', !r.ok && /E_PeriodCap/.test(r.failure ?? ''));
st = await adapter.readState({ net, vault: VAULT, now: nowS });
t('usage: 2 deploys, totalSpent = 0.5 + 2 x deposit', st.usage.deploys === 2 && st.usage.totalSpent === String(drawAmt + 2n * BigInt(exp.deposit)));

step(10, 'owner kill switches: pause, unpause, revoke; funds stay recoverable');
await owner.call(VAULT, 'pause', {});
r = await agentRun(adapter.buildCall('draw', { vault: VAULT, amount: 1n }));
t('paused: agent draw E_Paused', !r.ok && /E_Paused/.test(r.failure ?? ''));
await owner.call(VAULT, 'unpause', {});
// the vault account's own full-access key can bypass every rule: remove it (README step 5) and show everything still works
const del = await vaultAdmin.send(VAULT, [deleteKey(kVault.pk)]);
t('DeleteKey accepted: vault account now has no access keys', del.ok && (await root.keys(VAULT)).length === 0);
vc = await adapter.verifyVaultCode({ net, vault: VAULT, attested: { sha256: vaultSha } });
t('verifyVaultCode still ok and reports "vault account is locked"', vc.ok && vc.checks.some((c) => c.info && /none \(vault account is locked\)/.test(c.detail)));
r = await agentRun(adapter.buildCall('draw', { vault: VAULT, amount: NEAR / 10n }));
t('agent still draws from the locked vault', r.ok);
await owner.call(VAULT, 'revoke', {});
r = await agentRun(adapter.buildCall('draw', { vault: VAULT, amount: 1n }));
t('revoked: draw E_MandateInactive', !r.ok && /E_MandateInactive/.test(r.failure ?? ''));
r = await agentRun({ method: 'deploy', target: VAULT, args: { template: registrySha, name: 'afterrevoke', code: registryWasm } });
t('revoked: deploy E_MandateInactive', !r.ok && /E_MandateInactive/.test(r.failure ?? ''));
st = await adapter.readState({ net, vault: VAULT, now: nowS, previews: { draw: ['1'] } });
t('readState after revoke: mandate.revoked, active false, chain preview_draw MandateInactive', st.mandate.revoked && !st.mandate.active && st.previews.draw['1'] === 'MandateInactive');
const ob = BigInt((await root.account(OWNER)).amount);
const wd = await owner.call(VAULT, 'withdraw', { amount: String(5n * NEAR) });
t('owner withdraw works while revoked and pays the owner', wd.ok && BigInt((await root.account(OWNER)).amount) > ob + 4n * NEAR);

} catch (e) {
  R.fail++; R.failed.push(`script error: ${String(e?.message ?? e).slice(0, 200)}`);
  console.log(`\nFAIL  script error: ${e?.stack ?? e}`);
} finally {
  await stopSandbox();
}

// ---------- summary ----------
console.log(`\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`);
if (R.fail) console.log('failed checks:\n  - ' + R.failed.join('\n  - '));
console.log('SCOPE: local nearcore sandbox 2.13.4 (chain_id localnet), fresh genesis, single validator, instant-ish blocks. It is NOT NEAR testnet; gas price, limits, RPC providers and finality timing differ.');
console.log(`E2E (LOCAL NEAR SANDBOX, NOT a public testnet) ${R.fail ? 'FAILED' : 'PASSED'}`);
process.exit(R.fail ? 1 : 0);
