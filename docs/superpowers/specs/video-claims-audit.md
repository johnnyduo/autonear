# Video claims audit (Codex + Claude), 2026-11-05

Method: Codex (`codex exec -s read-only`) fact-checked the narration, the on-screen strings and the capture script against `src/`, `contracts/`, `tests/`; Claude verified each finding, fixed it, and re-ran. Four rounds.

| Round | Finding | Resolution |
|---|---|---|
| 1 repo audit | Real e2e = evidence -> scoring -> pending **testnet deployment decision** -> approval gates -> record only after chain receipt verification. Registry deployment on a public chain is **not** demonstrated; treasury quotes are synthetic fixtures when no live quote. | Story and every scene tag follow this. No "moves funds / mainnet / autonomous" claims. |
| 2 script | "requests by people", "never holds funds", "never let it spend", "bound to one account", "independent sources" overstated. | Rewritten: "posts by authors", "don't move funds", "agents propose, humans approve", "names the signer", "demand sources". `verify.mjs` bans words like audited / guarantee / mainnet / never-move. |
| 3 on-screen | Verifier mock was stale vs the current `src/chains/near.js`; contract counts were typed by hand (82/144); close card showed `npm install && npm test`; "tamper-evident", "24h", "3 suites" wording. | Mock uses the exact RPC shapes; capture hard-fails if the demo stops working; counts are measured (`scripts/contracts.mjs`: NEAR 84, EVM 144; Node 33); wording fixed. |
| 4 re-check | All fixed. One nit: "decision stays approved" read as the final state. | Now "this attempt: nothing recorded, still approved". |

Known limits that the video states or must not hide:
- The approval gate and receipt verification are shown on **fixture inputs with a mocked NEAR RPC**; no public testnet transaction exists yet (only the user's funded wallet can create one).
- The injection filter is heuristic; the audit log is hash-linked but not externally anchored; no independent audit has occurred.
- Narration used a macOS placeholder voice until `GEMINI_API_KEY` is provided.

Open items - resolved 2026-11-05:
1. README track now leads with AI Security & Defense (also Autonomous Business, AI Swarms); matches video, post and end card.
2. README test count already corrected by the app session (33).
3. Anvil key comments now say PUBLIC / NEVER FUND (`contracts/evm/script/e2e-anvil.sh`, `scripts/e2e-local.mjs`).
4. Repo list reviewed before first commit (`data/*.db`, `data/operator.token`, `video/out`, `video/.env` ignored).

Still open: real Gemini voice (needs `GEMINI_API_KEY`), the repo must be made PUBLIC before the X post, and a real public testnet deployment signed by the owner would replace the mocked-RPC scene.
