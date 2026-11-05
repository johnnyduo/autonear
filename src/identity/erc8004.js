// ERC-8004 "Trustless Agents": OPTIONAL identity adapter (EVM only, testnets only).
//
// WHAT THIS IS NOT: ERC-8004 is an ERC in DRAFT status. It defines three registries (Identity, Reputation, Validation)
// for agent DISCOVERY and TRUST SIGNALS. It is NOT a wallet standard and NOT a spending/permission standard: it cannot hold
// funds, limit spending, or authorise a transaction. Budget and permission enforcement lives in the Mandate Vault
// (docs/agent-vault-spec.md), never here. Payments are explicitly out of scope of the ERC.
//
// WHAT THIS MODULE DOES: builds/validates the agent registration file, encodes calls to the Identity Registry
// (register / setAgentURI / setMetadata) and its views (ownerOf / tokenURI / getMetadata / getAgentWallet), decodes results,
// and runs a READ-ONLY verifyRegistration() against an RPC. It never signs and never sends a transaction: encode* returns
// calldata, buildRegisterTx returns an unsigned request for the caller's own signer.
//
// SOURCES (read 2026-11-05; see src/identity/README.md): ERC text https://eips.ethereum.org/EIPS/eip-8004 (ethereum/ERCs
// commit 503591a6e80e6e1affdd6403341e25269141f046, last change to ERCS/erc-8004.md, 2026-01-25); reference contracts
// https://github.com/erc-8004/erc-8004-contracts commit b9e466c250744a7e06b13dff9d3c2844ed64f825 (2026-08-15), whose
// ERC8004SPEC.md is byte-identical to the ERCs file above. Because the standard is a Draft it may still change: re-check before
// relying on any of this beyond testnets.
import { createHash } from 'node:crypto';
import { jsonRpc, check } from '../chains/common.js';

export const SPEC = Object.freeze({
  eip: 8004,
  status: 'Draft',
  ercsCommit: '503591a6e80e6e1affdd6403341e25269141f046',
  contractsCommit: 'b9e466c250744a7e06b13dff9d3c2844ed64f825',
  contractsVersionReported: '2.0.0', // IdentityRegistryUpgradeable.getVersion() in that commit (not an on-chain check by this module)
  accessed: '2026-11-05',
  url: 'https://eips.ethereum.org/EIPS/eip-8004',
});

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
export const WELL_KNOWN_PATH = '/.well-known/agent-registration.json';
export const KNOWN_TRUST = Object.freeze(['reputation', 'crypto-economic', 'tee-attestation']);

// ------------------------------------------------------------------------------------------------ registry addresses
// TESTNETS ONLY. Each entry cites the line range of README.md in erc-8004/erc-8004-contracts @ b9e466c... where the
// IdentityRegistry / ReputationRegistry addresses were read. Chain ids are mapped by us from the README's network names
// (the README lists names, not ids). Mainnet addresses are deliberately NOT in this table and are blocked below.
const README = 'https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/README.md';
const row = (chainId, name, readmeHeading, lines) => Object.freeze({
  chainId, name, identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e', reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  source: `${README}#L${lines} ("${readmeHeading}")`,
});
export const TESTNET_REGISTRIES = Object.freeze({
  11155111: row(11155111, 'Ethereum Sepolia', 'Ethereum Sepolia', '12-13'),
  84532: row(84532, 'Base Sepolia', 'Base Sepolia', '20-21'),
  421614: row(421614, 'Arbitrum Sepolia', 'Arbitrum Testnet', '36-37'),
  97: row(97, 'BSC Testnet', 'BSC Testnet', '52-53'),
  10143: row(10143, 'Monad Testnet', 'Monad Testnet', '108-109'),
  11155420: row(11155420, 'Optimism Sepolia', 'Optimism Testnet', '116-117'),
});
// Hard block: chain ids of mainnets where the README lists deployments. Never enabled by this adapter, even with a custom registry.
export const BLOCKED_MAINNET_CHAIN_IDS = Object.freeze(new Set([1, 10, 56, 100, 137, 143, 250, 324, 5000, 8453, 42161, 42220, 43114, 59144, 534352]));

