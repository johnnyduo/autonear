# Mandate Vault v1: EVM (Solidity / Foundry)

EVM implementation of the cross-protocol state machine in [`docs/agent-vault-spec.md`](../../docs/agent-vault-spec.md), checked against
the shared [`contracts/vault-conformance.json`](../vault-conformance.json) (also used by the NEAR contract and the JS model).

A vault that holds **testnet gas money** for ONE autonomous agent and lets it do exactly two things inside an owner-set budget:

1. `draw(amount)`: pull ETH to **its own pre-bound address only**.
2. `deploy(templateId, salt, code)`: CREATE2 an **owner-allowlisted template** (exact initcode, constructor args fixed by the owner) from the vault.

The agent can never change config, widen its budget, send funds anywhere else, deploy unlisted code, pick init arguments (so it cannot
choose who owns a deployed registry), upgrade, or withdraw. The owner can always revoke, pause, withdraw (to the owner only) and replace
the mandate. Owner funds are never trapped.

> **Status: not verified on any public network. TESTNET ONLY; there is no mainnet path.** Everything below was exercised in `forge test`
> and against a **local anvil** node (chain 31337, `script/e2e-vault-anvil.sh`, which is NOT a public testnet). No external audit, no
> static-analysis tool run (see "Not proven").

## Layout

| Path | What |
| --- | --- |
| `src/IAgentVault.sol` | Types, events, custom errors (spec error codes, exact names), external API |
| `src/AgentVault.sol` | Implementation (no immutables, no delegatecall, no selfdestruct, no upgrade path) |
| `test/vault/*.t.sol`, `Handler.sol`, `Props.sol`, `Mocks.sol`, `VaultBase.sol` | Conformance harness, unit, reentrancy, events, source scans, fuzz, invariants |
| `script/DeployVault.s.sol` | Deploy (env `OWNER`); dry run unless the human passes `--broadcast`; refuses known mainnet chain ids |
| `script/e2e-vault-anvil.sh` | Self-contained local-anvil rehearsal with `cast` (starts/stops its own anvil) |
| `../../scripts/evm-vault-build.mjs` | `forge build` + `dist/AgentVault.json` (+ manifest) + `dist/AgentVault.abi.json` |
| `foundry.toml` | Only change: a read-only `fs_permissions` entry for `../vault-conformance.json` |

## Behavior

Spec names are snake_case; the Solidity functions are camelCase (`set_mandate` = `setMandate`, `preview_draw` = `previewDraw`, ...).

**Roles.** `owner` (two-step transfer; a multisig on any real network): everything privileged. `agent` (bound in the active mandate): only
`draw` and `deploy`. Anyone: plain ETH transfer to the vault (`receive()` emits `Deposited`); gifts only, they change no budget.

**Mandate** (at most one): `agent, expiresAt, perDrawCap, periodSecs, periodCap, totalCap, maxDeploys, revoked, start`. `setMandate` replaces
any mandate (even revoked/expired), bumps `epoch`, resets usage, sets `start = block.timestamp`, and is allowed while paused. Bounds (else
`BadMandate`): agent non-zero; `now < expiresAt <= now + 30 days`; `0 < perDrawCap <= periodCap <= totalCap`; `60 <= periodSecs <= 30 days`;
`maxDeploys <= 1000` (0 = draw-only).

**Time** is `block.timestamp` seconds. `periodIndex = floor((now - start) / periodSecs)`; the boundary second belongs to the new period.
`active(now)` = mandate exists, not revoked, `now < expiresAt` (expiry is exclusive).

**Agent op order** (first failing rule wins; one shared check function per op also backs the previews):
`NoMandate` (no mandate exists, for any caller) -> `Unauthorized` (caller != `mandate.agent`) -> `Paused` -> `MandateInactive` -> then
- `draw`: `BadAmount` (0) -> `PerDrawCap` -> `PeriodCap` -> `TotalCap` -> `InsufficientBalance`. Effects (counters, event) before the value send, which goes to `mandate.agent` only, via `call`, `nonReentrant`.
- `deploy`: `TemplateNotAllowed` -> `CodeMismatch` (`keccak256(code) != templateId`) -> `DeployLimit` -> `AddressTaken` (the CREATE2 address already has code). Then counter, then `CREATE2(value 0, salt, code)` from the vault.

