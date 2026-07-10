# Client — Money (budget · expenses · balances · settle-up) — `.specs/client/money.spec.md`

> **Task:** T-2.3 (MONEY bundle) · **Status:** DRAFT — pending Sean approval
> (P-2 gate 3). Not approvable until zero `[NEEDS CLARIFICATION]` markers
> remain.
>
> **Sources:** `CLAUDE.md` Law #2 (integer cents) ·
> `.specs/client/navigation.spec.md` (**CANONICAL** for routes, R-nav-13
> settle-request deep link, modal conventions §2.6, testID grammar §2.7) ·
> `.specs/api/money.spec.md` (companion — wire contracts, algorithms, authz) ·
> `.specs/research/payments-settle-up.md` (**the settle-up bible** —
> live-probed link formats, ToS red lines, device tests) ·
> `.specs/database/schema.spec.md` §§3.3.12–3.3.15 · ADR-005 (splitting free
> forever) · `.specs/design-system/tokens.spec.md` (Button, Input, Sheet,
> ConfirmDialog, EmptyState, ErrorBanner, ListItem, Badge).
>
> Screens live at the routes the navigation spec §2.1 already carved out
> under `[tripId]/money/`; this spec owns their content and behavior.

---

## 1. Requirements (EARS)

### Money tab (`money` — segmented budget · expenses · balances)

- **R-cmoney-1 (segments):** WHEN the money tab mounts THE SYSTEM SHALL show
  three segments — budget, expenses, balances — defaulting to **budget**, and
  SHALL keep the user's in-session segment choice (mirroring the R-nav-9
  no-snap-back pattern; cold launch re-defaults).
- **R-cmoney-2 (budget overview):** WHEN the budget segment renders THE
  SYSTEM SHALL show one row per `expense_category` with cap, AI estimate, and
  actual spend (from `GET /budgets`) plus a progress indicator; WHEN actual ≥
  80% of cap THE SYSTEM SHALL style the row as warning; WHEN actual > 100%
  THE SYSTEM SHALL style it as over-budget — thresholds rendered via semantic
  tokens, never hardcoded colors (R-ds-7).
  [NEEDS CLARIFICATION: is there an overall trip budget cap in addition to per-category caps? If yes: extra `budgets` row with a `total` pseudo-category vs a `trips.budget_cap_cents` column — pick after the product answer. User-visible.]
  *(Repeated verbatim from `.specs/database/schema.spec.md` §3.3.15 — decides
  whether the overview gets an editable total header row or a computed-only
  total.)*
