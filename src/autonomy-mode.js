// Owner-facing autonomy mode. kv `autonomy.mode`: 'manual' (default, the loop reconciles but never acts) or 'auto' (the loop may act inside the on-chain mandate).
// This is server state, not a chain transaction: the on-chain limits are the only thing that bounds what 'auto' can do.
import { audit, now } from './db.js';
import { PolicyError } from './policy.js';

export const MODE_KEY = 'autonomy.mode';
export const MODES = Object.freeze(['manual', 'auto']);

export async function getMode(db) {
  return (await db.get('SELECT v FROM kv WHERE k=?', [MODE_KEY]))?.v === 'auto' ? 'auto' : 'manual';
}

export async function setMode(db, mode, actor = 'operator') {
  if (!MODES.includes(mode)) throw new PolicyError(`mode must be one of ${MODES.join(', ')}`, 'input');
  const prev = await getMode(db);
  await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [MODE_KEY, mode]);
  if (prev !== mode) await audit(db, actor, 'autonomy.mode', { from: prev, to: mode, at: now() });
  return mode;
}

/** Gas top-up band (base units). Env AUTONOMY_TOPUP_LOW / AUTONOMY_TOPUP_TARGET override (decimal strings). An invalid or non-positive value falls back to the default; target is forced above low. */
export const TOPUP_DEFAULTS = Object.freeze({
  evm: { low: 3_000_000_000_000_000n, target: 10_000_000_000_000_000n },
  near: { low: 500_000_000_000_000_000_000_000n, target: 2_000_000_000_000_000_000_000_000n },
});
export function topUpConfig(env, protocol) {
  const d = TOPUP_DEFAULTS[protocol]; if (!d) return null;
  const big = (v, def) => { try { const n = BigInt(String(v)); return n > 0n ? n : def; } catch { return def; } };
  const lowMark = big(env.AUTONOMY_TOPUP_LOW, d.low); let target = big(env.AUTONOMY_TOPUP_TARGET, d.target);
  if (target <= lowMark) target = lowMark * 3n;
  return { low: lowMark, target };
}
