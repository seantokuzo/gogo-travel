# GoGo Travel

Everything a person needs for planning a trip — and using during it. Multiple
trips, itinerary/calendar, bookings (stay / flights / trains / rentals /
activities), maps with saved places + travel times, budgeting with AI expense
estimates, AI recommendations + tour guide, Splitwise-style expense splitting
with Venmo/Zelle handoff, photo albums pinned to the map and itinerary, and a
minimal, re-skinnable design system.

## Status

**P-1 — Workflow foundation.** No app code yet; the autonomous dev harness and
planning docs land first, then specs (P-2), then the build.

## Where things live

| Thing | Where |
|-------|-------|
| Constitution (laws, autonomy contract) | `CLAUDE.md` |
| Roadmap + architecture | `docs/PLANNING.md` |
| Work queue | `docs/QUEUE.md` |
| Current state | `docs/STATE.md` |
| Locked decisions | `docs/decisions/` |
| How sessions work | `docs/SESSION-GUIDE.md` |
| Feature specs | `.specs/` |
| Review pipeline | `.agents/skills/pr-review-pipeline/` |
| Autonomous chain mode | `scripts/run-loop.sh` + `.agents/skills/autonomous-loop/` |

## Provenance

Workflow machinery ported from sibling repos: `the-bach` (in-session review
engine), `get-sean-done` (GSD template: planning system + autonomous loop),
patterns from `roi-gen`, `seantokuzo-mcp`, and product inspiration from
`bartling-bachelor`.
