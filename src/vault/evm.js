// EVM chain adapter for the Mandate Vault (contracts/evm/src/AgentVault.sol). Implements the interface in the Mandate Vault spec
// ("Chain adapter interface") plus the extensions listed in src/vault/index.js. READ-ONLY except for the pure builders: nothing here
// holds a key or signs; signing is src/agent/*, driven by src/autonomy.js on the Node runtime only.
//
// All RPC goes through chains/common.js jsonRpc -> http-client guardedFetch (host allowlist, loopback http only for a local anvil),
// with `fetchImpl` injectable so tests run offline. State is read at ONE pinned block so model-vs-chain parity is exact.
import AGENT_VAULT from '../../contracts/evm/dist/AgentVault.json' with { type: 'json' };
import VAULT_ABI from '../../contracts/evm/dist/AgentVault.abi.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { jsonRpc } from '../chains/common.js';
import { keccak256, bytesToHex } from '../agent/keccak.js';
import { hexToBytes, bigIntToBytes, bytesToBigInt, isValidAddress, toChecksumAddress } from '../agent/secp256k1.js';
import { encodeCall, encodeArgs, signatureFromAbi, evmRpc, estimateFees, VAULT_SIGNATURES, selector } from '../agent/evm-signer.js';
import { UNITS, formatUnits } from './units.js';

const ABI = VAULT_ABI.abi;
const strip = (h) => (h ?? '').toLowerCase().replace(/^0x/, '');
const hex = (b) => '0x' + bytesToHex(b);
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const check = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail: String(detail) });
const ZERO = '0x0000000000000000000000000000000000000000';
const isZeroAddr = (a) => !a || /^0x0*$/i.test(a);

export const ATTESTED_VAULT = Object.freeze({
  contract: 'AgentVault', deployedBytecode: AGENT_VAULT.deployedBytecode, sha256: AGENT_VAULT.manifest.deployedBytecodeSha256,
  bytes: AGENT_VAULT.manifest.bytes, abiSha256: AGENT_VAULT.manifest.abiSha256, solc: AGENT_VAULT.manifest.solc,
});
export const PREVIEW_CODES = Object.freeze({ ...VAULT_ABI.previewCodes });
export const EVENT_TOPIC_DEPLOYED = VAULT_ABI.events['Deployed(uint64,bytes32,address,bytes32,uint256)'];
const DEPLOY_SELECTOR = hex(selector(VAULT_SIGNATURES.deploy));

