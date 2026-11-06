// Develop theater: the stored product page in its sandboxed frame, with the swarm of agents that replays how it was built.
// What is real: the page text (written once by Gemini from stored evidence) and the build request while it runs.
// What is a show: the cursors that draw the page. They replay a stored build, and the label under the header says so.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../ui.jsx';
import { buildingLine, siteLinks, swarmWord } from '../../app/build-model.js';
import { SwarmFrame, lessMotion, useSwarmFrame } from '../../app/SwarmFrame.jsx';
import { T } from '../../app/copy.js';

const J = T.journey;
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * status: 'building' (the build request runs) | 'ready' (the page is stored) | 'error'.
 * step: the result of nextStep(); it decides whether Publish and the public link show.
 */
export default function DevelopTheater({ title, page, status, startedAt, error, notice, step, publishing, onPublish, onClose, opener, fallback, toast }) {
  const panel = useRef(null);
  const links = page ? siteLinks(page, '') : null;
  const src = status === 'ready' ? links?.exactPath : undefined;
  const { frame, view, send } = useSwarmFrame(src, page?.hash);
  const motionOff = lessMotion();
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef(onClose); closeRef.current = onClose;

  useEffect(() => { if (status !== 'building') return undefined; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [status]);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return; } // the constellation behind must not also leave full screen
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); panel.current.focus(); return; }
      const first = items[0]; const last = items[items.length - 1]; const at = document.activeElement;
      if (!panel.current.contains(at) || at === panel.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const back = useRef({ opener, fallback }); back.current = { opener, fallback };
  useEffect(() => () => { const { opener: o, fallback: f } = back.current; (o?.isConnected ? o : f?.isConnected ? f : null)?.focus?.(); }, []);

  const copy = async () => { try { await navigator.clipboard.writeText(`${location.origin}${step.link}`); toast(T.build.copied); } catch { toast('Copying did not work here. Select the link and copy it by hand.', 'bad'); } };
  // keys typed inside the frame never reach this document; the frame is same-origin, so Esc is forwarded
  const forwardEsc = () => { try { frame.current?.contentWindow?.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRef.current(); }); } catch { /* frame not reachable */ } };
  const agents = view?.agents ?? [];

  return createPortal(
    <div className="co-dv" data-ui>
      <div className="co-dv-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby="co-dv-t" aria-describedby="co-dv-d" tabIndex={-1}>
        <header className="co-dv-h">
          <div><span className="co-dv-eye">PRODUCT PAGE</span><h2 id="co-dv-t">{title}</h2></div>
          <button type="button" className="co-dv-btn" onClick={onClose}><Icon name="x" size={16} />{J.theaterClose}<kbd>Esc</kbd></button>
        </header>

        <div className="co-dv-body">
          {status === 'building' && <p className="co-dv-run" role="status"><span className="co-dv-spin" aria-hidden="true" />{buildingLine(now - (startedAt ?? now))}</p>}
          {status === 'error' && <p className="co-dv-err" role="alert"><Icon name="alert" size={15} />{error || J.theaterFail}</p>}
          {status === 'ready' && src && (
            <div className="co-dv-frame"><SwarmFrame frame={frame} src={src} title={`The page for ${title}`} frameKey={page.hash} tabIndex={-1} onLoad={forwardEsc} /></div>
          )}
        </div>

        <div className="co-dv-foot">
          {status === 'ready' && (
            <>
              <div className="co-dv-ctl">
                <button type="button" className="co-dv-btn" onClick={() => send('play')} disabled={motionOff}><Icon name="play" size={14} />{J.theaterReplay}</button>
                <div className="co-dv-prog" role="progressbar" aria-label="Replay progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((view?.progress ?? 0) * 100)}><i style={{ width: `${(view?.progress ?? 0) * 100}%` }} /></div>
                <span className="co-dv-state" role="status">{motionOff ? T.build.reduced : swarmWord(view)}</span>
              </div>
              {agents.length > 0 && (
                <ul className="co-dv-agents" aria-label="What each agent is doing">
                  {agents.map((a) => <li key={a.name}><i style={{ background: a.color }} aria-hidden="true" /><b>{a.name}</b><span>{view.phase === 'running' ? a.doing || 'idle' : ''}</span></li>)}
                </ul>
              )}
              <p id="co-dv-d" className="co-dv-label">{J.theaterLabel}</p>
              <div className="co-dv-act">
                {step.actions.publish && <button type="button" className="co-dv-btn primary" onClick={onPublish} disabled={publishing}>{publishing ? J.publishing : J.publish}</button>}
                {step.link && (
                  <span className="co-dv-link"><a href={step.link} target="_blank" rel="noopener noreferrer">{`${location.origin}${step.link}`}</a><button type="button" className="co-dv-btn" onClick={copy}><Icon name="copy" size={14} />{J.copyLink}</button></span>
                )}
                {notice && <span className="co-dv-err" role="alert"><Icon name="alert" size={15} />{notice}</span>}
                {step.reason && !step.actions.publish && <span className="co-dv-why"><Icon name="lock" size={14} />{step.reason}</span>}
              </div>
            </>
          )}
          {status === 'building' && <p id="co-dv-d" className="co-dv-label">{J.headBuilding}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
