import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  SPEC, REGISTRATION_TYPE, TESTNET_REGISTRIES, BLOCKED_MAINNET_CHAIN_IDS, SELECTORS, EVENT_TOPICS, registryFor, agentRegistryId,
  encodeRegister, encodeRegisterEmpty, encodeRegisterWithMetadata, encodeSetAgentURI, encodeSetMetadata, encodeOwnerOf, encodeTokenURI,
  encodeGetMetadata, encodeGetAgentWallet, buildRegisterTx, decodeUint256, decodeAddress, decodeString, decodeBytes, parseRegisteredLog,
  buildRegistrationFile, validateRegistrationFile, canonicalJson, registrationFileHash, toDataUri, fromDataUri, fetchRegistrationFile,
  verifyRegistration,
} from '../src/identity/erc8004.js';

// viem is a web/ dependency, only used here as an independent cross-check. Skipped (visibly) when it is not installed.
let viem = null;
try { viem = createRequire(new URL('../web/package.json', import.meta.url))('viem'); } catch { /* not installed */ }
const needViem = { skip: viem ? false : 'viem not installed (run `npm --prefix web ci`)' };

const OWNER = '0x1111111111111111111111111111111111111111';
const AGENT_ID = 7n;
const CHAIN = 84532;
const REG = TESTNET_REGISTRIES[CHAIN].identity;
const ABI = viem && viem.parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function register() returns (uint256)',
  'struct MetadataEntry { string metadataKey; bytes metadataValue; }',
  'function register(string agentURI, MetadataEntry[] metadata) returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
]);

// ---------------------------------------------------------------- constants and the testnet table
test('spec metadata and testnet-only table', () => {
  assert.equal(SPEC.status, 'Draft');
  assert.match(SPEC.ercsCommit, /^[0-9a-f]{40}$/); assert.match(SPEC.contractsCommit, /^[0-9a-f]{40}$/);
  assert.equal(REGISTRATION_TYPE, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  const ids = Object.keys(TESTNET_REGISTRIES).map(Number).sort((a, b) => a - b);
  assert.deepEqual(ids, [97, 10143, 84532, 421614, 11155111, 11155420].sort((a, b) => a - b));
  for (const r of Object.values(TESTNET_REGISTRIES)) {
    assert.match(r.identity, /^0x8004A818[0-9a-fA-F]{32}$/); // testnet vanity prefix; mainnet is 0x8004A169...
    assert.ok(!/8004A169|8004BAa1/i.test(r.identity + r.reputation), 'mainnet address leaked into the testnet table');
    assert.match(r.source, /erc-8004-contracts\/blob\/b9e466c250744a7e06b13dff9d3c2844ed64f825\/README\.md#L\d+-\d+/);
  }
  assert.equal(Object.isFrozen(TESTNET_REGISTRIES), true);
});

test('mainnets are blocked and unknown chains are rejected', () => {
  for (const id of [1, 8453, 42161, 10, 56, 137]) { assert.ok(BLOCKED_MAINNET_CHAIN_IDS.has(id)); assert.throws(() => registryFor(id), /mainnet/); }
  assert.throws(() => registryFor(31337), /no verified testnet registry/);
  assert.throws(() => buildRegisterTx({ chainId: 1, agentURI: 'https://x.example/a.json' }), /mainnet/);
  assert.equal(agentRegistryId(CHAIN), `eip155:${CHAIN}:${REG}`);
  assert.throws(() => agentRegistryId(CHAIN, '0x123'), /bad identity registry/);
});

// ---------------------------------------------------------------- encoding vectors
test('hard-coded selectors and topics match viem', needViem, () => {
  for (const [sig, sel] of Object.entries(SELECTORS)) assert.equal(viem.toFunctionSelector(sig), sel, sig);
  assert.equal(viem.toEventSelector('Registered(uint256,string,address)'), EVENT_TOPICS.Registered);
  assert.equal(viem.toEventSelector('URIUpdated(uint256,string,address)'), EVENT_TOPICS.URIUpdated);
  assert.equal(viem.toEventSelector('Transfer(address,address,uint256)'), EVENT_TOPICS.Transfer);
});

const STRINGS = ['', 'a', 'https://autonear.example/.well-known/agent-registration.json', 'x'.repeat(31), 'x'.repeat(32), 'x'.repeat(33), 'ünïcödé 🚀 ' + 'y'.repeat(100), toDataUri({ a: 1 })];
test('call encoders equal viem.encodeFunctionData for every string length class', needViem, () => {
  for (const s of STRINGS) {
    assert.equal(encodeRegister(s), viem.encodeFunctionData({ abi: ABI, functionName: 'register', args: [s] }), `register(${s.length})`);
    assert.equal(encodeSetAgentURI(7, s), viem.encodeFunctionData({ abi: ABI, functionName: 'setAgentURI', args: [7n, s] }), 'setAgentURI');
    assert.equal(encodeGetMetadata(2n ** 200n, s), viem.encodeFunctionData({ abi: ABI, functionName: 'getMetadata', args: [2n ** 200n, s] }), 'getMetadata');
    assert.equal(encodeSetMetadata('12', s, '0xdeadbeef'), viem.encodeFunctionData({ abi: ABI, functionName: 'setMetadata', args: [12n, s, '0xdeadbeef'] }), 'setMetadata');
  }
  assert.equal(encodeRegisterEmpty(), viem.encodeFunctionData({ abi: ABI, functionName: 'register', args: [] }));
  for (const id of [0, 1, 7n, '123456789', 2n ** 256n - 1n]) {
    assert.equal(encodeOwnerOf(id), viem.encodeFunctionData({ abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] }));
    assert.equal(encodeTokenURI(id), viem.encodeFunctionData({ abi: ABI, functionName: 'tokenURI', args: [BigInt(id)] }));
    assert.equal(encodeGetAgentWallet(id), viem.encodeFunctionData({ abi: ABI, functionName: 'getAgentWallet', args: [BigInt(id)] }));
  }
  for (const bytes of ['0x', '0x00', '0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(33)]) {
    assert.equal(encodeSetMetadata(1, 'k', bytes), viem.encodeFunctionData({ abi: ABI, functionName: 'setMetadata', args: [1n, 'k', bytes] }));
  }
});

test('register(string, MetadataEntry[]) equals viem (empty, one, many entries)', needViem, () => {
  const sets = [[], [{ metadataKey: 'k', metadataValue: '0x01' }], [{ metadataKey: 'a'.repeat(40), metadataValue: '0x' }, { metadataKey: '', metadataValue: '0x' + 'ff'.repeat(70) }, { metadataKey: 'ü', metadataValue: '0x1234' }]];
  for (const m of sets) {
    assert.equal(encodeRegisterWithMetadata('ipfs://bafy', m), viem.encodeFunctionData({ abi: ABI, functionName: 'register', args: ['ipfs://bafy', m] }), JSON.stringify(m));
  }
});

test('decoders equal viem.decodeFunctionResult / encodeAbiParameters', needViem, () => {
  for (const s of STRINGS) assert.equal(decodeString(viem.encodeAbiParameters([{ type: 'string' }], [s])), s);
  assert.equal(decodeAddress(viem.encodeAbiParameters([{ type: 'address' }], [OWNER])), OWNER);
  assert.equal(decodeUint256(viem.encodeAbiParameters([{ type: 'uint256' }], [123n])), 123n);
  assert.equal(decodeBytes(viem.encodeAbiParameters([{ type: 'bytes' }], ['0xcafe'])), '0xcafe');
  assert.equal(decodeBytes(viem.encodeAbiParameters([{ type: 'bytes' }], ['0x'])), '0x');
});

test('Registered log parsing equals viem.encodeEventTopics/encodeAbiParameters', needViem, () => {
  const topics = viem.encodeEventTopics({ abi: ABI, eventName: 'Registered', args: { agentId: 9n, owner: OWNER } });
  const data = viem.encodeAbiParameters([{ type: 'string' }], ['https://x.example/a.json']);
  assert.equal(topics[0], EVENT_TOPICS.Registered);
  assert.deepEqual(parseRegisteredLog({ topics, data }), { agentId: 9n, owner: OWNER, agentURI: 'https://x.example/a.json' });
  assert.throws(() => parseRegisteredLog({ topics: [EVENT_TOPICS.Transfer], data: '0x' }), /not a Registered/);
});

test('known-answer vector (no viem needed): register("a")', () => {
  const d = encodeRegister('a');
  assert.equal(d, '0xf2c298be' + '20'.padStart(64, '0') + '1'.padStart(64, '0') + '61'.padEnd(64, '0'));
  assert.equal(encodeOwnerOf(1), '0x6352211e' + '1'.padStart(64, '0'));
});

test('encoders reject bad input and reserved key', () => {
  assert.throws(() => encodeOwnerOf(-1), /unsigned/);
  assert.throws(() => encodeOwnerOf(1.5), /unsigned/);
  assert.throws(() => encodeOwnerOf('0x10'), /unsigned/);
  assert.throws(() => encodeOwnerOf(2n ** 256n), /unsigned/);
  assert.throws(() => encodeRegister(5), /string/);
  assert.throws(() => encodeSetMetadata(1, 'agentWallet', '0x'), /reserved/);
  assert.throws(() => encodeRegisterWithMetadata('u', [{ metadataKey: 'agentWallet', metadataValue: '0x' }]), /reserved/);
  assert.throws(() => encodeSetMetadata(1, 'k', 'nothex'), /bytes/);
});

test('buildRegisterTx is an unsigned request, nothing more', () => {
  const tx = buildRegisterTx({ chainId: CHAIN, agentURI: 'https://x.example/a.json' });
  assert.deepEqual(Object.keys(tx).sort(), ['chainId', 'data', 'to', 'value']);
  assert.equal(tx.to, REG); assert.equal(tx.value, '0x0'); assert.equal(tx.data, encodeRegister('https://x.example/a.json'));
  assert.throws(() => buildRegisterTx({ chainId: CHAIN, agentURI: '' }), /agentURI/);
});

test('decoders reject malformed / hostile results', () => {
  assert.throws(() => decodeAddress('0x'), /truncated/);
  assert.throws(() => decodeAddress('0x' + 'ff'.repeat(32)), /not an address/);
  assert.throws(() => decodeString('0x' + '20'.padStart(64, '0') + 'ffffffff'.padStart(64, '0')), /bad dynamic length|truncated/);
  assert.throws(() => decodeString('0x' + (2n ** 255n).toString(16).padStart(64, '0')), /truncated|bad dynamic/);
  assert.throws(() => decodeString('zz'), /malformed/);
  assert.throws(() => decodeString('0x' + '20'.padStart(64, '0') + '1'.padStart(64, '0') + 'ff'.padEnd(64, '0')), /./); // invalid utf-8
});

// ---------------------------------------------------------------- registration file
const GOOD = () => buildRegistrationFile({
  name: 'AutoNEAR agent', description: 'Evidence-to-product agent (testnet only)', image: 'https://autonear.example/logo.png',
  services: [{ name: 'web', endpoint: 'https://autonear.example/', version: '1' }, { name: 'MCP', endpoint: 'https://autonear.example/mcp', version: '2025-06-18' }],
  registrations: [{ agentId: 7, agentRegistry: agentRegistryId(CHAIN) }], supportedTrust: ['reputation'],
});

test('registration file has exactly the ERC field names and order', () => {
  const f = GOOD();
  assert.deepEqual(Object.keys(f), ['type', 'name', 'description', 'image', 'services', 'x402Support', 'active', 'registrations', 'supportedTrust']);
  assert.equal(f.type, REGISTRATION_TYPE); assert.equal('endpoints' in f, false);
  assert.deepEqual(validateRegistrationFile(f), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(Object.keys(f.registrations[0]), ['agentId', 'agentRegistry']);
});

test('registration validation: each violation is reported', () => {
  const bad = (mut) => { const f = GOOD(); mut(f); return validateRegistrationFile(f); };
  assert.match(bad((f) => { f.type = 'x'; }).errors[0], /type/);
  assert.match(bad((f) => { f.name = ' '; }).errors[0], /name/);
  assert.match(bad((f) => { delete f.description; }).errors[0], /description/);
  assert.match(bad((f) => { f.services = {}; }).errors[0], /services/);
  assert.match(bad((f) => { f.services[0].endpoint = ''; }).errors[0], /endpoint/);
  assert.match(bad((f) => { f.services[0].name = 5; }).errors[0], /name/);
  assert.match(bad((f) => { f.x402Support = 'no'; }).errors[0], /x402Support/);
  assert.match(bad((f) => { f.active = 1; }).errors[0], /active/);
  assert.match(bad((f) => { f.registrations = 'x'; }).errors[0], /registrations/);
  assert.match(bad((f) => { f.registrations[0].agentId = -1; }).errors[0], /agentId/);
  assert.match(bad((f) => { f.registrations[0].agentRegistry = 'eip155:1'; }).errors[0], /agentRegistry/);
  assert.match(bad((f) => { f.supportedTrust = 'reputation'; }).errors[0], /supportedTrust/);
  assert.equal(validateRegistrationFile(null).ok, false); assert.equal(validateRegistrationFile([]).ok, false);
  // warnings, not errors
  const w = bad((f) => { delete f.image; f.registrations = []; f.supportedTrust = ['vibes']; delete f.services[0].version; f.services[0].endpoint = 'http://insecure.example'; });
  assert.equal(w.ok, true); assert.equal(w.warnings.length, 5);
  // extra fields are allowed
  assert.equal(bad((f) => { f.custom = { a: 1 }; f.services[0].skills = []; }).ok, true);
});

test('a first-draft file (no registrations yet) is valid-with-warning, and extra service fields survive', () => {
  const f = buildRegistrationFile({ name: 'n', description: 'd', services: [{ name: 'OASF', endpoint: 'ipfs://cid', version: '0.8', skills: ['s'], domains: [] }] });
  assert.deepEqual(f.services[0], { name: 'OASF', endpoint: 'ipfs://cid', version: '0.8', skills: ['s'], domains: [] });
  const v = validateRegistrationFile(f);
  assert.equal(v.ok, true); assert.ok(v.warnings.some((x) => /registrations is empty/.test(x)));
  assert.equal('supportedTrust' in f, false);
});

test('canonical JSON / hash / data URI round trip are key-order independent', () => {
  const a = GOOD(); const rev = (v) => (Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, rev(x)])) : v); const b = rev(a);
  assert.notDeepEqual(Object.keys(a), Object.keys(b));
  assert.equal(canonicalJson(a), canonicalJson(b)); assert.equal(registrationFileHash(a), registrationFileHash(b));
  assert.match(registrationFileHash(a), /^[0-9a-f]{64}$/);
  const changed = GOOD(); changed.name = 'other'; assert.notEqual(registrationFileHash(changed), registrationFileHash(a));
  assert.deepEqual(fromDataUri(toDataUri(a)), a);
  assert.throws(() => fromDataUri('data:text/plain;base64,AAAA'), /data URI/);
  assert.equal(registrationFileHash({ b: [1, 2], a: 1 }), '8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874'); // sha256 of {"a":1,"b":[1,2]}
});

// ---------------------------------------------------------------- mocked RPC + verifyRegistration
const RPC = 'https://sepolia.base.org';
const FILE_URL = 'https://autonear.example/agent.json';
// Independent string encoder for the mock (viem when present, hand-rolled otherwise) so the decoder is not tested against itself.
function abiString(s) {
  if (viem) return viem.encodeAbiParameters([{ type: 'string' }], [s]);
  const h = Buffer.from(s).toString('hex'); return '0x' + '20'.padStart(64, '0') + (h.length / 2).toString(16).padStart(64, '0') + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
}
const abiAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
function mockChain({ chainId = CHAIN, code = '0x6080', owner = OWNER, uri = FILE_URL, wallet = OWNER, files = {}, rpcFail = null, calls = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u === RPC) {
      const req = JSON.parse(init.body); calls.push(req.method);
      if (rpcFail) return new Response('nope', { status: 500 });
      const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200 });
      if (req.method === 'eth_chainId') return reply('0x' + chainId.toString(16));
      if (req.method === 'eth_getCode') return reply(code);
      if (req.method === 'eth_call') {
        const { to, data } = req.params[0];
        assert.equal(to.toLowerCase(), REG.toLowerCase());
        const sel = data.slice(0, 10);
        if (sel === SELECTORS['ownerOf(uint256)']) return reply(abiAddr(owner));
        if (sel === SELECTORS['tokenURI(uint256)']) return reply(abiString(uri));
        if (sel === SELECTORS['getAgentWallet(uint256)']) return reply(abiAddr(wallet));
        throw new Error(`unexpected selector ${sel}`);
      }
      throw new Error(`unexpected rpc ${req.method}`);
    }
    if (u in files) return new Response(typeof files[u] === 'string' ? files[u] : JSON.stringify(files[u]), { status: 200 });
    return new Response('not found', { status: 404 });
  };
}

