// Shared test scaffolding for the Mandate Vault service/autonomy tests: a LOCAL anvil (31337, never a public chain), a seeded database with a
// registry attestation, a pipeline run that yields a pending deploy_testnet decision, and an owner "wallet" that sends transactions with anvil's
// public dev keys. Nothing here touches a public network or a real key.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { createRun, executeRun } from '../src/orchestrator/coordinator.js';
import { recordAttestation } from '../src/attest.js';
import { createApp } from '../src/app.js';
import { loadKeystore } from '../src/agent/keystore.js';
import { evmRpc, sendTransaction, encodeArgs } from '../src/agent/evm-signer.js';
import { signDigest, hexToBytes, privateKeyToAddress } from '../src/agent/secp256k1.js';
import { memDb, fakeConnector, gh } from './helpers.js';

export const BIN = `${homedir()}/.foundry/bin`;
export const haveAnvil = existsSync(`${BIN}/anvil`);
const VAULT_ART = JSON.parse(readFileSync(new URL('../contracts/evm/dist/AgentVault.json', import.meta.url), 'utf8'));
const REG_ART = JSON.parse(readFileSync(new URL('../contracts/evm/dist/ProposalRegistry.json', import.meta.url), 'utf8'));
export { VAULT_ART, REG_ART };

// anvil's documented PUBLIC dev accounts: worthless, never fund them anywhere real.
export const KEY = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  owner: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  other: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
};
const addrOf = (k) => privateKeyToAddress(hexToBytes(k));
export const ADDR = { deployer: addrOf(KEY.deployer), owner: addrOf(KEY.owner), other: addrOf(KEY.other) };
// The REGISTRY's owner/proposer the vault owner fixes (anvil accounts 4 and 5, addresses only).
export const REG_OWNER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
export const REG_PROPOSER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
export const ETH = 10n ** 18n;
export const OPERATOR = 'test-operator-token';
/** Seed for the agent address: enough to pay the gas of its own draw, NOT enough for 3x a registry deploy fee, so the first run must draw. */
export const SEED = ETH / 1000n;

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

export async function startAnvil() {
  const port = await freePort();
  const proc = spawn(`${BIN}/anvil`, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  // The network table pins the local chain to http://127.0.0.1:8545; every RPC goes through guardedFetch, whose fetchImpl we point at this port.
  const baseFetch = (u, init) => fetch(String(u).replace('127.0.0.1:8545', `127.0.0.1:${port}`), init);
  const raw = async (method, params = []) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  return { port, url, proc, baseFetch, raw, stop: () => proc.kill(), blockTime: async () => Number(BigInt((await raw('eth_getBlockByNumber', ['latest', false])).timestamp)) };
}

/** Send a transaction signed by an anvil dev key through the production signer path (sendTransaction). Returns the receipt summary. */
export async function send(anvil, keyHex, { to = null, data = '0x', value = 0n }) {
  const priv = hexToBytes(keyHex);
  const rpc = evmRpc(anvil.url, { fetchImpl: undefined, role: 'launch' });
  const r = await sendTransaction({ rpc, address: addrOf(keyHex), signDigest: (d) => signDigest(d, priv), chainId: 31337, req: { to, data: typeof data === 'string' ? hexToBytes(data) : data, value: BigInt(value) }, maxFeePerTx: 10n ** 18n, pollMs: 20 });
  if (!r.ok) throw new Error(`tx ${r.status}`);
  return r;
}
export const sendAs = (anvil, who, tx) => send(anvil, KEY[who], tx);

export async function deployVault(anvil, owner = ADDR.owner) {
  const initcode = Buffer.concat([Buffer.from(VAULT_ART.bytecode.replace(/^0x/, ''), 'hex'), Buffer.from(encodeArgs(['address'], [owner]))]);
  return (await send(anvil, KEY.deployer, { to: null, data: initcode })).contractAddress;
}

export function tempKeystore() {
  const dir = mkdtempSync(join(tmpdir(), 'autonear-keys-'));
  const path = join(dir, 'agent.keys.json');
  const ks = loadKeystore({ env: { AGENT_KEYS_PATH: path }, create: true });
  return { ks, path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }), privateKeyHex: () => JSON.parse(readFileSync(path, 'utf8')).evm.privateKey };
}

export const offline = async () => { throw new TypeError('offline'); };
export const NAMES = ['unauthorized_propose', 'replay_rejected', 'expired_approve', 'pause_blocks', 'bad_nonce', 'cancel_by_outsider', 'double_execute', 'exceeded_spend', 'wrong_method', 'wrong_target', 'owner_two_step'];

/** In-memory DB with seeded evidence and an attestation of the REAL compiled ProposalRegistry. TEST DOUBLE: the test-name list and commit sha are fixtures. */
export async function seededDb() {
  const db = await memDb();
  const mk = (id, n) => fakeConnector(id, Array.from({ length: n }, (_, i) => gh(i + 1, { externalId: `${id}${i}`, author: `${id}-u${i}`, title: `Treasury multisig payout fails (${id}-${i})`, body: `We cannot rebalance DAO treasury ${id}${i}: multisig approval missing policy`, url: `https://example.org/${id}/${i}` })));
  const usage = fakeConnector('u1', [gh(99, { externalId: 'u99', kind: 'usage', forceTags: ['treasury'], org: 'near', title: 'On-chain: escrow holdings', body: 'fixture usage observation', author: 'rpc', url: 'https://example.org/usage' })]);
  const conns = [mk('s1', 8), mk('s2', 8), mk('s3', 8), usage];
  await registerSources(db, conns);
  for (const c of conns) await ingestSource(db, c);
  await db.run('UPDATE sources SET last_success=?', [Date.now()]);
  await refreshOpportunities(db);
  const sha = createHash('sha256').update(Buffer.from(REG_ART.deployedBytecode.replace(/^0x/, ''), 'hex')).digest('hex');
  await recordAttestation(db, { protocol: 'evm', commitSha: 'test-fixture', manifest: { sha256: sha, bytes: (REG_ART.deployedBytecode.length - 2) / 2, sourceSha256: 'cd'.repeat(32), abi: REG_ART.abi, bytecode: REG_ART.bytecode, deployedBytecode: REG_ART.deployedBytecode }, tests: { passed: 40, failed: 0, lint: true, fuzz: true, names: NAMES } });
  return { db, artifactHash: sha };
}