/** Registry entry for a testnet chain id. Throws for mainnets and for any chain not in the verified table. */
export function registryFor(chainId) {
  const id = Number(chainId);
  if (BLOCKED_MAINNET_CHAIN_IDS.has(id)) throw new Error(`erc8004: chain ${id} is a mainnet; this adapter is testnet-only`);
  const r = TESTNET_REGISTRIES[id];
  if (!r) throw new Error(`erc8004: no verified testnet registry for chain ${id}`);
  return r;
}

/** `{namespace}:{chainId}:{identityRegistry}` as defined by the ERC. */
export function agentRegistryId(chainId, identityRegistry = registryFor(chainId).identity) {
  if (!isAddress(identityRegistry)) throw new Error('erc8004: bad identity registry address');
  return `eip155:${Number(chainId)}:${identityRegistry}`;
}

// ------------------------------------------------------------------------------------------------ small ABI codec
const SEL = Object.freeze({
  // selectors computed with viem@2.57.16 toFunctionSelector (see tests/identity.test.js, which re-derives them)
  'register(string)': '0xf2c298be',
  'register()': '0x1aa3a008',
  'register(string,(string,bytes)[])': '0x8ea42286',
  'setAgentURI(uint256,string)': '0x0af28bd3',
  'setMetadata(uint256,string,bytes)': '0x466648da',
  'getMetadata(uint256,string)': '0xcb4799f2',
  'tokenURI(uint256)': '0xc87b56dd',
  'ownerOf(uint256)': '0x6352211e',
  'getAgentWallet(uint256)': '0x00339509',
});
export const SELECTORS = SEL;
export const EVENT_TOPICS = Object.freeze({
  Registered: '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a', // Registered(uint256,string,address)
  URIUpdated: '0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb', // URIUpdated(uint256,string,address)
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const w = (n) => n.toString(16).padStart(64, '0');
const pad32 = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
const utf8Hex = (s) => Buffer.from(s, 'utf8').toString('hex');
function uint(v) {
  let n;
  try { n = typeof v === 'bigint' ? v : (typeof v === 'number' || (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v))) ? BigInt(v) : null; } catch { n = null; }
  if (n === null || n < 0n || n >= 2n ** 256n) throw new Error('erc8004: expected unsigned integer');
  return n;
}
function bytesHex(v) {
  if (typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v)) return v.slice(2).toLowerCase();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  throw new Error('erc8004: expected bytes (0x-hex or Uint8Array)');
}
// An encoded value is { dynamic: boolean, head: hex (static only), tail: hex (dynamic only) }
const encString = (s) => { if (typeof s !== 'string') throw new Error('erc8004: expected string'); const h = utf8Hex(s); return w(BigInt(h.length / 2)) + pad32(h); };
const encBytes = (v) => { const h = bytesHex(v); return w(BigInt(h.length / 2)) + pad32(h); };
function encodeTuple(items) { // items: [{ dynamic, enc }] -> head+tail
  let headLen = 32 * items.length; let tail = ''; let head = '';
  for (const it of items) {
    if (it.dynamic) { head += w(BigInt(headLen + tail.length / 2)); tail += it.enc; } else head += it.enc;
  }
  return head + tail;
}
function encodeValue(type, v) {
  switch (type) {
    case 'uint256': return { dynamic: false, enc: w(uint(v)) };
    case 'address': if (!isAddress(v)) throw new Error('erc8004: bad address'); return { dynamic: false, enc: v.slice(2).toLowerCase().padStart(64, '0') };
    case 'string': return { dynamic: true, enc: encString(v) };
    case 'bytes': return { dynamic: true, enc: encBytes(v) };
    case 'metadata[]': { // (string metadataKey, bytes metadataValue)[]
      if (!Array.isArray(v)) throw new Error('erc8004: metadata must be an array');
      const els = v.map((e) => ({ dynamic: true, enc: encodeTuple([encodeValue('string', e.metadataKey), encodeValue('bytes', e.metadataValue)]) }));
      return { dynamic: true, enc: w(BigInt(els.length)) + encodeTuple(els) };
    }
    default: throw new Error(`erc8004: unsupported type ${type}`);
  }
}
const call = (sig, types = [], values = []) => `${SEL[sig]}${encodeTuple(types.map((t, i) => encodeValue(t, values[i])))}`;

