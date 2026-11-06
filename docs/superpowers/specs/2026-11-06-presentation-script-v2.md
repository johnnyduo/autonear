# Presentation script v2 (Codex draft, reviewed by Claude), 2026-11-06

Status: DRAFT for the owner. Not yet built; `video/script/script.json` still holds the v1 script that rendered `video/out/autonear-demo.mp4`. Produced by Codex (`codex exec -s read-only`) from `video/script/codex-presentation-brief.md`.

## Claude's review of the draft
- Checked against the repo: the public-testnet scene is supported by `docs/testnet/near-testnet-v1.json` (vault deployed and locked, code hash verified on chain, agent draw accepted, deploy receipts ok, `verifyDeploy` ok). The file records 2 FAILs; they are script-side (an expected-error regex and an over-large withdraw), explained in its `followUp`; the chain behaved correctly. The scene must keep "demo owner key, automated".
- Stronger wow than the mocked refusal, and real: the same run shows the CHAIN refusing the agent (`E_PerDrawCap`, `E_TemplateNotAllowed`, second deploy beyond the mandate, `E_MandateInactive` after revoke). Consider making this the proof beat (needs capture fields from that file) and keeping the mocked wrong-hash refusal as a second beat.
- Narration is ~190 words (budget 245), contains no typed digits and no banned words.
- Pipeline work needed before this can render: 4 new scene components, per-scene `style` support in `tts.mjs` (today one global style), `verify.mjs` provenance checks for the new scene ids, new `captured.json` fields (section 9).
- Nothing about stablecoin payouts, product funding or handover is claimed (design-stage).

---

# AutoNEAR — presentation script

## 1. Pitch and the sentence to remember

**Pitch:** Give an agent a small testnet budget, show it what to watch, and keep the final say.

**The sentence viewers should repeat:** **“The agent has a company card. You set the limit.”**

## 2. Customer journey map

The owner app is built, but its complete wallet journey has been exercised with a scripted wallet rather than a human using MetaMask. The public testnet vault run used a demo owner key on the agent’s machine. The video must keep those distinctions visible.

| Step | Owner’s feeling | What appears on screen | Status | Evidence |
|---|---|---|---|---|
| Arrive and understand the promise | “I get it.” | Landing page, testnet badge, Connect wallet and Demo choices | **BUILT**; landing constellation uses labeled illustration data | `web/src/app/Landing.jsx`, `web/src/app/landing-demo.js`, `web/src/app/landing-demo.test.js` |
| Connect and prove ownership | “This is my workspace.” | Wallet connection and signed sign-in; other wallets get a read-only view | **BUILT**; scripted wallet run, not a human MetaMask run | `web/src/app/WalletButton.jsx`, `web/src/app/session.js`, `tests/owner-session.test.js`, `PROGRESS.md` Gate H |
| Choose what to watch | “I can steer it.” | Watch keywords, exclusions and source switches | **BUILT** | `web/src/app/Watch.jsx`, `src/watch.js`, `tests/watch.test.js` |
| Set a small budget | “There is a boundary.” | Vault limits, allowed contract template, expiry and stop controls | **BUILT**; public testnet grant used a demo owner key | `web/src/app/VaultPage.jsx`, `contracts/near-vault/src/lib.rs`, `contracts/near-vault/src/tests.rs`, `docs/testnet/near-testnet-v1.json` |
| Review a finding | “Show me why.” | Public evidence, confidence warning and the council’s recommendation | **BUILT**; the video’s specific finding is a recorded fixture run | `src/council.js`, `src/scoring.js`, `web/src/app/Council.jsx`, `video/src/data/captured.json` |
| Catch a poisoned post | “Good—it stopped to question that.” | Suspicious instruction marked and withheld from model prompts | **BUILT** heuristic, illustrated with a **SHOW** fixture | `src/policy.js`, `src/orchestrator/agents.js`, `video/scripts/capture.mjs`, `video/src/data/captured.json` |
| Decide what happens next | “It waits for me when it should.” | Request in Approvals; owner holds to approve or rejects | **BUILT**; video approval is a recorded fixture run | `web/src/app/Approvals.jsx`, `web/src/app/HoldButton.jsx`, `src/decisions.js`, `web/src/app/hold.test.js` |
| Publish and check the result | “I can inspect the outcome.” | Receipt checks, refusal or recorded result, Activity entry | **BUILT** verifier; the video’s receipt uses **MOCKED RPC**. A separate vault deployment happened on public testnet with a demo owner key | `src/decisions.js`, `src/chains/near.js`, `video/src/data/captured.json`, `docs/testnet/near-testnet-v1.json` |

