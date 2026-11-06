// NEAR signer for the agent's own key: ed25519 (node:crypto), implicit-account derivation, borsh Transaction /
// SignedTransaction (FunctionCall + Transfer only), RPC (access key, gas price, send_tx / broadcast_tx_commit, status polling).
// Testnet-oriented: refuses an RPC whose chain_id is not testnet/sandbox/localnet.
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, randomBytes } from 'node:crypto';
import { base58Encode, base58Decode } from './base58.js';
import { jsonRpc } from '../chains/common.js';
import { enforceCall, enforceFee, normalizeLimits, LimitError, asBigInt, isPayAccount, MAX_PAY_MEMO_BYTES } from './limits.js';

// ---------- ed25519 ----------
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export const bytesToHex = (b) => Buffer.from(b).toString('hex');

export function generateSeed() { return new Uint8Array(randomBytes(32)); }

/** Derive the public key from a 32-byte seed. */
export function ed25519PublicKey(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return new Uint8Array(Buffer.from(createPublicKey(k).export({ format: 'jwk' }).x, 'base64url'));
}
/** Returns a function msg -> 64-byte signature that closes over the key (the seed is not retrievable from it). */
export function ed25519Signer(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return (msg) => new Uint8Array(nodeSign(null, msg, k));
}
export function ed25519Verify(publicKey, msg, sig) {
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  const pk = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  return nodeVerify(null, msg, pk, sig);
}

