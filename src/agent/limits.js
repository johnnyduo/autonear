// Defense-in-depth limits enforced INSIDE the signer, before anything is signed. The vault enforces the same rules
// on-chain; this layer exists so that a bug or prompt-injection in a higher layer cannot even produce a signature for
// the wrong target, the wrong method, or an unbounded fee.
import { isValidAddress } from './secp256k1.js';

/** Hard-coded: the agent can only ever sign these two vault methods, whatever `limits.allowedMethods` says. */
export const VAULT_METHODS = Object.freeze(['draw', 'deploy']);

export class LimitError extends Error {
  constructor(code, msg) { super(`limit ${code}: ${msg}`); this.name = 'LimitError'; this.code = code; }
}

const toBig = (v, what) => {
  try {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('unsafe');
    const b = BigInt(v);
    if (b < 0n) throw new Error('neg');
    return b;
  } catch { throw new LimitError('bad_limits', `${what} must be a non-negative integer`); }
};
export const asBigInt = toBig;

/**
 * Validate a limits object and return a normalised, frozen copy.
 * limits = { maxFeePerTx (base units: wei / yoctoNEAR, REQUIRED), allowedTargets: [..] (REQUIRED, non-empty), allowedMethods?: ['draw','deploy'] }
 */
export function normalizeLimits(chain, limits) {
  if (!limits || typeof limits !== 'object') throw new LimitError('bad_limits', 'limits are required');
  if (limits.maxFeePerTx === undefined || limits.maxFeePerTx === null) throw new LimitError('bad_limits', 'maxFeePerTx is required (hard fee ceiling per transaction)');
  const maxFeePerTx = toBig(limits.maxFeePerTx, 'maxFeePerTx');
  if (!Array.isArray(limits.allowedTargets) || limits.allowedTargets.length === 0) throw new LimitError('bad_limits', 'allowedTargets must list the vault address/account');
  const allowedTargets = limits.allowedTargets.map((t) => {
    if (typeof t !== 'string' || !t) throw new LimitError('bad_limits', 'allowedTargets entries must be strings');
    if (chain === 'evm') { if (!isValidAddress(t)) throw new LimitError('bad_limits', 'allowedTargets entry is not a valid EVM address'); return t.toLowerCase(); }
    return t;
  });
  const requested = limits.allowedMethods ?? VAULT_METHODS;
  if (!Array.isArray(requested) || requested.length === 0) throw new LimitError('bad_limits', 'allowedMethods must be a non-empty list');
  for (const m of requested) if (!VAULT_METHODS.includes(m)) throw new LimitError('method_not_permitted', `method "${String(m).slice(0, 40)}" can never be allowed for the agent`);
  return Object.freeze({ maxFeePerTx, allowedTargets: Object.freeze(allowedTargets), allowedMethods: Object.freeze([...requested]) });
}

const CALL_KEYS = new Set(['method', 'target', 'args']);
const ARG_KEYS = { draw: new Set(['amount']), deploy: { evm: new Set(['template', 'salt', 'code']), near: new Set(['template', 'name', 'code']) } };

/** Throws LimitError unless the call is exactly a vault draw/deploy to an allowed target. Returns the normalised target. */
export function enforceCall(chain, callSpec, limits) {
  if (!callSpec || typeof callSpec !== 'object' || Array.isArray(callSpec)) throw new LimitError('bad_call', 'callSpec must be an object');
  for (const k of Object.keys(callSpec)) if (!CALL_KEYS.has(k)) throw new LimitError('bad_call', `unexpected field "${k.slice(0, 40)}" (no value, data, gas or to overrides are accepted)`);
  const { method, target, args } = callSpec;
  if (!VAULT_METHODS.includes(method) || !limits.allowedMethods.includes(method)) throw new LimitError('method_not_permitted', `method "${String(method).slice(0, 40)}" is not allowed`);
  if (typeof target !== 'string') throw new LimitError('target_not_permitted', 'target must be a string');
  const t = chain === 'evm' ? target.toLowerCase() : target;
  if (!limits.allowedTargets.includes(t)) throw new LimitError('target_not_permitted', `target ${target.slice(0, 80)} is not the configured vault`);
  if (!args || typeof args !== 'object') throw new LimitError('bad_call', 'args are required');
  const allowedArgs = method === 'draw' ? ARG_KEYS.draw : ARG_KEYS.deploy[chain];
  for (const k of Object.keys(args)) if (!allowedArgs.has(k)) throw new LimitError('bad_call', `unexpected argument "${k.slice(0, 40)}" for ${method}`);
  return t;
}

/** Fee ceiling check on the worst-case fee (gas limit x max price), in base units. */
export function enforceFee(worstCaseFee, limits) {
  if (worstCaseFee > limits.maxFeePerTx) throw new LimitError('fee_ceiling', `worst-case fee ${worstCaseFee} exceeds maxFeePerTx ${limits.maxFeePerTx}`);
}
