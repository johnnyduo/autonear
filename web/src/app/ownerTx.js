// Owner transactions on the vault (EVM), sent from the owner's own wallet. wagmi actions, lazy-loaded; nothing here holds a key.
// Only these four owner functions are exposed, so the UI cannot be coaxed into sending anything else.
const FNS = { pause: 'function pause()', unpause: 'function unpause()', revoke: 'function revoke()', withdraw: 'function withdraw(uint256 amount)' };

export async function sendVaultTx({ chainId, address, fn, args = [], expect }) {
  if (!FNS[fn]) throw new Error('Unsupported action');
  const [{ walletConfig, chainById }, actions, { parseAbi }] = await Promise.all([import('../wallet/config.js'), import('wagmi/actions'), import('viem')]);
  const config = walletConfig();
  const target = chainById(chainId); if (!target) throw new Error('This network is not available in the wallet.');
  let conn = actions.getConnection(config);
  if (!conn.address) { const c = actions.getConnectors(config)[0]; if (!c) throw new Error('No wallet found.'); await actions.connect(config, { connector: c }); conn = actions.getConnection(config); }
  if (expect && conn.address?.toLowerCase() !== String(expect).toLowerCase()) throw new Error(`Switch your wallet to ${expect.slice(0, 6)}…${expect.slice(-4)} (the owner) and try again.`);
  if (conn.chainId !== chainId) await actions.switchChain(config, { chainId });
  const hash = await actions.writeContract(config, { address, abi: parseAbi([FNS[fn]]), functionName: fn, args, chainId });
  await actions.waitForTransactionReceipt(config, { hash, chainId });
  return hash;
}

// --- NEAR vaults owned by an Ethereum-style account (0x...): the owner signs in MetaMask, the relayer submits (NEP-518). See ../wallet/nearEth.js.
const NEAR_FNS = new Set(['accept_ownership', 'pause', 'unpause', 'revoke', 'withdraw', 'allow_template', 'set_mandate']);

async function walletProvider(expect) {
  const [{ walletConfig }, actions] = await Promise.all([import('../wallet/config.js'), import('wagmi/actions')]);
  const config = walletConfig(); let conn = actions.getConnection(config);
  if (!conn.address) { await actions.reconnect(config).catch(() => {}); conn = actions.getConnection(config); } // after a page reload the wallet used at sign-in is restored first
  if (!conn.address) { const c = actions.getConnectors(config)[0]; if (!c) throw new Error('No wallet found.'); await actions.connect(config, { connector: c }); conn = actions.getConnection(config); }
  if (expect && conn.address?.toLowerCase() !== String(expect).toLowerCase()) throw new Error(`Switch your wallet to ${expect.slice(0, 6)}…${expect.slice(-4)} and try again.`);
  const provider = await conn.connector.getProvider(); if (!provider?.request) throw new Error('The wallet did not offer a connection to sign with.');
  return provider;
}

/** One owner action on a NEAR vault (or a plain transfer when method is null). Resolves to { hash, explorer } once the network confirmed it; throws with plain words otherwise. */
export async function sendNearTx({ account, receiver, method, args = {}, deposit = 0n, gas, onStage }) {
  if (method && !NEAR_FNS.has(method)) throw new Error('Unsupported action');
  const near = await import('../wallet/nearEth.js'); const provider = await walletProvider(account);
  onStage?.('sign');
  const { hash } = await near.callNear({ provider, account: account.toLowerCase(), receiver, method, args, deposit, gas });
  onStage?.('wait');
  const r = await near.waitForReceipt(hash);
  if (!r.ok) throw new Error('The network did not accept this step. Nothing was changed.');
  return { hash, explorer: near.explorerTx(hash) };
}

/** The one-time relayer setup through a raw-hash signature (eth_sign), for wallets (MetaMask) that refuse to let a website send it to the wallet's own address. */
export async function sendSetupSigned({ account }) {
  const near = await import('../wallet/nearEth.js'); const provider = await walletProvider(account);
  return near.sendSetupWithEthSign({ provider, account: account.toLowerCase() });
}

/**
 * Mint the free TEST token (mock USDC) straight into a vault: one wallet signature. The token's own rules are checked first so the wallet is not opened for something that cannot work
 * (more than the per-call ceiling). A receiver that is not registered on the token yet gets its storage paid with 0.0025 NEAR attached (the token refunds the excess).
 */
export async function mintTestToken({ account, token, to, base, decimals }) {
  const { mintCall } = await import('./vaultView.js');
  const near = await import('../wallet/nearEth.js'); const provider = await walletProvider(account);
  const registered = await near.viewNear({ contract: token, method: 'storage_balance_of', args: { account_id: to } });
  const call = mintCall({ token, to, base, decimals, registered }); // throws for anything the token would refuse, before the wallet opens
  const { hash } = await near.callNear({ provider, account: account.toLowerCase(), ...call });
  const r = await near.waitForReceipt(hash); if (!r.ok) throw new Error('The token did not accept the mint. Nothing was added.');
  return { hash, explorer: near.explorerTx(hash) };
}

/** Read the vault's own config (owner, pending owner, paused) straight from NEAR. */
export async function readNearVault(vault) { const near = await import('../wallet/nearEth.js'); return near.viewNear({ contract: vault, method: 'config' }); }
