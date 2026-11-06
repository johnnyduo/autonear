import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.url is undefined in the Workers runtime; ROOT is only used for Node-side files (.env, data/).
export const ROOT = import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : '/';

function loadDotEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => {
  const n = Number(env(k, String(d)));
  return Number.isFinite(n) ? n : d;
};

export function operatorToken() {
  if (env('OPERATOR_TOKEN')) return env('OPERATOR_TOKEN');
  if (process.env.VERCEL) return ''; // read-only FS: OPERATOR_TOKEN must be set; empty token disables all mutations
  const p = resolve(ROOT, 'data/operator.token');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  mkdirSync(dirname(p), { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(p, t + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  return t;
}

/** Autonomy kill switch. Read from the environment at CALL time (not import time) and OFF unless exactly "1" / "true". */
export const autonomyEnabled = (e = process.env) => e.AUTONOMY_ENABLED === '1' || e.AUTONOMY_ENABLED === 'true';
/** Compiled-in ceiling on agent executions per rolling 24h, whatever the env or an approved payload says. */
export const AUTONOMY_HARD_MAX_PER_DAY = 50;
export const autonomyMaxPerDay = (e = process.env) => {
  const n = Number(e.AUTONOMY_MAX_PER_DAY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, AUTONOMY_HARD_MAX_PER_DAY) : 5;
};

export const config = {
  port: num('PORT', 8787),
  ownerAddress: env('OWNER_ADDRESS'),
  host: env('HOST', '127.0.0.1'),
  dbPath: resolve(ROOT, env('DB_PATH', 'data/autonear.db')),
  databaseUrl: env('DATABASE_URL'),
  databaseAuthToken: env('DATABASE_AUTH_TOKEN'),
  cronSecret: env('CRON_SECRET'),
  onVercel: Boolean(process.env.VERCEL),
  ingestIntervalMs: Math.max(60_000, num('INGEST_INTERVAL_MS', 900_000)),
  githubToken: env('GITHUB_TOKEN'),
  llm: {
    provider: env('LLM_PROVIDER', 'none'),
    anthropicKey: env('ANTHROPIC_API_KEY'),
    anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    gatewayKey: env('AI_GATEWAY_API_KEY'),
    gatewayUrl: env('AI_GATEWAY_URL', 'https://ai-gateway.vercel.sh/v1/chat/completions'),
    gatewayModel: env('AI_GATEWAY_MODEL', 'anthropic/claude-sonnet-5-5'),
  },
  budget: { usd: num('RUN_BUDGET_USD', 0.5), tokens: num('RUN_BUDGET_TOKENS', 60000) },
  near: {
    network: env('NEAR_NETWORK', 'testnet'),
    testnetRpc: env('NEAR_TESTNET_RPC', 'https://rpc.testnet.near.org'),
    mainnetRpc: env('NEAR_MAINNET_RPC', 'https://rpc.mainnet.near.org'),
    deployAccount: env('NEAR_DEPLOY_ACCOUNT'),
  },
  // Mandate Vault / agent wallet. Secrets are NEVER read here (src/agent/keystore.js owns AGENT_*_PRIVATE_KEY and the key file).
  agent: { keysPath: env('AGENT_KEYS_PATH'), publicUrl: env('AGENT_PUBLIC_URL') },
  vault: { maxTotalCap: env('VAULT_MAX_TOTAL_CAP'), autonomyIntervalMs: Math.max(10_000, num('AUTONOMY_INTERVAL_MS', 60_000)) },
  engines: {
    pythia: env('PYTHIA_ENABLED', 'false') === 'true',
    mirofishUrl: env('MIROFISH_URL'),
    kronos: env('KRONOS_ENABLED', 'false') === 'true',
  },
};
