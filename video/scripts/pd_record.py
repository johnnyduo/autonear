#!/usr/bin/env python3
"""Records the REAL AutoNEAR web app (production URL) as crisp 1920x1080 clips, one per scene, with every cursor move timed to the narration.
Frames come from the browser's own screencast (lossless-ish JPEG q=100), not Playwright's low-bitrate webm. DOM rectangles of the things the video
points at are measured live and written to src/data/pd-marks.json, so callouts sit on the real elements.
Run:  /opt/homebrew/opt/python@3.14/bin/python3.14 scripts/pd_record.py [scene ...]   (needs src/data/pd-words.json from scripts/pd-anchors.mjs)"""
import base64, json, math, re, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = 'https://autonear-eight.vercel.app/'
OFFSET = 0.567           # clip time at which narration second 0 happens (matches the Remotion shell: PRE 14f + LEAD 0.1s)
TAIL = 1.4               # extra seconds recorded after the narration ends (the scene's exit)
W = json.load(open(ROOT / 'src/data/pd-words.json'))
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
def cue(scene, phrase, nth=0):
    ws = W[scene]['words']; tg = [norm(x) for x in phrase.split() if norm(x)]
    seen = 0
    for i in range(len(ws) - len(tg) + 1):
        if all(norm(ws[i + k]['w']) == t for k, t in enumerate(tg)):
            if seen == nth: return ws[i]['t'] + OFFSET
            seen += 1
    raise SystemExit(f'cue not found: {scene}: {phrase}')

CURSOR_JS = """
(() => { if (window.__cur) return; const c = document.createElement('div'); c.id='__cur';
c.style.cssText='position:fixed;left:0;top:0;width:34px;height:34px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 4px 8px rgba(0,0,0,.55))';
c.innerHTML='<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.8 L11.7 21.5 L14.2 20.4 L11.2 13.8 L17.4 13.4 Z" fill="#fff" stroke="#0b0f14" stroke-width="1.4" stroke-linejoin="round"/></svg>';
document.documentElement.appendChild(c);
const r=document.createElement('div'); r.style.cssText='position:fixed;left:0;top:0;width:18px;height:18px;border-radius:99px;border:3px solid #c6f432;z-index:2147483646;pointer-events:none;opacity:0';
document.documentElement.appendChild(r);
window.__cur=c; window.__rip=(x,y)=>{r.animate([{transform:`translate(${x-9}px,${y-9}px) scale(.4)`,opacity:.95},{transform:`translate(${x-9}px,${y-9}px) scale(4.2)`,opacity:0}],{duration:650,easing:'ease-out'});};
addEventListener('mousemove',e=>{c.style.transform=`translate(${e.clientX-4}px,${e.clientY-2}px)`},true);
addEventListener('mousedown',e=>window.__rip(e.clientX,e.clientY),true);
})();"""
ease = lambda t: t * t * (3 - 2 * t)

class Rec:
    def __init__(self, page, cdp):
        self.page, self.cdp, self.frames, self.t0, self.mx, self.my = page, cdp, [], None, 800, 600
        self.marks = []
        cdp.on('Page.screencastFrame', self._frame)
    def _frame(self, f):
        try: self.frames.append((f['metadata']['timestamp'], base64.b64decode(f['data'])))
        finally: self.cdp.send('Page.screencastFrameAck', {'sessionId': f['sessionId']})
    def start(self):
        self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 100, 'maxWidth': 1600, 'maxHeight': 900, 'everyNthFrame': 1})
        self.t0 = time.time()
    def now(self): return time.time() - self.t0
    def wait_until(self, c):
        while self.now() < c: time.sleep(0.004)
    def glide(self, x, y, c_end, curve=0.12, raw=False):
        if not raw: x, y = x * 1600 / 1920, y * 1600 / 1920
        c0, x0, y0 = self.now(), self.mx, self.my
        dur = max(0.05, c_end - c0); nx, ny = -(y - y0) * curve, (x - x0) * curve
        while True:
            p = min(1, (self.now() - c0) / dur); e = ease(p)
            bx = x0 + (x - x0) * e + nx * math.sin(math.pi * e); by = y0 + (y - y0) * e + ny * math.sin(math.pi * e)
            self.page.mouse.move(bx, by); self.mx, self.my = bx, by
            if p >= 1: break
            time.sleep(0.008)
    def scroll(self, y_to, c_end):
        c0 = self.now(); y0 = self.page.evaluate('window.scrollY'); dur = max(0.05, c_end - c0)
        while True:
            p = min(1, (self.now() - c0) / dur)
            self.page.evaluate(f'window.scrollTo(0,{y0 + (y_to - y0) * ease(p)})')
            if p >= 1: break
            time.sleep(0.012)
    def box(self, sel_or_text, nth=0, name=None, scene=None):
        loc = self.page.get_by_text(re.compile(r'^\s*' + re.escape(sel_or_text[6:]) + r'\s*$', re.I)) if sel_or_text.startswith('exact:') else self.page.get_by_text(sel_or_text, exact=len(sel_or_text) <= 3) if not sel_or_text.startswith(('css=', 'role=')) else self.page.locator(sel_or_text)
        b = loc.nth(nth).bounding_box()
        if not b: raise SystemExit(f'no box for {sel_or_text}')
        self.marks.append({'name': name or sel_or_text, 'c': round(self.now(), 2), 'x': round(b['x']), 'y': round(b['y']), 'w': round(b['width']), 'h': round(b['height'])})
        return b
    def hover(self, sel_or_text, c_end, nth=0, dx=0.5, dy=0.5, name=None):
        b = self.box(sel_or_text, nth, name); self.glide(b['x'] + b['width'] * dx, b['y'] + b['height'] * dy, c_end, raw=True); return b
    def stop(self):
        self.cdp.send('Page.stopScreencast')

