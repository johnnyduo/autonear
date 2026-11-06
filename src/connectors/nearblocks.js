import { getJson, num, int, pause, utcDay } from './onchain-common.js';

const API = 'https://api.nearblocks.io/v1';
const SIGNER = 'v1.signer'; const INTENTS = 'intents.near';
const PATH = { charts: '/charts', count: (account) => `/account/${account}/txns/count`, latest: (account) => `/account/${account}/txns?per_page=1` };

// NearBlocks public API (api.nearblocks.io/v1), no key. Verified live 2026-11-06:
//  /charts                               1.5 MB: one row per UTC day since 2020 with txns, new_accounts, active_accounts, new_contracts, active_contracts (strings)
//  /account/<id>/txns/count              { txns: [{ count }] }: transactions NearBlocks lists for that account (all time)
//  /account/<id>/txns?per_page=1         newest transaction of that account, receipt_block.block_timestamp in nanoseconds
// The free tier is documented as 6 calls per minute and about 10,000 calls per month, with attribution. We send 4 calls per run and at most one run every 6 hours (<= 16 calls/day).
export const nearblocksConnector = {
  id: 'nearblocks',
  name: 'NearBlocks · NEAR mainnet activity',
  kind: 'usage',
  endpoint: 'https://api.nearblocks.io/v1',
  terms: 'NearBlocks API free tier (nearblocks.io/apis): public chain data, attribution to NearBlocks required, community service without warranty.',
  rateLimit: 'Free tier: 6 calls/min, ~10,000 calls/month; we send 4 calls per run and at most one run every 6 hours; stop early on HTTP 429',
  docsUrl: 'https://docs.near.org/tools/ecosystem-apis/nearblocks-api',
  minIntervalMs: 6 * 3_600_000,
  subSources: () => [`chart: daily network totals (${PATH.charts})`, `account: ${SIGNER} transaction count (${PATH.count(SIGNER)})`, `account: ${SIGNER} newest transaction (${PATH.latest(SIGNER)})`, `account: ${INTENTS} transaction count (${PATH.count(INTENTS)})`],
  async fetch(ctx = {}) {
    const items = []; const errors = [];
    const grab = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}: ${String(e.message).slice(0, 120)}`); return null; } };
    const credit = 'Source: NearBlocks API (nearblocks.io).';
    const today = utcDay();

    const charts = await grab('charts', async () => {
      const d = await getJson('collector', `${API}${PATH.charts}`, ctx); const rows = d?.charts;
      if (!Array.isArray(rows)) throw new Error('no charts array');
      const done = rows.filter((r) => typeof r?.date === 'string' && r.date.slice(0, 10) < today); // today's row is partial
      const last = done.at(-1); if (!last) throw new Error('no completed day');
      const v = { date: last.date.slice(0, 10), txns: num(last.txns), newAccounts: num(last.new_accounts), activeAccounts: num(last.active_accounts), newContracts: num(last.new_contracts), activeContracts: num(last.active_contracts) };
      if (Object.values(v).some((x) => x === null)) throw new Error('non-numeric chart fields');
      const win = done.slice(-30); const sum = (k) => win.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
      return { ...v, days: win.length, newAccounts30: sum('new_accounts'), newContracts30: sum('new_contracts') };
    });
    if (charts) {
      items.push({
        externalId: `nearblocks:accounts:${charts.date}`, url: 'https://nearblocks.io/charts/daily-new-accounts', publishedAt: Date.parse(`${charts.date}T23:59:59Z`), author: 'nearblocks',
        title: `On-chain: NEAR mainnet had ${int(charts.newAccounts)} new and ${int(charts.activeAccounts)} active accounts on ${charts.date}`,
        body: `NearBlocks daily chart for ${charts.date} (UTC): ${int(charts.newAccounts)} new accounts, ${int(charts.activeAccounts)} active accounts, ${int(charts.txns)} transactions. `
          + `Over the last ${charts.days} days: ${int(charts.newAccounts30)} new accounts (${int(charts.newAccounts30 / charts.days)} per day). ${credit}`,
        kind: 'usage', license: 'public chain data via NearBlocks', signals: { date: charts.date, newAccounts: charts.newAccounts, activeAccounts: charts.activeAccounts, txns: charts.txns, newAccounts30d: charts.newAccounts30 }, raw: charts,
      });
      items.push({
        externalId: `nearblocks:contracts:${charts.date}`, url: 'https://nearblocks.io/charts/daily-new-contracts', publishedAt: Date.parse(`${charts.date}T23:59:59Z`), author: 'nearblocks',
        title: `On-chain: ${int(charts.newContracts)} new contracts and ${int(charts.activeContracts)} active contracts on NEAR mainnet on ${charts.date}`,
        body: `NearBlocks daily chart for ${charts.date} (UTC): ${int(charts.newContracts)} contracts deployed for the first time, ${int(charts.activeContracts)} contracts called. `
          + `Over the last ${charts.days} days: ${int(charts.newContracts30)} new contracts. ${credit}`,
        kind: 'usage', license: 'public chain data via NearBlocks', signals: { date: charts.date, newContracts: charts.newContracts, activeContracts: charts.activeContracts, newContracts30d: charts.newContracts30 }, raw: charts,
      });
    }

    const count = async (account) => {
      const d = await getJson('collector', `${API}${PATH.count(account)}`, ctx); const c = num(d?.txns?.[0]?.count);
      if (c === null || c < 0) throw new Error(`no numeric count for ${account}`); return c;
    };
    await pause(ctx, 1200);
    const signerCount = await grab(`${SIGNER} count`, () => count(SIGNER));
    await pause(ctx, 1200);
    const signerLast = signerCount === null ? null : await grab(`${SIGNER} latest`, async () => {
      const d = await getJson('collector', `${API}${PATH.latest(SIGNER)}`, ctx); const ns = num(d?.txns?.[0]?.receipt_block?.block_timestamp);
      if (ns === null || ns <= 0) throw new Error('no block_timestamp'); return Math.floor(ns / 1e6);
    });
    if (signerCount !== null) {
      const day = utcDay();
      items.push({
        externalId: `nearblocks:${SIGNER}:${day}`, url: `https://nearblocks.io/address/${SIGNER}`, publishedAt: signerLast ?? Date.now(), author: 'nearblocks',
        title: `On-chain: chain signatures contract ${SIGNER} lists ${int(signerCount)} transactions`,
        body: `NearBlocks lists ${int(signerCount)} transactions for ${SIGNER}, the NEAR chain signatures (MPC) contract, as of ${day}.${signerLast ? ` The newest one is at ${new Date(signerLast).toISOString()}.` : ''} ${credit}`,
        kind: 'usage', license: 'public chain data via NearBlocks', signals: { account: SIGNER, txnCount: signerCount, latestAt: signerLast }, raw: { signerCount, signerLast },
        forceTags: ['signing'], forceReason: 'NearBlocks on-chain usage of the chain signatures contract',
      });
    }
    await pause(ctx, 1200);
    const intentsCount = await grab(`${INTENTS} count`, () => count(INTENTS));
    if (intentsCount !== null) {
      items.push({
        externalId: `nearblocks:${INTENTS}:${utcDay()}`, url: `https://nearblocks.io/address/${INTENTS}`, publishedAt: Date.now(), author: 'nearblocks',
        title: `On-chain: NEAR Intents contract ${INTENTS} lists ${int(intentsCount)} transactions`,
        body: `NearBlocks lists ${int(intentsCount)} transactions for ${INTENTS}, the NEAR Intents contract, as of ${utcDay()}. ${credit}`,
        kind: 'usage', license: 'public chain data via NearBlocks', signals: { account: INTENTS, txnCount: intentsCount }, raw: { intentsCount },
        forceTags: ['intents'], forceReason: 'NearBlocks on-chain usage of the NEAR Intents contract',
      });
    }
    if (!items.length) throw new Error(`nearblocks returned no usable number (${errors.join('; ') || 'empty'})`);
    return { items, meta: { partial: errors.length > 0, errors } };
  },
};