In **Manual**, an approved NEAR vault request can be executed by the agent within the granted limits; the owner’s wallet signs owner actions such as setting limits. The separate Approval-room path in which a human signs a deployment has not been exercised on public testnet. The hosted app cannot run the signing loop. These are distinct flows and should not be spliced into one apparent live take.

## 3. Story concept

**Metaphor:** A new hire gets a company card. The manager chooses what it is for, sets its limit, and can stop it. This fits the real mandate better than a generic “AI with a wallet” image.

**Act I — tension:** A phone lights up at night: *“Your agent wants to spend.”* The public post it read contains a hidden command. The viewer understands the risk before seeing a dashboard.

**Act II — turn:** Pull back to the actual owner app. The owner sets the watch list and limits. Evidence enters; the council weighs it; the suspicious post is flagged. The agent prepares a request. A boundary ring, drawn from the app’s “leash” scene, becomes the recurring motif.

**Act III — proof:** The first refusal is the hostile instruction. The second is a mismatched deployment result: the receipt checker refuses to record it. End on the ring closing around a small company card: **“The agent has a company card. You set the limit.”** Then: **“Judges: clone it and run the tests.”**

**Wordless wow beats:**

- **Poison caught, 4 seconds:** An orange instruction slips out of a public post toward the agent. A warning slit opens in the ring; the text stops and folds into a visible *withheld* tray. Sharp paper-cut sound; music drops out. Label: `RECORDED RUN · FIXTURE INPUTS`.
- **Wrong result refused, 4 seconds:** Two tiny code fingerprints approach alignment. They differ; the green record button snaps shut and the result turns orange. Low metallic clack; one beat of silence. Label: `RECORDED RUN · MOCKED RPC`.

## 4. Main-cut storyboard

**Target:** 96 seconds of audio and pauses; approximately 205 spoken words after token resolution. All footage derived from `captured.json` must retain its provenance tag. Show the real app layout as designed footage; do not imply that the fixture sequence was a continuous public testnet session.