def build_mp4(frames, total, out):
    if not frames: raise SystemExit('no frames')
    d = ROOT / 'public/footage-pd' / (out.stem + '-frames'); d.mkdir(parents=True, exist_ok=True)
    for f in d.glob('*.jpg'): f.unlink()
    t0 = frames[0][0]; lst = []
    for i, (ts, data) in enumerate(frames):
        p = d / f'{i:05d}.jpg'; p.write_bytes(data)
        nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 0.05
        lst.append(f"file '{p}'\nduration {max(0.001, nxt - ts):.4f}")
    (d / 'list.txt').write_text('\n'.join(lst) + f"\nfile '{d / f'{len(frames)-1:05d}.jpg'}'\n")
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(d / 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-t', f'{total:.2f}',
                    '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-movflags', '+faststart', str(out)], check=True)
    for f in d.glob('*.jpg'): f.unlink()

# ---------------------------------------------------------------- scene plans
def sc_landing(r, s):
    r.wait_until(0.4); r.box('Find demand', name='headline')
    r.glide(1300, 560, cue(s, 'Find demand', 0)); r.hover('Explore the demo', cue(s, 'how it works', 0) + 0.5, name='cta')
def sc_home(r, s):
    r.wait_until(0.3); r.box('Everything the agents have read', name='title'); r.box('546 RECORDS', name='counts')
    r.glide(1080, 480, cue(s, 'Five hundred', 0)); r.glide(1320, 560, cue(s, 'seven product', 0)); r.glide(980, 640, cue(s, 'Every record', 0) + 0.2); r.glide(1240, 420, cue(s, 'links back', 0) + 1.0)
def sc_watch(r, s):
    r.wait_until(0.3); r.box('Tell the agent what matters', name='intro'); r.box('What to look for', name='lookfor')
    r.glide(520, 470, cue(s, 'you choose', 0)); r.glide(560, 640, cue(s, 'or ignore', 0)); r.box('Where it looks', name='sources_h')
    r.scroll(260, cue(s, 'Below', 0) + 0.4); r.glide(1300, 420, cue(s, 'last checked', 0)); r.box('exact:WORKING', nth=0, name='working')
def sc_council(r, s):
    r.wait_until(0.3); r.box('Council', nth=0, name='title'); r.box('What did it see?', name='seen')
    r.hover('Replay the vote', cue(s, 'Then the council', 0) + 0.2, name='replay_btn')
    r.scroll(640, cue(s, 'Seven specialist', 0) + 0.2); r.box('Who voted, and how?', name='voted_h')
    t = r.now(); r.page.get_by_text('Replay the vote').first.click(); r.marks.append({'name': 'replay_click', 'c': round(t, 2), 'x': 0, 'y': 0, 'w': 0, 'h': 0})
    r.glide(1200, 620, cue(s, 'score each idea', 0) + 0.3); r.scroll(0, cue(s, 'Treasury rebalancing', 0) + 0.5); r.box('score 80 of 62 needed', name='score')
def sc_build(r, s):
    r.wait_until(0.3); r.box('The agents write a landing page', name='intro'); r.box('Policy-bound treasury rebalancing on NEAR', nth=0, name='top_idea')
    r.glide(700, 520, cue(s, 'From a go', 0)); r.wait_until(cue(s, 'landing page', 0) + 0.3); r.scroll(1150, cue(s, 'copy layout', 0) + 0.8); r.box('exact:PREVIEW', name='preview_h')
    r.glide(1500, 700, cue(s, 'You review it', 0)); r.scroll(700, cue(s, 'then approve', 0) - 0.2); r.box('Approve build', name='approve'); r.glide(1240, 640, cue(s, 'approve it', 0))
def sc_approvals(r, s):
    r.wait_until(0.3); r.box('Approvals', nth=0, name='title'); r.box('Publish the proposals contract', name='card1'); r.box('Pay 12.5 USDC', name='card2')
    r.glide(900, 520, cue(s, 'Actions that', 0)); r.hover('Cost: Test funds only', cue(s, 'what it does', 0) + 0.8, name='cost'); r.box('Hold to approve', nth=0, name='hold')
    r.hover('Hold to approve', cue(s, 'In Manual mode', 0) + 0.2, nth=0, name='hold_btn')
    c = cue(s, 'In Auto mode', 0); r.wait_until(c - 1.2); r.page.evaluate("location.hash='#/home?fixture=1'"); r.page.wait_for_timeout(600)
    r.glide(1520, 70, c + 1.6); r.box('Manual', nth=0, name='toggle')
