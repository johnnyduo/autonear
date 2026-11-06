// Owner sign-in: the vault owner proves control of an EVM address by signing a plain-text challenge (EIP-191, no transaction, no cost),
// and gets a short-lived stateless HMAC session token. Scope is enforced in app.js (`needOwner`): only a handful of routes accept it.
//  - EOA signatures only (ecrecover). Contract-wallet / multisig owners cannot sign in; they use the operator token.
//  - The authoritative owner is re-resolved on EVERY request (resolveOwner), so an owner transfer or env change kills old sessions.
//  - A challenge nonce is consumed by ONE atomic conditional insert (rows changed), never read-then-delete, and only after the
//    recovered address equals the owner, so strangers cannot grow the table.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { keccak256 } from './agent/keccak.js';
import { hexToBytes, publicKeyToAddressLower, recoverPublicKey } from './agent/secp256k1.js';
import { now } from './db.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 8 * 3600_000;
const low = (a) => String(a ?? '').toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

/** EIP-191 personal_sign recovery (EOA). Pure data ops: no secret is involved, so the non-constant-time BigInt math is fine here. */
export function recoverMessageAddress({ message, signature }) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('bad signature');
  const sig = hexToBytes(signature);
  let v = sig[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('bad signature');
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak256(Uint8Array.from([...prefix, ...body]));
  return publicKeyToAddressLower(recoverPublicKey(digest, { r: sig.subarray(0, 32), s: sig.subarray(32, 64), recovery: v }));
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export const deriveSecret = (operatorToken) => (operatorToken ? createHmac('sha256', operatorToken).update('owner-session-v1').digest() : null);

/** Single authoritative owner: OWNER_ADDRESS if set, else the one EVM owner shared by all attached vaults, else null (operator token only). */
export async function resolveOwner(db, envOwner = '') {
  if (envOwner) return isAddress(envOwner) ? low(envOwner) : null;
  const rows = await db.all('SELECT DISTINCT owner FROM vaults');
  const owners = [...new Set(rows.map((r) => r.owner).filter((o) => isAddress(String(o))).map(low))];
  return owners.length === 1 ? owners[0] : null;
}

export function buildChallenge({ host, address, t = now(), nonce = randomBytes(16).toString('hex') }) {
  const exp = t + CHALLENGE_TTL_MS;
  const message = [
    'AutoNEAR owner sign-in', '',
    'Sign this message to prove you own this wallet. Sign-in only: no transaction, no cost, nothing is sent on chain.', '',
    `Domain: ${host}`, `Address: ${address}`, `Nonce: ${nonce}`, `Issued At: ${new Date(t).toISOString()}`, `Expires At: ${new Date(exp).toISOString()}`,
  ].join('\n');
  return { message, nonce, exp };
}

const field = (m, k) => new RegExp(`^${k}: (.+)$`, 'm').exec(m)?.[1]?.trim() ?? '';

/** Validates the signed challenge and returns the lowercase signer, or throws an Error with a short reason. */
export async function checkSignedChallenge({ message, signature, address, host, t = now() }) {
  if (typeof message !== 'string' || message.length > 1000 || typeof signature !== 'string' || !isAddress(String(address))) throw new Error('bad request');
  if (field(message, 'Domain') !== host) throw new Error('challenge was issued for another site');
  if (low(field(message, 'Address')) !== low(address)) throw new Error('challenge address mismatch');
  const exp = Date.parse(field(message, 'Expires At')); const iat = Date.parse(field(message, 'Issued At'));
  if (!Number.isFinite(exp) || !Number.isFinite(iat) || t > exp || exp - iat > CHALLENGE_TTL_MS || iat > t + 60_000) throw new Error('challenge expired');
  const nonce = field(message, 'Nonce');
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('bad nonce');
  let rec; try { rec = recoverMessageAddress({ message, signature }); } catch { throw new Error('bad signature'); }
  if (low(rec) !== low(address)) throw new Error('signature is not from that address');
  return { signer: low(rec), nonce, exp };
}

/** Atomic single use: true only for the first caller. */
export async function consumeNonce(db, nonce, exp) {
  await db.run('DELETE FROM kv WHERE k LIKE ? AND CAST(v AS INTEGER) < ?', ['nonce:%', now()]).catch(() => {});
  const r = await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING', [`nonce:${nonce}`, String(exp)]);
  return r.changes === 1;
}

export function issueSession({ address, secret, t = now(), ttlMs = SESSION_TTL_MS }) {
  const p = b64({ a: low(address), exp: t + ttlMs });
  return `${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`;
}

export function readSession(token, { secret, t = now() }) {
  if (!secret || typeof token !== 'string' || token.length > 400) return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const want = Buffer.from(createHmac('sha256', secret).update(p).digest('base64url')); const got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  return o && typeof o.a === 'string' && Number.isFinite(o.exp) && o.exp > t ? { address: o.a, exp: o.exp } : null;
}
