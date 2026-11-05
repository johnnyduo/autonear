// EVM signer for the agent's own key: signature-driven ABI encoding, EIP-1559 (type 2) + legacy (EIP-155) transactions,
// JSON-RPC submit / receipt polling, nonce / gas / fee estimation with safety multipliers and a hard per-tx fee ceiling.
// All network access goes through chains/common.js jsonRpc -> http-client guardedFetch (host allowlist; loopback http only
// for a local anvil). Runtime is zero-dependency.
import { keccak256, bytesToHex, toBytes } from './keccak.js';
import { rlpEncode, rlpInt } from './rlp.js';
import { hexToBytes, bigIntToBytes, bytesToBigInt, isValidAddress, toChecksumAddress } from './secp256k1.js';
import { jsonRpc } from '../chains/common.js';
import { enforceCall, enforceFee, normalizeLimits, LimitError, asBigInt } from './limits.js';

const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const hex = (b) => '0x' + bytesToHex(b);
const qty = (n) => '0x' + BigInt(n).toString(16);

// ---------- ABI (static types + bytes/string; no tuples/arrays: the vault does not need them) ----------
export function parseSignature(sig) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/.exec(sig);
  if (!m) throw new Error(`abi: unsupported signature "${sig}" (tuples/arrays not supported)`);
  const types = m[2] === '' ? [] : m[2].split(',');
  for (const t of types) if (!/^(uint(8|16|32|64|128|256)?|address|bool|bytes([1-9]|[12][0-9]|3[0-2])?|string)$/.test(t)) throw new Error(`abi: unsupported type "${t}"`);
  return { name: m[1], types, canonical: `${m[1]}(${types.map((t) => (t === 'uint' ? 'uint256' : t)).join(',')})` };
}
/** 4-byte function selector from a human signature, e.g. "draw(uint256)". */
export function selector(sig) {
  const { canonical } = parseSignature(sig);
  return keccak256(canonical).slice(0, 4);
}
const pad32 = (b) => { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
const padRight32 = (b) => { const o = new Uint8Array(Math.ceil(b.length / 32) * 32); o.set(b); return o; };
function toBytesArg(v, what) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v)) return hexToBytes(v);
  throw new Error(`abi: ${what} must be bytes or 0x-hex`);
}
function encodeStatic(type, v) {
  if (type.startsWith('uint')) {
    const bits = type === 'uint' ? 256 : Number(type.slice(4));
    let n; try { n = typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v) ? BigInt(v) : typeof v === 'bigint' ? v : Number.isSafeInteger(v) ? BigInt(v) : null; } catch { n = null; }
    if (n === null || n < 0n || n >= 1n << BigInt(bits)) throw new Error(`abi: value out of range for ${type}`);
    return bigIntToBytes(n, 32);
  }
  if (type === 'address') { if (typeof v !== 'string' || !isValidAddress(v)) throw new Error('abi: invalid address'); return pad32(hexToBytes(v)); }
  if (type === 'bool') { if (typeof v !== 'boolean') throw new Error('abi: bool expected'); return pad32(Uint8Array.of(v ? 1 : 0)); }
  const n = Number(type.slice(5)); const b = toBytesArg(v, type); // bytesN, left-aligned
  if (b.length !== n) throw new Error(`abi: ${type} needs exactly ${n} bytes`);
  const o = new Uint8Array(32); o.set(b); return o;
}
/** ABI-encode arguments (without selector). */
export function encodeArgs(types, values) {
  if (types.length !== values.length) throw new Error('abi: argument count mismatch');
  const heads = []; const tails = []; let tailOffset = types.length * 32;
  types.forEach((t, i) => {
    if (t === 'bytes' || t === 'string') {
      const b = t === 'string' ? toBytes(values[i]) : toBytesArg(values[i], 'bytes');
      const tail = concat(bigIntToBytes(BigInt(b.length), 32), padRight32(b));
      heads.push(bigIntToBytes(BigInt(tailOffset), 32)); tails.push(tail); tailOffset += tail.length;
    } else heads.push(encodeStatic(t, values[i]));
  });
  return concat(...heads, ...tails);
}
/** selector(sig) || abi.encode(args). Signature-driven: works for any ABI the caller derives a signature from. */
export function encodeCall(sig, values) {
  const { types } = parseSignature(sig);
  return concat(selector(sig), encodeArgs(types, values));
}
export const VAULT_SIGNATURES = Object.freeze({ draw: 'draw(uint256)', deploy: 'deploy(bytes32,bytes32,bytes)' });
export const encodeDraw = (amount) => encodeCall(VAULT_SIGNATURES.draw, [amount]);
export const encodeDeploy = (template, salt, code) => encodeCall(VAULT_SIGNATURES.deploy, [template, salt, code]);
/** Derive a signature string from an ABI JSON fragment list, e.g. for contracts/evm/dist/AgentVault.json if present. */
export function signatureFromAbi(abi, name) {
  const f = abi.find((x) => x.type === 'function' && x.name === name);
  if (!f) throw new Error(`abi: function ${name} not found`);
  return `${name}(${f.inputs.map((i) => i.type).join(',')})`;
}

