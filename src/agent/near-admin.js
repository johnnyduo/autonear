// TEST / SETUP-ONLY NEAR signing helper. NOT used by the autonomy loop and NOT part of the agent's capabilities.
//
// src/agent/near-signer.js (deliberately) serialises only FunctionCall + Transfer and enforces vault-only limits. To set up a
// sandbox (create accounts, deploy the vault wasm, call owner methods with a deposit) the tests need more actions. This module adds
// them using the SAME primitives (node:crypto ed25519 via near-signer, the same borsh layout, the same base58) so the setup is
// signed by OUR serialisation, not by a Rust SDK:
//   CreateAccount (0), DeployContract (1), FunctionCall (2, with deposit), Transfer (3), AddKey (5, FullAccess | FunctionCall
//   permission), DeleteKey (6).
// Not supported on purpose: Stake, DeleteAccount, Delegate.
// Refuses any RPC whose chain_id is not testnet / sandbox / localnet. The caller passes the secret key; nothing here stores or logs it.
import { base58Encode } from './base58.js';
import {
  nearRpc, summarizeTxResult, transactionHash, serializeSignedTransaction, ed25519Signer, ed25519PublicKey, parseSecretKey,
  formatPublicKey, parsePublicKey, implicitAccountId,
} from './near-signer.js';

const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

