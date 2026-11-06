import { fetchJson, Budget, csv, maxItemsPerTick, maxAgeMs, sanitize, titleFrom, lowSignalFlags, flagRepeats, windowAndSort, sleep } from './social-common.js';

// Farcaster via a public hub HTTP API (Snapchain/Hubble: /v1/castsByParent?url=<channel url>, /v1/castsByFid?fid=). Hubs have NO keyword search.
// What was verified live on 2026-11-05 (do not read more into it):
//  * The official docs (snapchain.farcaster.xyz) describe the HTTP API of a node you RUN (127.0.0.1:3381) and recommend a managed service (Neynar) otherwise.
//    They list NO free public hub. hub.pinata.cloud no longer resolves (DNS), hoyt/nemes.farcaster.xyz:2281 are unreachable, hub-api.neynar.com and
//    snapchain-api.neynar.com answer HTTP 402 (x402 payment / API key required), api.neynar.com v1 is EOL.
//  * https://haatz.quilibrium.com (a community-run hub, operator and terms unknown, no SLA) answered /v1/info, /v1/castsByFid and /v1/castsByParent
//    anonymously with HTTP 200, no rate-limit headers. That is the only free access path that worked, and it is a third party we do not control.
//  * Channel https://warpcast.com/~/channel/near held 165 casts in total, newest 2026-02-24, i.e. NONE in the last 180 days. So with the default
//    channel this connector currently returns 0 items. That is reported as 0, not padded.
//  * The fnames `near` (FID 235167, display "NEAR Builders") and `nearprotocol` (FID 346344) resolve but have 0 casts, so they are NOT in the default
//    watchlist. There is no verified, active official NEAR account list here: FARCASTER_FIDS is empty by default and every FID you add is YOUR curated prior.
const FC_EPOCH_S = 1609459200; // Farcaster timestamps are seconds since 2021-01-01T00:00:00Z
const DEFAULT_HUB = 'https://haatz.quilibrium.com';
const DEFAULT_CHANNELS = 'near';
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const channelsOf = (env = process.env) => csv('FARCASTER_CHANNELS', DEFAULT_CHANNELS, env).map((c) => c.toLowerCase().replace(/^\/+/, '')).filter((c) => CHANNEL_RE.test(c));
const fidsOf = (env = process.env) => csv('FARCASTER_FIDS', '', env).filter((f) => /^[1-9][0-9]{0,9}$/.test(f)).slice(0, 10);

/** Normalizes one hub Message (MESSAGE_TYPE_CAST_ADD) (exported for tests). */
export function normalizeCast(m, via) {
  const d = m?.data;
  if (!d || d.type !== 'MESSAGE_TYPE_CAST_ADD' || !d.castAddBody || !m.hash || !Number.isSafeInteger(d.fid) || !Number.isFinite(d.timestamp)) return null;
  const text = sanitize(d.castAddBody.text ?? '');
  if (!text) return null;
  const publishedAt = (d.timestamp + FC_EPOCH_S) * 1000;
  const body = d.castAddBody;
  return {
    externalId: String(m.hash),
    url: `https://farcaster.xyz/~/conversations/${m.hash}`,
    publishedAt,
    author: `fid:${d.fid}`,
    title: titleFrom(text),
    body: text,
    org: null,
    kind: 'demand',
    license: 'user-authored Farcaster cast, public protocol data (excerpt + link only)',
    flags: lowSignalFlags({ text, createdAtMs: publishedAt }),
    signals: { fid: d.fid, via, isReply: Boolean(body.parentCastId), channelUrl: body.parentUrl ?? null, embeds: (body.embeds ?? []).length, mentions: (body.mentions ?? []).length },
    raw: { hash: m.hash, data: { fid: d.fid, timestamp: d.timestamp, castAddBody: { text: body.text, parentUrl: body.parentUrl ?? null, parentCastId: body.parentCastId ?? null, embeds: body.embeds ?? [], mentions: body.mentions ?? [] } } },
  };
}

export const farcasterConnector = {
  id: 'farcaster',
  name: 'Farcaster · public hub (channels + FID watchlist)',
  kind: 'demand',
  endpoint: `${DEFAULT_HUB}/v1/castsByParent`,
  terms: 'Public Farcaster protocol data read from a COMMUNITY hub (haatz.quilibrium.com): operator, terms and uptime are unknown and not guaranteed; the official docs list no free public hub. Casts are user-authored; stored as excerpts with a link. Keyword search does not exist on hubs: discovery is limited to the configured channels (FARCASTER_CHANNELS, default "near") and the curated FID watchlist (FARCASTER_FIDS, default EMPTY).',
  rateLimit: 'Not published for the community hub (no rate-limit headers seen 2026-11-05). We issue 1 request per channel + 1 per watchlist FID per run (<= 12 total, sequential, 300 ms apart).',
  docsUrl: 'https://snapchain.farcaster.xyz/reference/httpapi/casts',
  maxItems: () => maxItemsPerTick('FARCASTER_MAX_ITEMS'),
  subSources: (env = process.env) => [...channelsOf(env).map((c) => `channel: ${c}`), ...fidsOf(env).map((f) => `fid: ${f}`)],
  async fetch(ctx = {}) {
    const hub = (process.env.FARCASTER_HUB_URL || DEFAULT_HUB).replace(/\/+$/, ''); // must still be on the outbound allowlist, else it fails closed
    const channels = channelsOf();
    const fids = fidsOf();
    const budget = new Budget();
    const items = []; const errors = []; let ok = 0; let requests = 0; let partial = false;
    const jobs = [
      ...channels.map((c) => ({ via: `channel:${c}`, url: `${hub}/v1/castsByParent?url=${encodeURIComponent(`https://warpcast.com/~/channel/${c}`)}&pageSize=40&reverse=true` })),
      ...fids.map((f) => ({ via: `fid:${f}`, url: `${hub}/v1/castsByFid?fid=${f}&pageSize=20&reverse=true` })),
    ];
    for (const job of jobs) {
      if (budget.exhausted) { partial = true; break; }
      if (requests) await sleep(ctx.fetchImpl ? 0 : 300);
      try {
        requests++;
        const { json } = await fetchJson(job.url, ctx);
        if (!json || !Array.isArray(json.messages)) { errors.push(`${job.via}: unexpected response shape`); continue; }
        ok++;
        items.push(...json.messages.map((m) => normalizeCast(m, job.via)).filter(Boolean));
      } catch (e) { errors.push(`${job.via}: ${String(e.message).slice(0, 100)}`); if (e.status === 429) { partial = true; break; } }
    }
    if (jobs.length && !ok && errors.length) throw new Error(`every request failed: ${errors[0]}`);
    const seen = new Set(); const uniq = items.filter((a) => (seen.has(a.externalId) ? false : seen.add(a.externalId)));
    const w = windowAndSort(flagRepeats(uniq), maxAgeMs());
    const newest = uniq.reduce((a, i) => Math.max(a, i.publishedAt), 0);
    return { items: w.items, meta: { partial, requests, errors: errors.slice(0, 5), errorCount: errors.length, outOfWindow: w.dropped, newestSeen: newest ? new Date(newest).toISOString() : null, channels, watchlistFids: fids, hub: new URL(hub).hostname } };
  },
};
