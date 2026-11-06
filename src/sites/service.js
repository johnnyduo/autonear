// The server side of the Build show: build a stored page from the council result, list the pages, serve /develop/<slug>[/<hash>].
import { now, audit } from '../db.js';
import { PolicyError, Budget } from '../policy.js';
import { oppEvidence, getOpp } from '../store.js';
import { BUILDABLE_TOPICS } from '../council.js';
import { findAttestedBuild } from '../orchestrator/agents.js';
import { isSocialSource } from '../connectors/source-weights.js';
import { slugOf, validateContent } from './schema.js';
import { generateContent } from './content.js';
import { renderSite, shortHash, esc, SITE_CSP, TEMPLATE_VERSION } from './render.js';
import { saveSite, getSite, latestPublished, latestBuilt, listSites, tokensSince, staleKeys } from './store.js';

const DAY = 864e5;
const dailyTokenCap = () => Number(process.env.SITE_DAILY_TOKENS) || 40_000;
const httpUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

/** Stored evidence that supports the product, minus flagged and social records. Titles only (no body text goes to the model). */
export async function evidenceFor(db, oppId, max = 5) {
  const rows = (await oppEvidence(db, oppId)).filter((e) => (e.relation === 'supports' || e.relation === 'usage') && !e.flags.length && !isSocialSource(e.source_id));
  const seen = new Set(); const list = [];
  for (const e of rows) {
    const title = String(e.title ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const url = httpUrl(e.canonical_url);
    list.push(url ? { title, url } : { title });
    if (list.length >= max) break;
  }
  return list;
}

/** What the API shows for one stored version (no model text). */
export const view = (r) => r && ({
  opp_id: r.opp_id, slug: r.slug, hash: r.hash, url: `/develop/${r.slug}/${r.hash}`, built_at: r.created_at, published: r.published_at != null, published_at: r.published_at,
  verdict: r.meta.verdict ?? null, support: r.meta.support ?? null, override: Boolean(r.meta.override), model: r.meta.model ?? null, tokens: r.meta.tokens ?? 0, cost: r.meta.cost ?? 0,
  ...(r.content ? { content: r.content } : {}),
});

/** Public list: one row per council opportunity, with its newest stored version and the published one. */
export async function listView(db, council) {
  const all = await listSites(db); // newest first
  const stale = await staleKeys(db);
  return council.opportunities.map((o) => {
    const slug = slugOf(o); const mine = all.filter((s) => s.slug === slug);
    const built = mine[0] ?? null; const pub = mine.find((s) => s.published_at != null) ?? null;
    return {
      opp_id: o.oppId, slug, title: o.title, verdict: o.verdict, support: o.support, buildable: o.verdict === 'go' || Boolean(o.pageReady), can_override: o.verdict === 'watch' && !o.pageReady, page_ready: Boolean(o.pageReady), contract_template: Boolean(o.contractTemplate),
      hash: built?.hash ?? null, built_at: built?.created_at ?? null, published: Boolean(pub), published_hash: pub?.hash ?? null,
      override: Boolean(built?.meta.override), model: built?.meta.model ?? null, tokens: built?.meta.tokens ?? 0, cost: built?.meta.cost ?? 0,
      ...(built && stale.has(`${slug}/${built.hash}`) ? { stale: true } : {}),
    };
  });
}

/** Build (or return) the stored page for one opportunity. `entry` is the council entry for it. Returns { site, created }. */
export async function buildSite(db, { oppId, entry, override = false, regenerate = false, actor }) {
  if (!entry) throw new PolicyError('the council has no entry for this product', 'not_found');
  if (entry.verdict === 'drop') throw new PolicyError('The council dropped this product. A page can be built only for GO, or for WATCH on the owner\'s call.', 'state');
  if (entry.verdict !== 'go' && !entry.pageReady && override !== true) throw new PolicyError(`The council says ${String(entry.verdict).toUpperCase()}, not GO. Send override: true to build on the owner's call.`, 'state');
  const opp = await getOpp(db, oppId); if (!opp) throw new PolicyError('unknown product', 'not_found');
  const slug = slugOf(opp);
  if (!regenerate) { const have = await latestBuilt(db, slug); if (have && validateContent(have.content).ok) return { site: have, created: false }; } // a stored page that no longer passes the schema is written again
  const used = await tokensSince(db, now() - DAY);
  if (used >= dailyTokenCap()) throw new PolicyError('The daily token budget for page text is used up. Try again tomorrow.', 'state');
  const evidence = await evidenceFor(db, oppId);
  const gen = await generateContent({ opportunity: opp, entry, evidenceTitles: evidence.map((e) => e.title), budget: new Budget({ tokens: Math.max(1, dailyTokenCap() - used) }) });
  const hash = shortHash(gen.content);
  const meta = { title: opp.title, verdict: entry.verdict, support: entry.support, override: entry.verdict !== 'go' && !entry.pageReady, model: gen.model, tokens: gen.tokens, cost: gen.cost, evidence, template: TEMPLATE_VERSION };
  const site = await saveSite(db, { slug, oppId, hash, content: gen.content, meta, createdAt: now() });
  await audit(db, actor, 'site.build', { opp: oppId, slug, hash, override: meta.override });
  return { site, created: true };
}

// ---- path to production: real stored state only -----------------------------------------------------------------------------------------------
const day = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : 'an unknown date');

