# Proposal Registry v1: EVM (Solidity / Foundry)

EVM implementation of the cross-protocol state machine in [`docs/contracts-spec.md`](../../docs/contracts-spec.md).
An **attestation registry** for scoped, human-authorized actions: it binds an off-chain proposal (target, method,
max spend, expiry, nonce, artifact hash) to an owner-approved on-chain record. It **never holds funds and never
calls the target**; execution happens out of band and is then *recorded* with `markExecuted`.

> **Status: not verified on any public network.** Everything below was exercised in `forge test` and against a
> **local anvil** node only (`script/e2e-anvil.sh`, labelled LOCAL ANVIL). Nothing has been deployed to a public
> testnet or mainnet, and the contract has had no external audit.

## Layout

| Path | What |
| --- | --- |
| `src/IProposalRegistry.sol` | Types, events, custom errors, external API |
| `src/ProposalRegistry.sol` | Implementation (no immutables, no external calls, no ETH) |
| `test/unit` | Named negative-case matrix from the spec, events, ETH/no-call/runtime-code, deploy script, golden vectors |
| `test/fuzz`, `test/invariant` | Property tests; invariant suite with a bounded-random-walk `Handler` |
| `script/Deploy.s.sol` | Deploy (env `OWNER`, `PROPOSER`, `MAX_SPEND_CAP`; mainnet guard) |
| `script/EmitVectors.s.sol` | Writes `test-vectors.json` from the Solidity code |
| `script/e2e-anvil.sh` | Self-contained local-anvil lifecycle rehearsal with `cast` |
| `test-vectors.json` | Golden id vectors for the TypeScript backend |
| `../../scripts/evm-build.mjs`, `evm-export-abi.mjs` | Build manifest + `dist/ProposalRegistry.json`, `dist/abi.json` |

## Roles and API

`owner` (a multisig on any real network): `approve`, `markExecuted`, `cancel` (Pending or Approved), `pause`/`unpause`,
`addAllowed`/`removeAllowed`, `setProposer`, `setMaxSpendCap`, two-step `transferOwnership`/`acceptOwnership`; may also `propose`.
`proposer` (the AutoNEAR agent): `propose`, and `cancel` **its own Pending** proposals only. Nothing else.
Views: `computeId`, `getProposal`, `statusOf` (includes derived `Expired`; `None` if unknown), `list(offset, limit<=100)`,
`proposalCount`, `isAllowed`, `config`. `status` in storage is one of Pending, Approved, Executed, Cancelled; **Expired is
derived** (`block.timestamp > expiry` while Pending/Approved) and makes `approve`, `markExecuted` and `cancel` revert
`ProposalExpired`.

Selector mapping from the spec: `mark_executed` -> `markExecuted`, `max_spend` -> `maxSpend`, `receipt_ref` -> `bytes receiptRef`
(1..256 bytes), `network_id` -> `block.chainid` (reported by `config().networkId`), method -> `bytes4 selector`.

Chosen behaviours where the spec allows a choice:
* `approve` **re-checks the allowlist**; `markExecuted` does not (approval is an explicit owner decision, execution is out of band;
  the owner can `cancel` an Approved proposal instead). Removal after creation leaves the proposal Pending.
* The spend cap is enforced at `propose` only; lowering it later does not retroactively invalidate existing proposals.
* A proposer rotated out by `setProposer` immediately loses `propose` and `cancel` rights, including over its older proposals.
* Replay of an identical proposal reverts `ProposalAlreadyExists` (checked before the nonce, so the error is the clear one);
  a wrong nonce with otherwise new fields reverts `BadNonce(expected, given)`. A reverted `propose` consumes no nonce.
* Default cap: constructor arg `0` selects `DEFAULT_MAX_SPEND_CAP = 1_000_000 * 1e18` (the unit is whatever base unit the
  off-chain policy uses; the contract does not interpret it). `MAX_TTL = 30 days`.

## Proposal id: exact encoding

```
PROPOSAL_TYPE     = "Proposal(uint256 chainId,address registry,address target,bytes4 selector,uint256 maxSpend,uint64 expiry,uint64 nonce,bytes32 artifactHash)"
PROPOSAL_TYPEHASH = keccak256(PROPOSAL_TYPE) = 0xe5b41e3f3457738507c24f4f72fb96e58f230245bc7f03efcaa3ac8b37403ea7
id = keccak256(abi.encode(PROPOSAL_TYPEHASH, block.chainid, address(this), target, selector, maxSpend, expiry, nonce, artifactHash))
```

`abi.encode` of nine static words = **288 bytes**, each field one 32-byte word, in this order:

