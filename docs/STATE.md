# GoGo Travel — Active State

> Session brief: read whole at session start (hook-injected where hooks run; loop sessions read it
> explicitly). **Hard cap 6,144 bytes** (CI `check-doc-budgets`,
> [ADR-009](decisions/ADR-009-plan-doc-byte-budgets.md)). Replace, don't append. Narrative, session
> logs, resolved decisions → `docs/history/STATE-<date>.md`. Locked → ADR. Work items → `docs/QUEUE.md`.

## CURRENT DIRECTION

**Operating model:** high-autonomy Claude builds from upfront specs; Sean is planner/spec-maker/QA.
Human-in-the-loop ONLY at the escalation triggers in `CLAUDE.md § Autonomy Contract`. Reviews are
**local in-session** ([ADR-003](decisions/ADR-003-local-in-session-reviews.md)).

**Focus:** itinerary-evolution build (P-7 extension) after device QA 2026-09-19 passed (P-7 ledger
F-043..F-054 all true). P-5/P-6/P-8/P-9 (F-063..F-074) device QA still owed by Sean.

## NEXT SESSION

As of 2026-10-07 (origin/main c261b94; local `main` lags). Re-check:
`git fetch origin && git log --merges --oneline --since=2026-09-20 origin/main` +
`gh pr list --state open`. Session `gogo-tz` (Wave 1/2) re-syncs this after PR-B lands.

**Wave 1:** merged: sub-floor scope (#97), spec write-back Q2-001..Q2-300 (#93-#96). Open: B-30
destination-tz (#99, P1, un-wips `cross-tab-state`), R-map-18/Q2-186 (#98); Q2-185 awaits Sean's pick.
**Wave 2:** itinerary batch T-7.10..T-7.16 per PLANNING's P-7 extension block +
`.specs/client/itinerary.spec.md` R-itin-33..41; T-7.17 amends the tz-switcher spec at build time.
T-7.10 merged (#100), T-7.11 open (#101); rest per the block's dependency order.
**Wave 3:** B-31 (E2E-lane keyboard reachability) + the 4 `wip` Maestro flows, #84/#80/#78/B-28
follow-up rows, the wip-guard row, `apps/server/scripts` top-level I/O.
ID-less rows by handle: `grep -nF 'Sub-floor exact-match arm' docs/QUEUE.md`. Detail: archive,
`2026-09-20 close-out`.

## In-flight decisions

- **T-7.17 tz-switcher (ruled 2026-09-19, spec amend pending):** auto-switch on item focus +
  per-location day views; supersedes the 2026-09-13 "display-only, no math" reading. Amend #71's
  tz-switcher spec at build time (detail: QUEUE T-7.17; archive `Timezone-switcher UX`).
- **ODbL (ruled 2026-09-07, open until ship):** README attribution is in; add an open-source-licenses
  screen entry at ship. Never bundle the airport+tz dataset into the app binary without revisiting
  share-alike (detail: QUEUE B-9; archive `SEAN DECISION PACK`).

## Blockers / Waiting on Sean

- **PR #85 hardening follow-ups** (his own; PR merged a839de7): a courtesy security lane found 4
  blocking permission bypasses; QUEUE row `blocked`, P1.
- **Device QA still owed:** ledger flips outside P-7: P-9 F-063..F-074, P-8 F-055..F-062, P-6
  F-030..F-042, P-5 F-018..F-029, plus other Sean-gated QUEUE rows.
- **Mapbox:** pk token landed 2026-08-29, no longer a blocker. P-8 phase QA (incl. live
  travel-leg QA) is device-gated on Sean (QUEUE `P-8 phase QA`).
- **P-6 phase QA:** Claude-runnable sim checklist (`PHASE-006` § A.1) + Sean's device pass; flips
  F-030..F-042.
- **P-14:** domain `gogotravel.app` bought 2026-08-29; `LINK_DOMAIN` swap off the placeholder, Apple
  portal setup and the send-the-bill https links (gogo:// until then) are still to do.

## Landmines

- Merge: check MERGEABLE/CLEAN first; never pipe `gh pr merge`; delete the branch in a separate step
  gated on MERGED (PR #79).
- Fresh worktrees report false `FULL TURBO`: quote `--force` numbers only.
- Worktree agents can't write the main repo's `.tmp/`; never `git checkout`/`pull` in the main tree
  (Sean's live branch): `git fetch origin main:main`.
- A subagent waiting on a background notice for a native (XcodeBuildMCP) build never resumes: poll in
  the foreground.
- `expo run:ios` skips prebuild if `apps/mobile/ios/` exists: config/bundle-id changes need
  `expo prebuild`.
- Tests must not import scripts with top-level I/O (hit live S3, rewrote committed JSON); 4
  `apps/server/scripts/*` still do.
- Prettier rewrites line-initial `-`/`+`/`*`/`>` in raw-read prose (PR #64 corrupted a Law 2 line and
  ADR-004): use backticks.
- Green CI/connection is not a migrated dev DB (B-28 `/health` + `gogo://diagnostics` show drift).
- Device network failure: log the resolved API base URL ON the device first; Mac curl proves nothing.
- Grandfathered bookings with inverted instants can't be unscheduled (400); a details PATCH heals;
  permanent (Autonomy #5).
- Ledger: quote exact criteria, never paraphrase.
- Detail + env-rig facts (8-var auth all-or-nothing, PEM armor):
  `grep -n 'landmine\|do not re-derive' docs/history/STATE-2026-10-07.md`.

## Archives

Latest: `docs/history/STATE-2026-10-07.md`. Grep, never read whole:
`grep -n '<ID or phrase>' docs/history/STATE-*.md`. QUEUE detail:
`grep -nE '^\| <ID> +\|' docs/QUEUE.md docs/history/QUEUE-*.md`. Rules + phase archives:
`docs/history/README.md`.