/** Four steps {key, state: 'done'|'next'|'later', note} for one product. A step is done only when a stored row says so; the first step that is not done is next. */
export async function pathFor(db, oppId) {
  const opp = await getOpp(db, oppId);
  const template = Boolean(opp && BUILDABLE_TOPICS.includes(opp.topic));
  const done = {}; const note = {};
  done.contract = template;
  note.contract = template ? 'A contract template exists for this topic.' : 'A contract for this product has to be written and tested. None exists yet.';

  const att = template ? await findAttestedBuild(db, 'near') : null;
  done.build = Boolean(att);
  const passed = Number(att?.test_results?.passed);
  note.build = att ? `An attested build is stored${Number.isFinite(passed) && passed > 0 ? ` (${passed} tests passed)` : ''}, recorded ${day(att.created_at)}.` : template ? 'No attested build is stored yet. It is made by building the contract, running its tests and recording the hashes.' : 'There is nothing to build until a contract exists.';

  const run = await db.get('SELECT id FROM runs WHERE opportunity_id=? ORDER BY started_at DESC LIMIT 1', [oppId]);
  const decision = run ? await db.get("SELECT id, status, approver, decided_at, expiry FROM decisions WHERE run_id=? AND action='deploy_testnet' ORDER BY created_at DESC LIMIT 1", [run.id]) : null;
  const approved = Boolean(decision && ['approved', 'executed'].includes(decision.status));
  const byMandate = Boolean(decision?.approver && String(decision.approver).startsWith('mandate:'));
  done.approval = approved;
  note.approval = approved
    ? (byMandate ? `The deploy request was approved on ${day(decision.decided_at)} under a standing mandate. No person signed this deployment.` : `The owner approved the deploy request on ${day(decision.decided_at)}.`)
    : decision ? `A deploy request exists and is ${decision.status === 'pending' && decision.expiry < Date.now() ? 'expired' : decision.status}.` : 'No deploy request exists for this product yet.';

  const dep = decision ? await db.get('SELECT network, account, status, time FROM deployments WHERE decision_id=? ORDER BY time DESC LIMIT 1', [decision.id]) : null;
  const live = Boolean(dep && dep.status === 'verified' && dep.network === 'near-testnet');
  const viaVault = live && Boolean(await db.get("SELECT 1 x FROM mandate_runs WHERE decision_id=? AND status='confirmed'", [decision.id]));
  done.testnet = viaVault;
  note.testnet = viaVault
    ? `Deployed through the vault on NEAR testnet as ${dep.account} on ${day(dep.time)}, checked against the build.`
    : live ? `Deployed on NEAR testnet as ${dep.account} on ${day(dep.time)}, signed by the owner. It was not run through the vault.`
    : dep ? `A deployment is stored but it is ${dep.status} on ${dep.network}, not a checked NEAR testnet deployment.` : 'Nothing is deployed for this product.';

  let nextTaken = false;
  return ['contract', 'build', 'approval', 'testnet'].map((key) => {
    const state = done[key] ? 'done' : nextTaken ? 'later' : 'next';
    if (state === 'next') nextTaken = true;
    return { key, state, note: note[key] };
  });
}

// ---- public pages -------------------------------------------------------------------------------------------------------------------------
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'content-security-policy': SITE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN',
};
const plain = (status, text) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(text)}</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0e11;color:#ece9e1;margin:0;padding:48px 20px;max-width:560px}</style></head><body><p>${esc(text)}</p></body></html>`, { status, headers: { ...PAGE_HEADERS, 'cache-control': 'no-store' } });

/** `rest` is the path after /develop/. GET /develop/<slug> (published version only) and /develop/<slug>/<hash> (any stored version, unlisted link). */
export async function pageResponse(db, rest) {
  const parts = String(rest).replace(/\/$/, '').split('/'); const slug = parts[0]; const hash = parts[1] ?? null;
  if (parts.length > 2 || !/^[a-z0-9-]{1,40}$/.test(slug) || (hash !== null && !/^[0-9a-f]{10}$/.test(hash))) return plain(404, 'This page does not exist.');
  const site = hash ? await getSite(db, slug, hash) : await latestPublished(db, slug);
  if (!site) return plain(404, hash ? 'This page does not exist.' : 'No page is published here.');
  const v = validateContent(site.content); // the stored text is checked again before it is rendered; an older version (no contract) or a damaged row is not shown
  if (!v.ok) return plain(404, 'This version is out of date.');
  let path = null;
  try { path = await pathFor(db, site.opp_id); } catch { path = null; } // the page still shows; the renderer says the status is not available
  const html = renderSite({ content: v.value, meta: { slug, title: site.meta.title, verdict: site.meta.verdict, support: site.meta.support, builtAt: site.created_at, hash: site.hash, override: Boolean(site.meta.override), model: site.meta.model, evidence: site.meta.evidence ?? [], path } });
  return new Response(html, { status: 200, headers: { ...PAGE_HEADERS, 'cache-control': site.published_at != null ? 'public, max-age=60' : 'no-store' } });
}
