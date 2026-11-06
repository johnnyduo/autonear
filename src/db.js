// Async storage adapter. Local/dev: node:sqlite (zero deps). Vercel/prod: libSQL (Turso) via @libsql/client.
// Both speak SQLite SQL. Rule for tx(): never await network I/O inside the callback.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const now = () => Date.now();
export const j = (v) => JSON.stringify(v);
export const parse = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL,
  terms TEXT, rate_limit TEXT, docs_url TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until INTEGER, last_success INTEGER, last_error TEXT, last_error_at INTEGER);
CREATE TABLE IF NOT EXISTS evidence(
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL, observed_at INTEGER NOT NULL, published_at INTEGER, author TEXT,
  title TEXT NOT NULL, body_excerpt TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL,
  raw_ref TEXT NOT NULL, license TEXT, relevance REAL NOT NULL DEFAULT 0, relevance_reasons TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'demand', flags TEXT NOT NULL DEFAULT '[]', signals TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source_id, external_id));
CREATE INDEX IF NOT EXISTS evidence_obs ON evidence(observed_at DESC);
CREATE TABLE IF NOT EXISTS evidence_revisions(
  evidence_id TEXT NOT NULL, content_hash TEXT NOT NULL, observed_at INTEGER NOT NULL, raw_ref TEXT NOT NULL,
  PRIMARY KEY(evidence_id, content_hash));
