// NEAR transactions signed by an Ethereum wallet (NEP-518, "Ethereum wallets for NEAR").
// A 0x address is a NEAR account whose code is the wallet contract. The owner signs an ordinary Ethereum transaction in MetaMask;
// the relayer at eth-rpc.testnet.near.org submits it to the account's rlp_execute method, which turns it back into one NEAR action.
// Encoding, checked against near/near-wallet-contract (wallet-contract/src/{types,internal}.rs):
//   chain id 398 (testnet), legacy transaction, nonce = the wallet contract's get_nonce (served by eth_getTransactionCount),
//   to = last 20 bytes of keccak256(receiver account id), value = whole multiples of 1_000_000 yoctoNEAR (1 wei = 1e6 yocto),
//   data = selector + ABI args: functionCall(string receiver, string method, bytes args, uint64 gas, uint32 yocto) 0x6179b707
//                               transfer(string receiver, uint32 yocto)                                           0x3ed64124
//   1 EVM gas = 1e8 NEAR gas, so gas_limit = NEAR gas / 1e8. One action per transaction (no batching).
// No key is held here: signing happens in the wallet through an EIP-1193 provider.
import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, toHex } from 'viem';

export const NEAR_EVM = Object.freeze({
  chainId: 398, chainIdHex: '0x18e', name: 'NEAR testnet (EVM wallet)', rpc: 'https://eth-rpc.testnet.near.org',
  explorer: 'https://eth-explorer-testnet.near.org', nearRpc: 'https://rpc.testnet.fastnear.com', nearExplorer: 'https://testnet.nearblocks.io',
  symbol: 'NEAR', decimals: 18,
});
export const SELECTORS = Object.freeze({ functionCall: '0x6179b707', transfer: '0x3ed64124', addKey: '0x753ce5ab' });
const YOCTO_PER_WEI = 1_000_000n;
const EVM_GAS_PER_NEAR_GAS = 100_000_000n; // 1 EVM gas = 0.1 Ggas
const CALL_OVERHEAD_GAS = 20_000_000_000_000n; // 20 Tgas left for rlp_execute and its callback
const DEFAULT_GAS = 30_000_000_000_000n;
const MAX_ACTION_GAS = 250_000_000_000_000n;

/** The Ethereum address the wallet contract expects in `to` for a NEAR receiver. */
export const accountToAddress = (accountId) => `0x${keccak256(toBytes(String(accountId))).slice(-40)}`;
export const isEthImplicit = (a) => /^0x[0-9a-f]{40}$/.test(String(a ?? ''));

const big = (v, what) => { try { const n = BigInt(v ?? 0); if (n < 0n) throw new Error('negative'); return n; } catch { throw new Error(`${what} must be a non-negative whole number`); } };
const split = (deposit) => { const d = big(deposit, 'deposit'); return { value: d / YOCTO_PER_WEI, yocto: Number(d % YOCTO_PER_WEI) }; };
const argBytes = (args) => (args === undefined || args === null ? toBytes('{}') : typeof args === 'string' ? toBytes(args) : args instanceof Uint8Array ? args : toBytes(JSON.stringify(args)));

/** Calldata + value for one NEAR action. method === null/'' means a plain transfer. */
export function encodeAction({ receiver, method, args, deposit = 0n, gas = DEFAULT_GAS }) {
  if (!receiver || typeof receiver !== 'string') throw new Error('receiver is required');
  const { value, yocto } = split(deposit);
  if (!method) {
    const data = SELECTORS.transfer + encodeAbiParameters(parseAbiParameters('string, uint32'), [receiver, yocto]).slice(2);
    return { to: accountToAddress(receiver), value, data, nearGas: 2_000_000_000_000n };
  }
  const g = big(gas, 'gas'); if (g === 0n || g > MAX_ACTION_GAS) throw new Error('gas is out of range');
  const data = SELECTORS.functionCall + encodeAbiParameters(parseAbiParameters('string, string, bytes, uint64, uint32'), [receiver, String(method), toHex(argBytes(args)), g, yocto]).slice(2);
  return { to: accountToAddress(receiver), value, data, nearGas: g };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const b58encode = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b === 0) out = `1${out}`; else break; } return out; };

/** One-time setup: give the relayer a function-call key on the account that may only call rlp_execute on the account itself (unlimited fee allowance). */
export function encodeOnboarding({ account, relayerKeyHex }) {
  const key = toBytes(`0x${String(relayerKeyHex).replace(/^0x/, '')}`); if (key.length !== 32) throw new Error('The relayer key is not 32 bytes.');
  const data = SELECTORS.addKey + encodeAbiParameters(parseAbiParameters('uint8, bytes, uint64, bool, bool, uint128, string, string[]'), [0, toHex(key), 0n, false, false, 0n, account, ['rlp_execute']]).slice(2);
  return { to: account, value: 0n, data, nearGas: 2_000_000_000_000n };
}

/** The eth_sendTransaction params for one action. Legacy type: the relayer serves eth_gasPrice but not the EIP-1559 fee methods. */
export function buildTx({ account, nonce, gasPrice, onboard, ...action }) {
  const a = onboard ? encodeOnboarding({ account, relayerKeyHex: onboard }) : encodeAction(action);
  const gas = (a.nearGas + CALL_OVERHEAD_GAS) / EVM_GAS_PER_NEAR_GAS;
  return { from: account, to: a.to, value: toHex(a.value), data: a.data, gas: toHex(gas), gasPrice: toHex(big(gasPrice, 'gasPrice')), nonce: toHex(big(nonce, 'nonce')), chainId: NEAR_EVM.chainIdHex };
}

