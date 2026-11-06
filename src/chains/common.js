import { guardedFetch } from '../http-client.js';
export async function jsonRpc(role, url, method, params, { fetchImpl } = {}) {
  const res = await guardedFetch(role, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), fetchImpl });
  const out = JSON.parse(res.text);
  if (out.error) throw new Error(`${method}: ${out.error.message ?? ''} ${typeof out.error.data === 'string' ? out.error.data : ''}`.trim());
  // Newer nodes (fastnear) answer a failed NEAR query with HTTP 200 and { result: { error: '...' } } instead of a JSON-RPC error. Raise it here, once, for every caller:
  // otherwise a missing account / key / pruned block reads as an empty-but-valid answer (for example "0 access keys" on a code-immutability check).
  if (out.result && typeof out.result === 'object' && !Array.isArray(out.result) && typeof out.result.error === 'string') throw new Error(`${method}: ${out.result.error}`.slice(0, 400));
  return out.result;
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
export const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));
export const check = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail });
