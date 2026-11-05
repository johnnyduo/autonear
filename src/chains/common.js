import { guardedFetch } from '../http-client.js';
export async function jsonRpc(role, url, method, params, { fetchImpl } = {}) {
  const res = await guardedFetch(role, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), fetchImpl });
  const out = JSON.parse(res.text);
  if (out.error) throw new Error(`${method}: ${out.error.message ?? ''} ${typeof out.error.data === 'string' ? out.error.data : ''}`.trim());
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
