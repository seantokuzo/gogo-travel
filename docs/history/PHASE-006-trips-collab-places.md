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

---

## Appendix A — rotated out of `docs/STATE.md` on 2026-09-13

> Appended 2026-09-13 during a STATE rotation (STATE was 1102 lines against the
> ~800–1000 advisory cap). The body above is unchanged; everything below was
> living in `STATE.md § P-6` and is moved here so the section can be reduced to a
> pointer. Two things kept it out of the original archive: the phase-QA checklist
> is still un-run, and the landmine digest was deliberately parked in STATE for
> P-7+ to trip over. P-7/P-8/P-9 are all code-complete now, and the mobile half of
> the digest has since been codified in `.claude/rules/mobile.md`, so the digest's
> live duty is over. It is preserved verbatim-in-substance below.

### A.1 — PHASE-QA CHECKLIST (still un-run; ledger F-030..F-042 stays `passes:false`)

Live tracking row: `docs/QUEUE.md` "P-6 phase QA (ledger F-030..F-042 flips)",
status `blocked` on Sean. Rebuild precondition met 2026-08-15 (dev client rebuilt
on `main@293d0ef`, datetimepicker baked); the blocker since then is CREDENTIALS,
not the build — there is no signed-in path on the simulator. QA was PARKED by Sean
2026-08-16; the two unblock options (a) real OAuth/server env or (b) an approved
`__DEV__` session door stand recorded in the QUEUE row and in the P-8 PHASE-QA
attempt bullet. Run on sim before any ledger flip:

1. Two-account collab loop: create → invite (share sheet opens) → join via
   `gogo://` link → role change → transfer → remove (T-6.2 / T-6.8 / T-6.9).
2. Warm-start deep-link URL transport (the jest-untestable leg, T-6.6).
3. Offline cached-shell mount (source-verified only so far, T-6.6).
4. Native universal-link modals (T-6.6).
5. Trip create golden path with the native range picker + destination typeahead
   (T-6.7).
6. Settings: edit name / destination / dates / theme / currency; stale-409
   two-device conflict; leave (non-owner); delete (owner); owner-leave 409 copy
   (T-6.9).
7. Trip list: pagination past page 1; offline refocus retains rows with the banner
   (T-6.7).

B-2 note: press→settle act-stabilization is load-sensitive under
harsher-than-CI starvation. If act warnings resurface under host contention,
that is the class.

### A.2 — Live landmine digest (the classes P-7+ actually hit)

Client / query cache:

- **TanStack v5 drops per-call `mutate` callbacks for superseded calls.** NEVER
  hang per-call callbacks on a shared mutation instance; use the hook-level
  `onMutationError` / `onMutationSuccess` seam (`members.ts` and
  `trip-settings.ts` are the precedents) or pending-gate every affordance. This
  bit P-6 twice: T-6.8 found it, T-6.9 reintroduced it.
- **KEY-CACHE LAW:** `["trip-list"]` is a disjoint root. NOTHING may live under a
  `["trips", ...]` prefix except the trip-detail subtree that the guard's 404-scrub
  evicts. `invalidateTripLists(qc)` is the ONLY sanctioned list invalidation. New
  keys join the detail subtree or take their own disjoint root.
- **The conflict latch must be CONSUMED on every terminal path** (re-seed, effect,
  dismiss). Invariant: latch armed ⟺ notice visible.
- **The DS Sheet is hit-testable through its ~200ms exit animation.** Until the
  DS-level guard lands (QUEUE row), every new sheet consumer needs its own
  pending-gate posture.
- `expect_updated_at` always reads the FRESH context row, never the seeded form
  snapshot.

Server:

- Write predicates on role-bearing rows PIN the role (EPQ re-evaluation lands
  unguarded writes on a promoted row version after a lock wait).
- Global lock order is users → trip_members → invites. Extend it, never reorder.
- Cascade lock order equals FK-trigger CREATION order — fence multi-row deleters
  with an ordered `FOR UPDATE` SELECT.
- Membership INSERTs take the caller's `users` row `FOR SHARE` (live-only) FIRST.
- Atomic multi-writes use the WebSocket `Pool` / `postgres-js`, never Neon-HTTP.
- timestamptz µs-vs-ms: `date_trunc('milliseconds')` for wire equality.
- Raw `Date` params crash postgres-js drizzle `sql` templates — bind an ISO string
  plus an explicit cast.
- Membership aggregates join LIVE users only.

Tests:

- Key-presence authz needs falsy-value pins.
- Observer-less cache assertions pin `gcTime: Infinity`.
- RNTL v14 async-act boundaries are awaited.
- Server DB suites once needed `--no-file-parallelism` for Testcontainers
  contention. RETIRED 2026-08-30 by T-S3.3 (PR #44) — the shared globalSetup
  container plus TEMPLATE clones. Kept here only so the historical instruction
  reads as superseded, not current.
