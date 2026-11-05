## Findings

| Severity | ID | File:line | Defect and concrete scenario | Specific fix |
|---|---|---|---|---|
| High | N-01 | [near.js](/Library/WebServer/Documents/autonear/src/chains/near.js:7) | The verifier accepts a transaction containing `DeployContract` plus other actions. A bound signer can deploy the attested WASM and add a full access key in the same transaction; the code hash and `config()` checks still pass. | Require an explicitly approved action sequence. Reject `AddKey` and other unapproved actions, and verify the account’s access keys against an approved key policy. |
| High | N-02 | [near.js](/Library/WebServer/Documents/autonear/src/chains/near.js:10) | Success is inferred from top-level `status.SuccessValue`; `receipts_outcome` failures are not checked. A transaction with a successful top-level outcome but a failed downstream receipt can be recorded as successful. | Require finality and inspect every transaction and receipt outcome for `Failure`. |
| Medium | N-03 | [near.js](/Library/WebServer/Documents/autonear/src/chains/near.js:16) | The verifier checks current code and contract configuration, but never checks retained full access keys. A deployment to an account with an existing unapproved key passes. | Query access keys at finality and compare them with an approved key set or enforce an account custody policy. |
| Medium | B-01 | [attest.js](/Library/WebServer/Documents/autonear/src/attest.js:16) | The API accepts a build attestation with `tests.failed > 0` or without successful lint/fuzz results. An operator posting such an attestation can later have its artifact treated as deployable. | Reject failed test runs and enforce required build evidence before recording a contract artifact. |
| Medium | B-02 | [monitor.js](/Library/WebServer/Documents/autonear/src/monitor.js:31) | Each tick checks only the five newest verified deployments. Once more than five exist, older deployments receive no further monitoring. | Rotate through all verified deployments with a persistent cursor or bounded batches. |
| Low | C-01 | [ProposalRegistry.sol](/Library/WebServer/Documents/autonear/contracts/evm/src/ProposalRegistry.sol:205), [lib.rs](/Library/WebServer/Documents/autonear/contracts/near-registry/src/lib.rs:350) | Changing the proposer removes the former proposer’s ability to cancel its own Pending proposals, although the spec grants cancellation to a proposer of its own Pending proposal. The owner can still cancel them. | Decide whether cancellation belongs to the recorded proposer; if so, remove the current-proposer check on this path. |
| Low | B-03 | [near.js](/Library/WebServer/Documents/autonear/src/chains/near.js:20) | NEAR `config()` verification checks owner, proposer and pause state but not `network_id`. An otherwise matching deployment with the wrong configured network is accepted. | Compare `cfg.network_id` with the approved decision’s network identifier. |

## Checked and fine

- EVM proposal IDs use fixed-width `abi.encode` fields with the type hash, chain ID and registry address; no preimage boundary ambiguity was found. NEAR IDs length-prefix every field.
- Both contracts use `now > expiry` for derived expiration and mutation rejection, matching the spec’s boundary.
- Pause, allowlist re-check at approval, two-step ownership, bounded pagination, and on-chain nonce progression were checked. No ordinary ETH receipt path or external contract call appears in the EVM registry; no promise or callback path appears in the NEAR registry.
- The EVM `config()` decoder’s seven-word layout matches the Solidity `Config` field order. The verifier requires a creation receipt, so a factory or CREATE2 deployment without `receipt.contractAddress` does not pass this path.
- The decision path binds signer and NEAR receiver to the approved decision, atomically claims an approved decision, and relies on a unique transaction-hash column to prevent recording one receipt for two decisions.

## Limits

This was source review only. I ran no tests, builds, network requests or chain queries, and did not verify deployed bytecode, RPC behavior, or the security of operator credentials and external signing workflows.