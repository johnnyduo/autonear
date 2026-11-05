# ERC-8004 identity adapter (optional, EVM testnets only)

`src/identity/erc8004.js` is an OPTIONAL adapter for ERC-8004 "Trustless Agents". Nothing else in AutoNEAR depends on it.

## What ERC-8004 is

- An ERC in **Draft** status (created 2025-08-13, Standards Track: ERC). It can still change; do not treat it as final.
- Three per-chain singleton registries for agent **discovery and trust signals**:
  - **Identity Registry**: an ERC-721 (URIStorage). The token id is the `agentId`, the `tokenURI` is the `agentURI`, which resolves to an
    agent *registration file* (JSON) over `https://`, `ipfs://` or a base64 `data:` URI. Also on-chain key/value metadata and a reserved
    `agentWallet` key.
  - **Reputation Registry**: signed fixed-point feedback (`int128 value`, `uint8 valueDecimals`), tags, revoke, responses.
  - **Validation Registry**: validator requests/responses with a 0-100 score.

## What ERC-8004 is NOT

- **Not a wallet, not a spending or permission standard.** It cannot hold funds, cap spend, or authorise a transaction. The ERC says
  payments are "orthogonal ... and not covered". Spending limits in AutoNEAR come from the Mandate Vault (`docs/agent-vault-spec.md`),
  not from 8004.
- Not proof that an agent is trustworthy: a registration file is a self-description. Reputation/validation entries are only as good
  as who wrote them.
- `agentWallet` (an address the agent "receives payments" at) is metadata. It is not a signer allowlist or a budget.

## What this adapter does

| Function | Purpose |
| --- | --- |
| `buildRegistrationFile`, `validateRegistrationFile` | Registration file in the ERC's shape (`type`, `name`, `description`, `image`, `services[]`, `x402Support`, `active`, `registrations[]`, `supportedTrust`). Note: the current text uses `services`; earlier drafts called it `endpoints`. |
| `canonicalJson`, `registrationFileHash`, `toDataUri`, `fromDataUri` | Order-independent fingerprint (sha256 of canonical JSON; **our** convention, the ERC defines no on-chain hash of the file) and the `data:` URI form. |
| `encodeRegister`, `encodeRegisterEmpty`, `encodeRegisterWithMetadata`, `encodeSetAgentURI`, `encodeSetMetadata` | Calldata for the Identity Registry. `agentWallet` is rejected as a metadata key (the registry reserves it). `setAgentWallet` (needs an EIP-712/1271 signature) is intentionally not offered. |
| `encodeOwnerOf`, `encodeTokenURI`, `encodeGetMetadata`, `encodeGetAgentWallet` + `decode*` | View calls and hostile-RPC-safe decoders (bounds checked). `parseRegisteredLog` extracts the new `agentId` from a receipt. |
| `buildRegisterTx` | An **unsigned request** `{chainId, to, value, data}`. The module never signs and never sends. |
| `registryFor`, `TESTNET_REGISTRIES`, `agentRegistryId` | Per-testnet registry addresses (each with the README line it came from) and the `eip155:<chainId>:<address>` id. |
| `verifyRegistration` | Read-only (`eth_chainId`, `eth_getCode`, `eth_call`): registry has code on the expected chain, `ownerOf(agentId)` equals the expected EVM owner, `tokenURI` resolves to a schema-valid file that lists this exact `{agentId, agentRegistry}`, and its content/hash equals ours. Returns a list of named checks. |

Safety properties: testnets only (`registryFor` throws for the mainnet chain ids it knows and for any chain not in the verified table; a
custom registry address cannot bypass that); the registration file is fetched with https-only, private/loopback hosts refused, no
redirects followed, 256 KiB cap, optional host allowlist; `ipfs://` works only if you pass a gateway. DNS rebinding cannot be solved in
pure JS: in production fetch through an egress allowlist.

## Verified registry addresses (testnets only)

Read from the README of `erc-8004/erc-8004-contracts` at commit `b9e466c250744a7e06b13dff9d3c2844ed64f825` (2026-08-15, the head of `master`
on the access date). All listed testnets share one address pair (a deterministic-deployment vanity prefix `0x8004A818...` /
`0x8004B663...`). The README lists network names, not chain ids; the chain ids below are our mapping.

| Network (README heading) | chainId | IdentityRegistry | ReputationRegistry | README lines |
| --- | --- | --- | --- | --- |
| Ethereum Sepolia | 11155111 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 12-13 |
| Base Sepolia | 84532 | same | same | 20-21 |
| Arbitrum Testnet (Sepolia explorer) | 421614 | same | same | 36-37 |
| BSC Testnet | 97 | same | same | 52-53 |
| Monad Testnet | 10143 | same | same | 108-109 |
| Optimism Testnet | 11155420 | same | same | 116-117 |

Mainnet addresses exist in that README but are **deliberately not included or enabled**. "Present in the README" is not the same as
"verified on-chain by us": this module reads `eth_getCode` at verification time, but we have not called these contracts on a live RPC
(see "Unproven").

## Sources and access date (2026-11-05)

- ERC text: https://eips.ethereum.org/EIPS/eip-8004 (raw: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8004.md).
  Last commit touching that file: `503591a6e80e6e1affdd6403341e25269141f046` (2026-01-25, "Updates from community feedback"). The page shows no version field.
- Reference contracts: https://github.com/erc-8004/erc-8004-contracts, commit `b9e466c250744a7e06b13dff9d3c2844ed64f825`
  (2026-08-15). `ERC8004SPEC.md` in that commit is byte-identical to the ERCs file above. `IdentityRegistryUpgradeable.sol`
  (last changed in `44c0025f`, 2026-01-23) reports `getVersion() == "2.0.0"` and implements `register()`, `register(string)`,
  `register(string, MetadataEntry[])`, `setAgentURI`, `getMetadata`, `setMetadata`, `getAgentWallet` (returns `address`),
  `setAgentWallet`, `unsetAgentWallet`; events `Registered`, `URIUpdated`, `MetadataSet`.
- Encoding cross-check: `viem@2.57.16` from `web/node_modules` (test-only; skipped visibly if absent).

## Unproven

- Nothing here has been run against a live RPC or a live registry; tests use a mocked RPC and compare encodings with viem.
- The "MUST vs SHOULD" split in `validateRegistrationFile` is our reading of the ERC text (hard errors for `type`, `name`, `description`,
  `services`, `registrations` shape, boolean flags; warnings for missing `image`, `version`, empty `registrations`, non-example trust tags).
- The blocked-mainnet chain-id list is best effort; the real guard is that only the six listed testnets resolve to a registry.
- Draft status: function names and the file shape (`endpoints` -> `services`) already changed between drafts and may change again.
