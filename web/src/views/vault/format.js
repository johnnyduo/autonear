// Pure helpers for the Vault views: exact BigInt unit formatting, time normalisation, chain metadata, derived vault state.
// No React, no I/O. Amounts arrive as decimal strings in base units (wei / yoctoNEAR); nothing here ever uses floating point for money.

/** Fixture mode needs the explicit `fixture=1` query inside the hash (defined in api.js so the shell can use it without loading this module). */
export { isFixtureMode } from '../../api.js';
export function fixtureScenario() {
  try { return new URLSearchParams((location.hash || '').split('?')[1] || '').get('scenario') || 'default'; } catch { return 'default'; }
}

/* ---------- chains (testnets only). Mirrors src/protocols.js ids; explorer bases are address pages. ---------- */
export const CHAIN_META = {
  'evm:11155111': { label: 'Ethereum Sepolia', short: 'Sepolia', symbol: 'ETH', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://sepolia.etherscan.io/address/' },
  'evm:84532': { label: 'Base Sepolia', short: 'Base Sepolia', symbol: 'ETH', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://sepolia.basescan.org/address/' },
  'evm:421614': { label: 'Arbitrum Sepolia', short: 'Arb Sepolia', symbol: 'ETH', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://sepolia.arbiscan.io/address/' },
  'evm:11155420': { label: 'OP Sepolia', short: 'OP Sepolia', symbol: 'ETH', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://sepolia-optimism.etherscan.io/address/' },
  'evm:10143': { label: 'Monad testnet', short: 'Monad testnet', symbol: 'MON', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://testnet.monadexplorer.com/address/' },
  'evm:97': { label: 'BNB Chain testnet', short: 'BNB testnet', symbol: 'tBNB', decimals: 18, base: 'wei', kind: 'evm', addr: 'https://testnet.bscscan.com/address/' },
  'evm:31337': { label: 'Local anvil (not a public chain)', short: 'Local anvil', symbol: 'ETH', decimals: 18, base: 'wei', kind: 'evm', addr: '' },
  'near-testnet': { label: 'NEAR testnet', short: 'NEAR testnet', symbol: 'NEAR', decimals: 24, base: 'yoctoNEAR', kind: 'near', addr: 'https://testnet.nearblocks.io/address/' },
};
export const normChain = (c) => (typeof c === 'number' || /^\d+$/.test(String(c)) ? `evm:${c}` : String(c ?? ''));
export const chainMeta = (c) => CHAIN_META[normChain(c)] ?? null;
export const unitOf = (v) => v?.unit ?? chainMeta(v?.chainId) ?? { symbol: 'units', decimals: 0, base: 'base units' };
export const explorerAddr = (chainId, addr) => { const m = chainMeta(chainId); return m?.addr && addr ? `${m.addr}${addr}` : ''; };
export const protoOfChain = (c) => (chainMeta(c)?.kind ?? (String(c).startsWith('near') ? 'near' : 'evm'));

/* ---------- amounts ---------- */
const big = (v) => { try { if (typeof v === 'bigint') return v; if (v === null || v === undefined || v === '') return null; return BigInt(String(v)); } catch { return null; } };
export const toBig = big;

/** Exact decimal string for a base-unit integer. */
export function exactDecimal(base, decimals) {
  const b = big(base); if (b === null) return null;
  const neg = b < 0n; const s = (neg ? -b : b).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals); const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
/**
 * Display form: at most `max` fractional digits (truncated, never rounded up), exact value always available.
 * @returns {{text:string, exact:string, lossy:boolean, base:string}|null}
 */
export function fmtAmount(base, decimals, max = 6) {
  const b = big(base); if (b === null) return null;
  const exact = exactDecimal(b, decimals); const [w, f = ''] = exact.split('.');
  const cut = f.slice(0, max).replace(/0+$/, ''); const lossy = f.length > max && f.slice(max).replace(/0/g, '') !== '';
  let text = cut ? `${w}.${cut}` : w;
  if (b > 0n && text === '0') text = `<0.${'0'.repeat(max - 1)}1`;
  return { text, exact, lossy, base: b.toString() };
}
/** Fraction (0..1) of a/b using BigInt maths; 0 when b is 0. */
export function ratio(a, b) {
  const x = big(a); const y = big(b); if (x === null || y === null || y === 0n) return 0;
  if (x >= y) return 1; if (x <= 0n) return 0;
  return Number((x * 10000n) / y) / 10000;
}
/** User input ("0.015") to base units; null when not a valid non-negative decimal within `decimals` places. */
export function parseUnits(str, decimals) {
  const s = String(str ?? '').trim(); if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.'); if (f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, '0'));
}

/* ---------- time. Chain times are seconds, server/ledger times are ms; accept either (a seconds epoch is < 1e11). ---------- */
export const toMs = (t) => { const n = Number(t); if (!Number.isFinite(n) || n <= 0) return 0; return n < 1e11 ? n * 1000 : n; };
export const toSec = (t) => Math.floor(toMs(t) / 1000);

/** Compact duration for countdowns: 6d 04h, 3h 12m, 12m 04s, 41s. */
export function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${p(h)}h`; if (h) return `${h}h ${p(m)}m`; if (m) return `${m}m ${p(s % 60)}s`; return `${s}s`;
}
export const secsLabel = (s) => { const n = Number(s); if (!Number.isFinite(n)) return '–'; if (n % 86400 === 0) return `${n / 86400} d`; if (n % 3600 === 0) return `${n / 3600} h`; if (n % 60 === 0) return `${n / 60} min`; return `${n} s`; };
export const when = (t) => { const ms = toMs(t); return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '–'; };
export const ago = (t, now = Date.now()) => { const ms = toMs(t); if (!ms) return 'never'; const s = Math.max(0, Math.round((now - ms) / 1000)); if (s < 5) return 'just now'; return `${span(s * 1000)} ago`; };

/* ---------- derived state ---------- */
export function vaultFlags(v, nowMs) {
  const m = v?.mandate ?? null; const expired = Boolean(m) && toMs(m.expiresAt) <= nowMs;
  const f = { hasMandate: Boolean(m), revoked: Boolean(m?.revoked), expired, paused: Boolean(v?.paused), codeBad: v?.codeOk === false, readErr: Boolean(v?.readError) };
  f.active = f.hasMandate && !f.revoked && !f.expired && !f.paused && !f.codeBad;
  return f;
}
/** One headline per vault: the most serious true thing about it. */
export function vaultHeadline(v, nowMs) {
  const f = vaultFlags(v, nowMs);
  if (f.codeBad) return { key: 'code', tone: 'bad', label: 'Code mismatch', why: 'The code at the vault address does not match the attested build. The agent must not use it.' };
  if (f.revoked) return { key: 'revoked', tone: 'bad', label: 'Revoked', why: 'The owner revoked this mandate. The agent can do nothing.' };
  if (f.expired) return { key: 'expired', tone: 'bad', label: 'Expired', why: 'The mandate ran past its expiry. The agent can do nothing until the owner grants a new one.' };
  if (f.paused) return { key: 'paused', tone: 'warn', label: 'Vault paused', why: 'The owner paused the vault: agent operations are blocked, owner operations still work.' };
  if (!f.hasMandate) return { key: 'none', tone: '', label: 'No mandate', why: 'No mandate has been set on this vault. The agent can do nothing.' };
  if (f.readErr) return { key: 'read', tone: 'warn', label: 'Read error', why: 'The last chain read failed; the numbers shown are older.' };
  return { key: 'active', tone: 'ok', label: 'Active', why: 'Inside its mandate: the agent may draw gas and deploy allowlisted templates within the budget.' };
}
export const gaugeTone = (frac) => (frac >= 0.35 ? 'ok' : frac >= 0.12 ? 'warn' : 'bad');
export const gaugeWord = (frac, remaining) => (big(remaining) === 0n ? 'exhausted' : frac >= 0.35 ? 'healthy' : frac >= 0.12 ? 'low' : 'nearly out');

export const LOOP = {
  running: { tone: 'ok', word: 'Running', note: 'The loop is ticking: it re-reads the chain, and may approve and deploy under the mandate.' },
  idle: { tone: '', word: 'Idle', note: 'Enabled and waiting: no active mandate, or no eligible pending deploy decision.' },
  paused: { tone: 'warn', word: 'Paused', note: 'An operator paused the loop. Nothing executes until it is resumed.' },
  blocked: { tone: 'bad', word: 'Blocked', note: 'An integrity check failed. The loop stopped itself and stays stopped until an operator resumes it.' },
};

/** Server-ceiling hints and contract rules for the propose form (docs/agent-vault-spec.md). Hints only: the server decides. */
export const RULES = {
  maxExpiryHours: 720, minPeriodSecs: 60, maxPeriodSecs: 30 * 86400, maxDeploys: 1000,
  defaultTotalCeiling: { evm: '500000000000000000', near: '20000000000000000000000000' }, // 0.5 ETH / 20 NEAR (VAULT_MAX_TOTAL_CAP default)
};
