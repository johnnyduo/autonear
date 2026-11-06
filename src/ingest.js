import { sha256, now, j, parse, putBlob, audit } from './db.js';
import { assessRelevance, RELEVANCE_THRESHOLD } from './relevance.js';
import { CONNECTORS } from './connectors/index.js';
import { applyWatch, getWatch } from './watch.js';

const MAX_FAILS_BEFORE_OPEN = 3;
const circuitMs = (fails) => Math.min(60 * 60_000, 2 ** Math.max(0, fails - MAX_FAILS_BEFORE_OPEN) * 5 * 60_000);

export async function registerSources(db, connectors = CONNECTORS) {
  for (const c of connectors) {
    await db.run(
      `INSERT INTO sources(id,name,kind,endpoint,terms,rate_limit,docs_url) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,endpoint=excluded.endpoint,terms=excluded.terms,rate_limit=excluded.rate_limit,docs_url=excluded.docs_url`,
      [c.id, c.name, c.kind, c.endpoint, c.terms, c.rateLimit, c.docsUrl]);
    const avail = c.availability?.(); // opt-in sources show `not_configured` in /api/status from the first request, before any tick
    if (avail && avail.status !== 'ready') await db.run('UPDATE sources SET status=? WHERE id=? AND status IN (?,?)', [avail.status, c.id, 'unknown', 'ok']);
  }
}

