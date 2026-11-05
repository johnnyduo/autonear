// Agent key material: generate / load / hold. Private keys live ONLY in closures inside this module.
//  - Sources: env (AGENT_EVM_PRIVATE_KEY, AGENT_NEAR_PRIVATE_KEY) wins over the file data/agent.keys.json (mode 0600).
//  - The public view returns addresses / public keys only; handles expose sign() but never the key; every string that
//    leaves this module on an error path goes through redact().
//  - Refuses to load a key file that is group/world accessible, a symlink, or owned by another user.
// HONEST LIMIT: keys are plain process memory while the agent runs. This is a local, testnet-only key store, not an HSM.
import { lstatSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { ROOT } from '../config.js';
import { generatePrivateKey, getPublicKey, privateKeyToAddress, signDigest as secpSign, hexToBytes } from './secp256k1.js';
import { bytesToHex } from './keccak.js';
import { base58Encode } from './base58.js';
import { generateSeed, ed25519PublicKey, ed25519Signer, formatSecretKey, formatPublicKey, parseSecretKey, implicitAccountId } from './near-signer.js';
import { createEvmSigner } from './evm-signer.js';
import { createNearSigner } from './near-signer.js';

export const DEFAULT_KEY_PATH = resolve(ROOT, 'data/agent.keys.json');
export const ENV_EVM = 'AGENT_EVM_PRIVATE_KEY';
export const ENV_NEAR = 'AGENT_NEAR_PRIVATE_KEY';

export class KeystoreError extends Error { constructor(msg) { super(msg); this.name = 'KeystoreError'; } }

/** Throws unless the file is a regular, non-symlink file owned by this user with no group/other permission bits. */
export function assertKeyFileSafe(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new KeystoreError(`key file ${path} is a symlink; refusing to use it`);
  if (!st.isFile()) throw new KeystoreError(`key file ${path} is not a regular file`);
  if (process.platform !== 'win32') {
    if ((st.mode & 0o077) !== 0) throw new KeystoreError(`key file ${path} is accessible by group/others (mode ${(st.mode & 0o777).toString(8).padStart(3, '0')}); run: chmod 600 ${path}`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new KeystoreError(`key file ${path} is owned by another user; refusing to use it`);
  }
}

function parseEvmKey(v) {
  const s = String(v).trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new KeystoreError(`${ENV_EVM} / file evm.privateKey must be 32 bytes of hex (value not shown)`);
  const b = hexToBytes(s); getPublicKey(b); // range check (throws on 0 / >= n)
  return b;
}
function parseNearKey(v) {
  try { return parseSecretKey(String(v).trim()); } catch { throw new KeystoreError(`${ENV_NEAR} / file near.secretKey must be ed25519:<base58> (value not shown)`); }
}

function writeFileAtomic(path, text) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = resolve(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(tmp, 0o600); renameSync(tmp, path); chmodSync(path, 0o600); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

/**
 * Load (and optionally create) the agent keystore.
 * @param {{path?:string, env?:object, create?:boolean}} o  create=true generates any key that neither env nor file provides.
 */
export function loadKeystore({ path, env = process.env, create = false } = {}) {
  path = path ?? (env.AGENT_KEYS_PATH ? resolve(env.AGENT_KEYS_PATH) : DEFAULT_KEY_PATH);
  const secrets = new Set();
  const track = (...vals) => { for (const v of vals) if (v && String(v).length >= 8) secrets.add(String(v)); };
  // Anything in the env vars is treated as secret for redaction even if it fails to parse.
  track(env[ENV_EVM], env[ENV_NEAR], String(env[ENV_EVM] ?? '').replace(/^0x/i, ''), String(env[ENV_NEAR] ?? '').replace(/^ed25519:/, ''));

  let file = null;
  const pathExists = (() => { try { lstatSync(path); return true; } catch { return false; } })(); // lstat: a dangling symlink counts as present
  if (pathExists) {
    assertKeyFileSafe(path);
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new KeystoreError(`key file ${path} is not valid JSON (contents not shown)`); }
    if (!file || typeof file !== 'object') throw new KeystoreError(`key file ${path} has unexpected structure`);
    track(file.evm?.privateKey, String(file.evm?.privateKey ?? '').replace(/^0x/i, ''), file.near?.secretKey, String(file.near?.secretKey ?? '').replace(/^ed25519:/, ''));
  }

  const sources = { evm: null, near: null };
  let evmKey = null; let nearSeed = null; let dirty = false;
  const next = file ? { ...file } : { version: 1, createdAt: new Date().toISOString() };

  if (env[ENV_EVM]) { evmKey = parseEvmKey(env[ENV_EVM]); sources.evm = 'env'; }
  else if (file?.evm?.privateKey) { evmKey = parseEvmKey(file.evm.privateKey); sources.evm = 'file'; }
  else if (create) { evmKey = generatePrivateKey(); next.evm = { privateKey: '0x' + bytesToHex(evmKey) }; sources.evm = 'file'; dirty = true; }

  if (env[ENV_NEAR]) { nearSeed = parseNearKey(env[ENV_NEAR]); sources.near = 'env'; }
  else if (file?.near?.secretKey) { nearSeed = parseNearKey(file.near.secretKey); sources.near = 'file'; }
  else if (create) { nearSeed = generateSeed(); next.near = { secretKey: formatSecretKey(nearSeed) }; sources.near = 'file'; dirty = true; }

  if (dirty) writeFileAtomic(path, JSON.stringify(next, null, 2) + '\n');

  // Everything derived from a secret is tracked for redaction.
  if (evmKey) track('0x' + bytesToHex(evmKey), bytesToHex(evmKey));
  if (nearSeed) track(bytesToHex(nearSeed), base58Encode(nearSeed), formatSecretKey(nearSeed), base58Encode(new Uint8Array([...nearSeed, ...ed25519PublicKey(nearSeed)])), Buffer.from(nearSeed).toString('base64'));
  const secretList = [...secrets].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const secretRe = secretList.length ? new RegExp(secretList.map(esc).join('|'), 'gi') : null;

  /** Scrub known secrets and any key-shaped string from text. */
  const redactText = (text) => {
    let t = String(text);
    if (secretRe) t = t.replace(secretRe, '[REDACTED]');
    t = t.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, '[REDACTED]').replace(/AGENT_(?:EVM|NEAR)_PRIVATE_KEY\s*[=:]\s*\S+/g, 'AGENT_*_PRIVATE_KEY=[REDACTED]');
    return t;
  };
  /** Redact an error IN PLACE (message, stack, cause) so class / code survive; non-errors become a new Error. */
  const redact = (e) => {
    if (typeof e === 'string') return redactText(e);
    if (!(e instanceof Error)) return new Error(redactText(typeof e === 'object' ? JSON.stringify(e) : String(e)));
    try {
      e.message = redactText(e.message);
      if (e.stack) e.stack = redactText(e.stack);
      if (e.cause) e.cause = redact(e.cause);
    } catch { /* frozen error: fall through to a fresh one */ return new Error(redactText(e.message)); }
    return e;
  };

  let evm = null;
  if (evmKey) {
    const key = evmKey; const publicKey = getPublicKey(key); const address = privateKeyToAddress(key);
    evm = Object.freeze({
      chain: 'evm', address, publicKey: '0x' + bytesToHex(publicKey),
      signDigest: (digest) => secpSign(digest, key),
      toJSON: () => ({ chain: 'evm', address }),
      [inspect.custom]: () => `[evm key handle ${address}]`,
    });
  }
  let near = null;
  if (nearSeed) {
    const seed = nearSeed; const pub = ed25519PublicKey(seed); const signFn = ed25519Signer(seed);
    near = Object.freeze({
      chain: 'near', accountId: implicitAccountId(pub), publicKey: pub, publicKeyString: formatPublicKey(pub),
      sign: (msg) => signFn(msg),
      toJSON: () => ({ chain: 'near', accountId: implicitAccountId(pub), publicKey: formatPublicKey(pub) }),
      [inspect.custom]: () => `[near key handle ${implicitAccountId(pub)}]`,
    });
  }

  const view = () => ({
    evm: evm ? { address: evm.address, source: sources.evm } : null,
    near: near ? { account: near.accountId, publicKey: near.publicKeyString, source: sources.near } : null,
  });
  const keystore = {
    /** ONLY addresses / public keys (+ where each key came from: 'env' | 'file'). */
    publicView: view,
    evm, near, redact, redactText,
    path,
    /** Chain-agnostic Signer { chain, address, signAndSend(callSpec, limits) } bound to this keystore's key. */
    signer(chain, opts = {}) {
      if (chain === 'evm') { if (!evm) throw new KeystoreError('no EVM key configured'); return createEvmSigner({ key: evm, redact, ...opts }); }
      if (chain === 'near') { if (!near) throw new KeystoreError('no NEAR key configured'); return createNearSigner({ key: near, redact, ...opts }); }
      throw new KeystoreError(`unknown chain "${String(chain).slice(0, 20)}"`);
    },
    toJSON: view,
    [inspect.custom]: () => `[Keystore ${JSON.stringify(view())}]`,
  };
  return Object.freeze(keystore);
}