// ---------- transactions ----------
const toAddrBytes = (to) => (to === null || to === undefined ? new Uint8Array(0) : hexToBytes(to));
function accessListItems(al = []) { return al.map(({ address, storageKeys = [] }) => [hexToBytes(address), storageKeys.map((k) => hexToBytes(k))]); }

/** Serialise (and optionally sign) an EIP-1559 tx. sig = { r, s, recovery } or omitted for the unsigned payload. */
export function serializeEip1559(tx, sig) {
  const fields = [rlpInt(tx.chainId), rlpInt(tx.nonce), rlpInt(tx.maxPriorityFeePerGas), rlpInt(tx.maxFeePerGas), rlpInt(tx.gas), toAddrBytes(tx.to), rlpInt(tx.value ?? 0n), tx.data ?? new Uint8Array(0), accessListItems(tx.accessList)];
  if (sig) fields.push(rlpInt(sig.recovery & 1), rlpInt(bytesToBigInt(sig.r)), rlpInt(bytesToBigInt(sig.s)));
  return concat(Uint8Array.of(2), rlpEncode(fields));
}
export function serializeLegacy(tx, sig) { // EIP-155
  const base = [rlpInt(tx.nonce), rlpInt(tx.gasPrice), rlpInt(tx.gas), toAddrBytes(tx.to), rlpInt(tx.value ?? 0n), tx.data ?? new Uint8Array(0)];
  if (!sig) return rlpEncode([...base, rlpInt(tx.chainId), new Uint8Array(0), new Uint8Array(0)]);
  return rlpEncode([...base, rlpInt(BigInt(sig.recovery & 1) + 35n + 2n * BigInt(tx.chainId)), rlpInt(bytesToBigInt(sig.r)), rlpInt(bytesToBigInt(sig.s))]);
}
/** signDigest(digest32) -> { r, s, recovery }. Returns { raw, hash } (hex strings 0x...). */
export function signTransaction(tx, signDigest) {
  const unsigned = tx.type === 'legacy' ? serializeLegacy(tx) : serializeEip1559(tx);
  const sig = signDigest(keccak256(unsigned));
  const raw = tx.type === 'legacy' ? serializeLegacy(tx, sig) : serializeEip1559(tx, sig);
  return { raw, rawHex: hex(raw), hash: hex(keccak256(raw)), signature: sig };
}

// ---------- RPC ----------
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
/** Testnet-only allowlist of chain ids (mirrors src/policy.js allowedNetworks; no mainnet id is listed anywhere). */
export const TESTNET_CHAIN_IDS = Object.freeze(new Set([11155111, 84532, 421614, 11155420, 10143, 97, 31337]));

export function evmRpc(url, { fetchImpl, role = 'launch' } = {}) {
  const call = (method, params = []) => jsonRpc(role, url, method, params, { fetchImpl });
  return {
    call,
    chainId: async () => Number(BigInt(await call('eth_chainId'))),
    nonce: async (addr) => BigInt(await call('eth_getTransactionCount', [addr, 'pending'])),
    latestBlock: () => call('eth_getBlockByNumber', ['latest', false]),
    tip: async () => { try { return BigInt(await call('eth_maxPriorityFeePerGas')); } catch { return null; } },
    gasPrice: async () => BigInt(await call('eth_gasPrice')),
    estimateGas: async (req) => BigInt(await call('eth_estimateGas', [req])),
    sendRaw: (rawHex) => call('eth_sendRawTransaction', [rawHex]),
    receipt: (hash) => call('eth_getTransactionReceipt', [hash]),
    balance: async (addr) => BigInt(await call('eth_getBalance', [addr, 'latest'])),
  };
}

/** Fee suggestion. type 2 when the chain has a base fee (maxFee = baseFee * baseFeeMultiplier + tip); else legacy gasPrice * multiplier. */
export async function estimateFees(rpc, { baseFeeMultiplier = 2, legacyMultiplier = 1.25, minTip = 1n } = {}) {
  const block = await rpc.latestBlock();
  const mulBig = (v, m) => (v * BigInt(Math.round(m * 100)) + 99n) / 100n;
  if (block?.baseFeePerGas) {
    const base = BigInt(block.baseFeePerGas);
    let tip = (await rpc.tip()) ?? 1_000_000_000n; if (tip < minTip) tip = minTip;
    return { type: 'eip1559', maxFeePerGas: mulBig(base, baseFeeMultiplier) + tip, maxPriorityFeePerGas: tip, baseFee: base };
  }
  return { type: 'legacy', gasPrice: mulBig(await rpc.gasPrice(), legacyMultiplier) };
}

/**
 * Low-level: estimate, enforce the fee ceiling, sign and submit ONE transaction, then poll for the receipt.
 * Used by the restricted Signer below and directly by tests. NOT exposed on the Signer interface.
 * req = { to|null, data?, value? }; opts.maxFeePerTx (wei, REQUIRED) is the hard ceiling on gas * maxFeePerGas.
 */
