# AutoNEAR backend audit

Read-only review of the requested backend files. No network commands or tests were run.

| Severity | ID | File:line | Defect | Concrete scenario | Specific fix |
|---|---|---|---|---|---|
| **High** | H-1 | `src/decisions.js:65`, `src/chains/near.js:9` | NEAR verification never checks the transaction receiver against the approved decision target. | A successful deployment of the attested WASM to a different account, with matching configuration, can be recorded for the approved decision. | Pass `d.target` to the verifier and require `receiver_id === d.target`. |
| **High** | H-2 | `src/decisions.js:68`, `src/chains/evm.js:14` | The EVM deployer check is optional and takes its expected value from the receipt request, rather than the approved payload. | An operator can submit any successful deployment of the matching runtime code and omit `deployer`; it is recorded without checking who deployed it. | Bind the expected signer or deployer to the decision at approval and require it during verification. |
| **High** | H-3 | `src/decisions.js:73` | `INSERT OR IGNORE` hides a duplicate transaction hash, but the code still marks the new decision executed and reports success. | Reusing a hash already recorded for another decision makes the second decision appear executed without its own deployment row. | Use a conditional insert that reports conflicts; update the decision only if that insert succeeded, atomically where supported. |
| **Medium** | M-1 | `src/decisions.js:43` | Rejection updates by ID without rechecking status. | A concurrent approval or deployment can complete after the status read, then rejection overwrites the decision as `rejected`. | Put allowed prior statuses in the `UPDATE` predicate and check `changes`; coordinate deployment and rejection transitions. |
| **Medium** | M-2 | `src/decisions.js:73`, `src/db.js:130` | Deployment insertion and decision status update are separate, non-atomic D1 writes. | If the Worker stops between them, a deployment exists while its decision remains approved; a retry then encounters the ignored insert and can report a misleading result. | Model recording as an idempotent state transition with conflict checks and recovery for partial writes. |
| **Medium** | M-3 | `src/orchestrator/agents.js:159` | Skeptic LLM `extraGaps` and `challenges` lack a schema or string-length limits before being stored in artifacts and the brief. | A malformed or oversized model response can add arbitrary fields or long text to persisted outputs; citation checking covers IDs only. | Validate the complete LLM response with bounded schemas before copying fields. |
| **Medium** | M-4 | `src/scoring.js:35` | “Independent authors” are counted by `source_id:author`, without tying identities across sources or excluding blank authors. | One actor posting under several names or source accounts can raise demand and confidence; blank authors also count once per source. | Treat this as an unverified breadth signal, exclude empty identities, and cap or corroborate actor contribution. |
| **Low** | L-1 | `src/http-client.js:25` | The response limit is checked after `res.text()` has buffered the entire body. | An allowed host can return a very large response and consume memory before the 4 MB check runs. | Stream the body and abort once the byte limit is reached. |
| **Low** | L-2 | `src/app.js:27`, `src/app.js:34` | The in-memory rate limiter clears every bucket when it exceeds 5,000 entries. | Requests with many distinct forwarded IP values can repeatedly reset all limits. | Use bounded eviction or a trusted, shared rate limiter; trust forwarded IP headers only from a configured proxy. |
| **Low** | L-3 | `src/app.js:107` | Backslashes are left in the `LIKE` search term, while `%` and `_` are removed. | Search behavior can differ from the user’s literal query; the code does not implement a clear literal-search escaping rule. | Escape `%`, `_`, and the escape character, and use an explicit SQL `ESCAPE` clause. |

## Checks that held up

- Mutation routes in `src/app.js` require the operator token; the cron route requires its secret or that token. Token comparison uses `timingSafeEqual`.
- SQL values reviewed are bound as parameters; the dynamic evidence query builds its SQL from fixed clauses.
- `guardedFetch` checks the parsed hostname and protocol and sets `redirect: 'error'`. The code provides no direct user-controlled RPC URL in the HTTP receipt route.
- Approval uses a conditional `pending` update, and the schema has unique decision nonces and transaction hashes.
- Audit and run-event chains have unique predecessor constraints to prevent concurrent forks.

## Limits

This was static review of the requested scope. I did not execute tests, query chains or RPC providers, inspect a deployed D1 database, or verify frontend rendering. The report does not establish whether any listed scenario has occurred.