- **R-cmoney-3 (AI estimate CTA):** WHEN the budget segment renders for an
  editor+ THE SYSTEM SHALL offer an "Estimate with AI" action whose states
  are: enabled (trip has dates, online) · disabled with "add trip dates"
  hint (dateless trip) · disabled (offline) · loading (call in flight,
  re-press blocked) · error via ErrorBanner mapping `AI_CAP_EXCEEDED`
  ("daily AI limit reached — resets tomorrow") and `AI_DISABLED` ("AI
  features are paused") to friendly copy; WHEN the call succeeds THE SYSTEM
  SHALL show the returned range per category, persist nothing locally (the
  server wrote `budgets`), refetch, and display `ai_estimated_at`.
- **R-cmoney-4 (category taxonomy):** WHEN any category picker or budget row
  renders THE SYSTEM SHALL derive the category list from the shared
  `expense_category` enum — never a local list.
  [NEEDS CLARIFICATION: budget/expense category taxonomy — is this fixed set right, and are categories a fixed enum or user-definable? PLANNING names "food, transport, etc." for AI estimation but never enumerates. User-visible in budget UI and AI estimates.]
  *(Repeated verbatim from `.specs/database/schema.spec.md` §3.2; resolves
  there.)*
- **R-cmoney-5 (expense list):** WHEN the expenses segment renders THE SYSTEM
  SHALL list expenses newest-first (`spent_at`) with description, category,
  payer, amount in its logged currency, and per-item "your share"; SHALL
  offer member + category filters in a Sheet (nav §2.6 "filters"); and SHALL
  show the add-expense FAB for editor+ (role marker: api money spec
  R-money-26).
- **R-cmoney-6 (balances view):** WHEN the balances segment renders THE
  SYSTEM SHALL show (a) the caller's headline position ("you're owed" /
  "you owe" / settled), (b) per-member net chips, and (c) the transfer list
  from the API's `simplified` array — each row actionable: rows where the
  caller is debtor open the settle screen; rows where the caller is creditor
  open the send-the-bill flow.
  [NEEDS CLARIFICATION: debt simplification default — the navigation spec's screen inventory shows balances as "who-owes-who, simplified", but simplification changes who pays whom (you can be told to pay someone who never fronted money for you — Splitwise makes it an opt-in group setting for exactly this trust reason). Is simplified always-on, a per-trip setting, or a per-view toggle defaulting to pairwise? User-visible.]
  *(Repeated verbatim from `.specs/api/money.spec.md` R-money-10 — the API
  returns both shapes either way; only this display decision pends.)*

### Add-expense flow (`expense-new` — modal)

- **R-cmoney-7 (fields):** WHEN the add-expense modal opens THE SYSTEM SHALL
  collect: amount + currency, description, category, payer (default: the
  caller), date (default: today), participants (default: all current
  members, individually toggleable), split type, and optional booking link —
  save disabled until amount > 0, description present, and the split is
  valid.
- **R-cmoney-8 (integer-cents input):** WHEN the user types an amount THE
  SYSTEM SHALL parse the string directly to integer minor units (ISO-4217
  aware — JPY has none) via the shared helper and SHALL perform all split
  preview math on integers — float arithmetic on money is a blocking review
  finding (Law #2; PLANNING § blocking criteria).
- **R-cmoney-9 (split picker):** WHEN a split type is selected THE SYSTEM
  SHALL render its editor — equal: participant toggles only · exact:
  per-member cent inputs with a live "remaining to allocate" readout ·
  percent: per-member percent inputs (2dp = basis points) with a live
  sum-to-100 readout · shares: per-member integer weight steppers — always
  showing the live resolved per-member preview from the shared
  `computeShares` algorithm (api money spec §3.3), and SHALL block save
  unless the resolved shares sum to the amount exactly (mirror of R-money-2;
  the server re-validates regardless).
- **R-cmoney-10 (currency gate):** WHILE the multi-currency marker is
  unresolved THE SYSTEM SHALL lock the currency field to the trip's base
  currency (a non-base expense cannot yet carry a trustworthy rate — api
  money spec R-money-6).
  [NEEDS CLARIFICATION: multi-currency policy — when an expense's currency ≠ trip base currency, where does `fx_rate` come from (live rate API at entry time? manual entry? both with manual override?) and is it ever re-fetched? Balances shown always in trip base currency? Affects whether an FX-rate provider becomes a new external dependency (Autonomy Contract §3).]
  *(Repeated verbatim from `.specs/database/schema.spec.md` §3.3.12 — this
  is what unlocks PLANNING's "spend-in-local-currency logging" extra.)*
- **R-cmoney-11 (booking link):** WHEN the user links a booking THE SYSTEM
  SHALL offer the trip's bookings in a picker and prefill amount
  (`price_cents`), description (title), and category via the fixed mapping
  §2.3 — prefills editable, link removable.
- **R-cmoney-12 (edit mode):** WHEN opened with `?expenseId=` THE SYSTEM
  SHALL prefill all fields from the expense (split editor opens in `exact`
  mode showing current shares — original split type is not persisted, pends
  the split-metadata marker) and submit via PATCH with full shares
  replacement.
  [NEEDS CLARIFICATION: split-type persistence — `expense_shares` stores resolved cents only (schema spec §3.3.13); should the chosen split method + inputs (equal / percent 50-25-25 / shares 2-1-1) persist so expense detail and edit re-open in the original mode ("split equally"), or is derive-on-read acceptable (equal is detectable within remainder tolerance; percent/shares are not)? Persisting = schema addition (e.g. `expenses.split_meta jsonb`). User-visible in expense detail + edit.]
  *(Repeated verbatim from `.specs/api/money.spec.md` R-money-29.)*

### Expense detail (`expense-detail` — push)

- **R-cmoney-13 (detail):** WHEN an expense detail renders THE SYSTEM SHALL
  show amount/currency, payer, date, category, the full shares breakdown per
  member, the linked booking (tappable through to its detail) when present,
  and edit/delete actions per role; delete SHALL require a ConfirmDialog
  (R-ds-18) — delete semantics pend:
  [NEEDS CLARIFICATION: expense deletion — hard delete, or soft delete with a visible audit trail ("Sean deleted 'Dinner ¥12,000'"), Splitwise-style? Group money + trust says audit; schema would gain `deleted_at`/`deleted_by` and balance queries would filter. User-visible.]
  *(Repeated verbatim from `.specs/database/schema.spec.md` §3.3.12.)*

### Settle-up screen (`settle` — push, per research §Recommended v1 #3)

- **R-cmoney-14 (headline):** WHEN the settle screen opens for a counterparty
  THE SYSTEM SHALL headline the current pairwise position — "You owe Alex
  $25.50" or "Alex owes you $25.50" — with an amount field prefilled to the
  full owed amount and editable down (partial settles legal; a value above
  the owed amount shows a non-blocking warning).
- **R-cmoney-15 (rail buttons):** WHEN the caller owes THE SYSTEM SHALL
  render one payment button **per handle the counterparty has** (from their
  member-visible `UserProfile.payment_handles`): Venmo, Cash App, PayPal,
  Zelle — handles the counterparty lacks render nothing (no disabled
  stubs); WHEN the counterparty has no handles THE SYSTEM SHALL show a hint
  ("Alex hasn't added payment handles") above the always-present mark-as-
  settled action.
- **R-cmoney-16 (Venmo gating):** WHEN rendering the Venmo button THE SYSTEM
  SHALL check `canOpenURL('venmo://…')` (iOS
  `LSApplicationQueriesSchemes: [venmo]`; Android 11+ `<queries>` element or
  catch `ActivityNotFoundException` — research) and open the app scheme when
  available, else the probed web fallback URL — the button shows either way
  when the handle exists.
- **R-cmoney-17 (link formats):** WHEN a rail button fires THE SYSTEM SHALL
  build the URL exactly per the live-probed formats table §2.5 — usernames
  without `@`, cashtags with `$` prefixed at render (stored bare), amounts
  dot-decimal with the currency's minor-unit digits, notes URL-encoded,
  PayPal amounts always currency-pinned.
- **R-cmoney-18 (US-rail gating):** WHEN the trip's base currency is not USD
  THE SYSTEM SHALL hide the Venmo, Cash App, and Zelle buttons (USD-only
  rails) — PayPal (multi-currency) and mark-as-settled remain.
- **R-cmoney-19 (Zelle):** WHEN the counterparty has a Zelle handle THE
  SYSTEM SHALL render it as a copyable handle (tap = clipboard + toast +
  haptic) beside their `zelle_display_name` and the amount for manual entry
  — no deeplink exists (research: no link, no API, no scheme; the unofficial
  QR format is LOW-stability and out of scope v1).
- **R-cmoney-20 (mark as settled — unconditional):** WHEN the settle screen
  renders THE SYSTEM SHALL ALWAYS present "Mark as settled" — regardless of
  handles, rails, or how payment happened (research red line: every deeplink
  is best-effort UX sugar, killable without notice; this action must always
  work standalone) — opening a Sheet with amount (prefilled), method picker
  (default `cash`), and optional note, recording via
  `POST /settlements` on confirm.
- **R-cmoney-21 (return prompt):** WHEN the app returns to foreground within
  30 minutes of a rail deeplink-out THE SYSTEM SHALL present exactly once a
  "Did you complete the payment?" Sheet prefilled with that rail's method
  and amount — confirm records the settlement, decline/dismiss clears the
  pending record (same mechanics as the R-nav-18 booking-return pattern:
  stash `{counterparty, method, amount_cents, timestamp}` on tap, check on
  `AppState → active`, clear after prompting).
- **R-cmoney-22 (rail failure never blocks):** WHEN a rail link fails to
  open (app missing, URL rejected, OS error) THE SYSTEM SHALL show a
  non-blocking error and leave the screen fully usable — mark-as-settled is
  never gated on rail behavior.
- **R-cmoney-23 (creditor view):** WHEN the counterparty owes the caller THE
  SYSTEM SHALL replace rail buttons with "Request payment" (send-the-bill
  flow) and "Mark as settled" (recording money received — either party may
  record, api money spec R-money-12).
- **R-cmoney-24 (PayPal framing):** WHEN PayPal appears anywhere in settle-up
  UX THE SYSTEM SHALL frame it as a personal payment (Friends & Family) in
  copy — ToS red line (research).

### Send-the-bill request flow

- **R-cmoney-25 (create + share):** WHEN the caller requests payment THE
  SYSTEM SHALL create the request via `POST /settle-requests` (amount
  prefilled from the displayed balance, editable) and open the iOS share
  sheet with the returned GoGo universal link
  (`https://<domain>/t/<tripId>/request/<requestId>`, per navigation spec
  §2.3) plus message text carrying amount + trip name.
  [NEEDS CLARIFICATION: Universal-link domain — what domain do we own for `https://` links (gogo.travel? gogotravel.app?)? Needed for AASA / assetlinks and the link formats below. Custom scheme `gogo://` is assumed as the fallback either way.]
  *(Repeated verbatim from `.specs/client/navigation.spec.md` §1 Open
  questions; "the link formats below" refers to that spec's registry.)*
- **R-cmoney-26 (recipient screen):** WHEN a settle-request link opens the
  app (R-nav-13) THE SYSTEM SHALL render the request screen inside the
  trip's money context with: requester + trip name, amount owed, the same
  rail machinery as the settle screen (R-cmoney-15..22, built from the
  requester's handles), and mark-as-settled; WHEN the request is `settled`,
  `cancelled`, or `resolved` THE SYSTEM SHALL render a resolved state (who
  settled, when — no pay buttons); WHEN the id is unknown THE SYSTEM SHALL
  render an EmptyState with a path back to the money tab (navigation
  registry: "missing/settled request → request screen's resolved/empty
  state").
- **R-cmoney-27 (non-member recipients):**
  [NEEDS CLARIFICATION: Settle-up request links opened by someone who isn't a member of the trip (bills sent to friends outside the app is part of the brief). Does the link require membership (R-nav-15 applies), or is there a lightweight recipient view / web fallback page for non-members and non-users? Determines whether R-nav-13 needs an unauthenticated branch.]
  *(Repeated verbatim from `.specs/client/navigation.spec.md` §1 Open
  questions — until resolved, this screen assumes members only and
  non-members get the R-nav-15 no-access state.)*
- **R-cmoney-28 (Venmo charge — gated enhancement):** WHEN (and only when)
  device test D1 (§3 checklist) passes THE SYSTEM MAY additionally offer
  "Request via Venmo" using `txn=charge` on the same URL grammar; until then
  the GoGo link is the only request transport (research: charge format
  MED-HIGH, device-test pre-ship).

### Cross-cutting

- **R-cmoney-29 (states):** WHEN any money surface has no data THE SYSTEM
  SHALL render an EmptyState (never a blank region — R-ds-16): no expenses →
  "No expenses yet" + add CTA; balances all zero → "All settled up"; budget
  untouched → set-caps + AI-estimate CTAs; WHEN any money query fails THE
  SYSTEM SHALL render ErrorBanner with retry (R-ds-17).
- **R-cmoney-30 (testIDs):** WHEN any money screen renders THE SYSTEM SHALL
  carry testIDs on its root and every interactive element per the navigation
  spec §2.7 grammar (mirror of R-nav-22); the money inventory is §2.8 —
  E2E flows match on these exactly.
- **R-cmoney-31 (member visibility):** WHEN rendering payment buttons THE
  SYSTEM SHALL source handles exclusively from `UserProfile` of trip members
  (contracts spec §3.4: handles deliberately member-visible) — handles are
  never fetched for non-members, and this spec adds no new profile surface.
- **R-cmoney-32 (optimistic + fresh):** WHEN an expense or settlement
  mutation succeeds THE SYSTEM SHALL invalidate expenses + balances + budgets
  queries together (one stale trio is the classic split-app bug); optimistic
  updates follow PLANNING's collab-sync pattern (REST + optimistic +
  refetch-on-focus).

---

## 2. Design

### 2.1 Screen map (routes are canonical in navigation spec §2.1)

| Route | Screen | Presentation |
|---|---|---|
| `money/index.tsx` | Money tab — segmented budget · expenses · balances | tab root |
| `money/expense/new.tsx` | Add/edit expense (`?expenseId=` = edit, mirroring `itinerary/item/new`) | modal — form |
| `money/expense/[expenseId].tsx` | Expense detail | push |
| `money/settle/[memberId].tsx` | Settle screen (counterparty = memberId) | push; rail handoff + confirms in Sheets (nav §2.6: "settle handoff options") |
| `money/request/[requestId].tsx` | Settle-request recipient view | push; deep-link target (R-nav-13) |

Entry points beyond the tab: today-tab quick action "add expense" (nav
§2.4) opens `expense-new`; balances rows open `settle`/send-the-bill;
request deep links land on `request/[requestId]` after auth stash-resume
(R-nav-14).

Note for the design system: the segmented control needed by R-cmoney-1 is
not in the tokens spec §2.9 inventory — flag `SegmentedControl` as an
additive DS component (tokens spec owns it; testID element noun `segment`
already exists in the nav grammar).

### 2.2 Money tab segments

**Budget** — header: total spent vs total caps/estimates (editable total cap
pends the R-cmoney-2 marker); rows per category (full taxonomy from `GET
/budgets`): category name, progress bar (spent vs cap, warning ≥80%, over
>100%), `cap` (tap → inline cents input, editor+), `AI est.` column with
`ai_estimated_at` timestamp; footer: "Estimate with AI" Button (R-cmoney-3
states; loading per R-ds-14).

**Expenses** — ListItem rows: description, category Badge, "Paid by
{name}", `spent_at`, amount (logged currency), subdued "your share" line;
filter button opens Sheet (member picker + category picker + clear); FAB →
`expense-new`. Infinite scroll on the `Paginated` cursor.

**Balances** — headline Card (caller's net position); member chips row
(net per member, signed color tokens); transfer list (from API `simplified`
— display default pends R-cmoney-6 marker): "{A} → {B} {amount}"; rows
involving the caller carry the action chevron (debtor → settle screen,
creditor → request flow). "All settled up" EmptyState when no transfers.

### 2.3 Booking → expense prefill mapping (R-cmoney-11)

Deterministic mapping, defined once in `@gogo/shared` config (pends the
category-taxonomy marker for the right-hand values):

| `booking_category` | `expense_category` |
|---|---|
| `lodging` | `lodging` |
| `flight` · `train` · `car_rental` · `moped_rental` | `transport` |
| `activity` | `activities` |
| `restaurant` | `food` |
| `other` | `other` |

Prefill only — user edits freely; the booking link persists as
`expenses.booking_id` and renders on both booking detail (bookings spec's
side) and expense detail.

### 2.4 Add-expense split picker

Four-way segmented split editor (equal · exact · percent · shares), live
preview list under it — every member row shows their resolved share in cents
formatted per currency, recomputed on each keystroke via the shared
`computeShares` (api money spec §3.3; identical math client and tests).
Participant toggles remove members from the split (their share = absent, not
zero — zero-share rows are only produced by explicit `exact` entry).
Validation states: exact — "remaining: $X.XX" until zero; percent — "sum:
98.5% — needs 100%"; shares — weights ≥ 1. Save submits **resolved shares**
(`ExpenseCreate.shares`) — the split inputs never cross the wire (contracts
spec §3.4).

### 2.5 Rail handoff — exact link formats (implement these; research, live-probed 2026-07-09)

| Rail | Format | Notes |
|---|---|---|
| Venmo (app) | `venmo://paycharge?txn=pay&recipients=<user>&amount=25.50&note=<urlenc>` | `<user>` = `venmo_username` (stored bare — strip `@` at save); `txn=charge` reserved for R-cmoney-28. `venmo://users/<username>` is DEAD — never use |
| Venmo (web fallback) | `https://account.venmo.com/pay?txn=pay&recipients=<user>&amount=25.50&note=<enc>` | Used when `canOpenURL` fails (R-cmoney-16) |
| Cash App | `https://cash.app/$<cashtag>/25.50` | dot-decimal 2dp; **no note support**; cashtag stored bare, `$` prefixed at render; handle HEAD-validated at save (users spec side) |
| PayPal.me | `https://paypal.me/<user>/25.50USD` | **always pin the currency code** (trip base) or the recipient's default currency applies |
| Zelle | no link — copyable `zelle_handle` + `zelle_display_name` + amount shown adjacent | R-cmoney-19; unofficial QR format skipped v1 |

Shared formatting rules: amount = trip-base cents → dot-decimal string with
ISO-4217 minor-unit digits (2550 → `25.50`; JPY 2550 → `2550`) via the
shared minor-unit helper — never float division; `note` = `GoGo: <trip
name>` URL-encoded (Venmo only — Cash App has no note field). All rail
URLs open externally (`Linking.openURL`), never an in-app browser (device
test D3 validates this exact behavior).

### 2.6 Settle flow sequence

1. Balances row / member chip → `settle/[memberId]`.
2. Screen loads pairwise position (headline per R-cmoney-14) + counterparty
   handles.
3. "Settle up" primary action opens the **handoff Sheet** (nav §2.6): rail
   buttons per R-cmoney-15..19, "Mark as settled" always last
   (R-cmoney-20).
4. Rail tap → stash pending record → deeplink out.
5. Return within 30 min → **return-prompt Sheet** once (R-cmoney-21):
   "Did you complete the payment?" → [Yes, record it] posts the settlement
   (method = rail, amount = stashed) → success toast + R-cmoney-32
   invalidation; [Not yet] clears the stash.
6. "Mark as settled" (any time) → method/amount/note Sheet → post → same
   invalidation. Works with zero handles, zero rails, zero deeplinks.

Creditor variant (R-cmoney-23): headline flips; actions are "Request
payment" (→ §2.7) and "Mark as settled" (records received money).

### 2.7 Send-the-bill sequence

1. Entry: balances row (caller = creditor) or settle screen creditor view.
2. Amount Sheet (prefilled from displayed balance, editable) + optional note
   → `POST /settle-requests`.
3. iOS share sheet opens with the returned `link` + message text
   ("<Requester> requests $25.50 for <trip name> — settle up in GoGo:
   <link>"). Copy affordance as fallback.
4. Recipient opens link → R-nav-13 routing (auth stash-resume per R-nav-14)
   → `request/[requestId]` renders per R-cmoney-26; paying through it links
   the settlement to the request (`request_id` on the POST — api money spec
   R-money-18), flipping it to settled for both parties.
5. Open requests the caller sent render on the balances segment as subdued
   "requested $X on <date>" annotations on the relevant transfer rows, with
   cancel via ConfirmDialog (→ `DELETE /settle-requests/:id`).

### 2.8 testID inventory (grammar: navigation spec §2.7 — `<screen>-<element>[-qualifier]`)

Screen roots: `money-screen`, `expense-new-screen`, `expense-detail-screen`,
`settle-screen`, `settle-request-screen`.

| Surface | testIDs |
|---|---|
| Money tab | `money-segment-budget` · `money-segment-expenses` · `money-segment-balances` · `money-fab-add-expense` · `money-button-ai-estimate` · `money-budget-list-item-{category}` · `money-input-cap-{category}` · `money-expense-list` · `money-expense-list-item-{expenseId}` · `money-button-filter` · `money-sheet-filter` · `money-balance-list-item-{userId}` · `money-transfer-list-item-{fromUserId}-{toUserId}` |
| Add/edit expense | `expense-new-input-amount` · `expense-new-input-description` · `expense-new-picker-currency` · `expense-new-picker-category` · `expense-new-picker-payer` · `expense-new-input-date` · `expense-new-toggle-participant-{userId}` · `expense-new-segment-split-equal` / `-exact` / `-percent` / `-shares` · `expense-new-input-share-{userId}` · `expense-new-input-percent-{userId}` · `expense-new-stepper-weight-{userId}` · `expense-new-button-booking-link` · `expense-new-button-save` |
| Expense detail | `expense-detail-list-item-share-{userId}` · `expense-detail-button-booking` · `expense-detail-button-edit` · `expense-detail-button-delete` (ConfirmDialog derives `-confirm`/`-cancel`) |
| Settle | `settle-button-settle-up` · `settle-input-amount` · `settle-sheet-handoff` · `settle-button-venmo` · `settle-button-cashapp` · `settle-button-paypal` · `settle-button-zelle-copy` · `settle-button-mark-settled` · `settle-picker-method` · `settle-sheet-return` (+ `-confirm`/`-cancel`) · `settle-button-request` |
| Settle request | `settle-request-button-venmo` · `-cashapp` · `-paypal` · `-zelle-copy` · `settle-request-button-mark-settled` · `settle-request-button-back` |

(`settle-button-venmo` matches the worked example already in the navigation
spec §2.7 — kept identical.)

### 2.9 Empty / edge / error states

| Surface | Condition | Behavior |
|---|---|---|
| Budget | no caps, no estimates | EmptyState: "Plan your spending" + set-caps + AI CTA |
| Budget | AI cap / kill-switch / offline / dateless | R-cmoney-3 state table |
| Expenses | none | EmptyState + FAB pulse hint |
| Expenses | filter yields none | "No matches" EmptyState + clear-filters action |
| Balances | all zero | "All settled up" EmptyState |
| Settle | counterparty has zero handles | hint + mark-as-settled only (R-cmoney-15) |
| Settle | non-USD base trip | USD rails hidden (R-cmoney-18) |
| Settle | rail open failure | non-blocking error; screen stays usable (R-cmoney-22) |
| Request | settled / cancelled / resolved | resolved state, no pay buttons (R-cmoney-26) |
| Request | unknown id | EmptyState + back to money tab |
| Request | non-member opener | pends R-cmoney-27 marker (R-nav-15 no-access meanwhile) |
| All | query error | ErrorBanner + retry (R-ds-17) |
| All | offline, active trip | segments mount from cache (nav §2.8 note); mutations while offline are the offline spec's queue — out of scope here |

### 2.10 Out of scope (explicit)

- Wire contracts, split/balance algorithms, authz — `.specs/api/money.spec.md`.
- Payment-handle entry/edit UX (profile/onboarding) — users/profile spec;
  the navigation spec's onboarding + profile-surface markers cover where it
  lives.
- Offline mutation queueing for money writes — offline/sync spec.
- Push notifications ("Alex added an expense", "request received") —
  notifications spec.
- Currency converter surface (PLANNING extra) — pends the FX marker; not a
  money-tab v1 feature.
- Apple Cash — dead end per research (no third-party write path); not
  rendered even as a handle type.
- Zelle QR rendering — unofficial format, LOW stability (research); v1 is
  copy-only.

---

## 3. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on: MON-* API tasks, NAV-5 (deep-link registry), DS components
(+ the SegmentedControl addition flagged in §2.1).

| ID | Task | Covers |
|---|---|---|
| CMON-1 | Money tab shell: segments + budget overview (rows, caps editing, progress states) + AI estimate CTA state machine. | R-cmoney-1..4, 29, 30 |
| CMON-2 | Expense list + filters Sheet + expense detail (+ delete Confirm). | R-cmoney-5, 13, 29, 30, 32 |
| CMON-3 | Add/edit expense modal: integer-cents input, split picker × 4 with live shared-math preview, booking-link prefill. | R-cmoney-7..12 |
| CMON-4 | Balances segment: nets, transfer rows, actions, request annotations. | R-cmoney-6, 29, 32 |
| CMON-5 | Settle screen: rail buttons + gating, link builder (shared formatter), Zelle copy, mark-as-settled Sheet, return prompt. | R-cmoney-14..24 |
| CMON-6 | Send-the-bill flow + request recipient screen + deep-link wiring. | R-cmoney-25..28 |

**Tests required (unit/integration):**

- [ ] Amount parser: `"25.50"` → 2550; `"25.5"` → 2550; JPY `"2550"` → 2550;
      rejects `"25.505"`; no float appears in the pipeline (Law #2)
- [ ] Split preview parity: client preview === shared `computeShares` output
      for all four types (property test over random inputs)
- [ ] Save blocked until exact-sum; percent ≠ 100% and exact-remainder ≠ 0
      block with visible readouts
- [ ] Link builder: each rail's URL matches §2.5 verbatim for fixture
      handles/amounts; `@`/`$` normalization; note URL-encoding; PayPal
      currency pinned; JPY zero-decimal formatting
- [ ] Venmo gating: canOpenURL false → web fallback URL used, button still
      rendered
- [ ] Non-USD base: Venmo/CashApp/Zelle hidden, PayPal + mark-as-settled
      remain
- [ ] Mark-as-settled works with a counterparty that has zero handles
- [ ] Return prompt: shown once within 30 min, not after, not twice;
      confirm posts method+amount from the stash
- [ ] Request states: open (pay UI) / settled / cancelled / unknown-id
      render per §2.9
- [ ] Mutation invalidation trio: expense create updates expenses AND
      balances AND budgets queries
- [ ] Every §2.8 testID present (E2E smoke walks the inventory)

**Pre-ship device-test checklist (research §"Pre-ship device tests" — open
MEDIUMs promoted to blocking spec test requirements; run on real hardware,
results recorded in the feature ledger before store submission):**

- [ ] **D1 — Venmo `txn=charge` on real iPhone/Android.** Gates R-cmoney-28
      (request-via-Venmo stays disabled until this passes)
- [ ] **D2 — Venmo return-to-app behavior after payment.** Validates the
      R-cmoney-21 return-prompt trigger on the real handoff
- [ ] **D3 — Cash App/PayPal universal links launched from our app context
      (not in-app browser).** Validates §2.5's external-open requirement
- [ ] D4 (derived) — `canOpenURL` gating verified on a device WITHOUT Venmo
      installed (web fallback path) and one WITH it (scheme path); simulator
      cannot exercise this

---

*Trace: R-cmoney-N ↔ §2 sections inline. Markers: 8 repeated verbatim
(overall cap, taxonomy, FX, expense deletion — schema spec; simplification
default + split metadata — api money spec; universal-link domain +
non-member recipients — navigation spec), 0 new. Every marker is a P-2
interview question for Sean. Zero markers = approvable.*
