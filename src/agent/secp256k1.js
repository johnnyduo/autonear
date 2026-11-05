// Pure-BigInt secp256k1 for the agent's own EVM key: key -> public key -> EIP-55 address, RFC 6979 deterministic ECDSA
// (HMAC-SHA256 via node:crypto), low-s, recovery id, public-key recovery.
// HONEST LIMITS: BigInt arithmetic and the double-and-add ladder are NOT constant-time. This is acceptable for a local
// testnet agent key that never signs attacker-chosen messages over a timing-observable channel; do not reuse it as a general
// purpose or mainnet signing library.
import { createHmac, randomBytes } from 'node:crypto';
import { keccak256, bytesToHex } from './keccak.js';

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) { // extended Euclid
  let [r0, r1] = [mod(a, m), m]; let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  if (r0 !== 1n) throw new Error('not invertible');
  return mod(s0, m);
}
function pow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }

// Jacobian points [X, Y, Z]; infinity is Z = 0.
const INF = [0n, 1n, 0n];
function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const A = (X * X) % P; const B = (Y * Y) % P; const C = (B * B) % P;
  const D = mod(2n * (mod((X + B) ** 2n) - A - C));
  const E = 3n * A; const F = (E * E) % P;
  const X3 = mod(F - 2n * D); const Y3 = mod(E * (D - X3) - 8n * C); const Z3 = mod(2n * Y * Z);
  return [X3, Y3, Z3];
}
function add(p, q) {
  if (p[2] === 0n) return q; if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p; const [X2, Y2, Z2] = q;
  const Z1Z1 = (Z1 * Z1) % P; const Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P; const U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P; const S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? dbl(p) : INF;
  const H = mod(U2 - U1); const I = (4n * H * H) % P; const J = (H * I) % P; const r = mod(2n * (S2 - S1)); const V = (U1 * I) % P;
  const X3 = mod(r * r - J - 2n * V); const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod((mod((Z1 + Z2) ** 2n) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
}
function mul(p, k) {
  let r = INF; let q = p;
  for (let e = k; e > 0n; e >>= 1n) { if (e & 1n) r = add(r, q); q = dbl(q); }
  return r;
}
function toAffine([X, Y, Z]) {
  if (Z === 0n) return null;
  const zi = inv(Z); const zi2 = (zi * zi) % P;
  return { x: (X * zi2) % P, y: (Y * zi2 * zi) % P };
}
const G = [GX, GY, 1n];
const isOnCurve = (x, y) => mod(y * y - (x * x * x + 7n)) === 0n;

// ---- byte/bigint helpers
export const bytesToBigInt = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
export function bigIntToBytes(n, len = 32) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  if (n !== 0n) throw new Error('integer too large for field');
  return out;
}
export const hexToBytes = (h) => {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('invalid hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

export function assertPrivateKey(priv) {
  if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error('secp256k1 private key must be 32 bytes');
  const d = bytesToBigInt(priv);
  if (d <= 0n || d >= N) throw new Error('secp256k1 private key out of range');
  return d;
}

/** Fresh random private key (rejection-sampled into [1, n-1]). */
export function generatePrivateKey() {
  for (;;) { const b = randomBytes(32); const d = bytesToBigInt(b); if (d > 0n && d < N) return new Uint8Array(b); }
}

/** 65-byte uncompressed public key (0x04 || X || Y). */
export function getPublicKey(priv) {
  const a = toAffine(mul(G, assertPrivateKey(priv)));
  return concat(Uint8Array.of(4), bigIntToBytes(a.x), bigIntToBytes(a.y));
}

function parsePublicKey(pub) {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('expected 65-byte uncompressed public key');
  const x = bytesToBigInt(pub.subarray(1, 33)); const y = bytesToBigInt(pub.subarray(33));
  if (x >= P || y >= P || !isOnCurve(x, y)) throw new Error('public key not on curve');
  return [x, y, 1n];
}

/** Last 20 bytes of keccak256(X||Y), lowercase 0x-hex. */
export function publicKeyToAddressLower(pub) {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('expected 65-byte uncompressed public key');
  return '0x' + bytesToHex(keccak256(pub.subarray(1)).subarray(12));
}

/** EIP-55 mixed-case checksum. */
export function toChecksumAddress(addr) {
  const a = String(addr).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('invalid address');
  const h = bytesToHex(keccak256(a));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}
export const publicKeyToAddress = (pub) => toChecksumAddress(publicKeyToAddressLower(pub));
export const privateKeyToAddress = (priv) => publicKeyToAddress(getPublicKey(priv));
/** Accepts all-lower / all-upper (no checksum claim) or a correct EIP-55 mixed case; rejects a wrong checksum. */
export function isValidAddress(addr) {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(addr) === addr;
}

const hmac = (key, ...parts) => { const h = createHmac('sha256', key); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };

/** RFC 6979 section 3.2 nonce generator (HMAC-SHA256, qlen = 256). Yields candidates until the caller accepts one. */
function* rfc6979(d, digest) {
  const x = bigIntToBytes(d); const h1 = bigIntToBytes(mod(bytesToBigInt(digest), N)); // bits2octets
  let V = new Uint8Array(32).fill(1); let K = new Uint8Array(32);
  K = hmac(K, V, Uint8Array.of(0), x, h1); V = hmac(K, V);
  K = hmac(K, V, Uint8Array.of(1), x, h1); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bytesToBigInt(V);
    if (k >= 1n && k < N) yield k;
    K = hmac(K, V, Uint8Array.of(0)); V = hmac(K, V);
  }
}

/**
 * Sign a 32-byte digest. Deterministic (RFC 6979), canonical low-s. Returns { r, s, recovery } where r,s are 32-byte
 * Uint8Arrays and recovery is 0..3 (bit 0 = parity of R.y after low-s normalisation, bit 1 = R.x >= n).
 */
export function signDigest(digest, priv) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('digest must be 32 bytes');
  const d = assertPrivateKey(priv);
  const z = bytesToBigInt(digest);
  for (const k of rfc6979(d, digest)) {
    const R = toAffine(mul(G, k));
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let recovery = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
    if (s > HALF_N) { s = N - s; recovery ^= 1; }
    return { r: bigIntToBytes(r), s: bigIntToBytes(s), recovery };
  }
  throw new Error('unreachable');
}

/** Recover the 65-byte uncompressed public key from (digest, r, s, recovery). */
export function recoverPublicKey(digest, { r, s, recovery }) {
  const rn = bytesToBigInt(r); const sn = bytesToBigInt(s);
  if (rn <= 0n || rn >= N || sn <= 0n || sn >= N) throw new Error('bad signature');
  const x = rn + (recovery & 2 ? N : 0n);
  if (x >= P) throw new Error('bad recovery id');
  const y2 = mod(x * x * x + 7n);
  let y = pow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) throw new Error('bad signature: r is not on the curve');
  if (Number(y & 1n) !== (recovery & 1)) y = P - y;
  const R = [x, y, 1n];
  const rinv = inv(rn, N); const z = bytesToBigInt(digest);
  const Q = add(mul(R, mod(sn * rinv, N)), mul(G, mod(-z * rinv, N)));
  const a = toAffine(Q);
  if (!a) throw new Error('bad signature');
  return concat(Uint8Array.of(4), bigIntToBytes(a.x), bigIntToBytes(a.y));
}

export function verifyDigest(digest, { r, s }, pub) {
  const rn = bytesToBigInt(r); const sn = bytesToBigInt(s);
  if (rn <= 0n || rn >= N || sn <= 0n || sn >= N) return false;
  const w = inv(sn, N); const z = bytesToBigInt(digest);
  const pt = toAffine(add(mul(G, mod(z * w, N)), mul(parsePublicKey(pub), mod(rn * w, N))));
  return pt !== null && mod(pt.x, N) === rn;
}
