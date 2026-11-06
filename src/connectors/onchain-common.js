// Shared helpers for the on-chain and official-feed connectors (DefiLlama, NearBlocks, Sputnik DAOs, NEAR feed).
// All of them read public, unauthenticated endpoints through guardedFetch (host allowlist, timeout, size cap).
import { guardedFetch } from '../http-client.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pause between calls to a rate-limited API; zero when a test injects fetchImpl. */
export const pause = (ctx, ms) => (ctx.fetchImpl ? Promise.resolve() : sleep(ms));

export async function getJson(role, url, ctx, opts = {}) {
  const res = await guardedFetch(role, url, { fetchImpl: ctx.fetchImpl, headers: { accept: 'application/json' }, ...opts });
  try { return JSON.parse(res.text); } catch { throw new Error(`${new URL(url).hostname}: response is not JSON`); }
}

/** Finite number from a number or a numeric string, else null. Never coerces junk to 0. */
export const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
export const usd = (n) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};
export const int = (n) => Math.round(n).toLocaleString('en-US');
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
/** yoctoNEAR (string) -> "1234.56" NEAR, BigInt maths. */
export const nearOf = (yocto) => { const s = BigInt(yocto); const d = 10n ** 24n; return `${s / d}.${(s % d).toString().padStart(24, '0').slice(0, 2)}`; };
