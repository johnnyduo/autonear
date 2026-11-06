// Press-and-hold to confirm (pointer, or Space/Enter on the keyboard). A stray tap can never approve. Logic lives in hold.js.
import { useEffect, useRef, useState } from 'react';
import { createHold } from './hold.js';
import { T } from './copy.js';

export default function HoldButton({ onComplete, children = T.hold, ms = 800, disabled = false, busy = false }) {
  const [p, setP] = useState(0); const [holding, setHolding] = useState(false);
  const raf = useRef(0); const cb = useRef(onComplete); cb.current = onComplete;
  const hold = useRef(null);
  if (!hold.current) hold.current = createHold({ ms, onProgress: setP, onComplete: () => { setHolding(false); cancelAnimationFrame(raf.current); cb.current(); } });
  const frame = (t) => { hold.current.tick(t); if (hold.current.holding) raf.current = requestAnimationFrame(frame); };
  const start = () => { if (disabled || busy) return; setHolding(true); hold.current.start(performance.now()); cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(frame); };
  const stop = () => { setHolding(false); hold.current.cancel(); cancelAnimationFrame(raf.current); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => { if (!disabled && !busy) hold.current.reset(); }, [disabled, busy]);
  return (
    <button type="button" className={`hold${holding ? ' on' : ''}`} style={{ '--p': p }} disabled={disabled || busy}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); start(); }} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stop(); }} onBlur={stop}
      aria-label={`${typeof children === 'string' ? children : T.hold}. Press and hold for a second.`}>
      <i className="hold-fill" aria-hidden="true" />
      <span>{busy ? '…' : holding ? T.holding : children}</span>
    </button>
  );
}
