# AutoNEAR hackathon demo video: design

Status: user opted out of further questions ("do it autonomously until perfect"). Every choice marked **[my call]** was made by the builder, not agreed with the user.

## Intent
A ~90 s video, posted on X for the NEAR Hackathon (submission deadline 2026-11-14 23:59 UTC), that makes a judge who has never heard of AutoNEAR understand three things in order: the **problem**, the **solution**, and that it **really works end to end**. It must feel like a confident pitch (hype in pacing and sound), but every factual claim must be true of the code in this repo.

## Why these constraints
- The demo post on X needs a video; screenshots alone are rejected (HACKATHON.md Q-012). No length is specified.
- HACKATHON.md demo tips: first line understandable to a stranger; show one complete moment from real user action to visible result; skip architecture slides; state NEAR's role concretely; end with a next step and the repo link.
- Claude Code and Codex screen every project first and check "it runs and does what the README says". The video and README must tell the same story.
- Human judges: Illia Polosukhin, a16z crypto, Helius, Electric Capital, Synthetix, Dragonfly, cyber•Fund.

## Goals
1. Hook in the first 5 s that a non-expert grasps: AI agents can find what to build, but must never be able to spend without a human.
2. One continuous, truthful e2e moment: evidence in -> scored opportunity with confidence and warnings -> policy gate -> proposal -> human approval on a NEAR registry -> recorded receipt.
3. Show the safety story concretely: attacks the system rejects (prompt injection, over-budget spend, altered proposal, replay), taken from real tests.
4. Name NEAR's role concretely (registry contract on NEAR, NEAR Intents quotes, on-chain usage corroboration).
5. End with repo link and one specific call to action.
6. Reproducible: `npm run video:*` regenerates narration, captions and the render from a script file.

## Non-goals
- No claim that AutoNEAR moves funds, runs on mainnet, or executes autonomously. The registry is an attestation registry; treasury routes are a rehearsal (live quote when reachable, otherwise labelled synthetic fixtures).
- No generic "powered by AI" filler, no architecture slide, no logo wall.

## Anti-goals (failure even if it renders)
- Any scene presenting synthetic or mocked output as live. Each scene carries an honest provenance tag (LIVE, RECORDED RUN, FIXTURE).
- Narration that outruns what is on screen, or on-screen text unreadable at phone size.
- Claims the audit (Codex + Claude) flags as unbacked.

## Constraints
- Output: 1920x1080, 30 fps, H.264 MP4 with burned-in captions, plus a 1080x1080 or 1080x1350 variant if time allows. **[my call]**
- Narration: English, Gemini TTS, one voice. **[my call]**
- Stack: Remotion (latest, 4.0.x) in `video/`, own package.json, not touching the app's dependencies. **[my call]**
- Visual language comes from `design-system/autonear/MASTER.md` (gold `#F59E0B`, violet `#8B5CF6`, slate `#0F172A`, Orbitron + JetBrains Mono). Note: the app's `web/` uses Inter Tight/Instrument Serif; the video follows the MASTER file unless the web UI is finished and differs, in which case match the shipped UI. **[my call]**
- Secrets: `GEMINI_API_KEY` is read from the environment or an untracked `video/.env`; never committed.
- Truth source: Codex audit of the repo (`docs/superpowers/specs/video-claims-audit.md`) plus claims checked against code and test runs.

## Structure (draft, ~90 s) **[my call]**
1. Hook (0-6 s): "Anyone can build an AI agent. Nobody wants to give it the keys."
2. Problem (6-20 s): builders guess what to build; agents given wallets are one injected comment away from a bad transaction.
3. Solution (20-32 s): AutoNEAR = evidence -> opportunity -> proposal -> human-approved on NEAR. Agent can propose, never spend.
4. Live e2e (32-70 s): real run, step by step, with provenance tags.
5. Attack wall (70-80 s): rejected cases from the real negative-test matrix.
6. Close (80-90 s): repo, what's next, ask.

## Pipeline
`video/script/script.json` (scenes: id, narration, on-screen data) -> `scripts/tts.mjs` (Gemini TTS -> wav -> mp3, writes per-scene durations and word timings) -> Remotion composition reads durations via `calculateMetadata` so picture length follows audio -> `npm run render`.

## Left to the builder
Exact motion design, music bed (royalty-free or generated; none if licensing is unclear), caption styling, and which real outputs to capture, subject to the claims audit.