const run = async (over = {}, args = {}) => {
  const file = GOOD(); const calls = [];
  const fetchImpl = mockChain({ ...over, calls, files: over.files ?? { [FILE_URL]: file } });
  const res = await verifyRegistration({ rpc: RPC, chainId: CHAIN, agentId: AGENT_ID, expectedOwner: OWNER, expected: file, fetchImpl, ...args });
  return { res, calls };
};
const failed = (res) => res.checks.filter((c) => !c.ok).map((c) => c.name);

test('verifyRegistration: happy path via https', async () => {
  const { res, calls } = await run();
  assert.deepEqual(failed(res), []); assert.equal(res.ok, true);
  assert.deepEqual(res.checks.map((c) => c.name), ['expected_owner_valid', 'testnet_registry', 'chain_id_matches', 'registry_has_code', 'owner_matches', 'token_uri_readable', 'file_resolves', 'file_schema_valid', 'file_lists_this_agent', 'content_matches_expected']);
  assert.equal(res.owner.toLowerCase(), OWNER); assert.equal(res.agentURI, FILE_URL);
  assert.ok(calls.every((m) => ['eth_chainId', 'eth_getCode', 'eth_call'].includes(m)), 'read-only methods only');
  assert.ok(!calls.some((m) => /send|sign/i.test(m)));
});

