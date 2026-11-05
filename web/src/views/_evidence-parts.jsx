// Shared by Radar and Opportunity: source palette, flag chips, relevance meter and the PROVENANCE DRAWER.
import { useEffect, useState } from 'react';
import { api, fmt, useApi } from '../api.js';
import { Chip, Dialog, Empty, ErrorPanel, Hash, Icon, Meter, NeedsOperator, Skeleton, useToast } from '../ui.jsx';
import './evidence-parts.css';

export const TOPIC_ORDER = ['treasury', 'intents', 'signing', 'wallet_ux', 'dev_tooling', 'data_indexing', 'ai_agents'];
export const TOPIC_LABEL = {
  treasury: 'Treasury & multisig', intents: 'Intents & swaps', signing: 'Signatures & custody', wallet_ux: 'Wallet & account UX',
  dev_tooling: 'Developer tooling', data_indexing: 'Data, RPC & indexing', ai_agents: 'AI agents', untagged: 'Untagged',
};
const SRC = {
  'github-near': ['GitHub', '#5fa3c2'], 'gov-near': ['Gov forum', '#d9a6e8'], 'hn-algolia': ['Hacker News', '#f0c27b'], 'near-rpc-mainnet': ['NEAR RPC', '#7fd6c4'],
};
const FALLBACK = ['#e58fa0', '#a3b8f0', '#c9d98a', '#f0a37b'];
const fallbackColor = (id) => FALLBACK[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % FALLBACK.length];
export const srcColor = (id) => SRC[id]?.[1] ?? fallbackColor(id ?? '');
export const srcShort = (id) => SRC[id]?.[0] ?? id;
export const when = (e) => e.published_at ?? e.observed_at;
export const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

export function flagList(flags = []) {
  return flags.map((f) => {
    if (f === 'bot-author') return { key: f, label: 'bot author', why: 'Authored by a bot account: de-weighted in scoring.' };
    if (f.startsWith('duplicate-content-of')) return { key: f, label: 'duplicate', why: `Same content as ${f.split(':')[1] ?? 'another record'}: de-weighted in scoring.` };
    if (f.startsWith('prompt-injection')) return { key: f, label: 'injection quarantine', why: 'Contains prompt-injection-like text: kept out of LLM prompts.' };
    return { key: f, label: f, why: '' };
  });
}
export function FlagChips({ flags }) {
  const l = flagList(flags);
  if (!l.length) return null;
  return <>{l.map((f) => <Chip key={f.key} tone="bad" title={f.why}><Icon name="alert" size={12} />{f.label}</Chip>)}</>;
}
export function SourceTag({ id }) {
  return <span className="ep-src"><i style={{ background: srcColor(id) }} aria-hidden="true" />{srcShort(id)}</span>;
}
export function Relevance({ value = 0 }) {
  return <span className="ep-rel" title={`NEAR-relevance ${value.toFixed(2)} of 1`}><Meter value={value} tone={value >= 0.6 ? '' : 'warn'} label={`NEAR relevance ${value.toFixed(2)}`} /><b className="num">{value.toFixed(2)}</b></span>;
}
/** published = when the source says it was written; observed = when AutoNEAR fetched it. */
export function Freshness({ e }) {
  const t = when(e);
  const old = Date.now() - t > 30 * 864e5;
  return <span className={`ep-fresh ${old ? 'old' : ''}`} title={`${e.published_at ? 'published' : 'observed'} ${fmt.date(t)}`}>{fmt.ago(t)}</span>;
}