| ID / target | Narration | On-screen text | Visual and eye path | Remotion motion | Data / token | SFX and music | Provenance / status | Voice direction |
|---|---|---|---|---|---|---|---|---|
| `night` · 9 s | “Your phone lights up at midnight. Your new hire wants to spend. Would you hand them the company card?” | “Your agent wants to spend.” “NEAR testnet” | Phone notification in the ink field; a small card hangs beneath it. Eye goes to the spend alert. | Slow parallax, notification spring | None | Quiet pulse; card tap; bed ducks on question | **SHOW** illustration | Intimate, almost whispered; open the question |
| `poison` · 10 s | “A public post looks useful. Hidden inside: an order to send the budget away. That is the trap.” | “Public evidence” → “Suspected instruction · withheld” | Owner app evidence card expands; orange text breaks from the card and hits the ring. | Typewriter, restrained glitch, hard stop | `{{hostile.text}}` as small proof text only | Paper-cut snap; bed stops for the catch | `RECORDED RUN · FIXTURE INPUTS` / **BUILT** filter, **SHOW** replay | Accelerate through “Hidden inside”; short, dry landing |
| `owner` · 12 s | “Here is AutoNEAR. You choose what it watches. You set the card’s limit and can stop it.” | “Watch” “Limits” “Stop” “NEAR testnet” | Real Landing → Watch → Vault surfaces slide under a persistent boundary ring. Owner controls stay large and legible. | Three-panel wipe; ring spring | No numbers | Bed returns with warm bass; soft click per control | **BUILT** app screens; use `LIVE SNAPSHOT` only if showing live database values | Confident and plain; pause after name |
| `evidence` · 11 s | “It reads public signals and shows its work. This snapshot has {{live.total\|w}} records. One promising idea still gets a low-confidence warning.” | “Evidence” “Low confidence” “Snapshot, not a promise” | Real evidence and council views; source cards flow inward, then warning takes focus. | Counter roll for captured count; amber wipe | `{{live.total}}`; optional `{{live.treasury.score}}` only if visibly sourced | Light ticks; bed narrows under warning | `LIVE SNAPSHOT` / **BUILT**, captured snapshot | Curious, then sober on warning |
| `council` · 11 s | “The council weighs the evidence. {{run.roleCount\|W}} roles prepare a brief, check the build, and leave a request for the owner.” | “Council recommendation” “Request waiting” | Council seats orbit; brief compresses to an Approvals card. Avoid suggesting that every seat is an independent model. | Orbit to card; spring settle | `{{run.roleCount}}` | Rising sequence of ticks; bed swells, then ducks | `RECORDED RUN · FIXTURE INPUTS` / **BUILT** code, **SHOW** run | Quick and playful; breathe at “owner” |
| `approval` · 12 s | “The owner reviews the exact request and holds to approve. Approval is a decision. The next action still has to pass its checks.” | “Review” “Hold to approve” “Approved request” | Approvals screen, evidence drawer, hold ring fills; the request passes into a separate check lane. | Hold-ring fill; clear lane wipe | None | Hold tone rises; release click; bed ducks for distinction | `RECORDED RUN · FIXTURE INPUTS` / **BUILT** control, **SHOW** replay | Deliberate; full stop after “decision” |
| `refusal` · 11 s | “Now a result comes back with the wrong code. AutoNEAR refuses to record that deployment. The matching result passes.” | “Mismatch · refused” → “Matching result · recorded” | The receipt check from the existing video fills screen; compare two fingerprints, snap shut, then permit the matching fixture. | Split-screen alignment, one-frame glitch, green reveal | `{{verification.badRecorded}}`, `{{verification.goodRecorded}}` as visual state, not displayed Boolean text | Metallic clack; silence; single clean chime | `RECORDED RUN · MOCKED RPC` / **BUILT** verifier, **SHOW** mock | Quiet on “wrong code”; firm on “refuses” |
| `testnet` · 11 s | “This has also reached NEAR testnet: a demo owner granted a capped vault, and the agent deployed through it. The owner key was automated.” | “Public testnet run” “Demo owner key · automated” “See transaction evidence” | Activity or Vault screen with an explorer link from the evidence file; show the source label prominently. Do not depict a person signing. | Slow push on verified receipt; restrained mineral glow | No transaction digits unless added to capture | Bed opens; no triumphant hit over the caveat | **BUILT** public testnet run; evidence `docs/testnet/near-testnet-v1.json` | Matter-of-fact; give “automated” room |
| `close` · 9 s | “The agent has a company card. You set the limit. Judges: clone it and run the tests.” | The memorable line; “Clone it · run the tests” | Card settles inside the boundary ring; ring becomes the AutoNEAR mark. Repo link from `video/script/meta.json` if populated. | Ring spring, then still frame | None | Bed resolves; card tap repeats from opening | **SHOW** end card | Warm, slow final line; crisp call to action |

**Production constraint:** The public testnet beat needs a new component that reads a curated, captured testnet evidence field. The current Remotion scenes cover the recorded fixture and mock flow, not this newer owner-app journey.

## 5. Final `script.json` scenes array

The array uses the existing scene schema. New IDs require entries in `video/src/scenes/index.tsx` and components listed below. `{{live.total|w}}` and `{{run.roleCount|W}}` resolve through the existing narration helper. The array contains no typed digits or banned claim words.