// ------------------------------------------------------------------ ABI decoding (driven by the ABI JSON; tuples, strings, dynamic arrays)
const isDynamic = (p) => p.type === 'string' || p.type === 'bytes' || p.type.endsWith('[]') || (p.type === 'tuple' && p.components.some(isDynamic));
const words = (p) => (p.type === 'tuple' ? p.components.reduce((n, c) => n + words(c), 0) : 1);
const uintAt = (buf, pos) => {
  if (pos < 0 || pos + 32 > buf.length) throw new Error('abi: read out of bounds');
  return bytesToBigInt(buf.subarray(pos, pos + 32));
};
function decodeStatic(p, buf, pos) {
  if (p.type === 'tuple') { const o = {}; let q = pos; for (const c of p.components) { o[c.name] = decodeStatic(c, buf, q); q += words(c) * 32; } return o; }
  if (p.type === 'address') return toChecksumAddress('0x' + bytesToHex(buf.subarray(pos + 12, pos + 32)));
  if (p.type === 'bool') return uintAt(buf, pos) !== 0n;
  if (p.type.startsWith('uint')) return uintAt(buf, pos);
  if (/^bytes[0-9]+$/.test(p.type)) return hex(buf.subarray(pos, pos + Number(p.type.slice(5))));
  throw new Error(`abi: unsupported static type ${p.type}`);
}
function decodeAt(p, buf, headPos, base) {
  if (!isDynamic(p)) return decodeStatic(p, buf, headPos);
  const off = base + Number(uintAt(buf, headPos));
  if (p.type === 'string' || p.type === 'bytes') {
    const len = Number(uintAt(buf, off)); if (off + 32 + len > buf.length) throw new Error('abi: dynamic data out of bounds');
    const raw = buf.subarray(off + 32, off + 32 + len);
    return p.type === 'string' ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : hex(raw);
  }
  if (p.type.endsWith('[]')) {
    const el = { ...p, type: p.type.slice(0, -2) };
    const n = Number(uintAt(buf, off)); if (n > 4096) throw new Error('abi: array too large');
    const start = off + 32; const step = isDynamic(el) ? 32 : words(el) * 32;
    return Array.from({ length: n }, (_, i) => decodeAt(el, buf, start + i * step, start));
  }
  if (p.type === 'tuple') { const o = {}; let q = off; for (const c of p.components) { o[c.name] = decodeAt(c, buf, q, off); q += (isDynamic(c) ? 32 : words(c) * 32); } return o; }
  throw new Error(`abi: unsupported type ${p.type}`);
}
/** Decode the return data of `name` from the vault ABI. One output -> that value; several -> array. */
export function decodeOutputs(params, hexData) {
  const buf = hexToBytes(hexData); let pos = 0;
  const vals = params.map((p) => { const v = decodeAt(p, buf, pos, 0); pos += isDynamic(p) ? 32 : words(p) * 32; return v; });
  return vals.length === 1 ? vals[0] : vals;
}
const fn = (name) => ABI.find((x) => x.type === 'function' && x.name === name);
const sigOf = (name) => signatureFromAbi(ABI, name);
export const encodeVaultCall = (name, args = []) => encodeCall(sigOf(name), args);

// ------------------------------------------------------------------ hashing helpers (all local; proven against viem and anvil in tests)
/** keccak256(initcode): the template id. initcode = creation bytecode ++ abi-encoded constructor args. */
export const templateIdOfInitcode = (initcode) => hex(keccak256(typeof initcode === 'string' ? hexToBytes(initcode) : initcode));
/** CREATE2 address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:] (the vault's templateId IS the initcode hash). */
export function predictCreate2(vault, salt, templateId) {
  const h = keccak256(concat(Uint8Array.of(0xff), hexToBytes(vault), hexToBytes(salt), hexToBytes(templateId)));
  return toChecksumAddress('0x' + bytesToHex(h.subarray(12)));
}
/** Deterministic per-decision CREATE2 salt, so the target address is known (and verifiable) before the transaction exists. */
export const saltForDecision = (decisionId) => hex(keccak256(`autonear:deploy:${decisionId}`));

// ------------------------------------------------------------------ reads
const eth = (rpcUrl, method, params, fetchImpl) => jsonRpc('monitor', rpcUrl, method, params, { fetchImpl });
async function view(rpcUrl, vault, name, args, tag, fetchImpl) {
  const data = hex(encodeVaultCall(name, args));
  const out = await eth(rpcUrl, 'eth_call', [{ to: vault, data }, tag], fetchImpl);
  return decodeOutputs(fn(name).outputs, out);
}