test('verifyRegistration: data: URI agentURI, hash comparison, wallet check, owner comparison is case-insensitive', async () => {
  const file = GOOD();
  const { res } = await run({ uri: toDataUri(file), file, owner: OWNER.toUpperCase().replace('0X', '0x') }, { expected: undefined, expectedHash: registrationFileHash(file), expectedWallet: OWNER });
  assert.deepEqual(failed(res), []); assert.ok(res.checks.some((c) => c.name === 'hash_matches_expected'));
});

test('verifyRegistration: wrong owner', async () => {
  const { res } = await run({ owner: '0x2222222222222222222222222222222222222222' });
  assert.equal(res.ok, false); assert.deepEqual(failed(res), ['owner_matches']);
});

test('verifyRegistration: content tampered or not listing this agent', async () => {
  const other = GOOD(); other.description = 'changed after registration';
  const { res } = await run({ files: { [FILE_URL]: other } }, { expected: GOOD() });
  assert.deepEqual(failed(res), ['content_matches_expected']);
  const wrongId = GOOD(); wrongId.registrations[0].agentId = 8;
  const r2 = await run({ files: { [FILE_URL]: wrongId } }, { expected: wrongId });
  assert.deepEqual(failed(r2.res), ['file_lists_this_agent']);
  const wrongReg = GOOD(); wrongReg.registrations[0].agentRegistry = agentRegistryId(CHAIN, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  const r3 = await run({ files: { [FILE_URL]: wrongReg } }, { expected: wrongReg });
  assert.deepEqual(failed(r3.res), ['file_lists_this_agent']);
  const r4 = await run({}, { expectedHash: 'f'.repeat(64), expected: undefined });
  assert.deepEqual(failed(r4.res), ['hash_matches_expected']);
});

test('verifyRegistration: invalid file, unreachable file, empty URI, ipfs without gateway', async () => {
  const bad = { type: 'nope' };
  const r1 = await run({ files: { [FILE_URL]: bad } }, { expected: undefined });
  assert.ok(failed(r1.res).includes('file_schema_valid'));
  const r2 = await run({ files: {} });
  assert.deepEqual(failed(r2.res), ['file_resolves']); assert.match(r2.res.checks.at(-1).detail, /404/);
  const r3 = await run({ uri: '' });
  assert.deepEqual(failed(r3.res), ['token_uri_readable']);
  const r4 = await run({ uri: 'ipfs://bafy123' });
  assert.deepEqual(failed(r4.res), ['file_resolves']); assert.match(r4.res.checks.at(-1).detail, /ipfsGateway/);
  const files = { 'https://gw.example/ipfs/bafy123': GOOD() };
  const r5 = await run({ uri: 'ipfs://bafy123', files }, { ipfsGateway: 'https://gw.example/ipfs/' });
  assert.deepEqual(failed(r5.res), []);
});

test('verifyRegistration: wrong chain, no code, mainnet refused, rpc failure, bad inputs', async () => {
  assert.deepEqual(failed((await run({ chainId: 1 })).res), ['chain_id_matches']);
  assert.deepEqual(failed((await run({ code: '0x' })).res), ['registry_has_code']);
  const main = await verifyRegistration({ rpc: RPC, chainId: 8453, agentId: 1, expectedOwner: OWNER, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(main.ok, false); assert.deepEqual(failed(main), ['testnet_registry']);
  assert.deepEqual(failed((await run({ rpcFail: true })).res), ['rpc_reachable']);
  assert.deepEqual(failed(await verifyRegistration({ rpc: RPC, chainId: CHAIN, agentId: -1, expectedOwner: OWNER })), ['agent_id_valid']);
  assert.deepEqual(failed(await verifyRegistration({ rpc: RPC, chainId: CHAIN, agentId: 1, expectedOwner: 'nope' })), ['expected_owner_valid']);
  assert.equal((await verifyRegistration({})).ok, false);
});

test('verifyRegistration: RPC host outside the allowlist is refused by the shared HTTP policy', async () => {
  const res = await verifyRegistration({ rpc: 'https://evil.example/rpc', chainId: CHAIN, agentId: 1, expectedOwner: OWNER, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(failed(res), ['rpc_reachable']); assert.match(res.checks.at(-1).detail, /policy/);
});

test('verifyRegistration: warns when no expected content or hash is supplied', async () => {
  const { res } = await run({}, { expected: undefined });
  assert.equal(res.ok, true); assert.ok(res.warnings.some((w) => /only structure and ownership/.test(w)));
});

test('fetchRegistrationFile: SSRF guards', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  for (const u of ['http://autonear.example/a.json', 'https://127.0.0.1/a.json', 'https://localhost/a.json', 'https://10.0.0.5/a.json', 'https://169.254.169.254/latest', 'https://[::1]/a.json', 'https://192.168.1.1/a', 'https://printer.local/a', 'https://user:pw@autonear.example/a.json', 'https://2130706433/a']) {
    await assert.rejects(fetchRegistrationFile(u, { fetchImpl: never }), /refusing|non-https|private/i, u);
  }
  await assert.rejects(fetchRegistrationFile(FILE_URL, { fetchImpl: never, allowHosts: ['other.example'] }), /allowHosts/);
  await assert.rejects(fetchRegistrationFile(FILE_URL, { fetchImpl: async () => new Response('x'.repeat(300_000)) }), /too large/);
  await assert.rejects(fetchRegistrationFile(FILE_URL, { fetchImpl: async () => new Response('not json') }), /JSON|Unexpected/);
  await assert.rejects(fetchRegistrationFile(FILE_URL, { fetchImpl: async () => new Response('', { status: 302 }) }), /HTTP 302/);
  let seen; await fetchRegistrationFile(FILE_URL, { fetchImpl: async (u, init) => { seen = init; return new Response('{}'); } });
  assert.equal(seen.redirect, 'manual');
});