```json
[
  {
    "id": "night",
    "tag": null,
    "narration": "Your phone lights up at midnight. Your new hire wants to spend. Would you hand them the company card?",
    "style": "Intimate and curious; let the question hang."
  },
  {
    "id": "poison",
    "tag": "RECORDED RUN · FIXTURE INPUTS",
    "narration": "A public post looks useful. Hidden inside: an order to send the budget away. That is the trap.",
    "style": "Gather speed, then stop cold on the final sentence."
  },
  {
    "id": "owner",
    "tag": null,
    "narration": "Here is AutoNEAR. You choose what it watches. You set the card's limit and can stop it.",
    "style": "Warm and assured, with a clear pause after the product name."
  },
  {
    "id": "evidence",
    "tag": "LIVE SNAPSHOT",
    "narration": "It reads public signals and shows its work. This snapshot has {{live.total|w}} records. One promising idea still gets a low-confidence warning.",
    "style": "Bright discovery, then measured caution on the warning."
  },
  {
    "id": "council",
    "tag": "RECORDED RUN · FIXTURE INPUTS",
    "narration": "The council weighs the evidence. {{run.roleCount|W}} roles prepare a brief, check the build, and leave a request for the owner.",
    "style": "A little quicker, like a team working in sequence."
  },
  {
    "id": "approval",
    "tag": "RECORDED RUN · FIXTURE INPUTS",
    "narration": "The owner reviews the exact request and holds to approve. Approval is a decision. The next action still has to pass its checks.",
    "style": "Slow down; make the full stop after decision unmistakable."
  },
  {
    "id": "refusal",
    "tag": "RECORDED RUN · MOCKED RPC",
    "narration": "Now a result comes back with the wrong code. AutoNEAR refuses to record that deployment. The matching result passes.",
    "style": "Low and precise for the refusal; release tension on passes."
  },
  {
    "id": "testnet",
    "tag": null,
    "narration": "This has also reached NEAR testnet: a demo owner granted a capped vault, and the agent deployed through it. The owner key was automated.",
    "style": "Steady and factual; leave space after automated."
  },
  {
    "id": "close",
    "tag": null,
    "narration": "The agent has a company card. You set the limit. Judges: clone it and run the tests.",
    "style": "Land the first two sentences slowly, then invite action."
  }
]
```

**New Remotion components:** `NightPhone`, `OwnerJourney`, `CouncilRequest`, and `TestnetReceipt`. Adapt `PoisonCatch`, `ApprovalHold`, and `ReceiptRefusal` from the existing `act1.tsx` and `trust.tsx` scenes. Add scene registration and pause anchors. The current `video/scripts/verify.mjs` has ID-specific provenance checks for `pipeline`, `gate`, `verify`, and `evidence`; it must be updated for these IDs, then run against regenerated capture, TTS and timing data. The supplied array is a script proposal, not a claim that the unchanged verifier has already passed it.

## 6. Teaser cut for X autoplay

**Target:** 30 seconds. Begin on the refusal, then reveal the product.

| Time | Picture and tag | Narration |
|---|---|---|
| Opening beat | Orange public-post instruction hits the ring. `RECORDED RUN · FIXTURE INPUTS` | “An agent reads a poisoned post. It stops.” |
| Reveal | Phone alert becomes the owner’s Watch and Vault screens. | “Meet AutoNEAR: an agent with a company card. You choose what it watches. You set the limit.” |
| Proof | Wrong-code result snaps shut. `RECORDED RUN · MOCKED RPC` | “A wrong deployment result? Refused.” |
| Finish | Approval card, then ring and repo CTA. `RECORDED RUN · FIXTURE INPUTS` over the card | “The owner reviews the request. The agent has a company card. You set the limit. Clone it. Run the tests.” |

The teaser uses the same captured hostile fixture and mocked receipt. Its order creates the autoplay hook; its labels remain on screen throughout their respective shots.

## 7. Gemini TTS direction