async function readState({ net, vault, agent, fetchImpl }) {
  if (!isValidAddress(vault)) throw new Error('vault is not a valid EVM address');
  const cid = Number(BigInt(await eth(net.rpc, 'eth_chainId', [], fetchImpl)));
  if (cid !== net.chainId) throw new Error(`RPC reports chain id ${cid}, expected ${net.chainId}`);
  const blk = await eth(net.rpc, 'eth_getBlockByNumber', ['latest', false], fetchImpl);
  if (!blk?.number) throw new Error('latest block unavailable');
  const tag = blk.number; const v = (name, args = []) => view(net.rpc, vault, name, args, tag, fetchImpl);
  const [cfg, m, u, available, count] = [await v('config'), await v('mandate'), await v('usage'), await v('available'), await v('templateCount')];
  const templates = [];
  for (let from = 0n; from < count && templates.length < 512; from += 50n) {
    for (const t of await v('templates', [from, 50n])) templates.push({ id: t.id, label: t.label, deposit: t.deposit });
  }
  const hasMandate = !(isZeroAddr(m.agent) && m.expiresAt === 0n && m.totalCap === 0n);
  const mandate = hasMandate ? {
    agent: m.agent, expiresAt: m.expiresAt, perDrawCap: m.perDrawCap, periodSecs: m.periodSecs, periodCap: m.periodCap, totalCap: m.totalCap,
    maxDeploys: BigInt(m.maxDeploys), revoked: m.revoked, start: m.start,
  } : null;
  const who = agent ?? mandate?.agent;
  const agentBalance = who && !isZeroAddr(who) ? BigInt(await eth(net.rpc, 'eth_getBalance', [who, tag], fetchImpl)) : 0n;
  return {
    config: { owner: cfg.owner, pendingOwner: isZeroAddr(cfg.pendingOwner) ? null : cfg.pendingOwner, paused: cfg.paused, networkId: cfg.networkId.toString(), epoch: cfg.epoch },
    mandate,
    usage: { totalSpent: u.totalSpent, periodSpent: u.periodSpent, deploys: BigInt(u.deploys), periodIndex: u.periodIndex },
    available, templates, agentBalance, blockTime: BigInt(blk.timestamp), blockNumber: BigInt(blk.number), blockTag: tag,
  };
}

async function verifyVaultCode({ net, vault, attested = ATTESTED_VAULT, fetchImpl }) {
  const checks = [];
  try {
    const cid = Number(BigInt(await eth(net.rpc, 'eth_chainId', [], fetchImpl)));
    checks.push(check('rpc chain id matches the network', cid === net.chainId, `${cid} vs ${net.chainId}`));
    const code = await eth(net.rpc, 'eth_getCode', [vault, 'latest'], fetchImpl);
    checks.push(check('vault runtime code == attested AgentVault build', strip(code) === strip(attested.deployedBytecode) && strip(code).length > 0, `${strip(code).length / 2} bytes on-chain vs ${strip(attested.deployedBytecode).length / 2} attested (sha256 ${attested.sha256?.slice(0, 12)}…)`));
  } catch (e) { checks.push(check('vault code readable', false, String(e.message).slice(0, 200))); }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Error name the REAL call would hit now ('' = ok), straight from previewDraw / previewDeploy. Unknown selector -> throws (treated as an anomaly). */
async function preview(kind, { net, vault, amount, template, nameOrSalt, block, fetchImpl }) {
  const tag = block ?? 'latest';
  const raw = kind === 'draw' ? await view(net.rpc, vault, 'previewDraw', [amount], tag, fetchImpl) : await view(net.rpc, vault, 'previewDeploy', [template, nameOrSalt], tag, fetchImpl);
  const name = PREVIEW_CODES[String(raw).toLowerCase()];
  if (name === undefined) throw new Error(`unknown preview selector ${String(raw).slice(0, 12)}`);
  return name;
}

// ------------------------------------------------------------------ expected template (computed LOCALLY from the attested artifact + approved payload)
const CTOR_TYPES = ['address', 'address', 'uint256'];
function expectedTemplate({ manifest, payload }) {
  if (!manifest?.bytecode || !manifest?.deployedBytecode) throw new Error('attested artifact has no creation/runtime bytecode');
  const ctor = (manifest.abi ?? []).find((x) => x.type === 'constructor');
  if (!ctor || ctor.inputs.map((i) => i.type).join(',') !== CTOR_TYPES.join(',')) throw new Error('attested artifact constructor is not (address,address,uint256): refusing to encode arguments blindly');
  // the attested sha256 must be the hash of the attested runtime code (binds the blob to the artifact hash the decision names)
  if (createHash('sha256').update(hexToBytes(manifest.deployedBytecode)).digest('hex') !== manifest.sha256) throw new Error('attested artifact: sha256(deployedBytecode) does not equal the attested hash');
  const r = payload?.registry ?? {};
  if (!isValidAddress(r.owner) || !isValidAddress(r.proposer) || isZeroAddr(r.owner) || isZeroAddr(r.proposer)) throw new Error('payload.registry.owner / proposer must be non-zero EVM addresses');
  const cap = r.maxSpendCap === undefined || r.maxSpendCap === '' ? '0' : String(r.maxSpendCap);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(cap)) throw new Error('payload.registry.maxSpendCap must be a decimal integer');
  const args = encodeArgs(CTOR_TYPES, [r.owner, r.proposer, BigInt(cap)]);
  const code = concat(hexToBytes(manifest.bytecode), args);
  return {
    templateId: templateIdOfInitcode(code), code, label: `ProposalRegistry ${String(manifest.sha256 ?? '').slice(0, 12)}`.slice(0, 64), deposit: 0n,
    initMaterial: { constructorArgs: hex(args), owner: toChecksumAddress(r.owner), proposer: toChecksumAddress(r.proposer), maxSpendCap: cap },
  };
}

