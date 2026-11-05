// Minimal RLP (Ethereum yellow paper appendix B). Items are Uint8Array or (nested) arrays.
// Integers must be converted explicitly with rlpInt() so that 0 -> empty string, never a stray 0x00 byte.
export function rlpInt(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error('rlp: negative integer');
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Uint8Array.from(out);
}
const lenBytes = (n) => rlpInt(n);
function concat(parts) { const o = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of parts) { o.set(x, p); p += x.length; } return o; }

export function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([prefix(item.length, 0x80), item]);
  }
  if (Array.isArray(item)) {
    const body = concat(item.map(rlpEncode));
    return concat([prefix(body.length, 0xc0), body]);
  }
  throw new Error('rlp: items must be Uint8Array or arrays (use rlpInt for integers)');
}
function prefix(len, base) {
  if (len < 56) return Uint8Array.of(base + len);
  const lb = lenBytes(len);
  return concat([Uint8Array.of(base + 55 + lb.length), lb]);
}

/** Strict decoder (canonical forms only), used by tests and to sanity-check what we serialise. */
export function rlpDecode(buf) {
  const [item, used] = dec(buf, 0);
  if (used !== buf.length) throw new Error('rlp: trailing bytes');
  return item;
}
function readLen(buf, pos, n) {
  if (pos + n > buf.length) throw new Error('rlp: truncated');
  if (buf[pos] === 0) throw new Error('rlp: non-canonical length');
  let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i];
  return v;
}
function dec(buf, pos) {
  if (pos >= buf.length) throw new Error('rlp: truncated');
  const b = buf[pos];
  if (b < 0x80) return [buf.subarray(pos, pos + 1), pos + 1];
  if (b < 0xb8) { const n = b - 0x80; if (pos + 1 + n > buf.length) throw new Error('rlp: truncated'); if (n === 1 && buf[pos + 1] < 0x80) throw new Error('rlp: non-canonical'); return [buf.subarray(pos + 1, pos + 1 + n), pos + 1 + n]; }
  if (b < 0xc0) { const ll = b - 0xb7; const n = readLen(buf, pos + 1, ll); if (n < 56) throw new Error('rlp: non-canonical'); const s = pos + 1 + ll; if (s + n > buf.length) throw new Error('rlp: truncated'); return [buf.subarray(s, s + n), s + n]; }
  let n; let s;
  if (b < 0xf8) { n = b - 0xc0; s = pos + 1; } else { const ll = b - 0xf7; n = readLen(buf, pos + 1, ll); if (n < 56) throw new Error('rlp: non-canonical'); s = pos + 1 + ll; }
  if (s + n > buf.length) throw new Error('rlp: truncated');
  const items = []; let p = s;
  while (p < s + n) { const [it, np] = dec(buf, p); items.push(it); p = np; }
  if (p !== s + n) throw new Error('rlp: list length mismatch');
  return [items, s + n];
}
