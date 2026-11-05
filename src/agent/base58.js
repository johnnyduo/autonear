// Base58 (bitcoin alphabet) encode/decode for NEAR keys, signatures and hashes.
// The encoder is src/chains/common.js's, re-exported unchanged so there is exactly one implementation of it.
import { base58 } from '../chains/common.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const base58Encode = base58;
export function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) throw new Error('base58: empty input');
  let n = 0n;
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('base58: invalid character');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0; for (const ch of str) { if (ch === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}