function deployTarget({ decision, vault, expected }) {
  const salt = saltForDecision(decision.id);
  return { nameOrSalt: salt, predicted: predictCreate2(vault, salt, expected.templateId) };
}

const buildCall = (kind, { vault, amount, template, code, nameOrSalt }) => (kind === 'draw'
  ? { method: 'draw', target: vault, args: { amount: BigInt(amount) } }
  : { method: 'deploy', target: vault, args: { template, salt: nameOrSalt, code } });

/** Worst-case fee (base units) the signer would price this call at, using the signer's own multipliers (gas x1.2, maxFeePerGas = 2 x baseFee + tip). */
async function estimateFee({ net, vault, agent, call, fetchImpl, gasMultiplier = 1.2 }) {
  const rpc = evmRpc(net.rpc, { fetchImpl, role: 'launch' });
  const data = call.method === 'draw' ? encodeCall(VAULT_SIGNATURES.draw, [call.args.amount]) : encodeCall(VAULT_SIGNATURES.deploy, [call.args.template, call.args.salt, call.args.code]);
  const gasEst = await rpc.estimateGas({ from: agent, to: vault, value: '0x0', data: hex(data) });
  const fees = await estimateFees(rpc, {});
  const price = fees.type === 'eip1559' ? fees.maxFeePerGas : fees.gasPrice;
  const gas = (gasEst * BigInt(Math.round(gasMultiplier * 100)) + 99n) / 100n;
  return { gas, price, worstCaseFee: gas * price };
}

const signerOptions = ({ net, fetchImpl, extra = {} }) => ({ rpcUrl: net.rpc, chainId: net.chainId, fetchImpl, role: 'launch', ...extra });

