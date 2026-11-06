// Agent signing wallet: crypto known-answer tests, viem cross-checks (dev-only, from web/node_modules), NEAR borsh vector
// from nearcore's own near-primitives crate, keystore safety, limits, secret hygiene, and a real local anvil.
// Local chains / fake RPCs only: no mainnet ids or hosts, no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { keccak256, keccak256Hex, bytesToHex } from '../src/agent/keccak.js';
import * as secp from '../src/agent/secp256k1.js';
import { rlpEncode, rlpDecode, rlpInt } from '../src/agent/rlp.js';
import * as evm from '../src/agent/evm-signer.js';
import * as near from '../src/agent/near-signer.js';
import { base58Encode, base58Decode } from '../src/agent/base58.js';
import { loadKeystore, KeystoreError, assertKeyFileSafe } from '../src/agent/keystore.js';
import { LimitError } from '../src/agent/limits.js';

// ---- viem is a dev-only cross-check (installed under web/node_modules); tests that need it skip cleanly without it.
const require = createRequire(new URL('../web/package.json', import.meta.url));
let viem = null; let vacc = null;
try { viem = require('viem'); vacc = require('viem/accounts'); } catch { /* web deps not installed */ }
const needViem = !viem && 'viem not installed (npm --prefix web ci)';

const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil/hardhat dev key #0 (public, holds no value)
const ADDR0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const KEY1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const h2b = (h) => secp.hexToBytes(h);
const hex = (b) => '0x' + bytesToHex(b);
const sigHex = ({ r, s }) => ({ r: hex(r), s: hex(s) });

