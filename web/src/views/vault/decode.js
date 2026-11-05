// Decode the EXACT calldata the plan asks a human to sign, in words, and cross-check it against the approved decision.
// Pure, dependency-free (no viem: this must not pull the wallet chunk). Selectors are keccak256(signature)[0..4] of the
// IAgentVault owner functions (contracts/evm/src/IAgentVault.sol), computed from the signatures below with viem's toFunctionSelector.
import { exactDecimal, fmtAmount, secsLabel, toBig, toSec, when } from './format.js';

export const SELECTORS = {
  '0x2fe8e348': { name: 'setMandate', sig: 'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' },
  '0x6214a32f': { name: 'allowTemplate', sig: 'allowTemplate(bytes32,string,uint256)' },
  '0xc173d16c': { name: 'disallowTemplate', sig: 'disallowTemplate(bytes32)' },
  '0xb6549f75': { name: 'revoke', sig: 'revoke()' },
  '0x8456cb59': { name: 'pause', sig: 'pause()' },
  '0x3f4ba83a': { name: 'unpause', sig: 'unpause()' },
  '0x2e1a7d4d': { name: 'withdraw', sig: 'withdraw(uint256)' },
  '0xf2fde38b': { name: 'transferOwnership', sig: 'transferOwnership(address)' },
  '0x79ba5097': { name: 'acceptOwnership', sig: 'acceptOwnership()' },
};
const word = (hex, i) => hex.slice(2 + 8 + i * 64, 2 + 8 + (i + 1) * 64);
const addr = (w) => `0x${w.slice(24)}`;
const num = (w) => BigInt(`0x${w}`).toString();
const utf8 = (hex) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))); } catch { return null; } };

/** @returns {{ok:boolean, name:string, sig?:string, args:Record<string,string>, words:string, error?:string}} */
export function decodeCall(data, value, unit) {
  const d = String(data ?? '0x').toLowerCase(); const amt = (x) => { const f = fmtAmount(x, unit.decimals); return f ? `${f.text} ${unit.symbol}` : x; };
  if (d === '0x' || d === '') return { ok: true, name: 'deposit', args: { value: String(value ?? '0') }, words: `Send ${amt(value ?? '0')} from your wallet to the vault as a plain transfer. This is the money the agent will be able to draw from, inside its budget.` };
  const sel = d.slice(0, 10); const meta = SELECTORS[sel];
  if (!meta) return { ok: false, name: 'unknown', args: {}, words: `Unrecognised call (selector ${sel}). It is not a known AgentVault owner function. Do not sign it.`, error: 'unknown selector' };
  const body = d.length - 10;
  try {
    switch (meta.name) {
      case 'setMandate': {
        if (body !== 7 * 64) throw new Error('unexpected calldata length');
        const a = { agent: addr(word(d, 0)), expiresAt: num(word(d, 1)), perDrawCap: num(word(d, 2)), periodSecs: num(word(d, 3)), periodCap: num(word(d, 4)), totalCap: num(word(d, 5)), maxDeploys: num(word(d, 6)) };
        return { ok: true, ...meta, args: a, words: `Set the mandate: agent ${a.agent} may draw at most ${amt(a.perDrawCap)} per call, ${amt(a.periodCap)} per ${secsLabel(a.periodSecs)} period and ${amt(a.totalCap)} in total, and deploy at most ${a.maxDeploys} allowlisted contract${a.maxDeploys === '1' ? '' : 's'}, until ${when(a.expiresAt)}. This replaces any previous mandate and resets usage.` };
      }
      case 'allowTemplate': {
        const off = Number(BigInt(`0x${word(d, 1)}`)); const len = Number(BigInt(`0x${d.slice(2 + 8 + off * 2, 2 + 8 + off * 2 + 64)}`));
        const label = utf8(d.slice(2 + 8 + off * 2 + 64, 2 + 8 + off * 2 + 64 + len * 2)); if (label === null) throw new Error('label is not valid UTF-8');
        const a = { templateId: `0x${word(d, 0)}`, label, deposit: num(word(d, 2)) };
        return { ok: true, ...meta, args: a, words: `Allowlist one contract template "${label}" (id ${a.templateId.slice(0, 12)}…): the agent may deploy exactly this bytecode and nothing else, with a deposit of ${amt(a.deposit)}.` };
      }
      case 'disallowTemplate': return { ok: true, ...meta, args: { templateId: `0x${word(d, 0)}` }, words: `Remove template ${`0x${word(d, 0)}`.slice(0, 12)}… from the allowlist.` };
      case 'withdraw': return { ok: true, ...meta, args: { amount: num(word(d, 0)) }, words: `Withdraw ${amt(num(word(d, 0)))} from the vault to the owner address.` };
      case 'revoke': return { ok: true, ...meta, args: {}, words: 'Revoke the current mandate. The agent can do nothing afterwards.' };
      case 'pause': return { ok: true, ...meta, args: {}, words: 'Pause the vault: agent operations are blocked, owner operations keep working.' };
      case 'unpause': return { ok: true, ...meta, args: {}, words: 'Unpause the vault.' };
      case 'transferOwnership': return { ok: true, ...meta, args: { newOwner: addr(word(d, 0)) }, words: `Start transferring ownership to ${addr(word(d, 0))} (they must accept).` };
      case 'acceptOwnership': return { ok: true, ...meta, args: {}, words: 'Accept ownership of the vault.' };
      default: throw new Error('unhandled');
    }
  } catch (e) { return { ok: false, ...meta, args: {}, words: `Could not decode ${meta.name}: ${e.message}. Do not sign it.`, error: e.message }; }
}