/** True when a scheduled run would reach the network for this connector: not switched off by the owner and, for opt-in sources, configured. */
export const sourceEnabled = (connector, watch) => watch.sources[connector.id] !== false && (connector.availability?.().status ?? 'ready') === 'ready';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Ingest one connector. Idempotent: same provider+external_id never duplicates; changed content creates a revision. */
export async function ingestSource(db, connector, { trigger = 'manual', fetchImpl } = {}) {
  const t0 = now();
  const src = await db.get('SELECT * FROM sources WHERE id=?', [connector.id]);
  if (src?.circuit_open_until && src.circuit_open_until > t0) {
    const r = await db.run('INSERT INTO ingest_runs(source_id,trigger,started_at,ended_at,status,error) VALUES(?,?,?,?,?,?)',
      [connector.id, trigger, t0, t0, 'skipped', `circuit open until ${new Date(src.circuit_open_until).toISOString()}`]);
    return { sourceId: connector.id, status: 'skipped', runId: r.lastInsertRowid };
  }
  const watch = await getWatch(db);
  if (watch.sources[connector.id] === false) { // the owner switched this source off: no network, reported plainly
    await db.run('UPDATE sources SET status=? WHERE id=?', ['disabled_by_owner', connector.id]);
    const r = await db.run('INSERT INTO ingest_runs(source_id,trigger,started_at,ended_at,status,error) VALUES(?,?,?,?,?,?)', [connector.id, trigger, t0, t0, 'skipped', 'disabled by the owner']);
    return { sourceId: connector.id, status: 'disabled_by_owner', runId: r.lastInsertRowid };
  }
  const avail = connector.availability?.();
  if (avail && avail.status !== 'ready') { // e.g. opt-in source without credentials: say so, do not call it an error, do not touch the network
    await db.run('UPDATE sources SET status=?,last_error=NULL WHERE id=?', [avail.status, connector.id]);
    const r = await db.run('INSERT INTO ingest_runs(source_id,trigger,started_at,ended_at,status,error) VALUES(?,?,?,?,?,?)', [connector.id, trigger, t0, t0, 'skipped', String(avail.reason ?? avail.status).slice(0, 300)]);
    return { sourceId: connector.id, status: avail.status, reason: avail.reason, runId: r.lastInsertRowid };
  }
  // Sources with a published call quota (NearBlocks free tier) or slowly changing numbers (TVL, DAO balances) declare minIntervalMs. Scheduled ticks skip them until it has
  // passed, with no run row and no status change; a manual or CLI run always goes through.
  const every = Number(connector.minIntervalMs) || 0;
  if (every && trigger !== 'manual' && src?.last_success && t0 - src.last_success < every) return { sourceId: connector.id, status: 'fresh', nextInMs: every - (t0 - src.last_success) };
  const run = await db.run('INSERT INTO ingest_runs(source_id,trigger,started_at,status) VALUES(?,?,?,?)', [connector.id, trigger, t0, 'running']);
  const runId = run.lastInsertRowid;
  const stats = { fetched: 0, inserted: 0, updated: 0, duplicates: 0, filtered: 0 };
  let capped = 0; let flagged = 0; // capped: relevant items beyond the connector's per-tick cap (not stored this tick); flagged: kept with low-signal/bot flags
  try {
    const { items, meta } = await connector.fetch({ fetchImpl });
    stats.fetched = items.length;
    const cap = Number(connector.maxItems?.()) || Infinity; // per-source work bound per tick (social sources: default 40)
    let processed = 0;
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.externalId)) { stats.duplicates++; continue; }
      seen.add(it.externalId);
      let rel = it.forceTags
        ? { score: 1, isNear: true, reasons: [it.forceReason ?? 'official NEAR RPC observation'], tags: it.forceTags, flags: [] }
        : assessRelevance({ title: it.title, body: it.body, url: it.relevanceUrl ?? it.url, org: it.org, author: it.author, authorType: it.authorType });
      if (!it.forceTags) { const w = applyWatch(rel, `${it.title}\n${it.body}`, watch); if (w.drop) { stats.filtered++; continue; } rel = w.rel; }
      if (!rel.isNear || rel.score < RELEVANCE_THRESHOLD) { stats.filtered++; continue; }
      if (++processed > cap) { capped++; continue; }
      const full = norm(`${it.title}\n${it.body}`);
      const contentHash = sha256(full);
      const id = 'ev_' + sha256(`${connector.id}|${it.externalId}`).slice(0, 16);
      const existing = await db.get('SELECT content_hash FROM evidence WHERE id=?', [id]);
      if (existing && existing.content_hash === contentHash) { stats.duplicates++; continue; } // unchanged: one query, nothing else
      const rawRef = await putBlob(db, JSON.stringify(it.raw));
      const flags = [...new Set([...rel.flags, ...(it.flags ?? [])])]; // connector flags (e.g. low-signal:*) are kept next to relevance flags, never dropped
      if (flags.some((f) => f.startsWith('low-signal:') || f === 'bot-author')) flagged++;
      const twin = await db.get('SELECT id FROM evidence WHERE content_hash=? AND id<>? LIMIT 1', [contentHash, id]);
      if (twin) flags.push(`duplicate-content-of:${twin.id}`);
      const excerpt = full.slice(it.title.length).trim().slice(0, 1200);
      const title = it.title.slice(0, 300);
      if (existing) {
        await db.run(`UPDATE evidence SET observed_at=?,title=?,body_excerpt=?,content_hash=?,raw_ref=?,relevance=?,relevance_reasons=?,tags=?,flags=?,signals=? WHERE id=?`,
          [t0, title, excerpt, contentHash, rawRef, rel.score, j(rel.reasons), j(rel.tags), j(flags), j(it.signals ?? {}), id]);
        stats.updated++;
      } else {
        await db.run(`INSERT INTO evidence(id,source_id,external_id,canonical_url,observed_at,published_at,author,title,body_excerpt,content_hash,raw_ref,license,relevance,relevance_reasons,tags,kind,flags,signals)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, connector.id, it.externalId, it.url, t0, it.publishedAt ?? null, it.author ?? '', title, excerpt, contentHash, rawRef, it.license ?? '', rel.score, j(rel.reasons), j(rel.tags), it.kind, j(flags), j(it.signals ?? {})]);
        stats.inserted++;
      }
      await db.run('INSERT OR IGNORE INTO evidence_revisions(evidence_id,content_hash,observed_at,raw_ref) VALUES(?,?,?,?)', [id, contentHash, t0, rawRef]);
    }
    await db.run('UPDATE sources SET status=?,consecutive_failures=0,circuit_open_until=NULL,last_success=?,last_error=NULL WHERE id=?', ['ok', now(), connector.id]);
    await db.run('UPDATE ingest_runs SET ended_at=?,status=?,fetched=?,inserted=?,updated=?,duplicates=?,filtered=? WHERE id=?', [now(), 'ok', stats.fetched, stats.inserted, stats.updated, stats.duplicates, stats.filtered, runId]);
    if (meta || capped || cap !== Infinity) { // per-run diagnostics shown by /api/status: partial failures, filtered/capped/flagged counts
      await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [`meta:${connector.id}`, j({ ...(meta ?? {}), at: now(), cap: cap === Infinity ? null : cap, capped, flaggedLowSignal: flagged, relevanceFiltered: stats.filtered })]);
    }
    await audit(db, 'ingest', 'source.ok', { source: connector.id, trigger, ...stats, capped, flagged });
    return { sourceId: connector.id, status: 'ok', runId, ...stats };
  } catch (e) {
    const fails = (src?.consecutive_failures ?? 0) + 1;
    const open = fails >= MAX_FAILS_BEFORE_OPEN ? now() + circuitMs(fails) : null;
    await db.run('UPDATE sources SET status=?,consecutive_failures=?,circuit_open_until=?,last_error=?,last_error_at=? WHERE id=?', [fails >= MAX_FAILS_BEFORE_OPEN ? 'circuit_open' : 'error', fails, open, String(e.message).slice(0, 300), now(), connector.id]);
    await db.run('UPDATE ingest_runs SET ended_at=?,status=?,error=?,fetched=?,inserted=?,updated=?,duplicates=?,filtered=? WHERE id=?', [now(), 'error', String(e.message).slice(0, 300), stats.fetched, stats.inserted, stats.updated, stats.duplicates, stats.filtered, runId]);
    await audit(db, 'ingest', 'source.error', { source: connector.id, trigger, error: String(e.message).slice(0, 200), failures: fails });
    return { sourceId: connector.id, status: 'error', runId, error: e.message };
  }
}

export async function ingestAll(db, { trigger = 'manual', connectors = CONNECTORS, fetchImpl } = {}) {
  await registerSources(db, connectors);
  const out = [];
  for (const c of connectors) out.push(await ingestSource(db, c, { trigger, fetchImpl }));
  await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', ['ingest:last_all', j({ at: now(), trigger })]);
  return out;
}
