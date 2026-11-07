# Brief for Codex: write the end-to-end presentation script for AutoNEAR

You are the scriptwriter and creative director for the hackathon demo video of AutoNEAR (this repo). You have read-only access. Do not edit files; return one Markdown document (format at the bottom).

## Who watches, and what they must feel
- Audience: NEAR Hackathon judges (first Claude Code and Codex screen the repo, then humans) and people scrolling X. Most are NOT engineers. They give a video 5 seconds.
- Promise to the viewer: "In 90 seconds you will understand a new kind of AI agent: one you can give a small budget and still sleep." Understand in five seconds, wow by second fifteen, remember one sentence afterwards.
- Tone: modern, confident, playful, a little theatrical. Zero jargon in the narration (no "nonce", "wasm", "RPC", "hash" spoken aloud; show them on screen as small proof details, not as the story). Think product launch, not conference talk.
- Length: main cut 90-100 s of audio (hard cap 105 s, <= 245 spoken words), plus a 30 s teaser cut for X autoplay (same facts, different order, hook in the first 2 s).

## Step 1: learn the real product first (read, do not guess)
Read: `README.md`, `PROGRESS.md`, `docs/HANDOFF.md`, `docs/superpowers/specs/*.md` (especially `2026-11-06-owner-app-redesign-design.md`, `2026-11-06-build-show-design.md`, `2026-11-06-stablecoin-payouts-design.md`), `web/src/` (the owner app screens), `src/council.js`, `src/decisions.js`, `src/policy.js`, `contracts/near-vault/`, and the existing video in `video/` (`script/script.json`, `scripts/verify.mjs`, `scripts/capture.mjs`, `src/scenes/`, `src/data/captured.json`, `README.md`).
The product is moving fast: several specs are DESIGN ONLY. For every beat you want in the story, check the code and tests and label it:
- BUILT: works in the repo today, with the file and test that prove it.
- SHOW: a staged replay or illustration; allowed only with an on-screen label saying so.
- DESIGN-ONLY: not built; must NOT appear as something the product does. You may mention it only as "next" in the last line, if at all.

## Step 2: map the customer journey (this is the spine of the story)
Describe the real journey of the owner (a web2/web3 client, not an engineer) from first contact to outcome, in plain steps, for example: lands on the page -> connects a wallet -> sets limits and a watch list -> the agent watches public signals -> the council of seven roles votes -> an action waits for the owner -> owner approves in their own wallet -> the chain receipt is checked -> the outcome is recorded. Correct this list from what the code really does. For each step give: the user's feeling, what is on screen, status (BUILT/SHOW/DESIGN-ONLY), evidence path.

