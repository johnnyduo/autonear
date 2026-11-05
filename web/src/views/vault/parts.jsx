// Small presentational atoms for the Vault views. All amounts go through fmtAmount (exact BigInt maths; exact value on hover + sr text when trimmed).
import { Icon } from '../../ui.jsx';
import { CopyButton } from '../_run-parts.jsx';
import { explorerAddr, fmtAmount, gaugeTone, gaugeWord, ratio, toBig } from './format.js';

export function Amt({ v, unit, strong, hideUnit }) {
  const f = fmtAmount(v, unit.decimals);
  if (!f) return <span className="faint">–</span>;
  return (
    <span className={`amt${strong ? ' strong' : ''}`} title={`exact: ${f.base} ${unit.base} = ${f.exact} ${unit.symbol}`}>
      {f.lossy && <span aria-hidden="true">≈</span>}{f.text}{!hideUnit && <span className="amt-u"> {unit.symbol}</span>}
      {f.lossy && <span className="sr"> (approximately; exact value {f.exact} {unit.symbol})</span>}
    </span>
  );
}

/** Full address / id with copy + explorer link. Never truncated unless `short` (then the full value is in the title). */
export function Addr({ v, chainId, short, noCopy, what = 'address' }) {
  if (!v) return <span className="faint">–</span>;
  const url = chainId ? explorerAddr(chainId, v) : '';
  const shown = short && v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v;
  return (
    <span className="addr">
      <span className="mono-v" title={v}>{shown}</span>
      {!noCopy && <CopyButton text={v} label="Copy" aria={`Copy ${what}`} />}
      {url && <a className="btn sm ghost addr-x" href={url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${what} ${shown} in the block explorer (opens in a new tab)`}><Icon name="external" size={14} />Explorer</a>}
    </span>
  );
}

/** Semicircular budget gauge. Never colour alone: the percentage and a word (healthy / low / nearly out / exhausted) are always printed. */
export function Gauge({ label, remaining, cap, spent, unit, foot, sub, count, name }) {
  const frac = ratio(remaining, cap); const tone = gaugeTone(frac); const word = gaugeWord(frac, remaining);
  const pct = Math.round(frac * 100);
  const valueText = count ? `${remaining} of ${cap} left` : `${fmtAmount(remaining, unit.decimals)?.exact ?? '–'} ${unit.symbol} of ${fmtAmount(cap, unit.decimals)?.exact ?? '–'} ${unit.symbol} left`;
  return (
    <div className={`gauge ${tone}`} role="meter" aria-label={`${name ?? label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% remaining, ${word}. ${valueText}`}>
      <div className="g-label eyebrow">{label}</div>
      <svg viewBox="0 0 120 68" aria-hidden="true" focusable="false">
        <path d="M10 60A50 50 0 0 1 110 60" pathLength="100" className="g-track" />
        {frac > 0 && <path d="M10 60A50 50 0 0 1 110 60" pathLength="100" className="g-fill" style={{ strokeDasharray: `${Math.max(frac * 100, 0.8)} 100` }} />}
        <text x="60" y="55" textAnchor="middle" className="g-pct">{pct}%</text>
      </svg>
      <div className="g-val">{count ? <span className="amt strong">{remaining}<span className="amt-u"> of {cap}</span></span> : <Amt v={remaining} unit={unit} strong />}</div>
      <div className="g-sub">{count ? sub : <>of <Amt v={cap} unit={unit} /> cap{spent != null && <><br />spent <Amt v={spent} unit={unit} hideUnit /></>}</>}</div>
      <div className="g-foot"><span className={`g-word ${tone}`}>{word}</span>{foot && <span className="g-time"> · {foot}</span>}</div>
    </div>
  );
}

/** Two bars on ONE shared scale: what the agent holds vs what it could still draw from the vault. */
export function Liquidity({ agentBalance, available, maxDraw, unit }) {
  const a = toBig(agentBalance) ?? 0n; const v = toBig(available) ?? 0n; const top = a > v ? a : v;
  const w = (x) => (top === 0n ? 0 : Math.max(x > 0n ? 2 : 0, Math.round(ratio(x, top) * 100)));
  return (
    <div className="liq" role="group" aria-label="Agent wallet balance versus funds available in the vault">
      <div className="liq-row"><span className="eyebrow">In the vault · agent may draw</span><span className="liq-v"><Amt v={available} unit={unit} strong /></span><div className="liq-bar" aria-hidden="true"><i className="pool" style={{ width: `${w(v)}%` }} /></div></div>
      <div className="liq-row"><span className="eyebrow">In the agent wallet · pays its own gas</span><span className="liq-v"><Amt v={agentBalance} unit={unit} strong /></span><div className="liq-bar" aria-hidden="true"><i className="agent" style={{ width: `${w(a)}%` }} /></div></div>
      <p className="help liq-note">
        {(toBig(maxDraw) ?? 0n) > 0n ? <>Right now the agent may draw at most <Amt v={maxDraw} unit={unit} strong /> in one call (the smallest of its per-draw cap, remaining budget and vault balance).</> : <>Right now the agent may not draw anything: the budget, the mandate state or the vault balance blocks it.</>}
      </p>
    </div>
  );
}