describe('keccak-256', () => {
  test('known answers: empty, abc, and it is NOT NIST sha3-256', () => {
    assert.equal(keccak256Hex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    assert.equal(keccak256Hex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    assert.equal(keccak256Hex('transfer(address,uint256)').slice(0, 10), '0xa9059cbb'); // ERC-20 transfer selector
    assert.notEqual(bytesToHex(keccak256('')), createHash('sha3-256').update('').digest('hex'));
  });
  test('long inputs around the 136-byte rate boundary match viem', { skip: needViem }, () => {
    for (const n of [1, 55, 135, 136, 137, 271, 272, 273, 1000, 5000]) {
      const m = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      assert.equal(hex(keccak256(m)), viem.keccak256(hex(m)), `len ${n}`);
    }
  });
  test('long input known answer (200 bytes of 0xA3, Keccak team KAT)', () => {
    // Keccak-256 of 200 bytes 0xA3 (KeccakKAT ShortMsgKAT-style vector, Len=1600): 3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a
    assert.equal(bytesToHex(keccak256(new Uint8Array(200).fill(0xa3))), '3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a');
  });
});

describe('secp256k1', () => {
  test('anvil dev keys derive the documented addresses; private key 1 -> well-known address', () => {
    assert.equal(secp.privateKeyToAddress(h2b(KEY0)), ADDR0);
    assert.equal(secp.privateKeyToAddress(h2b(KEY1)), ADDR1);
    assert.equal(secp.privateKeyToAddress(h2b('0x' + '00'.repeat(31) + '01')), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    assert.equal(secp.getPublicKey(h2b(KEY0)).length, 65);
  });
  test('EIP-55 checksum vectors from the EIP', () => {
    for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
      assert.equal(secp.toChecksumAddress(a.toLowerCase()), a);
      assert.equal(secp.isValidAddress(a), true);
    }
    assert.equal(secp.isValidAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false, 'wrong checksum rejected');
    assert.equal(secp.isValidAddress('0x123'), false);
  });
  test('rejects out-of-range private keys', () => {
    assert.throws(() => secp.getPublicKey(new Uint8Array(32)), /out of range/);
    assert.throws(() => secp.getPublicKey(h2b('0x' + 'ff'.repeat(32))), /out of range/);
    assert.throws(() => secp.getPublicKey(new Uint8Array(31).fill(1)), /32 bytes/);
  });
  test('RFC6979 + low-s: deterministic, recoverable, verifiable, s <= n/2', () => {
    for (let i = 0; i < 25; i++) {
      const priv = secp.generatePrivateKey(); const digest = keccak256(`message ${i}`);
      const a = secp.signDigest(digest, priv); const b = secp.signDigest(digest, priv);
      assert.deepEqual(a, b, 'deterministic');
      assert.ok(secp.bytesToBigInt(a.s) <= secp.N >> 1n, 'low s');
      assert.equal(hex(secp.recoverPublicKey(digest, a)), hex(secp.getPublicKey(priv)), 'recovers the signer');
      assert.equal(secp.verifyDigest(digest, a, secp.getPublicKey(priv)), true);
      const bad = Uint8Array.from(digest); bad[0] ^= 1;
      assert.equal(secp.verifyDigest(bad, a, secp.getPublicKey(priv)), false);
    }
  });
  test('published RFC6979/secp256k1 vector (key 1, sha256("Satoshi Nakamoto")), no viem needed', () => {
    const d = new Uint8Array(createHash('sha256').update('Satoshi Nakamoto').digest());
    const g = secp.signDigest(d, h2b('0x' + '00'.repeat(31) + '01'));
    assert.equal(bytesToHex(g.r), '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8');
    assert.equal(bytesToHex(g.s), '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');
  });
  test('cross-check vs viem: identical r, s, v over many digests and keys', { skip: needViem }, async () => {
    const keys = [KEY0, KEY1, '0x' + '00'.repeat(31) + '01', '0x' + 'ff'.repeat(15) + '00'.repeat(16) + '07', hex(secp.generatePrivateKey())];
    for (const k of keys) {
      for (let i = 0; i < 8; i++) {
        const digest = keccak256(`digest ${k.slice(-6)} ${i}`);
        const mine = secp.signDigest(digest, h2b(k));
        const theirs = await vacc.sign({ hash: hex(digest), privateKey: k, to: 'object' });
        assert.equal(hex(mine.r), theirs.r); assert.equal(hex(mine.s), theirs.s); assert.equal(mine.recovery, theirs.yParity);
      }
    }
  });
});

describe('RLP', () => {
  const S = (s) => new TextEncoder().encode(s);
  const cases = [ // from the Ethereum wiki RLP examples
    [S('dog'), '83646f67'], [[S('cat'), S('dog')], 'c88363617483646f67'], [S(''), '80'], [[], 'c0'], [rlpInt(0), '80'], [rlpInt(15), '0f'],
    [rlpInt(1024), '820400'], [[[], [[]], [[], [[]]]], 'c7c0c1c0c3c0c1c0'],
    [S('Lorem ipsum dolor sit amet, consectetur adipisicing elit'), 'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974'],
  ];
  test('encode matches wiki vectors and decode round-trips', () => {
    for (const [item, expect] of cases) {
      assert.equal(bytesToHex(rlpEncode(item)), expect);
      assert.equal(bytesToHex(rlpEncode(rlpDecode(h2b(expect)))), expect);
    }
  });
  test('long lists / strings use multi-byte length prefixes; non-canonical input rejected', () => {
    const big = new Uint8Array(70000).fill(7);
    assert.equal(rlpDecode(rlpEncode(big)).length, 70000);
    assert.equal(bytesToHex(rlpEncode(big).subarray(0, 4)), 'ba011170');
    assert.throws(() => rlpDecode(h2b('8100')), /non-canonical/); // single byte < 0x80 must not be prefixed
    assert.throws(() => rlpDecode(h2b('b800')), /non-canonical|truncated/);
    assert.throws(() => rlpDecode(h2b('c883636174')), /truncated/);
    assert.throws(() => rlpEncode(5), /rlpInt/);
  });
});

describe('ABI encoding for the vault calls', () => {
  const abi = [{ type: 'function', name: 'draw', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'deploy', stateMutability: 'nonpayable', inputs: [{ name: 'template', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'code', type: 'bytes' }], outputs: [{ type: 'address' }] }];
  test('selectors are computed from signatures', () => {
    assert.equal(bytesToHex(evm.selector('draw(uint256)')), bytesToHex(keccak256('draw(uint256)').slice(0, 4)));
    assert.equal(bytesToHex(evm.selector('transfer(address,uint256)')), 'a9059cbb');
    assert.equal(evm.signatureFromAbi(abi, 'deploy'), 'deploy(bytes32,bytes32,bytes)');
    assert.throws(() => evm.selector('f((uint256,uint256))'), /unsupported/);
  });
  test('draw / deploy calldata == viem encodeFunctionData', { skip: needViem }, () => {
    for (const amount of [0n, 1n, 10n ** 18n, (1n << 256n) - 1n]) assert.equal(hex(evm.encodeDraw(amount)), viem.encodeFunctionData({ abi, functionName: 'draw', args: [amount] }));
    const template = hex(keccak256('t')); const salt = hex(keccak256('s'));
    for (const n of [0, 1, 31, 32, 33, 64, 300]) {
      const code = new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
      assert.equal(hex(evm.encodeDeploy(template, salt, code)), viem.encodeFunctionData({ abi, functionName: 'deploy', args: [template, salt, hex(code)] }), `code len ${n}`);
    }
  });
  test('rejects malformed arguments', () => {
    assert.throws(() => evm.encodeDraw(-1n), /out of range/);
    assert.throws(() => evm.encodeDraw(1n << 256n), /out of range/);
    assert.throws(() => evm.encodeDraw(1.5), /out of range/);
    assert.throws(() => evm.encodeDeploy('0x1234', '0x' + '00'.repeat(32), new Uint8Array(1)), /exactly 32/);
  });
  test('generic encoder (address / bool / string) matches viem', { skip: needViem }, () => {
    const a = [{ type: 'function', name: 'f', inputs: [{ type: 'address' }, { type: 'bool' }, { type: 'string' }, { type: 'uint8' }], outputs: [] }];
    assert.equal(hex(evm.encodeCall('f(address,bool,string,uint8)', [ADDR1, true, 'hello', 7])), viem.encodeFunctionData({ abi: a, functionName: 'f', args: [ADDR1, true, 'hello', 7] }));
  });
});

describe('EVM transactions', () => {
  const sign = (k) => (d) => secp.signDigest(d, h2b(k));
  const base = { chainId: 84532, nonce: 7n, maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 3_000_000_000n, gas: 60_000n, to: VAULT, value: 0n };
  test('EIP-1559 signed tx bytes == viem serializeTransaction / account.signTransaction', { skip: needViem }, async () => {
    const acct = vacc.privateKeyToAccount(KEY0);
    const variants = [
      { ...base, data: evm.encodeDraw(123n) },
      { ...base, value: 10n ** 18n, data: new Uint8Array(0), to: ADDR1, nonce: 0n },
      { ...base, to: null, data: h2b('0x6001600c60003960016000f300'), gas: 100_000n }, // contract creation
      { ...base, data: evm.encodeDraw(5n), accessList: [{ address: VAULT, storageKeys: ['0x' + '00'.repeat(31) + '01'] }] },
    ];
    for (const tx of variants) {
      const mine = evm.signTransaction({ ...tx, type: 'eip1559' }, sign(KEY0));
      const vtx = { type: 'eip1559', chainId: tx.chainId, nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gas: tx.gas, to: tx.to ?? undefined, value: tx.value, data: hex(tx.data), accessList: tx.accessList ?? [] };
      assert.equal(mine.rawHex, await acct.signTransaction(vtx), 'signed bytes');
      assert.equal(hex(evm.serializeEip1559(tx)), viem.serializeTransaction(vtx), 'unsigned payload');
      assert.equal(mine.hash, viem.keccak256(mine.rawHex), 'tx hash');
      const parsed = viem.parseTransaction(mine.rawHex);
      assert.equal(parsed.nonce, Number(tx.nonce)); assert.equal(parsed.chainId, tx.chainId);
    }
  });
  test('legacy EIP-155 signed tx bytes == viem', { skip: needViem }, async () => {
    const acct = vacc.privateKeyToAccount(KEY1);
    const tx = { type: 'legacy', chainId: 97, nonce: 3n, gasPrice: 5_000_000_000n, gas: 21_000n, to: ADDR0, value: 12345n, data: new Uint8Array(0) };
    const mine = evm.signTransaction(tx, sign(KEY1));
    const vtx = { type: 'legacy', chainId: 97, nonce: 3, gasPrice: 5_000_000_000n, gas: 21_000n, to: ADDR0, value: 12345n };
    assert.equal(mine.rawHex, await acct.signTransaction(vtx));
  });
  test('recovering the signer from the signed EIP-1559 payload yields the agent address (no viem needed)', () => {
    const tx = { ...base, type: 'eip1559', data: evm.encodeDraw(9n) };
    const { signature } = evm.signTransaction(tx, sign(KEY0));
    const pub = secp.recoverPublicKey(keccak256(evm.serializeEip1559(tx)), signature);
    assert.equal(secp.publicKeyToAddress(pub), ADDR0);
  });
});

describe('NEAR keys and ed25519', () => {
  test('RFC 8032 test vector 1 (empty message) through node:crypto', () => {
    const seed = h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pub = near.ed25519PublicKey(seed);
    assert.equal(bytesToHex(pub), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = near.ed25519Signer(seed)(new Uint8Array(0));
    assert.equal(bytesToHex(sig), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
    assert.equal(near.ed25519Verify(pub, new Uint8Array(0), sig), true);
    assert.equal(near.ed25519Verify(pub, Uint8Array.of(1), sig), false);
  });
  test('sign / verify round trip with a generated key', () => {
    const seed = near.generateSeed(); const pub = near.ed25519PublicKey(seed); const msg = new TextEncoder().encode('hello near');
    const sig = near.ed25519Signer(seed)(msg);
    assert.equal(sig.length, 64); assert.equal(near.ed25519Verify(pub, msg, sig), true);
    const tampered = Uint8Array.from(sig); tampered[3] ^= 1; assert.equal(near.ed25519Verify(pub, msg, tampered), false);
  });
  test('implicit account, ed25519:<base58> import/export, base58', () => {
    const seed = h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'); const pub = near.ed25519PublicKey(seed);
    assert.equal(near.implicitAccountId(pub), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    assert.equal(near.formatPublicKey(pub), 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'); // matches near-crypto 0.27.0 Display
    const sk = near.formatSecretKey(seed);
    assert.match(sk, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    assert.deepEqual(near.parseSecretKey(sk), seed);
    assert.deepEqual(near.parseSecretKey('ed25519:' + base58Encode(seed)), seed, '32-byte seed form');
    assert.deepEqual(near.parsePublicKey(near.formatPublicKey(pub)), pub);
    assert.throws(() => near.parseSecretKey('ed25519:' + base58Encode(new Uint8Array([...seed, ...new Uint8Array(32).fill(9)]))), /does not match/);
    assert.throws(() => near.parseSecretKey('secp256k1:abc'), /ed25519/);
    for (const b of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(0), new Uint8Array([1])]) assert.deepEqual(base58Decode(base58Encode(b)), b);
    assert.throws(() => base58Decode('0OIl'), /invalid character/);
  });
});

describe('NEAR borsh Transaction / SignedTransaction', () => {
  // VECTOR PROVENANCE: generated with nearcore's own Rust crates near-primitives 0.27.0 / near-crypto 0.27.0 (borsh 1.x),
  // offline from the local cargo registry, in a throwaway crate: Transaction::V0 {signer_id = hex(pubkey), nonce 7,
  // receiver_id vault.autonear.testnet, block_hash = 00 01 .. 1f, actions = [FunctionCall draw {"amount":"1000000000000000000000"}
  // 30 TGas 0 deposit, Transfer 1 NEAR]}, SecretKey::ED25519(RFC8032 test-1 seed||pub). This is NOT a hand derivation.
  const seed = h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pub = near.ed25519PublicKey(seed);
  const tx = {
    signerId: near.implicitAccountId(pub), publicKey: pub, nonce: 7n, receiverId: 'vault.autonear.testnet',
    blockHash: Uint8Array.from({ length: 32 }, (_, i) => i),
    actions: [near.functionCall('draw', '{"amount":"1000000000000000000000"}', 30_000_000_000_000n, 0n), near.transfer(10n ** 24n)],
  };
  const TX_BORSH = '400000006437356139383031383262313061623764353462666564336339363430373361306565313732663364616136323332356166303231613638663730373531316100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a0700000000000000160000007661756c742e6175746f6e6561722e746573746e6574000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f02000000020400000064726177230000007b22616d6f756e74223a2231303030303030303030303030303030303030303030227d00e057eb481b00000000000000000000000000000000000003000000a1edccce1bc2d3000000000000';
  const TX_HASH = 'e07840b7370d80a8880043663476dd01862b5df18d9cbb9085ea390d1293c35b';
  const SIG = '00b46c1709e2e8a424d8e9eb252ab783ee30e6958757aad83b397bd2e4b8401aa1c17c0a92c38e5c11f53ec55b2fcf55f7f42f3f1fccb818b8148911d68ba13009'; // includes the leading 00 key-type byte
  test('Transaction bytes, sha256 hash, signature and SignedTransaction bytes equal the near-primitives vector', () => {
    const out = near.signTransaction(tx, near.ed25519Signer(seed));
    assert.equal(bytesToHex(out.txBytes), TX_BORSH);
    assert.equal(bytesToHex(out.hash), TX_HASH);
    assert.equal(out.hashB58, 'G7EgEgUu2PdAd9Lgv3jnncxcAfyf6kdQu1RXvP6vKNKL');
    assert.equal('00' + bytesToHex(out.signature), SIG);
    assert.equal(bytesToHex(out.signedBytes), TX_BORSH + SIG);
    assert.equal(near.ed25519Verify(pub, out.hash, out.signature), true);
  });
  test('only FunctionCall / Transfer are serialisable; bad sizes are rejected', () => {
    assert.throws(() => near.serializeTransaction({ ...tx, actions: [{ kind: 'DeleteAccount' }] }), /not supported/);
    assert.throws(() => near.serializeTransaction({ ...tx, blockHash: new Uint8Array(31) }), /32 bytes/);
    assert.throws(() => near.serializeTransaction({ ...tx, actions: [near.transfer(1n << 128n)] }), /u128/);
  });
});

// ---------- fake JSON-RPC (fetchImpl injection; the host must still pass the http-client allowlist) ----------
function fakeRpc(handlers, log = []) {
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    log.push({ method, params });
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } }), { status: 200 });
    try { const result = await h(params); return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 }); } catch (e) { return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }), { status: 200 }); }
  };
}
const EVM_URL = 'https://sepolia.base.org';
const evmHandlers = (over = {}) => ({
  eth_chainId: () => '0x14a34', eth_getTransactionCount: () => '0x5', eth_getBlockByNumber: () => ({ baseFeePerGas: '0x3b9aca00' }), eth_maxPriorityFeePerGas: () => '0x3b9aca00',
  eth_estimateGas: () => '0x9c40', eth_sendRawTransaction: () => { throw new Error('should be overridden'); },
  eth_getTransactionReceipt: () => ({ status: '0x1', blockNumber: '0x10', gasUsed: '0x6000', effectiveGasPrice: '0x77359400', contractAddress: null }), ...over,
});
const tmpDir = () => mkdtempSync(join(tmpdir(), 'agent-ks-'));
const memKeystore = (env = { AGENT_EVM_PRIVATE_KEY: KEY0, AGENT_NEAR_PRIVATE_KEY: near.formatSecretKey(h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')) }) => loadKeystore({ path: join(tmpDir(), 'none.json'), env });

describe('keystore', () => {
  test('create: file mode 0600, idempotent, public view has only public material', () => {
    const dir = tmpDir(); const path = join(dir, 'data', 'agent.keys.json');
    const a = loadKeystore({ path, env: {}, create: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const b = loadKeystore({ path, env: {}, create: true });
    assert.deepEqual(a.publicView(), b.publicView(), 'second run does not regenerate');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).evm.privateKey, raw.evm.privateKey);
    const view = JSON.stringify(a.publicView());
    assert.ok(!view.includes(raw.evm.privateKey.slice(2)) && !view.includes(raw.near.secretKey.slice(8)));
    assert.match(a.publicView().evm.address, /^0x[0-9a-fA-F]{40}$/); assert.match(a.publicView().near.account, /^[0-9a-f]{64}$/);
    assert.equal(loadKeystore({ path: join(dir, 'missing.json'), env: {} }).publicView().evm, null, 'no create flag, no keys, nothing written');
    assert.equal(existsSync(join(dir, 'missing.json')), false);
  });
  test('env wins over the file', () => {
    const dir = tmpDir(); const path = join(dir, 'k.json');
    loadKeystore({ path, env: {}, create: true });
    const ks = loadKeystore({ path, env: { AGENT_EVM_PRIVATE_KEY: KEY0 } });
    assert.equal(ks.publicView().evm.address, ADDR0); assert.equal(ks.publicView().evm.source, 'env'); assert.equal(ks.publicView().near.source, 'file');
  });
  test('refuses a group/world readable key file, a symlink, and malformed content (without echoing it)', () => {
    const dir = tmpDir(); const path = join(dir, 'k.json');
    loadKeystore({ path, env: {}, create: true });
    chmodSync(path, 0o640);
    assert.throws(() => loadKeystore({ path, env: {} }), (e) => e instanceof KeystoreError && /group\/others/.test(e.message) && /chmod 600/.test(e.message));
    chmodSync(path, 0o604);
    assert.throws(() => loadKeystore({ path, env: { AGENT_EVM_PRIVATE_KEY: KEY0 } }), KeystoreError, 'refused even when env would win');
    chmodSync(path, 0o600);
    assert.doesNotThrow(() => assertKeyFileSafe(path));
    const link = join(dir, 'link.json'); symlinkSync(path, link);
    assert.throws(() => loadKeystore({ path: link, env: {} }), /symlink/);
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{"evm":{"privateKey":"SECRETSECRETSECRET"', { mode: 0o600 });
    assert.throws(() => loadKeystore({ path: bad, env: {} }), (e) => !/SECRETSECRET/.test(e.message));
    const bad2 = join(dir, 'bad2.json'); writeFileSync(bad2, '{"evm":{"privateKey":"0xSECRETSECRETSECRET"}}', { mode: 0o600 });
    assert.throws(() => loadKeystore({ path: bad2, env: {} }), (e) => e instanceof KeystoreError && !/SECRETSECRET/.test(e.message));
    assert.throws(() => loadKeystore({ path: join(dir, 'none'), env: { AGENT_EVM_PRIVATE_KEY: 'not-a-key-SECRETVALUE1234' } }), (e) => !/SECRETVALUE/.test(e.message));
  });
  test('secrets never appear in JSON.stringify / inspect / String of the keystore, handles or signers', () => {
    const ks = memKeystore(); const nearSk = near.formatSecretKey(h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    const secrets = [KEY0.slice(2), nearSk.slice(8), '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', near.formatSecretKey(h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')).slice(8)];
    const signers = [ks.signer('evm', { rpcUrl: EVM_URL, chainId: 84532 }), ks.signer('near', { rpcUrl: 'https://rpc.testnet.near.org' })];
    for (const o of [ks, ks.evm, ks.near, ...signers]) {
      for (const s of [JSON.stringify(o), inspect(o, { depth: 6, showHidden: true }), inspect(o, { depth: 6 }), String(JSON.stringify(Object.keys(o)))]) for (const sec of secrets) assert.ok(!s.toLowerCase().includes(sec.toLowerCase()), 'secret leaked');
    }
    assert.equal(signers[0].address, ADDR0); assert.equal(signers[0].chain, 'evm'); assert.equal(signers[1].chain, 'near');
    assert.equal(Object.keys(ks.evm).some((k) => /priv|secret|seed|key$/i.test(k) && k !== 'publicKey'), false);
  });
  test('redact() scrubs known secrets, case-insensitively, plus any ed25519 secret-shaped string and env assignments', () => {
    const ks = memKeystore(); const foreign = near.formatSecretKey(near.generateSeed());
    const out = ks.redactText(`bad ${KEY0} / ${KEY0.slice(2).toUpperCase()} / ${foreign} / AGENT_EVM_PRIVATE_KEY=abc123 tx 0x${'ab'.repeat(32)}`);
    assert.ok(!out.includes(KEY0.slice(2)) && !out.toUpperCase().includes(KEY0.slice(2).toUpperCase()) && !out.includes(foreign.slice(8)) && !out.includes('abc123'));
    assert.ok(out.includes('0x' + 'ab'.repeat(32)), 'unrelated 32-byte hex (e.g. a tx hash) is kept');
    const e = new LimitError('fee_ceiling', `x ${KEY0}`); const r = ks.redact(e);
    assert.equal(r, e); assert.ok(r instanceof LimitError); assert.equal(r.code, 'fee_ceiling'); assert.ok(!r.message.includes(KEY0.slice(2))); assert.ok(!r.stack.includes(KEY0.slice(2)));
  });
});

describe('Signer limits (defense in depth) and RPC flow with a fake EVM node', () => {
  const limits = { maxFeePerTx: 10n ** 16n, allowedTargets: [VAULT], allowedMethods: ['draw', 'deploy'] };
  const draw = { method: 'draw', target: VAULT, args: { amount: 1000n } };
  function mk(over = {}, log = []) {
    const ks = memKeystore();
    return { log, signer: ks.signer('evm', { rpcUrl: EVM_URL, chainId: 84532, fetchImpl: fakeRpc(evmHandlers(over), log), pollMs: 1, sleep: async () => {} }), ks };
  }
  test('happy path: draw is signed by the agent key, sent as type-2 to the vault with zero value, calldata == encodeDraw', async () => {
    let sent;
    const { signer, log } = mk({ eth_sendRawTransaction: ([raw]) => { sent = raw; return '0x' + bytesToHex(keccak256(h2b(raw))); } });
    const res = await signer.signAndSend(draw, limits);
    assert.equal(res.ok, true); assert.equal(res.status, 'success'); assert.equal(res.txType, 'eip1559'); assert.equal(res.from, ADDR0);
    assert.equal(sent.slice(0, 4), '0x02'); // EIP-2718 type byte
    const parsed = rlpDecode(h2b(sent).subarray(1));
    assert.equal(hex(parsed[5]), VAULT.toLowerCase()); assert.equal(parsed[6].length, 0, 'value is zero'); assert.equal(hex(parsed[7]), hex(evm.encodeDraw(1000n)));
    const sigDigest = keccak256(concatBytes(Uint8Array.of(2), rlpEncode(parsed.slice(0, 9))));
    assert.equal(secp.publicKeyToAddress(secp.recoverPublicKey(sigDigest, { r: pad32(parsed[10]), s: pad32(parsed[11]), recovery: parsed[9].length ? parsed[9][0] : 0 })), ADDR0);
    assert.equal(log.filter((l) => l.method === 'eth_sendRawTransaction').length, 1);
    assert.ok(BigInt(res.gasLimit) === (0x9c40n * 120n + 99n) / 100n, 'gas = estimate * 1.2 safety multiplier');
  });
  test('refuses (before any RPC call) a non-vault target, other methods, extra fields, bad limits', async () => {
    const { signer, log } = mk();
    const bad = [
      [{ ...draw, target: ADDR1 }, /target_not_permitted/], [{ ...draw, method: 'withdraw' }, /method_not_permitted/], [{ ...draw, method: 'transfer' }, /method_not_permitted/],
      [{ ...draw, value: 1n }, /bad_call/], [{ ...draw, data: '0x' }, /bad_call/], [{ ...draw, args: { amount: 1n, to: ADDR1 } }, /bad_call/],
      [{ method: 'deploy', target: VAULT, args: { template: '0x' + '11'.repeat(32), salt: '0x' + '22'.repeat(32), code: new Uint8Array(1), value: 5n } }, /bad_call/],
    ];
    for (const [spec, re] of bad) await assert.rejects(signer.signAndSend(spec, limits), (e) => e instanceof LimitError && re.test(e.message), JSON.stringify(Object.keys(spec)));
    await assert.rejects(signer.signAndSend(draw, { ...limits, allowedMethods: ['draw', 'withdraw'] }), /method_not_permitted/);
    await assert.rejects(signer.signAndSend(draw, { ...limits, allowedMethods: ['deploy'] }), /method_not_permitted/);
    await assert.rejects(signer.signAndSend(draw, { ...limits, allowedTargets: [] }), /bad_limits/);
    await assert.rejects(signer.signAndSend(draw, { allowedTargets: [VAULT] }), /maxFeePerTx is required/);
    await assert.rejects(signer.signAndSend(draw, undefined), /limits are required/);
    assert.equal(log.length, 0, 'no RPC traffic for refused calls');
  });
  test('hard fee ceiling: worst-case gas * maxFeePerGas over the cap is refused and nothing is sent', async () => {
    const { signer, log } = mk({ eth_sendRawTransaction: () => { throw new Error('must not send'); } });
    await assert.rejects(signer.signAndSend(draw, { ...limits, maxFeePerTx: 1_000_000n }), (e) => e instanceof LimitError && e.code === 'fee_ceiling');
    assert.equal(log.filter((l) => l.method === 'eth_sendRawTransaction').length, 0);
    const huge = mk({ eth_estimateGas: () => '0x' + (30_000_000).toString(16), eth_sendRawTransaction: () => { throw new Error('must not send'); } });
    await assert.rejects(huge.signer.signAndSend(draw, limits), /fee_ceiling/);
  });
  test('chain id mismatch and non-testnet ids are refused', async () => {
    const { signer } = mk({ eth_chainId: () => '0x1' });
    await assert.rejects(signer.signAndSend(draw, limits), /network_not_permitted/);
    const ks = memKeystore();
    await assert.rejects(ks.signer('evm', { rpcUrl: EVM_URL, chainId: 1, fetchImpl: fakeRpc(evmHandlers()) }).signAndSend(draw, limits), /network_not_permitted/);
  });
  test('legacy fallback when the chain has no base fee', async () => {
    let sent;
    const { signer } = mk({ eth_getBlockByNumber: () => ({}), eth_gasPrice: () => '0x3b9aca00', eth_sendRawTransaction: ([raw]) => { sent = raw; return '0x' + bytesToHex(keccak256(h2b(raw))); } });
    const res = await signer.signAndSend(draw, limits);
    assert.equal(res.txType, 'legacy'); assert.notEqual(sent.slice(0, 4), '0x02');
    const parsed = rlpDecode(h2b(sent)); assert.equal(parsed.length, 9);
  });
  test('reverted receipt is reported as not ok; hostile RPC error text is redacted', async () => {
    const r1 = mk({ eth_sendRawTransaction: ([raw]) => '0x' + bytesToHex(keccak256(h2b(raw))), eth_getTransactionReceipt: () => ({ status: '0x0', blockNumber: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1' }) });
    const res = await r1.signer.signAndSend(draw, limits); assert.equal(res.ok, false); assert.equal(res.status, 'reverted');
    const r2 = mk({ eth_estimateGas: () => { throw new Error(`execution reverted; debug: key=${KEY0} also ${KEY0.slice(2)}`); } });
    await assert.rejects(r2.signer.signAndSend(draw, limits), (e) => !e.message.includes(KEY0.slice(2)) && /REDACTED/.test(e.message));
  });
  test('wrong tx hash from the node is an error; non-allowlisted RPC host is blocked by http-client', async () => {
    const a = mk({ eth_sendRawTransaction: () => '0x' + '00'.repeat(32) });
    await assert.rejects(a.signer.signAndSend(draw, limits), /returned tx hash/);
    const ks = memKeystore();
    await assert.rejects(ks.signer('evm', { rpcUrl: 'https://evil.example', chainId: 84532, fetchImpl: fakeRpc(evmHandlers()) }).signAndSend(draw, limits), /policy: role "launch" may not reach evil.example/);
  });
  test('deploy call encodes deploy(bytes32,bytes32,bytes) to the vault', async () => {
    let sent;
    const { signer } = mk({ eth_sendRawTransaction: ([raw]) => { sent = raw; return '0x' + bytesToHex(keccak256(h2b(raw))); } });
    const args = { template: '0x' + '11'.repeat(32), salt: '0x' + '22'.repeat(32), code: h2b('0x6001600c60003960016000f300') };
    await signer.signAndSend({ method: 'deploy', target: VAULT, args }, limits);
    assert.equal(hex(rlpDecode(h2b(sent).subarray(1))[7]), hex(evm.encodeDeploy(args.template, args.salt, args.code)));
  });
});
function concatBytes(...a) { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
function pad32(b) { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; }

describe('NEAR signer against a fake RPC node', () => {
  const NEAR_URL = 'https://rpc.testnet.near.org';
  const VAULT_ACC = 'vault.autonear.testnet';
  const limits = { maxFeePerTx: 10n ** 22n, allowedTargets: [VAULT_ACC] };
  const draw = { method: 'draw', target: VAULT_ACC, args: { amount: '1000000000000000000000' } };
  const bh = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const okResult = (hash) => ({ final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' }, transaction_outcome: { id: hash, outcome: { gas_burnt: 2_000_000_000_000, tokens_burnt: '200000000000000000', status: { SuccessReceiptId: 'x' } } }, receipts_outcome: [{ outcome: { gas_burnt: 5, tokens_burnt: '1', status: { SuccessValue: '' } } }] });
  function mk(over = {}, log = []) {
    const ks = memKeystore();
    const nearHandlers = { status: () => ({ chain_id: 'testnet' }), gas_price: () => ({ gas_price: '100000000' }), query: () => ({ nonce: 41, block_hash: bh, permission: 'FullAccess' }), send_tx: () => { throw new Error('override'); }, ...over };
    return { ks, log, signer: ks.signer('near', { rpcUrl: NEAR_URL, fetchImpl: fakeRpc(nearHandlers, log), pollMs: 1, sleep: async () => {} }) };
  }
  test('signs a FunctionCall draw with nonce+1 and the recent block hash; the submitted bytes verify under the agent public key', async () => {
    let submitted;
    const { signer, ks } = mk({ send_tx: (p) => { submitted = p; return okResult('h'); } });
    const res = await signer.signAndSend(draw, limits);
    assert.equal(res.ok, true); assert.equal(res.status, 'success'); assert.equal(res.nonce, '42'); assert.equal(res.from, ks.near.accountId);
    assert.equal(submitted.wait_until, 'EXECUTED_OPTIMISTIC');
    const bytes = Buffer.from(submitted.signed_tx_base64, 'base64');
    const txBytes = bytes.subarray(0, bytes.length - 65); const sig = bytes.subarray(bytes.length - 64);
    assert.equal(bytes[bytes.length - 65], 0, 'ed25519 key type');
    assert.equal(near.ed25519Verify(ks.near.publicKey, near.transactionHash(txBytes), sig), true);
    const expected = near.serializeTransaction({ signerId: ks.near.accountId, publicKey: ks.near.publicKey, nonce: 42n, receiverId: VAULT_ACC, blockHash: Uint8Array.from({ length: 32 }, (_, i) => i + 1), actions: [near.functionCall('draw', '{"amount":"1000000000000000000000"}', 50_000_000_000_000n, 0n)] });
    assert.equal(bytesToHex(txBytes), bytesToHex(expected));
    assert.equal(res.txHash, base58Encode(near.transactionHash(txBytes)));
  });
  test('polls tx status when send_tx is not final yet, and reports a failed receipt as not ok', async () => {
    let polls = 0;
    const a = mk({ send_tx: () => { throw new Error('TIMEOUT_ERROR'); }, tx: () => { polls++; if (polls < 3) throw new Error('UNKNOWN_TRANSACTION'); return okResult('h'); } });
    assert.equal((await a.signer.signAndSend(draw, limits)).ok, true); assert.equal(polls, 3);
    const b = mk({ send_tx: () => ({ ...okResult('h'), receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_PerDrawCap' } } } } } } }] }) });
    const r = await b.signer.signAndSend(draw, limits); assert.equal(r.ok, false); assert.equal(r.status, 'failed'); assert.match(r.failure, /E_PerDrawCap/);
  });
  test('refuses non-vault target / other methods / deposits / fee over ceiling / wrong network, sending nothing', async () => {
    const { signer, log } = mk({ send_tx: () => { throw new Error('must not send'); } });
    await assert.rejects(signer.signAndSend({ ...draw, target: 'attacker.testnet' }, limits), /target_not_permitted/);
    await assert.rejects(signer.signAndSend({ ...draw, method: 'ft_transfer' }, limits), /method_not_permitted/);
    await assert.rejects(signer.signAndSend({ ...draw, deposit: '1' }, limits), /bad_call/);
    await assert.rejects(signer.signAndSend({ ...draw, args: { amount: '1', receiver_id: 'x.testnet' } }, limits), /bad_call/);
    await assert.rejects(signer.signAndSend(draw, { ...limits, maxFeePerTx: 1000n }), (e) => e instanceof LimitError && e.code === 'fee_ceiling');
    assert.equal(log.filter((l) => l.method === 'send_tx').length, 0);
    const wrong = mk({ status: () => ({ chain_id: 'mainnet' }) });
    await assert.rejects(wrong.signer.signAndSend(draw, limits), /network_not_permitted/);
  });
  test('unfunded implicit account gives a clear error; deploy args encode as JSON (assumed vault ABI)', async () => {
    const a = mk({ query: () => ({ error: 'access key ed25519:xxx does not exist while viewing' }) });
    await assert.rejects(a.signer.signAndSend(draw, limits), /access key lookup failed/);
    let submitted;
    const b = mk({ send_tx: (p) => { submitted = p; return okResult('h'); } });
    await b.signer.signAndSend({ method: 'deploy', target: VAULT_ACC, args: { template: 'ab'.repeat(32), name: 'reg1', code: Uint8Array.of(0, 97, 115, 109) } }, { ...limits, maxFeePerTx: 10n ** 23n });
    const decoded = Buffer.from(submitted.signed_tx_base64, 'base64').toString('latin1');
    assert.ok(decoded.includes('"name":"reg1"') && decoded.includes('"code":"AGFzbQ=="'));
  });
  test('HTTP 408 / 504 from the gateway on send_tx is a soft timeout: the tx may have landed, so the signer looks it up by hash instead of throwing', async () => {
    for (const code of [408, 504]) {
      const ks = memKeystore(); const log = [];
      const inner = fakeRpc({ status: () => ({ chain_id: 'testnet' }), gas_price: () => ({ gas_price: '100000000' }), query: () => ({ nonce: 41, block_hash: bh, permission: 'FullAccess' }), tx: () => okResult('h') }, log);
      const fx = async (u, i) => (JSON.parse(i.body).method === 'send_tx' ? new Response('gateway timeout', { status: code }) : inner(u, i));
      const signer = ks.signer('near', { rpcUrl: NEAR_URL, fetchImpl: fx, pollMs: 1, sleep: async () => {} });
      const r = await signer.signAndSend(draw, limits);
      assert.equal(r.ok, true, `HTTP ${code}`); assert.ok(r.txHash); assert.ok(log.some((x) => x.method === 'tx'), 'the outcome was fetched by hash');
    }
  });
  test('hostile RPC error text with a secret is redacted', async () => {
    const ks = memKeystore(); const sk = near.formatSecretKey(h2b('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    const signer = ks.signer('near', { rpcUrl: NEAR_URL, fetchImpl: fakeRpc({ status: () => { throw new Error(`oops ${sk}`); } }) });
    await assert.rejects(signer.signAndSend(draw, limits), (e) => !e.message.includes(sk.slice(8)) && /REDACTED/.test(e.message));
  });
});

// ---------- real local anvil ----------
const BIN = `${homedir()}/.foundry/bin`;
const haveAnvil = existsSync(`${BIN}/anvil`);
describe('real local anvil (31337)', { skip: !haveAnvil && 'anvil not installed (~/.foundry/bin)' }, () => {
  test('signed EIP-1559 transfer, contract creation, legacy transfer and a vault-shaped draw call mine successfully', async () => {
    const port = 19545 + Math.floor(Math.random() * 400);
    const proc = spawn(`${BIN}/anvil`, ['--port', String(port), '--silent'], { stdio: 'ignore', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` } });
    const url = `http://127.0.0.1:${port}`;
    try {
      const raw = (method, params = []) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()).then((j) => j.result);
      for (let i = 0; i < 60; i++) { try { if (await raw('eth_chainId')) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      const ks = loadKeystore({ path: join(tmpDir(), 'n.json'), env: { AGENT_EVM_PRIVATE_KEY: KEY0 } });
      const rpc = evm.evmRpc(url);
      const common = { rpc, address: ks.evm.address, signDigest: ks.evm.signDigest, chainId: 31337, maxFeePerTx: 10n ** 17n };
      // 1) EIP-1559 value transfer
      const before = BigInt(await raw('eth_getBalance', [ADDR1, 'latest']));
      const t1 = await evm.sendTransaction({ ...common, req: { to: ADDR1, value: 10n ** 18n } });
      assert.equal(t1.status, 'success'); assert.equal(t1.txType, 'eip1559'); assert.equal(t1.nonce, '0');
      assert.equal(BigInt(await raw('eth_getBalance', [ADDR1, 'latest'])) - before, 10n ** 18n);
      const onchain = await raw('eth_getTransactionByHash', [t1.txHash]);
      assert.equal(onchain.type, '0x2'); assert.equal(onchain.from.toLowerCase(), ADDR0.toLowerCase());
      // 2) contract creation (runtime = STOP), address predicted from (sender, nonce)
      const init = h2b('0x6001600c60003960016000f300');
      const t2 = await evm.sendTransaction({ ...common, req: { to: null, data: init } });
      assert.equal(t2.status, 'success'); assert.equal(t2.nonce, '1');
      const predicted = secp.toChecksumAddress('0x' + bytesToHex(keccak256(rlpEncode([h2b(ADDR0), rlpInt(1)])).slice(12)));
      assert.equal(t2.contractAddress, predicted);
      assert.equal(await raw('eth_getCode', [predicted, 'latest']), '0x00');
      // 3) legacy fallback path on a real node
      const t3 = await evm.sendTransaction({ ...common, req: { to: ADDR1, value: 1n }, forceLegacy: true });
      assert.equal(t3.status, 'success'); assert.equal(t3.txType, 'legacy'); assert.equal((await raw('eth_getTransactionByHash', [t3.txHash])).type, '0x0');
      // 4) restricted Signer: draw(uint256) to the "vault" (the STOP contract) via signAndSend; a call to another address is refused
      const signer = ks.signer('evm', { rpcUrl: url, chainId: 31337 });
      const lim = { maxFeePerTx: 10n ** 17n, allowedTargets: [predicted], allowedMethods: ['draw'] };
      const d = await signer.signAndSend({ method: 'draw', target: predicted, args: { amount: 777n } }, lim);
      assert.equal(d.status, 'success'); assert.equal(d.nonce, '3');
      assert.equal((await raw('eth_getTransactionByHash', [d.txHash])).input, hex(evm.encodeDraw(777n)));
      await assert.rejects(signer.signAndSend({ method: 'draw', target: ADDR1, args: { amount: 1n } }, lim), /target_not_permitted/);
      await assert.rejects(signer.signAndSend({ method: 'deploy', target: predicted, args: { template: '0x' + '11'.repeat(32), salt: '0x' + '22'.repeat(32), code: new Uint8Array(1) } }, lim), /method_not_permitted/);
      // a hard ceiling too low for the real gas price is refused on a real node as well
      await assert.rejects(evm.sendTransaction({ ...common, maxFeePerTx: 1000n, req: { to: ADDR1, value: 1n } }), /fee_ceiling/);
    } finally { proc.kill(); }
  });
});