// ------------------------------------------------------------------------------------------------ call encoders (no sending)
/** register(string agentURI) -> returns agentId. */
export const encodeRegister = (agentURI) => call('register(string)', ['string'], [agentURI]);
/** register() with no URI (set it later with setAgentURI). */
export const encodeRegisterEmpty = () => call('register()');
/** register(string agentURI, MetadataEntry[] metadata). Key "agentWallet" is reserved by the registry and rejected here too. */
export function encodeRegisterWithMetadata(agentURI, metadata = []) {
  for (const m of metadata) if (m.metadataKey === 'agentWallet') throw new Error('erc8004: "agentWallet" is a reserved metadata key');
  return call('register(string,(string,bytes)[])', ['string', 'metadata[]'], [agentURI, metadata]);
}
export const encodeSetAgentURI = (agentId, newURI) => call('setAgentURI(uint256,string)', ['uint256', 'string'], [agentId, newURI]);
export function encodeSetMetadata(agentId, metadataKey, metadataValue) {
  if (metadataKey === 'agentWallet') throw new Error('erc8004: "agentWallet" is a reserved metadata key (use setAgentWallet with a signature)');
  return call('setMetadata(uint256,string,bytes)', ['uint256', 'string', 'bytes'], [agentId, metadataKey, metadataValue]);
}
// views
export const encodeOwnerOf = (agentId) => call('ownerOf(uint256)', ['uint256'], [agentId]);
export const encodeTokenURI = (agentId) => call('tokenURI(uint256)', ['uint256'], [agentId]);
export const encodeGetMetadata = (agentId, metadataKey) => call('getMetadata(uint256,string)', ['uint256', 'string'], [agentId, metadataKey]);
export const encodeGetAgentWallet = (agentId) => call('getAgentWallet(uint256)', ['uint256'], [agentId]);

/** Unsigned transaction REQUEST for `register(agentURI)` on a testnet. Nothing is signed or sent here. */
export function buildRegisterTx({ chainId, agentURI, registry }) {
  const r = registryFor(chainId);
  const to = registry ?? r.identity;
  if (!isAddress(to)) throw new Error('erc8004: bad registry address');
  if (typeof agentURI !== 'string' || !agentURI) throw new Error('erc8004: agentURI required');
  return { chainId: r.chainId, to, value: '0x0', data: encodeRegister(agentURI) };
}

// ------------------------------------------------------------------------------------------------ decoders (hostile-RPC safe)
function dataBytes(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('erc8004: malformed hex result');
  return hex.slice(2);
}
const wordAt = (d, off) => { if (off < 0 || (off + 32) * 2 > d.length) throw new Error('erc8004: result truncated'); return BigInt('0x' + d.slice(off * 2, (off + 32) * 2)); };
export function decodeUint256(hex) { return wordAt(dataBytes(hex), 0); }
export function decodeAddress(hex) {
  const v = wordAt(dataBytes(hex), 0);
  if (v >= 2n ** 160n) throw new Error('erc8004: not an address');
  return '0x' + v.toString(16).padStart(40, '0');
}
function dynBytes(d, headOff) {
  const off = Number(wordAt(d, headOff)); const len = Number(wordAt(d, off));
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || (off + 32 + len) * 2 > d.length) throw new Error('erc8004: bad dynamic length');
  return Buffer.from(d.slice((off + 32) * 2, (off + 32 + len) * 2), 'hex');
}
export function decodeString(hex) { return new TextDecoder('utf-8', { fatal: true }).decode(dynBytes(dataBytes(hex), 0)); }
export function decodeBytes(hex) { return '0x' + dynBytes(dataBytes(hex), 0).toString('hex'); }

/** Parse a `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` log from a receipt. */
export function parseRegisteredLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== EVENT_TOPICS.Registered || log.topics.length !== 3) throw new Error('erc8004: not a Registered log');
  return { agentId: BigInt(log.topics[1]), owner: '0x' + log.topics[2].slice(-40), agentURI: decodeString(log.data) };
}

