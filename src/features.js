// Scope switch. The product runs on NEAR testnet only; EVM wallets sign through NEAR's Ethereum-wallet standard, so no regular EVM chain is needed.
// The EVM contract and adapter code is still in the repo. ENABLE_EVM=1 turns the EVM networks back on (development and its tests only).
export const evmEnabled = (env = process.env) => env.ENABLE_EVM === '1';