/* ------------------------------------------------------------------ provenance drawer */
export function EvidenceDrawer({ id, preview, onClose, token }) {
  const { data, error, loading, reload } = useApi(`/api/evidence/${id}`);
  const toast = useToast();
  const [raw, setRaw] = useState(null); const [rawErr, setRawErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setRaw(null); setRawErr(null); }, [id]);
  const e = data ?? preview ?? null;

  const loadRaw = async () => {
    setBusy(true); setRawErr(null);
    try { setRaw(await api(`/api/evidence/${id}?raw=1`)); }
    catch (x) { setRawErr(x); } finally { setBusy(false); }
  };
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('Hash copied'); } catch { toast('Copy is blocked by the browser; select the hash and copy manually', 'bad'); }
  };

  return (
    <Dialog title="Provenance" onClose={onClose} drawer wide>
      {!e && loading && <div className="stack-s" role="status" aria-label="Loading record"><Skeleton h={28} /><Skeleton h={120} /><Skeleton h={80} /></div>}
      {!e && error && <ErrorPanel error={error} onRetry={reload} what="this evidence record" />}
      {e && (
        <div className="ep-drawer stack">
          <div className="stack-s">
            <div className="row"><SourceTag id={e.source_id} /><Chip tone="mineral">{e.kind}</Chip><FlagChips flags={e.flags} /></div>
            <h3 className="ep-title">{e.title}</h3>
          </div>
          {error && data && <div className="banner warn" role="status"><Icon name="alert" /><span>Could not refresh this record; showing the last copy. <button className="btn sm" onClick={reload}>Retry</button></span></div>}
          {flagList(e.flags).map((f) => (
            <div key={f.key} className="banner risk" role="note"><Icon name="alert" /><span><b>{f.label}.</b> {f.why}</span></div>
          ))}

          <dl className="kv">
            <dt>Original</dt>
            <dd>
              <a href={e.canonical_url} target="_blank" rel="noreferrer noopener" className="ep-link">{e.canonical_url}<Icon name="external" size={14} /></a>
              <div className="help">Opens the source site in a new tab. AutoNEAR stores an excerpt and this link only.</div>
            </dd>
            <dt>Source</dt><dd>{srcShort(e.source_id)} <span className="faint mono-v">({e.source_id})</span></dd>
            <dt>External id</dt><dd className="mono-v">{e.external_id}</dd>
            <dt>Author</dt><dd>{e.author || <span className="faint">not provided</span>}</dd>
            <dt>Content hash</dt>
            <dd>
              <span className="mono-v ep-hash">{e.content_hash}</span>
              <div><button className="btn sm ghost" onClick={() => copy(e.content_hash)} aria-label="Copy content hash"><Icon name="copy" size={14} />Copy hash</button></div>
            </dd>
            <dt>Raw store ref</dt><dd><Hash h={e.raw_ref} n={14} /></dd>
            <dt>Published</dt><dd className="num">{e.published_at ? <>{fmt.date(e.published_at)} <span className="faint">({fmt.ago(e.published_at)})</span></> : <span className="faint">source gave no publish time</span>}</dd>
            <dt>Observed</dt><dd className="num">{fmt.date(e.observed_at)} <span className="faint">({fmt.ago(e.observed_at)})</span></dd>
            <dt>License</dt><dd className="dim">{e.license || 'not stated'}</dd>
          </dl>

          <section aria-labelledby="ep-why" className="stack-s">
            <h4 id="ep-why" className="eyebrow">Why this counts as NEAR Protocol</h4>
            <div className="row"><Relevance value={e.relevance} /></div>
            {e.reasons?.length ? <ul className="ep-reasons">{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="faint">No stored reasons for this record.</p>}
            <p className="help">Reasons come from the relevance filter at ingest time; the English word &ldquo;near&rdquo; alone never qualifies.</p>
          </section>

          <section aria-labelledby="ep-tags" className="stack-s">
            <h4 id="ep-tags" className="eyebrow">Tags &amp; signals</h4>
            <div className="row">{e.tags?.length ? e.tags.map((t) => <Chip key={t} tone="mineral">{TOPIC_LABEL[t] ?? t}</Chip>) : <span className="faint">no topic tags</span>}</div>
            {e.signals && Object.keys(e.signals).length > 0 && <div className="row">{Object.entries(e.signals).map(([k, v]) => <Chip key={k}>{k}: {String(v)}</Chip>)}</div>}
          </section>

          <section aria-labelledby="ep-ex" className="stack-s">
            <h4 id="ep-ex" className="eyebrow">Stored excerpt (untrusted text)</h4>
            <blockquote className="ep-excerpt">{e.body_excerpt || 'No excerpt stored.'}</blockquote>
          </section>

          <section aria-labelledby="ep-rev" className="stack-s">
            <h4 id="ep-rev" className="eyebrow">Revisions</h4>
            {!data ? <Skeleton h={24} /> : data.revisions?.length ? (
              <ol className="ep-rev">{data.revisions.map((r, i) => <li key={r.content_hash}><span className="num">{fmt.date(r.observed_at)}</span><Hash h={r.content_hash} n={8} />{r.content_hash === e.content_hash && <Chip tone="ok">current</Chip>}{i === 0 && <span className="faint">first seen</span>}</li>)}</ol>
            ) : <p className="faint">One version stored; the content has not changed since first observation.</p>}
          </section>

          <section aria-labelledby="ep-opp" className="stack-s">
            <h4 id="ep-opp" className="eyebrow">Linked opportunities</h4>
            {!data ? <Skeleton h={24} /> : data.links?.length ? (
              <ul className="ep-links">{data.links.map((l) => (
                <li key={l.opportunity_id + l.relation}>
                  <a href={`#/opportunity/${l.opportunity_id}`} className="btn sm">{l.opportunity_id.replace('opp_', '')}</a>
                  <Chip tone={l.relation === 'contradicts' ? 'bad' : l.relation === 'supports' ? 'ok' : 'mineral'}>{l.relation}</Chip>
                  <span className="dim">{l.note}</span>
                </li>
              ))}</ul>
            ) : <p className="faint">Not linked to any opportunity yet.</p>}
          </section>

          <section aria-labelledby="ep-raw" className="stack-s">
            <h4 id="ep-raw" className="eyebrow">Raw source payload</h4>
            <NeedsOperator token={token} hint="Operator token required for raw payloads">
              {raw ? <pre className="code">{JSON.stringify(raw.raw ?? raw, null, 2)}</pre> : (
                <div><button className="btn" onClick={loadRaw} disabled={busy}>{busy ? 'Loading…' : 'Load raw payload'}</button></div>
              )}
            </NeedsOperator>
            {!token && <p className="help">Sign in with the operator token (top right) to read the unredacted payload stored at the raw ref above.</p>}
            {rawErr && <div className="banner risk" role="alert"><Icon name="alert" /><span>{rawErr.status === 401 ? 'The API refused the token: raw payloads need the operator token.' : rawErr.message}</span></div>}
          </section>
        </div>
      )}
      {!e && !loading && !error && <Empty title="Record not found">It may have been removed.</Empty>}
    </Dialog>
  );
}
