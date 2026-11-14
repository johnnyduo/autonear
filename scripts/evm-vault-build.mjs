#!/usr/bin/env node
/**
 * Deterministic build + BUILD_MANIFEST for the EVM AgentVault (Mandate Vault v1, contracts/evm).
 *
 * Runs `forge build`, then writes
 *   contracts/evm/dist/AgentVault.json      { contract, abi, bytecode, deployedBytecode, constructorArgs, manifest }
 *   contracts/evm/dist/AgentVault.abi.json  { contract, abi, selectors, errors, events, previewCodes }
 * and prints one JSON manifest line on stdout:
 *   { protocol:'evm', contract, solc, evmVersion, bytecodeSha256, deployedBytecodeSha256, abiSha256, bytes,
 *     foundryLockSha256, pinnedLibs, sourceSha256 }
 *
 * Same conventions as scripts/evm-build.mjs (the registry's builder, which this does NOT modify):
 * - bytecodeSha256 / deployedBytecodeSha256: sha256 of the raw bytes (hex-decoded, no 0x), not of the hex text.
 * - bytes: length of the deployed (runtime) bytecode, the EIP-170 relevant size.
 * - sourceSha256: sha256 over, in sorted relative-path order, "<path>\0<content>\0" for foundry.toml and the two vault
 *   sources (src/AgentVault.sol, src/IAgentVault.sol). Scoped to the vault on purpose, so registry edits do not move it.
 * - The build FAILS if the runtime code contains immutable references (the backend verifies a deployment by
 *   comparing eth_getCode to deployedBytecode).
 * - dist/AgentVault.abi.json is the ABI the backend uses. `previewCodes` maps the 4-byte error selector returned by
 *   previewDraw / previewDeploy (0x00000000 = ok) to the spec error code name. It is generated, never hand-copied.
 *
 * Usage: node scripts/evm-vault-build.mjs [--no-build]
 */
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVM = join(ROOT, "contracts", "evm");
const CONTRACT = "AgentVault";
const SOURCES = ["foundry.toml", "src/AgentVault.sol", "src/IAgentVault.sol"];
const ARTIFACT = join(EVM, "out", `${CONTRACT}.sol`, `${CONTRACT}.json`);
const DIST = join(EVM, "dist");

// The 17 spec error codes (the Mandate Vault spec), in spec order. Only these are previewable.
const SPEC_ERRORS = [
  "Unauthorized", "Paused", "NoMandate", "MandateInactive", "BadMandate", "BadAmount", "PerDrawCap", "PeriodCap",
  "TotalCap", "InsufficientBalance", "DeployLimit", "TemplateNotAllowed", "CodeMismatch", "AddressTaken", "BadName",
  "BadTemplate", "BadOwner",
];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hexBytes = (hex) => Buffer.from(hex.replace(/^0x/, ""), "hex");
const fail = (msg) => {
  console.error(`evm-vault-build: ${msg}`);
  process.exit(1);
};

function foundryBin(name) {
  const candidate = join(process.env.HOME ?? "", ".foundry", "bin", name);
  return existsSync(candidate) ? candidate : name;
}

function sourceSha256() {
  const h = createHash("sha256");
  for (const rel of [...SOURCES].sort()) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(EVM, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

function pinnedLibs() {
  const lockPath = join(EVM, "foundry.lock");
  if (!existsSync(lockPath)) return {foundryLockSha256: null, pinnedLibs: {}};
  const raw = readFileSync(lockPath);
  const lock = JSON.parse(raw.toString("utf8"));
  const libs = {};
  for (const [name, info] of Object.entries(lock)) libs[name] = info.tag ? `${info.tag.name}@${info.tag.rev}` : info.rev ?? null;
  return {foundryLockSha256: sha256(raw), pinnedLibs: libs};
}

// Canonical type string for an ABI param (expands tuples).
const typeOf = (p) => (p.type.startsWith("tuple") ? `(${p.components.map(typeOf).join(",")})${p.type.slice(5)}` : p.type);
const sig = (e) => `${e.name}(${e.inputs.map(typeOf).join(",")})`;
const keccak = (s) => {
  try {
    return execFileSync(foundryBin("cast"), ["keccak", s], {encoding: "utf8"}).trim();
  } catch {
    return fail("`cast keccak` unavailable; install Foundry (selectors are generated, never hand-written)");
  }
};

if (!process.argv.includes("--no-build")) {
  try {
    execFileSync(foundryBin("forge"), ["build"], {cwd: EVM, stdio: ["ignore", process.stderr, process.stderr]});
  } catch {
    fail("forge build failed");
  }
}
if (!existsSync(ARTIFACT)) fail(`missing artifact ${ARTIFACT}; run forge build`);

const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const bytecode = art.bytecode?.object;
const deployed = art.deployedBytecode?.object;
if (!bytecode || !deployed) fail("artifact has no bytecode");
if (/__\$[0-9a-fA-F]{34}\$__/.test(bytecode)) fail("unlinked library placeholders in bytecode");
const immutables = art.deployedBytecode?.immutableReferences ?? {};
if (Object.keys(immutables).length > 0) fail("deployedBytecode has immutable references; breaks getCode == deployedBytecode verification");

const constructor = art.abi.find((e) => e.type === "constructor");
const meta = typeof art.rawMetadata === "string" ? JSON.parse(art.rawMetadata) : art.metadata ?? {};
const solc = (meta.compiler?.version ?? "").split("+")[0] || null;
const evmVersion = meta.settings?.evmVersion ?? null;

// Every spec error code must exist in the ABI (the shared conformance file and the JS model rely on the names).
const abiErrors = new Set(art.abi.filter((e) => e.type === "error").map((e) => e.name));
for (const name of SPEC_ERRORS) if (!abiErrors.has(name)) fail(`ABI is missing spec error ${name}`);

const abiSha256 = sha256(JSON.stringify(art.abi));
const {foundryLockSha256, pinnedLibs: libs} = pinnedLibs();
const manifest = {
  protocol: "evm",
  contract: CONTRACT,
  solc,
  evmVersion,
  bytecodeSha256: sha256(hexBytes(bytecode)),
  deployedBytecodeSha256: sha256(hexBytes(deployed)),
  abiSha256,
  bytes: hexBytes(deployed).length,
  foundryLockSha256,
  pinnedLibs: libs,
  sourceSha256: sourceSha256(),
};

mkdirSync(DIST, {recursive: true});
writeFileSync(
  join(DIST, `${CONTRACT}.json`),
  JSON.stringify(
    {
      contract: CONTRACT,
      abi: art.abi,
      bytecode,
      deployedBytecode: deployed,
      constructorArgs: constructor ? constructor.inputs : [],
      manifest,
    },
    null,
    2,
  ) + "\n",
);

const selectors = {};
for (const [s, sel] of Object.entries(art.methodIdentifiers ?? {})) selectors[s] = `0x${sel}`;
const errors = {};
const events = {};
const previewCodes = {"0x00000000": ""};
for (const e of art.abi) {
  if (e.type === "error") {
    const selector = keccak(sig(e)).slice(0, 10);
    errors[sig(e)] = selector;
    if (SPEC_ERRORS.includes(e.name)) previewCodes[selector] = e.name;
  }
  if (e.type === "event") events[sig(e)] = keccak(sig(e));
}
writeFileSync(join(DIST, `${CONTRACT}.abi.json`), JSON.stringify({contract: CONTRACT, abi: art.abi, selectors, errors, events, previewCodes}, null, 2) + "\n");

console.log(JSON.stringify(manifest));