// ---------- NEAR key strings ----------
const KEY_PREFIX = 'ed25519:';
export const formatPublicKey = (pub) => KEY_PREFIX + base58Encode(pub);
export function parsePublicKey(str) {
  if (typeof str !== 'string' || !str.startsWith(KEY_PREFIX)) throw new Error('public key must look like ed25519:<base58>');
  const b = base58Decode(str.slice(KEY_PREFIX.length));
  if (b.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return b;
}
/** NEAR secret key string = ed25519:base58(seed || publicKey) (64 bytes). */
export const formatSecretKey = (seed) => KEY_PREFIX + base58Encode(concat(seed, ed25519PublicKey(seed)));
/** Accepts the 64-byte NEAR form (public half verified against the seed) or a bare 32-byte seed. Returns the seed. */
export function parseSecretKey(str) {
  if (typeof str !== 'string' || !str.startsWith(KEY_PREFIX)) throw new Error('secret key must look like ed25519:<base58>');
  const b = base58Decode(str.slice(KEY_PREFIX.length));
  if (b.length !== 64 && b.length !== 32) throw new Error('ed25519 secret key must decode to 64 (or 32) bytes');
  const seed = b.slice(0, 32);
  if (b.length === 64 && bytesToHex(ed25519PublicKey(seed)) !== bytesToHex(b.slice(32))) throw new Error('ed25519 secret key: public half does not match the seed');
  return seed;
}
/** NEAR implicit account id: lowercase hex of the 32-byte ed25519 public key. */
export const implicitAccountId = (pub) => bytesToHex(pub);

// ---------- borsh ----------
class BorshWriter {
  #parts = [];
  u8(n) { this.#parts.push(Uint8Array.of(n)); return this; }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.#parts.push(b); return this; }
  u64(n) { const v = BigInt(n); if (v < 0n || v >= 1n << 64n) throw new Error('borsh: u64 out of range'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.#parts.push(b); return this; }
  u128(n) { let v = BigInt(n); if (v < 0n || v >= 1n << 128n) throw new Error('borsh: u128 out of range'); const b = new Uint8Array(16); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } this.#parts.push(b); return this; }
  raw(bytes) { this.#parts.push(Uint8Array.from(bytes)); return this; }
  bytes(bytes) { return this.u32(bytes.length).raw(bytes); }
  string(s) { return this.bytes(new TextEncoder().encode(s)); }
  done() { return concat(...this.#parts); }
}

// Action enum indices (nearcore Action): 0 CreateAccount, 1 DeployContract, 2 FunctionCall, 3 Transfer, ...
export const functionCall = (methodName, args, gas, deposit = 0n) => ({ kind: 'FunctionCall', methodName, args: args instanceof Uint8Array ? args : new TextEncoder().encode(args), gas: BigInt(gas), deposit: BigInt(deposit) });
export const transfer = (deposit) => ({ kind: 'Transfer', deposit: BigInt(deposit) });

function writeAction(w, a) {
  if (a.kind === 'FunctionCall') return w.u8(2).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit);
  if (a.kind === 'Transfer') return w.u8(3).u128(a.deposit);
  throw new Error(`borsh: action "${a.kind}" is not supported by the agent signer`);
}
/** Borsh bytes of a NEAR Transaction. publicKey and blockHash are raw 32-byte arrays. */
export function serializeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  if (publicKey.length !== 32 || blockHash.length !== 32) throw new Error('publicKey and blockHash must be 32 bytes');
  const w = new BorshWriter().string(signerId).u8(0).raw(publicKey).u64(nonce).string(receiverId).raw(blockHash).u32(actions.length);
  for (const a of actions) writeAction(w, a);
  return w.done();
}
/** NEAR signs sha256(borsh(Transaction)). */
export const transactionHash = (txBytes) => sha256(txBytes);
export const serializeSignedTransaction = (txBytes, signature) => {
  if (signature.length !== 64) throw new Error('signature must be 64 bytes');
  return concat(txBytes, Uint8Array.of(0), signature); // Signature enum: 0 = ED25519
};
export function signTransaction(tx, signFn) {
  const txBytes = serializeTransaction(tx);
  const hash = transactionHash(txBytes);
  const signature = signFn(hash);
  const signedBytes = serializeSignedTransaction(txBytes, signature);
  return { txBytes, hash, hashB58: base58Encode(hash), signature, signedBytes, base64: Buffer.from(signedBytes).toString('base64') };
}

// ---------- RPC ----------
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_OK = new Set(['EXECUTED', 'EXECUTED_OPTIMISTIC', 'FINAL']);

export function nearRpc(url, { fetchImpl, role = 'launch' } = {}) {
  const call = (method, params) => jsonRpc(role, url, method, params, { fetchImpl });
  return {
    call,
    chainId: async () => (await call('status', [])).chain_id,
    gasPrice: async () => BigInt((await call('gas_price', [null])).gas_price),
    async accessKey(accountId, publicKeyStr) {
      let r;
      try { r = await call('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKeyStr }); } // jsonRpc raises both the JSON-RPC error and fastnear's { result: { error } }
      catch (e) { throw new Error(`access key lookup failed: ${String(e?.message ?? e).slice(0, 200)}`); }
      if (r?.error) throw new Error(`access key lookup failed: ${String(r.error).slice(0, 200)}`);
      return { nonce: BigInt(r.nonce), blockHash: base58Decode(r.block_hash), permission: r.permission };
    },
    sendTx: (base64, waitUntil = 'EXECUTED_OPTIMISTIC') => call('send_tx', { signed_tx_base64: base64, wait_until: waitUntil }),
    broadcastCommit: (base64) => call('broadcast_tx_commit', [base64]),
    txStatus: (txHash, senderId, waitUntil = 'EXECUTED_OPTIMISTIC') => call('tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil }),
  };
}

/** Reduce an RPC tx result to { status: 'success' | 'failed' | 'pending', ... } (all receipts must succeed). */
export function summarizeTxResult(res) {
  const outcomes = [res?.transaction_outcome, ...(res?.receipts_outcome ?? [])].filter(Boolean);
  let failure = res?.status?.Failure ?? null;
  for (const o of outcomes) if (!failure && o.outcome?.status?.Failure) failure = o.outcome.status.Failure;
  const finality = res?.final_execution_status ?? null;
  const done = res?.status && (res.status.SuccessValue !== undefined || res.status.Failure);
  let burnt = 0n; for (const o of outcomes) burnt += BigInt(o.outcome?.tokens_burnt ?? 0);
  const gasBurnt = outcomes.reduce((n, o) => n + BigInt(o.outcome?.gas_burnt ?? 0), 0n);
  return { status: failure ? 'failed' : done && (!finality || TERMINAL_OK.has(finality)) ? 'success' : 'pending', failure, finality, tokensBurnt: burnt, gasBurnt };
}

// ---------- Signer ----------
const TGAS = 10n ** 12n;
// `pay` = vault.pay -> token.ft_transfer (30 Tgas) -> vault.on_paid (10 Tgas) with headroom: the contract documents >= 100 Tgas attached.
const DEFAULT_GAS = { draw: 50n * TGAS, deploy: 300n * TGAS, pay: 100n * TGAS };
const MAX_GAS = 300n * TGAS;
const TESTNET_CHAINS = new Set(['testnet', 'sandbox', 'localnet']);

/** Default JSON arg encoding for the vault. Matches the source of contracts/near-vault/src/lib.rs as read (draw(amount: U128),
 *  deploy(template: String, name: String, code: Base64VecU8)); NOT yet proven against a live NEAR node. Pass `encodeArgs` to
 *  createNearSigner if the ABI changes (nothing else needs to). */
export function defaultEncodeArgs(method, args) {
  if (method === 'draw') {
    const amount = asBigInt(args.amount, 'amount');
    if (amount <= 0n) throw new LimitError('bad_call', 'draw amount must be > 0');
    return { amount: amount.toString() };
  }
  if (method === 'pay') { // payouts build: pay(token: AccountId, to: AccountId, amount: U128, memo: Option<String>)
    if (!isPayAccount(args.token) || !isPayAccount(args.to)) throw new LimitError('bad_call', 'pay needs token and to as NEAR account ids');
    const amount = asBigInt(args.amount, 'amount');
    if (amount <= 0n || amount >= 1n << 128n) throw new LimitError('bad_call', 'pay amount must be > 0 and fit u128');
    const out = { token: args.token, to: args.to, amount: amount.toString() };
    if (args.memo !== undefined && args.memo !== null) {
      if (typeof args.memo !== 'string' || new TextEncoder().encode(args.memo).length > MAX_PAY_MEMO_BYTES) throw new LimitError('bad_call', `pay memo must be text of at most ${MAX_PAY_MEMO_BYTES} bytes`);
      out.memo = args.memo;
    }
    return out;
  }
  if (method !== 'deploy') throw new LimitError('bad_call', `no argument encoding for method "${String(method).slice(0, 40)}"`);
  if (!(args.code instanceof Uint8Array) || args.code.length === 0) throw new LimitError('bad_call', 'deploy code must be non-empty bytes');
  if (typeof args.name !== 'string' || !args.name || typeof args.template !== 'string' || !args.template) throw new LimitError('bad_call', 'deploy needs template and name');
  return { template: args.template.replace(/^0x/, ''), name: args.name, code: Buffer.from(args.code).toString('base64') };
}

/**
 * key = { accountId, publicKey (32 bytes), publicKeyString, sign(msg32) -> 64 bytes }   (from keystore; no secret inside)
 * Returns the chain-agnostic Signer { chain, address, signAndSend(callSpec, limits) }.
 */
export function createNearSigner({ key, rpcUrl, networkId = 'testnet', fetchImpl, role = 'launch', redact = (e) => e, encodeArgs = defaultEncodeArgs, gas = {}, gasPriceMultiplier = 1.5, sleep = sleepReal, pollMs = 1500, timeoutMs = 60_000, submit = 'send_tx', allowedNetworkIds = TESTNET_CHAINS } = {}) {
  if (!key?.sign || !key.accountId) throw new Error('createNearSigner: key handle required');
  const rpc = nearRpc(rpcUrl, { fetchImpl, role });
  const gasFor = (m) => { const g = BigInt(gas[m] ?? DEFAULT_GAS[m]); if (g <= 0n || g > MAX_GAS) throw new LimitError('bad_call', 'attached gas out of range (max 300 TGas)'); return g; };
  let chainChecked = false; let lastNonce = 0n; let queue = Promise.resolve();

  async function run(callSpec, limitsIn) {
    const limits = normalizeLimits('near', limitsIn);
    const target = enforceCall('near', callSpec, limits);
    const argsObj = encodeArgs(callSpec.method, callSpec.args);
    const argBytes = new TextEncoder().encode(JSON.stringify(argsObj));
    const gasAttached = gasFor(callSpec.method);
    if (!chainChecked) {
      const cid = await rpc.chainId();
      if (!allowedNetworkIds.has(cid) || cid !== networkId) throw new LimitError('network_not_permitted', `RPC chain_id "${String(cid).slice(0, 30)}" is not the configured testnet network`);
      chainChecked = true;
    }
    const price = await rpc.gasPrice();
    const worstCaseFee = (gasAttached * price * BigInt(Math.round(gasPriceMultiplier * 100)) + 99n) / 100n; // deposit is always 0, so fee is the only spend
    enforceFee(worstCaseFee, limits);
    const ak = await rpc.accessKey(key.accountId, key.publicKeyString);
    const nonce = (ak.nonce > lastNonce ? ak.nonce : lastNonce) + 1n;
    const signed = signTransaction({ signerId: key.accountId, publicKey: key.publicKey, nonce, receiverId: target, blockHash: ak.blockHash, actions: [functionCall(callSpec.method, argBytes, gasAttached, 0n)] }, key.sign);
    lastNonce = nonce;
    let res;
    try { res = submit === 'broadcast_tx_commit' ? await rpc.broadcastCommit(signed.base64) : await rpc.sendTx(signed.base64); } catch (e) { res = null; if (!/timeout|TIMEOUT/i.test(String(e?.message))) throw e; }
    const start = Date.now();
    let sum = res?.status ? summarizeTxResult(res) : { status: 'pending' };
    while (sum.status === 'pending' && Date.now() - start < timeoutMs) {
      await sleep(pollMs);
      try { res = await rpc.txStatus(signed.hashB58, key.accountId); sum = summarizeTxResult(res); } catch (e) { if (!/UNKNOWN_TRANSACTION|doesn't exist|not found|TIMEOUT/i.test(String(e?.message))) throw e; }
    }
    return { chain: 'near', txHash: signed.hashB58, from: key.accountId, to: target, method: callSpec.method, nonce: nonce.toString(), attachedGas: gasAttached.toString(), maxFeeBound: worstCaseFee.toString(), ok: sum.status === 'success', status: sum.status, failure: sum.failure ? JSON.stringify(sum.failure).slice(0, 400) : null, finality: sum.finality, tokensBurnt: sum.tokensBurnt?.toString?.() ?? null };
  }

  const signer = {
    chain: 'near',
    address: key.accountId,
    publicKey: key.publicKeyString,
    // Serialised: one in-flight transaction at a time so nonces never collide.
    signAndSend(callSpec, limits) {
      const p = queue.then(() => run(callSpec, limits));
      queue = p.catch(() => {});
      return p.catch((e) => { throw redact(e); });
    },
    toJSON() { return { chain: 'near', address: key.accountId, publicKey: key.publicKeyString }; },
  };
  return Object.freeze(signer);
}
