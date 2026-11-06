// "Up next" in the council score box: every product in rank order with the state of its page. A click only changes which product the box shows.
import { useState } from 'react';
import { T } from '../../app/copy.js';
import { score } from '../../app/build-model.js';
import { hasToggle, queueTag, visibleQueue } from '../../app/queue-model.js';

const J = T.journey;

export default function UpNext({ queue, current, goAt, onFocus }) {
  const [all, setAll] = useState(false);
  if (!Array.isArray(queue) || queue.length < 2) return null;
  const rows = visibleQueue(queue, { showAll: all, focus: current });
  return (
    <>
      <h4 className="co-sc-h">{J.queue} <small>score</small></h4>
      <ul className="co-sc-queue">
        {rows.map((x) => { const tag = queueTag(x, J, goAt); return (
          <li key={x.oppId}>
            <button type="button" className="co-sc-q" aria-current={x.oppId === current ? 'true' : undefined} onClick={() => onFocus(x.oppId)}>
              <span className="co-sc-q-t">{x.title}</span>
              <span className="co-sc-q-n">{score(x.support)}</span>
              <span className="co-sc-q-tags">
                <span className={`co-sc-tag ${tag.key}`}>{tag.text}</span>
                {!x.contractTemplate && <span className="co-sc-tag none">{J.tagNoContract}</span>}
              </span>
            </button>
          </li>); })}
      </ul>
      {hasToggle(queue) && <button type="button" className="co-sc-qmore" aria-expanded={all} onClick={() => setAll(!all)}>{all ? J.queueFewer : J.queueAll(queue.length)}</button>}
    </>
  );
}