const eqAddr = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const eqNum = (a, b) => { const x = toBig(a); const y = toBig(b); return x !== null && y !== null && x === y; };

/**
 * Cross-check one plan transaction against the approved decision payload. Every row is a real comparison; nothing is assumed.
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
export function checkTx(tx, decoded, payload, chainNumeric) {
  const rows = []; const add = (name, ok, detail) => rows.push({ name, ok, detail });
  add('goes to the approved vault address', eqAddr(tx.to, payload?.vault?.address), `${tx.to} vs ${payload?.vault?.address ?? 'missing'}`);
  add('is for the approved chain', Number(tx.chainId) === chainNumeric, `chain ${tx.chainId} vs ${chainNumeric ?? 'missing'}`);
  if (!decoded.ok) { add('calldata is a known owner call', false, decoded.error ?? 'unknown'); return rows; }
  const m = payload?.mandate ?? {}; const a = decoded.args;
  if (decoded.name === 'setMandate') {
    add('agent equals the approved agent', eqAddr(a.agent, payload?.agent?.address), `${a.agent} vs ${payload?.agent?.address ?? 'missing'}`);
    add('expiry equals the approved expiry', toSec(a.expiresAt) === toSec(m.expiresAt), `${when(a.expiresAt)} vs ${when(m.expiresAt)}`);
    for (const k of ['perDrawCap', 'periodCap', 'totalCap']) add(`${k} equals the approved value`, eqNum(a[k], m[k]), `${a[k]} vs ${m[k] ?? 'missing'}`);
    add('period length equals the approved value', eqNum(a.periodSecs, m.periodSecs), `${a.periodSecs}s vs ${m.periodSecs ?? 'missing'}s`);
    add('max deploys equals the approved value', eqNum(a.maxDeploys, m.maxDeploys), `${a.maxDeploys} vs ${m.maxDeploys ?? 'missing'}`);
    add('carries no value', eqNum(tx.value ?? '0', 0), `value ${tx.value ?? '0'}`);
  } else if (decoded.name === 'allowTemplate') {
    const t = (payload?.templates ?? []).find((x) => String(x.templateId).toLowerCase() === a.templateId);
    add('template id is one of the approved templates', Boolean(t), a.templateId);
    if (t) { add('label equals the approved label', t.label === a.label, `"${a.label}" vs "${t.label}"`); add('deposit equals the approved deposit', eqNum(a.deposit, t.deposit ?? 0), `${a.deposit} vs ${t.deposit ?? 0}`); }
    add('carries no value', eqNum(tx.value ?? '0', 0), `value ${tx.value ?? '0'}`);
  } else if (decoded.name === 'deposit') {
    add('amount equals the approved funding', eqNum(a.value, payload?.fund?.amount), `${a.value} vs ${payload?.fund?.amount ?? 'missing'}`);
  } else {
    add('is part of an approved grant', false, `${decoded.name} is not part of a mandate grant; the decision does not authorise it`);
  }
  return rows;
}

/** Does the set of plan txs cover the whole approved decision (every template, the mandate, the funding)? */
export function coverage(txs, payload, unit) {
  const have = txs.map((t) => t.decoded);
  const rows = [{ name: 'a setMandate call is present exactly once', ok: have.filter((d) => d.name === 'setMandate').length === 1, detail: `${have.filter((d) => d.name === 'setMandate').length} found` }];
  for (const t of payload?.templates ?? []) rows.push({ name: `template "${t.label}" is allowlisted`, ok: have.some((d) => d.name === 'allowTemplate' && d.args.templateId === String(t.templateId).toLowerCase()), detail: String(t.templateId).slice(0, 14) + '…' });
  if (toBig(payload?.fund?.amount) > 0n) rows.push({ name: 'the vault is funded with the approved amount', ok: have.some((d) => d.name === 'deposit' && eqNum(d.args.value, payload.fund.amount)), detail: `${exactDecimal(payload.fund.amount, unit.decimals)} ${unit.symbol}` });
  return rows;
}
