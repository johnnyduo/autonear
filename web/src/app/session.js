// Wallet-first sign-in. wagmi is lazy-loaded on first click so it stays out of the landing bundle.
// Flow: connect an injected wallet -> server challenge -> personal_sign (free, no transaction) -> short-lived owner session.
// A wallet that is not the vault owner is "connected, read-only": no token is issued and every write control stays disabled.
import { useSyncExternalStore } from 'react';
import { api, setToken } from '../api.js';

const KEY = 'autonear.owner';
let state = { address: null, isOwner: false, exp: 0, busy: false, error: '' };
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const set = (p) => { state = { ...state, ...p }; emit(); };
try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s?.address && s.exp > Date.now()) state = { ...state, address: s.address, isOwner: Boolean(s.isOwner), exp: s.exp }; } catch { /* storage may throw */ }
const persist = () => { try { state.address ? sessionStorage.setItem(KEY, JSON.stringify({ address: state.address, isOwner: state.isOwner, exp: state.exp })) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } };

export const useOwner = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

async function wagmi() {
  const [{ walletConfig }, actions] = await Promise.all([import('../wallet/config.js'), import('wagmi/actions')]);
  return { config: walletConfig(), ...actions };
}

/** Wallets the browser announced (EIP-6963) plus the legacy injected one. */
export async function listWallets() {
  const { config, getConnectors } = await wagmi();
  return getConnectors(config).map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? null }));
}

export async function connectAndSignIn(connectorId) {
  set({ busy: true, error: '' });
  try {
    const { config, getConnectors, connect, getConnection, signMessage } = await wagmi();
    const connectors = getConnectors(config);
    const connector = connectors.find((c) => c.id === connectorId) ?? connectors[0];
    if (!connector) throw new Error('NO_WALLET');
    if (!getConnection(config).address) await connect(config, { connector });
    const address = getConnection(config).address;
    if (!address) throw new Error('The wallet did not share an address.');
    const ch = await api('/api/auth/challenge', { method: 'POST', body: { address } });
    const signature = await signMessage(config, { message: ch.message });
    const r = await api('/api/auth/session', { method: 'POST', body: { address, message: ch.message, signature } });
    if (r.token) setToken(r.token);
    set({ address: r.address ?? address.toLowerCase(), isOwner: Boolean(r.isOwner), exp: r.exp ?? Date.now() + 8 * 3600_000, busy: false });
    persist();
    return r;
  } catch (e) {
    const msg = e.message === 'NO_WALLET' ? 'NO_WALLET' : /user rejected|denied/i.test(e.message) ? 'You closed the wallet window. Nothing was signed.' : e.message;
    set({ busy: false, error: msg });
    throw e;
  }
}

export async function signOut() {
  try { const { config, disconnect } = await wagmi(); await disconnect(config); } catch { /* not connected */ }
  setToken('');
  set({ address: null, isOwner: false, exp: 0, error: '' });
  persist();
}
