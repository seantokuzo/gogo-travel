# Gate 2 Punch List — Open Questions from the Spec Suite

> Every unique `[NEEDS CLARIFICATION]` marker across the 18 spec files, deduped
> (verbatim repeats resolve at their canonical home), grouped by theme, each
> with a recommendation. **Decision protocol:** Sean approves wholesale or
> flags items; each answer gets written back into the canonical spec and the
> marker removed. Items marked ⚠️ have NO sensible default — Sean must supply.
> Rec = my recommendation.

## A. Identity & brand

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| A1 ⚠️ | Brand accent palette / visual identity | none — Sean supplies (or I propose 3 palettes to pick from) | tokens.spec:90 |
| A2 | Which accent themes ship v1, how many | 3 themes (default + 2), proven re-skin seam | tokens.spec:94 |
| A3 ⚠️ | Universal-link domain (AASA/assetlinks) | Sean picks/buys (gogo.travel / gogotravel.app / subdomain of seantokuzo.dev) | navigation.spec:100 |
| A4 | Custom fonts vs system v1 | System (SF Pro/Roboto) v1; custom font = later theme upgrade | tokens.spec:103 |
| A5 | In-app haptics toggle | OS-setting only v1 | tokens.spec:106 |
| A6 | Theme scope: trip theme vs user accent | User-level accent pref; trip theme colors small trip accents only, NOT whole-app re-skin v1 | tokens.spec:98 |

