# GoGo Travel — Work Queue

> Live work pulse. Order is **derived**: highest-priority `queued` item whose
> `depends_on` are all `done`. IDs are stable — never renumber.
> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)):
> `queued · in-progress · blocked · done · deferred · cancelled`

## Active

| ID | Title | Status | Priority | Depends on |
|----|-------|--------|----------|------------|
| P-2 | Phase: upfront spec suite — Gates 1+2 PASSED 2026-07-09; **Gate 3 (phase plan) awaiting Sean** | in-progress | P0 | — |
| P-3 | Phase: foundations — scaffold + `@gogo/shared` + DB schema (PLANNING § P-3) | queued | P0 | P-2 (Gate 3) |
| T-3.1 | Monorepo scaffold: pnpm+Turborepo, Expo dev build, Hono server, versions pinned via `npm view`/expo-doctor, path rules + formatter hook | queued | P0 | P-2 (Gate 3) |
| T-3.2 | `@gogo/shared` scaffold [SH-1]: enums, scalars, envelope, descriptors, 16 domain modules, ai/* schemas | queued | P0 | T-3.1 |
| T-3.3 | DB schema + initial migration + constraint suite [DB-1] | queued | P0 | T-3.2 |
| T-3.4 | CI gate (`pnpm lint/typecheck/test/build`) + postgres-js test harness | queued | P0 | T-3.1 |

## Blocked

| ID | Title | Status | Priority | Blocker |
|----|-------|--------|----------|---------|
| T-1.3 | Push workflow foundation to origin | blocked | P0 | `gh auth login` needed (Sean) — 2 commits waiting on `main` |

## Recently done

| ID | Title | Done |
|----|-------|------|
| T-2.4 | feature-ledger.json (118 features, F-001..F-118) + frozen phase roadmap P-3..P-14 (PLANNING § Phase Detail) → Gate 3 packet ready | 2026-07-09 |
| T-2.3 | Spec bundles: auth/users/entitlements · trips/itinerary/bookings · capture · maps/places · money · AI · photos · notifications/today — all drafted, zero markers | 2026-07-09 |
| T-2.2 | Spec: design system tokens + navigation IA | 2026-07-09 |
| T-2.1 | Spec: DB schema + shared Zod contracts | 2026-07-09 |
| S-2 | Product + integration research — 5 reports banked in `.specs/research/` | 2026-07-09 |
| T-1.1 | Port workflow machinery from sibling repos | 2026-07-09 (70c0065) |
| T-1.2 | Author CLAUDE.md + planning docs + ADRs 1–3 | 2026-07-09 (70c0065) |
| S-1 | Stack decision → [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md) (Expo/RN + Hono/Drizzle/Postgres, iOS-first) | 2026-07-09 |
| T-1.4 | Pin stack-specifics (CI gate cmd, engineer personas; path rules land with P-3 scaffold) | 2026-07-09 |
