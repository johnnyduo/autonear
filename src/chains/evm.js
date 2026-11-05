import { jsonRpc, check } from './common.js';

const strip = (h) => (h ?? '').toLowerCase().replace(/^0x/, '');

/** Verify a human-signed EVM contract creation tx: success, right chain, runtime code == attested deployedBytecode. */
export async function verifyEvmDeploy({ rpc, chainId, txHash, expectedDeployer, expectedDeployedBytecode, expectedOwner, expectedProposer, fetchImpl }) {
  const checks = [];
  const cid = parseInt(await jsonRpc('monitor', rpc, 'eth_chainId', [], { fetchImpl }), 16);
  checks.push(check('rpc chain id matches decision', cid === chainId, `${cid} vs ${chainId}`));
  const rcpt = await jsonRpc('monitor', rpc, 'eth_getTransactionReceipt', [txHash], { fetchImpl });
  if (!rcpt) return { ok: false, account: null, checks: [...checks, check('receipt found', false, 'tx not mined or unknown to this RPC')], observedAt: Date.now() };
  checks.push(check('tx succeeded (status 0x1)', rcpt.status === '0x1', rcpt.status));
  checks.push(check('creates a contract', Boolean(rcpt.contractAddress), rcpt.contractAddress ?? 'none'));
  checks.push(check('deployer is the signer bound at approval', Boolean(expectedDeployer) && strip(rcpt.from) === strip(expectedDeployer), `${rcpt.from} vs ${expectedDeployer}`));
  const head = parseInt(await jsonRpc('monitor', rpc, 'eth_blockNumber', [], { fetchImpl }), 16);
  checks.push(check('≥1 confirmation', head >= parseInt(rcpt.blockNumber, 16), `head ${head} / block ${parseInt(rcpt.blockNumber, 16)}`));
  if (rcpt.contractAddress) {
    const code = await jsonRpc('monitor', rpc, 'eth_getCode', [rcpt.contractAddress, 'latest'], { fetchImpl });
    checks.push(check('on-chain runtime code == attested deployedBytecode', strip(code) === strip(expectedDeployedBytecode), `${strip(code).length / 2} bytes on-chain`));
    try { // config() selector 0x79502c55 -> (owner, pendingOwner, proposer, paused, networkId, nextNonce, maxSpendCap): 7 static words
      const raw = strip(await jsonRpc('monitor', rpc, 'eth_call', [{ to: rcpt.contractAddress, data: '0x79502c55' }, 'latest'], { fetchImpl }));
      const w = (i) => raw.slice(i * 64, i * 64 + 64);
      const addr = (i) => '0x' + w(i).slice(24);
      checks.push(check('config() returned 7 words', raw.length === 7 * 64, `${raw.length / 64} words`));
      if (expectedOwner) checks.push(check('owner matches decision', addr(0) === '0x' + strip(expectedOwner), addr(0)));
      if (expectedProposer) checks.push(check('proposer matches decision', addr(2) === '0x' + strip(expectedProposer), addr(2)));
      checks.push(check('contract not paused at deploy', BigInt('0x' + w(3)) === 0n));
      checks.push(check('registry network id == chain id', BigInt('0x' + w(4)) === BigInt(chainId), String(BigInt('0x' + w(4)))));
    } catch (e) { checks.push(check('config() view callable', false, e.message)); }
  }
  return { ok: checks.every((c) => c.ok), account: rcpt.contractAddress ?? null, checks, observedAt: Date.now(), blockNumber: parseInt(rcpt.blockNumber, 16) };
}
