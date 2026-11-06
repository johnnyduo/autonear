// Small terminal-style log in the corner of the stage. Every line is a stored record: run events, the last scheduler tick, per-source last ingest.
// Lines that already exist when the feed first has data appear at once; only lines that arrive afterwards are typed out.
import { useEffect, useMemo, useRef, useState } from 'react';
import { srcShort } from '../_evidence-parts.jsx';
import { buildFeedLines, chipState, countdown, feedText } from '../../app/live-text.js';
import { fmt } from '../../api.js';
import { ROLES, lastIngest, useTyped } from './shared.js';

const SHOWN = 8;
const roleLabel = (id) => ROLES.find((r) => r[0] === id)?.[1];

/** Typed text with a cursor while it is still typing. The untyped rest stays in the layout (invisible), so a card does not jump in height. */
export function Typed({ text, k, cps, calm, hold = false, cursor = true }) {
  const v = useTyped(hold ? '' : text, { key: k, cps, calm });
  const done = !hold && v.length >= (text ?? '').length;
  return (
    <>
      <span>{v}</span>{cursor && !done && !calm && <span className="co-cur" aria-hidden="true" />}<span className="co-ghost" aria-hidden="true">{(text ?? '').slice(v.length)}</span>
    </>
  );
}

function Row({ line, typed, calm }) {
  return <li className="co-feed-l"><Typed text={feedText(line)} k={line.id} cps={90} calm={calm || !typed} /></li>;
}

function Heartbeat({ at }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const due = Number.isFinite(at) && at <= now;
  return <li className="co-feed-l co-feed-hb">{`idle · ${Number.isFinite(at) ? (due ? 'tick due now' : `next tick in ${countdown(at, now)}`) : 'no tick time stored'}`}</li>;
}

/** props: status (/api/status), run (the run whose events are shown), runEvents (array, or null while loading), live (run is queued/running). */
export default function AgentFeed({ status, run, runEvents, live, calm }) {
  const box = useRef(null); const ls = useRef(null); const [wide, setWide] = useState(false); const [open, setOpen] = useState(true); const sized = useRef(false);
  useEffect(() => {
    const el = box.current?.parentElement; if (!el) return undefined;
    const f = () => { setWide(el.clientWidth >= 900); if (!sized.current) { sized.current = true; setOpen(el.clientHeight >= 780); } }; f(); // short stages start with the feed folded
    const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect();
  }, []);
  const sch = status?.scheduler;
  const all = useMemo(() => buildFeedLines({ events: runEvents, tick: sch?.lastTick, sources: status?.sources, roleLabel, lastIngestOf: lastIngest, srcLabel: srcShort }), [runEvents, sch?.lastTick, status?.sources]);
  const ready = Boolean(status) && (!run || runEvents !== null);
  const seen = useRef(null); const fresh = useRef(new Set());
  if (ready && seen.current === null) seen.current = new Set(all.map((l) => l.id));
  else if (seen.current) for (const l of all) if (!seen.current.has(l.id)) { seen.current.add(l.id); fresh.current.add(l.id); }
  const shown = ready ? all.slice(-SHOWN) : [];
  const idle = !status?.activeRun && !live;
  const lastId = shown[shown.length - 1]?.id;
  useEffect(() => { const el = ls.current; if (el) el.scrollTop = el.scrollHeight; }, [lastId, open, wide]);
  return (
    <div className="co-feedwrap" ref={box} hidden={!wide}>
      {wide && (
        <details className="co-feed" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-ui data-reserve>
          <summary>Agent feed<span className="faint"> · stored events only</span></summary>
          <div className="co-feed-b" role="group" aria-label="Agent activity log, built from stored run events, the last scheduler tick and each source's last ingest" aria-live="off">
            {run && <p className="co-feed-run">{live ? 'active run' : 'last run'} {run.id.slice(0, 14)} · {run.state} · {fmt.ago(run.ended_at ?? run.started_at)}</p>}
            <ul className="co-feed-chips" aria-label="Agent roles in the shown run">
              {ROLES.map(([id, label]) => { const st = run && runEvents ? chipState(runEvents, id) : 'idle'; const s2 = st === 'working' && !live ? 'idle' : st; return (
                <li key={id} className={`co-fchip ${s2}`} title={`${label}: ${s2}`}><i aria-hidden="true" />{label}<span className="sr"> {s2}</span><em aria-hidden="true">{s2}</em></li>
              ); })}
            </ul>
            <ol className="co-feed-ls" ref={ls} tabIndex={0} aria-label="Log lines, newest last">
              {shown.length === 0 && <li className="co-feed-l faint">{ready ? 'No stored events yet.' : 'Loading stored events…'}</li>}
              {shown.map((l) => <Row key={l.id} line={l} typed={fresh.current.has(l.id)} calm={calm} />)}
              {idle && ready && <Heartbeat at={sch?.nextRunAt} />}
            </ol>
          </div>
        </details>
      )}
    </div>
  );
}
