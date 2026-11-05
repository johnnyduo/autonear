# AutoNEAR demo video (Remotion + Gemini TTS)

A ~90-100 s pitch for the NEAR Hackathon (track: **AI Security & Defense**), built as code so it can be regenerated whenever the app changes.
Every number, label and rejection shown comes from `src/data/captured.json`, which `scripts/capture.mjs` produces by running AutoNEAR's real modules; nothing is typed in by hand.

## Provenance (what each scene really is)
| Scene | Source | On-screen tag |
|---|---|---|
| evidence | read-only snapshot of the app's own database (live ingestion from GitHub, gov.near.org, Hacker News, NEAR mainnet RPC) | `LIVE SNAPSHOT` |
| pipeline, gate | the real app modules run in memory on **fixture inputs** (canned evidence, test-double build attestation) | `RECORDED RUN · FIXTURE INPUTS` |
| verify | real verifier code against a **mocked NEAR RPC** (no public transaction) | `RECORDED RUN · MOCKED RPC` |
| proof | `npm test`, `cargo test --locked`, `forge test`, run on the date shown | `VERIFIED <date>` |

## Pipeline
```
node scripts/capture.mjs      # run real code paths -> src/data/captured.json
GEMINI_API_KEY=... npm run tts  # narration per scene (Gemini TTS) -> public/audio + src/data/timing.json (durations, pause calibration)
npm run audio                 # synthesised music bed + SFX (original, no licensing)
npm run verify                # claim / number / length gate (+ tsc)
npm run render                # -> out/autonear-demo.mp4
npm run studio                # live preview
node scripts/stills.mjs gate:0.9 verify    # review stills -> out/stills/
```
`npm run build` runs all of it. Without a key, `npm run tts:scratch` uses macOS `say` so layout and timing can be reviewed; `verify` warns until the real voice is generated.

## Editing the story
- Narration lives in `script/script.json`. Numbers must be `{{tokens}}` into captured data (`verify` rejects hard-coded digits and overclaiming words such as "audited", "guarantee", "mainnet").
- Scene visuals are in `src/scenes/*`; they anchor to spoken words via `useAnchors(s).at('phrase')`, calibrated against pauses detected in the real audio.
- Set `script/meta.json` `repoUrl` to the public repo before the final render.
- Gemini voice: `GEMINI_TTS_VOICE` (default `Puck`) and `GEMINI_TTS_MODEL` (auto-picked from ListModels). Key from env or untracked `video/.env`.

## Before posting
Re-run `capture` + `tts` + `render` right before recording (the app moves), then read `npm run verify` output. The X post needs `@NEARProtocol` and `#NEARHackathon`, the video attached, and the public repo link.