**Templates.** `templateId = keccak256(initcode)`, and the initcode *includes the constructor arguments*, so the owner fixes them at allowlist
time. `allowTemplate(bytes32 id, string label, uint256 deposit)`: `deposit` must be 0 (`BadTemplate`; EVM forwards no value), label <= 64 bytes
(`BadTemplate`), re-allowing an existing id only updates the label. `templateIdOf(bytes)` and `predictAddress(id, salt)` are provided so
off-chain code never re-implements the hashing. Because the id *is* the initcode hash, the CREATE2 address is `keccak256(0xff ++ vault ++ salt ++ id)[12:]`,
known before deploying and reproduced by the previews.

**Deploys spend nothing on EVM**, so the spec's "spend rules using `template.deposit`" are vacuous for them (`deposit == 0` is enforced at
allowlist time) and are not executed in `deploy`; deploys are bounded by `maxDeploys` instead. (Draws and deploys still share one mandate and one `usage` record.)

**Owner ops** (caller must be owner else `Unauthorized`): `setMandate`, `revoke` (idempotent; `NoMandate` if none ever set), `pause`/`unpause`
(idempotent; block agent ops only), `allowTemplate`/`disallowTemplate` (`TemplateNotAllowed` if unknown), `withdraw(amount)` (to the owner only;
`BadAmount` for 0, `InsufficientBalance` above the balance; works while paused/revoked/expired), `transferOwnership(new)` (`BadOwner` for zero or
self) and `acceptOwnership()` (pending owner only, else `Unauthorized`; nothing pending is `Unauthorized` for everyone).

**Views.** `config()` (`owner, pendingOwner, paused, networkId = block.chainid, epoch`), `mandate()`, `usage()` (raw counters), `template(id)`,
`templates(from, limit)` (paged, clamped), `templateCount()`, `available()` (= `address(this).balance`), `periodState(ts)` (effective
`index, spent, startsAt, endsAt`; zeros when there is no mandate or `ts < start`), `previewDraw(amount)`, `previewDeploy(id, salt)`,
`predictAddress`, `templateIdOf`. Previews assume the caller is the bound agent at the current time and never mutate. `previewDeploy` assumes the
code matches the template (the code is not an argument), so it never returns `CodeMismatch`.

**Events** (every mutation): `Deposited`, `MandateSet`, `MandateRevoked`, `VaultPaused`, `VaultUnpaused` (not `Paused`, which is the error name),
`TemplateAllowed`, `TemplateDisallowed`, `Drawn`, `Deployed`, `Withdrawn`, `OwnershipTransferStarted`, `OwnershipTransferred`. ETH that arrives
without `receive()` (selfdestruct beneficiary, coinbase reward) is not logged but is counted by `available()` and is withdrawable.

## Error codes and the preview representation

Errors are custom errors named exactly like the spec codes. **`previewDraw` / `previewDeploy` return `bytes4`: the 4-byte selector of the
custom error the real call would revert with, and `0x00000000` for "ok".** The real call reverts with the very same 4 bytes, because both
paths run the same check function and the revert is the raw selector (identical to `revert X()`), so `preview == revert data` by construction
(and a test asserts it for every conformance step made by the agent). JS side: `dist/AgentVault.abi.json` has `previewCodes`, a generated map
`selector -> spec error name` (`"0x00000000": ""` = ok, matching the spec's "empty = ok"):

| Code | Selector | | Code | Selector |
| --- | --- | --- | --- | --- |
| `Unauthorized` | `0x82b42900` | | `DeployLimit` | `0x0a68f4fd` |
| `Paused` | `0x9e87fac8` | | `TemplateNotAllowed` | `0xfb16ac4c` |
| `NoMandate` | `0x8814cafb` | | `CodeMismatch` | `0x179708c0` |
| `MandateInactive` | `0xb25d2e88` | | `AddressTaken` | `0xf649c1a5` |
| `BadMandate` | `0x3e916108` | | `BadName` (NEAR only; never raised here) | `0x153736cd` |
| `BadAmount` | `0x749b5939` | | `BadTemplate` | `0x2d22289e` |
| `PerDrawCap` | `0xc4b0aa3c` | | `BadOwner` | `0x73cb018f` |
| `PeriodCap` | `0xf203bf60` | | `InsufficientBalance` | `0xf4d678b8` |
| `TotalCap` | `0x18f65848` | | | |

EVM-only extras, **not spec codes** (the JS model and NEAR never emit them; the backend should map them to a generic failure):
`TransferFailed()` (the agent's or owner's `receive` rejected the value send; whole tx reverts, nothing is spent), `Reentrancy()` (guarded
function re-entered), `DeployFailed()` (CREATE2 returned 0: constructor reverted/out of gas, or the address has a nonce but no code).
`BadName` exists in the interface for cross-chain parity only.

## Threat model

Trust: the **owner** is fully trusted (it can set any mandate for any agent, allowlist any code, withdraw everything). The **agent key** is
assumed hostile/compromised: the design goal is that a stolen agent key loses at most the mandate's remaining `totalCap` (to the agent's own address)
plus up to `maxDeploys` deployments of owner-approved code.

