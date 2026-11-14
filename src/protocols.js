import { evmEnabled } from './features.js';
// Protocol/target registry. `status` is honest: only entries marked "implemented" have code + tests in this repo.
export const PROTOCOLS = {
  near: {
    label: 'NEAR (Rust · near-sdk)', status: 'implemented', dir: 'contracts/near-registry',
    toolchain: 'rustc (pinned in rust-toolchain.toml) · wasm32-unknown-unknown · near-sdk 5',
    networks: [
      { id: 'near-testnet', label: 'NEAR testnet', rpc: 'https://rpc.testnet.fastnear.com', explorer: 'https://testnet.nearblocks.io/txns/', mainnet: false },
      { id: 'near-mainnet', label: 'NEAR mainnet', rpc: 'https://rpc.mainnet.near.org', explorer: 'https://nearblocks.io/txns/', mainnet: true },
    ],
    commands: { build: 'npm run contract:near:build', test: 'npm run contract:near:test' },
    // Mandate Vault (the Mandate Vault spec). The contract is in contracts/near-vault; the backend adapter is src/vault/near.js.
    // `backend` is the honest state of the BACKEND path: nothing here is exercised on a public NEAR testnet.
    vault: { contract: 'contracts/near-vault', unit: { symbol: 'NEAR', base: 'yoctoNEAR', decimals: 24 }, adapter: 'src/vault/near.js', backend: 'adapter not exercised by the evm-first backend tests', commands: { build: 'npm run contract:near-vault:build', test: 'npm run contract:near-vault:test' } },
  },
  evm: {
    label: 'EVM (Solidity · Foundry)', status: 'implemented', dir: 'contracts/evm',
    toolchain: 'solc 0.8.28 · cancun · via_ir · forge/anvil/cast',
    networks: [
      { id: 'evm:11155111', chainId: 11155111, label: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io/tx/', mainnet: false },
      { id: 'evm:84532', chainId: 84532, label: 'Base Sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/', mainnet: false },
      { id: 'evm:421614', chainId: 421614, label: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io/tx/', mainnet: false },
      { id: 'evm:11155420', chainId: 11155420, label: 'OP Sepolia', rpc: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io/tx/', mainnet: false },
      { id: 'evm:10143', chainId: 10143, label: 'Monad testnet', rpc: 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadexplorer.com/tx/', mainnet: false },
      { id: 'evm:97', chainId: 97, label: 'BNB Chain testnet', rpc: 'https://bsc-testnet-rpc.publicnode.com', explorer: 'https://testnet.bscscan.com/tx/', mainnet: false },
      { id: 'evm:31337', chainId: 31337, label: 'Local anvil (not a public chain)', rpc: 'http://127.0.0.1:8545', explorer: '', mainnet: false, local: true },
    ],
    commands: { build: 'npm run contract:evm:build', test: 'npm run contract:evm:test', e2e: 'npm run contract:evm:e2e' },
    // Mandate Vault (the Mandate Vault spec). Backend path exercised end to end only against a LOCAL anvil (31337), never a public testnet.
    vault: { contract: 'contracts/evm/src/AgentVault.sol', unit: { symbol: 'ETH', base: 'wei', decimals: 18 }, adapter: 'src/vault/evm.js', backend: 'tested against a local anvil only', commands: { build: 'npm run contract:evm:vault:build', test: 'npm run contract:evm:vault:test', e2e: 'npm run contract:evm:vault:e2e' } },
  },
  // Listed so the roadmap is visible. NO code exists for these yet; the UI shows them as "planned".
  solana: { label: 'Solana (Rust · Anchor)', status: 'planned', toolchain: 'anchor + solana-test-validator', networks: [] },
  sui: { label: 'Sui (Move)', status: 'planned', toolchain: 'sui move', networks: [] },
  aptos: { label: 'Aptos (Move)', status: 'planned', toolchain: 'aptos move', networks: [] },
  starknet: { label: 'Starknet (Cairo)', status: 'planned', toolchain: 'scarb + snforge', networks: [] },
  ton: { label: 'TON (Tolk/FunC)', status: 'planned', toolchain: 'blueprint', networks: [] },
};

// Regular EVM chains are off unless ENABLE_EVM=1 (see features.js): no network is registered, so nothing can target them.
if (!evmEnabled()) { PROTOCOLS.evm.networks = []; PROTOCOLS.evm.status = 'disabled'; }

export function findNetwork(chainId) {
  for (const [protocol, p] of Object.entries(PROTOCOLS)) for (const n of p.networks) if (n.id === chainId) return { protocol, ...n };
  return null;
}
export const protocolOf = (chainId) => findNetwork(chainId)?.protocol ?? null;
