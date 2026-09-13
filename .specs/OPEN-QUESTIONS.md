# Gate 2 Punch List — ✅ RESOLVED 2026-07-09

> **Status: Sean approved ALL recommendations wholesale (Gate 2, 2026-07-09).**
> Every answer has been folded back into its canonical spec and all
> `[NEEDS CLARIFICATION]` markers removed (verified zero remaining). The "Rec"
> column below is now the DECIDED answer — this file is the decision record.
>
> Still-open action items (not spec gaps): **A1** — Sean picks a palette from
> the three proposed directions (artifact delivered); **A3** — Sean buys the
> universal-link domain before TestFlight (spec uses `links.gogotravel.example`
> placeholder, one-config swap).

## A. Identity & brand

| #     | Question                                | Rec                                                                                         | Canonical           |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| A1 ⚠️ | Brand accent palette / visual identity  | none — Sean supplies (or I propose 3 palettes to pick from)                                 | tokens.spec:90      |
| A2    | Which accent themes ship v1, how many   | 3 themes (default + 2), proven re-skin seam                                                 | tokens.spec:94      |
| A3 ⚠️ | Universal-link domain (AASA/assetlinks) | Sean picks/buys (gogo.travel / gogotravel.app / subdomain of seantokuzo.dev)                | navigation.spec:100 |
| A4    | Custom fonts vs system v1               | System (SF Pro/Roboto) v1; custom font = later theme upgrade                                | tokens.spec:103     |
| A5    | In-app haptics toggle                   | OS-setting only v1                                                                          | tokens.spec:106     |
| A6    | Theme scope: trip theme vs user accent  | User-level accent pref; trip theme colors small trip accents only, NOT whole-app re-skin v1 | tokens.spec:98      |

## B. Trips & collaboration

