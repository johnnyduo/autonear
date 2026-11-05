// Keccak-256 (the ORIGINAL Keccak padding 0x01, as used by Ethereum; NOT NIST SHA3-256 which pads with 0x06).
// Pure BigInt, zero dependencies. Not constant-time (hashes here are of public data or feed a signer that is not timing-hardened anyway).
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [ // rotation offsets r[x][y], flat index x + 5*y
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  const C = new Array(5); const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) s[y + x] = B[y + x] ^ (~B[y + ((x + 1) % 5)] & MASK & B[y + ((x + 2) % 5)]);
    s[0] ^= RC[round];
  }
}

const enc = new TextEncoder();
export const toBytes = (data) => (typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : Uint8Array.from(data));

/** keccak-256 of bytes (or a UTF-8 string). Returns a 32-byte Uint8Array. */
export function keccak256(data) {
  const msg = toBytes(data);
  const RATE = 136;
  const s = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg); padded[msg.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) { let lane = s[i]; for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; } }
  return out;
}
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const keccak256Hex = (data) => '0x' + bytesToHex(keccak256(data));
