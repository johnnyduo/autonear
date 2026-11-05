// Integration: deploy the REAL compiled ProposalRegistry to a local anvil and run the production verifier against it.
// Local chain only (31337). Skipped when foundry or the built artifact is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { verifyEvmDeploy } from '../src/chains/evm.js';

const BIN = `${homedir()}/.foundry/bin`;
const ART = new URL('../contracts/evm/dist/ProposalRegistry.json', import.meta.url).pathname;
const have = existsSync(`${BIN}/anvil`) && existsSync(ART);
// Anvil's documented public dev accounts (never hold value).
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('real registry on anvil: verifier accepts the right signer/code and rejects tampering', { skip: !have && 'foundry or contracts/evm/dist missing' }, async () => {
  const port = 18545 + Math.floor(Math.random() * 500);
  const anvil = spawn(`${BIN}/anvil`, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpc = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const art = JSON.parse(readFileSync(ART, 'utf8'));
    const args = spawnSync(`${BIN}/cast`, ['abi-encode', 'constructor(address,address,uint256)', A0, A1, '0'], { encoding: 'utf8' }).stdout.trim().replace(/^0x/, '');
    const sent = spawnSync(`${BIN}/cast`, ['send', '--rpc-url', rpc, '--private-key', KEY0, '--json', '--create', art.bytecode.replace(/^0x/, '') + args], { encoding: 'utf8' });
    const txHash = JSON.parse(sent.stdout).transactionHash;
    const base = { rpc, chainId: 31337, txHash, expectedDeployedBytecode: art.deployedBytecode, expectedOwner: A0, expectedProposer: A1 };
    const ok = await verifyEvmDeploy({ ...base, expectedDeployer: A0 });
    assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
    assert.equal((await verifyEvmDeploy({ ...base, expectedDeployer: A1 })).ok, false, 'wrong signer');
    assert.equal((await verifyEvmDeploy({ ...base, expectedDeployer: A0, expectedOwner: A1 })).ok, false, 'wrong owner');
    assert.equal((await verifyEvmDeploy({ ...base, expectedDeployer: A0, expectedDeployedBytecode: art.deployedBytecode + '00' })).ok, false, 'tampered bytecode');
    assert.equal((await verifyEvmDeploy({ ...base, chainId: 1, expectedDeployer: A0 })).ok, false, 'wrong chain');
  } finally { anvil.kill(); }
});
