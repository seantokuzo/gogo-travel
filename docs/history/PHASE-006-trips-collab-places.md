# PHASE-006: Trips, Collaboration & Places Spine

**Status:** Code-complete (phase QA pending — sim/device checklist lives in STATE until ledger flips)
**Started:** 2026-07-25
**Completed:** 2026-07-31 (code-complete; 9/9 tasks merged)
**PRs:** #2–#10 (every judge verdict merge/high)

## What shipped

The app's spine. Users can now: create/edit/archive/delete trips (owner-gated
fields, `expect_updated_at` optimistic concurrency, status reconciliation with
owner override); invite collaborators via multi-use `gogo://` links (256-bit
tokens, rate-limited, preview envelope); manage members (roles, removal, leave,
ownership transfer under an ordered two-row lock fence); search places (text
trgm / geo sargable / blend on a deterministic keyset codec) backed by the
open-data ingest spine (Overture + FSQ-OS GeoParquet via DuckDB, $0/no-key,
fixture-driven); and drive it all from the client — trip list w/ keyset
pagination, create modal w/ native range picker + destination typeahead,
invite-join accept flow, members screen w/ optimistic mutation quartet,
settings (details/theme/currency/leave/delete + stale-409 conflict UX), entry
redirect + membership guard (client half of the 404-indistinguishable IDOR
posture), deep-link registry, and the CT-6 collab invalidation layer
(exhaustive 10-event plan). Push-invalidation emitter seam is live server-side
(dormant transport until P-13).

## Tasks completed

- T-6.1 — Trip CRUD router + `expect_updated_at` + status reconciliation — PR #2 (f11f686)
- T-6.2 — Members + invites + transfer + TOCTOU closures — PR #4 (5694f83)
- T-6.3 — Push-invalidation emitter seam (10-event catalog) — PR #5 (0cc55d1)
- T-6.4 — Places ingest spine (DuckDB GeoParquet, region grid) — PR #3 (e5a2c97)
- T-6.5 — Places search + custom places + scale caps — PR #6 (3f6a8ce)
- T-6.6 — Entry redirect + [tripId] guard + deep-links (NAV-3/4/5) — PR #7 (e180d0f)
- T-6.7 — Trip list + create modal (CT-1/CT-2) — PR #9 (dd5304a)
- T-6.8 — Invite-join + members screens (CT-3/CT-4) — PR #8 (04b00a8)
- T-6.9 — Trip settings + collab client layer (CT-5/CT-6) — PR #10 (322807a)

Final suite counts: server 515, shared 378, mobile 517 (72 suites).

## Decisions locked (promoted to ADRs)

None promoted — phase ran entirely inside ADR-001..004. Notable
judge-validated mechanizations recorded in QUEUE/STATE instead: solely-owned
trips cascade on account deletion (spec-amendment note pending), global lock
order users → trip_members → invites, KEY-CACHE LAW (`["trip-list"]` disjoint
root vs `["trips", ...]` detail subtree).

## What worked

- **Wave discipline** (server spine → nav shell → client screens) with
  parallel lanes only where files were disjoint; mid-flight merges survived
  twice (T-6.4 into T-6.2, T-6.8 retrofit during T-6.7).
- **Seam-first dispatch:** T-6.3's dormant emitter and T-6.4's
  `enqueueSearchMiss` let consumers build against frozen contracts before the
  machinery existed — zero cross-wave file contention.
- **Falsification probes as the review standard:** R2/R3 lanes re-ran
  mutate→red / restore→green on every claimed fix; twice this rejected a
  builder's "unreachable" amendment with an empirical counter-test (T-6.9
  Sheet exit window).
- **Fixture-driven $0 ingest** dodged the FSQ-OS distribution shift entirely.

## What didn't / surprises

- **TanStack v5 drops per-call mutate callbacks for superseded calls** — found
  in T-6.8, _reintroduced by the same phase in T-6.9's updateTrip_. Class fix:
  hook-level `onMutationError`/`onMutationSuccess` seams on shared mutation
  instances. The bug class recurred within the phase that discovered it.
- **EPQ re-evaluation lands unguarded writes** on promoted row versions after
  a lock wait — write predicates on role-bearing rows must pin the role.
- **ON DELETE CASCADE lock order = FK-trigger creation order**, not your
  explicit order — trip-delete deadlocked until fenced with an ordered
  `FOR UPDATE` SELECT.
- **timestamptz µs-vs-wire-ms** 409'd every fresh row until
  `date_trunc('milliseconds')` parity landed on both drivers.
- **DS Sheet is hit-testable through its ~200ms exit animation** — a real
  two-in-flight mutation path, not a theoretical one (QUEUE row for the DS
  guard).
- Testcontainers file-parallelism kept wedging Docker (workaround
  `--no-file-parallelism`; real fix still queued P1).

## Open follow-ups

All carried as QUEUE rows: P-6 phase QA (sim checklist ① – ⑦, REBUILD dev
client first — datetimepicker native module); invites-list raw-token strip
server-side (riding first P-7 server touch); ThemeKeySchema union tightening;
DS Sheet exit-animation pointerEvents guard; §2.7 testID spec-sync batch;
destination-tier ingest rate cap; T-6.6 captive-portal refresh catch-all;
P-13 push-transport obligations incl. handleCollabEvent burst coalescing;
Sean spec-pass batch (leave placement, join-entry home, archive surface,
§2.5 behavior wording); ledger F-030..F-042 flips pend phase QA.

## Linked context

- STATE.md P-6 section rotated here 2026-07-31 (P-7 kickoff). Live landmine
  digest (TanStack callback seams, KEY-CACHE LAW, latch-consume invariant,
  Sheet exit window, `expect_updated_at` fresh-context read, EPQ role pins,
  lock order, liveness doors) **stays in STATE** — P-7+ client/server work
  hits the same classes.
- Specs: `.specs/api/trips.spec.md`, `.specs/api/places.spec.md`,
  `.specs/client/trips.spec.md`, `.specs/client/navigation.spec.md`.
- Full per-PR review narratives: QUEUE.md "Recently done" rows T-6.1..T-6.9
  (this archive is the summary; QUEUE rows are the detail).
