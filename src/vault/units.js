// Pure unit helpers shared by policy (spend ceilings), the vault core and the CLI. No I/O.
export const UNITS = Object.freeze({
  evm: Object.freeze({ symbol: 'ETH', base: 'wei', decimals: 18 }),
  near: Object.freeze({ symbol: 'NEAR', base: 'yoctoNEAR', decimals: 24 }),
});

/** "0.05" -> 50000000000000000n. Strict: digits with an optional fractional part, no sign, no exponent. null when invalid. */
export function parseUnits(text, decimals) {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(String(text).trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** 50000000000000000n -> "0.05" (trailing zeros trimmed). */
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n; const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base; const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** JSON-safe deep copy: BigInt -> decimal string. */
export const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
