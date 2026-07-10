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

### P-3 — Foundations (ACTIVE — build has started)

- **Gate 3 PASSED 2026-07-10.** Exec mode: **in-session, phase by phase**.
  Palette outcome: all three directions ship as user-selectable themes;
  default `goldenHour`; palette additions must be pure-data (tokens spec
  § Resolved). T-3.1 (monorepo scaffold) in progress via engineer subagent —
  versions pinned live via `npm view`/expo-doctor, never training data.
- Build loop per CLAUDE.md: build → CI gate → `/review` (5 lanes) → judge →
  merge `--merge` → ledger update → next task. Escalations only per the
  Autonomy Contract.

### P-2 — Upfront spec suite (CLOSED 2026-07-10; P-1 push still pending)

- **Where we are:** Gates 1 AND 2 passed 2026-07-09. Full spec suite written
  (18 files, ~280 EARS requirements) by 11 parallel spec agents; all 59
  punch-list questions approved wholesale (see `.specs/OPEN-QUESTIONS.md` —
  now the decision record); both resolution agents ran — **zero markers
  remain**. Cross-agent sync items applied (push_tokens.timezone, packing
  live-uncached, map search bar). Judgment calls flagged by resolvers are
  logged in their reports; notable: editors can only edit/delete their OWN
  expenses (per approved permission matrix), sole-owner account deletion →
  409 transfer-first.
- **T-2.4 DONE:** `feature-ledger.json` (118 features, F-001..F-118, all
  `passes:false`, 466 requirement IDs verified) + frozen roadmap **P-3..P-14**
  (12 phases, ~62 PRs) in PLANNING § Phase Detail. **GATE 3 OPEN — Sean
  approves the phase plan → P-3 build starts.**
- Sequencing notes from T-2.4 (binding): places spine ships with trips (P-6);
  AI expense-estimate CTA stubs in P-9, wires in P-10; capture (P-11) needs
  the AI platform (P-10); push emitter stubs P-6, transport lands P-13.
- Sean's open action items: **Gate 3 approval** · palette pick (artifact
  claude.ai/code/artifact/229f853e-c9d3-49a9-b439-96a0c27f914f) · gh auth
  login (push) · (later, P-14) buy universal-link domain.
- **Port sources, for archaeology:** `../the-bach` (in-session 5-lane review
  pipeline — its ADR-002 is our ADR-003; commands; hooks), `../get-sean-done`
  (canonical GSD template: doc system, autonomous loop, naming ADRs),
  `../bartling-bachelor` (product exemplar — mobile PWA, design system, itinerary
  UX), `../roi-gen` (STATE discipline), `../seantokuzo-mcp` (rules/hooks patterns).
- **Research base:** autonomous-build patterns synthesis (Anthropic harness
  posts, Spec Kit, Kiro, Ralph loop) — see PLANNING.md § P-2 for how it lands.

## In-flight decisions

- ~~S-1 stack~~ → **LOCKED 2026-07-09 as
  [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md)**: Expo/RN +
  Hono + Drizzle/Postgres monorepo, iOS-first, StyleSheet+tokens styling.
  Extras all approved (live-trip, utilities, collab, recap).
- ~~S-2 product research~~ → **DONE 2026-07-09.** All five streams banked in
  `.specs/research/`: `competitors.md`, `booking-integrations.md`,
  `maps-places.md`, `payments-settle-up.md`, `ai-architecture.md`.
  Headlines: all-in-one slot validated w/ no good competitor execution;
  splitting+payment-handoff is uncontested; **Mapbox over Google (Google ToS
  bans Places/Routes content on non-Google maps + AI use — this supersedes
  the AI report's Google-Places grounding; ground AI in our Overture/FSQ-OS
  POI spine instead)**; settle-up = record-only ledger + handle deeplinks
  (formats live-probed); Viator + Ticketmaster APIs instant-approve day one;
  Amadeus self-serve dies 2026-07-17 (we never touch it). Total run-rate
  ~$40–120/mo at 1k MAU. Spec-shaping sign-offs pending (see Blockers).

## Blockers / Waiting on Sean

- **Push to origin blocked:** `gh` token invalid — Sean runs `gh auth login -h
  github.com` (5 commits waiting on `main`).
- **Gate 1 open:** approve PLANNING.md § Architecture (component map, data
  model, provider table, offline/collab patterns) + pick auth method.
- Gates ahead: per-feature specs → feature ledger + frozen phase plan.
