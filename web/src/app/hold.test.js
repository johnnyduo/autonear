import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHold } from './hold.js';

test('does not fire before 800 ms', () => {
  let n = 0; const h = createHold({ onComplete: () => { n += 1; } });
  h.start(0); h.tick(799); assert.equal(n, 0);
});
test('fires once at 800 ms and not again', () => {
  let n = 0; const h = createHold({ onComplete: () => { n += 1; } });
  h.start(0); h.tick(800); h.tick(900); h.start(1000); h.tick(2000);
  assert.equal(n, 1); assert.equal(h.done, true);
});
test('release cancels and progress resets', () => {
  let n = 0; let p = -1; const h = createHold({ onComplete: () => { n += 1; }, onProgress: (x) => { p = x; } });
  h.start(0); h.tick(500); assert.equal(p, 0.625); h.cancel(); assert.equal(p, 0); h.tick(900);
  assert.equal(n, 0); assert.equal(h.holding, false);
});
test('a second hold after a cancel starts from zero', () => {
  let n = 0; const h = createHold({ onComplete: () => { n += 1; } });
  h.start(0); h.tick(700); h.cancel(); h.start(1000); h.tick(1700); assert.equal(n, 0); h.tick(1800); assert.equal(n, 1);
});
test('keyboard hold uses the same machine (start on keydown, cancel on keyup)', () => {
  let n = 0; const h = createHold({ ms: 800, onComplete: () => { n += 1; } });
  h.start(10); h.start(20); // key auto-repeat must not restart the clock
  h.tick(810); assert.equal(n, 1);
});
