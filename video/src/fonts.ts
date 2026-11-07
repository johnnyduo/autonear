import { continueRender, delayRender, staticFile } from 'remotion';

const faces: [string, string, FontFaceDescriptors][] = [
  ['Instrument Serif', 'fonts/instrument-serif-latin-400-normal.woff2', { weight: '400', style: 'normal' }],
  ['Instrument Serif', 'fonts/instrument-serif-latin-400-italic.woff2', { weight: '400', style: 'italic' }],
  ['Inter Tight', 'fonts/inter-tight-latin-wght-normal.woff2', { weight: '100 900', style: 'normal' }],
  ['Anybody', 'fonts/anybody-latin-wdth-normal.woff2', { weight: '100 900', style: 'normal', stretch: '50% 150%' }],
  ['JetBrains Mono', 'fonts/jetbrains-mono-latin-wght-normal.woff2', { weight: '100 800', style: 'normal' }],
];

let started = false;
export function loadFonts() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('Loading fonts');
  Promise.all(faces.map(([family, file, d]) => new FontFace(family, `url(${staticFile(file)})`, d).load().then((f) => (document.fonts as any).add(f))))
    .then(() => continueRender(handle))
    .catch((e) => { console.error('font load failed', e); continueRender(handle); });
}
