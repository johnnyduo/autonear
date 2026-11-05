#!/usr/bin/env node
/**
 * Export the ProposalRegistry ABI from Foundry output to contracts/evm/dist/abi.json.
 * Generated, never hand-copied: a hand-copied ABI drifts silently. Run after `forge build` (or evm-build.mjs).
 *
 * Output: { contract, abi, selectors: {"propose(address,bytes4,uint256,uint64,uint64,bytes32)":"0x..."},
 *           errors: {"NotOwner(address)":"0x..."}, events: {"Proposed(...)":"0x<topic0>"} }
 *
 * Usage: node scripts/evm-export-abi.mjs
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVM = join(ROOT, "contracts", "evm");
const CONTRACT = "ProposalRegistry";
const ARTIFACT = join(EVM, "out", `${CONTRACT}.sol`, `${CONTRACT}.json`);

if (!existsSync(ARTIFACT)) {
  console.error(`${ARTIFACT} not found. Run \`forge build\` in contracts/evm first.`);
  process.exit(1);
}
const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
if (!Array.isArray(art.abi) || art.abi.length === 0) {
  console.error(`${CONTRACT} has no ABI entries.`);
  process.exit(1);
}

// Canonical type string for an ABI param (expands tuples).
const typeOf = (p) => (p.type.startsWith("tuple") ? `(${p.components.map(typeOf).join(",")})${p.type.slice(5)}` : p.type);
const sig = (e) => `${e.name}(${e.inputs.map(typeOf).join(",")})`;

// Selectors/topics come from forge's own output where available (methodIdentifiers); events and errors are
// hashed with keccak256, which Node's crypto lacks natively, so ask cast if present, else omit them.
import {execFileSync} from "node:child_process";
const cast = existsSync(join(process.env.HOME ?? "", ".foundry", "bin", "cast")) ? join(process.env.HOME, ".foundry", "bin", "cast") : "cast";
const keccak = (s) => {
  try {
    return execFileSync(cast, ["keccak", s], {encoding: "utf8"}).trim();
  } catch {
    return null;
  }
};

const selectors = {};
for (const [s, sel] of Object.entries(art.methodIdentifiers ?? {})) selectors[s] = `0x${sel}`;
const errors = {};
const events = {};
for (const e of art.abi) {
  if (e.type === "error") errors[sig(e)] = keccak(sig(e))?.slice(0, 10) ?? null;
  if (e.type === "event") events[sig(e)] = keccak(sig(e));
}

mkdirSync(join(EVM, "dist"), {recursive: true});
const out = join(EVM, "dist", "abi.json");
const body = {contract: CONTRACT, abi: art.abi, selectors, errors, events};
writeFileSync(out, JSON.stringify(body, null, 2) + "\n");
console.log(JSON.stringify({file: out, abiEntries: art.abi.length, sha256: createHash("sha256").update(JSON.stringify(art.abi)).digest("hex")}));