// ------------------------------------------------------------------ receipt-level proof of a vault deployment
async function verifyDeploy({ net, txHash, vault, agent, decision, manifest, expected, fetchImpl }) {
  const checks = [];
  const ok = (n, c, d = '') => checks.push(check(n, c, d));
  const target = deployTarget({ decision, vault, expected });
  const cid = Number(BigInt(await eth(net.rpc, 'eth_chainId', [], fetchImpl)));
  ok('rpc chain id matches decision', cid === net.chainId, `${cid} vs ${net.chainId}`);
  const rcpt = await eth(net.rpc, 'eth_getTransactionReceipt', [txHash], fetchImpl);
  if (!rcpt) return { ok: false, account: null, checks: [...checks, check('receipt found', false, 'tx not mined or unknown to this RPC')], observedAt: Date.now() };
  ok('tx succeeded (status 0x1)', rcpt.status === '0x1', rcpt.status);
  ok('tx was sent by the mandate-bound agent', strip(rcpt.from) === strip(agent) && Boolean(agent), `${rcpt.from} vs ${agent}`);
  ok('tx was sent to the vault', strip(rcpt.to) === strip(vault), `${rcpt.to} vs ${vault}`);
  const tx = await eth(net.rpc, 'eth_getTransactionByHash', [txHash], fetchImpl);
  let call = null;
  try {
    if (strip(tx?.input).slice(0, 8) !== strip(DEPLOY_SELECTOR)) throw new Error('not a vault deploy() call');
    const buf = hexToBytes('0x' + strip(tx.input).slice(8));
    const [tpl, salt, code] = [0, 1, 2].map((i) => decodeAt(i === 2 ? { type: 'bytes' } : { type: 'bytes32' }, buf, i * 32, 0));
    call = { tpl, salt, code };
  } catch (e) { ok('calldata is vault.deploy(template, salt, code)', false, e.message); }
  if (call) {
    ok('calldata template == locally recomputed template id', call.tpl.toLowerCase() === expected.templateId.toLowerCase());
    ok('calldata salt == the per-decision salt', call.salt.toLowerCase() === target.nameOrSalt.toLowerCase());
    ok('calldata initcode == attested creation code ++ approved constructor args', strip(call.code) === bytesToHex(expected.code));
  }
  const logs = (rcpt.logs ?? []).filter((l) => strip(l.address) === strip(vault) && l.topics?.[0]?.toLowerCase() === EVENT_TOPIC_DEPLOYED.toLowerCase());
  ok('exactly one Deployed event from the vault', logs.length === 1, `${logs.length} found`);
  const ev = logs[0];
  const evTarget = ev ? toChecksumAddress('0x' + strip(ev.topics[3]).slice(24)) : null;
  if (ev) {
    ok('Deployed.templateId == expected', ev.topics[2].toLowerCase() === expected.templateId.toLowerCase());
    ok('Deployed.target == local CREATE2 prediction', evTarget === target.predicted, `${evTarget} vs ${target.predicted}`);
    ok('Deployed.salt == the per-decision salt', strip(ev.data).slice(0, 64) === strip(target.nameOrSalt));
  }
  const head = Number(BigInt(await eth(net.rpc, 'eth_blockNumber', [], fetchImpl)));
  ok('≥1 confirmation', head >= Number(BigInt(rcpt.blockNumber)), `head ${head} / block ${Number(BigInt(rcpt.blockNumber))}`);
  const account = evTarget ?? target.predicted;
  const code = await eth(net.rpc, 'eth_getCode', [account, 'latest'], fetchImpl);
  ok('on-chain runtime code at target == attested deployedBytecode', strip(code) === strip(manifest.deployedBytecode) && strip(code).length > 0, `${strip(code).length / 2} bytes on-chain`);
  try { // registry config(): (owner, pendingOwner, proposer, paused, networkId, nextNonce, maxSpendCap)
    const raw = strip(await eth(net.rpc, 'eth_call', [{ to: account, data: '0x79502c55' }, 'latest'], fetchImpl));
    const w = (i) => raw.slice(i * 64, i * 64 + 64);
    ok('registry config() returned 7 words', raw.length === 7 * 64, `${raw.length / 64} words`);
    ok('registry owner == the approved owner', '0x' + w(0).slice(24) === '0x' + strip(expected.initMaterial.owner));
    ok('registry proposer == the approved proposer', '0x' + w(2).slice(24) === '0x' + strip(expected.initMaterial.proposer));
    ok('registry not paused at deploy', BigInt('0x' + w(3)) === 0n);
    ok('registry network id == chain id', BigInt('0x' + w(4)) === BigInt(net.chainId), String(BigInt('0x' + w(4))));
  } catch (e) { ok('registry config() view callable', false, e.message); }
  const vcode = await verifyVaultCode({ net, vault, fetchImpl });
  for (const c of vcode.checks) ok(`vault: ${c.name}`, c.ok, c.detail);
  return { ok: checks.every((c) => c.ok), account, checks, observedAt: Date.now(), blockNumber: Number(BigInt(rcpt.blockNumber)) };
}

