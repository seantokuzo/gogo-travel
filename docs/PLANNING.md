# GoGo Travel — Planning Document

> Source of truth for architecture, design decisions, and the long-arc roadmap.
> Living spec, not a snapshot.
>
> **Naming convention:** stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) + canonical
> doc homes. See [ADR-001](decisions/ADR-001-naming-convention.md) and
> `.claude/rules/planning-doc-homes.md`.

---

## How to use this doc

| Doc | Purpose | When to read |
|-----|---------|--------------|
| `docs/PLANNING.md` (this file) | Architecture, design, full phase roadmap | Planning a phase, onboarding |
| `docs/QUEUE.md` | What's in flight RIGHT NOW | Every session start |
| `docs/STATE.md` | Active context, in-flight decisions, failed approaches | Every session start (auto-injected) |
| `docs/SECURITY.md` | Security findings + fix order | Security work |
| `docs/decisions/` | Locked decisions (append-only ADRs) | "Why did we do X?" |
| `docs/history/` | Completed-phase archives (append-only) | Post-mortems |
| `docs/SESSION-GUIDE.md` | Human operator playbook | Session start/end |
| `.specs/<area>/<name>.spec.md` | Feature/impl specs — the build contracts | Before building the thing |

---

## Overview

### What

**GoGo Travel** — a mobile travel app that holds a user's trips and covers the
full arc: plan it, book it, budget it, live it, remember it. Sean's brief,
verbatim scope:

**Core features (committed):**
- **Trips** — a user holds multiple trip plans; everything below is per-trip
- **Itinerary / calendar** — customizable calendar interface; day + range views
- **Bookings by category** — Stay (lodging); Travel (flights, trains, car/moped
  rentals); Activities/events
- **Maps** — save locations with times, estimated travel times between stops,
  clickable locations opening detail views
- **Budgeting** — per-trip budget interface with AI-powered expense estimation
  (food, transport, etc.)
- **AI recommendations** — suggested activities/food/lodging in destination
- **AI tour guide** — trivia / info on places being visited
- **Expense splitting** — Splitwise-style; send friends bills; Venmo/Zelle
  integrations or at minimum payment links on profile
- **Profiles** — customizable user profile (avatar, payment links, preferences)
- **Booking integrations / deeplinks** — minimize manual entry, maximize detail
  capture for all booking types
- **Photos / albums** — uploads pinned to map + itinerary; see pictures by place;
  private/public visibility so others planning the same destination can see
  experiences/reviews