| #   | Question                                   | Rec                                                                                                   | Canonical                           |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| B1  | Trip dates required at creation?           | Required v1 (unlocks season/AI/tile triggers); date-less trips deferred                               | schema.spec:280                     |
| B2  | Destination input: structured vs free text | Structured search against Overture city/locality subset (free, no new dependency); guarantees lat/lng | schema.spec:281 (+trips client:214) |
| B3  | Trip status transitions                    | Date-derived + manual override allowed (override wins until cleared)                                  | schema.spec:282                     |
| B4  | Ownership transfer / owner leaves          | Owner may transfer; leaving requires transfer first                                                   | schema.spec:296                     |
| B5  | Invite links                               | Multi-use, 7-day default expiry, revocable, optional max_uses                                         | schema.spec:314                     |
| B6  | Multi-active-trip cold-launch landing      | Most-recently-viewed active trip; trip switcher in header                                             | navigation.spec:119                 |
| B7  | Viewer role boundary                       | Viewers CAN log expenses + upload photos (they're travelers); CANNOT edit itinerary/bookings/settings | trips.spec:230 + money.spec:211     |
| B8  | Base-currency change semantics             | Base currency locks once the first expense exists                                                     | trips.spec:645                      |
| B9  | Trip-level "visibility" concept            | Drop from v1 (trips are member-private; only photos have visibility)                                  | trips.spec:655                      |
| B10 | Member removal with nonzero balance        | Allowed; ledger rows survive (R-db-16 posture), balances still shown                                  | money.spec:218                      |
| B11 | Collaborator-activity ticker               | Defer activity feed to v2; v1 today-view drops the ticker                                             | today.spec:193                      |

## C. Money

| #   | Question                                    | Rec                                                                                                                                                               | Canonical            |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| C1  | Expense/budget category taxonomy            | Fixed enum v1: lodging, transport, food, activities, shopping, other (aligned w/ booking categories)                                                              | schema.spec:192      |
| C2  | Multi-currency FX policy                    | Store original cents + base cents + rate captured at entry; rate auto-fetched when online (free FX API = new dependency, see escalations), manual override always | schema.spec:446      |
| C3  | Expense deletion                            | Soft-delete with visible audit trail                                                                                                                              | schema.spec:447      |
| C4  | Overall trip budget cap                     | Yes — optional overall cap alongside per-category                                                                                                                 | schema.spec:494      |
| C5  | Debt simplification default                 | Off by default; one-tap "simplify debts" view toggle (Splitwise trust precedent)                                                                                  | money.spec:113       |
| C6  | Settlement correction                       | Recorder may delete own settlement ≤24h; after that, counter-entry only                                                                                           | money.spec:133       |
| C7  | settlement_requests table (entity addition) | Approve                                                                                                                                                           | money.spec:157       |
| C8  | Split-type persistence                      | Persist resolved cents only v1; split_meta later if re-edit demanded                                                                                              | money.spec:220       |
| C9  | Party-size source for booking deeplinks     | Default adults = trip member count; editable per search                                                                                                           | itinerary client:179 |

## D. Capture

| #   | Question                                      | Rec                                                                                                                                           | Canonical           |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| D1  | Auto-file vs always-confirm                   | High-confidence parses auto-file + push notification with one-tap undo; medium/low → review queue. (The TripIt "magic" depends on auto-file.) | capture.spec:141    |
| D2  | Registered sender addresses (entity addition) | Approve — verified additional senders table (Apple private-relay reality)                                                                     | capture.spec:69     |
| D3  | Capture LLM vs 30/day AI cap                  | Does NOT count against AI cap; separate structural ceiling (20 captures/day)                                                                  | schema.spec:197     |
| D4  | Raw capture retention (PII)                   | Delete raw payload on confirm or after 30 days, whichever first                                                                               | schema.spec:514     |
| D5  | Capture queue surface                         | Trips-level inbox (captures can precede trip assignment) + per-trip filtered view                                                             | navigation.spec:113 |

## E. Auth & profile

| #   | Question                       | Rec                                                                                                                      | Canonical           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| E1  | Apple↔Google identity linking  | Auto-link on verified matching email                                                                                     | schema.spec:233     |
| E2  | Account deletion strategy      | Soft-delete + PII scrub; ledger rows survive as "Deleted user"                                                           | schema.spec:117     |
| E3  | Session management UI v1       | Endpoints + minimal list/revoke screen in settings                                                                       | auth-users.spec:503 |
| E4  | Apple sign-in client mechanism | Native `expo-apple-authentication` (App-Review-favored; server contract unchanged) — technical, decided unless objection | auth-users.spec:269 |
| E5  | Onboarding contents            | Name/avatar → home currency → payment handles (skippable) → notification priming; travel_style optional prompt           | navigation.spec:104 |
| E6  | Profile/settings home          | Avatar button on trips-list header (outside trip context)                                                                | navigation.spec:108 |
| E7  | travel_style taxonomy          | Multi-tag, fixed set: budget, comfort, luxury, foodie, adventure, culture, nightlife, family, relaxation                 | contracts.spec:189  |

## F. Places & maps

| #   | Question                                                  | Rec                                                                 | Canonical            |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| F1  | POI ingestion source set                                  | Both Overture + FSQ OS; Overture wins dedup priority                | places.spec:154      |
| F2  | place_ingest_regions table + ingest job (entity addition) | Approve                                                             | places.spec:162      |
| F3  | Foursquare premium details in MVP                         | Defer — MVP is spine-data-only ($0); revisit post-launch            | places.spec:168      |
| F4  | Map place-discovery affordance                            | Search bar on map tab (spine-backed), no basemap-POI tap-through v1 | map.spec:183         |
| F5  | Persistent mini-map in plan mode                          | Defer to polish phase; strong map-tab linkage first                 | itinerary client:188 |

## G. Photos

| #   | Question                                         | Rec                                                       | Canonical       |
| --- | ------------------------------------------------ | --------------------------------------------------------- | --------------- |
| G1  | Is photo+caption the whole v1 "reviews" surface? | Yes — no separate review concept v1                       | schema.spec:540 |
| G2  | Where public photos surface for non-members      | Place detail sheet only v1 (destination gallery later)    | schema.spec:541 |
| G3  | Photo moderation                                 | Trip owner may delete any photo within the trip           | photos.spec:166 |
| G4  | Member leaves trip → photos                      | Photos remain in trip; uploader retains delete rights     | photos.spec:171 |
| G5  | Location-consent posture                         | Per-upload opt-in; remembered default after first consent | photos.spec:177 |

## H. AI, notifications, utilities

| #   | Question                           | Rec                                                                                                             | Canonical              |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
| H1  | Per-feature AI ceilings            | Approve proposed: recs 10/day, expense-est 10/day, packing 5/day, tour-guide 50 places/trip, recap 1/trip       | ai.spec:77             |
| H2  | Packing-list cache policy          | Live-uncached (personal, cheap on Haiku)                                                                        | ai.spec:413            |
| H3  | Tour-guide pre-gen trigger         | T-3 days before trip start (+ manual "prepare offline" button)                                                  | ai.spec:609            |
| H4  | AI content English-only v1?        | English-only; no locale in cache key yet                                                                        | schema.spec:580        |
| H5  | Packing lists shared vs per-member | Shared per trip v1 (simplest useful)                                                                            | schema.spec:613        |
| H6  | Recap persistence home             | Approve new `recaps` table (entity addition)                                                                    | schema.spec:783        |
| H7  | Flight-status provider             | Defer to v2 (no provider researched; alerts are TripIt's paid moat — do it right later)                         | notifications.spec:149 |
| H8  | Day-ahead digest timing            | 8pm trip-local time; fallback device timezone                                                                   | notifications.spec:288 |
| H9  | Offline caching of document scans  | No offline doc scans v1 (security > convenience)                                                                | notifications.spec:295 |
| H10 | Non-member settle-request links    | Require app install + account v1 (no web surface exists); revisit with any web phase                            | navigation.spec:122    |
| H11 | Multi-day bookings on the calendar | Spanning all-day lane on grid; check-in/check-out point items on day list (branch pre-mapped in itinerary spec) | schema.spec:401        |

## Entity-list additions bundled for one nod

`place_ingest_regions` (F2) · `settlement_requests` (C7) · `recaps` (H6) ·
registered-senders table (D2) · auth tables (`auth_sessions`, `refresh_tokens`,
`apple_credentials` — already specced in auth spec §, consistent with schema
conventions).

## New-dependency escalations surfaced by specs (Autonomy Contract §3)

- Free FX-rate API (C2) — needed for multi-currency; candidates at build time.
- Transactional email outbound (capture parse-reply) — provider chosen at
  build (CloudMailin covers inbound only).
- Weather provider (weather_cache) — provider-agnostic shape specced; chosen at build.
- Object storage (photos/docs/capture raw) — provider-agnostic port specced;
  chosen at P-3 (likely S3/R2).

## Resolution protocol

Approved answer → edit the canonical spec (remove marker, write the rule) →
repeats inherit via their citation → note in PLANNING Decisions Log if
cross-phase. This file shrinks to zero before Gate 3 freezes the roadmap.

---

# Round 2 — Spec-Pass Decision Batch (2026-09-13)

> **How to answer:** approve every recommendation below in one reply ("approve
> all"), or list exception item numbers only (e.g. "approve all except
> Q2-014, Q2-152, Q2-231"). Default recommendation per item is **keep as
> shipped**, unless a real alternative is called out.
>
> **Count: 300 items** — Money 55 · Itinerary & bookings 129 · Maps & places
> 101 · Trips & collaboration 4 · Forms & pickers 6 · Infra & other 5.

⚠️ **Read these first — they get more expensive with time:**

- The whole **Money** group below (Q2-001..Q2-054) — every item is a P-9
  ledger/settle-up interpretation; the longer they sit unruled, the more
  downstream money surfaces (recaps, AI estimates, send-the-bill polish)
  build on the unruled assumption. Law #2.
- **Q2-185 — Map pin-coverage structural closure** (PR #23) — a JUDGE MERGE
  CONDITION; P-8 isn't truly closed until this is ruled.
- **Q2-186 — R-map-18 activation-mount ruling** (PR #27) — P1; a one-line fix
  either way, but every trip ships the one-visit-late interim behavior until
  ruled.

---

## Money (55 items)

Law #2 — review this group first; it gates the shape every future money
surface inherits.

### PR #31 — T-9.1 shared money contracts + money-tab shell (13 items)

| #      | Interpretation (as shipped)                                                                               | Rec              | Decision |
| ------ | --------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| Q2-001 | Creditor balance rows route to `settle/[memberId]`, not a dedicated request route (T-9.7 owns "Request"). | Keep as shipped. |          |
| Q2-002 | Open-request balance annotations ship as an empty seam — no settle-request LIST endpoint exists.          | Keep as shipped. |          |
| Q2-003 | Budget "untouched" EmptyState shows even when spend exists — spec-literal on caps/estimates only.         | Keep as shipped. |          |
| Q2-004 | AI-estimate budget column renders only when an estimate exists; no six-dash noise row otherwise.          | Keep as shipped. |          |
| Q2-005 | Money FAB lives on the Expenses segment, visible to viewers; today-tab quick-add is the other add entry.  | Keep as shipped. |          |
| Q2-006 | Budget cap inputs are always-inline; no separate display→edit morph state.                                | Keep as shipped. |          |
| Q2-007 | Money display shape is `"USD 25.50"`, mirroring the existing idea-price formatter.                        | Keep as shipped. |          |
| Q2-008 | Balance parties missing from the live member roster render as "Former member".                            | Keep as shipped. |          |
| Q2-009 | Money-tab segment memory resets only at sign-out, not per navigation.                                     | Keep as shipped. |          |
| Q2-010 | DS Input's new RN passthroughs (`onEndEditing`, `editable`) are additive, not a breaking change.          | Keep as shipped. |          |
| Q2-011 | `usePutBudget` is NOT optimistic — a cap edit isn't an interaction-continuity case like drag.             | Keep as shipped. |          |
| Q2-012 | Money cache keys live under the trip's detail subtree (evicted with the trip), not a disjoint root.       | Keep as shipped. |          |
| Q2-013 | Offline copy/posture for money segments follows the R-itin-29 pattern verbatim.                           | Keep as shipped. |          |

### PR #32 — T-9.4 settle-requests + budgets + FX proxy (16 items: SR-1..7, B-1..4, FX-1..5)

| #      | Interpretation (as shipped)                                                                                     | Rec              | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| Q2-014 | [SR-1] `resolved` derives from live pairwise debt only, independent of the request's own `status`.              | Keep as shipped. |          |
| Q2-015 | [SR-2] An explicit settle amount is accepted at ANY debt level — zero, negative, above, or below.               | Keep as shipped. |          |
| Q2-016 | [SR-3] Wire `created_by` on a settle-request is always the creditor.                                            | Keep as shipped. |          |
| Q2-017 | [SR-4] Settle-request `link` is the https form on the wire; the `gogo://` mirror is client-composed.            | Keep as shipped. |          |
| Q2-018 | [SR-5] Debtor-is-caller and debtor-not-a-member both map to 400 VALIDATION_FAILED.                              | Keep as shipped. |          |
| Q2-019 | [SR-6] Cancelling an already-settled/cancelled request is ONE 409 either way — cancel is not idempotent.        | Keep as shipped. |          |
| Q2-020 | [SR-7] Settle-request create takes the trip row FOR UPDATE (same lock class as first-expense insert).           | Keep as shipped. |          |
| Q2-021 | [B-1] Budget `ai_estimate_cents` sums non-null category estimates; null when every category is null.            | Keep as shipped. |          |
| Q2-022 | [B-2] Budget upsert's conflict arm re-stamps currency from `trips.base_currency`, never touches AI estimates.   | Keep as shipped. |          |
| Q2-023 | [B-3] `spent_cents` is computed at expense grain — Σ effective-base per category, payer shares included.        | Keep as shipped. |          |
| Q2-024 | [B-4] Unknown `:category` on a budget PUT returns 400 only AFTER the membership gate.                           | Keep as shipped. |          |
| Q2-025 | [FX-1] FX-proxy outage/timeout/parse failure → 503 `AI_UPSTREAM` (no generic `UPSTREAM` alias added).           | Keep as shipped. |          |
| Q2-026 | [FX-2] Provider rate renders via `toFixed(8)` + trailing-zero trim; out-of-envelope values → 503, never cached. | Keep as shipped. |          |
| Q2-027 | [FX-3] Identity currency pairs (base = quote) pass through to the provider, no local shortcut.                  | Keep as shipped. |          |
| Q2-028 | [FX-4] FX-rate endpoint is rate-limited at 20/min per user.                                                     | Keep as shipped. |          |
| Q2-029 | [FX-5] FX provider timeout fixed at 4s, fails fast into the client's manual-rate fallback.                      | Keep as shipped. |          |

### PR #56 — T-9.7 settle-up + send-the-bill (2 flagged gaps + 14 items)

| #      | Interpretation (as shipped)                                                                                                    | Rec                                                                                                     | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------- |
| Q2-030 | **[Gap]** §2.7 balances-row open-request annotations stay seam-only/empty — no settle-request LIST endpoint.                   | Needs a wire ruling (add a LIST endpoint) before the annotation can go live — flag, not a rubber-stamp. |          |
| Q2-031 | **[Gap]** Settle-request wire carries no `settled_by`/`settled_at` — "who/when" degrades to generic copy past page one.        | Add the two columns at next settle-request touch, or accept the degrade permanently — real alternative. |          |
| Q2-032 | §2.8's `settle-input-amount` is the SCREEN field; sheet-internal ids derive per the §2.7 rule-4 convention.                    | Keep as shipped.                                                                                        |          |
| Q2-033 | The request screen's on-screen settle amount is fixed at the request amount, not independently editable.                       | Keep as shipped.                                                                                        |          |
| Q2-034 | No toast component exists — copy/record confirmations render as inline "Copied" state plus a haptic.                           | Keep as shipped.                                                                                        |          |
| Q2-035 | Deeplink return-prompt hosts mount on the settle/request screens only, not global chrome.                                      | Keep as shipped.                                                                                        |          |
| Q2-036 | At a net-zero balance, "mark as settled" records caller→counterparty by default (pay framing).                                 | Keep as shipped.                                                                                        |          |
| Q2-037 | Zelle `displayName` falls back to the raw handle when `zelle_display_name` is null (legacy rows).                              | Keep as shipped.                                                                                        |          |
| Q2-038 | A throwing `canOpenURL` (Android missing the venmo `<queries>` entry) folds into the web-fallback arm.                         | Keep as shipped.                                                                                        |          |
| Q2-039 | Share-request message text is `"<requester> requests <amount> for <trip> — settle up in GoGo: <gogo://…> (web: <https://…>)"`. | Keep as shipped.                                                                                        |          |
| Q2-040 | SendBillSheet always POSTs an explicit amount, prefilled from the displayed balance.                                           | Keep as shipped.                                                                                        |          |
| Q2-041 | An uninvolved member opening a request link gets a read-only summary, no action affordances.                                   | Keep as shipped.                                                                                        |          |
| Q2-042 | Unknown-request-id EmptyState routes back to the money tab via a same-tab `router.replace`.                                    | Keep as shipped.                                                                                        |          |
| Q2-043 | Settle/settle-request success invalidates the settlements list + linked request detail, beyond the frozen trio.                | Keep as shipped.                                                                                        |          |
| Q2-044 | A settled net-zero pair keeps mark-as-settled reachable through the debtor-arm handoff sheet.                                  | Keep as shipped.                                                                                        |          |
| Q2-045 | Sheet actions ship as Navigate + Details for a linked booking's own detail on the settle flow's kind fork.                     | Keep as shipped.                                                                                        |          |

### PR #57 — T-9.6 expense list/detail/add-edit (10 items, incl. G1/G2)

| #      | Interpretation (as shipped)                                                                                                          | Rec                                                                                                       | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------- |
| Q2-046 | [G1] Audit-trail (deleted-expense) entries have no LIST wire source — the history list can't show deletions.                         | Needs a wire-param ruling if the history screen should list deleted entries — real alternative.           |          |
| Q2-047 | [G2] Expense edit sends a changed-fields-only PATCH; an untouched split naming an ex-member survives, a changed one is save-blocked. | Keep as shipped — R-cmoney-12's literal "full shares replacement" can't hold for legacy ex-member splits. |          |
| Q2-048 | Expense base amount is derived read-only in the form; a currency change drops any manual rate override.                              | Keep as shipped.                                                                                          |          |
| Q2-049 | `expense-new-picker-currency` is an uppercase 3-letter code field (BookingForm/B-20 precedent).                                      | Keep as shipped.                                                                                          |          |
| Q2-050 | Expense category defaults to `other`; chips render the full shared taxonomy in fixed tuple order.                                    | Keep as shipped.                                                                                          |          |
| Q2-051 | A booking-prefilled expense also carries the booking's currency, not just its amount.                                                | Keep as shipped.                                                                                          |          |
| Q2-052 | "Your share" line renders only when the caller holds a share row (an explicit zero-share row included).                              | Keep as shipped.                                                                                          |          |
| Q2-053 | The §2.9 FAB pulse hint is a finite 3-cycle ring (`useReduceMotion` honored), not an infinite loop.                                  | Keep as shipped.                                                                                          |          |
| Q2-054 | A malformed `?expenseId=` edit deep link degrades to a "gone" EmptyState, never a blank create form.                                 | Keep as shipped.                                                                                          |          |
| Q2-055 | Expense date filters (`from`/`to`) are not built this pass — the wire already supports them for a later surface.                     | Keep as shipped.                                                                                          |          |

---

## Itinerary & bookings (129 items)

### PR #11 — T-7.2 itinerary router, single question (1 item)

| #      | Interpretation (as shipped)                                                                                                 | Rec                                                                                                                     | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-056 | `GET /bookings?unscheduled=false` is treated as no filter (identical to the param being absent) — spec only defines `true`. | Bless as-is, or spec the complement ("false = scheduled-only") — real alternative, low urgency until a client wants it. |          |

### PR #12 — T-7.2 spec-pass batch #2 + a security tension (8 items)

| #      | Interpretation (as shipped)                                                                                   | Rec                                                                                                                                                                | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Q2-057 | `title` is forbidden on a `place_visit` create.                                                               | Keep as shipped.                                                                                                                                                   |          |
| Q2-058 | `place_id` is custom-create-only on `place_visit` vs. PATCH-only elsewhere — a deliberate asymmetry.          | Keep as shipped.                                                                                                                                                   |          |
| Q2-059 | `end_day` rides the R-ib-16 protected-field set.                                                              | Keep as shipped.                                                                                                                                                   |          |
| Q2-060 | Multi-item unschedule deletes ALL of a booking's items, not one at a time.                                    | Keep as shipped.                                                                                                                                                   |          |
| Q2-061 | Unlisted-day items survive a reorder; duplicate ids in a reorder payload → 400.                               | Keep as shipped.                                                                                                                                                   |          |
| Q2-062 | A spanning pull (drag across days) keeps `end_day` intact.                                                    | Keep as shipped.                                                                                                                                                   |          |
| Q2-063 | A malformed `:day` path param → 400, not 404.                                                                 | Keep as shipped.                                                                                                                                                   |          |
| Q2-064 | **[Security]** R-ib-15's mandated foreign-trip 400 on reorder is a cross-trip existence oracle on item UUIDs. | Fold foreign ids into the dead-id LWW-ignore, or reject unknown ids too — both close the oracle; pick one and reword R-ib-15. Real alternative, security-flavored. |          |

### PR #14 — T-7.8 client deeplink interpretations (6 items)

| #      | Interpretation (as shipped)                                                                  | Rec              | Decision |
| ------ | -------------------------------------------------------------------------------------------- | ---------------- | -------- |
| Q2-065 | Party-size (`adults`) is form-only — no deeplink param carries it.                           | Keep as shipped. |          |
| Q2-066 | Trainline with a zero URN falls back to the plain domain instead of a broken deep link.      | Keep as shipped. |          |
| Q2-067 | A non-http(s) `external_url` is treated as missing.                                          | Keep as shipped. |          |
| Q2-068 | Manual-add bookings get stopgap client-generated ids.                                        | Keep as shipped. |          |
| Q2-069 | R-itin-29's offline deeplink posture is deferred to T-7.9 (resolved there — see that group). | Keep as shipped. |          |
| Q2-070 | Skyscanner with an absent cabin class defaults to economy.                                   | Keep as shipped. |          |

### PR #15 — T-7.4 client spec-pass batch (6 items)

| #      | Interpretation (as shipped)                                                             | Rec              | Decision |
| ------ | --------------------------------------------------------------------------------------- | ---------------- | -------- |
| Q2-071 | Day-range fill is sparse (only days with content render distinctly), not continuous.    | Keep as shipped. |          |
| Q2-072 | Check-in/out row synthesis ships for lodging only; other spanning categories don't yet. | Keep as shipped. |          |
| Q2-073 | The check-out row is placed at a fixed spot and is non-draggable.                       | Keep as shipped. |          |
| Q2-074 | A `place_visit` with no place name (composite-read gap) shows a generic title fallback. | Keep as shipped. |          |
| Q2-075 | The day-jump strip renders at every trip length — no trip-length threshold.             | Keep as shipped. |          |
| Q2-076 | A server-refused reorder shows one undiscriminated generic banner.                      | Keep as shipped. |          |

### PR #16 — T-7.7 calendar grid + multi-day rendering (15 items)

| #      | Interpretation (as shipped)                                                                                                      | Rec                                                           | Decision |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| Q2-077 | A timed item with no `end_time` renders as a 60-minute block in the grid.                                                        | Keep as shipped.                                              |          |
| Q2-078 | "Rounded to 30 min" (R-itin-14) means floor-to-half-hour of the tap's `locationY`.                                               | Keep as shipped.                                              |          |
| Q2-079 | The visible 08:00–20:00 band (R-itin-17) is `viewportHeight/12` clamped 44–96pt — approximate on extreme screens.                | Keep as shipped.                                              |          |
| Q2-080 | The landing column is today if today has any item, including a sparse out-of-range one.                                          | Keep as shipped.                                              |          |
| Q2-081 | Spanning-lane items render as abutting per-column segments — a literal span can't cross a virtualized pager.                     | Keep as shipped.                                              |          |
| Q2-082 | New grid testIDs (span/day/hours/pager/allday/scroll) need folding into the §2.9 spec-sync batch.                                | Keep as shipped; fold into the existing testID spec-sync row. |          |
| Q2-083 | Non-lodging spanning items generalize §2.6's flight treatment (timed→clipped+"+1", untimed→chip+"+1").                           | Keep as shipped.                                              |          |
| Q2-084 | Viewer slots render as inert grid lines with no write-affordance testIDs.                                                        | Keep as shipped.                                              |          |
| Q2-085 | Overlap badges count only DIRECT time-range sharers, not transitively-chained cluster members.                                   | Keep as shipped.                                              |          |
| Q2-086 | Day-peek column width = 92% of window minus 48pt gutter, paged via `snapToInterval`.                                             | Keep as shipped.                                              |          |
| Q2-087 | All-day chips render in one fixed-height row per column, no wrap.                                                                | Keep as shipped.                                              |          |
| Q2-088 | Spanning-lodging detection reuses `projectItem`'s two-entry signature (one source of truth with the list).                       | Keep as shipped.                                              |          |
| Q2-089 | Rider-unmount test pin is a net assertion, not a discriminator (test-infra only, no product surface).                            | Keep as shipped.                                              |          |
| Q2-090 | Members-overlap test pin re-vectored to same-frame multi-touch (test-infra only, no product surface).                            | Keep as shipped.                                              |          |
| Q2-091 | `MIN_BLOCK_HEIGHT = 22pt` floors very short event blocks so they stay tappable, deviating from strict R-itin-13 duration-sizing. | Keep as shipped.                                              |          |

### PR #17 — T-7.6 ideas bucket + add/edit flows (25 items — 2 money rulings already made 2026-08-25, excluded: currency-default and zero-decimal handling)

| #      | Interpretation (as shipped)                                                                                                                                                                                                               | Rec                                                                                      | Decision |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| Q2-092 | Detail datetimes are composed `YYYY-MM-DDTHH:MM:00Z`; calendar placement derives by SLICING wall components (exact), only the denormalized UTC instant is approximate. A half-filled datetime is a validation error, never a silent drop. | Keep as shipped.                                                                         |          |
| Q2-093 | Ideas bucket defaults collapsed; expanded content caps at 45% of window height with internal scroll.                                                                                                                                      | Keep as shipped.                                                                         |          |
| Q2-094 | The cancelled list is fetched eagerly (one bounded extra request) so a cancelled-only trip isn't invisible.                                                                                                                               | Keep as shipped.                                                                         |          |
| Q2-095 | The ideas bucket renders in BOTH view modes, including grid.                                                                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-096 | Cancelled cards get a neutral "Cancelled" badge, route to booking-detail, never schedulable.                                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-097 | New §2.9 testIDs (ideas schedule sheet, item-new fields, error/loading surfaces) need spec-sync folding.                                                                                                                                  | Keep as shipped; fold into the testID spec-sync batch.                                   |          |
| Q2-098 | Add-option slugs are kebab-case (`car-rental`, `moped-rental`, `place-visit`).                                                                                                                                                            | Keep as shipped.                                                                         |          |
| Q2-099 | The in-form category step reuses the `itinerary-add-option-*` ids (the two surfaces never co-mount).                                                                                                                                      | Keep as shipped.                                                                         |          |
| Q2-100 | `?day=` alone is NOT written into booking details on create — only day+time (gap-tap) seeds the start field.                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-101 | A create→schedule chain failure is never silent — a warning banner shows and Save swaps for Done.                                                                                                                                         | Keep as shipped.                                                                         |          |
| Q2-102 | A booking edit with an attached place shows a generic "Attached place" chip (no place name on the wire yet).                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-103 | The place picker is spine-search only — "saved places first" has no endpoint yet, flagged as a seam.                                                                                                                                      | Keep as shipped.                                                                         |          |
| Q2-104 | Viewer gating (R-ib-24): FAB, empty-day add rows, and the EmptyState CTA are hidden for viewers.                                                                                                                                          | Keep as shipped.                                                                         |          |
| Q2-105 | The status control honors §3.2 exactly — a PATCH only fires when status CHANGED, no self-loops.                                                                                                                                           | Keep as shipped.                                                                         |          |
| Q2-106 | Booking forms show exactly the §2.4 table's fields — notes/`segments`/`passenger_names` stay off-form.                                                                                                                                    | Keep as shipped.                                                                         |          |
| Q2-107 | Kayak's "non-stop only" toggle is not exposed — not in the §2.4 field table.                                                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-108 | Booking edit sends whole-form LWW (nullable fields clear on each save).                                                                                                                                                                   | Keep as shipped.                                                                         |          |
| Q2-109 | Item forms expose no `end_day`; title is custom-only, place is place_visit-only per the PATCH rules.                                                                                                                                      | Keep as shipped.                                                                         |          |
| Q2-110 | The deeplink-out host mount lives in the itinerary stack layout (every deeplink surface shares it).                                                                                                                                       | Keep as shipped.                                                                         |          |
| Q2-111 | Lodging deeplink `location` falls back address → property_name → destination_name.                                                                                                                                                        | Keep as shipped.                                                                         |          |
| Q2-112 | Test-infra ruling: the modal audit tolerates a Fragment-wrapped Stack; the renderRouter exit-timer drain is skipped by design (test-infra only).                                                                                          | Keep as shipped.                                                                         |          |
| Q2-113 | The activity form includes an `address` field beyond the §2.4 row's named list — read as covering venue name AND address.                                                                                                                 | Keep as shipped; §2.4's "exactly the table's fields" reads as "plus `activity.address`". |          |
| Q2-114 | `ItemForm` edit renders "Selected place" for a nameless attached place (same no-name gap as bookings' "Attached place").                                                                                                                  | Keep as shipped; consider unifying both placeholder strings at the next touch.           |          |
| Q2-115 | `OptionChips` tapping the SELECTED chip clears it (every detail field is optional, no "none" option exists).                                                                                                                              | Keep as shipped.                                                                         |          |
| Q2-116 | `TimeField` opens at 12:00 (noon) when unset, avoiding the DST edges a midnight default would hit.                                                                                                                                        | Keep as shipped.                                                                         |          |

### PR #18 — T-7.5 travel-time legs + conflict surfacing (35 items)

| #      | Interpretation (as shipped)                                                                                                                                            | Rec                                                                                                                            | Decision |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Q2-117 | The default-mode ladder continues past R-itin-5 to transit → cycling → walking-over-15-min when driving/walking modes are absent.                                      | Keep as shipped.                                                                                                               |          |
| Q2-118 | R-itin-6 ships as "no chip" rather than a subtle placeholder for an uncomputed leg.                                                                                    | Keep as shipped.                                                                                                               |          |
| Q2-119 | A leg chip renders directly after its FROM row, even when the pair isn't adjacent (chain crosses unlocated items).                                                     | Keep as shipped.                                                                                                               |          |
| Q2-120 | Check-out rows ARE leg endpoints (a spanning item chains into both its `day` and `end_day`).                                                                           | Keep as shipped.                                                                                                               |          |
| Q2-121 | Mode-Sheet rows are informational, not selectors — only Directions/close are interactive (so the chip can't contradict R-itin-5).                                      | Keep as shipped.                                                                                                               |          |
| Q2-122 | Distance shows only in the Sheet, never on the chip (metric only — no locale/units preference exists yet).                                                             | Keep as shipped.                                                                                                               |          |
| Q2-123 | Duration copy rounds to the nearest minute, floors sub-minute legs to "1 min", splits hours above 60.                                                                  | Keep as shipped.                                                                                                               |          |
| Q2-124 | The travel provider is surfaced in Sheet rows (e.g. "3.4 km · transitous") for legibility, not spec-required.                                                          | Keep as shipped.                                                                                                               |          |
| Q2-125 | Directions launch Google Maps, not Apple Maps — no verified Apple Maps URL format exists in `.specs/research/`.                                                        | Bless Google-only for v1, or spend a device-verify pass on an Apple Maps variant — real alternative, deliberately not shipped. |          |
| Q2-126 | Directions taps are NOT recorded for the return-booking prompt (a nav handoff books nothing).                                                                          | Keep as shipped.                                                                                                               |          |
| Q2-127 | Directions degrades to disabled (with a "Needs …" hint), never to a junk-text query, for an unnamed place.                                                             | Keep as shipped.                                                                                                               |          |
| Q2-128 | Endpoint label preference is a two-way branch on `item.kind` (booking → address/title/null; other → title only, no fallback).                                          | Keep as shipped.                                                                                                               |          |
| Q2-129 | The trip destination is appended as query context ("Walk Shibuya, Tokyo"), suppressed if already present.                                                              | Keep as shipped.                                                                                                               |          |
| Q2-130 | The mode Sheet does not use `dismissDisabled` — it wraps no mutation to gate.                                                                                          | Keep as shipped.                                                                                                               |          |
| Q2-131 | The mode Sheet mounts eagerly (a lazy-mount attempt was withdrawn in round 1 — Reduce Motion regression).                                                              | Keep as shipped.                                                                                                               |          |
| Q2-132 | Stale legs after a reorder degrade to absent — the forward scan stops at the first located entry.                                                                      | Keep as shipped.                                                                                                               |          |
| Q2-133 | The leg Sheet's title reads "To {toTitle}".                                                                                                                            | Keep as shipped.                                                                                                               |          |
| Q2-134 | The overlap span (grid conflict detection) and the sort key are deliberately different notions — spanning lodging is excluded from the former, included in the latter. | Keep as shipped.                                                                                                               |          |
| Q2-135 | "Sort day by time" leaves untimed items exactly in their existing slot; only timed items are permuted.                                                                 | Keep as shipped.                                                                                                               |          |
| Q2-136 | Same-start-minute ties never mark a day "unsorted"; sort is stable.                                                                                                    | Keep as shipped.                                                                                                               |          |
| Q2-137 | Non-monotonicity checks ignore untimed rows entirely.                                                                                                                  | Keep as shipped.                                                                                                               |          |
| Q2-138 | The "Sort by time" affordance lives in the day header, shown only when that day is unsorted.                                                                           | Keep as shipped.                                                                                                               |          |
| Q2-139 | The sort affordance is viewer- and pending-gated (it's a write); overlap chips are not gated (read-only).                                                              | Keep as shipped.                                                                                                               |          |
| Q2-140 | The sort PUT reuses `useDayOrder`'s rollback/invalidation/ErrorBanner plumbing.                                                                                        | Keep as shipped.                                                                                                               |          |
| Q2-141 | The add/edit form's conflict notice is derived live, never latched — no dismiss affordance, can't desync.                                                              | Keep as shipped.                                                                                                               |          |
| Q2-142 | Conflict notice copy names up to three overlapping items then "and N more"; states overlaps are allowed.                                                               | Keep as shipped.                                                                                                               |          |
| Q2-143 | The booking form's conflict notice derives from the shared server derivation (`deriveAutoItems`), not a client re-derivation.                                          | Keep as shipped.                                                                                                               |          |
| Q2-144 | A half-filled datetime produces no conflict notice (no placement, nothing to warn about).                                                                              | Keep as shipped.                                                                                                               |          |
| Q2-145 | A spanning-lodging candidate warns about nothing (ambient); a same-day lodging (check-in=check-out) warns normally.                                                    | Keep as shipped.                                                                                                               |          |
| Q2-146 | `useFormConflicts` reads the two plan queries from cache rather than taking props.                                                                                     | Keep as shipped.                                                                                                               |          |
| Q2-147 | New testIDs (leg sheet, leg error, overlap, conflict) flagged for the §2.9 spec-sync batch.                                                                            | Keep as shipped; fold into the testID spec-sync row.                                                                           |          |
| Q2-148 | Leg row keys AND the chip testID are day-scoped (`itinerary-leg-{date}-{fromItemId}`, changed from the §2.9 spelling).                                                 | Keep as shipped; the §2.9 id itself needs updating in the spec-sync batch.                                                     |          |
| Q2-149 | "Sort by time" fires the `actionLight` haptic (a tap that commits a gesture's result uses the tap vocabulary).                                                         | Keep as shipped; add the convention line to tokens §2.8.                                                                       |          |
| Q2-150 | A same-place pair (`same_place` provider, zero-duration/distance) renders no leg chip at all.                                                                          | Keep as shipped.                                                                                                               |          |
| Q2-151 | An unknown parent booking on an item counts as LOCATED (stops the leg scan rather than skipping and misdrawing).                                                       | Keep as shipped.                                                                                                               |          |

### PR #19 — T-7.9 booking/item detail + offline degrade (29 items)

| #      | Interpretation (as shipped)                                                                                                     | Rec                                                                                 | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Q2-152 | Cancel leaves you ON the detail screen (the Cancelled badge is the confirmation); Delete pops (the row is gone).                | Keep as shipped.                                                                    |          |
| Q2-153 | `cancelled` is terminal in the UI (no status/cancel buttons), but Delete still works.                                           | Keep as shipped.                                                                    |          |
| Q2-154 | Status actions render as buttons, not a segmented control, on the detail screen.                                                | Keep as shipped.                                                                    |          |
| Q2-155 | New testID family `booking-detail-button-status-{status}` — not in the §2.9 inventory.                                          | Keep as shipped; fold into spec-sync.                                               |          |
| Q2-156 | Other new detail-screen testIDs (status/price/source/confirmation/field/loading/error/missing/banner) — flagged for spec-sync.  | Keep as shipped; fold into spec-sync.                                               |          |
| Q2-157 | ConfirmDialog ids derive from the triggering button (`booking-detail-button-cancel` → `…-confirm`/`…-cancel`).                  | Keep as shipped.                                                                    |          |
| Q2-158 | Empty detail fields are omitted from the render, not shown dashed.                                                              | Keep as shipped.                                                                    |          |
| Q2-159 | Detail datetimes render as destination WALL time (sliced, never through `Date`).                                                | Keep as shipped.                                                                    |          |
| Q2-160 | Multi-item bookings (car rental, lodging spans) collapse their schedule row to one line ("through {day}"/"N entries").          | Keep as shipped.                                                                    |          |
| Q2-161 | A zero-item booking gets a non-pressable "Not on the calendar" row, with copy that differs for idea vs. cancelled.              | Keep as shipped.                                                                    |          |
| Q2-162 | The place and expenses rows jump to the TAB, not a screen inside it (no place names on the wire yet).                           | Keep as shipped.                                                                    |          |
| Q2-163 | The expenses row always renders, even with zero linked expenses.                                                                | Keep as shipped.                                                                    |          |
| Q2-164 | The `?day=` return jump only retargets list mode, never the grid's own column state.                                            | Keep as shipped.                                                                    |          |
| Q2-165 | The `?day=` param is narrowed by `typeof` at the boundary; membership in the trip's day set is the real guard.                  | Keep as shipped.                                                                    |          |
| Q2-166 | Offline is DERIVED from transport failures (`ApiRequestError(0)`), not independently measured.                                  | Keep as shipped; a true connectivity signal is offline-spec scope, not this task's. |          |
| Q2-167 | Offline outranks a refresh error and shows no retry over retained data (no-cache branch keeps its retry).                       | Keep as shipped.                                                                    |          |
| Q2-168 | The offline banner fires trip-wide, even if only the `[tripId]` guard's own read failed.                                        | Keep as shipped.                                                                    |          |
| Q2-169 | Offline disables deeplinks but never materializes an omitted URL (e.g., Eventbrite outside a covered city).                     | Keep as shipped.                                                                    |          |
| Q2-170 | The deeplink offline hint outranks the "Needs …" field hint when both are true.                                                 | Keep as shipped.                                                                    |          |
| Q2-171 | The deeplink panel stays visible for viewers (a partner search isn't a write; every actual write stays hidden).                 | Keep as shipped.                                                                    |          |
| Q2-172 | The detail surface reuses the form's `stateFromDetails`→`deeplinkInputFor` mapping rather than a second one.                    | Keep as shipped.                                                                    |          |
| Q2-173 | The booking-kind cross-item hand-off uses `router.replace`, not `push` (avoids a bounce-back stack entry).                      | Keep as shipped.                                                                    |          |
| Q2-174 | Item detail resolves from the composite read, not a per-item GET (no such endpoint exists).                                     | Keep as shipped.                                                                    |          |
| Q2-175 | `itemWhenLabel` reads "No time set" for an untimed item rather than an empty row.                                               | Keep as shipped.                                                                    |          |
| Q2-176 | The copy affordance flips to "Copied" and stays for the life of the screen (no timed revert).                                   | Keep as shipped.                                                                    |          |
| Q2-177 | The clipboard engine is RN core `Clipboard` behind a one-file seam (`expo-clipboard` = a reported, untaken new-dep escalation). | Keep as shipped.                                                                    |          |
| Q2-178 | Cross-tab navigation uses a new `jumpToTripTab` helper that degrades to a no-op instead of throwing on a miss.                  | Keep as shipped.                                                                    |          |
| Q2-179 | A cross-tab jump records the manual tab selection (`rememberTab`), same as a real tab-bar press.                                | Keep as shipped.                                                                    |          |
| Q2-180 | The booking-detail missing state is terminal (no retry) for a bad/404 id; other pre-data errors get a retry banner.             | Keep as shipped.                                                                    |          |

### PR #67 — booking-form validation UX polish (4 items — about to merge)

| #      | Interpretation (as shipped)                                                                                                                                      | Rec                                                                                                                                                           | Decision |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-181 | Only `title` is required — every other booking field stays optional by design (a flight with no departure time is currently savable).                            | Keep as shipped unless a real floor is wanted (e.g. flight ⇒ departure date+time). If so, it's a shared-schema change everyone inherits — a real alternative. |          |
| Q2-182 | Required-indicator design: a danger-colored `*` beside the label, a "* Required" legend, `", required"` in the a11y name.                                        | Keep as shipped.                                                                                                                                              |          |
| Q2-183 | Banner wording when every error maps to a field names the fields once ("These fields need attention: Name, Currency.") rather than repeating each message twice. | Keep as shipped.                                                                                                                                              |          |
| Q2-184 | Raw Zod/server validation text is shown as-is (can read as developer-ish, e.g. "Too small: expected string to have >=1 characters").                             | Keep as shipped until a per-rule copy table is written — that's a spec artefact, not invented here.                                                           |          |

---

## Maps & places (101 items)

⚠️ Top of group — read these two first:

| #      | Interpretation (as shipped)                                                                                                                                                                                                                                                                        | Rec                                                                                                                                                                                                | Decision |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-185 | **Map pin-coverage structural closure (PR #23 interp 1, JUDGE MERGE CONDITION):** itinerary/booking pins render only when the item's place is ALSO saved (items/bookings carry no lat/lng on the wire, §2.1 forbids a map-specific endpoint). Declared spec-tolerable interim; closure is unowned. | Choose: (a) embed place rows in the itinerary composite read (server contract change) or (b) client fan-out over PL-3 `GET /places/:placeId`. Real alternative — needs a pick, not a rubber-stamp. |          |
| Q2-186 | **R-map-18 activation-mount ruling (PR #27 interp 4):** the offline-pack auto-download pill/controller mounts only on the map-tab or settings surface, so a trip flipping `active` before either mounts downloads only on the NEXT visit.                                                          | Choose: mount `useOfflinePackController` at the root layout (closes the one-visit-late gap) vs. accept surface-mount semantics as documented. Real alternative, one-line fix either way.           |          |

### PR #20 — T-8.6 native scaffold / map color + token choices (5 items)

| #      | Interpretation (as shipped)                                                                                                                                                             | Rec              | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| Q2-187 | Day-pin colors draw only from the four shared status ramps (info/success/warning/danger), two stops each, hue-interleaved — accent/primary/neutral are reserved for other pin families. | Keep as shipped. |          |
| Q2-188 | `pinPhotoRing`/`routeLine`/`dimOpacity` token values chosen (neutral ring, info route line, 0.35 dim) — tunable at the T-8.2 consumer if QA disagrees.                                  | Keep as shipped. |          |
| Q2-189 | Location "when in use" purpose string: "Allow $(PRODUCT_NAME) to use your location to show where you are on the trip map while the app is open."                                        | Keep as shipped. |          |
| Q2-190 | `clusterFill`/`clusterText` use the AA-validated `primary.solid`/`primary.onSolid` pairing (no dedicated cluster color exists in spec).                                                 | Keep as shipped. |          |
| Q2-191 | `pinSelectedRing` uses `border.focus` (the theme's existing "this is selected" affordance, no dedicated color specced).                                                                 | Keep as shipped. |          |

### PR #21 — T-8.1 place detail + saved-places CRUD (14 items)

| #      | Interpretation (as shipped)                                                                                                                 | Rec                                                                        | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| Q2-192 | `?fresh=true` reason codes chosen: `no_fsq_id` for non-FSQ places, `disabled` for `fsq_os` places (no FSQ integration deployed).            | Keep as shipped.                                                           |          |
| Q2-193 | `?fresh=false` is treated as "not requested" — no `no-store`, no reason.                                                                    | Keep as shipped.                                                           |          |
| Q2-194 | `no-store` applies to every response to a fresh-requesting call, including the 404 arm (no existence oracle).                               | Keep as shipped.                                                           |          |
| Q2-195 | Saved-place list ordering is `created_at DESC, id DESC` (spec pins pagination, not order).                                                  | Keep as shipped.                                                           |          |
| Q2-196 | Saved-place list `limit` cap is 100 (spec names the default, not a max).                                                                    | Keep as shipped.                                                           |          |
| Q2-197 | Saved-place `note` cap is 2000 chars, matching the repo's other notes-like-prose fields; empty string allowed, `null` = no note.            | Keep as shipped.                                                           |          |
| Q2-198 | Already-saved 409 detail shape is `{ reason: "already_saved" }`, mirroring the custom-place-delete 409 precedent.                           | Keep as shipped.                                                           |          |
| Q2-199 | The attribution registry is NOT widened with `foursquare_api`/`mapbox` yet — deferred to the integrations that can honestly verify wording. | Keep as shipped; flagged for reviewer ruling if Sean wants it widened now. |          |
| Q2-200 | `FreshPlaceDetails` field types ship as contract placeholders (caps, ranges) pending the real FSQ integration.                              | Keep as shipped.                                                           |          |
| Q2-201 | A malformed `place_id` in a POST body → 400 (shared-schema boundary door); the `:savedPlaceId` path param folds to 404.                     | Keep as shipped.                                                           |          |
| Q2-202 | PATCH/DELETE on a saved place skip a separate visibility re-check (the row's trip presence IS the grant).                                   | Keep as shipped.                                                           |          |
| Q2-203 | The POST visibility check runs on the bare client, no transaction — DB races closed by constraint instead.                                  | Keep as shipped.                                                           |          |
| Q2-204 | The premium FSQ feature (client, entitlement read, rate guards) ships deferred WITH the integration, not built now.                         | Keep as shipped.                                                           |          |
| Q2-205 | v1 never sends `?fresh=true` — Gate-2 outranks §2.3's literal wording, shipped built-and-tested behind a flag.                              | Keep as shipped.                                                           |          |

### PR #23 — T-8.2 map shell (17 items — pin-coverage closure pulled out above)

| #      | Interpretation (as shipped)                                                                                                                                                          | Rec                                                                                                       | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------- |
| Q2-206 | A zero-span camera fit (single pin or all pins at one coordinate) centers at fixed zoom 14 rather than fitting a degenerate envelope.                                                | Keep as shipped.                                                                                          |          |
| Q2-207 | "All" re-selection refits the camera to all pins; an empty day subset moves the camera nowhere.                                                                                      | Keep as shipped.                                                                                          |          |
| Q2-208 | Day-filter chips span only the trip's own date range; out-of-range items still pin under "All" but get no chip.                                                                      | Keep as shipped.                                                                                          |          |
| Q2-209 | Pin glyph day numbers are 1-based in range; out-of-range pins show their raw arithmetic number (0, -1, …).                                                                           | Keep as shipped.                                                                                          |          |
| Q2-210 | `map-pin-*`/`map-cluster-*` ids live in GeoJSON `properties.testID`, not RN `testID` props (style-layer pins aren't React views).                                                    | Keep as shipped.                                                                                          |          |
| Q2-211 | `map-sheet-attribution` testID is grammar-derived (inventory only names the opener `map-button-attribution`).                                                                        | Keep as shipped.                                                                                          |          |
| Q2-212 | Pin-glyph/count ink uses `mapColors.clusterText` — no dedicated pin-ink token exists.                                                                                                | Keep as shipped.                                                                                          |          |
| Q2-213 | No blocking loading UI on the map — the basemap itself is the loading surface; errored queries get a retry banner.                                                                   | Keep as shipped.                                                                                          |          |
| Q2-214 | The world-empty EmptyState renders only when there are no pins AND no usable destination coordinates.                                                                                | Keep as shipped.                                                                                          |          |
| Q2-215 | Pin layer z-order is honored per family (photo → saved → itinerary, clusters below pins within a family); a strict global ordering is unreachable with per-family clustered sources. | Keep as shipped.                                                                                          |          |
| Q2-216 | SDK ornament placement: logo bottom-left at token spacing, attribution control offset 96pt right.                                                                                    | Keep as shipped; exact fit is a phase-QA visual check.                                                    |          |
| Q2-217 | Photo-pin press is a shell no-op (the photo family is empty in prod; T-8.3 wires the real route).                                                                                    | Keep as shipped.                                                                                          |          |
| Q2-218 | Pending map-focus is last-set-wins and trip-scoped (a consume for a different trip discards and clears).                                                                             | Keep as shipped.                                                                                          |          |
| Q2-219 | Span-aware day rendering: a multi-day item stays pinned on EVERY covered day of the filter — a deliberate superset of the grid's check-in/check-out-only treatment.                  | Keep as shipped; the map/grid divergence is flagged, R-map-3 is ambiguous for spans.                      |          |
| Q2-220 | Saved-places pagination follows `nextCursor` to exhaustion, bounded at 10 pages (1000 pins).                                                                                         | Keep as shipped.                                                                                          |          |
| Q2-221 | A place that is both saved AND scheduled renders in BOTH pin families (double pin) — no dedup/merge.                                                                                 | Keep as shipped; dedup/merge across families is a real design alternative if double-pins read as clutter. |          |
| Q2-222 | The attribution (i) info button sits bottom-right (SDK ornaments own bottom-left) — later surfaces must compose around it.                                                           | Keep as shipped.                                                                                          |          |

### PR #24 — T-8.3 pin interactions + map search + foreground location (18 items)

| #      | Interpretation (as shipped)                                                                                                                                                                        | Rec                                                                                                                   | Decision |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-223 | Search geo bound is the destination-region envelope (spine-ingest coverage), not the live viewport — R-map-25's viewport-bias applies once camera state is exposed.                                | Keep as shipped.                                                                                                      |          |
| Q2-224 | Antimeridian search boxes clip rather than issuing two calls; wrapped neighbor cells drop.                                                                                                         | Keep as shipped.                                                                                                      |          |
| Q2-225 | The map-search query key is a disjoint family from destination search (global spine rows, tripId-suffixed for custom-place visibility).                                                            | Keep as shipped.                                                                                                      |          |
| Q2-226 | `trip_id` rides every map search; page limit pinned at 20 client-side.                                                                                                                             | Keep as shipped.                                                                                                      |          |
| Q2-227 | Search-pin color uses `mapColors.pinSelectedRing` (no dedicated search-pin color exists in tokens).                                                                                                | Keep as shipped.                                                                                                      |          |
| Q2-228 | The `search` pin family doesn't extend the frozen shell's `PinFamily` union — own structural types instead.                                                                                        | Keep as shipped.                                                                                                      |          |
| Q2-229 | Search-result selection lives in slot state as the full `Place` row; a result tap closes the sheet first, both sources clear on dismissal.                                                         | Keep as shipped.                                                                                                      |          |
| Q2-230 | Search bar sits top-overlay under the day-filter strip (48pt clearance); locate button bottom-right, stacked above the (i) attribution button.                                                     | Keep as shipped.                                                                                                      |          |
| Q2-231 | Offline search: the proactive arm disables the query outright; the reactive arm keys off the status-0 transport marker.                                                                            | Keep as shipped.                                                                                                      |          |
| Q2-232 | Nav handoff uses Google Maps URLs API only, coordinates as destination, no travelmode param (matches the T-7.5 ruling verbatim).                                                                   | Keep as shipped; same Apple Maps question as the T-7.5 item — don't re-litigate separately.                           |          |
| Q2-233 | This task ships Navigate + Details sheet actions only; Save/add-to-day/view-in-itinerary wait on T-8.4's concurrent mutation layer.                                                                | Keep as shipped.                                                                                                      |          |
| Q2-234 | Location permission rationale-first flow: a ConfirmDialog fronts the system prompt; a denial stops and waits for the next tap (no repeated prompt loop).                                           | Keep as shipped.                                                                                                      |          |
| Q2-235 | Locate is single-shot (`getCurrentPositionAsync`), no continuous `watchPositionAsync`; distance labels round with a "never misstate magnitude" boundary rule (999.6m→"1.0 km", 9999.6m→"10.0 km"). | Keep as shipped.                                                                                                      |          |
| Q2-236 | The camera-intent store is NOT trip-scoped (only carries the user's own location; worst case is a misplaced viewport).                                                                             | Keep as shipped.                                                                                                      |          |
| Q2-237 | The place sheet is always-mounted with a nullable place (avoids a refs-lint violation from an exit-frame content-retention alternative).                                                           | Keep as shipped.                                                                                                      |          |
| Q2-238 | An unresolvable `selectedPlaceId` (unsaved place) presents nothing — consistent with the interim pin-coverage limit, no improvised fallback.                                                       | Keep as shipped.                                                                                                      |          |
| Q2-239 | Granted-but-read-fails location (services off, transient GPS fault) raises the same "Location is off" Settings dialog as an outright denial.                                                       | Keep as shipped; a distinct failure-arm copy for the transient case is a real alternative, flagged for the spec-sync. |          |
| Q2-240 | Six shipped testIDs sit beyond the §2.8 inventory; a naming fork (`map-dialog-locate-*` vs. the `*-dialog` suffix convention) needs the spec-sync to pick one ordering.                            | Real alternative — pick one naming convention, apply repo-wide.                                                       |          |

### PR #25 — T-8.4 place detail screen + map↔itinerary linking (17 items)

| #      | Interpretation (as shipped)                                                                                                                   | Rec                                                                                             | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| Q2-241 | Place detail issues two queries (`usePlace` cacheable spine + `usePlaceFresh`) — §2.4's "dedicated query" read literally.                     | Keep as shipped.                                                                                |          |
| Q2-242 | `placeDetail`/`placeFresh` cache keys live outside the trips subtree (global auth-only reads; not evicted on trip-access loss).               | Keep as shipped.                                                                                |          |
| Q2-243 | Lives in `features/places/`, not `features/map/` (disjoint file set from T-8.3, by construction).                                             | Keep as shipped.                                                                                |          |
| Q2-244 | Distance-from-user is specced for the detail screen but currently unreachable (no location seam yet) — the W3/W4 rider owns wiring it.        | Keep as shipped.                                                                                |          |
| Q2-245 | The tour-guide entry point is not rendered yet (absent, not a broken tap) — lands with P-10.                                                  | Keep as shipped.                                                                                |          |
| Q2-246 | The public photos-by-place strip (map.spec §2.3, Gate-2 companion) is a SEPARATE, un-wired surface deferred to P-12.                          | Keep as shipped; P-12 must land the public-by-place strip, not just feed the trip-scoped strip. |          |
| Q2-247 | FSQ premium photo URLs are not rendered in this seam build (needs the deferred licensing/display pass).                                       | Keep as shipped.                                                                                |          |
| Q2-248 | Custom places render no attribution footer (the shared registry keys spine sources only).                                                     | Keep as shipped.                                                                                |          |
| Q2-249 | Save-conflict (409) semantics: optimistic row kept, list invalidated for truth; only non-409 errors reach the error handler.                  | Keep as shipped.                                                                                |          |
| Q2-250 | Unsave has no success-equivalent error status; failures roll back and invalidate.                                                             | Keep as shipped.                                                                                |          |
| Q2-251 | Place-note PATCH is non-optimistic (house precedent for non-save/unsave mutations).                                                           | Keep as shipped.                                                                                |          |
| Q2-252 | Cross-tab navigation from a place is a two-step jump (tab switch, then navigate in the now-active stack).                                     | Keep as shipped.                                                                                |          |
| Q2-253 | `item/new` gains `?placeId=`/`?placeName=` params; malformed/repeated params degrade to the empty picker.                                     | Keep as shipped.                                                                                |          |
| Q2-254 | Navigate disables offline on the DETAIL SCREEN half of the R-map-8 action (superseded for the SHEET half by PR #26 — see that item).          | Keep as shipped; the pair's divergence is reconciled in PR #26 below.                           |          |
| Q2-255 | The dependency guard scope exempts test/test-utils files and includes `package.json` (a dependency violation exists before its first import). | Keep as shipped.                                                                                |          |
| Q2-256 | Linked map rows land on the item's OWN detail per kind — booking-kind pushes `booking/[bookingId]` directly, not through `item/[itemId]`.     | Keep as shipped (R1 blocker fix — avoids a back-stack bounce).                                  |          |

### PR #26 — T-8.7 P-8 integration rider (13 items)

| #      | Interpretation (as shipped)                                                                                                                                           | Rec                                                                                        | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Q2-257 | Search temp pins render topmost (last ShapeSource child, above every other pin family).                                                                               | Keep as shipped.                                                                           |          |
| Q2-258 | Navigate ships ENABLED offline on BOTH R-map-8 surfaces (supersedes PR #25's detail-only disable) — an external nav launch can work offline.                          | Keep as shipped.                                                                           |          |
| Q2-259 | Search-selection state was LIFTED from slot to screen (only screen-side can observe a search-pin tap).                                                                | Keep as shipped.                                                                           |          |
| Q2-260 | `selectedItemId` rides the map-sheet seam so "View in itinerary" lands on the RIGHT item for a place visited twice.                                                   | Keep as shipped.                                                                           |          |
| Q2-261 | AppState re-sync (location permission) is transition-only, no mount-time read; a previously-granted permission shows no puck until the first background→active cycle. | Keep as shipped; a one-line mount-time `get` closes the gap if phase QA finds it annoying. |          |
| Q2-262 | A location revoke clears the last-known position, so every "distance when puck active" label can't render stale.                                                      | Keep as shipped.                                                                           |          |
| Q2-263 | The place sheet's action row wraps 2-up (up to 4 actions); exact layout is a phase-QA visual check.                                                                   | Keep as shipped.                                                                           |          |
| Q2-264 | Sheet save errors get their own banner (`map-sheet-place-action-error`), distinct from the Navigate-failure banner.                                                   | Keep as shipped.                                                                           |          |
| Q2-265 | New testIDs beyond the §2.8 inventory (save/add-to-day/view-in-itinerary buttons, badges, dialogs) — flagged for spec-sync.                                           | Keep as shipped; fold into the testID spec-sync row alongside PR #24's list.               |          |
| Q2-266 | Location-unavailable dialog copy: "Couldn't get your location" / "…Location Services may be off, or the signal dropped. Check Settings, or try again in a moment."    | Keep as shipped.                                                                           |          |
| Q2-267 | The place sheet resolves a linked item's kind from the same cache the map's own pin builder reads (map and sheet can't disagree).                                     | Keep as shipped.                                                                           |          |
| Q2-268 | Add-to-day is hidden from viewers (mirrors T-8.4's identical place-detail posture).                                                                                   | Keep as shipped.                                                                           |          |
| Q2-269 | The jest mock for `@rnmapbox/maps` omits `setTelemetryEnabled`; the guard feature-detects and returns false under test only (test-infra note).                        | Keep as shipped; add the mock method at the next jest.setup touch.                         |          |

### PR #27 — T-8.5 offline StylePacks/TileRegions lifecycle (16 items — R-map-18 pulled out above)

| #      | Interpretation (as shipped)                                                                                                                                  | Rec                                                                                                                   | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-270 | Antimeridian/pole envelope math: wrapping neighbor cells shift ±360°; pole-dropped neighbors simply don't extend the envelope.                               | Keep as shipped.                                                                                                      |          |
| Q2-271 | No SDK size-estimate API exists in Mapbox 10.3.5 — size is a deterministic tile-count × 12KB approximation, labeled `~` everywhere.                          | Keep as shipped; phase QA calibrates the constant against a real download.                                            |          |
| Q2-272 | Auto-download arms only from `none` — a `stale` pack requires a manual refresh, never a silent re-download.                                                  | Keep as shipped.                                                                                                      |          |
| Q2-273 | Orphan pack sweep targets only unaccounted packs (no local MMKV annotation) — a paginated trip list can't safely be the sweep's source of truth.             | Keep as shipped; a remotely-deleted trip's local pack persists until sweep/hook conditions catch it — documented gap. |          |
| Q2-274 | A `failed` download state is session-scoped (not annotated); after restart it reads `none` and re-attempts on the next wifi window.                          | Keep as shipped.                                                                                                      |          |
| Q2-275 | Packs download the CURRENT theme's style URL; a theme flip marks the pack `stale` in the management UI only, never nags via the pill.                        | Keep as shipped.                                                                                                      |          |
| Q2-276 | R-map-20's "prompt on active→past" ships as a non-blocking offer line on management surfaces (no background transition observer exists to hang a modal off). | Keep as shipped.                                                                                                      |          |
| Q2-277 | `setTileCountLimit` is never called (Mapbox ToS) — enforced structurally via a mock that omits it, so a prod call would fault loudly.                        | Keep as shipped.                                                                                                      |          |
| Q2-278 | Delete/leave pack hygiene rides the `exitToTripList` exit surface — fire-and-forget so cleanup never blocks navigation.                                      | Keep as shipped.                                                                                                      |          |
| Q2-279 | Pack completion = `percentage >= 100` (the SDK's own example contract, since the numeric state enum can't be mocked).                                        | Keep as shipped.                                                                                                      |          |
| Q2-280 | The unusable-destination guard (NaN coords) stands the whole pack machine down — no fingerprint, no effects.                                                 | Keep as shipped.                                                                                                      |          |
| Q2-281 | The offline pill hides for online settled states (`none`/`ready`/`stale`) — stale nudges live only in the management UI.                                     | Keep as shipped.                                                                                                      |          |
| Q2-282 | Pack reconcile removes an SDK pack with no annotation for the current trip (same policy as the sweep; SDK is the source of truth).                           | Keep as shipped.                                                                                                      |          |
| Q2-283 | The cellular-data ConfirmDialog also fronts refresh and retry downloads, not just first download (same data cost).                                           | Keep as shipped.                                                                                                      |          |
| Q2-284 | "Unmetered wifi" = `NetworkStateType.WIFI` + `isConnected` (iOS exposes no metered-ness signal).                                                             | Keep as shipped.                                                                                                      |          |
| Q2-285 | Ready-state pack display derives from the MMKV annotation first, verified against the SDK asynchronously (no-flash posture; drift self-corrects).            | Keep as shipped.                                                                                                      |          |

---

## Trips & collaboration (4 items)

### P-6 client-trips spec-pass questions (batched, non-blocking)

| #      | Interpretation (as shipped)                                                                                                                        | Rec                                                                                                                          | Decision |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-286 | A second "leave trip" entry on the MEMBERS screen was trimmed per §2.1; the capability still exists via settings.                                  | Keep as shipped (capability retained via settings; the MEMBERS-screen entry is a small revert if wanted — real alternative). |          |
| Q2-287 | The §2.1 "join-entry home" spec text says "EmptyState and header overflow" — the DS has no overflow menu, so a footer+Sheet stopgap ships instead. | Amend §2.1 to match the stopgap (recommended), or spend design time on a true overflow affordance — real alternative.        |          |
| Q2-288 | The archive/status-override surface: the API grants the owner capability (§3.2), but the client renders no row for it — wire plumbing is ready.    | Choose: surface it somewhere on the client, or leave it API-only for now — real alternative.                                 |          |
| Q2-289 | §2.5's "Push → form/picker" behavior column is instead an inline details card + theme/currency Sheets (members-Sheet precedent).                   | Bless as-is and amend §2.1/§2.5 wording to match.                                                                            |          |

---

## Forms & pickers (6 items)

### PR #51 — B-20 questionable list Q1–Q4

| #      | Interpretation (as shipped)                                                                                                                                                             | Rec                                                                                                           | Decision |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-290 | Q1 — confirmation-code field: free-form text, uppercase-normalized at the wire, no 6-char lock.                                                                                         | Keep free-form + uppercase; revisit a lock after B-9's airport/airline lookup work lands.                     |          |
| Q2-291 | Q2 — wire IATA-code narrowing (3-letter, uppercase) is enforced client-side now; wire-side narrowing rides B-9's client half.                                                           | Keep as shipped — client gate now, wire narrowing later.                                                      |          |
| Q2-292 | Q3 — cabin-class chips render client-side only; no server enum exists yet.                                                                                                              | Keep as shipped — next itinerary touch can wire the server side if wanted.                                    |          |
| Q2-293 | Q4 — payment-handle client field mirrors the server's char cap, but a 31-char prefix-less handle currently passes the client check and fails the 30-char write schema (generic banner). | Fix the client cap to match the write schema at the next touch — real, low-cost fix, not just a rubber-stamp. |          |

### PR #49 — picker follow-up options (Sean-decision-pending, recorded so they survive the PR body)

| #      | Interpretation (as shipped)                                                                                                                                              | Rec                                                                                                         | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| Q2-294 | Native calendar picker: Done is the one committed action path; tap-the-highlighted-day-to-commit needs a custom calendar (or day-cell hit detection) to add.             | Keep Done-only as shipped, or invest in a custom calendar for tap-to-commit — real alternative, no urgency. |          |
| Q2-295 | Time spinner commits on first wheel settle (hour then minute = two opens); a draft-until-Done model would touch the ScheduleSheet/IdeasBucket immediate-commit contract. | Keep as shipped, or take draft-until-Done as its own task — real alternative, contract-changing either way. |          |

---

## Infra & other (5 items)

| #      | Interpretation (as shipped)                                                                                                                                                                                   | Rec                                                                                                                                                                                               | Decision |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q2-296 | **B-1 — F-001 ledger step 2 is unsatisfiable as written** (Postgres assignment cast rounds numeric→bigint on the append-only feature ledger). Needs Sean's nod on an amendment protocol before B-1 can build. | Approve an append-only-safe amendment protocol (e.g. a superseding note appended alongside the unsatisfiable step, never editing it in place) — needs an actual product call, not a rubber-stamp. |          |
| Q2-297 | **DisplayName bidi/zero-width (`\p{Cf}`) hardening** — beyond R-user-2's existing "no control chars" rule; a blanket rejection would break legitimate emoji-ZWJ names.                                        | Needs a product call on where the line sits (which `\p{Cf}` code points to allow) — not a rubber-stamp.                                                                                           |          |
| Q2-298 | **Object-storage provider pick** (avatars now, trip photos at P-12) — the provider-agnostic `ObjectStorage` port ships and fails safe; Sean deferred the actual provider pick 2026-07-24 to revisit at P-12.  | Reaffirm the deferral to P-12 (recommended — Cloudflare R2 remains the standing recommendation when it's time), or pick now if P-12 is closer than expected.                                      |          |
| Q2-299 | **Branch protection / ruleset on `main`** — `ci-success` is not a required check, so a merge can land with CI red; every "CI green before merge" has been agent discipline, not a mechanism.                  | Approve adding a ruleset on `main` requiring `ci-success`; consider also requiring PRs. Repo-settings change — needs Sean's own action either way.                                                |          |
| Q2-300 | **`format:check` in the CI gate** — the repo-wide prettier sweep (PR #64) landed and `main` is clean, but adding `format:check` to the blocking CI gate itself was left undecided.                            | Approve adding `format:check` to the CI gate now that the sweep is clean — low-risk, prevents re-drift.                                                                                           |          |

---

## What flips when approved

Once Sean replies, a follow-up doc-writeback pass should:

**QUEUE rows `blocked` → `done`** (spec text amended, nothing left to build for the interpretation itself):

- P-9 spec-pass batch row (PRs #31/#32/#56/#57) → `docs/QUEUE.md` Blocked row citing PR #56/#57
- B-20 Q1–Q4 row (PR #51)
- Picker follow-up row (PR #49) — items ① and ② close; item ③ still rides the Android pre-launch pass, row stays open for that
- P-6 client-trips spec-pass row
- P-7 api spec-pass batch #2 row (PR #12) + its T-7.8 (PR #14) bundle
- P-7 api spec-pass single-question row (PR #11)
- T-7.6 spec-pass batch row (PR #17) — the two already-ruled money items stay marked RULED; only the remaining 25 close
- T-7.4 + T-7.7 + T-7.5 combined row (PRs #15/#16/#18)
- T-7.9 spec-pass batch row (PR #19)
- Map pin-coverage structural closure row (PR #23) — also clears the judge merge condition retroactively noted against P-8
- R-map-18 activation-mount ruling row (Active table, priority P1)
- P-8 spec-pass batch row (PRs #20/#21/#23/#24/#25/#26/#27)
- B-1 row (once the amendment protocol is picked, B-1 itself moves `blocked` → `queued`, ready to build)
- DisplayName bidi row (once the code-point line is picked, moves `blocked` → `queued`)
- Branch-protection row (once Sean applies the ruleset — a repo-settings action, not a doc edit)
- `format:check`-in-CI-gate row (once approved, becomes a `queued` one-line CI task)

**Stays `blocked`, reaffirmed:** object-storage provider pick (still parked for P-12 unless Sean picks now).

**Spec files needing the ruling written back:**

- `.specs/server/money.spec.md` + `.specs/api/*` money router docs (P-9 batch — the SR/B/FX items + settle/expense interpretations)
- `.specs/client/itinerary.spec.md` §2.2/§2.3/§2.4/§2.5/§2.6/§2.7/§2.9 (T-7.4/6/7/9 batches — this is the biggest single write-back; consider doing it as its own pass)
- `.specs/api/*` itinerary router docs, R-ib-13..17, R-ib-15 wording (PR #12 batch)
- `.specs/client/directions.ts` / travel-legs §2.7 (Apple Maps variant decision, T-7.5 + T-8.3 both cite it — one ruling closes both)
- `.specs/client/map.spec.md` §2.2/§2.4/§3.3/§3.4, R-map-3/-5/-6/-18/-20/-25 (P-8 batch + the two top-of-group items)
- `.specs/client/places.spec.md` §3.2.4, R-places-14/17 (T-8.1 attribution-registry deferral)
- `.specs/client/trips.spec.md` §2.1/§2.5 (P-6 client-trips batch)
- `.specs/design-system/tokens.spec.md` §2.8 (the `actionLight` haptic convention from T-7.5)
- The accumulating **§2.7/§2.8 testID spec-sync batch** (existing QUEUE row) — nearly every group above flags new testIDs; fold them all in one pass once this round is approved, including the `map-dialog-locate-*` naming-fork pick
- `.specs/client/contracts.spec.md` (B-20 confirmation-code casing, already partly written)
- A new or amended ADR/QUEUE note for the B-1 append-only ledger amendment protocol

---

## Resolution protocol

Same as Round 1: approved answer → edit the canonical spec (write the rule,
strike the interpretation from the source PR body's "needs a ruling" framing)
→ flip the QUEUE row → note in PLANNING's Decisions Log if cross-phase. This
round's items do not touch `.specs/OPEN-QUESTIONS.md` itself once resolved —
they stay here as the decision record, same as Round 1 above.