async function rpc(url, method, params, fetchImpl = fetch) {
  for (let i = 0; ; i++) {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429 && i < 5) { await new Promise((ok) => setTimeout(ok, 1200 * 2 ** i)); continue; }
    if (!r.ok) throw new Error(`The NEAR network answered ${r.status}. Try again in a moment.`);
    const j = await r.json(); if (j.error) throw new Error(j.error.message ?? 'The NEAR network refused the request.'); return j.result;
  }
}
export const relayer = (method, params, fetchImpl) => rpc(NEAR_EVM.rpc, method, params, fetchImpl);
export const nearRpc = (method, params, fetchImpl) => rpc(NEAR_EVM.nearRpc, method, params, fetchImpl);

/** Ask the wallet to use the NEAR EVM network (adds it first if it is unknown). */
export async function ensureNearChain(provider) {
  const cur = await provider.request({ method: 'eth_chainId' });
  if (String(cur).toLowerCase() === NEAR_EVM.chainIdHex) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NEAR_EVM.chainIdHex }] }); }
  catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e?.message))) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: NEAR_EVM.chainIdHex, chainName: NEAR_EVM.name, rpcUrls: [NEAR_EVM.rpc], nativeCurrency: { name: 'NEAR', symbol: NEAR_EVM.symbol, decimals: NEAR_EVM.decimals }, blockExplorerUrls: [NEAR_EVM.explorer] }] });
  }
}

/** Liquid balance of a 0x account in yoctoNEAR (the relayer reports 18 decimals, so wei * 1e6). */
export async function balanceYocto(account, fetchImpl) { return BigInt(await relayer('eth_getBalance', [account, 'latest'], fetchImpl)) * YOCTO_PER_WEI; }

/** Read-only call on a NEAR contract (JSON in, JSON out). */
export async function viewNear({ contract, method, args = {}, fetchImpl }) {
  const r = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) }, fetchImpl);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

/**
 * Sign and send one NEAR action from the connected 0x account. Returns { hash } once the relayer accepted it; use waitForReceipt for the outcome.
 * `provider` is an EIP-1193 provider (MetaMask or any injected wallet).
 */
export async function callNear({ provider, account, receiver, method, args, deposit = 0n, gas = DEFAULT_GAS, fetchImpl }) {
  if (!isEthImplicit(account)) throw new Error('This account is not an Ethereum-style NEAR account.');
  const [from] = await provider.request({ method: 'eth_requestAccounts' });
  if (String(from).toLowerCase() !== account.toLowerCase()) throw new Error(`Switch your wallet to ${account.slice(0, 6)}…${account.slice(-4)} and try again.`);
  await ensureNearChain(provider);
  const ob = await onboardingStatus(account, fetchImpl);
  if (!ob.onboarded) {
    const nonce0 = await relayer('eth_getTransactionCount', [account, 'latest'], fetchImpl); const gp0 = await relayer('eth_gasPrice', [], fetchImpl);
    const h = await provider.request({ method: 'eth_sendTransaction', params: [buildTx({ account, nonce: nonce0, gasPrice: gp0, onboard: ob.relayerKeyHex })] });
    for (let i = 0; i < 40; i++) { if ((await onboardingStatus(account, fetchImpl)).onboarded) break; if (i === 39) throw new Error('The one-time setup was sent but is not visible yet. Try again in a minute.'); await new Promise((ok) => setTimeout(ok, 2500)); }
    void h;
  }
  const [nonce, gasPrice, balance] = await Promise.all([relayer('eth_getTransactionCount', [account, 'latest'], fetchImpl), relayer('eth_gasPrice', [], fetchImpl), balanceYocto(account, fetchImpl)]);
  const tx = buildTx({ account, nonce, gasPrice, receiver, method, args, deposit, gas });
  const need = BigInt(tx.value) * YOCTO_PER_WEI + BigInt(tx.gas) * BigInt(tx.gasPrice) * YOCTO_PER_WEI;
  if (balance < need) throw new Error('This account does not hold enough NEAR for the amount and the network fee.');
  // The relayer can lag a few seconds behind the chain when it learns about a freshly added key: retry only that one message.
  for (let i = 0; ; i++) {
    try { const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] }); return { hash, tx }; }
    catch (e) { if (i < 8 && /not onboarded|key was revoked/i.test(String(e?.message))) { await new Promise((ok) => setTimeout(ok, 3000)); continue; } throw e; }
  }
}

/** Poll the relayer until the transaction has a receipt. status true = the NEAR action succeeded. */
export async function waitForReceipt(hash, { fetchImpl, timeoutMs = 90_000, pollMs = 2500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await relayer('eth_getTransactionReceipt', [hash], fetchImpl).catch(() => null);
    if (r) return { ok: r.status === '0x1' || r.status === 1, receipt: r };
    await new Promise((ok) => setTimeout(ok, pollMs));
  }
  throw new Error('The network has not confirmed this yet. Check again in a minute.');
}

/** The relayer's public key (hex, 32 bytes) and whether it is already a key on `account`. */
export async function onboardingStatus(account, fetchImpl) {
  const r = await relayer('near_getPublicKey', [], fetchImpl); const hex = String(r.public_key).replace(/^0x/, '');
  const pub = `ed25519:${b58encode(toBytes(`0x${hex}`))}`;
  try { await nearRpc('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: pub }, fetchImpl); return { onboarded: true, relayerKeyHex: hex, pub }; }
  catch (e) { if (/does not exist|doesn't exist|never been observed|UnknownAccessKey|Unknown/i.test(String(e?.message))) return { onboarded: false, relayerKeyHex: hex, pub }; throw e; }
}

export const explorerTx = (hash) => `${NEAR_EVM.explorer}/tx/${hash}`;
