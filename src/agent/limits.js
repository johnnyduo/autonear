// Defense-in-depth limits enforced INSIDE the signer, before anything is signed. The vault enforces the same rules
// on-chain; this layer exists so that a bug or prompt-injection in a higher layer cannot even produce a signature for
// the wrong target, the wrong method, or an unbounded fee.
import { isValidAddress } from './secp256k1.js';

/** Hard-coded: the agent can only ever sign these vault methods, whatever `limits.allowedMethods` says. `pay` (token payout, payouts-build NEAR vault) is
 *  the ceiling of what can be allowed, never the default: a caller must list it in `allowedMethods` on purpose (see DEFAULT_METHODS). */
export const VAULT_METHODS = Object.freeze(['draw', 'deploy', 'pay']);
/** What `allowedMethods` defaults to when the caller names none: exactly the v1 vault's two methods, so existing callers cannot start paying by accident. */
export const DEFAULT_METHODS = Object.freeze(['draw', 'deploy']);
export const MAX_PAY_MEMO_BYTES = 128;
const U128_MAX = (1n << 128n) - 1n;
const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** A NEAR account id as the vault's `pay` takes it: 2..64 chars, never the reserved `system` / zero account. */
export const isPayAccount = (a) => typeof a === 'string' && a.length >= 2 && a.length <= 64 && NEAR_ACCOUNT_RE.test(a) && a !== 'system' && !/^0{64}$/.test(a);

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
 * limits = { maxFeePerTx (base units: wei / yoctoNEAR, REQUIRED), allowedTargets: [..] (REQUIRED, non-empty), allowedMethods?: subset of ['draw','deploy','pay'] (default ['draw','deploy']; 'pay' is NEAR only) }
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
  const requested = limits.allowedMethods ?? DEFAULT_METHODS;
  if (!Array.isArray(requested) || requested.length === 0) throw new LimitError('bad_limits', 'allowedMethods must be a non-empty list');
  for (const m of requested) if (!VAULT_METHODS.includes(m)) throw new LimitError('method_not_permitted', `method "${String(m).slice(0, 40)}" can never be allowed for the agent`);
  if (chain !== 'near' && requested.includes('pay')) throw new LimitError('method_not_permitted', 'method "pay" exists only on NEAR payouts vaults');
  return Object.freeze({ maxFeePerTx, allowedTargets: Object.freeze(allowedTargets), allowedMethods: Object.freeze([...requested]) });
}

const CALL_KEYS = new Set(['method', 'target', 'args']);
const ARG_KEYS = { draw: new Set(['amount']), pay: new Set(['token', 'to', 'amount', 'memo']), deploy: { evm: new Set(['template', 'salt', 'code']), near: new Set(['template', 'name', 'code']) } };

/** Throws LimitError unless the call is exactly a vault draw/deploy/pay to an allowed target. Returns the normalised target. */
export function enforceCall(chain, callSpec, limits) {
  if (!callSpec || typeof callSpec !== 'object' || Array.isArray(callSpec)) throw new LimitError('bad_call', 'callSpec must be an object');
  for (const k of Object.keys(callSpec)) if (!CALL_KEYS.has(k)) throw new LimitError('bad_call', `unexpected field "${k.slice(0, 40)}" (no value, data, gas or to overrides are accepted)`);
  const { method, target, args } = callSpec;
  if (!VAULT_METHODS.includes(method) || !limits.allowedMethods.includes(method)) throw new LimitError('method_not_permitted', `method "${String(method).slice(0, 40)}" is not allowed`);
  if (typeof target !== 'string') throw new LimitError('target_not_permitted', 'target must be a string');
  const t = chain === 'evm' ? target.toLowerCase() : target;
  if (!limits.allowedTargets.includes(t)) throw new LimitError('target_not_permitted', `target ${target.slice(0, 80)} is not the configured vault`);
  if (!args || typeof args !== 'object') throw new LimitError('bad_call', 'args are required');
  if (method === 'pay' && chain !== 'near') throw new LimitError('method_not_permitted', 'method "pay" exists only on NEAR payouts vaults');
  const allowedArgs = method === 'draw' ? ARG_KEYS.draw : method === 'pay' ? ARG_KEYS.pay : ARG_KEYS.deploy[chain];
  for (const k of Object.keys(args)) if (!allowedArgs.has(k)) throw new LimitError('bad_call', `unexpected argument "${k.slice(0, 40)}" for ${method}`);
  if (method === 'pay') assertPayArgs(args, t);
  return t;
}

/** Exact shape of a vault `pay` call: token + to (NEAR accounts, neither the vault itself), amount (positive integer, fits u128), optional memo (<= 128 bytes). */
function assertPayArgs(args, vault) {
  for (const k of ['token', 'to']) {
    if (!isPayAccount(args[k])) throw new LimitError('bad_call', `pay.${k} must be a NEAR account id`);
    if (args[k] === vault) throw new LimitError('bad_call', `pay.${k} cannot be the vault itself`);
  }
  if (args.token === args.to) throw new LimitError('bad_call', 'pay.token and pay.to must differ');
  let a; try { a = typeof args.amount === 'bigint' || typeof args.amount === 'string' || (typeof args.amount === 'number' && Number.isSafeInteger(args.amount)) ? BigInt(args.amount) : null; } catch { a = null; }
  if (a === null || a <= 0n || a > U128_MAX) throw new LimitError('bad_call', 'pay.amount must be a positive integer that fits u128');
  if (args.memo !== undefined && args.memo !== null && (typeof args.memo !== 'string' || new TextEncoder().encode(args.memo).length > MAX_PAY_MEMO_BYTES)) throw new LimitError('bad_call', `pay.memo must be text of at most ${MAX_PAY_MEMO_BYTES} bytes`);
}

/** Fee ceiling check on the worst-case fee (gas limit x max price), in base units. */
export function enforceFee(worstCaseFee, limits) {
  if (worstCaseFee > limits.maxFeePerTx) throw new LimitError('fee_ceiling', `worst-case fee ${worstCaseFee} exceeds maxFeePerTx ${limits.maxFeePerTx}`);
}
