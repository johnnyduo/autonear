// Pure logic behind the Vault page: which state the vault is in (and what the owner should do next), whether the agent is running low on fuel, how much of the budget is used, and
// whether an amount typed for "take back" is acceptable. No React here, so it can be tested.
import { exactDecimal, parseUnits, ratio, toBig } from '../views/vault/format.js';

export const shortAddr = (a, head = 8, tail = 6) => { const s = String(a ?? ''); return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s; };

/** The agent keeps working while it holds a little of the chain's coin for fees. Below this it is "running low" (NEAR only: the other chains pay differently). */
export const LOW_FUEL = Object.freeze({ near: 5n * 10n ** 22n /* 0.05 NEAR */ });

/** 'low' | 'ok' | 'unknown'. */
export function fuelState(v, protocol) {
  const have = toBig(v?.agentBalance); const floor = LOW_FUEL[protocol];
  if (have === null || floor === undefined) return 'unknown';
  return have < floor ? 'low' : 'ok';
}

/** { used, total, ratio } of the total budget, or null when no limits are on. */
export function budgetUse(v) {
  const m = v?.mandate; if (!m || m.revoked) return null;
  const total = toBig(m.totalCap); const used = toBig(v?.usage?.totalSpent) ?? 0n; if (total === null || total <= 0n) return null;
  return { used, total, ratio: ratio(used, total) };
}

/**
 * The single most important thing about this vault right now, in plain words, with the next step.
 * Order matters: waiting for you to accept > paused on chain > agent stopped > no limits > working.
 * `action` is what the primary button does ('accept' | 'unpause' | 'start' | 'limits' | null); the page decides whether this wallet may press it.
 */
export function vaultStatus({ pendingMine = false, paused = false, stopped = false, live = false, demo = false } = {}) {
  if (pendingMine) return { key: 'pending', tone: 'warn', chip: 'Waiting for you', title: 'This vault is waiting for you to take it over', text: 'Until you accept ownership, the previous owner still controls it. Accepting makes you the owner.', action: 'accept' };
  if (paused) return { key: 'paused', tone: 'bad', chip: 'Paused on chain', title: 'The vault is paused', text: 'Nothing can leave it, not even through the agent’s own key. Un-pause it when you are ready.', action: 'unpause' };
  if (stopped) return { key: 'stopped', tone: 'warn', chip: 'Agent stopped', title: 'The agent is stopped', text: 'It will not do anything until you start it again. The limits and the funds are untouched.', action: 'start' };
  if (!live) return { key: 'nolimits', tone: 'warn', chip: 'No limits set', title: 'The agent has no budget yet', text: 'With no limits set, the agent cannot take anything from this vault. Set its limits to let it work.', action: demo ? null : 'limits' };
  return { key: 'live', tone: 'ok', chip: 'Limits are on', title: 'The agent is working inside your limits', text: 'It can only spend what the limits below allow. They are enforced on the blockchain, not by our server.', action: null };
}

/**
 * Check what the owner typed for "take back". Returns { base: bigint|null, error: string }.
 * An empty box is not an error (nothing to do yet); anything that cannot work says why.
 */
export function withdrawCheck(text, available, decimals) {
  const s = String(text ?? '').trim(); if (!s) return { base: null, error: '' };
  const base = parseUnits(s, decimals);
  if (base === null) return { base: null, error: decimals === 0 ? 'Use a whole number.' : `Use a number with at most ${decimals} decimals, like 0.5.` };
  if (base <= 0n) return { base: null, error: 'Enter more than zero.' };
  const have = toBig(available);
  if (have !== null && base > have) return { base: null, error: 'That is more than the vault can give back right now.' };
  return { base, error: '' };
}

/** The exact amount for the "Max" button, or '' when unknown. */
export const maxText = (available, decimals) => { const b = toBig(available); return b === null || b <= 0n ? '' : exactDecimal(b, decimals); };

/**
 * A vault that can pay people spends a tiny NEAR deposit (1 yoctoNEAR) on every payment, out of its SPENDABLE NEAR: what it holds minus its storage cost (about 3.4 NEAR for this build)
 * minus a 1 NEAR reserve. A vault funded only with the token has none, and every payment is refused with "no spendable NEAR". Returns '' when all is well, else the plain explanation.
 */
export function payFuelWarning(v) {
  if (!v?.payouts) return '';
  const have = toBig(v.available); if (have === null || have > 0n) return '';
  return 'No payment can go out yet. The vault has no spendable NEAR: every payment needs a tiny NEAR deposit, and the vault keeps back what its storage costs (about 3.4 NEAR) plus a 1 NEAR reserve. Send it more NEAR until “In the vault” shows an amount.';
}

/** The note shown with the steps of a grant that lets the agent pay people. '' for any other grant. */
export function payoutsNeedNote(payload) {
  const n = Array.isArray(payload?.payouts?.tokens) ? payload.payouts.tokens.length : 0; if (!n) return '';
  return 'This grant lets the agent pay people. Besides the tokens, the vault also needs NEAR it can spend: it keeps back its storage cost (about 3.4 NEAR) and a 1 NEAR reserve, and every payment uses a tiny NEAR deposit. Fund the vault with NEAR above that, or no payment can go out.';
}
