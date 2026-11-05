import { guardedFetch } from '../http-client.js';
import { config } from '../config.js';

async function rpc(method, params, ctx) {
  const res = await guardedFetch('collector', config.near.mainnetRpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), fetchImpl: ctx.fetchImpl,
  });
  const out = JSON.parse(res.text);
  if (out.error) throw new Error(`rpc ${method}: ${out.error.data ?? out.error.message}`);
  return out.result;
}
const ftBalance = async (token, account, ctx) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: token, method_name: 'ft_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') }, ctx);
  return { balance: JSON.parse(Buffer.from(r.result).toString()), block: r.block_height };
};
const fmt = (yocto, decimals) => {
  const s = BigInt(yocto); const d = 10n ** BigInt(decimals);
  return `${s / d}.${(s % d).toString().padStart(decimals, '0').slice(0, 2)}`;
};

export const nearRpcConnector = {
  id: 'near-rpc-mainnet',
  name: 'NEAR mainnet RPC · Intents usage',
  kind: 'usage',
  endpoint: 'https://rpc.mainnet.near.org',
  terms: 'Public NEAR JSON-RPC (docs.near.org/api/rpc). Public node, best-effort; production use needs a provider key.',
  rateLimit: 'Public endpoint is rate limited and may throttle; we issue 4 calls per run',
  docsUrl: 'https://docs.near.org/api/rpc/introduction',
  async fetch(ctx = {}) {
    const [acct, wnear, usdc, gas] = await Promise.all([
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: 'intents.near' }, ctx),
      ftBalance('wrap.near', 'intents.near', ctx),
      ftBalance('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'intents.near', ctx),
      rpc('gas_price', [null], ctx),
    ]);
    const day = new Date().toISOString().slice(0, 10);
    const body = [
      `Observed on NEAR mainnet at block ${acct.block_height}.`,
      `intents.near holds ${fmt(wnear.balance, 24)} wNEAR (wrap.near ft_balance_of).`,
      `intents.near holds ${fmt(usdc.balance, 6)} USDC (native NEAR USDC contract).`,
      `intents.near contract storage_usage: ${acct.storage_usage} bytes; native balance ${fmt(acct.amount, 24)} NEAR.`,
      `Network gas price: ${gas.gas_price} yoctoNEAR/gas.`,
    ].join(' ');
    return {
      items: [{
        externalId: `mainnet:intents.near:${day}`,
        url: 'https://nearblocks.io/address/intents.near',
        publishedAt: Date.now(),
        author: 'near-rpc',
        title: `On-chain: NEAR Intents escrow holdings, ${day}`,
        body,
        org: 'near',
        kind: 'usage',
        license: 'public chain data',
        signals: { wnear: wnear.balance, usdc: usdc.balance, storageUsage: acct.storage_usage, block: acct.block_height },
        raw: { acct, wnear, usdc, gas },
        forceTags: ['intents', 'treasury'],
      }],
    };
  },
};