class W {
  #p = [];
  u8(n) { this.#p.push(Uint8Array.of(n)); return this; }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.#p.push(b); return this; }
  u64(n) { const v = BigInt(n); if (v < 0n || v >= 1n << 64n) throw new Error('borsh: u64 out of range'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.#p.push(b); return this; }
  u128(n) { let v = BigInt(n); if (v < 0n || v >= 1n << 128n) throw new Error('borsh: u128 out of range'); const b = new Uint8Array(16); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } this.#p.push(b); return this; }
  raw(x) { this.#p.push(Uint8Array.from(x)); return this; }
  bytes(x) { return this.u32(x.length).raw(x); }
  string(s) { return this.bytes(new TextEncoder().encode(s)); }
  done() { return concat(...this.#p); }
}

// ---------- action constructors (plain data, serialised by writeAction) ----------
export const createAccount = () => ({ kind: 'CreateAccount' });
export const deployContract = (code) => {
  if (!(code instanceof Uint8Array) || code.length === 0) throw new Error('deployContract: code must be non-empty bytes');
  return { kind: 'DeployContract', code };
};
export const functionCall = (methodName, args, gas, deposit = 0n) => ({
  kind: 'FunctionCall', methodName,
  args: args instanceof Uint8Array ? args : new TextEncoder().encode(typeof args === 'string' ? args : JSON.stringify(args)),
  gas: BigInt(gas), deposit: BigInt(deposit),
});
export const transfer = (deposit) => ({ kind: 'Transfer', deposit: BigInt(deposit) });
/** permission: 'FullAccess' or { receiverId, methodNames = [], allowance = null } (function-call key). publicKey: "ed25519:..." string. */
export const addKey = (publicKey, permission = 'FullAccess', nonce = 0n) => ({ kind: 'AddKey', publicKey: typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey, permission, nonce: BigInt(nonce) });
export const deleteKey = (publicKey) => ({ kind: 'DeleteKey', publicKey: typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey });

const writePub = (w, pub) => { if (pub.length !== 32) throw new Error('public key must be 32 bytes'); return w.u8(0).raw(pub); };

function writeAction(w, a) {
  switch (a.kind) {
    case 'CreateAccount': return w.u8(0);
    case 'DeployContract': return w.u8(1).bytes(a.code);
    case 'FunctionCall': return w.u8(2).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit);
    case 'Transfer': return w.u8(3).u128(a.deposit);
    case 'AddKey': {
      writePub(w.u8(5), a.publicKey).u64(a.nonce);
      if (a.permission === 'FullAccess') return w.u8(1);
      const p = a.permission;
      if (!p || typeof p.receiverId !== 'string') throw new Error('AddKey: permission must be "FullAccess" or { receiverId, methodNames, allowance }');
      w.u8(0);
      if (p.allowance === null || p.allowance === undefined) w.u8(0); else w.u8(1).u128(p.allowance);
      w.string(p.receiverId);
      const names = p.methodNames ?? [];
      w.u32(names.length); for (const n of names) w.string(n);
      return w;
    }
    case 'DeleteKey': return writePub(w.u8(6), a.publicKey);
    default: throw new Error(`borsh: action "${a.kind}" is not supported by near-admin`);
  }
}

/** Borsh bytes of a NEAR Transaction (V0 layout: signer, ed25519 key, nonce, receiver, block hash, actions). */
export function serializeAdminTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  if (publicKey.length !== 32 || blockHash.length !== 32) throw new Error('publicKey and blockHash must be 32 bytes');
  const w = new W().string(signerId);
  writePub(w, publicKey).u64(nonce).string(receiverId).raw(blockHash).u32(actions.length);
  for (const a of actions) writeAction(w, a);
  return w.done();
}

export function signAdminTransaction(tx, signFn) {
  const txBytes = serializeAdminTransaction(tx);
  const hash = transactionHash(txBytes);
  const signature = signFn(hash);
  const signedBytes = serializeSignedTransaction(txBytes, signature);
  return { txBytes, hash, hashB58: base58Encode(hash), signature, signedBytes, base64: Buffer.from(signedBytes).toString('base64') };
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL_OK = new Set(['testnet', 'sandbox', 'localnet']);

/**
 * secretKey: "ed25519:<base58 of 64 bytes>" (NEAR form) or a 32-byte seed (Uint8Array).
 * Returns { accountId, publicKey (string), send, call, view, ... }. Every tx waits for `waitUntil` (default FINAL) so the next
 * query sees its effects.
 */
export function createNearAdmin({ rpcUrl, accountId, secretKey, networkId = 'localnet', fetchImpl, role = 'launch', sleep = sleepReal, timeoutMs = 90_000, pollMs = 300 } = {}) {
  if (!rpcUrl || !accountId || !secretKey) throw new Error('createNearAdmin: rpcUrl, accountId and secretKey are required');
  const seed = secretKey instanceof Uint8Array ? secretKey : parseSecretKey(secretKey);
  const pub = ed25519PublicKey(seed); const sign = ed25519Signer(seed); const pubStr = formatPublicKey(pub);
  const rpc = nearRpc(rpcUrl, { fetchImpl, role });
  let chainOk = false; let lastNonce = 0n; let queue = Promise.resolve();

  async function run(receiverId, actions, { waitUntil = 'FINAL', allowFail = false } = {}) {
    if (!chainOk) {
      const cid = await rpc.chainId();
      if (!LOCAL_OK.has(cid) || cid !== networkId) throw new Error(`near-admin: RPC chain_id "${String(cid).slice(0, 30)}" is not the configured test network "${networkId}"`);
      chainOk = true;
    }
    const ak = await rpc.accessKey(accountId, pubStr);
    const nonce = (ak.nonce > lastNonce ? ak.nonce : lastNonce) + 1n;
    const signed = signAdminTransaction({ signerId: accountId, publicKey: pub, nonce, receiverId, blockHash: ak.blockHash, actions }, sign);
    lastNonce = nonce;
    let res = null;
    try { res = await rpc.sendTx(signed.base64, waitUntil); } catch (e) { if (!/timeout|TIMEOUT|HTTP (?:408|504)\b/i.test(String(e?.message))) throw e; }
    const start = Date.now();
    let sum = res?.status ? summarizeTxResult(res) : { status: 'pending' };
    const finalOk = (s) => s.status !== 'pending' && (waitUntil !== 'FINAL' || s.finality === 'FINAL');
    while (!finalOk(sum) && Date.now() - start < timeoutMs) {
      await sleep(pollMs);
      try { res = await rpc.txStatus(signed.hashB58, accountId, waitUntil); sum = summarizeTxResult(res); } catch (e) { if (!/UNKNOWN_TRANSACTION|doesn't exist|not found|TIMEOUT|HTTP (?:408|504)\b/i.test(String(e?.message))) throw e; }
    }
    const out = { txHash: signed.hashB58, from: accountId, to: receiverId, nonce, ok: sum.status === 'success', status: sum.status, failure: sum.failure, finality: sum.finality, res, summary: sum };
    if (!out.ok && !allowFail) throw new Error(`near-admin: tx ${out.txHash} to ${receiverId} ${sum.status}: ${JSON.stringify(sum.failure ?? null).slice(0, 600)}`);
    return out;
  }

  const api = {
    accountId, publicKey: pubStr, rpc,
    /** Serialised: one in-flight tx at a time. */
    send(receiverId, actions, opts) { const p = queue.then(() => run(receiverId, actions, opts)); queue = p.catch(() => {}); return p; },
    transfer(to, yocto, opts) { return api.send(to, [transfer(yocto)], opts); },
    /** CreateAccount + Transfer + AddKey(FullAccess) in one tx (tx receiver = the new account, which must be a sub-account of the signer or an implicit id). */
    createSubAccount(newId, publicKeyStr, yocto, opts) { return api.send(newId, [createAccount(), transfer(yocto), addKey(publicKeyStr, 'FullAccess')], opts); },
    /** DeployContract (+ optional init call) to the signer's own account (or any account the signer holds a full-access key of). */
    deploy(receiverId, wasm, init, opts) { return api.send(receiverId, [deployContract(wasm), ...(init ? [functionCall(init.method, init.args, init.gas, init.deposit ?? 0n)] : [])], opts); },
    call(receiverId, method, args, { gas = 30n * 10n ** 12n, deposit = 0n, ...opts } = {}) { return api.send(receiverId, [functionCall(method, args, gas, deposit)], opts); },
    async view(contract, method, args = {}) {
      const r = await rpc.call('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      if (r?.error) throw new Error(`view ${method}: ${String(r.error).slice(0, 300)}`);
      return JSON.parse(Buffer.from(r.result).toString());
    },
    async account(id) { return rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: id }); },
    async keys(id) { return (await rpc.call('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys; },
    toJSON: () => ({ accountId, publicKey: pubStr }),
  };
  return Object.freeze(api);
}

export { implicitAccountId };