| Threat | Mitigation | Evidence |
| --- | --- | --- |
| Agent redirects funds | `draw` pays `mandate.agent` only; `withdraw` pays `owner` only; no function takes a recipient | `test_agent_drawPaysOnlyAgent_*`, `testFuzz_agent_cannotRedirect`, source scan `test_source_sendTargets`, mutation check (below) |
| Agent widens its budget / changes config | every owner op `Unauthorized` for agent, strangers, pending owner, old owner, the vault itself | `VaultAccessTest` |
| Agent deploys unlisted or altered code / picks the owner of a deployed registry | `keccak256(code) == templateId` against the owner's allowlist; constructor args are inside the hash | `test_agent_cannotDeployRegistryWithItselfAsOwner`, e2e |
| Re-entrancy through the agent's or owner's `receive`, or a template constructor | transient-storage lock on `draw`/`deploy`/`withdraw`; effects before interaction | `VaultReentrancyTest` (malicious agent, owner contract, malicious constructor) |
| Budget overrun via arithmetic edge cases (huge caps, period rollover) | all cap checks use subtraction forms (`amount > cap - spent`), usage never exceeds a cap by invariant; uint256 caps of `2^256-1` tested | `test_setMandate_hugeCaps*`, invariants |
| Stale approval after a bad key event | `revoke`, `pause`, 30-day maximum mandate lifetime, `setMandate` resets usage | conformance, e2e |
| Funds trapped | `withdraw` works in every state; checked by the invariant suite after every random action | `invariant_ownerCanAlwaysWithdrawAvailable` |
| Upgrade / backdoor | no proxy, no delegatecall, no selfdestruct, no arbitrary call, no immutables; runtime code equals the build artifact | `VaultSourceTest`, e2e `getCode` equality |
| Front-running a CREATE2 address | the address depends on the vault, the owner-fixed initcode hash and the agent's salt; nobody else can deploy there | by construction; not separately tested beyond `AddressTaken` |

Accepted / known limits:
- A compromised agent can still drain its remaining `totalCap` (that is the point of a mandate) and deploy up to `maxDeploys` instances of allowlisted code, each owned by the owner-fixed addresses.
- If the **owner** is a contract whose `receive` reverts, `withdraw` fails with `TransferFailed` (change the owner with `transferOwnership` first; that never sends ETH).
- A template whose constructor returns *empty* runtime code leaves an address with a nonce but no code; a second deploy there would fail as `DeployFailed`, not `AddressTaken`. Allowlist only templates that deploy code.
- A hostile **template** is owner-approved code: the vault guarantees only that exactly those bytes are deployed, not that they are safe.
- `agent == owner` (or the agent is a contract that is also the owner) is permitted by the spec; the lock still prevents `withdraw` -> `draw` re-entry.
- Block timestamp skew (seconds) is irrelevant at the 60 s minimum period / 30 day scale.

## Upgrade strategy

**There is none, by design.** To change the vault: deploy a new `AgentVault`, owner `withdraw`s the old one to the owner (works in every state), funds the new vault, sets a
new mandate and re-allowlists templates. The backend re-attaches by verifying `eth_getCode(address) == dist/AgentVault.json deployedBytecode` and `config()`. Anything the old
vault deployed stays deployed and owned by the owner-fixed addresses; it needs nothing from the vault afterwards.

## Gas notes

Measured (not estimated) on a local anvil, `script/e2e-vault-anvil.sh`: vault deployment 1,548,438 gas (runtime 6,790 bytes, EIP-170 limit 24,576); `setMandate`
~150k first time (cold slots) and ~52k when replacing an existing mandate; `allowTemplate` ~117k (label + index storage); `draw` ~92k for the first draw of an epoch
and ~58-61k afterwards (includes the value send to an EOA); `revoke` ~32k; `pause` ~28k; `withdraw` ~32k; plain deposit ~22k. A `deploy` of the real ProposalRegistry
cost ~1.53M gas, almost all of which is the registry's own CREATE2 (the vault's bookkeeping is small); in `forge test --gas-report` a successful `deploy` of a 10-byte fixture peaks at ~94k (the 23k lower bound is a revert path). The reentrancy lock uses transient
storage (`tload`/`tstore`, cancun), so it adds no persistent-storage writes; I did not measure its exact overhead.

