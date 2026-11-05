## Findings

- **High — Vault code verification can fail open** — [src/autonomy.js:118](/Library/WebServer/Documents/autonear/src/autonomy.js:118), [src/vault/index.js:176](/Library/WebServer/Documents/autonear/src/vault/index.js:176). If the code-check RPC fails while the state read succeeds, `codeChecked` is false and the loop continues toward signing. A vault whose code cannot be attested can therefore remain active. Require a successful code check and `codeOk` on every acting tick; treat either failure as a refusal.

- **Medium — An approved grant is reusable after a mandate reset** — [src/vault/index.js:117](/Library/WebServer/Documents/autonear/src/vault/index.js:117), [src/vault/index.js:351](/Library/WebServer/Documents/autonear/src/vault/index.js:351). Activation records the mandate epoch, but later verification compares only mandate fields and templates. If the owner calls `setMandate` again with identical fields, on-chain usage resets while the backend still accepts the old grant. The agent can spend another full cap under that one approval. Persist the activated epoch and require it to match on every tick; require a new approved grant for a replacement mandate.

- **Medium — A failed NEAR draw remains charged** — [contracts/near-vault/src/lib.rs:518](/Library/WebServer/Documents/autonear/contracts/near-vault/src/lib.rs:518). `draw` increments usage before creating an asynchronous transfer and has no failure callback. If the bound agent is a named account that has since been deleted, the transfer can fail and return funds to the vault, but the mandate budget stays consumed. Add a private transfer callback that reverses the charge on failure, with the same epoch and period safeguards used for deploys.

- **Low — EVM preview misses an occupied address with empty runtime code** — [contracts/evm/src/AgentVault.sol:392](/Library/WebServer/Documents/autonear/contracts/evm/src/AgentVault.sol:392). An allowlisted initcode can successfully create an account with empty runtime code. A second `deploy` with the same salt passes `previewDeploy` because `code.length == 0`, then `CREATE2` fails because the account already has a nonce. Track used `(templateId, salt)` pairs, or reject empty-runtime templates, so preview and execution agree.

## Checked and found OK

- EVM owner and agent roles, budget checks, effects before value transfers, and reentrancy guards.
- EVM template IDs bind the full initcode, including constructor arguments.
- NEAR deployment batches omit `AddKey`; stored owner-approved init arguments are used, and failed deployment callbacks reverse optimistic charges.
- The backend recomputes template IDs, checks NEAR stored init material, restricts signer calls to vault `draw` and `deploy`, caps fees, and verifies deployment receipts before recording them.
- Vault mutation routes require the operator token; public vault reads expose public state rather than key material.