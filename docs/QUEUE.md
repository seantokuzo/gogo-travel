# GoGo Travel — Work Queue

> Live work pulse. Order is **derived**: highest-priority `queued` item whose
> `depends_on` are all `done`. IDs are stable — never renumber.
> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)):
> `queued · in-progress · blocked · done · deferred · cancelled`

## Active

| ID | Title | Status | Priority | Depends on |
|----|-------|--------|----------|------------|
| T-1.1 | Port workflow machinery from sibling repos | in-progress | P0 | — |
| T-1.2 | Author CLAUDE.md + planning docs + ADR-003 | in-progress | P0 | — |
| S-1 | Spike: stack decision (PWA vs Expo/RN vs hybrid) → ADR-004 | in-progress | P0 | — |

## Up next

| ID | Title | Status | Priority | Depends on |
|----|-------|--------|----------|------------|
| T-1.3 | Initial commit + push workflow foundation to origin | queued | P0 | T-1.1, T-1.2 |
| T-1.4 | Pin stack-specific bits (CI gate command, engineer personas, path rules, formatter hook) | queued | P0 | S-1 |
| S-2 | Spike: product + integration research (competitors, deeplinks, maps, payments) | queued | P0 | — |
| P-2 | Phase: upfront spec suite (requirements/design/tasks per feature + feature ledger) | queued | P0 | S-1, S-2 |

## Blocked

_(none)_

## Recently done

_(nothing merged yet)_