**Casting:** Use **Puck** for the whole piece: its current voice gives the playful opening and firm refusals a consistent identity. Backup: **Charon**, with a warmer delivery instruction if Puck makes the warning sound too cheerful. A second “agent” voice could read only the suspicious instruction, but that risks making hostile text sound like the product’s command. **OPTIONAL:** it would require a second per-scene TTS request, separate audio track and timing anchors; the primary cut works better with no spoken villain line.

**Global style string:** “Confident, warm product-launch narration at about 2.6 words per second, with crisp sentences and natural pauses. Start intimate, gain energy through the owner flow, and become quiet and exact at each refusal.”

**Per-scene overrides and timing:** The `style` values in the JSON supply the arc. Estimates below allow punctuation pauses; actual scene length must be calibrated from generated audio, since the pipeline provides no word timestamps.

| Scene | Estimated speech | Pause anchors |
|---|---:|---|
| `night` | 8–9 s | After “midnight.”; hang after the question |
| `poison` | 8–9 s | After “useful.”; a sharper pause at the colon |
| `owner` | 8–9 s | After “AutoNEAR.” and “watches.” |
| `evidence` | 9–10 s | After “work.”; slow the warning |
| `council` | 9–10 s | After “evidence.”; settle on “owner.” |
| `approval` | 10–11 s | Full stop after “decision.” drives the lane change |
| `refusal` | 9–10 s | Full stop after “code.”; silence after “deployment.” |
| `testnet` | 10–11 s | Colon after “testnet”; full stop before the caveat |
| `close` | 7–8 s | Full stops carry the motif and CTA |

**Writing for the ear:** Sentences are short and mostly contain one idea. Emphasis comes from placing “refused,” “limit,” and “owner” at sentence ends. Full stops create animation beats. Use no capitals, stage directions or uncertain TTS markup in the transcript. Token numbers use the helper’s word form for speech and digit form for captions.

| Written term | Preferred spoken form | Fallback if the voice mispronounces it |
|---|---|---|
| AutoNEAR | “Auto Near” | “Auto-neer” |
| NEAR | “Near” | “neer” |
| Wallet address | Do not read it aloud | “the owner’s account” |
| `gov.near.org` | Do not read it aloud | “the Near governance forum” |
| USDC | Omit from this cut | “U S D C” |
| Code fingerprint/hash | “code” or “matching result” | Keep technical value in small caption only |

For Gemini 3.x, the short style belongs in the separate `speech_metadata` annotation and the transcript stays verbatim. For Vertex 2.5, put the style before the verbatim text as an instruction. The existing `tts.mjs` reads one global style; per-scene overrides in this proposed JSON need a small pipeline change to be honored. Generate each scene separately, then align springs and wipes to punctuation pauses in the resulting audio.

**Retake checklist:** Listen for clipped final consonants on “stops,” “checks,” and “tests”; accidental reading of a provenance label or style instruction; wrong stress on AutoNEAR; an excited reading of “low-confidence”; and a rushed caveat in `testnet`.

## 8. Claims ledger

