# GoGo Travel — Work Queue

> Live **index**: ≤20,480 bytes, every line ≤400 bytes (CI `check-doc-budgets`, [ADR-009](decisions/ADR-009-plan-doc-byte-budgets.md)).
> One row per live item, no narrative. Order is **derived**: highest-priority `queued` row whose `depends_on` are all `done`. IDs never renumber.
> Status enum ([ADR-002](decisions/ADR-002-status-enum-lock.md)): `queued · in-progress · blocked · done · deferred · cancelled`.
> **Detail is read by ID, never whole files:** `grep -nE '^\| B-30 +\|' docs/QUEUE.md docs/history/QUEUE-*.md` · ID-less rows: `grep -nF '<handle>' docs/QUEUE.md docs/history/QUEUE-*.md`.
> **Dependency not in the live index?** Its `done` row was rotated out: `grep -nE '^\| <ID> +\|' docs/history/QUEUE-*.md`. A `done`/`cancelled` archive row means the dependency is met.
> Not prettier-formatted on purpose (`.prettierignore`): table padding re-inflates this file 5×.

## Active

| ID | Title | Status | Priority | Depends on |
| --- | --- | --- | --- | --- |
| — | **Claude-config program 2026-10** — agents/skills discovery migration (chore/agents-skills-migration), plan-doc byte budgets, STATE injection + read-by-ID, loop OS sandbox (B-29) | in-progress | P1 | — |
| T-7.10 | Schedule endpoint gains optional target status (P-7 extension, itinerary evolution batch, feature ④ API half) | queued | P1 | — |
| T-7.11 | Overnight flight Departs/Arrives list rows (P-7 extension, feature ①) | queued | P1 | — |
| T-7.12 | Calendar timezone switcher component (P-7 extension, feature ②) | queued | P1 | — |
| T-7.13 | Calendar view density mechanism: Day/3-day/Trip-span (P-7 extension, feature ③) | queued | P1 | — |
| T-7.14 | Month view (P-7 extension, feature ③ cont'd) | queued | P1 | — |
| T-7.15 | Ideas bucket Planned/Booked rework (P-7 extension, feature ④ client half) | queued | P1 | — |
| T-7.16 | Itinerary screen header wiring (P-7 extension, features ②+③ integration) | queued | P1 | — |
| B-29 | secrets-read gap: env deny rules miss unnamed reads, scripts, Grep tool; fix = loop OS sandbox (detail: docs/SECURITY.md B-29) | queued | P2 | — |
| — | **E2E gate evidence is not durably auditable (P2)** | queued | P2 | — |
| — | **Strip the dev diagnostics panel from Release bytecode (PR #61, P3)** | queued | P3 | — |
| — | **`sign-in-cancel-surface` env dependency + flake watch (PR #61, P3)** | queued | P3 | — |
| — | **`.prettierignore`'s `apps/server/reference-data/*.json` glob is directory-wide (PR #64, P4)** | queued | P4 | — |
| — | **Shared scratchpad filename collisions (2026-09-07 session, P4)** | queued | P4 | — |
| — | **`.claude/agent-memory/` is untracked and not gitignored (P3, Sean's call)** | in-progress | P3 | — |
| — | **B-19 adjacent-affordance window (PR #60 residual, P3)**: a second affordance tapped inside a DS Sheet's exit window | queued | P3 | — |
| — | **Grandfathered-booking dead end (PR #59 B-8 revert, P2 — user-visible)**: inverted-instant bookings cannot be unscheduled | queued | P2 | — |
| — | **Stale 12h-grace prose in the shared testing pack (PR #59 conventions defer, P3)** | queued | P3 | — |
| — | **Expense-list polish deferrals (PR #57 R1, P3)** | queued | P3 | — |
| — | **Android pre-launch verification pass (seeded 2026-09-07 — riders accumulate here)** | queued | P2 | pre-launch |
| — | **FX cache-miss single-flight coalescing** (PR #32 perf defer, P3) | queued | P3 | — |
| — | **Jest worker force-exit warning — localize the stray handle (B-22 ③ spun out, P3)** | queued | P3 | — |
| — | **Migrate the 12 remaining real-sleep `settle()` consumers** to `settleFake` (booking, map, money, place-detail) | queued | P3 | — |
| — | **Itinerary a11y follow-ups (PR #53 single-pass review, 6 verified advisories, P3 batch)** | queued | P3 | — |
| — | **Export wire-cap constants from @gogo/shared and import at client call sites** (PR #51 defer) | queued | P3 | — |
| — | **Sean QA feature batch 2026-09-06 (spec-pass needed — four itinerary-display/flow features)**: features ①–④ map to T-7.10..T-7.16 | in-progress | P1 | Sean sign-off (PR #71) |
| S-3 | testing overhaul (Sean-mandated 2026-08-30): T-S3.1..T-S3.5 merged; PR #38 (ADR-006 + spec) was held for Sean's read | in-progress | P1 | — |
| — | **B-5 follow-ups (PR #39 R1 defers + verifier residual)** | queued | P2 | — |
| P-9 | Phase: money — budgets, expenses, splits, settle-up (SENSITIVE PATH, Law #2): T-9.1..T-9.7 merged; spec-pass + F-063..F-074 device QA remain | in-progress | P0 | P-7 ✅ |
| — | **FetchLike body-cap streaming follow-up (PR #32 R1 security advisory, accepted class)** | queued | P3 | — |
| — | **Repo-wide lock-cycle class (pre-existing, surfaced by PR #30 R1 security+correctness)** | queued | P2 | — |
| P-8 | Phase: maps, saved places, offline tile packs — CODE-COMPLETE 2026-08-23 (T-8.1..T-8.7); phase QA blocked on pk token + QA unpark | in-progress | P0 | P-7 |
| — | **P-8 phase QA (ledger F-055..F-062 flips)** — pk-token-gated; runs once Sean supplies the token and unparks QA | blocked | P1 | Sean (pk token + QA unpark) |
| — | **Deliberate-camera-writer fit-sweep (PR #26 judge-committed)** | queued | P3 | — |
| — | **Search keystroke pin-strobe + typeahead debounce (PR #26 perf advisory; same future PR)** | queued | P3 | — |
| — | **Post-merge comment hygiene (PR #27 verifier find)** | queued | P4 | — |
| — | **Remote pack deletion gap (PR #27 interp 5, security-affirmed no-Law-#3)** | queued | P4 | — |
| — | **Typeahead time-debounce across ALL FOUR call sites at once (PR #24 perf defer)** | queued | P3 | — |
| P-7 | Phase: itinerary & bookings — CODE-COMPLETE 2026-08-10 (T-7.1..T-7.9, PRs #11–#19); phase QA + F-043..F-054 flips pending | in-progress | P0 | P-6 |
| — | **P-6 phase QA (ledger F-030..F-042 flips)**: parked by Sean 2026-08-16 | blocked | P1 | Sean (QA parked 2026-08-16) |
| — | **Fast-refresh MapView native crash (dev-workflow, 2026-08-15)** | queued | P3 | — |
| — | **P-13 push-transport obligations (from T-6.3 review)** | queued | P1 | P-13 |
| — | Exactly-once `trip.status_changed` tightening (T-6.3 advisory): boundary-day readers emit duplicates (self-healing) | queued | P3 | — |
| — | **datetimepicker 9.1.0 native module (T-6.7)** | queued | P1 | — |
| — | **CI: add `pnpm format:check` to the blocking gate** (round-2 Q2-300, RULED 2026-09-19) | queued | P3 | — |
| — | **Payment-handle client cap — enforce 30 chars AFTER `@`/`$` stripping** (round-2 Q2-293, RULED 2026-09-19) | queued | P3 | — |
| — | **§2.7 testID spec-sync batch (doc-freeze lift at P-6 close)** | queued | P2 | P-6 |
| — | **ThemeKeySchema union tightening (T-6.9 R1 security find)** | queued | P2 | — |
| — | **T-6.6 round-2 defer (correctness):** stalled 401-refresh settles into auth-lost (captive-portal stall forces local sign-out) | queued | P2 | — |
| — | **T-6.5 round-1 defer (security):** destination-tier ingest exempt from the search-miss budget; trip create/PATCH has no per-user rate limit | queued | P2 | — |
| — | **PL-3 follow-ups:** GiST trgm KNN if global text search becomes a requirement; revisit the 4-char floor for the locality tier | queued | P2 | P-8 |
| — | **FSQ-OS distribution watch (potential escalation #3 at live wiring)** | queued | P2 | P-14 |
| — | Deferred from T-5.8 (P-6 push): onboarding notification-priming step needs EAS `projectId` + push-token flow; v1 ships without it | queued | P2 | P-6 |
| — | **FULLY RESOLVED across T-6.1 + T-6.2 (5694f83)** — sole-owner-ghost, invite-accept TOCTOU, deletion-guard fence (T-5.6 defer) | queued | P1 | P-6 |
| — | Deferred from T-5.6 (P-11 capture / utilities documents): account-deletion scrub must purge capture_senders / capture_inbox / documents | queued | P1 | P-11 |
| — | **P-10 blocker (T-5.4 defer):** AI-usage increment must be atomic (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) | queued | P0 | P-10 |
| — | ai_usage `(user_id, day)` composite index — requireAiQuota daily-count query scans all features×days; add when ai_usage ages | queued | P3 | P-10 |
| — | Trusted-proxy `ipOf` decision at deploy — rate-limit IP key = socket peer; behind a proxy/LB all clients share one bucket | queued | P2 | P-14 |
| — | **Deploy-posture: `NODE_ENV` fail-open default (PR #37 R1 security + correctness advisories)** | queued | P2 | P-14 |
| — | Housekeeping-job wire-up (scheduler for auth + push-token + capture-sender prunes) incl. refresh_tokens sweep index | queued | P2 | P-5 |
| — | T-6.1 round-1 defer (money domain): base-currency TOCTOU — R-trips-22 lock check + budgets-sync read the pre-UPDATE snapshot | queued | P2 | P-9 |
| — | 400-vs-404 divergence on malformed ids: users' `:userId` returns 400 while trips' `:tripId` folds into 404 | queued | P3 | — |
| — | **T-7.2 R1 perf/refactor defers (next server touch or if symptoms surface)** | queued | P3 | — |
| — | Drizzle drift-check gate step (schema.ts ↔ migrations parity tripwire — Law #6 currently has no automated guard) | queued | P2 | — |
| — | **members-screen VirtualizedList act-warning (pre-existing, PR #14 R2 find)** | queued | P2 | — |
| — | **P-7 doc follow-ups (PR #14 conventions lane — batch, post-merge)** | queued | P2 | — |
| — | **travel-leg provider brownout mitigation** (T-7.3 perf defer, optional; deliberately not implemented) | queued | P3 | — |
| — | **T-7.4 test-coverage follow-ups (PR #15 tests R1 advisories)** | queued | P3 | — |
| — | **travel-leg perf advisory (T-7.4 perf R1 on #15)** | queued | P3 | — |
| — | **T-7.6 residual coverage gaps (PR #17, deferred by triage — next mobile touch)** | queued | P3 | — |
| — | **T-7.5 deferrals (PR #18, recorded at merge — next mobile/infra touch)** | queued | P3 | — |
| — | **T-7.9 round-1 defer (correctness, PR #19)** | queued | P3 | — |
| — | **Review-record NUL contamination (judge find, PR #18)** | queued | P3 | — |
| — | **Reference-search E2E coverage (P1, Sean’s explicit ask, 2026-09-11)** | queued | P1 | S-4 |
| — | **Trip-list switcher uses `ScrollView` + `.map()` over up to 100 rows (P3)** | queued | P3 | — |
| — | **`money-screen.test.tsx` in-flight PUT pin is flaky (P3)** | queued | P3 | — |
| — | **`.specs/client/navigation.spec.md` R-nav-23 / §2.1 spec-sync (P2)** | in-progress | P2 | — |
| — | **Fresh-worktree `FULL TURBO` false cache hit** | queued | P3 | — |
| — | **Same-name destination-tier rows indistinguishable in the picker** | blocked | P3 | pending #75 round 1 |
| — | **Fuzzy cross-source dedup could skip a real POI near a locality anchor** | queued | P3 | — |
| — | **`makeTestQueryClient` (gcTime 0, staleTime 0) cannot see stale-cache bugs** | queued | P3 | — |
| — | **VS Code indexes `.claude/worktrees/`:** Sean's user settings exclude it; a repo `.vscode/settings.json` is a candidate rider | queued | P3 | — |
| — | **B-28 follow-ups (PR #74, P3):** DB-ahead-of-branch refuse message, same-`when` journal collision, unbounded boot query | queued | P3 | — |
| — | **PG-teardown follow-ups (PR #78, P3):** pin `dropAdmin.end()` seconds + `statement_timeout`; nullish-rejection guard on `drop()` | queued | P3 | — |
| — | **`apps/server/scripts/*` top-level-I/O landmine (found via PR #75's fix-verifier catch, P3)** | queued | P3 | — |
| — | **B-26 residuals (PR #67, P3):** `GridSurface.test.tsx` act-warning flake; landscape-small keyboard tail accepted | queued | P3 | — |
| — | **S-4 mobile-door residual: overlapping-opens flake (PR #77, P3)** | queued | P3 | — |
| — | **B-7/#80 deferred follow-ups (P3):** §2.7 testID registry, M-A2 partial pins, dead `isUsableDestination` export, PATCH 400-vs-403 | queued | P3 | — |
| — | **`trips.destination_place_id` — parked (Sean: not now, from #80/#81 review)** | deferred | P3 | — |
| — | **B-7/#75 spec gaps (P3):** destination picker cannot disambiguate same-named localities; Vatican City absent from the tier | queued | P3 | — |
| B-31 | booking form fields/Save unreachable behind the keyboard (PR #83 E2E finding); not reproduced on device, re-scoped to the E2E lane | queued | P3 | — |
| B-30 | server/client trip-status day-boundary UTC vs. local mismatch; RULED 2026-09-19: destination timezone, both sides; blocks `cross-tab-state` | queued | P1 | Sean (ruling) |
| — | **Sub-floor exact-match arm drops `trip_id` scope (P2, PR #84, Sean ruling)** | queued | P2 | Sean (ruling) |
| T-7.17 | timezone-aware itinerary/calendar UX enhancement (Sean UX-story ruling 2026-09-19; feature, not bug); folds into PR #71's tz-switcher spec | queued | P2 | PR #71 |
| — | **B-7/#84 deferred follow-ups (P3):** couple the two search floors with an equality pin; EXPLAIN pins; stale comments | queued | P3 | — |
| — | **E2E `wip` tag has no guard rail (P3):** nothing forces a `wip` Maestro flow to cite a filed bug or be re-run | queued | P3 | — |
| — | **PR #85 hardening follow-ups (Sean, `chore/claude-permissions-hardening`, P1, blocking)**: 4 blocking permission bypasses | blocked | P1 | Sean (his PR) |
| — | **Write the round-2 rulings back into the specs (Q2-001..Q2-300, `.specs/OPEN-QUESTIONS.md` round 2)** | queued | P2 | — |
| — | **Shared-schema booking ordering pre-check (R-shared-7)**: deferred half of B-8's SECONDARY; B-26 shipped the field-mapping half | queued | P3 | — |
| — | **Swap the `links.gogotravel.example` placeholder for the real domain**: `LINK_DOMAIN` + `app.json` `associatedDomains` (domain owned; P-14 swap) | queued | P3 | — |
| — | **T-3.2 shared-schema advisories**: reject dot-only paypalme handles; trim-normalize `external_url` (carried from the closed T-3.2 row) | queued | P3 | — |
| — | **Rental one-way zones**: no zone fields (both ends `Z`), so a cross-zone one-way skews the instant; rejected only if dropoff wall time < pickup (B-9) | queued | P3 | — |

## Blocked

| ID | Title | Status | Priority | Blocker |
| --- | --- | --- | --- | --- |
| — | **Object-storage provider pick (avatars now, trip photos P-12)** | blocked | P2 | Sean (deferred) |
| — | **⚠️ `main` has NO branch protection and NO rulesets (security lane, PR #18)** | blocked | P2 | Sean (repo settings) |
| B-1 | F-001 ledger step 2 unsatisfiable as written (PG numeric→bigint cast rounds); Q2-296: direction approved, ADR-008 shape + Law #8 wording await Sean | blocked | P2 | Sean: ADR-008/Law 8 |
| — | DisplayName bidi/zero-width (\p{Cf}) hardening — security-lane suggestion beyond R-user-2; blanket rejection breaks emoji-ZWJ names | blocked | P3 | Sean decision |

## Recently done

| ID | Title | Done |
| --- | --- | --- |
| B-26 | MERGED (PR #67) — booking-form UX: scrollable zone picker, required markers from shared Zod, save errors mapped to fields | 2026-09-13 |
| B-7 | CLOSED (PRs #75, #73, #80/#81) — places cold-start deadlock fixed end to end; device-confirmed 2026-09-19 | 2026-09-14 |
| B-28 | MERGED (PR #74) — migration-state check: refuses in development on pending migrations, warns elsewhere | 2026-09-14 |
| — | **MERGED (PR #78) 2026-09-13 — shared-PG-container teardown timeout fixed.** | 2026-09-13 |
| — | **MERGED (PR #79 `b6b6a39` + PR #77 `4025dc1`) 2026-09-14 — S-4 T3+T4: server + mobile session door.** | 2026-09-14 |