CREATE TABLE IF NOT EXISTS raw_store(ref TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS raw_store_immutable BEFORE UPDATE ON raw_store BEGIN SELECT RAISE(ABORT,'raw_store is immutable'); END;
CREATE TABLE IF NOT EXISTS ingest_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0, filtered INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS opportunities(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT NOT NULL, problem TEXT NOT NULL, audience TEXT NOT NULL,
  topic TEXT NOT NULL, score_breakdown TEXT NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_links(
  opportunity_id TEXT NOT NULL, evidence_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN('supports','contradicts','competitor','usage')),
  note TEXT NOT NULL DEFAULT '', PRIMARY KEY(opportunity_id, evidence_id, relation));
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, idem_key TEXT UNIQUE, opportunity_id TEXT NOT NULL, trigger TEXT NOT NULL, state TEXT NOT NULL,
  budget TEXT NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, spent_tokens INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, stage TEXT NOT NULL, agent_role TEXT NOT NULL,
  time INTEGER NOT NULL, input_refs TEXT NOT NULL DEFAULT '[]', output_ref TEXT, model TEXT, tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', prev_hash TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(run_id, prev_hash));
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, immutable_ref TEXT NOT NULL, hash TEXT NOT NULL,
  commit_sha TEXT, test_results TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(ref TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS blobs_immutable BEFORE UPDATE ON blobs BEGIN SELECT RAISE(ABORT,'blobs are immutable'); END;
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY, run_id TEXT, artifact_hash TEXT NOT NULL, action TEXT NOT NULL, chain_id TEXT NOT NULL,
  target TEXT NOT NULL, method TEXT NOT NULL, max_spend TEXT NOT NULL, expiry INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, approver TEXT, status TEXT NOT NULL DEFAULT 'pending',
  decided_at INTEGER, signed_receipt TEXT, bound_signer TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deployments(
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, network TEXT NOT NULL, account TEXT NOT NULL, artifact_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE, explorer_url TEXT NOT NULL, time INTEGER NOT NULL, status TEXT NOT NULL, verification TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT NOT NULL, prev_hash TEXT NOT NULL UNIQUE, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** Schema v2: indexes only (migrations/0002_indexes.sql is generated from this). Kept apart from SCHEMA so 0001 never changes once applied.
 *  evidence_sortkey matches the expression the list API orders by, so paging no longer scans + sorts the whole table. */
export const SCHEMA_V2 = `
CREATE INDEX IF NOT EXISTS evidence_sortkey ON evidence(COALESCE(published_at,observed_at) DESC);
CREATE INDEX IF NOT EXISTS evidence_source_sortkey ON evidence(source_id, COALESCE(published_at,observed_at) DESC);
CREATE INDEX IF NOT EXISTS evidence_links_by_evidence ON evidence_links(evidence_id);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS runs_by_opportunity ON runs(opportunity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS decisions_created ON decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_by_run ON decisions(run_id);
CREATE INDEX IF NOT EXISTS deployments_by_decision ON deployments(decision_id);
CREATE INDEX IF NOT EXISTS artifacts_by_hash ON artifacts(hash);
CREATE INDEX IF NOT EXISTS artifacts_by_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS ingest_runs_by_source ON ingest_runs(source_id, id DESC);
`;

/** Schema v3: Mandate Vault tables (NEW tables only; migrations/0003_vault.sql is generated from this, existing tables are never altered).
 *  vault_ledger is hash-chained like audit (UNIQUE(prev_hash) makes a fork impossible). mandate_runs.decision_id is the PRIMARY KEY, so a decision
 *  can be executed by the agent at most once; the partial unique index makes "one deploy in flight per vault" a database fact, not a convention. */
export const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS vaults(
  id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, address TEXT NOT NULL, owner TEXT NOT NULL, agent TEXT, attested_ref TEXT,
  status TEXT NOT NULL DEFAULT 'attached', mandate_decision_id TEXT, created_at INTEGER NOT NULL, last_state TEXT, last_read_at INTEGER,
  UNIQUE(chain_id, address));
CREATE TABLE IF NOT EXISTS vault_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL, time INTEGER NOT NULL, kind TEXT NOT NULL, decision_id TEXT, tx_hash TEXT,
  amount TEXT, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', prev_hash TEXT NOT NULL UNIQUE, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS vault_ledger_by_vault ON vault_ledger(vault_id, id DESC);
CREATE TABLE IF NOT EXISTS mandate_runs(
  decision_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, epoch INTEGER NOT NULL, tx_hash TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mandate_runs_by_vault ON mandate_runs(vault_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mandate_runs_one_inflight ON mandate_runs(vault_id) WHERE status IN ('claimed','submitted');
`;

/** Schema v4: landing pages written from the council result (NEW table only; migrations/0004_sites.sql is generated from this).
 *  One row per (slug, content hash). The partial unique index makes "at most one published version per slug" a database fact. */
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS sites(
  slug TEXT NOT NULL, hash TEXT NOT NULL, opp_id TEXT NOT NULL, content TEXT NOT NULL, meta TEXT NOT NULL,
  created_at INTEGER NOT NULL, published_at INTEGER, PRIMARY KEY(slug, hash));
CREATE UNIQUE INDEX IF NOT EXISTS sites_one_published ON sites(slug) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sites_by_created ON sites(created_at DESC);
`;

/** Schema v5: token payouts (NEW table only; migrations/0005_payments.sql is generated from this, existing tables are never altered).
 *  One row per executed pay_testnet decision. decision_id UNIQUE = one payment per decision; tx_hash UNIQUE = one chain transaction can
 *  prove only one payment. `verification` is the adapter's check list (JSON). Written ONLY after the transfer was verified on chain. */
export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL, token TEXT NOT NULL, payee TEXT NOT NULL,
  amount TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, verification TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS payments_by_created ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS payments_by_vault ON payments(vault_id, created_at DESC);
`;

class Lock {
  #p = Promise.resolve();
  run(fn) { const r = this.#p.then(fn, fn); this.#p = r.catch(() => {}); return r; }
}

async function openLocal(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const lock = new Lock();
  const ops = {
    all: async (sql, a = []) => raw.prepare(sql).all(...a).map((r) => ({ ...r })),
    get: async (sql, a = []) => { const r = raw.prepare(sql).get(...a); return r ? { ...r } : undefined; },
    run: async (sql, a = []) => { const r = raw.prepare(sql).run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
  };
  return {
    kind: 'sqlite', ...ops,
    exec: async (s) => raw.exec(s),
    tx: (fn) => lock.run(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await fn(ops); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    }),
    close: async () => raw.close(),
  };
}

async function openLibsql(url, authToken) {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url, authToken });
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((col, i) => [col, r[i]])));
  const mk = (ex) => ({
    all: async (sql, a = []) => rows(await ex.execute({ sql, args: a })),
    get: async (sql, a = []) => rows(await ex.execute({ sql, args: a }))[0],
    run: async (sql, a = []) => { const r = await ex.execute({ sql, args: a }); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) }; },
  });
  const ops = mk(c);
  return {
    kind: 'libsql', ...ops,
    exec: async (s) => c.executeMultiple(s),
    tx: async (fn) => {
      const t = await c.transaction('write');
      try { const r = await fn(mk(t)); await t.commit(); return r; } catch (e) { try { await t.rollback(); } catch { /* ignore */ } throw e; } finally { t.close(); }
    },
    close: async () => c.close(),
  };
}

const nn = (a) => a.map((x) => (x === undefined ? null : x));
/** Cloudflare D1 binding. D1 has no interactive transactions: tx() is sequential and NOT atomic (atomicTx=false).
 *  Schema is applied by `wrangler d1 migrations apply` (see migrations/), never at request time. */
export function openD1(d1) {
  const ops = {
    all: async (sql, a = []) => (await d1.prepare(sql).bind(...nn(a)).all()).results,
    get: async (sql, a = []) => (await d1.prepare(sql).bind(...nn(a)).first()) ?? undefined,
    run: async (sql, a = []) => { const r = await d1.prepare(sql).bind(...nn(a)).run(); return { changes: r.meta.changes, lastInsertRowid: r.meta.last_row_id }; },
  };
  return { kind: 'd1', atomicTx: false, ...ops, exec: async () => {}, tx: async (fn) => fn(ops), close: async () => {} };
}

export async function openDb({ url = '', authToken = '', path = ':memory:', d1 = null } = {}) {
  if (d1) return openD1(d1);
  const db = url ? await openLibsql(url, authToken) : await openLocal(path);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA_V2);
  await db.exec(SCHEMA_V3);
  await db.exec(SCHEMA_V4);
  await db.exec(SCHEMA_V5);
  return db;
}

/** Append-only hash-chained audit log. UNIQUE(prev_hash) makes a fork impossible on every backend: a racing writer
 *  loses the insert and retries on the new head. */
export async function audit(db, actor, action, detail = {}) {
  const d = j(detail);
  for (let attempt = 0; attempt < 8; attempt++) {
    const prev = (await db.get('SELECT hash FROM audit ORDER BY id DESC LIMIT 1'))?.hash ?? '0'.repeat(64);
    const time = now();
    const hash = sha256(`${prev}|${time}|${actor}|${action}|${d}`);
    try {
      await db.run('INSERT INTO audit(time,actor,action,detail,prev_hash,hash) VALUES(?,?,?,?,?,?)', [time, actor, action, d, prev, hash]);
      return hash;
    } catch (e) { if (!/UNIQUE|constraint/i.test(String(e.message))) throw e; }
  }
  throw new Error('audit: could not append after retries');
}

export async function verifyAuditChain(db) {
  let prev = '0'.repeat(64);
  for (const r of await db.all('SELECT * FROM audit ORDER BY id')) {
    if (r.prev_hash !== prev || sha256(`${prev}|${r.time}|${r.actor}|${r.action}|${r.detail}`) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}

export async function putBlob(db, body) {
  const ref = 'sha256:' + sha256(body);
  await db.run('INSERT OR IGNORE INTO blobs(ref,body,created_at) VALUES(?,?,?)', [ref, body, now()]);
  return ref;
}
export const getBlob = async (db, ref) => (await db.get('SELECT body FROM blobs WHERE ref=?', [ref]))?.body ?? null;