export async function sendTransaction({ rpc, address, signDigest, chainId, req, maxFeePerTx, gasMultiplier = 1.2, baseFeeMultiplier = 2, forceLegacy = false, allowedChainIds = TESTNET_CHAIN_IDS, receiptTimeoutMs = 60_000, pollMs = 1000, sleep = sleepReal, wait = true }) {
  if (maxFeePerTx === undefined || maxFeePerTx === null) throw new LimitError('bad_limits', 'maxFeePerTx is required');
  const ceiling = asBigInt(maxFeePerTx, 'maxFeePerTx');
  if (!allowedChainIds.has(chainId)) throw new LimitError('network_not_permitted', `chain id ${chainId} is not an allowed testnet`);
  const remote = await rpc.chainId();
  if (remote !== chainId) throw new LimitError('network_not_permitted', `RPC reports chain id ${remote}, expected ${chainId}`);
  const data = req.data ?? new Uint8Array(0); const value = BigInt(req.value ?? 0);
  const nonce = await rpc.nonce(address);
  const fees = forceLegacy ? { type: 'legacy', gasPrice: (await rpc.gasPrice()) * 125n / 100n } : await estimateFees(rpc, { baseFeeMultiplier });
  const est = await rpc.estimateGas({ from: address, ...(req.to ? { to: req.to } : {}), value: qty(value), data: hex(data) });
  const gas = (est * BigInt(Math.round(gasMultiplier * 100)) + 99n) / 100n;
  const maxPrice = fees.type === 'eip1559' ? fees.maxFeePerGas : fees.gasPrice;
  const worstCaseFee = gas * maxPrice;
  enforceFee(worstCaseFee, { maxFeePerTx: ceiling });
  const tx = fees.type === 'eip1559'
    ? { type: 'eip1559', chainId, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: req.to ?? null, value, data }
    : { type: 'legacy', chainId, nonce, gasPrice: fees.gasPrice, gas, to: req.to ?? null, value, data };
  const signed = signTransaction(tx, signDigest);
  const returned = await rpc.sendRaw(signed.rawHex);
  if (String(returned).toLowerCase() !== signed.hash) throw new Error(`RPC returned tx hash ${returned}, expected ${signed.hash}`);
  const base = { chain: 'evm', chainId, txHash: signed.hash, from: address, to: req.to ?? null, nonce: nonce.toString(), txType: tx.type, gasLimit: gas.toString(), maxFeeBound: worstCaseFee.toString() };
  if (!wait) return { ...base, status: 'submitted', ok: null };
  const start = Date.now();
  for (;;) {
    const r = await rpc.receipt(signed.hash);
    if (r) {
      const gasUsed = BigInt(r.gasUsed); const eff = BigInt(r.effectiveGasPrice ?? maxPrice);
      return { ...base, status: r.status === '0x1' ? 'success' : 'reverted', ok: r.status === '0x1', blockNumber: Number(BigInt(r.blockNumber)), gasUsed: gasUsed.toString(), effectiveGasPrice: eff.toString(), feePaid: (gasUsed * eff).toString(), contractAddress: r.contractAddress ? toChecksumAddress(r.contractAddress) : null };
    }
    if (Date.now() - start > receiptTimeoutMs) return { ...base, status: 'pending', ok: null, note: 'receipt not seen before timeout; the tx may still be mined' };
    await sleep(pollMs);
  }
}

// ---------- Signer ----------
/**
 * key = { address, signDigest(digest32) -> {r,s,recovery} } (keystore handle; the private key is not reachable from it).
 * Returns the chain-agnostic Signer { chain, address, signAndSend(callSpec, limits) }.
 */
export function createEvmSigner({ key, rpcUrl, chainId, fetchImpl, role = 'launch', redact = (e) => e, signatures = VAULT_SIGNATURES, ...txOpts } = {}) {
  if (!key?.signDigest || !key.address) throw new Error('createEvmSigner: key handle required');
  if (!Number.isInteger(chainId)) throw new Error('createEvmSigner: chainId required');
  const rpc = evmRpc(rpcUrl, { fetchImpl, role });
  let queue = Promise.resolve();
  async function run(callSpec, limitsIn) {
    const limits = normalizeLimits('evm', limitsIn);
    const target = enforceCall('evm', callSpec, limits);
    const a = callSpec.args;
    const data = callSpec.method === 'draw'
      ? encodeCall(signatures.draw, [a.amount])
      : encodeCall(signatures.deploy, [a.template, a.salt, a.code]);
    // value is ALWAYS zero: vault draw/deploy are non-payable and the agent never sends funds anywhere.
    const res = await sendTransaction({ rpc, address: key.address, signDigest: key.signDigest, chainId, req: { to: toChecksumAddress(target), data, value: 0n }, maxFeePerTx: limits.maxFeePerTx, ...txOpts });
    return { ...res, method: callSpec.method };
  }
  return Object.freeze({
    chain: 'evm',
    address: key.address,
    chainId,
    signAndSend(callSpec, limits) {
      const p = queue.then(() => run(callSpec, limits));
      queue = p.catch(() => {});
      return p.catch((e) => { throw redact(e); });
    },
    toJSON() { return { chain: 'evm', address: key.address, chainId }; },
  });
}
