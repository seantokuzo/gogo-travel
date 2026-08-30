# Handoff — device QA session 2026-08-29

> Scratch handoff for the NEXT session. Fold the durable parts into
> `docs/STATE.md` + `docs/QUEUE.md` and delete this file — it is deliberately
> outside the canonical doc homes (`.claude/rules/planning-doc-homes.md`) and
> must not become a permanent top-level doc.

## Where things actually are

**Branch `qa/device-integration`** (pushed, no PR yet) carries everything from
this session: B-4 (Google nonce), B-6 (dev error surfacing), the dev request
log, the B-8 transport grace + migration 0001, `scripts/seed-qa-places.mjs`,
QUEUE rows B-5..B-13, and three ledger flips.

Open PRs from earlier, now SUPERSEDED by that branch's contents — decide
whether to close or merge them first, do not double-apply:

| PR  | What                                       | State                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------- |
| #32 | T-9.4 settle-requests + budgets + FX proxy | mid-review-loop, untouched all session                        |
| #35 | B-4 Google nonce                           | CI green, never reviewed (auth path — wants the 5-lane panel) |
| #36 | dev request log                            | CI was running at last check                                  |

⚠️ **`qa/device-integration` was never put through the review pipeline.** It
touches `**/auth/**` and a migration — both PLANNING-designated sensitive
paths. It should not merge to main on this session's evidence alone.

## The rig (Sean's iPhone, live)

- Server `:3000` (`pnpm --filter @gogo/server dev`), Metro `:8081`, LAN
  `192.168.1.69`, Neon migrated (2 migrations), Docker up.
- Bundle id `app.gogotravel`; app installed and signed in as
  `seantokuzo@gmail.com`. Trip **"Spring in Kyoto"**
  `1933d1bf-9bee-4519-9c69-05c8c2b28363`, 6 bookings, 5 itinerary items.
- `apps/mobile/.env` carries a HARDCODED `EXPO_PUBLIC_API_URL=http://192.168.1.69:3000`.
  That is the **B-5 workaround** and it dies on any DHCP change. Remove it
  when B-5 lands.

## Ledger: 3 flipped, 1 deliberately NOT

`F-023`, `F-044`, `F-051` → `passes: true` with evidence, append-only verified.

**`F-043` was NOT flipped and must not be flipped without more testing.** Sean
reported "pass", but he was answering criterion 3 only — that is all this
session asked him for. Criteria 1 and 2 are untested:

- **1** — "create one booking per category": only 5 of 8 categories exist
  (flight, lodging, restaurant, train). Missing `car_rental`, `moped_rental`,
  `activity`, `other`. Also untested: invalid detail shape → 400, price
  requires currency.
- **2** — category change on update rejected; instants denormalize from
  details.
- **3** — ✅ well evidenced: cancelled "Imperial Hotel Tokyo" holds 0
  itinerary_items while its booking row survives.

This is the session's repeated failure mode, so it is worth stating plainly:
**ask the ledger's exact criteria, never a paraphrase.** An earlier "Chunk 2"
was improvised and mapped onto no complete ledger entry, which wasted a round.

## Two parallel workstreams Sean approved

Both in **isolated worktrees** (`isolation: "worktree"`). Non-negotiable: a
build agent must NEVER share the working tree while device QA is live — this
session caused a phantom "returning-user bug" by switching branches under a
running Metro, then misdiagnosed the result. Metro and `tsx watch` serve the
TREE, so a checkout is a silent deploy.

### Stream A — client polish (B-10..B-13)

All `apps/mobile`. Sean's device-QA gripes, root causes already located:

- **B-10 (P1)** — `DateField` renders an iOS `display="inline"` picker inside
  a half-width parent (`new.tsx:318` `datesRow` > `dateField`), so the
  right-hand calendar overflows the screen and half the days are untappable.
  Plus it defaults to `new Date()` (`DateField.tsx:44`) instead of a
  contextual date, and flight arrival should default to the entered
  departure. Recurred on the lodging flow → fix in `DateField`, not per-caller.
- **B-11 (P2)** — the "Add to this day" row renders only for EMPTY days, so a
  populated day has no add affordance in list view.
- **B-12 (P2)** — lodging shows as an all-day block with no check-in/check-out
  times. Sean wants derived ~15-min indicator blocks at the real times, KEEPING
  the all-day span. They must stay **ephemeral** — F-051 criterion 2 requires
  exactly ONE itinerary row for a multi-night stay, so materializing them
  breaks a ledger criterion that is now flipped `true`.
- **B-13 (P2)** — Ideas/Cancelled bins render when empty and Cancelled borrows
  the Ideas box. Hide a bin at zero count; never hide cancelled bookings
  themselves (F-043 criterion 3).

### Stream B — the testing overhaul

**This is NOT mostly backend.** Sean assumed it was; it is roughly half mobile,
so the two streams are not cleanly separated. Overlap risk is small but real:
Stream B touches `apps/mobile/src/auth/*` tests and **`jest.setup.js`**, while
Stream A touches components. `jest.setup.js` is the one file that could
genuinely collide — assign it to Stream B only.

Evidence base: **five bugs this session, none catchable by the 1418 existing
unit tests.** Each needs a different layer:

| Bug           | Why every unit test missed it                                        | Layer owed                                                                                          |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B-4 nonce     | the mock asserted a request shape iOS never produces                 | **mock fidelity**: import the REAL library, assert the shape our mock claims                        |
| B-5 localhost | nothing ever exercised URL resolution on a device                    | **device smoke**: a few legs that must run on hardware — start with "what base URL did we resolve?" |
| B-7 deadlock  | every suite seeds fixtures first, so nobody runs the first-user path | **fresh-database suite**: empty DB, no fixtures, first-run flows                                    |
| B-8 timezone  | every fixture uses one timezone                                      | **hostile fixtures**: date-line flight, multi-zone trip, zero-decimal currency, empty states        |

Recommended shape: write the **strategy as an ADR first** (it is a testing
decision, not a code change), then build. Do not start by writing more unit
tests — they demonstrably would not have caught a single one of these.

## Known-wrong data on the device

Every booking created so far carries instants offset by the real timezone
(B-8). "LAX => NRT" stores a 2h49m duration for an ~11h flight. Re-enter them
after B-9 (airport table + IANA tz) rather than trusting itinerary ordering or
leave-by math against them.

## Session self-assessment (process, not code)

Four avoidable errors, all worth guarding against next time:

1. **Switched branches under live QA** twice, then diagnosed the resulting
   regression as a new bug with a plausible-sounding story. The tell was there
   — the identical error string from the original B-4 symptom.
2. **Paraphrased ledger criteria** instead of reading them, then nearly flipped
   entries on the paraphrase.
3. **Blamed the user** for the date-line flight — filed it as "user entered an
   inverted range" before asking what the booking was. Sean corrected it; the
   original mis-filing is deliberately preserved in the B-8 row.
4. **Claimed verification from the wrong side** — proved the server was
   reachable by curling from the Mac, which said nothing about what the phone
   was dialing. Three `EADDRINUSE` orphans also produced 200s from a zombie
   process while logging nothing.
