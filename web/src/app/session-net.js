// Which network the connected wallet is on, as far as AutoNEAR cares: NEAR testnet through the Ethereum-wallet standard is chain 398 (0x18e).
export const NEAR_CHAIN_ID = 398;

/** 'near' | 'other' | 'unknown' for an eth_chainId answer (hex string or number). */
export function netOf(chainId) {
  if (chainId == null || chainId === '') return 'unknown';
  const n = Number(chainId);
  if (!Number.isFinite(n)) return 'unknown';
  return n === NEAR_CHAIN_ID ? 'near' : 'other';
}