// ------------------------------------------------------------------------------------------------ registration file
/**
 * Build an agent registration file in the shape given by the ERC (field names are the ERC's: `services`, not the earlier `endpoints`).
 * `registrations` may be empty for a first draft: the agentId is only known after register(); publish via setAgentURI afterwards.
 */
export function buildRegistrationFile({ name, description, image, services = [], x402Support = false, active = true, registrations = [], supportedTrust } = {}) {
  const f = { type: REGISTRATION_TYPE, name, description };
  if (image !== undefined) f.image = image;
  f.services = services.map((s) => ({ name: s.name, endpoint: s.endpoint, ...(s.version !== undefined ? { version: s.version } : {}), ...extra(s) }));
  f.x402Support = x402Support;
  f.active = active;
  f.registrations = registrations.map((r) => ({ agentId: Number(r.agentId), agentRegistry: r.agentRegistry }));
  if (supportedTrust !== undefined) f.supportedTrust = [...supportedTrust];
  return f;
}
const extra = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !['name', 'endpoint', 'version'].includes(k)));

const AGENT_REGISTRY_RE = /^eip155:[0-9]+:0x[0-9a-fA-F]{40}$/;
/**
 * Validate against the structure in the ERC. Returns { ok, errors, warnings }. Errors = violates a MUST of the ERC's structure
 * (as read by us); warnings = SHOULD / examples-only conventions. Unknown extra fields are allowed (the ERC says fields are customizable).
 */
export function validateRegistrationFile(file) {
  const errors = []; const warnings = [];
  const e = (m) => errors.push(m); const wn = (m) => warnings.push(m);
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return { ok: false, errors: ['registration file must be a JSON object'], warnings };
  if (file.type !== REGISTRATION_TYPE) e(`type must be "${REGISTRATION_TYPE}"`);
  if (typeof file.name !== 'string' || !file.name.trim()) e('name must be a non-empty string');
  if (typeof file.description !== 'string' || !file.description.trim()) e('description must be a non-empty string');
  if (file.image === undefined) wn('image missing (SHOULD be present for ERC-721 app compatibility)');
  else if (typeof file.image !== 'string' || !file.image) e('image must be a non-empty string when present');
  if (!Array.isArray(file.services)) e('services must be an array');
  else {
    file.services.forEach((s, i) => {
      if (s === null || typeof s !== 'object') { e(`services[${i}] must be an object`); return; }
      if (typeof s.name !== 'string' || !s.name) e(`services[${i}].name must be a non-empty string`);
      if (typeof s.endpoint !== 'string' || !s.endpoint) e(`services[${i}].endpoint must be a non-empty string`);
      if (s.version !== undefined && typeof s.version !== 'string') e(`services[${i}].version must be a string when present`);
      if (s.version === undefined) wn(`services[${i}].version missing (SHOULD per the ERC)`);
      if (['web', 'A2A', 'MCP'].includes(s.name) && typeof s.endpoint === 'string' && !/^(https:\/\/|ipfs:\/\/)/.test(s.endpoint)) wn(`services[${i}] ${s.name} endpoint is not https/ipfs`);
    });
  }
  if (file.x402Support === undefined) wn('x402Support missing'); else if (typeof file.x402Support !== 'boolean') e('x402Support must be boolean');
  if (file.active === undefined) wn('active missing'); else if (typeof file.active !== 'boolean') e('active must be boolean');
  if (!Array.isArray(file.registrations)) e('registrations must be an array');
  else {
    if (file.registrations.length === 0) wn('registrations is empty (the ERC says agents SHOULD have at least one; fill it after register())');
    file.registrations.forEach((r, i) => {
      if (r === null || typeof r !== 'object') { e(`registrations[${i}] must be an object`); return; }
      if (!Number.isSafeInteger(r.agentId) || r.agentId < 0) e(`registrations[${i}].agentId must be a non-negative integer`);
      if (typeof r.agentRegistry !== 'string' || !AGENT_REGISTRY_RE.test(r.agentRegistry)) e(`registrations[${i}].agentRegistry must look like eip155:<chainId>:0x<address>`);
    });
  }
  if (file.supportedTrust !== undefined) {
    if (!Array.isArray(file.supportedTrust) || file.supportedTrust.some((t) => typeof t !== 'string')) e('supportedTrust must be an array of strings when present');
    else for (const t of file.supportedTrust) if (!KNOWN_TRUST.includes(t)) wn(`supportedTrust "${t}" is not one of the ERC's examples (${KNOWN_TRUST.join(', ')})`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Deterministic JSON (sorted keys, no whitespace) so equality/hash do not depend on key order. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** sha256 over canonicalJson (lowercase hex). The ERC defines no on-chain hash of the registration file; this is OUR integrity fingerprint. */
export const registrationFileHash = (file) => createHash('sha256').update(canonicalJson(file)).digest('hex');

/** `data:application/json;base64,...` as allowed by the ERC for fully on-chain files. */
export const toDataUri = (file) => `data:application/json;base64,${Buffer.from(JSON.stringify(file), 'utf8').toString('base64')}`;
export function fromDataUri(uri) {
  const m = /^data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]*)$/i.exec(uri ?? '');
  if (!m) throw new Error('erc8004: not a base64 application/json data URI');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

// ------------------------------------------------------------------------------------------------ read-only verification
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|metadata\.google\.internal)$/i;
function privateIp(host) {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.includes(':')) return true; // IPv6 literals are refused outright
  const p = h.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x))) return /^[0-9.]+$/.test(h); // odd numeric forms -> refuse
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Fetch the registration file referenced by an agentURI. Supports data:, https:// and ipfs:// (via `ipfsGateway`, e.g.
 * "https://ipfs.io/ipfs/"; none by default). https hosts that are IP literals, localhost-like or private are refused; pass
 * `allowHosts` to restrict further. DNS rebinding cannot be prevented in pure JS: in production route through an egress allowlist.
 */
