import { getJson, num, usd, utcDay } from './onchain-common.js';

const API = 'https://api.llama.fi';

// DefiLlama public API (no key). Verified live 2026-11-06:
//  /v2/chains                  58 KB, array of { name, tvl, ... }; the NEAR entry is named "Near" (chain TVL, USD)
//  /tvl/near-intents           a bare number: total value locked of the protocol across every chain DefiLlama tracks for it (not only NEAR)
//  /overview/dexs/near?...     DEX volume on NEAR: total24h, total7d, total30d (USD)
// /protocols (9.5 MB) and /protocol/<slug> (4 MB) exceed our 4 MB response cap and are not used.
export const defillamaConnector = {
  id: 'defillama-near',
  name: 'DefiLlama · NEAR Intents TVL and NEAR DEX volume',
  kind: 'usage',
  endpoint: 'https://api.llama.fi/tvl/near-intents',
  terms: 'DefiLlama public API (defillama.com/docs/api), no key. Numbers are DefiLlama\'s aggregation of public chain data; credit DefiLlama when quoting them.',
  rateLimit: 'No limit is published for the free API; we send 3 small requests per run and at most one run per hour',
  docsUrl: 'https://defillama.com/docs/api',
  minIntervalMs: 3_600_000,
  async fetch(ctx = {}) {
    const errors = [];
    const grab = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}: ${String(e.message).slice(0, 120)}`); return null; } };
    const chainTvl = await grab('chain tvl', async () => {
      const chains = await getJson('collector', `${API}/v2/chains`, ctx);
      const near = Array.isArray(chains) ? chains.find((c) => c?.name === 'Near') : null;
      const v = num(near?.tvl); if (v === null || v < 0) throw new Error('no NEAR entry with a numeric tvl');
      return v;
    });
    const intentsTvl = await grab('near-intents tvl', async () => { const v = num(await getJson('collector', `${API}/tvl/near-intents`, ctx)); if (v === null || v < 0) throw new Error('not a number'); return v; });
    const dex = await grab('dex volume', async () => {
      const d = await getJson('collector', `${API}/overview/dexs/near?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, ctx);
      const d24 = num(d?.total24h); const d7 = num(d?.total7d); if (d24 === null || d7 === null) throw new Error('no numeric total24h/total7d');
      return { d24, d7, d30: num(d.total30d) };
    });
    if (intentsTvl === null && dex === null) throw new Error(`defillama returned no usable number (${errors.join('; ') || 'empty'})`);
    const day = utcDay();
    const lines = [];
    if (intentsTvl !== null) lines.push(`DefiLlama lists NEAR Intents (slug near-intents) at ${usd(intentsTvl)} total value locked across the chains it supports.`);
    if (chainTvl !== null) lines.push(`DefiLlama lists the NEAR chain at ${usd(chainTvl)} total value locked.`);
    if (dex) lines.push(`DEX volume on NEAR: ${usd(dex.d24)} in the last 24 hours and ${usd(dex.d7)} in the last 7 days.`);
    lines.push('Source: DefiLlama API (api.llama.fi).');
    const head = intentsTvl !== null ? `NEAR Intents TVL ${usd(intentsTvl)}` : `NEAR DEX volume ${usd(dex.d24)} (24h)`;
    return {
      items: [{
        externalId: `defillama:near:${day}`,
        url: 'https://defillama.com/protocol/near-intents',
        publishedAt: Date.now(),
        author: 'defillama',
        title: `On-chain: ${head} (DefiLlama), ${day}`,
        body: lines.join(' '),
        org: 'near',
        kind: 'usage',
        license: 'public chain data aggregated by DefiLlama',
        signals: { intentsTvlUsd: intentsTvl, nearChainTvlUsd: chainTvl, nearDexVolume24hUsd: dex?.d24 ?? null, nearDexVolume7dUsd: dex?.d7 ?? null, nearDexVolume30dUsd: dex?.d30 ?? null },
        raw: { chainTvl, intentsTvl, dex, errors },
        forceTags: ['intents'],
        forceReason: 'DefiLlama on-chain TVL and DEX volume for NEAR Intents',
      }],
      meta: { partial: errors.length > 0, errors },
    };
  },
};
