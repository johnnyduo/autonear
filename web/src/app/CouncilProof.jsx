// Proof popup for the Council page. Shows what a seat (or the verdict) really is, a digest anyone can recompute, and what is really on a chain.
// Honesty: a seat is an off-chain rule in src/council.js. It is not a contract and not an agent with a key, so there is nothing of it to deploy.
// The chain facts are (1) this product's deployment, when one exists in the stored data, and (2) the recorded NEAR testnet run of the vault and the registry.
import { Dialog } from '../ui.jsx';
import run from './testnetRun.json';

const EXP = 'https://testnet.nearblocks.io';
const q = (x) => Math.round(x * 100);
const STANCE = { back: 'backs it', abstain: 'unsure', object: 'objects' };
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const acct = (a) => <a href={`${EXP}/address/${a}`} target="_blank" rel="noreferrer noopener" className="mono-v">{a.length > 64 ? `${a.slice(0, 14)}…${a.slice(-8)}` : a}</a>;

function Chain({ journey, oppId }) {
  const dep = journey?.oppId === oppId ? journey?.deployment : null; const A = run.accounts ?? {};
  const neg = run.txs.filter((t) => !t.ok).length;
  return (
    <>
      <h4 className="cn-ph">On a chain</h4>
      <div className="cn-pbox"><b>This product</b>
        {dep ? <p>Deployed on {dep.network} at <span className="mono-v">{dep.account}</span> ({dep.status}). {dep.explorer && <a href={dep.explorer} target="_blank" rel="noreferrer noopener">Open on the explorer</a>}</p>
          : <p>Not deployed yet, so there is no transaction to show. A deployment appears here, with its transaction link, the moment the owner (or the agent inside the owner limits in Auto) executes the request.</p>}</div>
      <div className="cn-pbox"><b>The contracts this product would use (NEAR testnet, recorded run)</b>
        <dl className="cn-pdl"><dt>Vault</dt><dd>{A.vault ? acct(A.vault) : '—'}</dd><dt>Registry</dt><dd>{A.registry ? acct(A.registry) : '—'}</dd><dt>Owner</dt><dd>{A.owner ? acct(A.owner) : '—'}</dd></dl>
        <p className="faint">These were deployed by a scripted run on {run.startedAt.slice(0, 10)} with a demo owner key (automation, not a human signature). {run.txs.length} transactions: {run.txs.length - neg} succeeded and {neg} were refused on purpose to show the limits hold. This run does not contain the council&rsquo;s votes.</p>
        <details><summary>All {run.txs.length} transactions</summary>
          <ul className="cn-ptx">{run.txs.map((t) => <li key={t.hash}><a href={t.explorer} target="_blank" rel="noreferrer noopener" className="mono-v">{short(t.hash)}</a><span>{t.ok ? '' : 'refused · '}{t.label}</span></li>)}</ul></details>
      </div>
      <p className="faint">The council&rsquo;s votes are not written to a chain yet. Their digest is published by the API so anyone can check it; anchoring the verdict digest in the registry receipt is a possible next step.</p>
    </>
  );
}

export default function ProofDialog({ entry, seat, council, journey, onClose }) {
  const info = seat ? council.seats?.find((s) => s.role === seat.role) : null; const label = seat?.label ?? 'Verdict';
  return (
    <Dialog title={seat ? `${label} seat` : `Verdict: ${entry.title}`} onClose={onClose} wide>
      <div className="cn-proof">
        {seat ? (
          <>
            <p className="cn-pq">{info?.question ?? 'One question, answered with a number from stored data.'}</p>
            <div className="cn-pvote"><b>{q(seat.support)}</b><span>out of 100 · {STANCE[seat.stance]} · weight {Math.round(seat.weight * 100)}%</span></div>
            <p>{seat.reason}</p>
            <dl className="cn-pdl"><dt>Seat id</dt><dd className="mono-v">{info?.id ?? `autonear:council-seat:${seat.role}@1`}</dd><dt>What it is</dt><dd>An off-chain rule in <span className="mono-v">src/council.js</span>. Not a contract, not an AI agent, and it holds no key.</dd><dt>Vote digest</dt><dd className="mono-v">{seat.digest ?? 'available after the next council session'}</dd></dl>
          </>
        ) : (
          <>
            <div className="cn-pvote"><b>{q(entry.support)}</b><span>out of 100 · {entry.verdict.toUpperCase()}</span></div>
            <p>{entry.reason}</p>
            <dl className="cn-pdl"><dt>Verdict digest</dt><dd className="mono-v">{entry.digest ?? 'available after the next council session'}</dd><dt>Rules hash</dt><dd className="mono-v">{council.rulesHash ?? 'available after the next council session'}</dd></dl>
          </>
        )}
        <h4 className="cn-ph">How to check it yourself</h4>
        <ol className="cn-pol"><li>Open <a href="/api/council" target="_blank" rel="noreferrer noopener" className="mono-v">/api/council</a>: the same numbers and digests are there, read only.</li><li>Recompute the digest from the vote with SHA-256 over the sorted JSON, as written in <span className="mono-v">src/council.js</span>. The same stored data always gives the same digest, and any change to a vote or rule changes it.</li></ol>
        <p className="faint">Ids such as the seat id are AutoNEAR&rsquo;s own names, not EIP, ERC or NEP numbers. The only standard in use on chain is NEP-297 (event format) in the registry contract.</p>
        <Chain journey={journey} oppId={entry.oppId} />
      </div>
    </Dialog>
  );
}
