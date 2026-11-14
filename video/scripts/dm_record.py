#!/usr/bin/env python3
"""Records the REAL AutoNEAR web app (production URL) for the v3 product demo, frame by frame at exactly 30 fps.
Time is virtual (Playwright's fake clock), so scrolling, cursor moves and the app's own timers/animations advance by exactly 1/30 s per frame: no dropped or
uneven frames. Every scene starts on the page the previous scene ended on and then navigates by really clicking, so the cut between scenes is seamless.
Viewport 1920x1012 at device scale 1.5 -> 2880x1518 footage (sharp when the camera pushes in). DOM rects of what the video points at go to src/data/dm-marks.json.
Run: /opt/homebrew/opt/python@3.14/bin/python3.14 scripts/dm_record.py [scene ...]   (needs src/data/dm-words.json from scripts/dm-anchors.mjs)"""
import datetime, json, math, re, subprocess, sys, time, pathlib, shutil
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = 'https://autonear-eight.vercel.app/'
VW, VH, DSF, FPS = 1920, 1012, 1.5, 30
OFFSET = 0.567           # clip time at which narration second 0 happens (Remotion shell: PRE 14f + LEAD 0.1s)
TAIL = 1.4               # seconds recorded after the narration ends (the scene's exit)
W = json.load(open(ROOT / 'src/data/dm-words.json'))
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
c.style.cssText='position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 3px 6px rgba(0,0,0,.6))';
c.innerHTML='<svg width="32" height="32" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.8 L11.7 21.5 L14.2 20.4 L11.2 13.8 L17.4 13.4 Z" fill="#fff" stroke="#0b0f14" stroke-width="1.4" stroke-linejoin="round"/></svg>';
document.documentElement.appendChild(c);
const r=document.createElement('div'); r.style.cssText='position:fixed;left:0;top:0;width:18px;height:18px;border-radius:99px;border:3px solid #c6f432;z-index:2147483646;pointer-events:none;opacity:0';
document.documentElement.appendChild(r);
window.__cur=c; window.__rip=(x,y)=>{r.animate([{transform:`translate(${x-9}px,${y-9}px) scale(.4)`,opacity:.95},{transform:`translate(${x-9}px,${y-9}px) scale(4.2)`,opacity:0}],{duration:650,easing:'ease-out'});};
addEventListener('mousemove',e=>{c.style.transform=`translate(${e.clientX-4}px,${e.clientY-2}px)`},true);
addEventListener('mousedown',e=>window.__rip(e.clientX,e.clientY),true);
document.documentElement.style.scrollBehavior='auto';
})();"""
ease = lambda t: t * t * (3 - 2 * t)

class Rec:
    def __init__(self, page, d):
        self.page, self.d, self.i, self.mx, self.my, self.tracks = page, d, 0, 960, 540, {}
    def now(self): return self.i / FPS
    def _measure(self):   # every element the video points at is measured on EVERY frame, so highlights stay glued to it while the page scrolls or re-lays out
        for n, t in self.tracks.items():
            try: r = self.page.evaluate("e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}", t['h'])
            except Exception:
                try: t['h'] = self.loc(*t['q']).element_handle(timeout=500); r = self.page.evaluate("e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}", t['h'])
                except Exception: r = t['r'][-1] if t['r'] else [0, 0, 0, 0]
            t['r'].append([round(v, 1) for v in r])
    def tick(self):
        self.page.clock.run_for(33 if self.i % 3 else 34)   # 33,33,34 ms = exactly 30 fps
        self._measure()
        self.page.screenshot(path=str(self.d / f'{self.i:05d}.jpg'), type='jpeg', quality=90)
        self.i += 1
    def wait_until(self, c):
        while self.now() < c: self.tick()
    def glide(self, x, y, c_end, curve=0.10):
        c0, x0, y0 = self.now(), self.mx, self.my
        dur = max(1 / FPS, c_end - c0); nx, ny = -(y - y0) * curve, (x - x0) * curve
        while True:
            p = min(1, (self.now() - c0) / dur); e = ease(p)
            bx = x0 + (x - x0) * e + nx * math.sin(math.pi * e); by = y0 + (y - y0) * e + ny * math.sin(math.pi * e)
            self.page.mouse.move(bx, by); self.mx, self.my = bx, by
            self.tick()
            if p >= 1: break
    def scroll(self, y_to, c_end):
        c0 = self.now(); y0 = self.page.evaluate('window.scrollY'); dur = max(1 / FPS, c_end - c0)
        while True:
            p = min(1, (self.now() - c0) / dur)
            self.page.evaluate(f'window.scrollTo(0,{y0 + (y_to - y0) * ease(p)})')
            self.tick()
            if p >= 1: break
    def loc(self, q, nth=0):
        if q.startswith('exact:'): l = self.page.get_by_text(re.compile(r'^\s*' + re.escape(q[6:]) + r'\s*$', re.I))
        elif q.startswith('re:'): l = self.page.get_by_text(re.compile(q[3:], re.I))
        elif q.startswith(('css=', 'role=')): l = self.page.locator(q)
        elif q.startswith('link:'): l = self.page.get_by_role('link', name=re.compile(q[5:]))
        else: l = self.page.get_by_text(q, exact=len(q) <= 3)
        return l.nth(nth)
    def need(self, q, nth=0):   # the fake clock is paused between ticks, so wait for an element by ticking (lazy routes / timers need time to pass)
        for k in range(150):
            if self.loc(q, nth).count() > 0:
                if k: print(f'  .. waited {k} frames for {q}', flush=True)
                return self.loc(q, nth)
            self.tick()
        raise SystemExit(f'element never appeared: {q}')
    def scroll_el(self, q, c_end, frac=0.4, nth=0):
        top = self.page.evaluate('window.scrollY') + self.need(q, nth).bounding_box()['y']
        self.scroll(max(0, top - VH * frac), c_end)
    def box(self, q, nth=0, name=None):
        l = self.need(q, nth); b = l.bounding_box()
        if not b: raise SystemExit(f'no box for {q}')
        self.tracks[name or q] = {'f0': self.i, 'r': [], 'h': l.element_handle(), 'q': (q, nth)}
        return b
    def hover(self, q, c_end, nth=0, dx=0.5, dy=0.5, name=None):
        b = self.box(q, nth, name); self.glide(b['x'] + b['width'] * dx, b['y'] + b['height'] * dy, c_end); return b
    def click_at(self, x, y, c_end):
        self.glide(x, y, c_end - 0.12); self.page.mouse.down(); self.tick(); self.tick(); self.page.mouse.up()
    def click(self, q, c_end, nth=0):
        b = self.need(q, nth).bounding_box(); self.click_at(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2, c_end)
        for _ in range(8): self.tick()
    def to_top(self, total):   # leave the page scrolled to the top, cursor mid-screen, so the next scene starts on the same picture
        if self.page.evaluate('window.scrollY') > 5: self.wait_until(total - 1.5); self.scroll(0, total - 0.7)
        else: self.wait_until(total - 0.7)
        self.glide(960, 540, total - 0.1)

def build_mp4(d, out):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS), '-i', str(d / '%05d.jpg'), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-movflags', '+faststart', str(out)], check=True)
    shutil.rmtree(d)

# ---------------------------------------------------------------- scene plans (cursor starts mid-screen unless a plan sets it)
def sc_landing(r, s):
    r.wait_until(0.4); r.box('Find demand', name='headline'); r.glide(1050, 560, cue(s, 'Find demand', 0))
    r.hover('Explore the demo', cue(s, 'first signal', 0) - 0.4, name='cta')
def sc_home(r, s):
    r.wait_until(0.6); r.box('Everything the agents have read', name='title'); r.box('re:RECORDS ·', name='counts')
    r.glide(1000, 520, cue(s, 'Each point', 0) + 0.3); r.hover('re:RECORDS ·', cue(s, 'over five hundred', 0) + 0.3, name='counts_h')
    r.glide(1300, 620, cue(s, 'thirteen sources', 0) + 0.3)
    r.scroll_el('What it found lately', cue(s, 'Scroll down', 0) + 1.3, frac=0.33); r.box('What it found lately', name='found_h'); r.box('Policy-bound treasury rebalancing on NEAR', nth=0, name='idea1'); r.box('re:4 sources agree', name='agree')
    r.glide(960, 640, cue(s, 'grouped', 0) + 0.6); r.hover('re:4 sources agree', cue(s, 'number of sources', 0) + 0.8, name='agree_h')
    r.to_top(r.total)
def sc_watch(r, s):
    r.wait_until(0.6); r.box('Tell the agent what matters', name='intro'); r.box('What to look for', name='lookfor')
    r.glide(520, 560, cue(s, 'you tell', 0)); r.hover('WORDS AND TOPICS', cue(s, 'topics to follow', 0) + 0.4, name='topics'); r.hover('HACKATHONS AND EVENTS', cue(s, 'events', 0) + 0.3, name='events'); r.hover('IGNORE ANYTHING ABOUT', cue(s, 'words to ignore', 0) + 0.3, name='ignore')
    r.scroll_el('Where it looks', cue(s, 'Below that', 0) + 1.0, frac=0.18); r.box('Where it looks', name='sources_h'); r.box('exact:WORKING', nth=0, name='working')
    r.glide(1300, 560, cue(s, 'they read', 0) + 0.2); r.hover('exact:WORKING', cue(s, 'last checked', 0) + 0.3, nth=0, name='working_h')
    r.to_top(r.total)
def sc_council(r, s):
    r.wait_until(0.6); r.box('What did it see?', name='seen')
    r.glide(1000, 500, cue(s, 'Then the council', 0) + 0.2)
    r.scroll_el('Who voted, and how?', cue(s, 'Seven specialist', 0) + 0.2, frac=0.12); r.box('Who voted, and how?', name='voted_h')
    r.hover('Replay the vote', cue(s, 'replay the vote', 0) - 0.5, name='replay_btn')
    r.page.mouse.down(); r.tick(); r.tick(); r.page.mouse.up()
    r.glide(1100, 640, cue(s, 'Treasury rebalancing', 0) - 0.2)
    r.scroll(0, cue(s, 'It needed', 0) + 0.3); r.box('score 80 of 62 needed', name='score'); r.hover('score 80 of 62 needed', cue(s, 'That is a go', 0) + 0.3, name='score_h')
    r.to_top(r.total)
def sc_build(r, s):
    r.wait_until(1.7); r.box('re:The agents write a landing page', name='intro'); r.box('Policy-bound treasury rebalancing on NEAR', nth=0, name='top_idea')
    r.glide(900, 520, cue(s, 'A go becomes', 0) + 0.3); r.hover('Policy-bound treasury rebalancing on NEAR', cue(s, 'landing page', 0) + 0.4, nth=0, name='top_h')
    r.scroll_el('exact:PREVIEW', cue(s, 'the layout', 0) + 0.6, frac=0.2); r.box('exact:PREVIEW', name='preview_h')
    r.glide(1400, 700, cue(s, 'run their checks', 0) + 0.3)
    r.scroll_el('Approve build', cue(s, 'then you approve', 0) - 0.4, frac=0.6); r.box('Approve build', name='approve'); r.hover('Approve build', cue(s, 'approve it', 0) + 0.2, name='approve_h')
    r.to_top(r.total)
def sc_approvals(r, s):
    r.wait_until(0.7); r.box('Publish the proposals contract', name='card1'); r.box('Pay 12.5 USDC', name='card2')
    r.glide(900, 560, cue(s, 'Anything that', 0) + 0.2); r.hover('Cost: Test funds only', cue(s, 'what it does', 0) + 1.0, name='cost'); r.box('Hold to approve', nth=0, name='hold')
    r.hover('Hold to approve', cue(s, 'In Manual mode', 0) + 0.6, nth=0, name='hold_btn')
    c = cue(s, 'In Auto mode', 0)
    r.wait_until(c - 1.7); r.click('link:^Home', c - 0.9)
    r.hover('exact:Auto', c + 1.6, nth=0, name='toggle')
    r.to_top(r.total)
def sc_vault(r, s):
    r.wait_until(0.7); r.box('The agent is working inside', name='status'); r.box('LIMITS ARE ON', name='limits_on')
    r.glide(900, 520, cue(s, 'The limits live', 0) + 0.3)
    r.scroll_el('exact:EACH TIME', cue(s, 'half a NEAR', 0) - 0.2, frac=0.45)
    for k, nm in (('exact:EACH TIME', 'each'), ('exact:EVERY 1 D', 'daily'), ('exact:IN TOTAL', 'total'), ('exact:VALID UNTIL', 'expiry')): r.box(k, name=nm)
    r.glide(520, 520, cue(s, 'half a NEAR', 0) + 0.4); r.glide(1260, 520, cue(s, 'an expiry', 0) + 0.3)
    r.scroll(0, cue(s, 'The blockchain', 0) + 0.2); r.box('The agent is working inside', name='status2'); r.glide(960, 420, cue(s, 'Anything outside', 0) + 0.4)
    r.to_top(r.total)
def drawer_scroll(r, y_to, c_end):
    c0 = r.now(); dur = max(1 / FPS, c_end - c0)
    y0 = r.page.evaluate("(() => { const e=[...document.querySelectorAll('*')].filter(n=>n.scrollHeight>n.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.getBoundingClientRect().left>900)[0]; window.__d=e; return e?e.scrollTop:0; })()")
    while True:
        p = min(1, (r.now() - c0) / dur)
        r.page.evaluate(f'window.__d && (window.__d.scrollTop={y0 + (y_to - y0) * ease(p)})')
        r.tick()
        if p >= 1: break
def sc_proof(r, s):
    r.click('link:^Activity', 0.8); r.wait_until(1.1); r.box('What happened', name='what'); r.box('A payment was refused', name='refused_row')
    r.hover('A payment was refused', cue(s, 'Fuel taken', 0) + 0.2, name='refused_h'); r.glide(1700, 400, cue(s, 'A payment refused', 0) + 0.3)
    r.wait_until(cue(s, 'Below that', 0) - 0.1); drawer_scroll(r, 420, cue(s, 'a recorded run', 0) + 0.8); r.box('Recorded run on NEAR testnet', name='recorded_h'); r.box('DONE', nth=0, name='done0')
    r.glide(1600, 640, cue(s, 'transaction hashes', 0) + 0.2); r.box('signed by autonear-agent-1106', name='hash0')
def sc_close(r, s):
    r.wait_until(0.3); r.glide(960, 560, cue(s, 'The code is open', 0))

# scene -> (start url, plan, previous-page url used so the cut is seamless; None = start on this page)
LAND, HOME = '#/', '#/?fixture=1'
PLANS = {'landing': (LAND, sc_landing), 'home': (LAND, sc_home), 'watch': (HOME, sc_watch), 'council': ('#/watch?fixture=1', sc_council), 'build': ('#/council?fixture=1', sc_build),
         'approvals': ('#/build?fixture=1', sc_approvals), 'vault': (HOME, sc_vault), 'proof': ('#/vault?fixture=1', sc_proof), 'close': (LAND, sc_close)}
NAVCLICK = {'home': ('Explore the demo', None), 'watch': ('link:^Watch', None), 'council': ('link:^Council', None), 'build': ('Build a product page', None), 'approvals': ('link:^Approvals', None), 'vault': ('link:^Vault', None)}
LANDING_SCENES = ('landing', 'home', 'close')

def main():
    want = [a for a in sys.argv[1:] if not a.startswith('-')] or list(PLANS)
    mp = ROOT / 'src/data/dm-marks.json'; marks = json.load(open(mp)) if mp.exists() else {}
    out_dir = ROOT / 'public/footage-dm'; out_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'])   # real GPU: the home visual is far too heavy for software GL
        for sid in want:
            url, fn = PLANS[sid]; t_start = time.time()
            ctx = b.new_context(viewport={'width': VW, 'height': VH}, device_scale_factor=DSF); page = ctx.new_page()
            page.add_init_script(CURSOR_JS); page.clock.install(time=datetime.datetime.now())   # real wall-clock start, or the app prints '20750798d ago'
            if sid in LANDING_SCENES:   # hero copy changed in web/src/app/Landing.jsx; show it before it is deployed
                def swap(route):
                    resp = route.fetch(); body = resp.text()
                    route.fulfill(response=resp, body=body.replace('An agent that works for you,', 'Find demand.').replace('on a leash you hold.', 'Build within limits.'))
                page.route('**/*.js', swap)
            page.goto(BASE + url); page.wait_for_load_state('networkidle'); page.wait_for_timeout(2500)
            page.evaluate(CURSOR_JS)
            page.clock.pause_at(datetime.datetime.now() + datetime.timedelta(seconds=1))
            d = ROOT / f'public/footage-dm/{sid}-frames'; d.mkdir(parents=True, exist_ok=True)
            for f in d.glob('*.jpg'): f.unlink()
            r = Rec(page, d); total = OFFSET + W[sid]['dur'] + TAIL; r.total = total
            nav = NAVCLICK.get(sid)
            if nav and nav[0] == 'Explore the demo':      # landing -> home: the cursor starts on the button the previous scene ended on
                bb = r.loc('Explore the demo').bounding_box(); r.mx, r.my = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2; page.mouse.move(r.mx, r.my)
            else: page.mouse.move(r.mx, r.my)
            r.tick()
            if nav:
                if nav[0] == 'Explore the demo': r.wait_until(0.25); r.click('Explore the demo', 0.5)
                else: r.click(nav[0], 0.55)
                r.wait_until(0.8)
            fn(r, sid); r.wait_until(total)
            n = r.i; build_mp4(d, out_dir / f'{sid}.mp4')
            marks[sid] = {n: {'f0': t['f0'], 'r': t['r']} for n, t in r.tracks.items()}; json.dump(marks, open(mp, 'w'), separators=(',', ':')); print(sid, f'{n} frames, {total:.1f}s, {time.time() - t_start:.0f}s wall, url={page.url}', flush=True)
            ctx.close()
        b.close()
main()