const explorerTx = (net, txHash) => (net.explorer ? net.explorer + txHash : '');
const explorerAddress = (net, addr) => (net.explorer ? net.explorer.replace(/\/tx\/$/, '/address/') + addr : '');

// ------------------------------------------------------------------ human plan (exact calldata + cast equivalents)
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function planSteps({ net, payload, vault }) {
  const m = payload.mandate; const chainId = net.chainId; const rpc = net.rpc;
  const cast = (to, sigOrNone, args, value) => `cast send ${to} ${sigOrNone ? shq(sigOrNone) + ' ' : ''}${args.map(shq).join(' ')}${args.length ? ' ' : ''}${value ? `--value ${value} ` : ''}--rpc-url ${rpc} --account <your-owner-keystore>`.replace(/\s+$/, '');
  const steps = [];
  for (const t of payload.templates) {
    const sig = sigOf('allowTemplate');
    steps.push({
      who: 'human', title: `allowTemplate: ${t.label}`, note: `Owner allowlists templateId ${t.templateId} (= keccak256 of the attested creation code + the constructor args fixed in this decision). Deposit must be 0 on EVM.`,
      tx: { to: vault, data: hex(encodeCall(sig, [t.templateId, t.label, BigInt(t.deposit)])), value: '0', chainId },
      cli: cast(vault, sig, [t.templateId, t.label, t.deposit]),
    });
  }
  const sm = sigOf('setMandate');
  const smArgs = [payload.agent.address, m.expiresAt, m.perDrawCap, m.periodSecs, m.periodCap, m.totalCap, m.maxDeploys];
  steps.push({
    who: 'human', title: 'setMandate', note: `Binds the agent ${payload.agent.address}. expiresAt (${m.expiresAt}) must still satisfy now < expiresAt <= now + 30 days when you send this, otherwise the vault reverts BadMandate: propose again. Every cap is in wei.`,
    tx: { to: vault, data: hex(encodeCall(sm, smArgs.map((x, i) => (i === 0 ? x : BigInt(x))))), value: '0', chainId },
    cli: cast(vault, sm, smArgs),
  });
  steps.push({
    who: 'human', title: `Fund the vault with ${formatUnits(payload.fund.amount, 18)} ${UNITS.evm.symbol}`, note: 'Plain value transfer to the vault (its receive() logs Deposited). Gifts only: funding changes no budget. You can withdraw everything back at any time.',
    tx: { to: vault, data: '0x', value: String(payload.fund.amount), chainId },
    cli: cast(vault, '', [], payload.fund.amount),
  });
  steps.push({
    who: 'human', title: 'Seed the agent address with a little gas', note: `The agent pays gas for its OWN first draw, so it needs a small seed balance once (a few cents of testnet ETH) at ${payload.agent.address}. After that the vault funds its gas.`,
    tx: { to: payload.agent.address, data: '0x', value: '2000000000000000', chainId },
    cli: `cast send ${payload.agent.address} --value 2000000000000000 --rpc-url ${rpc} --account <your-owner-keystore>`,
  });
  return steps;
}

/** 'mined' | 'reverted' | 'unknown' for a tx hash (unknown = no receipt on this RPC yet, or the RPC failed). */
async function receiptStatus({ net, txHash, fetchImpl }) {
  try { const r = await eth(net.rpc, 'eth_getTransactionReceipt', [txHash], fetchImpl); return !r ? 'unknown' : r.status === '0x1' ? 'mined' : 'reverted'; } catch { return 'unknown'; }
}

export const adapter = {
  chain: 'evm',
  unit: UNITS.evm,
  attested: ATTESTED_VAULT,
  readState, verifyVaultCode, expectedTemplate, buildCall, verifyDeploy, explorerTx, explorerAddress,
  // extensions (see src/vault/index.js REQUIRED_ADAPTER_METHODS)
  preview, estimateFee, signerOptions, deployTarget, planSteps, receiptStatus,
};
export default adapter;
