// Test-only EIP-1193 provider backed by a local key (viem). It stands in for MetaMask in node tests and end-to-end runs; it is never imported by the app.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NEAR_EVM } from './nearEth.js';

export function testProvider(privateKey, { rpc = NEAR_EVM.rpc, fetchImpl = fetch } = {}) {
  const account = privateKeyToAccount(privateKey); let chainId = '0x1'; const log = [];
  const relay = async (method, params) => { for (let i = 0; ; i++) { const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); if (r.status === 429 && i < 6) { await new Promise((ok) => setTimeout(ok, 1200 * 2 ** i)); continue; } const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; } };
  return {
    address: account.address.toLowerCase(), log,
    async request({ method, params = [] }) {
      log.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address.toLowerCase()];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') { if (params[0].chainId !== NEAR_EVM.chainIdHex) { const e = new Error('Unrecognized chain ID'); e.code = 4902; throw e; } chainId = params[0].chainId; return null; }
      if (method === 'wallet_addEthereumChain') { chainId = params[0].chainId; return null; }
      if (method === 'eth_sign') return account.sign({ hash: params[1] }); // raw 32-byte hash, no prefix: what MetaMask does when Eth_sign requests are switched on
      if (method === 'personal_sign') return account.signMessage({ message: { raw: params[0] } });
      if (method === 'eth_sendTransaction') {
        const t = params[0]; const raw = await account.signTransaction({ type: 'legacy', chainId: Number(t.chainId), nonce: Number(BigInt(t.nonce)), to: t.to, value: BigInt(t.value), data: t.data, gas: BigInt(t.gas), gasPrice: BigInt(t.gasPrice) });
        return relay('eth_sendRawTransaction', [raw]);
      }
      throw new Error(`testProvider: ${method} is not supported`);
    },
  };
}
