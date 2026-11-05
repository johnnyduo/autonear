// Treasury rebalancing rehearsal: quote comparison + policy evaluation. NOTHING here moves funds.
import { guardedFetch } from '../http-client.js';

export const TREASURY_POLICY = {
  name: 'demo-treasury-policy-v1',
  maxSlippageBps: 100,
  maxTradeUsd: 5000,
  maxFeeBps: 50,
  maxQuoteAgeSec: 120,
  allowedAssets: ['wNEAR', 'USDC'],
  requireHumanApproval: true,
  network: 'testnet-only (rehearsal)',
};
const TRADE = { from: 'wNEAR', to: 'USDC', amountNear: 1000 };

async function referencePrices(fetchImpl) {
  const res = await guardedFetch('launch', 'https://1click.chaindefuser.com/v0/tokens', { fetchImpl });
  const toks = JSON.parse(res.text);
  const p = (sym) => toks.find((t) => t.blockchain === 'near' && t.symbol === sym)?.price;
  return { wNEAR: p('wNEAR'), USDC: p('USDC'), at: toks.find((t) => t.symbol === 'wNEAR')?.priceUpdatedAt };
}

async function liveQuote(fetchImpl) {
  const body = {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: TREASURY_POLICY.maxSlippageBps,
    originAsset: 'nep141:wrap.near',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    amount: (BigInt(TRADE.amountNear) * 10n ** 24n).toString(),
    refundTo: 'treasury.example.near',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'treasury.example.near',
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 3600e3).toISOString(),
  };
  const res = await guardedFetch('launch', 'https://1click.chaindefuser.com/v0/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    fetchImpl,
  });
  return JSON.parse(res.text);
}

export function evaluateQuote(q, policy = TREASURY_POLICY) {
  const checks = [
    { name: 'slippage ≤ policy', ok: q.slippageBps <= policy.maxSlippageBps, value: `${q.slippageBps} bps vs ${policy.maxSlippageBps}` },
    { name: 'fee ≤ policy', ok: q.feeBps <= policy.maxFeeBps, value: `${q.feeBps} bps vs ${policy.maxFeeBps}` },
    { name: 'trade size ≤ policy', ok: q.notionalUsd <= policy.maxTradeUsd, value: `$${q.notionalUsd.toFixed(0)} vs $${policy.maxTradeUsd}` },
    { name: 'assets allowlisted', ok: [q.from, q.to].every((a) => policy.allowedAssets.includes(a)), value: `${q.from}→${q.to}` },
    { name: 'human approval required', ok: policy.requireHumanApproval, value: 'always' },
  ];
  return { ...q, checks, pass: checks.every((c) => c.ok) };
}

export async function compareQuotes({ fetchImpl } = {}) {
  const out = { policy: TREASURY_POLICY, trade: TRADE, attempts: [], mode: 'synthetic-fixture', quotes: [], referencePrices: null };
  try {
    out.referencePrices = await referencePrices(fetchImpl);
  } catch (e) {
    out.attempts.push({ what: 'reference prices (1Click /v0/tokens)', ok: false, error: e.message });
  }
  try {
    const lq = await liveQuote(fetchImpl);
    out.attempts.push({ what: '1Click /v0/quote dry-run', ok: true });
    out.mode = 'live';
    out.liveQuote = lq;
  } catch (e) {
    out.attempts.push({ what: '1Click /v0/quote dry-run', ok: false, error: e.message });
  }
  if (out.mode === 'live' && out.liveQuote?.quote) {
    const q = out.liveQuote.quote;
    out.quotes.push(evaluateQuote({
      route: 'NEAR Intents 1Click (live dry-run)', from: 'wNEAR', to: 'USDC', amountIn: TRADE.amountNear,
      amountOut: Number(q.amountOutFormatted ?? 0), slippageBps: TREASURY_POLICY.maxSlippageBps, feeBps: 0,
      notionalUsd: Number(q.amountOutUsd ?? 0), kind: 'live',
    }));
  } else {
    const mid = (out.referencePrices?.wNEAR ?? 4) / (out.referencePrices?.USDC ?? 1);
    const notional = TRADE.amountNear * mid;
    // SYNTHETIC: route spreads are invented for the rehearsal. Only the mid price comes from the live token catalogue (when reachable).
    const routes = [
      { route: 'Route A (synthetic)', sp: 18, fee: 10 },
      { route: 'Route B (synthetic)', sp: 42, fee: 5 },
      { route: 'Route C (synthetic, would fail policy)', sp: 160, fee: 8 },
    ];
    for (const r of routes) {
      out.quotes.push(evaluateQuote({
        route: r.route, from: 'wNEAR', to: 'USDC', amountIn: TRADE.amountNear,
        amountOut: Number((TRADE.amountNear * mid * (1 - (r.sp + r.fee) / 1e4)).toFixed(2)),
        slippageBps: r.sp, feeBps: r.fee, notionalUsd: notional, kind: 'synthetic-fixture',
      }));
    }
    out.note = 'No live executable quote was available. Route quotes are SYNTHETIC FIXTURES for the policy rehearsal; only the reference mid-price is live (when reachable). Not a market quote.';
  }
  out.best = out.quotes.filter((q) => q.pass).sort((a, b) => b.amountOut - a.amountOut)[0] ?? null;
  return out;
}
