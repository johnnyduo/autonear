// Storage for the concept pages (table `sites`, created in src/db.js SCHEMA_V4). One row per (slug, content hash).
// published_at is set on at most one row per slug: the partial unique index enforces it and publish() clears the others first.
import { parse, j, now } from '../db.js';
import { PolicyError } from '../policy.js';
import { validateContent } from './schema.js';

const row = (r) => (r ? { slug: r.slug, hash: r.hash, opp_id: r.opp_id, content: parse(r.content, null), meta: parse(r.meta, {}), created_at: r.created_at, published_at: r.published_at ?? null } : null);

/** Inserts a version. An identical (slug, hash) is kept as it is. Returns the stored row. */
export async function saveSite(db, { slug, oppId, hash, content, meta, createdAt = now() }) {
  await db.run('INSERT OR IGNORE INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,NULL)', [slug, hash, oppId, j(content), j(meta), createdAt]);
  return getSite(db, slug, hash);
}
export const getSite = async (db, slug, hash) => row(await db.get('SELECT * FROM sites WHERE slug=? AND hash=?', [slug, hash]));
export const latestPublished = async (db, slug) => row(await db.get('SELECT * FROM sites WHERE slug=? AND published_at IS NOT NULL', [slug]));
export const latestBuilt = async (db, slug) => row(await db.get('SELECT * FROM sites WHERE slug=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [slug]));
/** Every stored version, newest first, without the content (the list is for the queue and the gallery). */
export async function listSites(db) {
  return (await db.all('SELECT slug,hash,opp_id,meta,created_at,published_at FROM sites ORDER BY created_at DESC, rowid DESC')).map((r) => ({ ...row({ ...r, content: 'null' }), content: undefined }));
}
/** Makes (slug, hash) the published version and clears the others. */
export async function publish(db, slug, hash) {
  if (!(await getSite(db, slug, hash))) throw new PolicyError('no such stored page version', 'not_found');
  await db.tx(async (t) => {
    await t.run('UPDATE sites SET published_at=NULL WHERE slug=? AND published_at IS NOT NULL', [slug]);
    await t.run('UPDATE sites SET published_at=? WHERE slug=? AND hash=?', [now(), slug, hash]);
  });
  return getSite(db, slug, hash);
}
export async function unpublish(db, slug) {
  const r = await db.run('UPDATE sites SET published_at=NULL WHERE slug=? AND published_at IS NOT NULL', [slug]);
  return r.changes > 0;
}
/** Tokens spent on page text since `sinceMs` (the daily budget check). */
export async function tokensSince(db, sinceMs) {
  return (await db.all('SELECT meta FROM sites WHERE created_at>=?', [sinceMs])).reduce((a, r) => a + (Number(parse(r.meta, {}).tokens) || 0), 0);
}

/** Keys ("slug/hash") of the stored versions whose content no longer passes the current schema (for example pages written before the contract field existed). */
export async function staleKeys(db) {
  const out = new Set();
  for (const r of await db.all('SELECT slug,hash,content FROM sites')) if (!validateContent(parse(r.content, null)).ok) out.add(`${r.slug}/${r.hash}`);
  return out;
}