## Step 3: design the story (be creative, then be strict)
- Open with a cold open a non-technical person feels immediately (one concrete human image or a question, not a logo). Use ONE everyday metaphor that carries the whole video (for example a new hire with a company card that has a limit and needs a manager's signature) and pay it off at the end. You may propose a different metaphor if it is better; justify it in one line.
- Three acts: tension (why giving an AI money or keys is scary; a poisoned public post is the villain), turn (what AutoNEAR does differently, shown not told), proof (the moment it refuses a wrong thing, then the chain checks the result).
- Include two "wow" moments that are visible and explainable without words: e.g. the hostile instruction being caught and withheld, and the wrong code hash being refused. Design each as a 3-5 second visual beat with a sound cue.
- One recurring motif (visual or sonic) that returns at the end. End with a single memorable line plus one call to action for the judges (clone it, run the tests).
- Respect the provenance rules below. A great script is honest about what is live, what is a recorded run on fixtures, and what is mocked, and makes that honesty feel like a strength ("it tells you when not to trust it").

## Hard honesty rules (the repo's own fact-checks enforce these; violations fail `npm run verify`)
- NEAR testnet only. Never say mainnet, "real funds", "secure(d)", "audited", "guarantee", "production-ready", "autonomous deployment", "never moves/holds funds" (say what the code does instead: registries record approvals, they do not move funds; the vault limits what the agent can draw).
- No independent audit exists. The injection filter is heuristic. The audit log is hash-linked, not externally anchored. Live swap quotes were synthetic fixtures. A public testnet deployment signed by the owner's wallet may not exist yet: check `docs/testnet/` and `PROGRESS.md` before saying a deployment happened.
- Every number in narration or on screen must be a `{{token}}` resolved from `video/src/data/captured.json` or `video/src/data/contracts.json` (no digits typed in narration). If you need a number that is not in those files, list it under "new capture fields needed" with the exact source in the code, do not invent it.
- Scenes built from fixtures need the tags `RECORDED RUN · FIXTURE INPUTS`; mocked RPC needs `RECORDED RUN · MOCKED RPC`; real database snapshot needs `LIVE SNAPSHOT`; measured test results need `VERIFIED <date>`.

## Step 4: technique, scene by scene (the production notes must be exact enough to build from)
For every scene give a row with: scene id, duration target (s), narration (spoken words), on-screen text, visual (what moves, what is revealed, where the eye goes), camera/motion style (Remotion: spring, wipe, parallax, counter roll, typewriter, glitch, etc.), data shown and its `{{token}}`, SFX cue and music behaviour (the music bed is synthesized with ffmpeg: say where it ducks, swells or stops), provenance tag, status (BUILT/SHOW), and the voice direction below. Visual identity is fixed: ink #0a0c0f, signal #c6f432, risk #ff6a3d, warn #f2b84b, mineral #5fa3c2, Instrument Serif / Inter Tight / JetBrains Mono (see `video/src/theme.ts`). Prefer screens and flows from the real owner app (`web/src`) rendered as designed scenes over abstract art.

## Step 5: Gemini TTS direction (this is how the voice will be produced, so write for it)
Pipeline facts: narration is synthesized one scene per request with `video/scripts/tts.mjs`. Gemini 3.x uses the Interactions API where a short style is passed as a separate `speech_metadata` annotation and the text is a verbatim transcript; Vertex AI (2.5 TTS) uses generateContent with the style as an instruction before the text. There are no word timestamps, so timing is calibrated from the pauses in the audio: sentence breaks (`. ! ? :`) become pauses, and the on-screen animation syncs to them. Voice today: Puck.
Give me:
1. Voice casting: choose a prebuilt Gemini voice (and one backup) for the whole piece and say why; if a two-voice format would clearly wow (e.g. narrator + the "agent" voice), say what pipeline change it needs and mark it OPTIONAL.
2. A global style string (<= 2 sentences, nothing that could be read aloud as content, includes pace in words per second) and a per-scene style override for each scene (energy arc across the video: where it whispers, where it accelerates, where it lands).
3. Writing-for-the-ear rules you applied: sentence length, rhythm, where a full stop creates the beat, how emphasis is created by word order and short sentences (not by ALL CAPS, not by tags we are unsure the model supports), how numbers are spelled, words to avoid because TTS mispronounces them (NEAR, AutoNEAR, wallet addresses, "gov.near.org", "USDC"): give a phonetic or respelled fallback for each hard word and a `spoken` form.
4. Per scene: the exact narration with `{{tokens}}`, an estimated spoken duration at 2.4-3.0 words/s, and the pause beats you rely on.
5. A short retake checklist for the human to listen for (clipped endings, spoken instructions, wrong stress).

## Output format (one Markdown document, in this order)
1. **One-line pitch + the single sentence viewers should repeat.**
2. **Customer journey map** (table: step, feeling, screen, BUILT/SHOW/DESIGN-ONLY, evidence path).
3. **Story concept**: metaphor, three acts, motif, the two wow moments.
4. **Storyboard table** (Step 4 columns), main cut.
5. **Final `script.json` scenes array** for the main cut, valid JSON in the same schema as `video/script/script.json` (`id`, `tag`, `narration`, optional `style`), numbers only as `{{tokens}}`, passing the banned-word and 245-word rules. Fresh scene ids are fine; list any new scene components the Remotion project needs.
6. **30 s teaser cut**: scene list, narration, hook.
7. **Gemini TTS direction** (Step 5).
8. **Claims ledger**: every factual claim in the narration or on screen -> status -> evidence file.
9. **New capture fields needed** (exact source in code) and anything only the human can provide (e.g. a real testnet transaction signed by their wallet).
10. **Self-critique**: the three weakest moments of your own script and how you would fix each.
