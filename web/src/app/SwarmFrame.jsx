// The sandboxed page frame and its swarm-state messages, shared by the Build page preview and the Develop theater.
import { useCallback, useEffect, useRef, useState } from 'react';
import { swarmView } from './build-model.js';

export const lessMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** `src` and `frameKey` restart the listener. `send('play' | 'skip' | 'still')` talks to the frame; `view` is the last valid swarm-state. */
export function useSwarmFrame(src, frameKey) {
  const frame = useRef(null);
  const [view, setView] = useState(null);
  useEffect(() => {
    setView(null);
    // Only messages from our own origin and from this exact frame are used.
    const onMsg = (e) => { if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return; const v = swarmView(e.data); if (v) setView(v); };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, [src, frameKey]);
  const send = useCallback((cmd) => { try { frame.current?.contentWindow?.postMessage({ type: 'swarm', cmd }, location.origin); } catch { /* frame not ready */ } }, []);
  return { frame, view, send };
}

export function SwarmFrame({ frame, src, title, frameKey, tabIndex, onLoad }) {
  return (
    /* sandbox="allow-scripts allow-same-origin": the replay script needs to run and to postMessage with a real origin (a sandbox without
       allow-same-origin gives the frame the origin "null", and we check origins on both sides). This is acceptable because the framed page is
       served by us under Content-Security-Policy default-src 'none'; script-src 'self' (only our own /swarm.js, no inline script), it holds
       escaped text only, and no model-written code runs. It also has no cookies, no wallet code and no way to reach this app's session. */
    <iframe key={`${src}|${frameKey}`} ref={frame} title={title} src={src} sandbox="allow-scripts allow-same-origin" loading="lazy" referrerPolicy="no-referrer" tabIndex={tabIndex} onLoad={onLoad} />
  );
}
