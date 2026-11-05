// Cross-language check: the Solidity-produced golden vectors must be reproduced by an independent viem implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(new URL('../web/package.json', import.meta.url));
let viem = null; try { viem = require('viem'); } catch { /* web deps not installed */ }
const EVM = new URL('../contracts/evm/test-vectors.json', import.meta.url);
const NEAR = new URL('../contracts/near-registry/test-vectors.json', import.meta.url);

test('EVM vectors: keccak(abi.encode(...)) in viem == Solidity computeId', { skip: !viem && 'viem not installed (npm --prefix web ci)' }, () => {
  const v = JSON.parse(readFileSync(EVM, 'utf8'));
  const { keccak256, encodeAbiParameters, toHex, stringToBytes } = viem;
  assert.equal(keccak256(toHex(stringToBytes(v.typeString))), v.typehash, 'typehash');
  for (const x of v.vectors) {
    const pre = encodeAbiParameters(
      ['bytes32', 'uint256', 'address', 'address', 'bytes4', 'uint256', 'uint64', 'uint64', 'bytes32'].map((type) => ({ type })),
      [v.typehash, BigInt(x.chainId), x.registry, x.target, x.selector, BigInt(x.maxSpend), BigInt(x.expiry), BigInt(x.nonce), x.artifactHash]);
    assert.equal(pre, x.preimage, `${x.name}: preimage`);
    assert.equal(keccak256(pre), x.id, `${x.name}: id`);
  }
});

test('NEAR vectors file is present and well-formed (id == sha256(preimage), recomputed independently in Node)', { skip: !existsSync(NEAR) }, () => {
  const v = JSON.parse(readFileSync(NEAR, 'utf8'));
  const list = v.vectors ?? v;
  assert.ok(Array.isArray(list) && list.length >= 3);
  for (const x of list) {
    assert.match(x.id, /^(0x)?[0-9a-f]{64}$/i);
    assert.equal(createHash('sha256').update(Buffer.from(x.preimage_hex.replace(/^0x/, ''), 'hex')).digest('hex'), x.id.replace(/^0x/, ''), `${x.name}: sha256(preimage) == id`);
  }
});
