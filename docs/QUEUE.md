# GoGo Travel — Work Queue

> Live work pulse. Order is **derived**: highest-priority `queued` item whose
> `depends_on` are all `done`. IDs are stable — never renumber.
> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)):
> `queued · in-progress · blocked · done · deferred · cancelled`

## Active

| ID | Title | Status | Priority | Depends on |
|----|-------|--------|----------|------------|
| P-2 | Phase: upfront spec suite (architecture/data model → per-feature specs → feature ledger → frozen roadmap; Sean gates between each) | in-progress | P0 | — |

## Blocked

| ID | Title | Status | Priority | Blocker |
|----|-------|--------|----------|---------|
| T-1.3 | Push workflow foundation to origin | blocked | P0 | `gh auth login` needed (Sean) — 2 commits waiting on `main` |

## Recently done

| ID | Title | Done |
|----|-------|------|
| S-2 | Product + integration research — 5 reports banked in `.specs/research/` | 2026-07-09 |
| T-1.1 | Port workflow machinery from sibling repos | 2026-07-09 (70c0065) |
| T-1.2 | Author CLAUDE.md + planning docs + ADRs 1–3 | 2026-07-09 (70c0065) |
| S-1 | Stack decision → [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md) (Expo/RN + Hono/Drizzle/Postgres, iOS-first) | 2026-07-09 |
| T-1.4 | Pin stack-specifics (CI gate cmd, engineer personas; path rules land with P-3 scaffold) | 2026-07-09 |
