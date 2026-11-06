// Pure renderer: content JSON + meta -> one HTML page. Same input, same bytes. Every dynamic string is escaped here, nowhere else.
// Markup contract with /swarm.js: each buildable element has data-sw="box|text|button|line|media" and optionally data-sw-agent="Copy|Layout|Style|Media|Check".
// Document order is build order and parents come before children.
import { createHash } from 'node:crypto';

export const TEMPLATE_VERSION = 'v1';
/** Sent with every /develop page. vercel.json carries the same string (a test keeps the two equal). */
export const SITE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
/** sha-256 (hex) over the canonical JSON of the content (keys sorted) plus the template version. */
export const contentHash = (content, templateVersion = TEMPLATE_VERSION) => createHash('sha256').update(JSON.stringify(canon(content))).update('\n').update(String(templateVersion)).digest('hex');
/** The first 10 hex characters: the id used in URLs and in the sites table. */
export const shortHash = (content, templateVersion = TEMPLATE_VERSION) => contentHash(content, templateVersion).slice(0, 10);

const AGENT = { box: 'Layout', text: 'Copy', button: 'Style', line: 'Layout', media: 'Media' };
/** Attribute string for a buildable element. */
const sw = (kind, agent = AGENT[kind]) => `data-sw="${kind}" data-sw-agent="${agent}"`;

