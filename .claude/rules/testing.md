---
paths: ["**/*.test.*", "**/__tests__/**", ".maestro/**", ".specs/testing/**"]
---

# Testing standard — the bar a test clears to count

Strategy and the four layers above unit tests: [ADR-006](../../docs/decisions/ADR-006-testing-strategy-overhaul.md)
and `.specs/testing/testing-overhaul.spec.md`. This file is the BAR, not the plan.
Sean, 2026-09-12: _"we should be doing TDD ... catching all scenarios - not just
happy paths"_ / _"we are missing things ... that should be caught before I even
have to device QA."_ Five burns below say he is right.

## 1. Test-first, or same commit — never "after"

Write the failing test before the fix when the shape is known; at worst, in the
same edit as the code. A test written after the code is written to pass it. New
logic with no test in the same commit is an incomplete task, not a fast one.

## 2. Cover the matrix, not the happy path

Every new behavior gets: happy · error (the real error object, not a stub) ·
empty/zero-row · offline / request-in-flight · boundary (first, last, past the
cap) · adversarial (hostile input, wrong tz, wrong currency, a list longer than
the screen). 🔴 **A list needs a "can the user reach item N" pin** — PR #67
shipped a zone picker rendering at most 12 of 418 zones with NO scroll container;
406 zones were unreachable and every test was green.

## 3. Mutation-verify, or it does not count

Break the thing the test guards; watch it go RED; restore. State the falsification
in the test ("what change makes this red"). 🔴 PR #60: a "load-bearing" pin was
TOOTHLESS — a naive implementation that still froze the app on device kept ALL
EIGHT original pins green. Only a file-local iOS-faithful `jest.mock` of RN's
`Modal` discriminated. See the vacuous-pin taxonomy in `.claude/rules/mobile.md`
(disabled elements, already-settled promises, `git add -N` before diff probes,
release deferred promises in `finally`) — that taxonomy is the repo-wide bar.

**A probe that finds nothing has not proven absence** until you have proven the
probe can find the thing. PR #61 read an ASCII `strings` miss as proof a string
was absent, three times; Hermes had stored it UTF-16 (mechanism: `mobile.md`).

## 4. Run against something prod-shaped

A green mock proves nothing about the device. Hermes ≠ Node (Intl, `formatToParts`,
string encoding). `postgres-js` ≠ Neon WebSocket Pool (`.claude/rules/ci.md`
prod-parity landmine). A hand-rolled mock of a native module is fiction until a
contract suite pins it against the real library's shape (ADR-006 § Decision).

## 5. The layers unit tests structurally cannot reach

- 🔴 **Environment and migration state.** 2026-09-11: every airport/airline search
  500'd on device because Sean's dev DB was two migrations behind. Server booted
  clean, client fired correctly, ~3000 unit tests and CI all green, nothing
  anywhere asserted the DB was at head. Assert the environment, not just the code.
- 🔴 **Authenticated end-to-end paths.** All four default `.maestro/` flows are
  unauthenticated, so they never execute the booking form, timezone composition,
  or anything behind sign-in — which is where every one of Sean's device findings
  has lived. Behind-sign-in behavior is not covered until a flow signs in
  (S-4 wave 2).