## Build, test, run

```bash
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"   # forge 1.7.1 used here
cd contracts/evm
forge build
forge test --match-path 'test/vault/*'                      # vault suites only (the plain `forge test` also runs them)
FOUNDRY_PROFILE=deep forge test --match-path 'test/vault/*' # 50k fuzz runs, 4096x256 invariants (~4.5 min here)
forge fmt --check
forge coverage --ir-minimum --match-path 'test/vault/*' --report summary   # --ir-minimum is required (via_ir); see numbers below
bash script/e2e-vault-anvil.sh                               # local anvil; prints PASS/FAIL counts
node ../../scripts/evm-vault-build.mjs                       # dist/AgentVault.json + dist/AgentVault.abi.json + manifest line
```

Deploy (human-run; nothing is sent without `--broadcast`; signing only via forge CLI flags, never from a file):

```bash
OWNER=<multisig> forge script script/DeployVault.s.sol --rpc-url "$RPC" --sender <addr>                       # dry run
OWNER=<multisig> forge script script/DeployVault.s.sol --rpc-url "$RPC" --account <keystore> --broadcast      # real
```

## What was run (this build)

| Check | Result |
| --- | --- |
| `forge test` (whole project) | 240 tests pass (96 vault + 144 pre-existing registry tests) |
| Vault suites | Conformance 2 (11 scenarios / 115 steps run, 2 NEAR-only scenarios skipped), Access 15, Behavior 35, Reentrancy 9, Events 10, Source 5, RegistryViaVault 2, DeployScript 3, Fuzz 7, Invariant 8 |
| Deep profile (`FOUNDRY_PROFILE=deep`, vault suites) | all pass: fuzz 50,000 runs each; 8 invariants x 4,096 runs x 256 depth (1,048,576 handler calls each) |
| `forge fmt --check` | clean |
| `forge coverage --ir-minimum` on `src/AgentVault.sol` | lines 96.34% (158/164), statements 97.12% (202/208), **branches 100% (39/39)**, functions 100% (34/34) |
| `script/e2e-vault-anvil.sh` | PASS=97 FAIL=0 on local anvil (chain 31337) |
| Mutation spot checks (manual, 10 attempted) | 1 did not compile; of the 9 valid mutants all were caught by the non-conformance suites and 7 also by the conformance harness. The 2 conformance misses: removing the reentrancy lock on `draw` (not observable in the conformance model) and `draw` paying `msg.sender` instead of `mandate.agent` (equivalent at runtime since only the agent can pass the gate; caught by the source-scan test) |

Coverage honesty: the 6 uncovered lines (80, 84, 88, 270, 418, 419) are all **inline-assembly statements** (`tload`/`tstore` in the lock, `create2`, the raw
`revert(selector)`), which forge's coverage does not attribute; they are executed by the tests (reentrancy blocked, CREATE2 deploys landing on `predictAddress`, every revert selector asserted). With
`--ir-minimum` source mappings are approximate. The test files also trigger forge-lint `unsafe-typecast` warnings (none in `src/`).

## Not proven / not done

- **No static analysis**: `slither` is not installed here and was not run; no Mythril/Echidna/Certora either. Nothing is claimed beyond the tests above.
- **No external audit**, no formal verification. Mutation testing was manual (9 valid mutants), not a systematic tool run.
- Never deployed on a public testnet; the anvil rehearsal says nothing about real gas prices, RPC behaviour, reorgs or a multisig owner. Mainnet is explicitly out of scope.
- The invariant walk's reachability was only measured for a deterministic sequence (52 successful draws, 5 deploys, 23 withdrawals, 16 mandates in 900 actions); I did not instrument per-run reachability inside the Foundry invariant runner.
- Template deposit rules are vacuous on EVM by design; NEAR-specific behaviors (`BadName`, async `on_deployed` rollback) are not exercised here, and the 2 NEAR-only conformance scenarios were skipped as specified.
- The JS model, backend and NEAR contract were not touched or run by this work.
- `dist/AgentVault.json` is only as fresh as the last `node scripts/evm-vault-build.mjs`; the registry builder `scripts/evm-build.mjs` hashes all of `src/`, so its `sourceSha256` changes because the vault sources now live there (its bytecode is unaffected: `dist/ProposalRegistry.json` still equals the fresh build output).