- **Design system** — thoughtful, minimalistic, customizable (re-skinnable
  themes à la bartling-bachelor's ThemeProvider)

**Extras — APPROVED by Sean 2026-07-09, all four bundles committed:**
- Packing lists (AI-generated from destination/weather/duration)
- Weather forecast integrated into itinerary days
- Travel-document vault (passport/visa/insurance reminders + expiry alerts)
- Offline mode for the active trip (itinerary + maps + bookings cached)
- Collaborative trip planning (invite co-travelers, shared editing, votes on
  proposals — bartling had votes; proven pattern)
- Live-trip "today" view — a running home screen during the trip (next event,
  directions, countdowns)
- Flight status / delay notifications
- Currency converter + spend-in-local-currency logging
- Post-trip recap generator (album + stats + map trace)

### Why

Trip planning is scattered across booking sites, spreadsheets, group chats,
maps apps, and Splitwise. One app that holds the whole trip — and stays useful
DURING the trip — is the gap.

### Success metrics

- [ ] Sean plans and takes a real trip using only this app
- [ ] A full trip (lodging + transport + 10 activities) enterable in < 15 min
      via deeplinks/integrations
- [ ] Expense splitting round-trips a real group without a spreadsheet

---

## Architecture

**Stack locked — [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md).**

```
┌───────────────────────┐        ┌──────────────────────┐      ┌──────────────┐
│  apps/mobile          │  HTTP  │  apps/server         │      │  Postgres    │
│  Expo / React Native  │───────▶│  Hono + zod-validator│─────▶│  (Neon)      │
│  expo-router · TQ ·   │        │  Drizzle ORM         │      │              │
│  Zustand · tokens     │        │  auth · jobs         │      └──────────────┘
└──────────┬────────────┘        └──────────┬───────────┘
           │      shared contract           │
           └────────▶ packages/shared ◀─────┘
                     (@gogo/shared — Zod schemas, z.infer types)
```

- iOS first (simulator-driven dev), Android verification pass pre-launch.
- Styling: `StyleSheet` + design-token package; re-skinnable themes.
- Offline-first persistence pattern, maps SDK, AI provider: finalized in P-2
  design (S-2 research feeds it).

This section gets the full component map, API spec, and data model during P-2.

---

## Security

- Threat model written in P-2 alongside the data model (auth, IDOR on trip
  resources, photo privacy boundaries, payment-link injection, location privacy).
- Findings tracked in `docs/SECURITY.md`.
- Sensitive paths (auto-escalate review): auth, payments/splitting, photo
  privacy/visibility, migrations, release workflows.

---

## Phase Roadmap

> Status enum locked by [ADR-002](decisions/ADR-002-status-enum-lock.md).
> **P-3+ are provisional** — P-2's spec work freezes the real phase list.

| ID | Type | Title | Status | Priority | Depends on |
|----|------|-------|--------|----------|------------|
| P-1 | Phase | Workflow foundation (port machinery, CLAUDE.md, docs, ADRs 1-3, stack decision) | in-progress | P0 | — |
| P-2 | Phase | Research + upfront spec suite (product research, architecture, data model, per-feature specs, feature ledger, phase plan) | queued | P0 | P-1 |
| P-3 | Phase | Scaffold + design system + auth (provisional) | queued | P0 | P-2 |
| P-4 | Phase | Trips + itinerary/calendar core (provisional) | queued | P0 | P-3 |
| P-5 | Phase | Bookings by category + deeplink integrations (provisional) | queued | P0 | P-4 |
| P-6 | Phase | Maps + places + travel times (provisional) | queued | P0 | P-4 |
| P-7 | Phase | Budgeting + expense splitting + payment handoff (provisional) | queued | P1 | P-4 |
| P-8 | Phase | AI layer: recommendations, expense estimation, tour guide (provisional) | queued | P1 | P-5, P-6 |
| P-9 | Phase | Photos/albums + map/itinerary pinning + visibility (provisional) | queued | P1 | P-6 |
| P-10 | Phase | Launch readiness: perf, offline, store/deploy (provisional) | queued | P1 | P-5..P-9 |

---

## Phase Detail

### P-1 — Workflow foundation

- **Status:** in-progress · **Priority:** P0
- **Goal:** A fully-armed autonomous dev harness: ported machinery, CLAUDE.md
  constitution, planning docs, local review pipeline, autonomous loop — plus the
  stack decision (ADR-004) so P-2 can spec against a real target.
- **Acceptance criteria:**
  - [x] Machinery ported + rebranded (`GOGO-*` markers)
  - [x] CLAUDE.md + docs + ADR-003 authored
  - [ ] Aggregator tests green (`node --test .github/scripts/`)
  - [ ] Pushed to `origin/main`
  - [x] ADR-004 (stack) locked with Sean's buy-in — Expo/RN + Hono/Drizzle/
        Postgres, iOS-first, all four extras bundles committed
  - [x] Stack-specific bits pinned (T-1.4: CI gate command, engineer personas;
        path-scoped rules + formatter hook land with the P-3 scaffold)
- **Tasks:** T-1.1 port · T-1.2 author · T-1.3 commit/push · T-1.4 pin
  stack-specifics · S-1 stack spike
- **Linked ADRs:** ADR-001, ADR-002, ADR-003, ADR-004 (pending)

### P-2 — Research + upfront spec suite

- **Status:** queued · **Priority:** P0
- **Goal:** Specs complete enough to "one-shot" the build with minimal ambiguity.
  Front-load ALL the human-in-the-loop: interview Sean until zero
  `[NEEDS CLARIFICATION]` markers remain, then the build phases run autonomously.
- **Deliverables:**
  - S-2 research: competitor teardown, booking-deeplink landscape (flights /
    lodging / rentals / trains), maps SDK comparison, Splitwise/Venmo/Zelle
    integration reality-check, AI provider plan
  - Architecture + data model + API contract (this doc's Architecture section)
  - Per-feature specs in `.specs/<area>/` — three artifacts each:
    `requirements` (EARS acceptance criteria: "WHEN <condition> THE SYSTEM
    SHALL <behavior>"), `design`, `tasks` (traceable to requirement IDs)
  - `feature-ledger.json` — machine-checkable verification ledger (per feature:
    verification steps + `passes: false`). **Tamper rule: booleans flip only
    after verified testing; removing/editing entries is forbidden.**
  - Frozen phase roadmap (replaces the provisional P-3+ rows above)
  - Threat model + SECURITY.md seed
- **Approval gates (Sean):** feature set → architecture/data model → phase plan.
  Each gate is a real stop; after the last one, autonomy is the default.
- **Linked spikes:** S-1 (stack), S-2 (product research)

---

## Review Pipeline Configuration

> Local, in-session — [ADR-003](decisions/ADR-003-local-in-session-reviews.md).
> Mechanics: `.agents/skills/pr-review-pipeline/SKILL.md`; sentinel format:
> `.claude/rules/pr-review-files.md`.

- **Lanes (locked, 5):** correctness · security · tests · performance · conventions
- **Judge:** fresh impartial subagent → `merge | re-review | human-decides`;
  hard cap 4 rounds
- **Sensitive paths (auto-escalate + recommend `/code-review` at high effort):**
  `**/auth/**`, `**/payment*/**`, `**/split*/**`, photo visibility/privacy
  logic, `**/migrations/**`, `.github/workflows/**`
- **Project blocking criteria:** money handled in integer cents/Decimal only;
  no location/photo data crossing a privacy boundary without an explicit
  visibility check; secrets never in code
- **Per-phase re-evaluation:** when a phase introduces a new domain (AI layer,
  payments), re-check the lane mix before starting it.

---

## Decisions Log

> At-a-glance pointers. Full rationale in `docs/decisions/`.

| Date | ID | Decision | ADR | Revisit? |
|------|-----|----------|-----|----------|
| 2026-07-09 | ADR-001 | Stable IDs (P/T/B/S) + canonical doc homes (adopted from GSD template) | [ADR-001](decisions/ADR-001-naming-convention.md) | No |
| 2026-07-09 | ADR-002 | Status enum lock: `queued/in-progress/blocked/done/deferred/cancelled` | [ADR-002](decisions/ADR-002-status-enum-lock.md) | No |
| 2026-07-09 | ADR-003 | PR reviews run local in-session on Max — never GitHub Claude app / metered CI | [ADR-003](decisions/ADR-003-local-in-session-reviews.md) | No |
| 2026-07-09 | ADR-004 | Expo/RN + Hono + Drizzle/Postgres monorepo, iOS-first | [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md) | No |
