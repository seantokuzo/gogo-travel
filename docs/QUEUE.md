# GoGo Travel — Work Queue

> Live work pulse. Order is **derived**: highest-priority `queued` item whose
> `depends_on` are all `done`. IDs are stable — never renumber.
> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)):
> `queued · in-progress · blocked · done · deferred · cancelled`

## Active

| ID | Title | Status | Priority | Depends on |
|----|-------|--------|----------|------------|
| P-4 | Phase: design system + navigation skeleton (PLANNING § P-4) | in-progress | P0 | — |
| T-4.3 | Core component library + Gallery screen [DS-5..10]: Button/Card/Input/Badge/EmptyState/ErrorBanner/ConfirmDialog/TabNav/PageHeader/ListItem/Sheet/Skeleton/SegmentedControl/Text per tokens.spec §2.9 + dev Gallery (Law #7 visual evidence) | in-progress | P0 | — |

## Blocked

| ID | Title | Status | Priority | Blocker |
|----|-------|--------|----------|---------|
| B-1 | F-001 ledger step 2 unsatisfiable as written (PG assignment cast ROUNDS numeric→bigint; probed 2026-07-16) — needs Sean's nod on the append-only ledger amendment protocol | blocked | P2 | Sean decision |
| — | Push to origin re-blocked: workflow-file pushes need the `workflow` scope — Sean runs `gh auth refresh -h github.com -s workflow` | blocked | P0 | Sean (interactive auth) |

## Recently done

| ID | Title | Done |
|----|-------|------|
| T-4.2 | Theme runtime wired — first clean round-1 SHIP (0 blocking, 5 lanes); mobile jest harness live (10 tests incl. first-frame probe); judge merge/high | 2026-07-17 |
| T-4.1 | @gogo/tokens merged — 312 tests, 45/45 seeds mutation-proven, 3 dark-mode AA fixes caught by new pairing, derive script reproducible; judge merge/high | 2026-07-17 |
| P-3 | Foundations CLOSED — 4 tasks merged through full review loop; ledger F-002..F-009 flipped w/ evidence; archive: docs/history/PHASE-003-foundations.md | 2026-07-16 |
| T-3.4 | CI gate merged 64b2131 — ship 0/12 → judge caught fix-regression (Node-24 dir-form) → round-2 merge/high; Law #7 Docker-down hard-fail observed live | 2026-07-16 |
| T-3.3 | DB schema merged — 30 tables column-exact, migration 0000 + pg_trgm, 47 constraint tests on live postgres; Docker-skip cache trap fixed (CI hard-fail + turbo cache:false); judge merge/high, escalation ruled mechanical | 2026-07-14 |
| T-3.2 | @gogo/shared merged 7a1de80 — 259 tests; 2 security blockers fixed + judge-red-teamed (46 probes, 0 bypasses); judge merge/high, ultra-escalation ruled unnecessary. Follow-up advisories for consumer tasks: reject dot-only paypalme handles (AU-4), trim-normalize kept external_url (CAP tasks) | 2026-07-10 |
| T-3.1 | Monorepo scaffold — merged 74d6c61 after round-1 review (2 blocking fixed incl. empirically-probed turbo cache false-green; judge: merge/high). Defers: jest-expo+render test→P-4, root-config lint→T-3.4 | 2026-07-10 |
| P-2 | Upfront spec suite — Gates 1+2+3 ALL PASSED; all three palettes ship as user themes (default: goldenHour); exec mode: in-session phase-by-phase | 2026-07-10 |
| T-2.4 | feature-ledger.json (118 features, F-001..F-118) + frozen phase roadmap P-3..P-14 (PLANNING § Phase Detail) → Gate 3 packet ready | 2026-07-09 |
| T-2.3 | Spec bundles: auth/users/entitlements · trips/itinerary/bookings · capture · maps/places · money · AI · photos · notifications/today — all drafted, zero markers | 2026-07-09 |
| T-2.2 | Spec: design system tokens + navigation IA | 2026-07-09 |
| T-2.1 | Spec: DB schema + shared Zod contracts | 2026-07-09 |
| S-2 | Product + integration research — 5 reports banked in `.specs/research/` | 2026-07-09 |
| T-1.1 | Port workflow machinery from sibling repos | 2026-07-09 (70c0065) |
| T-1.2 | Author CLAUDE.md + planning docs + ADRs 1–3 | 2026-07-09 (70c0065) |
| S-1 | Stack decision → [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md) (Expo/RN + Hono/Drizzle/Postgres, iOS-first) | 2026-07-09 |
| T-1.4 | Pin stack-specifics (CI gate cmd, engineer personas; path rules land with P-3 scaffold) | 2026-07-09 |