export async function fetchRegistrationFile(uri, { fetchImpl = fetch, ipfsGateway, allowHosts, timeoutMs = 8000 } = {}) {
  if (typeof uri !== 'string' || !uri) throw new Error('empty agentURI');
  if (uri.startsWith('data:')) return { file: fromDataUri(uri), via: 'data' };
  let url = uri;
  if (uri.startsWith('ipfs://')) {
    if (!ipfsGateway) throw new Error('ipfs:// agentURI but no ipfsGateway configured');
    url = ipfsGateway.replace(/\/?$/, '/') + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`refusing non-https agentURI scheme ${u.protocol}`);
  if (u.username || u.password) throw new Error('refusing agentURI with credentials');
  if (PRIVATE_HOST.test(u.hostname) || privateIp(u.hostname)) throw new Error(`refusing private/loopback host ${u.hostname}`);
  if (allowHosts && !allowHosts.includes(u.hostname)) throw new Error(`host ${u.hostname} is not in allowHosts`);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching registration file`);
    const text = await res.text();
    if (text.length > MAX_FILE_BYTES) throw new Error('registration file too large');
    return { file: JSON.parse(text), via: uri.startsWith('ipfs://') ? 'ipfs-gateway' : 'https', text };
  } finally { clearTimeout(timer); }
}

const sameAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Read-only check of an on-chain ERC-8004 identity. Never sends a transaction (only eth_chainId / eth_getCode / eth_call).
 * Checks: chain id, registry has code, ownerOf == expectedOwner, tokenURI resolves to a valid registration file, the file lists
 * this exact (agentRegistry, agentId), and (if `expected` or `expectedHash` given) its content equals ours.
 * Result: { ok, checks:[{name, ok, detail}], agentId, owner, agentURI, file, warnings }. `ok` = every check passed.
 * `fetchImpl` is used for BOTH the JSON-RPC calls (via jsonRpc's 'monitor' host allowlist) and the registration file download.
 */
export async function verifyRegistration({ rpc, chainId, agentId, expectedOwner, expected, expectedHash, registry, fetchImpl = fetch, ipfsGateway, allowHosts, expectedWallet } = {}) {
  const checks = []; const out = { ok: false, checks, agentId: undefined, owner: undefined, agentURI: undefined, file: undefined, warnings: [] };
  const done = () => { out.ok = checks.length > 0 && checks.every((c) => c.ok); return out; };
  const add = (n, ok, d) => { checks.push(check(n, ok, d)); return ok; };
  let id; try { id = uint(agentId); } catch { add('agent_id_valid', false, 'agentId must be an unsigned integer'); return done(); }
  out.agentId = id;
  if (!add('expected_owner_valid', isAddress(expectedOwner), 'expectedOwner must be a 0x address')) return done();
  let reg;
  try {
    if (!chainId) throw new Error('chainId required');
    const t = registryFor(chainId); // throws for mainnets / unknown chains
    reg = { chainId: t.chainId, identity: registry ?? t.identity };
    if (registry && !isAddress(registry)) throw new Error('bad registry override');
    add('testnet_registry', true, `${t.name} identity registry ${reg.identity}`);
  } catch (err) { add('testnet_registry', false, err.message); return done(); }
  const rpcCall = (method, params) => jsonRpc('monitor', rpc, method, params, { fetchImpl });
  const ethCall = (data) => rpcCall('eth_call', [{ to: reg.identity, data }, 'latest']);
  try {
    const cid = Number(BigInt(await rpcCall('eth_chainId', [])));
    if (!add('chain_id_matches', cid === reg.chainId, `rpc reports ${cid}, expected ${reg.chainId}`)) return done();
    const code = await rpcCall('eth_getCode', [reg.identity, 'latest']);
    if (!add('registry_has_code', typeof code === 'string' && /^0x[0-9a-fA-F]{2,}$/.test(code), `eth_getCode(${reg.identity})`)) return done();
  } catch (err) { add('rpc_reachable', false, err.message); return done(); }

  try { out.owner = decodeAddress(await ethCall(encodeOwnerOf(id))); } catch (err) { add('owner_matches', false, `ownerOf(${id}) failed: ${err.message}`); return done(); }
  add('owner_matches', sameAddr(out.owner, expectedOwner), `ownerOf(${id}) = ${out.owner}, expected ${expectedOwner}`);
  if (expectedWallet !== undefined) {
    try { const wl = decodeAddress(await ethCall(encodeGetAgentWallet(id))); add('agent_wallet_matches', sameAddr(wl, expectedWallet), `getAgentWallet = ${wl}, expected ${expectedWallet}`); }
    catch (err) { add('agent_wallet_matches', false, `getAgentWallet failed: ${err.message}`); }
  }
  try { out.agentURI = decodeString(await ethCall(encodeTokenURI(id))); } catch (err) { add('token_uri_readable', false, `tokenURI failed: ${err.message}`); return done(); }
  if (!add('token_uri_readable', Boolean(out.agentURI), out.agentURI ? `agentURI scheme ${out.agentURI.split(':')[0]}` : 'agentURI is empty')) return done();
  let fetched;
  try { fetched = await fetchRegistrationFile(out.agentURI, { fetchImpl, ipfsGateway, allowHosts }); out.file = fetched.file; add('file_resolves', true, `via ${fetched.via}`); }
  catch (err) { add('file_resolves', false, err.message); return done(); }
  const v = validateRegistrationFile(out.file); out.warnings = v.warnings;
  add('file_schema_valid', v.ok, v.ok ? 'ok' : v.errors.join('; '));
  const agentRegistry = agentRegistryId(reg.chainId, reg.identity);
  const listed = Array.isArray(out.file?.registrations) && out.file.registrations.some((r) => r && Number(r.agentId) === Number(id) && typeof r.agentRegistry === 'string' && r.agentRegistry.toLowerCase() === agentRegistry.toLowerCase());
  add('file_lists_this_agent', listed, `registrations must contain {agentId:${id}, agentRegistry:"${agentRegistry}"}`);
  if (expected !== undefined) add('content_matches_expected', canonicalJson(out.file) === canonicalJson(expected), 'canonical JSON equality with the file we built');
  if (expectedHash !== undefined) add('hash_matches_expected', registrationFileHash(out.file) === String(expectedHash).toLowerCase(), 'sha256(canonicalJson(file))');
  if (expected === undefined && expectedHash === undefined) out.warnings.push('no expected content or hash supplied: only structure and ownership were verified');
  return done();
}
