# Build show: from council vote to a published product page

Status: design, waiting for the owner's OK. Nothing in this document is built yet. Date: 2026-11-06. Deadline for the project: 14 Nov 2026 23:59 UTC.

## Intent
The pipeline ends today with a pending request and a contract build. Nothing shows the last mile: the council backs a product, the owner says yes, the agents make something, and it is on the web. This feature shows that last mile in about 30 seconds on one internal page, with a published page at `/develop/<slug>`. The visual idea is a small swarm of named cursors that draw the page live (boxes, typing, lines), taken as a concept from github.com/DhvanilPatel/swarm-cursors. That repo has no licence and asks that its code is not reused, so we write our own code and take nothing from it.

## What is real and what is a show
| Part | Real or show |
| --- | --- |
| Council votes, ranking, verdict, threshold (62 build, 48 watch) | Real, from `/api/council` |
| Owner vote | Real. A wallet-signed owner session must press Approve. It is stored in the audit log. It is not an on-chain transaction |
| Page content (headline, three features, how it works, call to action) | Real, written once by Gemini (flash-lite) from the stored council entry and stored evidence titles. Stored with model, tokens, cost |
| The swarm drawing the page | A show. It replays a stored blueprint. Labelled "replay of a stored build" |
| Publish | Real: the page becomes available at `/develop/<slug>` |

The contract build (Rust, attested with `npm run attest`) stays as it is, offline. This page is about the product site only.

## Flow on the page (`#/build`, owner app, internal)
1. **Queue.** The ranked products from the council. Top one first. Each row: score, verdict, "needs 62 to build", and whether it already has a stored site. Second place and below are the "waiting for a vote" list: their votes are recomputed at every scheduler tick, nobody votes on them by hand today. A row with WATCH can be pushed by the owner ("build on my call"); the published page then says so.
2. **Council vote.** The seven seats light up with their real stored scores (existing seat names and weights).
3. **Owner vote.** One Approve button. Needs the owner wallet. Without it the page is read-only.
4. **Build.** If the product has no stored blueprint, the server asks Gemini once (about 5 s), validates the answer against a schema, and stores it. Then the swarm replays the blueprint: 5 or 6 named cursors (Copy, Layout, Style, Media, Check), roughly 20 s, skippable. Sound is off by default.
5. **Done.** A preview of the finished page next to a Publish button and the content hash of the blueprint.

Target: under 30 s end to end for a product that has no stored blueprint, about 22 s when it does.

## The blueprint (the key decision)
Gemini never writes HTML. It returns a small JSON content object. Our code turns it into a **blueprint**: a list of layers (rect, text, line, button, image placeholder) with positions, sizes, colours from our tokens, and a build order with dependencies. One blueprint feeds both outputs:
- the server renderer that makes the published HTML (all text escaped),
- the client swarm that replays it.

Consequences: no model-written code ever runs, the page cannot carry scripts, the animation is deterministic and costs no tokens when replayed, and the content hash of the blueprint identifies a version.

## Cost
One Gemini call per product, about 1.5k tokens in and 1k out with `gemini-3.1-flash-lite`, a fraction of a cent. Replays and visits cost nothing. Haiku is an Anthropic model and the project uses Gemini only, so it is not an option here.

## Publish and URLs
- `/develop/<slug>`: the latest published version. The slug comes from the product name (`dex`, `treasury`, `ai-agents`).
- `/develop/<slug>/<hash>`: one exact version (first 10 hex characters of the blueprint hash). Visiting plays the swarm rebuild, then leaves the live page; `?still=1` or reduced motion shows the page directly.
- Publish needs the owner session. Unpublish exists.
- If the project gets its own domain later, the same paths work there. Right now the host is the Vercel one.
- Every published page carries a footer: "Example page written by AutoNEAR agents from stored evidence. Not a live service." with the council score and the date, and a link to the evidence.

## Security
- Served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` and `X-Content-Type-Options: nosniff`. The only script is our own static replay file.
- No cookies, no auth, no wallet code on those pages, so nothing of the owner app is reachable from them.
- The JSON from Gemini is checked against a schema (lengths, no URLs except our own links, no HTML), then escaped on render.
- Publish and build endpoints require the owner session. Build is rate-limited and has a daily token budget like the rest of the pipeline.

## Parts to build
1. `src/sites/` : schema, blueprint builder (pure), HTML renderer (pure), Gemini content call through the existing provider layer, store (`sites` table in the existing database, migration included), endpoints `GET /api/sites`, `POST /api/sites/:opp/build`, `POST /api/sites/:slug/publish`, `GET /develop/:slug[/:hash]`.
2. `web/src/app/Build.jsx` : the page, with the queue, stepper and preview.
3. `web/src/app/swarm.js` : the swarm engine (cursors, tasks, flocking, typing), shared by the page and the published page.
4. Tests: blueprint and renderer (escaping, determinism, hash), schema rejects bad model output, endpoint auth, CSP header, swarm scheduler timing (pure part).

## Not in scope
Real web app code generation, custom domains, editing the page by hand, on-chain recording of the owner vote.

## Calls I made (change them if you disagree)
- Gemini returns content only, our code lays it out. Chosen over model-written HTML for safety and for a reliable animation.
- Products with WATCH can be built only by an explicit owner override, and the page says so.
- The owner vote on this page is a signed session plus a stored approval, not a transaction.
- Slug and hash scheme above. The domain stays as it is.
