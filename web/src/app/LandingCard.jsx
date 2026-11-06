// Landing card: an EXAMPLE of the council's score card. It cycles through made-up product ideas with a channel-change burst of TV static,
// then streams the text in. Nothing here is stored data; the real votes are on the Council page.
import { useEffect, useRef, useState } from 'react';
import { useCalm } from '../ui.jsx';
import { STORIES, scoreStory, councilFrom } from './landing-cards.js';

const CYCLE = 8200; const BURST = 460; const TYPE = 26; // ms per cycle, static burst, per character
const VERDICT = { go: ['GO', 'The council backs building this', '#c6f432'], watch: ['WATCH', 'Not strong enough to build yet', '#f2b84b'], drop: ['DROP', 'Not now', '#8c8b82'] };
const NEXT = { go: 'Next: the agent builds it, inside your limits.', watch: 'Next: keep watching. Nothing is built.', drop: 'Next: set aside.' };

function Snow({ amp }) { // canvas snow: strong during the burst, a faint hiss the rest of the time
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return undefined; const x = cv.getContext('2d'); const W = 160; const H = 120; cv.width = W; cv.height = H;
    const img = x.createImageData(W, H); let raf = 0; let last = 0;
    const draw = (t) => {
      raf = requestAnimationFrame(draw); const a = amp.current; if (t - last < (a > 0.3 ? 33 : 90)) return; last = t;
      const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = Math.random() < 0.55 ? 255 : 0; }
      x.putImageData(img, 0, 0);
      if (a > 0.3) { for (let k = 0; k < 4; k++) { x.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.4})`; x.fillRect(0, Math.random() * H, W, 1 + Math.random() * 3); } }
      cv.style.opacity = String(a);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [amp]);
  return <canvas ref={ref} className="lc-snow" aria-hidden="true" />;
}

export default function LandingCard({ onStory }) {
  const calm = useCalm();
  const order = useRef(null); if (!order.current) order.current = [...STORIES.keys()].sort(() => Math.random() - 0.5);
  const [n, setN] = useState(0); const [ms, setMs] = useState(calm ? 1e9 : BURST * 0.5 + 1);
  const amp = useRef(calm ? 0 : 0.06); const story = useRef(null);
  if (!story.current || story.current.n !== n) story.current = { n, ...scoreStory(STORIES[order.current[n % order.current.length]]) };

  useEffect(() => { onStory?.(councilFrom(story.current)); }, [n]); // eslint-disable-line react-hooks/exhaustive-deps -- the council star on the landing shows the same example

  useEffect(() => {
    if (calm) { const id = setInterval(() => setN((k) => k + 1), 9000); return () => clearInterval(id); }
    let raf = 0; let t0 = performance.now(); let last = 0; let swapped = false; let cur = n;
    const tick = (t) => {
      raf = requestAnimationFrame(tick); const e = t - t0;
      if (e >= CYCLE) { t0 = t; swapped = false; cur += 1; amp.current = 0.9; setMs(0); return; }
      if (e < BURST) amp.current = 0.9 * (1 - e / BURST) + 0.06;
      else amp.current = 0.06;
      if (!swapped && e >= BURST * 0.5) { swapped = true; setN(cur); }
      if (e < 3600 || e > CYCLE - 200) { if (t - last > 33) { last = t; setMs(Math.max(0, e)); } } else if (t - last > 600) { last = t; setMs(e); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calm]);

  const s = story.current; const v = VERDICT[s.verdict]; const e = calm || ms < BURST * 0.5 ? 1e9 : Math.max(0, ms - BURST); // before the swap point the previous card is still fully shown
  const chars = Math.min(s.title.length, Math.floor(e / TYPE)); const titleDone = chars >= s.title.length;
  const seatAt = (i) => 520 + i * 150; const seatOn = (i) => e >= seatAt(i);
  const partial = s.seats.reduce((a, x, i) => a + (seatOn(i) ? x.w * x.score : 0), 0); const shown = Math.round(partial);
  const verdictOn = e >= seatAt(6) + 260;
  const glitch = !calm && ms < BURST;
  return (
    <aside className={`lc${glitch ? ' glitch' : ''}`} aria-label="Example council score card (made-up)">
      <Snow amp={amp} />
      <div className="lc-in">
        <p className="lc-eye"><span>COUNCIL SCORE</span><em>EXAMPLE</em></p>
        <p className="lc-title" aria-live="off">{s.title.slice(0, chars)}<i className={titleDone ? 'idle' : ''} aria-hidden="true" /></p>
        <div className="lc-top">
          <div className="lc-num"><b>{shown}</b><span>/ 100</span></div>
          <div className="lc-verdict" style={{ '--c': v[2], opacity: verdictOn ? 1 : 0.15 }}><b>{verdictOn ? v[0] : '···'}</b><span>{verdictOn ? v[1] : 'counting votes'}</span></div>
        </div>
        <ul className="lc-seats">
          {s.seats.map((x, i) => (
            <li key={x.name} className={seatOn(i) ? 'on' : ''}>
              <span className="lc-name">{x.name}</span>
              <span className="lc-bar"><i style={{ width: seatOn(i) ? `${x.score}%` : '0%', background: x.score >= 62 ? '#59ffd1' : x.score >= 48 ? '#f2b84b' : '#ff6b8b' }} /></span>
              <span className="lc-val">{seatOn(i) ? x.score : '–'}</span>
            </li>
          ))}
        </ul>
        <p className="lc-next">{verdictOn ? NEXT[s.verdict] : ' '}</p>
        <p className="lc-foot">Made-up scores for the picture. <a href="#/council">See real votes</a></p>
      </div>
    </aside>
  );
}
