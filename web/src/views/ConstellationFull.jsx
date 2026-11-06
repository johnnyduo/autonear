// Full-screen constellation app (route #/constellation): the same lazy renderer, full-bleed over the whole viewport, with an Exit control.
import { useEffect } from 'react';
import { useApi } from '../api.js';
import { ConstellationPanel } from './_overview-parts.jsx';

export default function ConstellationFull({ status }) {
  const opps = useApi('/api/opportunities', { poll: 60000 });
  useEffect(() => { // Esc leaves full screen unless something inside the stage is pinned (the stage handles Esc itself first)
    const f = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.co-card.pinned')) location.hash = '#/'; };
    addEventListener('keydown', f); document.documentElement.classList.add('co-noscroll');
    return () => { removeEventListener('keydown', f); document.documentElement.classList.remove('co-noscroll'); };
  }, []);
  return <ConstellationPanel full status={status} opps={opps.data?.items} evidenceCount={status.data?.counts?.evidence} />;
}