def sc_vault(r, s):
    r.wait_until(0.3); r.box('The agent is working inside', name='status'); r.box('LIMITS ARE ON', name='limits_on')
    r.glide(900, 460, cue(s, 'The vault holds', 0)); r.scroll(560, cue(s, 'half a NEAR', 0) - 0.3); r.box('exact:EACH TIME', name='each'); r.box('exact:IN TOTAL', name='total'); r.box('exact:VALID UNTIL', name='expiry'); r.box('exact:EVERY 1 D', name='daily')
    r.glide(520, 520, cue(s, 'half a NEAR', 0)); r.glide(1240, 520, cue(s, 'and an expiry', 0) + 0.2); r.scroll(0, cue(s, 'The blockchain', 0) + 0.3); r.box('The agent is working inside', name='status2'); r.glide(960, 420, cue(s, 'is refused', 0) if False else cue(s, 'Go outside', 0) + 0.4)
def drawer_scroll(r, y_to, c_end):
    js = "(() => { const e=[...document.querySelectorAll('*')].find(n=>n.children.length&&/What happened/.test(n.textContent)&&n.scrollHeight>n.clientHeight+20&&getComputedStyle(n).overflowY!=='visible'); return e; })()"
    c0 = r.now(); dur = max(0.05, c_end - c0)
    y0 = r.page.evaluate("(() => { const e=[...document.querySelectorAll('*')].filter(n=>n.scrollHeight>n.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.getBoundingClientRect().left>900)[0]; window.__d=e; return e?e.scrollTop:0; })()")
    while True:
        p = min(1, (r.now() - c0) / dur)
        r.page.evaluate(f'window.__d && (window.__d.scrollTop={y0 + (y_to - y0) * ease(p)})')
        if p >= 1: break
        time.sleep(0.012)
def sc_proof(r, s):
    r.wait_until(0.3); r.box('What happened', name='what'); r.box('A payment was refused', name='refused_row')
    r.glide(1640, 400, cue(s, 'fuel taken', 0)); r.glide(1640, 372, cue(s, 'refused', 0) + 0.2)
    r.glide(1640, 640, cue(s, 'Below it', 0)); drawer_scroll(r, 420, cue(s, 'a recorded run', 0) + 0.5); r.box('Recorded run on NEAR testnet', name='recorded_h'); r.box('DONE', nth=0, name='done0')
    r.glide(1500, 700, cue(s, 'transaction hash', 0)); r.box('signed by autonear-agent-1106', name='hash0'); r.glide(1560, 560, cue(s, 'each step', 0) + 0.2)
def sc_close(r, s):
    r.wait_until(0.3); r.glide(960, 540, cue(s, 'The code is open', 0))
PLANS = {'landing': ('#/', sc_landing), 'home': ('#/home?fixture=1', sc_home), 'watch': ('#/watch?fixture=1', sc_watch), 'council': ('#/council?fixture=1', sc_council),
         'build': ('#/build?fixture=1', sc_build), 'approvals': ('#/approvals?fixture=1', sc_approvals), 'vault': ('#/vault?fixture=1', sc_vault), 'proof': ('#/home?fixture=1&activity=1', sc_proof), 'close': ('#/', sc_close)}

def main():
    want = [a for a in sys.argv[1:] if not a.startswith('-')] or list(PLANS)
    mp = ROOT / 'src/data/pd-marks.json'; marks = json.load(open(mp)) if mp.exists() else {}
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for sid in want:
            url, fn = PLANS[sid]
            ctx = b.new_context(viewport={'width': 1600, 'height': 900}, device_scale_factor=1); page = ctx.new_page()
            page.add_init_script(CURSOR_JS)
            if sid in ('landing', 'close'):   # the hero copy changed in web/src/app/Landing.jsx; show it before it is deployed
                def swap(route):
                    resp = route.fetch(); body = resp.text()
                    body = body.replace('An agent that works for you,', 'Find demand.').replace('on a leash you hold.', 'Build within limits.')
                    route.fulfill(response=resp, body=body)
                page.route('**/*.js', swap)
            page.goto(BASE + url); page.wait_for_load_state('networkidle'); page.wait_for_timeout(2500)
            page.evaluate(CURSOR_JS); page.mouse.move(800, 600)
            r = Rec(page, ctx.new_cdp_session(page)); r.mx, r.my = 800, 600; r.start()
            total = OFFSET + W[sid]['dur'] + TAIL
            fn(r, sid); r.wait_until(total); r.stop()
            build_mp4(r.frames, total, ROOT / 'public/footage-pd' / f'{sid}.mp4')
            marks[sid] = r.marks; print(sid, f'{len(r.frames)} frames, {total:.1f}s', flush=True)
            ctx.close()
        b.close()
    json.dump(marks, open(mp, 'w'), indent=1)
main()
