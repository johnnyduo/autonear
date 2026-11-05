// Map a contract constructor ABI to the decision's registry parameters. Pure + defensive: any input we cannot map
// with certainty yields an error and the deploy button stays disabled (we never guess an argument).
import { isAddress } from 'viem';

const norm = (s) => String(s ?? '').toLowerCase().replace(/^_+/, '').replace(/^initial/, '').replace(/[_\s]/g, '');
const ALIAS = { owner: 'owner', admin: 'owner', proposer: 'proposer', maxspendcap: 'maxSpendCap', maxspend: 'maxSpendCap', spendcap: 'maxSpendCap', cap: 'maxSpendCap' };

/** @returns {{ok:boolean, args:any[], rows:{name:string,type:string,source:string,value:string}[], errors:string[]}} */
export function buildConstructorArgs(abi, registry) {
  const errors = []; const rows = []; const args = [];
  if (!Array.isArray(abi)) return { ok: false, args, rows, errors: ['The API returned no ABI for this decision, so the constructor cannot be encoded.'] };
  const ctor = abi.find((x) => x.type === 'constructor');
  if (!ctor) return { ok: false, args, rows, errors: ['The ABI has no constructor entry.'] };
  if (!registry || typeof registry !== 'object') return { ok: false, args, rows, errors: ['The decision payload has no registry parameters.'] };
  for (const inp of ctor.inputs ?? []) {
    const key = ALIAS[norm(inp.name)];
    const raw = key ? registry[key] : undefined;
    if (!key || raw === undefined || raw === null || raw === '') { errors.push(`Constructor input "${inp.name || '(unnamed)'}" (${inp.type}) cannot be matched to a registry parameter (owner, proposer, maxSpendCap).`); continue; }
    try {
      if (inp.type === 'address') { if (!isAddress(String(raw))) throw new Error(`"${raw}" is not a valid EVM address`); args.push(String(raw)); }
      else if (/^u?int\d*$/.test(inp.type)) args.push(BigInt(String(raw)));
      else throw new Error(`unsupported constructor type ${inp.type}`);
      rows.push({ name: inp.name, type: inp.type, source: `registry.${key}`, value: String(raw) });
    } catch (e) { errors.push(`Constructor input "${inp.name}": ${e.message}`); }
  }
  return { ok: errors.length === 0 && args.length === (ctor.inputs ?? []).length, args, rows, errors };
}

export async function sha256Hex(hexWithPrefix) {
  const hex = String(hexWithPrefix ?? '').replace(/^0x/, '');
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((x) => parseInt(x, 16)));
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
