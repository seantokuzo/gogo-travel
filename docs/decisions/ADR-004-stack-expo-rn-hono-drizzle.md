# ADR-004: Stack — Expo/React Native + Hono + Drizzle/Postgres monorepo

**Status:** Accepted
**Date:** 2026-07-09
**Supersedes:** none
**Superseded by:** none

## Context

GoGo Travel is a mobile app whose core features skew heavily toward *during-trip*
usage: native maps with saved places and travel times, camera/photo albums pinned
to places, offline access on spotty connectivity, push notifications (flight
status, itinerary), and a live "today" view. Sean approved the full extras set
(live-trip experience, trip utilities, collaborative planning, post-trip recap),
committed to **iOS first, Android soon after**, and picked the backend
(Hono + Drizzle + Postgres) before the platform question closed.

Two proven exemplars exist in sibling repos: `bartling-bachelor` (mobile PWA —
shipped, but its own weakest points are iframe-grade maps, browser-limited
camera, and weak offline) and `the-bach` (Expo/RN + Hono/Drizzle/Neon monorepo
with a shared Zod contract package — its documented Expo pain was app bugs, not
platform failures).

## Decision

**pnpm-workspaces + Turborepo monorepo, TypeScript strict everywhere:**

| Workspace | Stack |
|-----------|-------|
| `apps/mobile` | **Expo SDK (latest at scaffold) + React Native**, `expo-router`, TanStack Query (server state), Zustand (client state), offline-first persistence (MMKV/SQLite — pattern finalized in P-2 design), `expo-notifications` |
| `apps/server` | **Hono** + `@hono/zod-validator`, **Drizzle ORM** on **Postgres** (Neon serverless in dev/prod; `postgres-js` + testcontainers in tests) |
| `packages/shared` | **Zod schemas as the single source of truth** — all wire types are `z.infer`; platform-agnostic (DI for platform deps) |

- **Styling:** `StyleSheet.create` + a design-token package (re-skinnable themes).
  NativeWind is NOT adopted by default — half-adopting it was a documented
  the-bach landmine; a deliberate migration may be proposed in P-2 design.
- **Targets:** iOS first (simulator-driven dev; Apple dev account deferred until
  push-on-device/TestFlight). Android stays compilable; verification pass
  pre-launch.
- **Exact package versions:** pinned at P-3 scaffold via `npm view <pkg> version`
  + `npx expo-doctor` — never from training data.
- **Maps SDK and AI provider:** chosen in S-2 research (separate ADRs if
  non-obvious).
- **CI gate:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Alternatives considered

1. **Native Swift (iOS) + Kotlin (Android) later.** Maximum platform fidelity,
   but the app gets built twice, the shared Zod contract with the chosen backend
   is forfeited (parallel hand-maintained types), AI-assisted throughput drops,
   and every ported sibling-repo pattern is discarded. Rejected — nothing in
   this feature set (no AR/game/DSP) needs it; Expo dev builds keep a custom
   Swift-module escape hatch anyway.
2. **Mobile PWA (bartling-bachelor path).** Fastest iteration, no app store —
   but web-grade maps/camera/offline directly undercut the committed live-trip
   bundle. Rejected for the product, its design-system/theming ideas still port.
3. **Supabase (BaaS) instead of Hono/Drizzle.** Cuts auth/storage boilerplate,
   but vendor-couples the API layer and drops the owned-contract discipline that
   worked in the-bach. Rejected; Neon still gives managed Postgres.
4. **Express + MongoDB (bartling path).** Familiar and shipped, but document
   modeling fits trips/itinerary/expenses/splits worse than relational, and the
   type contract is weaker. Rejected.

## Consequences

- One TS codebase serves both platforms; Android is a verification pass, not a
  rewrite.
- Types flow DB → API → client through `@gogo/shared`; contract drift becomes a
  compile error.
- Heavier iteration loop than a PWA (dev builds, simulators) — mitigated by
  XcodeBuildMCP simulator tooling in-session and Expo Go for JS-only iteration.
- Known stack traps inherited from the-bach are pre-documented in the engineer
  personas (Neon HTTP driver has NO transactions; Drizzle `[row]` destructure
  is `undefined` at runtime on no-match; `crypto.randomUUID` needs a RN
  polyfill; long lists must virtualize; EAS `projectId` required for push).
- App-store distribution requires the Apple developer account when we get there.

## Links

- `docs/PLANNING.md § Architecture` — the living component map
- `.agents/agents/{mobile,backend}-engineer.md` — persona charters + landmines
- the-bach `docs/decisions/` — upstream evidence for monorepo/contract patterns