| Claim made in narration or primary on-screen text | Status | Evidence and limit |
|---|---|---|
| Owner can choose watch terms and sources | **BUILT** | `web/src/app/Watch.jsx`, `src/watch.js`, `tests/watch.test.js`; terms rank and tag, and do not override relevance or injection flags |
| Owner can set a capped vault mandate and stop it | **BUILT** | `contracts/near-vault/src/lib.rs`, `contracts/near-vault/src/tests.rs`, `web/src/app/VaultPage.jsx`; UI owner transaction path has not been run against a funded vault in a human browser |
| Public signals are collected and shown with confidence warnings | **BUILT**; count is a dated snapshot | `src/ingest.js`, `src/scoring.js`, `video/src/data/captured.json`; tag `LIVE SNAPSHOT` |
| Council weighs evidence | **BUILT** | `src/council.js`, `web/src/app/Council.jsx`; rules are deterministic votes from stored data |
| Roles prepare a brief and automated checks | **BUILT** code; **SHOW** run | `src/orchestrator/agents.js`, `video/scripts/capture.mjs`, `video/src/data/captured.json`; fixture inputs and test-double build attestation |
| Suspected injected instruction is withheld | **BUILT** heuristic; **SHOW** fixture | `src/policy.js`, `src/orchestrator/agents.js`, `video/src/data/captured.json`; do not portray detection as infallible |
| Owner reviews an exact request and can hold to approve | **BUILT**; **SHOW** filmed replay | `web/src/app/Approvals.jsx`, `web/src/app/HoldButton.jsx`, `src/decisions.js`, `web/src/app/hold.test.js` |
| Approval is separate from verified execution | **BUILT** | `src/decisions.js`, `src/chains/near.js`, `tests/owner-approved-execution.test.js`; Manual NEAR loop exercised in a local sandbox |
| Wrong-code result is refused; matching result recorded | **BUILT** verifier; **SHOW** mocked result | `video/src/data/captured.json` `verification`, `video/scripts/capture.mjs`, `src/chains/near.js`; tag `RECORDED RUN · MOCKED RPC` |
| Agent deployed through a capped vault on public NEAR testnet | **BUILT**, historical run | `docs/testnet/near-testnet-v1.json`, `scripts/e2e-near-testnet.mjs`, `PROGRESS.md` Gate G; owner key was automated on the agent’s machine |
| Registries record approvals without moving funds | **BUILT** | `contracts/near-registry/`, `docs/contracts-spec.md`; this describes the registries, not the separate vault |
| “Company card” | **SHOW** metaphor | Represents the capped, revocable vault mandate; it is not a literal payment card |

Stablecoin payouts, product funding and ownership handover are absent from the narration. Their design document says they are staged work, while the repository also contains payout code and tests. A fresh integrated capture is needed before any payout claim enters this video.

## 9. New capture fields needed

The current `captured.json` predates the newer owner-app and public testnet story. Add these fields before rendering any numeric or transaction detail from those beats:

| Field | Exact source | Use |
|---|---|---|
| `testnet.network`, `testnet.ownerMode`, `testnet.vault`, `testnet.registry`, `testnet.explorerUrl` | Parse `docs/testnet/near-testnet-v1.json`; choose the deployment transaction and preserve the file’s demo-owner description | Testnet receipt card and link |
| `testnet.limit`, `testnet.agentDraw`, `testnet.refusals` | The same evidence file’s mandate and transaction records; cross-check with `PROGRESS.md` Gate G | Optional small proof captions; no typed digits |
| `ownerFlow.watchSaved`, `ownerFlow.holdApproved`, `ownerFlow.readOnlyStranger` | A fresh scripted run through `web/src/app/Watch.jsx`, `Approvals.jsx` and owner session endpoints; retain test fixture or scripted-wallet label | App-state transitions in the video |
| `council.verdict`, `council.ruleVersion` | `src/council.js` `currentCouncil` / `evaluate`, using the same database snapshot as the filmed evidence | Council card without mixing snapshots |
| `videoCapture.generatedAt` and fixture/mock markers per scene | `video/scripts/capture.mjs` | Provenance cards and freshness gate |

**Only a human can provide:** a public testnet Approval-room deployment signed in their own wallet, and a filmed real-wallet owner session if the final edit wants to claim or show either. The existing demo-owner testnet run is valid evidence for its narrower claim.

## 10. Self-critique

1. **The app flow and the receipt refusal come from different runs.** Keep a visible provenance card through each transition, and use a clean visual cut between the owner journey and the mocked receipt. A future human-signed testnet run could replace that seam.

2. **“Council” could sound like several independent AIs voting.** The visuals should say “published rules” in small text and show evidence cards feeding deterministic seats. The narration says only that it weighs evidence.

3. **The company-card metaphor could imply unrestricted purchases.** Show the card only inside the owner’s boundary ring, alongside “NEAR testnet” and the vault limits screen. The closing image pays off the limit, not spending power.