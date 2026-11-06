// Press-and-hold confirmation as a pure state machine (testable without a DOM). The component feeds it pointer/keyboard events and animation frames.
export function createHold({ ms = 800, onComplete, onProgress = () => {} } = {}) {
  let t0 = null; let done = false;
  return {
    start(t) { if (t0 === null && !done) { t0 = t; onProgress(0); } },
    tick(t) {
      if (t0 === null || done) return 0;
      const p = Math.min(1, Math.max(0, (t - t0) / ms));
      onProgress(p);
      if (p >= 1) { done = true; t0 = null; onComplete(); }
      return p;
    },
    cancel() { if (t0 !== null) { t0 = null; onProgress(0); } },
    get holding() { return t0 !== null; },
    get done() { return done; },
    reset() { t0 = null; done = false; onProgress(0); },
  };
}
