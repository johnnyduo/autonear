// Single outbound HTTP path. Enforces per-role host allowlist, timeout, response-size cap.
// redirect: 'manual' (not 'error'): Workers rejects 'error'. A 3xx is non-ok, so it still fails closed below and is never followed.
const MAX_BYTES = 4_000_000;

export class HttpError extends Error {
  constructor(msg, { status = 0, retryAfter = null, headers = null } = {}) { super(msg); this.status = status; this.retryAfter = retryAfter; this.headers = headers; }
}

const RPC_HOSTS = ['rpc.mainnet.near.org', 'rpc.testnet.near.org', 'ethereum-sepolia-rpc.publicnode.com', 'sepolia.base.org', 'sepolia-rollup.arbitrum.io', 'sepolia.optimism.io', 'testnet-rpc.monad.xyz', 'bsc-testnet-rpc.publicnode.com'];
export const ALLOWED_HOSTS = {
  // Public, unauthenticated evidence reads. Social hosts (each verified by a live request 2026-11-05, see PROGRESS.md):
  //   api.near.social (SocialDB index/get API) · mastodon.social, mastodon.online (public hashtag timelines) · haatz.quilibrium.com (community Farcaster hub)
  //   dev.to (Forem articles API). api.bsky.app is deliberately NOT allowed: Bluesky search goes through the credentialed role below.
  collector: new Set(['api.github.com', 'hn.algolia.com', 'gov.near.org', 'rpc.mainnet.near.org', 'rpc.testnet.near.org', '1click.chaindefuser.com',
    'api.near.social', 'mastodon.social', 'mastodon.online', 'haatz.quilibrium.com', 'dev.to']),
  // Credentialed reads: the ONLY role that may carry a login (Bluesky app password -> session token) and only to the PDS host.
  credentialed: new Set(['bsky.social']),
  monitor: new Set(RPC_HOSTS),
  launch: new Set([...RPC_HOSTS, '1click.chaindefuser.com']),
  llm: new Set(['api.anthropic.com', 'ai-gateway.vercel.sh']),
};

async function readCapped(res, max) {
  if (!res.body?.getReader) { const t = await res.text(); if (t.length > max) throw new HttpError('response too large', { status: res.status }); return t; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let n = 0; let out = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.byteLength; if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new HttpError('response too large', { status: res.status }); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

export async function guardedFetch(role, url, { method = 'GET', headers = {}, body, timeoutMs = 12_000, fetchImpl = fetch } = {}) {
  const u = new URL(url);
  const allow = ALLOWED_HOSTS[role];
  const loopback = (role === 'monitor' || role === 'launch') && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && !process.env.VERCEL;
  if (!allow || (!loopback && (u.protocol !== 'https:' || !allow.has(u.hostname)))) throw new HttpError(`policy: role "${role}" may not reach ${u.hostname}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers: { 'user-agent': 'autonear/0.1 (+https://github.com/autonear)', ...headers }, body, signal: ac.signal, redirect: 'manual' });
    const text = await readCapped(res, MAX_BYTES);
    if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${u.hostname}`, { status: res.status, retryAfter: res.headers.get('retry-after'), headers: res.headers });
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `network error: ${e.message}`);
  } finally { clearTimeout(t); }
}
