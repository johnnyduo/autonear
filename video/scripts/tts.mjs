// Narration: Gemini TTS per scene -> video/public/audio/<id>.mp3 + src/data/timing.json (durations drive the picture).
//   GEMINI_API_KEY=... node scripts/tts.mjs            real narration (Gemini)
//   node scripts/tts.mjs --scratch                       macOS `say` placeholder so layout/timing can be built before a key exists
// Options: --force (ignore cache)  --voice=Puck  --model=<id>
// Key lookup: process.env.GEMINI_API_KEY, else video/.env (untracked). Never printed, never committed.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { display, spoken } from '../src/lib/narration.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => process.argv.includes(`--${n}`);

function loadEnvFile() {
  const p = resolve(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

const script = JSON.parse(readFileSync(resolve(root, 'script/script.json'), 'utf8'));
const data = JSON.parse(readFileSync(resolve(root, 'src/data/captured.json'), 'utf8'));
const audioDir = resolve(root, 'public/audio');
mkdirSync(audioDir, { recursive: true });
const timingPath = resolve(root, 'src/data/timing.json');
const prev = existsSync(timingPath) ? JSON.parse(readFileSync(timingPath, 'utf8')) : { scenes: [] };

const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const scratch = flag('scratch') || !key;
if (scratch && !flag('scratch')) console.warn('! No GEMINI_API_KEY found: producing SCRATCH narration with macOS `say`. Set the key and rerun for the real voice.');
const voice = arg('voice') || process.env.GEMINI_TTS_VOICE || script.voice.name;
const style = script.voice.style;
const API = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta'; // GEMINI_API_BASE is for tests only

// Model candidates, best first. 3.x models speak the Interactions API (style is a separate field, text is a verbatim transcript);
// 2.5 previews use generateContent. Override with --model= or GEMINI_TTS_MODEL. The first candidate that answers is used for every scene.
const CANDIDATES = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts'];
const isInteractions = (m) => /^gemini-3\./.test(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const styleShort = style.split('.')[0];

async function post(url, body) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const txt = (await r.text()).slice(0, 400);
    if (r.status === 429 && /per day/i.test(txt)) { const e = new Error(`HTTP 429 (daily quota): ${txt}`); e.status = 429; e.daily = true; throw e; }
    if ([429, 500, 503].includes(r.status) && attempt < 8) {
      // Free tier is ~3 requests/min: honour the server's "retry in Ns" hint.
      const hint = Number(/retry in (\d+(?:\.\d+)?)s/i.exec(txt)?.[1]);
      const wait = r.status === 429 && hint ? (hint + 2) * 1000 : 1500 * attempt ** 2;
      console.warn(`  HTTP ${r.status}, waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`);
      await sleep(wait); continue;
    }
    const e = new Error(`HTTP ${r.status}: ${txt}`); e.status = r.status; throw e;
  }
}

/** -> { file, kind: 'wav' | 's16le', rate } written to audioDir */
async function synth(model, text, outBase) {
  if (isInteractions(model)) {
    const j = await post(`${API}/interactions`, {
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: styleShort }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    });
    const audio = (j.steps ?? []).filter((x) => x.type === 'model_output').flatMap((x) => x.content ?? []).filter((c) => c.type === 'audio').at(-1);
    if (!audio?.data) throw new Error(`No audio in Interactions response: ${JSON.stringify(j).slice(0, 300)}`);
    const file = `${outBase}.wav`;
    writeFileSync(file, Buffer.from(audio.data, 'base64'));
    return { file, kind: 'wav' };
  }
  const j = await post(`${API}/models/${model}:generateContent`, {
    contents: [{ parts: [{ text: `Say in this style (do not read these instructions aloud): ${style}\n\n${text}` }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error(`No audio in response: ${JSON.stringify(j).slice(0, 300)}`);
  const file = `${outBase}.pcm`;
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  return { file, kind: 's16le', rate: Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000) };
}

let chosenModel = null;
async function synthWithFallback(text, outBase) {
  const override = arg('model') || process.env.GEMINI_TTS_MODEL;
  const list = override ? [override] : chosenModel ? [chosenModel, ...CANDIDATES.filter((m) => m !== chosenModel)] : CANDIDATES;
  let lastErr;
  for (const m of list) {
    try { const r = await synth(m, text, outBase); chosenModel = m; return { ...r, model: m }; }
    catch (e) { lastErr = e; if (![400, 403, 404].includes(e.status) && !e.daily) throw e; console.warn(`  model ${m} unavailable (${e.message.slice(0, 120)}); trying next`); }
  }
  throw lastErr;
}

const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

// Real speech boundaries from the audio itself (used to calibrate caption / animation timing).
function analyze(mp3, dur) {
  const need = (display(script.scenes.find((x) => mp3.endsWith(x.id + '.mp3')).narration, data).match(/[.!?](\s|$)/g) ?? []).length - 1;
  let r;
  for (const [noise, d] of [['-35dB', '0.14'], ['-32dB', '0.09'], ['-28dB', '0.06']]) {
    r = spawnSync('ffmpeg', ['-hide_banner', '-i', mp3, '-af', `silencedetect=noise=${noise}:d=${d}`, '-f', 'null', '-'], { encoding: 'utf8' });
    if ((r.stderr.match(/silence_start/g) ?? []).length >= need + 1) break; // enough pauses to match every sentence boundary
  }
  const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const sil = starts.map((st, i) => ({ start: st, end: ends[i] ?? dur }));
  const lead = sil.find((p) => p.start < 0.05);
  const tail = sil.find((p) => p.end >= dur - 0.05 && p.start > dur / 2);
  const speech = { start: lead ? lead.end : 0, end: tail ? tail.start : dur };
  return { speech, pauses: sil.filter((p) => p !== lead && p !== tail).map((p) => ({ start: +p.start.toFixed(3), end: +p.end.toFixed(3) })) };
}

const hashModel = scratch ? 'macos-say' : (arg('model') || process.env.GEMINI_TTS_MODEL || 'auto');
let model = hashModel;
console.log(`mode=${scratch ? 'SCRATCH' : 'GEMINI'} model=${model} voice=${scratch ? 'Daniel' : voice}`);

const scenes = [];
for (const s of script.scenes) {
  const text = spoken(s.narration, data);
  const shown = display(s.narration, data);
  const mp3 = resolve(audioDir, `${s.id}.mp3`);
  const hash = createHash('sha256').update(JSON.stringify([hashModel, scratch ? 'Daniel' : voice, scratch ? '' : style, text])).digest('hex').slice(0, 16);
  const cached = prev.scenes.find((p) => p.id === s.id);
  if (!flag('force') && cached?.hash === hash && existsSync(mp3)) {
    console.log(`= ${s.id} (cached)`);
    scenes.push({ ...cached, spoken: text, display: shown, tag: s.tag ? display(s.tag, data) : null, cal: analyze(mp3, cached.durationSec) });
    continue;
  }
  if (scratch) {
    const aiff = resolve(audioDir, `${s.id}.aiff`);
    execFileSync('say', ['-v', 'Daniel', '-r', '178', '-o', aiff, text]);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-ar', '44100', '-b:a', '160k', mp3]);
    execFileSync('rm', ['-f', aiff]);
  } else {
    const r = await synthWithFallback(text, resolve(audioDir, s.id));
    model = r.model;
    const inArgs = r.kind === 'wav' ? ['-i', r.file] : ['-f', 's16le', '-ar', String(r.rate), '-ac', '1', '-i', r.file];
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...inArgs, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-ar', '44100', '-b:a', '192k', mp3]);
    execFileSync('rm', ['-f', r.file]);
  }
  const durationSec = probe(mp3);
  const words = text.split(/\s+/).length;
  const wps = words / durationSec;
  console.log(`+ ${s.id}: ${durationSec.toFixed(2)}s, ${words} words, ${wps.toFixed(2)} w/s`);
  if (!scratch && (wps < 1.6 || wps > 4)) console.warn(`  ! ${s.id}: ${wps.toFixed(2)} words/s is outside the normal 1.6-4 range; the style prompt may have been spoken aloud or truncated. Listen to public/audio/${s.id}.mp3.`);
  scenes.push({ id: s.id, hash, file: `audio/${s.id}.mp3`, durationSec, spoken: text, display: shown, tag: s.tag ? display(s.tag, data) : null, cal: analyze(mp3, durationSec) });
}

writeFileSync(timingPath, JSON.stringify({ mode: scratch ? 'scratch' : 'gemini', model, voice: scratch ? 'Daniel' : voice, generatedAt: new Date().toISOString(), scenes }, null, 2));
const total = scenes.reduce((a, s) => a + s.durationSec, 0);
console.log(`total narration ${total.toFixed(1)}s -> ${timingPath}`);
