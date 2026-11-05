#!/usr/bin/env node
/**
 * Deterministic build + BUILD_MANIFEST for the EVM ProposalRegistry (contracts/evm).
 *
 * Runs `forge build`, then writes contracts/evm/dist/ProposalRegistry.json
 *   { abi, bytecode, deployedBytecode, constructorArgs }
 * and prints one JSON manifest line on stdout:
 *   { protocol:'evm', contract, solc, evmVersion, bytecodeSha256, deployedBytecodeSha256, bytes,
 *     foundryLockSha256, pinnedLibs, sourceSha256 }
 *
 * - bytecodeSha256 / deployedBytecodeSha256: sha256 of the raw bytes (hex-decoded, no 0x), not of the hex text.
 * - bytes: length of the deployed (runtime) bytecode, the EIP-170 relevant size.
 * - sourceSha256: sha256 over, in sorted relative-path order, "<path>\0<content>\0" for foundry.toml,
 *   remappings.txt (if present) and every file under src/. Paths are relative to contracts/evm and use "/".
 * - The build FAILS if the runtime code contains immutable references: the backend verifies a deploy by comparing
 *   eth_getCode to deployedBytecode, which only holds when there are none.
 *
 * Usage: node scripts/evm-build.mjs [--no-build]
 */
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVM = join(ROOT, "contracts", "evm");
const CONTRACT = "ProposalRegistry";
const ARTIFACT = join(EVM, "out", `${CONTRACT}.sol`, `${CONTRACT}.json`);
const DIST = join(EVM, "dist");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hexBytes = (hex) => Buffer.from(hex.replace(/^0x/, ""), "hex");
const fail = (msg) => {
  console.error(`evm-build: ${msg}`);
  process.exit(1);
};

function forgeBin() {
  const home = process.env.HOME ?? "";
  const candidate = join(home, ".foundry", "bin", "forge");
  return existsSync(candidate) ? candidate : "forge";
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function sourceSha256() {
  const files = [join(EVM, "foundry.toml"), ...(existsSync(join(EVM, "remappings.txt")) ? [join(EVM, "remappings.txt")] : []), ...walk(join(EVM, "src"))]
    .map((p) => relative(EVM, p).split("\\").join("/"))
    .sort();
  const h = createHash("sha256");
  for (const rel of files) {
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

if (!process.argv.includes("--no-build")) {
  try {
    execFileSync(forgeBin(), ["build"], {cwd: EVM, stdio: ["ignore", process.stderr, process.stderr]});
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
    },
    null,
    2,
  ) + "\n",
);

const {foundryLockSha256, pinnedLibs: libs} = pinnedLibs();
const manifest = {
  protocol: "evm",
  contract: CONTRACT,
  solc,
  evmVersion,
  bytecodeSha256: sha256(hexBytes(bytecode)),
  deployedBytecodeSha256: sha256(hexBytes(deployed)),
  bytes: hexBytes(deployed).length,
  foundryLockSha256,
  pinnedLibs: libs,
  sourceSha256: sourceSha256(),
};
console.log(JSON.stringify(manifest));
