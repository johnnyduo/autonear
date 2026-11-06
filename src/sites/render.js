// Pure renderer: content JSON + meta -> one HTML page. Same input, same bytes. Every dynamic string is escaped here, nowhere else.
// Markup contract with /swarm.js: each buildable element has data-sw="box|text|button|line|media" and optionally data-sw-agent="Copy|Layout|Style|Media|Check".
// Document order is build order and parents come before children.
// Scripts: /swarm.js (replay), /mark.js (canvas hero mark), /contract-sim.js (the limits simulation). All static files of ours, no inline script, no handler attributes.
import { createHash } from 'node:crypto';
import { seedOf, markParams, spherePoints, rotX, rotY, rotZ, project, ringPoint, arcPoint, mixColor } from '../../web/src/app/mark-core.js';

export const TEMPLATE_VERSION = 'v2';
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

// ---- the hero mark as a still SVG (the canvas in /mark.js draws the same scene and replaces it once it has drawn) --------------------------
const n1 = (v) => String(Math.round(v * 10) / 10);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function markSvg(hash) {
  const params = markParams(seedOf(hash));
  const S = 200 * 0.255; const yaw = 0.55; const view = (p) => rotX(rotY(p, yaw), 0.12);
  const at = (q) => `${n1(q[0] * S)} ${n1(-q[1] * S)}`;
  const buckets = [[], [], [], []];
  for (const p0 of spherePoints(150, params)) {
    const p = view(rotZ(rotX(rotY(p0, 1.1), params.tiltX), params.tiltZ)); const q = project(p, 5);
    const lit = Math.max(0, p[0] * -0.42 + p[1] * 0.5 + p[2] * 0.76);
    const v = Math.min(0.999, 0.62 * ((p[2] + 1) / 2) + 0.38 * lit);
    buckets[Math.floor(v * 4)].push(`M${at(q)}h0`);
  }
  const dots = buckets.map((b, i) => (b.length ? `<path d="${b.join('')}" stroke="${rgb(mixColor(((i + 0.5) / 4) * 1.15 - 0.05))}" stroke-width="${n1(1 + i * 0.4)}" opacity="${n1(0.25 + 0.25 * i)}"/>` : '')).join('');
  const rings = params.rings.map((ring, k) => {
    const front = []; const back = [];
    for (let j = 0; j < 64; j++) { const p = view(ringPoint(ring, (j / 64) * Math.PI * 2 + ring.phase)); (p[2] >= 0 ? front : back).push(`M${at(project(p, 5))}h0`); }
    const c = rgb(mixColor(k === 0 ? 0.2 : 0.45));
    return `<path d="${back.join('')}" stroke="${c}" stroke-width="0.8" opacity="0.22"/><path d="${front.join('')}" stroke="${c}" stroke-width="0.9" opacity="0.55"/>`;
  }).join('');
  const arcs = params.arcs.slice(0, 2).map((a) => {
    const pts = []; for (let j = 0; j <= 14; j++) pts.push(at(project(view(rotZ(rotX(rotY(arcPoint(a.a, a.b, 0.15 + (0.7 * j) / 14, 0.3), 1.1), params.tiltX), params.tiltZ)), 5)));
    return `<path d="M${pts.join('L')}" fill="none" stroke="rgb(198,244,50)" stroke-width="0.5" opacity="0.6"/>`;
  }).join('');
  const nodes = params.nodes.slice(0, 3).map((nd) => { const q = project(view(ringPoint(params.rings[nd.ring], nd.phase)), 5); return `<circle cx="${n1(q[0] * S)}" cy="${n1(-q[1] * S)}" r="${n1(1.1 * nd.size / 2.2)}" fill="rgb(236,250,190)"/>`; }).join('');
  return `<svg class="mark-fb" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false"><g fill="none" stroke-linecap="round">${dots}${rings}${arcs}</g>${nodes}</svg>`;
}