## B. Trips & collaboration

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| B1 | Trip dates required at creation? | Required v1 (unlocks season/AI/tile triggers); date-less trips deferred | schema.spec:280 |
| B2 | Destination input: structured vs free text | Structured search against Overture city/locality subset (free, no new dependency); guarantees lat/lng | schema.spec:281 (+trips client:214) |
| B3 | Trip status transitions | Date-derived + manual override allowed (override wins until cleared) | schema.spec:282 |
| B4 | Ownership transfer / owner leaves | Owner may transfer; leaving requires transfer first | schema.spec:296 |
| B5 | Invite links | Multi-use, 7-day default expiry, revocable, optional max_uses | schema.spec:314 |
| B6 | Multi-active-trip cold-launch landing | Most-recently-viewed active trip; trip switcher in header | navigation.spec:119 |
| B7 | Viewer role boundary | Viewers CAN log expenses + upload photos (they're travelers); CANNOT edit itinerary/bookings/settings | trips.spec:230 + money.spec:211 |
| B8 | Base-currency change semantics | Base currency locks once the first expense exists | trips.spec:645 |
| B9 | Trip-level "visibility" concept | Drop from v1 (trips are member-private; only photos have visibility) | trips.spec:655 |
| B10 | Member removal with nonzero balance | Allowed; ledger rows survive (R-db-16 posture), balances still shown | money.spec:218 |
| B11 | Collaborator-activity ticker | Defer activity feed to v2; v1 today-view drops the ticker | today.spec:193 |

## C. Money

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| C1 | Expense/budget category taxonomy | Fixed enum v1: lodging, transport, food, activities, shopping, other (aligned w/ booking categories) | schema.spec:192 |
| C2 | Multi-currency FX policy | Store original cents + base cents + rate captured at entry; rate auto-fetched when online (free FX API = new dependency, see escalations), manual override always | schema.spec:446 |
| C3 | Expense deletion | Soft-delete with visible audit trail | schema.spec:447 |
| C4 | Overall trip budget cap | Yes — optional overall cap alongside per-category | schema.spec:494 |
| C5 | Debt simplification default | Off by default; one-tap "simplify debts" view toggle (Splitwise trust precedent) | money.spec:113 |
| C6 | Settlement correction | Recorder may delete own settlement ≤24h; after that, counter-entry only | money.spec:133 |
| C7 | settlement_requests table (entity addition) | Approve | money.spec:157 |
| C8 | Split-type persistence | Persist resolved cents only v1; split_meta later if re-edit demanded | money.spec:220 |
| C9 | Party-size source for booking deeplinks | Default adults = trip member count; editable per search | itinerary client:179 |

## D. Capture

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| D1 | Auto-file vs always-confirm | High-confidence parses auto-file + push notification with one-tap undo; medium/low → review queue. (The TripIt "magic" depends on auto-file.) | capture.spec:141 |
| D2 | Registered sender addresses (entity addition) | Approve — verified additional senders table (Apple private-relay reality) | capture.spec:69 |
| D3 | Capture LLM vs 30/day AI cap | Does NOT count against AI cap; separate structural ceiling (20 captures/day) | schema.spec:197 |
| D4 | Raw capture retention (PII) | Delete raw payload on confirm or after 30 days, whichever first | schema.spec:514 |
| D5 | Capture queue surface | Trips-level inbox (captures can precede trip assignment) + per-trip filtered view | navigation.spec:113 |

## E. Auth & profile

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| E1 | Apple↔Google identity linking | Auto-link on verified matching email | schema.spec:233 |
| E2 | Account deletion strategy | Soft-delete + PII scrub; ledger rows survive as "Deleted user" | schema.spec:117 |
| E3 | Session management UI v1 | Endpoints + minimal list/revoke screen in settings | auth-users.spec:503 |
| E4 | Apple sign-in client mechanism | Native `expo-apple-authentication` (App-Review-favored; server contract unchanged) — technical, decided unless objection | auth-users.spec:269 |
| E5 | Onboarding contents | Name/avatar → home currency → payment handles (skippable) → notification priming; travel_style optional prompt | navigation.spec:104 |
| E6 | Profile/settings home | Avatar button on trips-list header (outside trip context) | navigation.spec:108 |
| E7 | travel_style taxonomy | Multi-tag, fixed set: budget, comfort, luxury, foodie, adventure, culture, nightlife, family, relaxation | contracts.spec:189 |

## F. Places & maps

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| F1 | POI ingestion source set | Both Overture + FSQ OS; Overture wins dedup priority | places.spec:154 |
| F2 | place_ingest_regions table + ingest job (entity addition) | Approve | places.spec:162 |
| F3 | Foursquare premium details in MVP | Defer — MVP is spine-data-only ($0); revisit post-launch | places.spec:168 |
| F4 | Map place-discovery affordance | Search bar on map tab (spine-backed), no basemap-POI tap-through v1 | map.spec:183 |
| F5 | Persistent mini-map in plan mode | Defer to polish phase; strong map-tab linkage first | itinerary client:188 |

## G. Photos

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| G1 | Is photo+caption the whole v1 "reviews" surface? | Yes — no separate review concept v1 | schema.spec:540 |
| G2 | Where public photos surface for non-members | Place detail sheet only v1 (destination gallery later) | schema.spec:541 |
| G3 | Photo moderation | Trip owner may delete any photo within the trip | photos.spec:166 |
| G4 | Member leaves trip → photos | Photos remain in trip; uploader retains delete rights | photos.spec:171 |
| G5 | Location-consent posture | Per-upload opt-in; remembered default after first consent | photos.spec:177 |

## H. AI, notifications, utilities

| # | Question | Rec | Canonical |
|---|----------|-----|-----------|
| H1 | Per-feature AI ceilings | Approve proposed: recs 10/day, expense-est 10/day, packing 5/day, tour-guide 50 places/trip, recap 1/trip | ai.spec:77 |
| H2 | Packing-list cache policy | Live-uncached (personal, cheap on Haiku) | ai.spec:413 |
| H3 | Tour-guide pre-gen trigger | T-3 days before trip start (+ manual "prepare offline" button) | ai.spec:609 |
| H4 | AI content English-only v1? | English-only; no locale in cache key yet | schema.spec:580 |
| H5 | Packing lists shared vs per-member | Shared per trip v1 (simplest useful) | schema.spec:613 |
| H6 | Recap persistence home | Approve new `recaps` table (entity addition) | schema.spec:783 |
| H7 | Flight-status provider | Defer to v2 (no provider researched; alerts are TripIt's paid moat — do it right later) | notifications.spec:149 |
| H8 | Day-ahead digest timing | 8pm trip-local time; fallback device timezone | notifications.spec:288 |
| H9 | Offline caching of document scans | No offline doc scans v1 (security > convenience) | notifications.spec:295 |
| H10 | Non-member settle-request links | Require app install + account v1 (no web surface exists); revisit with any web phase | navigation.spec:122 |
| H11 | Multi-day bookings on the calendar | Spanning all-day lane on grid; check-in/check-out point items on day list (branch pre-mapped in itinerary spec) | schema.spec:401 |

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
