// Local nearcore SANDBOX helpers shared by the NEAR end-to-end scripts (copied from scripts/e2e-near-sandbox.mjs, which keeps its own copy).
// Chain id "localnet"; a throw-away home dir; killed on exit. NOT testnet.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function findSandboxBin() {
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
export async function rpcRaw(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json());
}

let CHILD = null; let HOME = null;
const running = () => CHILD && CHILD.exitCode === null && CHILD.signalCode === null;
/** Last-resort synchronous cleanup (process 'exit' / signals): hard-kill the node, remove the throw-away home. */
function cleanup() {
  if (running()) { try { CHILD.kill('SIGKILL'); } catch { /* gone */ } }
  if (HOME && !process.env.KEEP_SANDBOX_HOME) { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } }
}
/** Normal shutdown: SIGTERM, wait for the node to exit (SIGKILL after 15 s), then remove its home so nothing writes into it any more. */
export async function stopSandbox() {
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

export async function startSandbox(bin) {
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