const CSS = `
:root{--bg:#0b0e11;--panel:#12171c;--line:#252d35;--text:#ece9e1;--muted:#9aa3ab;--accent:#c6f432;--ink:#0b0e11;--display:Georgia,'Times New Roman',serif;--sans:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 var(--sans)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px}
.brand{font:700 18px/1.2 var(--display);letter-spacing:.01em}
.tag{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.hero{padding:56px 0 40px}
.hero .wrap{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:center}
.badge{display:inline-block;padding:4px 12px;border:1px solid var(--accent);color:var(--accent);border-radius:999px;font-size:13px;letter-spacing:.04em}
h1{font:700 clamp(30px,5vw,50px)/1.1 var(--display);margin:18px 0 14px;overflow-wrap:anywhere}
.sub{font-size:18px;color:var(--muted);margin:0 0 24px;max-width:34em;overflow-wrap:anywhere}
.cta{appearance:none;border:0;background:var(--accent);color:var(--ink);font:600 16px/1 var(--sans);padding:14px 22px;border-radius:8px;cursor:default}
.media{position:relative;aspect-ratio:4/3;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:linear-gradient(135deg,#141b22,#0f1418)}
.media i{position:absolute;display:block;border-radius:10px}
.media i:nth-child(1){left:8%;top:12%;width:46%;height:20%;background:var(--accent);opacity:.9}
.media i:nth-child(2){left:8%;top:40%;width:84%;height:12%;background:#26313b}
.media i:nth-child(3){left:8%;top:58%;width:60%;height:12%;background:#26313b}
.media i:nth-child(4){right:8%;bottom:10%;width:28%;height:16%;border:2px solid var(--accent)}
section.block{padding:40px 0}
h2{font:700 clamp(22px,3vw,30px)/1.2 var(--display);margin:0 0 22px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
.card h3{font:700 18px/1.25 var(--display);margin:0 0 8px;overflow-wrap:anywhere}
.card p{margin:0;color:var(--muted);overflow-wrap:anywhere}
.steps{position:relative}
.steps .rail{position:absolute;left:5%;right:5%;top:30px;height:2px;background:var(--line)}
.steps .grid{position:relative}
.num{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--accent);color:var(--ink);font-weight:700;margin-bottom:12px}
.council{margin:8px 0 0;padding:18px 20px;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;background:var(--panel)}
.council p{margin:0}
.council .own{margin-top:6px;color:var(--muted)}
footer{margin-top:40px;border-top:1px solid var(--line);padding:28px 0 40px;color:var(--muted);font-size:14px}
footer p{margin:0 0 8px}
footer .note{color:var(--text)}
footer ul{margin:8px 0 12px;padding-left:20px}
footer a{color:var(--muted)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
@media (max-width:760px){.hero .wrap{grid-template-columns:1fr;gap:28px}.grid{grid-template-columns:1fr}.steps .rail{left:18px;right:auto;top:30px;bottom:30px;width:2px;height:auto}.hero{padding-top:36px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

const NOSCRIPT = '<noscript><style>[data-sw]{opacity:1!important;visibility:visible!important;transform:none!important}</style></noscript>';

const httpUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dateOf = (ms) => { const d = new Date(Number(ms)); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown date'; };
const VERDICT = { go: 'GO', watch: 'WATCH', drop: 'DROP' };

/**
 * @param {{content:{badge,headline,sub,features:{title,body}[],steps:{title,body}[],cta}, meta:{slug,title,verdict,support,builtAt,hash,override,model,evidence:{title,url?}[]}}} a
 * @returns {string} a full HTML document
 */
export function renderSite({ content, meta }) {
  const c = content; const m = meta ?? {};
  const score = Math.round(Math.min(1, Math.max(0, Number(m.support) || 0)) * 100);
  const verdict = VERDICT[m.verdict] ?? esc(String(m.verdict ?? '').toUpperCase());
  const hash = esc(String(m.hash ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 10));
  const evidence = (Array.isArray(m.evidence) ? m.evidence : []).slice(0, 6).map((e) => {
    const title = esc(clip(e?.title, 140)); const href = httpUrl(e?.url);
    return `<li>${href ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>` : title}</li>`;
  }).join('');
  const feature = (f) => `<div class="card" ${sw('box')}><h3 ${sw('text')}>${esc(f.title)}</h3><p ${sw('text')}>${esc(f.body)}</p></div>`;
  const step = (s, i) => `<div class="card" ${sw('box')}><div class="num" ${sw('box', 'Style')}>${i + 1}</div><h3 ${sw('text')}>${esc(s.title)}</h3><p ${sw('text')}>${esc(s.body)}</p></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(m.title)} (example page)</title>
<link rel="icon" href="data:,">
<style>${CSS}
</style>
${NOSCRIPT}
</head>
<body data-template="${esc(TEMPLATE_VERSION)}">
<header class="top" ${sw('box')}><div class="wrap"><div class="brand" ${sw('text')}>${esc(m.title)}</div><div class="tag" ${sw('text')}>Example page</div></div></header>
<main>
<section class="hero" ${sw('box')}><div class="wrap">
<div>
<span class="badge" ${sw('text')}>${esc(c.badge)}</span>
<h1 ${sw('text')}>${esc(c.headline)}</h1>
<p class="sub" ${sw('text')}>${esc(c.sub)}</p>
<button class="cta" type="button" aria-disabled="true" ${sw('button')}>${esc(c.cta)}</button>
</div>
<div class="media" aria-hidden="true" ${sw('media')}><i></i><i></i><i></i><i></i></div>
</div></section>
<section class="block" ${sw('box')}><div class="wrap">
<h2 ${sw('text')}>What it would do</h2>
<div class="grid">${c.features.map(feature).join('')}</div>
</div></section>
<section class="block steps" ${sw('box')}><div class="wrap">
<h2 ${sw('text')}>How it would work</h2>
<div class="rail" ${sw('line')}></div>
<div class="grid">${c.steps.map(step).join('')}</div>
</div></section>
<section class="block" ${sw('box')}><div class="wrap">
<div class="council" ${sw('box', 'Check')}>
<p ${sw('text', 'Check')}>The council scored this ${score} out of 100: ${verdict}</p>${m.override ? `\n<p class="own" ${sw('text', 'Check')}>Built on the owner&#39;s call. The council said ${verdict}.</p>` : ''}
</div>
</div></section>
</main>
<footer ${sw('box')}><div class="wrap">
<p class="note" ${sw('text', 'Check')}>Example page written by AutoNEAR agents from stored evidence. Not a live service.</p>
<p ${sw('text')}>Built ${esc(dateOf(m.builtAt))}${m.model ? ` with ${esc(clip(m.model, 60))}` : ''}.</p>
${evidence ? `<p ${sw('text')}>Evidence it was written from:</p>\n<ul ${sw('box')}>${evidence}</ul>` : ''}
<p class="mono" ${sw('text')}>Version ${hash}</p>
</div></footer>
<script src="/swarm.js" defer></script>
</body>
</html>
`;
}
