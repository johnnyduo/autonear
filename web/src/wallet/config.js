// Wallet layer config. Memoized at MODULE scope: wagmi keeps connection state inside the config object,
// so a second createConfig() mid-session would silently strand the first one's listeners.
// Injected wallets only (EIP-6963 discovery + the legacy window.ethereum fallback). No WalletConnect, no ConnectKit,
// therefore nothing here depends on a project id. Testnets and local anvil ONLY: no mainnet chain is configured anywhere.
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors/injected';
import { sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, monadTestnet, bscTestnet, foundry } from 'wagmi/chains';

export const CHAINS = [sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, monadTestnet, bscTestnet, foundry];

let cached;
export function walletConfig() {
  cached ??= createConfig({
    chains: CHAINS,
    connectors: [injected()],
    multiInjectedProviderDiscovery: true, // EIP-6963: every installed wallet announces itself as its own connector
    transports: Object.fromEntries(CHAINS.map((c) => [c.id, http()])),
    ssr: false,
  });
  return cached;
}

/** 'evm:84532' -> 84532 (null for anything else, e.g. NEAR networks). */
export const chainIdOf = (chain_id) => { const m = /^evm:(\d+)$/.exec(chain_id ?? ''); return m ? Number(m[1]) : null; };
export const chainById = (id) => CHAINS.find((c) => c.id === id) ?? null;