let runSeq = 0;
/** Run the real pipeline and return the pending deploy_testnet decision for the registry owner/proposer the vault owner approved (or others). */
export async function pendingDecision(db, { owner = REG_OWNER, proposer = REG_PROPOSER, chain = 'evm:31337' } = {}) {
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain, owner, proposer }, idemKey: `vt-${++runSeq}-${Math.random()}` });
  const done = await executeRun(db, run.id, { fetchImpl: offline });
  if (done.state !== 'awaiting_approval') throw new Error(`pipeline ended ${done.state}: ${done.error}`);
  return db.get('SELECT * FROM decisions WHERE run_id=?', [run.id]);
}

/** HTTP-level helper over the web-standard app. */
export function apiClient(app, token = OPERATOR) {
  const ip = `test-ip-${Math.random().toString(36).slice(2)}`; // own rate-limit bucket per client (the app limits writes to 20/min per ip)
  return async (path, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const r = await app(new Request('http://t' + path, { method, headers: { 'x-peer-ip': ip, ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
}

export const MANDATE = { perDrawCap: (ETH / 20n).toString(), periodSecs: 3600, periodCap: (ETH / 10n).toString(), totalCap: (ETH / 4n).toString(), maxDeploys: 3 };

/**
 * A complete world: fresh vault on the shared anvil, fresh keystore (funded with a small seed), fresh DB, vault attached, grant proposed, approved by the
 * OWNER, every human step of GET /api/vault/plan executed VERBATIM from the owner wallet, then re-attached so the server activates the loop.
 */
export async function makeWorld(anvil, opts = {}) {
  const { db, artifactHash } = opts.db ? { db: opts.db, artifactHash: opts.artifactHash } : await seededDb(); // opts.db/keys/artifactHash: a SECOND vault in the same database
  const vault = await deployVault(anvil);
  if (opts.mode !== 'manual') await db.run("INSERT INTO kv(k,v) VALUES('autonomy.mode','auto') ON CONFLICT(k) DO UPDATE SET v='auto'"); // the loop's default is MANUAL; the cycle tests exercise AUTO unless a test asks otherwise
  const keys = opts.keys ?? tempKeystore();
  const agent = keys.ks.publicView().evm.address;
  if ((opts.seed ?? SEED) > 0n) await sendAs(anvil, 'other', { to: agent, value: opts.seed ?? SEED });
  const fetchImpl = opts.fetchImpl ?? anvil.baseFetch;
  const app = createApp({ db, operatorToken: OPERATOR, keystore: keys.ks, signingSupported: true, fetchImpl, defer: () => {} });
  const api = apiClient(app);
  const attach = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: vault } });
  if (attach.status !== 201) throw new Error(`attach ${attach.status} ${attach.text}`);
  const mandate = { ...MANDATE, ...(opts.mandate ?? {}) };
  const prop = await api('/api/vault/mandates/propose', { method: 'POST', body: {
    chainId: 'evm:31337', vault, mandate, templates: [{ artifactHash, owner: REG_OWNER, proposer: REG_PROPOSER }],
    fund: { amount: (opts.fund ?? ETH / 5n).toString() }, loop: { maxPerDay: opts.maxPerDay ?? 5 },
  } });
  if (prop.status !== 201) throw new Error(`propose ${prop.status} ${prop.text}`);
  const grant = prop.json;
  const ap = await api(`/api/decisions/${grant.id}/approve`, { method: 'POST', body: { nonce: grant.nonce, payloadHash: grant.payload_hash, confirm: `approve ${grant.id}`, signer: ADDR.owner } });
  if (ap.status !== 200) throw new Error(`approve ${ap.status} ${ap.text}`);
  const plan = (await api(`/api/vault/plan?decisionId=${grant.id}`)).json;
  const world = { db, app, api, anvil, vault, keys, agent, artifactHash, grant, plan, fetchImpl, mandate };
  if (!opts.skipPlan) {
    for (const s of plan.steps.filter((x) => x.who === 'human' && x.tx)) await sendAs(anvil, 'owner', { to: s.tx.to, data: s.tx.data, value: BigInt(s.tx.value) });
    world.activation = (await api('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: vault } })).json;
  }
  world.vaultId = attach.json.vaultId;
  world.newDecision = (o) => pendingDecision(db, o);
  world.tick = (extra = {}) => import('../src/autonomy.js').then((m) => m.autonomyTick(db, { keystore: keys.ks, signingSupported: true, fetchImpl, signerOpts: { pollMs: 20 }, env: { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5' }, ...extra }));
  world.ledger = async () => (await api('/api/vault/ledger?limit=200')).json;
  world.cleanup = () => keys.cleanup();
  return world;
}
