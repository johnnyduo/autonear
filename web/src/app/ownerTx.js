// Owner transactions on the vault (EVM), sent from the owner's own wallet. wagmi actions, lazy-loaded; nothing here holds a key.
// Only these four owner functions are exposed, so the UI cannot be coaxed into sending anything else.
const FNS = { pause: 'function pause()', unpause: 'function unpause()', revoke: 'function revoke()', withdraw: 'function withdraw(uint256 amount)' };

export async function sendVaultTx({ chainId, address, fn, args = [] }) {
  if (!FNS[fn]) throw new Error('Unsupported action');
  const [{ walletConfig, chainById }, actions, { parseAbi }] = await Promise.all([import('../wallet/config.js'), import('wagmi/actions'), import('viem')]);
  const config = walletConfig();
  const target = chainById(chainId); if (!target) throw new Error('This network is not available in the wallet.');
  let conn = actions.getConnection(config);
  if (!conn.address) { const c = actions.getConnectors(config)[0]; if (!c) throw new Error('No wallet found.'); await actions.connect(config, { connector: c }); conn = actions.getConnection(config); }
  if (conn.chainId !== chainId) await actions.switchChain(config, { chainId });
  const hash = await actions.writeContract(config, { address, abi: parseAbi([FNS[fn]]), functionName: fn, args, chainId });
  await actions.waitForTransactionReceipt(config, { hash, chainId });
  return hash;
}