// ---- card icons: six abstract shapes, drawn here ----------------------------------------------------------------------------------------
const ICONS = [
  '<rect x="7" y="7" width="18" height="18"/><rect x="15" y="15" width="18" height="18"/>',
  '<circle cx="20" cy="20" r="13"/><path d="M3 20h34"/><circle cx="20" cy="20" r="2.5" fill="currentColor"/>',
  '<rect x="6" y="7" width="9" height="9"/><path d="M21 11.5h13M6 24h28M6 32h19"/>',
  '<circle cx="20" cy="20" r="14"/><path d="M20 10l9 16H11z"/>',
  '<circle cx="12" cy="12" r="5"/><circle cx="28" cy="12" r="5"/><circle cx="12" cy="28" r="5"/><circle cx="28" cy="28" r="5" fill="currentColor"/>',
  '<path d="M6 30a14 14 0 0 1 28 0"/><path d="M6 30h28"/><circle cx="20" cy="15" r="3"/>',
];
const icon = (i) => `<svg class="icon" viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false">${ICONS[i % ICONS.length]}</svg>`;

// ---- the contract sketch: names and sentences come from the model, the signatures are composed here -------------------------------------
const camel = (s) => String(s ?? '').split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;
function codeLines(contract) {
  const ct = contract && typeof contract === 'object' ? contract : {};
  const methods = Array.isArray(ct.methods) ? ct.methods : [];
  const name = camel(ct.name);
  const lines = [`${span('k', 'pub')} ${span('k', 'struct')} ${span('t', name)}${span('p', ';')}`, '', `${span('k', 'impl')} ${span('t', name)} ${span('p', '{')}`];
  for (const m of methods) {
    const args = (Array.isArray(m?.args) ? m.args : []).map((a) => `${span('n', a?.name)}${span('p', ':')} ${span('t', a?.type)}`);
    const sig = [`${span('p', '&')}${span('k', 'mut')} ${span('k', 'self')}`, ...args].join(`${span('p', ',')} `);
    const ret = m?.returns && m.returns !== 'none' ? ` ${span('p', '->')} ${span('t', m.returns)}` : '';
    lines.push(`    ${span('c', `// ${m?.does ?? ''}`)}`, `    ${span('k', 'pub')} ${span('k', 'fn')} ${span('n', m?.name)}${span('p', '(')}${sig}${span('p', ')')}${ret}${span('p', ';')}`);
  }
  lines.push(span('p', '}'));
  return lines.map((l) => (l ? `<span class="l" ${sw('text')}>${l}</span>` : '<span class="l"></span>')).join('');
}

// ---- path to production ---------------------------------------------------------------------------------------------------------------
const PATH_STEPS = [
  ['contract', 'Contract written and tested'],
  ['build', 'Build attested'],
  ['approval', 'Deploy request approved by the owner'],
  ['testnet', 'Running on NEAR testnet through the vault'],
];
const STATES = { done: 'DONE', next: 'NEXT', later: 'LATER' };
function pathRows(path) {
  const list = Array.isArray(path) ? path : [];
  return PATH_STEPS.map(([key, title], i) => {
    const it = list.find((x) => x && x.key === key);
    const state = it && STATES[it.state] ? it.state : 'later';
    const note = it ? it.note : 'The status of this step is not available for this page.';
    return `<li class="p-row ${state}" ${sw('box')}><span class="p-no">${String(i + 1).padStart(2, '0')}</span><div class="p-body"><h3 ${sw('text')}>${esc(title)}</h3><p ${sw('text')}>${esc(note)}</p></div><span class="p-state">${STATES[state]}</span></li>`;
  }).join('');
}

const CSS = `
:root{color-scheme:dark;--bg:#0b0e11;--bg2:#0e1317;--panel:#11161b;--code:#0a0d10;--line:#222a32;--line2:#33404b;--text:#ece9e1;--muted:#a3acb4;--dim:#838d97;--accent:#c6f432;--blue:#7fb6cf;--amber:#f2b84b;--mint:#59ffd1;--rose:#ff6b8b;--ink:#0b0e11;--display:Georgia,'Times New Roman',serif;--sans:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.2,.7,.2,1)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:84px}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:0 32px}
.mono{font-family:var(--mono)}

header.top{position:sticky;top:0;z-index:30;background:rgba(11,14,17,.72);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.brand{font:700 19px/1.2 var(--display);letter-spacing:.005em;overflow-wrap:anywhere}
.chip{font:500 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--blue);border:1px solid rgba(127,182,207,.55);border-radius:999px;padding:6px 11px;white-space:nowrap}

.hero{position:relative;isolation:isolate;overflow:hidden;padding:104px 0 120px}
.hero::before{content:'';position:absolute;inset:0;z-index:-1;background-image:linear-gradient(rgba(236,233,225,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(236,233,225,.05) 1px,transparent 1px);background-size:72px 72px;-webkit-mask-image:radial-gradient(ellipse 65% 75% at 70% 45%,#000,transparent 78%);mask-image:radial-gradient(ellipse 65% 75% at 70% 45%,#000,transparent 78%)}
.hero::after{content:'';position:absolute;z-index:-1;right:-8%;top:-25%;width:72%;height:150%;background:radial-gradient(closest-side,rgba(127,182,207,.14),rgba(127,182,207,.04) 55%,transparent 75%)}
.hero .wrap{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(0,.98fr);gap:56px;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:500 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.eyebrow::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px rgba(198,244,50,.7)}
h1{font:400 clamp(38px,5vw,66px)/1.02 var(--display);letter-spacing:-.022em;margin:26px 0 24px;overflow-wrap:anywhere;text-wrap:balance}
.sub{font-size:clamp(17px,1.5vw,20px);line-height:1.55;color:var(--muted);margin:0 0 38px;max-width:31em;overflow-wrap:anywhere}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:14px 30px}
.btn{display:inline-flex;align-items:center;justify-content:center;appearance:none;border:0;background:var(--accent);color:var(--ink);font:600 15px/1 var(--sans);letter-spacing:.01em;padding:16px 28px;border-radius:999px;cursor:pointer;text-decoration:none;transition:transform .22s var(--ease),box-shadow .22s var(--ease),background-color .22s}
.btn:hover{transform:translateY(-2px);background:#d4ff4a;box-shadow:0 10px 34px rgba(198,244,50,.28)}
.btn:active{transform:translateY(0)}
.btn[disabled]{opacity:.55;cursor:default;transform:none;box-shadow:none}
.btn.sm{padding:13px 22px;font-size:14px}
.ghost{font:500 14px/1.2 var(--sans);color:var(--text);text-decoration:none;padding:6px 0;background:linear-gradient(var(--accent),var(--accent)) 0 100%/100% 1px no-repeat;transition:background-size .22s var(--ease),color .22s}
.ghost:hover{background-size:100% 3px;color:#fff}
.mark-box{position:relative}
.mark{position:relative;width:100%;max-width:620px;margin-left:auto;aspect-ratio:1/1;-webkit-mask-image:radial-gradient(closest-side,#000 72%,transparent 100%);mask-image:radial-gradient(closest-side,#000 72%,transparent 100%)}
.mark canvas,.mark .mark-fb{position:absolute;inset:0;width:100%;height:100%;display:block}
.mark canvas{cursor:grab;touch-action:pan-y}
.mark canvas.is-drag{cursor:grabbing}
.mark-fb{transition:opacity .5s ease}
.mark.is-live .mark-fb{opacity:0}
html.sw-on .mark-fb{visibility:hidden}
.mark-cap{position:absolute;left:0;bottom:-6px;font:11px/1.4 var(--mono);letter-spacing:.06em;color:var(--dim)}

.sec{padding:112px 0;border-top:1px solid var(--line)}
.sec.alt{background:linear-gradient(180deg,var(--bg2),var(--bg))}
.kick{display:flex;align-items:center;gap:14px;font:500 12px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--blue);margin:0 0 20px}
.kick::before{content:'';width:28px;height:1px;background:var(--blue)}
h2{font:400 clamp(30px,3.6vw,48px)/1.1 var(--display);letter-spacing:-.015em;margin:0 0 16px;max-width:20em;text-wrap:balance}
.lead{color:var(--muted);font-size:17px;max-width:38em;margin:0 0 56px}
h3{margin:0}

.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,0) 60%),var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px 30px 34px;transition:transform .24s var(--ease),border-color .24s,box-shadow .24s}
.cards .card:hover{transform:translateY(-4px);border-color:rgba(198,244,50,.55);box-shadow:0 18px 50px rgba(0,0,0,.35),0 0 0 1px rgba(198,244,50,.12)}
.icon{display:block;color:var(--accent);margin-bottom:34px}
.card h3{font:400 24px/1.2 var(--display);letter-spacing:-.005em;margin:0 0 12px;overflow-wrap:anywhere}
.card p{margin:0;color:var(--muted);overflow-wrap:anywhere}

.flow{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px}
.flow .rail{position:absolute;left:22px;right:calc(100% / 3 - 49px);top:22px;height:1px;background:linear-gradient(90deg,var(--accent),var(--line2) 45%,var(--line))}
.step{position:relative}
.node{position:relative;z-index:1;width:44px;height:44px;border-radius:50%;background:var(--bg);border:1px solid var(--accent);display:grid;place-items:center;font:500 12px/1 var(--mono);letter-spacing:.08em;color:var(--accent)}
.step h3{font:400 24px/1.2 var(--display);margin:28px 0 10px;overflow-wrap:anywhere}
.step p{margin:0;color:var(--muted);max-width:22em;overflow-wrap:anywhere}

.chain{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(0,1fr);gap:20px;align-items:start}
.chain .card{padding:28px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 18px}
.card-head h3{font:500 12px/1.4 var(--mono);letter-spacing:.06em;color:var(--muted)}
.card-head .tag{font:500 10.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);white-space:nowrap}
.code{margin:0;background:var(--code);border:1px solid var(--line);border-radius:12px;padding:20px 22px;overflow-x:auto;font:12px/1.85 var(--mono);color:var(--text);tab-size:4}
.code .l{display:block;white-space:pre;min-height:1.85em}
.code .k{color:var(--accent)}.code .t{color:var(--blue)}.code .n{color:var(--text)}.code .c{color:var(--dim)}.code .p{color:#8f99a3}
.note{font:11.5px/1.5 var(--mono);letter-spacing:.03em;color:var(--dim);margin:16px 0 0}
.sim h3.title{font:400 24px/1.2 var(--display);margin:0 0 10px;color:var(--text)}
.sim .lead{font-size:15px;margin:0 0 22px}
.field{margin:0 0 18px}
.field label,.allow legend{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 9px;padding:0}
.field output{color:var(--text);letter-spacing:.04em}
select,input[type=number]{width:100%;appearance:none;-webkit-appearance:none;background:var(--code);color:var(--text);border:1px solid var(--line2);border-radius:10px;padding:11px 14px;font:14px/1.3 var(--mono);transition:border-color .2s,box-shadow .2s}
select{background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat;padding-right:36px;cursor:pointer}
select:hover,input[type=number]:hover{border-color:var(--blue)}
input[type=range]{width:100%;margin:6px 0;background:transparent;appearance:none;-webkit-appearance:none;height:20px;cursor:pointer}
input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--line2);border-radius:2px}
input[type=range]::-moz-range-track{height:2px;background:var(--line2);border-radius:2px}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-7px;border-radius:50%;background:var(--accent);border:0;box-shadow:0 0 0 4px rgba(198,244,50,.15);transition:box-shadow .2s}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--accent);border:0;box-shadow:0 0 0 4px rgba(198,244,50,.15)}
input[type=range]:hover::-webkit-slider-thumb{box-shadow:0 0 0 7px rgba(198,244,50,.18)}
.allow{border:0;margin:0 0 18px;padding:0;min-width:0}
.allow .opts{display:flex;flex-wrap:wrap;gap:8px}
.allow label{display:inline-flex;align-items:center;gap:0;margin:0;cursor:pointer;position:relative}
.allow input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.allow span{font:12px/1 var(--mono);letter-spacing:0;text-transform:none;color:var(--dim);border:1px solid var(--line2);border-radius:999px;padding:8px 12px;transition:color .2s,border-color .2s,background-color .2s}
.allow input:checked+span{color:var(--text);border-color:rgba(198,244,50,.6);background:rgba(198,244,50,.08)}
.allow input:focus-visible+span{outline:2px solid var(--blue);outline-offset:3px}
.allow label:hover span{border-color:var(--blue)}
.period{display:flex;align-items:center;gap:12px;margin:0 0 22px;font:11.5px/1 var(--mono);color:var(--muted)}
.period .bar{flex:0 0 72px;height:4px;border-radius:4px;background:var(--line2);overflow:hidden}
.period .bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s var(--ease)}
.linkbtn{appearance:none;background:none;border:0;padding:4px 0;margin-left:auto;font:11.5px/1 var(--mono);color:var(--blue);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.linkbtn:hover{color:#a8d3e6}
.log{margin:18px 0 0;min-height:176px;max-height:240px;overflow-y:auto;background:var(--code);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font:12px/1.7 var(--mono)}
.log:empty::before{content:'Nothing has run yet. The steps appear here.';color:var(--dim)}
.sim-line{display:flex;gap:12px}
.sim-tag{flex:0 0 78px;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.sim-line.ok .sim-tag{color:var(--mint)}.sim-line.no .sim-tag{color:var(--rose)}
.sim-text{color:var(--muted);overflow-wrap:anywhere}
.sim-line.done{margin-top:6px;padding-top:8px;border-top:1px solid var(--line)}
.sim-line.done .sim-tag{font-weight:700}
.sim-line.done .sim-text{color:var(--text)}

.path{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.p-row{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:20px;align-items:start;padding:28px 0;border-bottom:1px solid var(--line)}
.p-no{font:500 12px/2 var(--mono);letter-spacing:.1em;color:var(--dim)}
.p-body h3{font:400 22px/1.25 var(--display);margin:0 0 8px}
.p-body p{margin:0;color:var(--muted);max-width:44em}
.p-state{font:500 11px/1 var(--mono);letter-spacing:.16em;padding:7px 12px;border-radius:999px;border:1px solid var(--line2);color:var(--dim);margin-top:2px}
.p-row.done .p-state{color:var(--mint);border-color:rgba(89,255,209,.5);background:rgba(89,255,209,.07)}
.p-row.next .p-state{color:var(--amber);border-color:rgba(242,184,75,.55);background:rgba(242,184,75,.07)}
.p-row.done .p-no{color:var(--mint)}.p-row.next .p-no{color:var(--amber)}

.council{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,420px);gap:28px 56px;align-items:center;padding:30px 32px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
.council p{margin:0}
.council .own{margin-top:8px;color:var(--muted);font-size:14px}
.council .said{font:400 22px/1.3 var(--display)}
.gauge{position:relative;height:34px}
.gauge .track{position:absolute;left:0;right:0;top:8px;height:6px;border-radius:6px;background:var(--line2)}
.gauge .fill{position:absolute;left:0;top:8px;height:6px;border-radius:6px;background:linear-gradient(90deg,var(--blue),var(--accent))}
.gauge .tick.w b{left:auto;right:6px}
.gauge .tick{position:absolute;top:2px;width:1px;height:18px;background:var(--text);opacity:.55}
.gauge .tick b{position:absolute;top:22px;left:6px;font:500 10.5px/1 var(--mono);letter-spacing:.1em;color:var(--dim);white-space:nowrap}

footer{border-top:1px solid var(--line);padding:56px 0 64px;color:var(--muted);font-size:14px}
footer .wrap{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:32px 56px}
footer p{margin:0 0 10px}
footer .concept{font:400 21px/1.4 var(--display);color:var(--text);max-width:24em}
footer .meta{font:12px/1.7 var(--mono);color:var(--muted)}
footer .meta a{color:var(--text);text-underline-offset:3px}
footer .meta a:hover{color:var(--accent)}
.chips{list-style:none;margin:6px 0 14px;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.chips li{border:1px solid var(--line2);border-radius:999px;padding:6px 12px;font:11.5px/1.3 var(--mono);color:var(--muted);transition:border-color .2s,color .2s}
.chips li:hover{border-color:var(--blue)}
.chips a{text-decoration:none}.chips a:hover{color:var(--text)}

@media (min-width:1101px){.chain>.card:first-child{position:sticky;top:96px}}
@media (max-width:1100px){.chain{grid-template-columns:minmax(0,1fr)}}
@media (max-width:1024px){.hero .wrap{gap:36px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.council{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){
.wrap{padding:0 20px}
.hero{padding:56px 0 72px}.hero .wrap{grid-template-columns:minmax(0,1fr)}.mark{max-width:420px;margin:0 auto}.mark-cap{left:50%;transform:translateX(-50%);white-space:nowrap}
.sec{padding:72px 0}.lead{margin-bottom:40px}
.cards{grid-template-columns:minmax(0,1fr)}.card{padding:26px 24px 28px}
.flow{grid-template-columns:minmax(0,1fr);gap:34px}.flow .rail{left:22px;right:auto;top:22px;bottom:22px;width:1px;height:auto;background:linear-gradient(180deg,var(--accent),var(--line2) 45%,var(--line))}
.step{padding-left:70px;min-height:44px}.step .node{position:absolute;left:0;top:0}.step h3{margin:6px 0 8px}
.p-row{grid-template-columns:40px minmax(0,1fr);gap:12px 14px}.p-state{grid-column:2;justify-self:start}
.council{padding:24px 22px}
footer .wrap{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important;transition:none!important}}`;

const NOSCRIPT = '<noscript><style>[data-sw]{opacity:1!important;visibility:visible!important;transform:none!important}</style></noscript>';

const httpUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dateOf = (ms) => { const d = new Date(Number(ms)); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown date'; };
const VERDICT = { go: 'GO', watch: 'WATCH', drop: 'DROP' };

/**
 * @param {{content:{badge,headline,sub,features:{title,body}[],steps:{title,body}[],cta,contract:{name,methods:{name,args:{name,type}[],returns,does}[]}}, meta:{slug,title,verdict,support,builtAt,hash,override,model,evidence:{title,url?}[],path?:{key,state,note}[]}}} a
 * @returns {string} a full HTML document
 */
export function renderSite({ content, meta }) {
  const c = content; const m = meta ?? {};
  const score = Math.round(Math.min(1, Math.max(0, Number(m.support) || 0)) * 100);
  const verdict = VERDICT[m.verdict] ?? esc(String(m.verdict ?? '').toUpperCase());
  const hash = esc(String(m.hash ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 10));
  const seed = String(m.hash ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 10);
  const evidence = (Array.isArray(m.evidence) ? m.evidence : []).slice(0, 6).map((e) => {
    const title = esc(clip(e?.title, 60)); const href = httpUrl(e?.url);
    return `<li>${href ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>` : title}</li>`;
  }).join('');
  const base = seedOf(seed) % 6;
  const feature = (f, i) => `<div class="card" ${sw('box')}>${icon(base + 2 * i)}<h3 ${sw('text')}>${esc(f.title)}</h3><p ${sw('text')}>${esc(f.body)}</p></div>`;
  const step = (s, i) => `<div class="step"><div class="node" ${sw('box', 'Style')}>${String(i + 1).padStart(2, '0')}</div><h3 ${sw('text')}>${esc(s.title)}</h3><p ${sw('text')}>${esc(s.body)}</p></div>`;
  const methods = Array.isArray(c.contract?.methods) ? c.contract.methods : [];
  const methodOpts = methods.map((x) => `<option value="${esc(x?.name)}">${esc(x?.name)}</option>`).join('');
  const allowOpts = methods.map((x) => `<label><input type="checkbox" data-sim="allow" value="${esc(x?.name)}" checked><span>${esc(x?.name)}</span></label>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(m.title)} · concept</title>
<link rel="icon" href="data:,">
<style>${CSS}
</style>
${NOSCRIPT}
</head>
<body data-template="${esc(TEMPLATE_VERSION)}">
<header class="top" ${sw('box')}><div class="wrap"><div class="brand" ${sw('text')}>${esc(m.title)}</div><div class="chip" ${sw('text')}>Concept</div></div></header>
<main>
<section class="hero" ${sw('box')}><div class="wrap">
<div>
<span class="eyebrow" ${sw('text')}>${esc(c.badge)}</span>
<h1 ${sw('text')}>${esc(c.headline)}</h1>
<p class="sub" ${sw('text')}>${esc(c.sub)}</p>
<div class="actions"><a class="btn" href="#how" ${sw('button')}>${esc(c.cta)}</a><a class="ghost" href="#contract" ${sw('text')}>See the contract</a></div>
</div>
<div class="mark-box"><div class="mark">${markSvg(seed)}<canvas data-mark data-seed="${hash}" aria-hidden="true" ${sw('media')}></canvas></div><div class="mark-cap" ${sw('text')}>Mark drawn from version ${hash}</div></div>
</div></section>
<section class="sec" ${sw('box')}><div class="wrap">
<p class="kick" ${sw('text')}>The idea</p>
<h2 ${sw('text')}>What it would do</h2>
<div class="cards">${c.features.map(feature).join('')}</div>
</div></section>
<section class="sec alt" id="how" ${sw('box')}><div class="wrap">
<p class="kick" ${sw('text')}>The flow</p>
<h2 ${sw('text')}>How it would work</h2>
<div class="flow"><div class="rail" ${sw('line')}></div>${c.steps.map(step).join('')}</div>
</div></section>
<section class="sec" id="contract" ${sw('box')}><div class="wrap">
<p class="kick" ${sw('text')}>On-chain</p>
<h2 ${sw('text')}>The contract it would need</h2>
<p class="lead" ${sw('text')}>A sketch of the interface this product would put on NEAR, and a way to try the limits it would enforce.</p>
<div class="chain">
<div class="card" ${sw('box')}>
<div class="card-head"><h3 ${sw('text')}>Interface sketch (not audited, not deployed)</h3><span class="tag">Rust, NEAR</span></div>
<pre class="code" tabindex="0" aria-label="Interface sketch"><code>${codeLines(c.contract)}</code></pre>
<p class="note" ${sw('text')}>A sketch for this concept. No code exists behind it.</p>
</div>
<div class="card sim" ${sw('box')}>
<h3 class="title" ${sw('text')}>Try the limits</h3>
<p class="lead" ${sw('text')}>Pick a method and an amount, set the caps, then run the call against the rules this contract would enforce.</p>
<form data-sim="form" autocomplete="off" novalidate>
<div class="field"><label for="sim-method">Method</label><select id="sim-method" data-sim="method">${methodOpts}</select></div>
<fieldset class="allow"><legend>On the allowlist</legend><div class="opts">${allowOpts}</div></fieldset>
<div class="field"><label for="sim-amount">Amount <span>units</span></label><input id="sim-amount" data-sim="amount" type="number" inputmode="numeric" min="1" step="1" value="120"></div>
<div class="field"><label for="sim-call">Per-call cap <output data-sim="percall-out">200</output></label><input id="sim-call" data-sim="percall" type="range" min="0" max="1000" step="10" value="200"></div>
<div class="field"><label for="sim-period">Per-period cap <output data-sim="perperiod-out">500</output></label><input id="sim-period" data-sim="perperiod" type="range" min="0" max="2000" step="50" value="500"></div>
<div class="period"><span class="bar"><i data-sim="meter"></i></span><span data-sim="spent">0 of 500 used this period</span><button class="linkbtn" type="button" data-sim="reset">Reset</button></div>
<button class="btn sm" type="submit" data-sim="run" ${sw('button')}>Run the call</button>
<div class="log" data-sim="log" role="log" aria-live="polite"></div>
</form>
<p class="note" ${sw('text')}>Simulation in your browser. Nothing is sent to any network.</p>
</div>
</div>
</div></section>
<section class="sec alt" id="path" ${sw('box')}><div class="wrap">
<p class="kick" ${sw('text')}>Path to production</p>
<h2 ${sw('text')}>What it takes to make this real</h2>
<p class="lead" ${sw('text')}>Each step is read from what AutoNEAR has stored for this product. Nothing here is an estimate.</p>
<ol class="path">${pathRows(m.path)}</ol>
</div></section>
<section class="sec" ${sw('box')}><div class="wrap">
<div class="council" ${sw('box', 'Check')}>
<div>
<p class="said" ${sw('text', 'Check')}>The council scored this ${score} out of 100: ${verdict}</p>${m.override ? `\n<p class="own" ${sw('text', 'Check')}>Built on the owner&#39;s call. The council said ${verdict}.</p>` : ''}
</div>
<div class="gauge" role="img" aria-label="Score ${score} out of 100. Watch from 48, go from 62." ${sw('line', 'Check')}><div class="track"></div><div class="fill" style="width:${score}%"></div><div class="tick w" style="left:48%"><b>WATCH 48</b></div><div class="tick" style="left:62%"><b>GO 62</b></div></div>
</div>
</div></section>
</main>
<footer ${sw('box')}><div class="wrap">
<div>
<p class="concept" ${sw('text', 'Check')}>Concept written by AutoNEAR agents from stored evidence. Not a live service.</p>
</div>
<div class="meta">
<p ${sw('text')}>Built ${esc(dateOf(m.builtAt))}${m.model ? ` with ${esc(clip(m.model, 60))}` : ''}.</p>
${evidence ? `<p ${sw('text')}>Evidence it was written from</p>\n<ul class="chips" ${sw('box')}>${evidence}</ul>` : ''}
<p ${sw('text')}>Version ${hash}</p>
<p><a href="/">AutoNEAR project</a></p>
</div>
</div></footer>
<script src="/swarm.js" defer></script>
<script src="/mark.js" defer></script>
<script src="/contract-sim.js" defer></script>
</body>
</html>
`;
}
