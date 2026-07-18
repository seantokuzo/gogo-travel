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

### P-4 — Design system + navigation skeleton (ACTIVE)

- **P-3 CLOSED 2026-07-16** — 4/4 tasks merged through the full review loop;
  ledger F-002..F-009 flipped with evidence (F-001 held: step unsatisfiable
  as written — see B-1); archive: `docs/history/PHASE-003-foundations.md`.
- **T-4.1 MERGED (544bce8)** — @gogo/tokens: 312 tests, 258-pairing WCAG
  matrix, 45/45 approved seeds mutation-proven, 3 dark-mode AA fixes caught
  by review-added pairing, derive script committed (byte-reproduces hexes).
  Spec synced to shipped reality incl. §2.9 component mapping (71368ec).
- **T-4.2 MERGED 2026-07-17** — theme runtime wired (MMKV + Appearance
  singleton seams); first clean round-1 SHIP; mobile jest harness live.
- **T-4.3 MERGED (1fc755f)** — 14 components + dev Gallery, mobile 96 tests.
  Round-1: 1 blocking (RN 0.86 Pressable defaults `accessible:true` →
  ConfirmDialog card flattened to one AT element; fixed `accessible={false}`,
  revert-proven) + 11 advisories all addressed; judge merge/high (re-ran
  suite + revert-proof firsthand). Fix agent died awaiting Docker boot —
  orchestrator ran gate/commit inline. Landmine codified in rules/mobile.md.
- **T-4.4 MERGED (e7a56e2)** — NAV-1..7 skeleton: full §2.1 tree (36 route
  files), DS TabNav tab shell, TripIdProvider (vendored-router param gap),
  NAV-7 ESLint testID guard w/ committed self-test, mobile 144 tests.
  Round-1: first 5-lane 0-blocking SHIP (12 advisories, all fixed — one
  exposed a factually false test comment re back-behavior); judge merge/high,
  large-diff escalation WAIVED (mechanical, T-3.2/T-3.3 precedent).
  expo-router 57 landmines codified in rules/mobile.md.
- **PHASE CLOSE IN PROGRESS**: F-010..F-017 need simulator evidence
  (F-012 machine-only). First native build running (`expo run:ios`, Debug +
  Metro — MMKV blocks Expo Go; ios/ is CNG-gitignored). Then: evidence
  capture → ledger flips → archive → PLANNING row → Sean's Gallery QA moment.
- Parked (judge note, non-blocking): apps/mobile/tsconfig.json comment
  overstates node-builtin guard (real guard = Metro resolution failure);
  one-line no-restricted-imports or comment tweak in a future task.
- **Push re-blocked**: workflow-file pushes need `workflow` scope — Sean:
  `gh auth refresh -h github.com -s workflow`, then I push (first GitHub
  Actions run validates the new CI on the runner).
- Gotchas for future sessions: node ≥22.9 (env-file flag); mobile TS ~6.0.3
  is Expo's pin; guard-job comments must never contain literal trigger keys;
  PG assignment cast rounds numeric→bigint (app-boundary z.int is the gate).

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

- ~~Push blocked~~ → RESOLVED 2026-07-16: pushed to origin.
- ~~All P-2 gates~~ → passed. No open Sean items except: (P-14) buy the
  universal-link domain.