| # | field | ABI type | word layout |
|---|---|---|---|
| 0 | typehash | bytes32 | as is |
| 1 | chainId | uint256 | big-endian, left-padded |
| 2 | registry | address | 20 bytes left-padded with 12 zero bytes (the registry's own address) |
| 3 | target | address | same |
| 4 | selector | **bytes4** | **4 bytes first, then 28 zero bytes (RIGHT-padded)** |
| 5 | maxSpend | uint256 | big-endian |
| 6 | expiry | uint64 | big-endian, left-padded |
| 7 | nonce | uint64 | big-endian, left-padded |
| 8 | artifactHash | bytes32 | as is |

It is the EIP-712 `hashStruct` with `chainId` and `registry` *inside* the struct (no `\x19\x01` domain-separator wrapper; the id is
not a signature digest). The id is computed on-chain; callers never supply it. Any altered field yields a different id, so an
approval for one id never applies to another. viem: `keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,address,bytes4,uint256,uint64,uint64,bytes32'), [...]))`
or `hashStruct`-equivalent. The `Proposed` event carries the id as `topics[1]`.

**Golden vectors:** `test-vectors.json` (6 vectors: baseline, same fields on another chain id, large spend, zero/min values, max values,
selector padding). Produced by `forge script script/EmitVectors.s.sol` by placing the real runtime code at each vector's registry address
(`vm.etch`) and chain id (`vm.chainId`) and calling `computeId`. Each vector holds `chainId, registry, target, selector, maxSpend, expiry,
nonce, artifactHash, preimage, id` (uint256-sized values are decimal strings to survive JSON). `test/unit/Vectors.t.sol` re-derives every
vector from the current code, so the file cannot drift. I also cross-checked all six with `cast keccak <preimage>`.

## Security properties

* **No ETH**: no payable function, no `receive`, no `fallback`. A plain transfer reverts (tested, incl. value on every mutator, and in the invariant suite).
  Honest caveat: ETH can still be *force-sent* (selfdestruct beneficiary, coinbase, pre-funded address). It is then un-withdrawable by
  construction (no function reads or moves balance) and does not affect behaviour; this is tested (`test_Eth_ForcedSelfdestructEthIsStrandedAndHarmless`).
  The "no ETH balance" invariant therefore holds for everything callable, not against forced sends.
* **No external calls**: no low-level call/delegatecall/staticcall, no value transfer, no token or target interaction, hence no reentrancy surface and
  no callbacks. Enforced by a source scan (`test_NoExternalCalls_SourceContainsNoCallPrimitives`) and a hostile-owner test.
* **No immutables, no proxy, no selfdestruct, no assembly**: `eth_getCode(registry)` equals the artifact `deployedBytecode` byte for byte
  (`test_NoImmutables_RuntimeCodeEqualsArtifactDeployedBytecode`, and `script/e2e-anvil.sh` asserts it on a live node). `bytecode_hash = "none"`,
  `cbor_metadata = false` so no metadata hash makes the bytecode path-dependent.
* Two-step ownership; zero and self transfers rejected; `acceptOwnership` is closed to `address(0)` when nothing is pending.
* `pause` never traps state: `cancel` and all views work while paused; admin setters also stay available.
* Block timestamp is used for expiry (seconds granularity; validator skew is irrelevant at a 30-day TTL scale).

## Build, test, run

```bash
export PATH="$HOME/.foundry/bin:$PATH"           # forge 1.7.1 used here
cd contracts/evm
forge build --sizes                                # solc 0.8.28, cancun, via_ir, optimizer_runs=200
forge test                                         # unit + fuzz + invariant (default profile: 1000 fuzz runs, 512x64 invariant)
forge fmt --check
FOUNDRY_PROFILE=lite forge test                    # quick loop
FOUNDRY_PROFILE=deep forge test                    # 50k fuzz runs, 4096x256 invariant (slow; invariants take minutes)
forge coverage --report summary --ir-minimum       # --ir-minimum is required with via_ir; line numbers are approximate
bash script/e2e-anvil.sh                           # starts and stops its own anvil on a free port
node ../../scripts/evm-build.mjs                   # forge build + dist/ProposalRegistry.json + BUILD_MANIFEST JSON on stdout
node ../../scripts/evm-export-abi.mjs              # dist/abi.json (abi, selectors, error selectors, event topics)
forge script script/EmitVectors.s.sol              # regenerate test-vectors.json
```

Deterministic build: toolchain pinned in `foundry.toml` (`solc_version = "0.8.28"`, `evm_version = "cancun"`, optimizer on, runs 200, via_ir,
no metadata). The manifest (`evm-build.mjs`) reports `bytecodeSha256`, `deployedBytecodeSha256`, `bytes`, `foundryLockSha256`, pinned libs and
`sourceSha256`; the deployed hash was identical before and after `forge clean`.

**Dependencies** are vendored without git submodules into `lib/` (the only one is forge-std, used by tests/scripts; the contract itself imports
nothing external and needs no OpenZeppelin). Pinned in `foundry.lock`: `lib/forge-std` = `v1.16.2` @ `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`
(identical `src/` to the copy in `cats.fund/contracts/lib`). Installed with `forge install --no-git foundry-rs/forge-std@v1.16.2`; forge warns
"Failed to get git revision for dependency" because `lib/` is not a git checkout; that warning is expected and harmless.

## Deploy

`script/Deploy.s.sol` reads `OWNER`, `PROPOSER`, optional `MAX_SPEND_CAP` from env and calls `vm.startBroadcast()` with **no key**: the signer is
whatever the forge CLI is given (`--account <keystore>`, `--ledger`, `--private-key` for local use). It never reads a key from a file. It refuses a
list of known mainnet chain ids (Ethereum, OP, BNB, Gnosis, Polygon, Fantom, zkSync, Polygon zkEVM, Mantle, Base, Mode, Arbitrum One/Nova, Celo,
Avalanche, Linea, Blast, Scroll, Zora, Aurora) unless `I_UNDERSTAND_MAINNET=yes`. The list is a guard rail, not exhaustive; an unlisted mainnet
would deploy without the flag.

```bash
OWNER=<multisig> PROPOSER=<agent addr> MAX_SPEND_CAP=<base units> \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --account <keystore-name> --broadcast
```

Then the owner `addAllowed(target, selector)` for each permitted pair. Backend verification: compare `eth_getCode(address)` to
`dist/ProposalRegistry.json` `deployedBytecode` (or its `deployedBytecodeSha256`).

## Gas and storage

Measured on a LOCAL anvil node (`e2e-anvil.sh` receipts, cold storage, cancun): deploy 1,484,432; `addAllowed` 48,846; `propose` 174,639 (first)
/ 177,451 (later); `approve` 58,134 (first) / 41,034 (later); `markExecuted` 132,040 (45-byte receipt ref) ; `cancel` 35,734; `pause` 27,678;
`transferOwnership` 48,013; `acceptOwnership` 28,282. Runtime size **6,259 B** (24,576 B EIP-170 limit; initcode 6,659 B).
`test/unit/GasProfile.t.sol` logs in-EVM numbers and asserts upper bounds as a regression guard.

Storage (`forge inspect ProposalRegistry storageLayout`): slot 0 = owner(20) + paused(1) + nextNonce(8); 1 pendingOwner; 2 proposer; 3 maxSpendCap;
4 `_records` mapping; 5 `_allowed` mapping; 6 `_ids` array. A proposal `Record` takes 6 packed fixed slots plus the dynamic `receiptRef`:
`[proposer|status|createdAt]`, `[target|selector|expiry]`, `[nonce|approvedAt|executedAt]`, `maxSpend`, `spent`, `artifactHash`
(the id is the mapping key and is not stored; `getProposal` fills it in). Each `propose` also appends one `bytes32` to `_ids`
(needed for `list`). Lifecycle updates touch only the packed status slot and (on execution) `spent` + `receiptRef`. The receipt bytes are
stored (up to 256 B), so a long ref costs ~22k gas per 32 bytes; keep refs short (a tx hash is 32 B) or a hash/CID.

## Upgrade strategy

**Immutable by default; no proxy, no admin upgrade path, no selfdestruct.** Reasoning: the registry is the audit trail and the approval authority
for human-authorized actions; an upgradeable proxy would let whoever holds the upgrade key silently rewrite the meaning of past approvals, which
defeats the point. It also keeps `eth_getCode` verification exact. Migration for a v2: deploy a new registry (new address, hence new id space,
since the registry address is in the id preimage); `pause()` the old one so it accepts no new work while `cancel` stays open for stragglers;
the backend then points at the new address. Old executed records remain readable forever. A v2 may add (in the new contract) things such as
per-asset caps, batched approvals, an EIP-712 signature path (`approveWithSig`) for multisig-less owners, or Safe-module integration. Changing
the owner/proposer/allowlist/cap needs no redeploy; changing logic does.

## Limitations (honest list)

* **Not deployed or verified on any public testnet or mainnet.** Evidence is `forge test` (144 tests incl. fuzz and invariant), `forge coverage`, and a
  local anvil rehearsal. A public-testnet run would additionally prove real gas prices, RPC behaviour and a real multisig owner.
* No external audit. Invariant/fuzz testing is bounded random testing, not formal verification (the `deep` profile was run once: fuzz 17 tests x 50,000 runs passed in ~7 s; invariants 7 x 4096 runs x depth 256 passed in ~365 s).
* The registry **attests, it does not enforce**: nothing on-chain stops the owner from executing something different from what was approved; `spent <= maxSpend`
  is a claim recorded by the owner, not verified against any transfer. Enforcement lives in the owner multisig's process and the off-chain `artifactHash` check.
* Single owner key semantics: the owner must be a multisig to get any real separation; a compromised owner can approve anything allowlisted (but not
  anything outside the allowlist for new proposals, and cannot move funds because the contract has none).
* `proposer` is one address; the nonce is a single global counter, so concurrent proposers (e.g. owner + agent) must serialise nonce use; a lost race reverts `BadNonce`.
* Forced ETH via selfdestruct/coinbase is possible and stranded (see above).
* `maxSpend`/`spent` are unitless `uint256`s; the registry does not know which asset they refer to.
* The mainnet guard list is static.
