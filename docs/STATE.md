# GoGo Travel — Active State

> **Short-term active context** for in-flight work. Advisory cap ~800–1000 lines.
> Locked decisions → `docs/decisions/ADR-NNN-*.md`. Completed phases → `docs/history/`.
> Stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) per [ADR-001](decisions/ADR-001-naming-convention.md).
> Log **failed approaches** here too ("Tried X, didn't work because Y") — fresh
> sessions must not re-walk dead ends.

---

## CURRENT DIRECTION

Building **GoGo Travel** — a mobile travel app covering everything a person needs
for planning AND using during a trip. Multiple trips per user; itinerary/calendar,
bookings by category (lodging / flights / trains / car+moped rentals / activities),
maps with saved places + travel times, budgeting + AI expense estimates, AI
recommendations + AI tour guide, Splitwise-style expense splitting with Venmo/Zelle
handoff, photo albums pinned to map/itinerary (private/public), deeplink-first
booking integrations, minimal customizable design system.

**Operating model:** high-autonomy Claude builds from upfront specs; Sean is
planner/spec-maker/QA. Human-in-the-loop ONLY at the escalation triggers in
`CLAUDE.md § Autonomy Contract`. Reviews are **local in-session**
([ADR-003](decisions/ADR-003-local-in-session-reviews.md)) — no GitHub Claude app.

## Active phase context

### P-1 — Workflow foundation (in progress)

- **Where we are:** Machinery ported from sibling repos; markers renamed
  `BACH-*`/`GSD-*` → `GOGO-*`. CLAUDE.md + planning docs authored. Next:
  commit/push (T-1.3), then stack decision (S-1) unblocks the rest.
- **Port sources, for archaeology:** `../the-bach` (in-session 5-lane review
  pipeline — its ADR-002 is our ADR-003; commands; hooks), `../get-sean-done`
  (canonical GSD template: doc system, autonomous loop, naming ADRs),
  `../bartling-bachelor` (product exemplar — mobile PWA, design system, itinerary
  UX), `../roi-gen` (STATE discipline), `../seantokuzo-mcp` (rules/hooks patterns).
- **Research base:** autonomous-build patterns synthesis (Anthropic harness
  posts, Spec Kit, Kiro, Ralph loop) — see PLANNING.md § P-2 for how it lands.

## In-flight decisions

- **S-1 — Stack choice (BLOCKS P-2 freeze):** mobile PWA (à la bartling-bachelor:
  Vite + React + Express) vs Expo/React Native (à la the-bach: Expo + Hono +
  Drizzle/Postgres + shared Zod package) vs Expo-with-web hybrid.
  Options + recommendation going to Sean. Output → ADR-004.
- **S-2 — Product research:** competitor features, booking-deeplink landscape
  (flights/lodging/rentals), maps SDK choice, Splitwise/Venmo/Zelle integration
  reality-check. Feeds the P-2 spec suite.

## Blockers / Waiting on Sean

- S-1 stack decision.
- Feature-set sign-off (including proposed extras in PLANNING.md § Overview)
  before P-2 specs freeze.
