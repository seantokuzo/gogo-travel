# PHASE-003 — Foundations (P-3)

> Closed 2026-07-16. Append-only archive.

## What shipped

Monorepo scaffold → shared contracts → DB schema → CI gate. Four tasks, four
merges, every one through the full 5-lane review + impartial judge loop:

| Task                                                                       | Merge   | Review outcome                                                                          |
| -------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| T-3.1 scaffold (pnpm+turbo, Expo SDK 57, Hono skeleton, path rules, hooks) | 74d6c61 | fix-then-ship 2/9 → merge/high                                                          |
| T-3.2 @gogo/shared (16 domains, 259 tests, money math, AI schemas)         | 7a1de80 | fix-then-ship 2/12 → judge red-teamed 46 probes, 0 bypasses → merge/high                |
| T-3.3 DB schema (30 tables, migration 0000, 47 constraint tests live)      | 22c7496 | fix-then-ship 1/12 → merge/high                                                         |
| T-3.4 CI gate (verify/guard/ci-success, root lint, ci.md)                  | 64b2131 | ship 0/12 → judge caught a fix-round regression (Node-24 dir-form) → round-2 merge/high |

## Ledger

F-002..F-009 flipped `passes: true` with executed evidence (constraint suite
on live postgres:17, 259 shared tests, gate runs). **F-001 remains false**:
its step 2 ("fractional INSERT rejected by type") is unsatisfiable as
written — probed 2026-07-16: PG assignment cast ROUNDS numeric 25.5→26 into
bigint (string '25.5' does reject). Real fractional-money protection is the
app-boundary `CentsSchema z.int()` (F-007 ✓) + negative-cents CHECKs (F-004 ✓).
Ledger is append-only → amendment protocol needs Sean's nod (queued B-1).

## Locked decisions (already ADR'd)

ADR-004 stack execution proven; ADR-005 entitlement seams landed in schema +
shared; ADR-003 review model exercised 4× end-to-end.

## What worked

- The deterministic aggregator refused a 3-lane "right-sized" review
  (degraded=true) — the 5-lane contract is machine-enforced; honor it.
- Judges that re-verify firsthand caught a real regression INTRODUCED BY a
  fix round (T-3.4 dir-form `node --test` fails on Node 24 / unpinned runner).
- Law #7 simulations: turbo-cache false-green probe (T-3.1), Docker-down
  hard-fail observed live (T-3.4), 533 sha256 vectors + 6,500 money probes
  (T-3.2).
- Inline orchestrator build (T-3.4) when agent spawns were 529-dead — the
  loop survives API weather.

## Surprises / gotchas (STATE carries the live ones)

- Shared worktree: orchestrator commits landed on an agent's branch →
  CLAUDE.md git-freeze rule (2026-07-10).
- turbo: globalDependencies needed for root configs; strict-env CI var relies
  on an undeclared allowlist → globalPassThroughEnv ["CI"] pinned.
- pnpm 11 cooldown gate (minimumReleaseAge) is on by default; exclusions must
  carry rationale.
- gh auth: "already logged in" keeps stale tokens; workflow-file pushes need
  the `workflow` scope.
- PG assignment cast rounds numeric→bigint (see Ledger).

## Follow-ups

- B-1: F-001 verification-step correction (ledger amendment protocol — Sean).
- First GitHub Actions run pending Sean's `gh auth refresh -s workflow` +
  push (validates runner behavior; local pipeline-equivalent green).
- jest-expo + first render test → P-4 (T-3.1 defer).
- SHA-pinning actions (vs @v4 majors) — deliberate future proposal (security
  lane, T-3.4).
- Branch protection requiring `CI Success` once repo settings are touched.
