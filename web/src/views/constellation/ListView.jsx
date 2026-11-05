// Accessible table of exactly the data the visual shows: opportunities, sources, then every stored evidence record.
import { useMemo, useState } from 'react';
import { fmt } from '../../api.js';
import { FlagChips, srcColor, srcShort, when } from '../_evidence-parts.jsx';
import { Icon } from '../../ui.jsx';
import { WELLS } from './data.js';

export function ListView({ model, srcInfo, filter }) {
  const [sort, setSort] = useState('relevance');
  const rows = useMemo(() => {
    const r = model.nodes.filter((n) => !filter.srcOff.has(model.sources[n.src]?.id) && !filter.topicOff.has(WELLS[n.primary]));
    return r.sort((a, b) => (sort === 'relevance' ? b.rel - a.rel || when(b.e) - when(a.e) : when(b.e) - when(a.e)));
  }, [model, filter, sort]);
  return (
    <div className="co-list" tabIndex={-1}>
      <div className="co-list-in">
        <h3 className="eyebrow">Opportunities</h3>
        <div className="scroll-x"><table className="tbl">
          <caption className="sr">Opportunity hubs with stored score and confidence</caption>
          <thead><tr><th scope="col">Topic</th><th scope="col">Opportunity</th><th scope="col">Score</th><th scope="col">Confidence</th><th scope="col">Linked records</th><th scope="col"><span className="sr">Open</span></th></tr></thead>
          <tbody>{model.wells.map((w) => (
            <tr key={w.id}><th scope="row">{w.label}</th><td>{w.opp?.title ?? <span className="faint">no opportunity (untagged records)</span>}</td><td className="num">{w.opp ? w.opp.score.toFixed(2) : '–'}</td><td className="num">{w.opp ? w.opp.confidence.toFixed(2) : '–'}</td><td className="num">{w.linked}</td><td>{w.opp && <a href={`#/opportunity/${w.opp.id}`}>Open dossier</a>}</td></tr>
          ))}</tbody>
        </table></div>
        <h3 className="eyebrow">Sources</h3>
        <div className="scroll-x"><table className="tbl">
          <caption className="sr">Sources with last real ingest</caption>
          <thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last ingest</th><th scope="col">Stored records</th></tr></thead>
          <tbody>{model.sources.map((s, i) => { const info = srcInfo[i] ?? {}; return (
            <tr key={s.id}><th scope="row"><i className="co-sw" style={{ background: srcColor(s.id) }} aria-hidden="true" /> {srcShort(s.id)}</th><td>{info.status ?? '–'}{info.recent ? ' · recent' : ''}</td><td>{info.last ? `${fmt.ago(info.last)} (${fmt.date(info.last)})` : 'never'}</td><td className="num">{model.nodes.filter((n) => n.src === i).length}</td></tr>
          ); })}</tbody>
        </table></div>
        <div className="row sp"><h3 className="eyebrow">Evidence records ({rows.length})</h3>
          <div className="co-seg sm" role="group" aria-label="Sort records"><button type="button" aria-pressed={sort === 'relevance'} onClick={() => setSort('relevance')}>By relevance</button><button type="button" aria-pressed={sort === 'date'} onClick={() => setSort('date')}>Newest first</button></div></div>
        <div className="scroll-x"><table className="tbl">
          <caption className="sr">Every stored evidence record in the current filter</caption>
          <thead><tr><th scope="col">Record</th><th scope="col">Source</th><th scope="col">Topic</th><th scope="col">Date</th><th scope="col">Relevance</th><th scope="col">Flags</th><th scope="col"><span className="sr">Open</span></th></tr></thead>
          <tbody>{rows.map((n) => (
            <tr key={n.id}><th scope="row" className="co-t">{n.e.title}</th><td>{srcShort(n.e.source_id)}</td><td>{model.wells[n.primary].label}</td><td className="num">{fmt.date(when(n.e)).slice(0, 10)}</td><td className="num">{n.rel.toFixed(2)}</td><td><FlagChips flags={n.e.flags} /></td><td><a href={`#/radar/${n.id}`}>Open in Radar<Icon name="arrow" size={12} /></a></td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}
