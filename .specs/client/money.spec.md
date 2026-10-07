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
>
> **Round-2 rulings (2026-09-19):** Sean approved the Money group of the
> round-2 spec pass wholesale (`.specs/OPEN-QUESTIONS.md` § Round 2 — Money,
> Q2-001..Q2-055). Each ruling is written inline where it governs, tagged
> `(Q2-NNN, ruled 2026-09-19)`; the OPEN-QUESTIONS rows stay as the decision
> record. A "keep as shipped" ruling makes the shipped interpretation the
> normative rule; where it contradicts an earlier sentence, that sentence is
> amended in place.

---

## 1. Requirements (EARS)

### Money tab (`money` — segmented budget · expenses · balances)

- **R-cmoney-1 (segments):** WHEN the money tab mounts THE SYSTEM SHALL show
  three segments — budget, expenses, balances — defaulting to **budget**, and
  SHALL keep the user's in-session segment choice, per trip (mirroring the
  R-nav-9 no-snap-back pattern; cold launch re-defaults). The memory is
  in-session only, never persisted: it resets at sign-out (R-nav-4) and on
  cold launch, and **not** on navigation — leaving the money tab and coming
  back keeps the choice. (Q2-009, ruled 2026-09-19)
- **R-cmoney-2 (budget overview):** WHEN the budget segment renders THE
  SYSTEM SHALL show one row per `expense_category` with cap, AI estimate, and
  actual spend (from `GET /budgets`) plus a progress indicator; WHEN actual ≥
  80% of cap THE SYSTEM SHALL style the row as warning; WHEN actual > 100%
  THE SYSTEM SHALL style it as over-budget — thresholds rendered via semantic
  tokens, never hardcoded colors (R-ds-7). Resolved at
  `.specs/database/schema.spec.md`:§3.3.15 (Gate 2, 2026-07-09): an
  optional overall trip cap exists alongside per-category caps — the
  overview header row is an **editable total cap** (editor+), with
  computed total spend beside it.
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
  `expense_category` enum — never a local list. Resolved at
  `.specs/database/schema.spec.md`:§3.2 (Gate 2, 2026-07-09): fixed enum
  v1 — lodging, transport, food, activities, shopping, other; not
  user-definable.
- **R-cmoney-5 (expense list):** WHEN the expenses segment renders THE SYSTEM
  SHALL list expenses newest-first (`spent_at`) with description, category,
  payer, amount in its logged currency, and per-item "your share" — rendered
  **only when the caller holds a share row** on that expense (an explicit
  zero-share row included; an absent share means not involved, so no
  synthetic zero line — Q2-052, ruled 2026-09-19); SHALL offer member +
  category filters in a Sheet (nav §2.6 "filters") — date filters
  (`from`/`to`) are **not built** this pass; the wire already supports them
  (api money spec E2) for a later surface (Q2-055, ruled 2026-09-19); and
  SHALL
  show the add-expense FAB for **every member including viewers** (api
  money spec R-money-26, resolved Gate 2 — viewers log expenses too). The
  FAB lives on the **Expenses segment** only (§2.2); the today-tab quick
  action (nav §2.4) is the other add-expense entry point. (Q2-005, ruled
  2026-09-19)
- **R-cmoney-6 (balances view):** WHEN the balances segment renders THE
  SYSTEM SHALL show (a) the caller's headline position ("you're owed" /
  "you owe" / settled), (b) per-member net chips, and (c) the transfer
  list rendered **pairwise by default** with a one-tap "Simplify debts"
  view toggle (`money-toggle-simplify`) that switches to the API's
  `simplified` array — simplification is off by default (Splitwise trust
  precedent: it changes who pays whom); the toggle is a per-view control,
  not a persisted setting. Each row is actionable: rows where the caller
  is debtor open the settle screen; rows where the caller is creditor open
  the **same** settle screen (`settle/[memberId]`), whose creditor variant
  (R-cmoney-23) carries the send-the-bill entry — there is no dedicated
  request route from balances, because `request/[requestId]` needs an id
  that only exists after `POST /settle-requests`. (Resolved 2026-07-09,
  Gate 2 — api money spec R-money-10; creditor routing: Q2-001, ruled
  2026-09-19)

### Add-expense flow (`expense-new` — modal)

- **R-cmoney-7 (fields):** WHEN the add-expense modal opens THE SYSTEM SHALL
  collect: amount + currency, description, category, payer (default: the
  caller), date (default: today), participants (default: all current
  members, individually toggleable), split type, and optional booking link —
  save disabled until amount > 0, description present, and the split is
  valid. The category defaults to `other` (so the save-disabled list above
  stays exhaustive); the category chips render the full shared
  `expense_category` taxonomy in its fixed tuple order (R-cmoney-4), and a
  booking prefill overrides the default via §2.3. (Q2-050, ruled 2026-09-19)
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
- **R-cmoney-10 (multi-currency entry):** WHEN the user picks a currency ≠
  trip base THE SYSTEM SHALL auto-fetch the FX rate when online (free FX
  API — approved dependency; provider picked at build), prefill the
  converted base amount, and always allow manual override of the rate;
  WHEN offline (or the FX source fails) THE SYSTEM SHALL require manual
  rate entry before save. The rate is captured at entry and never
  re-fetched; balances render in trip base currency. Resolved at
  `.specs/database/schema.spec.md`:§3.3.12 (Gate 2, 2026-07-09) — this
  unlocks PLANNING's "spend-in-local-currency logging" extra. The base
  amount is **derived and read-only** in the form — computed from amount ×
  rate by exact integer/rational arithmetic (never float), rounded inside the
  R-money-6 consistency window the server accepts — so a free-typed base can
  never form an inconsistent pair; the manual path is rate entry. A
  currency change drops any manual rate override (a EUR rate means nothing
  for GBP). (Q2-048, ruled 2026-09-19)
- **R-cmoney-11 (booking link):** WHEN the user links a booking THE SYSTEM
  SHALL offer the trip's bookings in a picker and prefill amount
  (`price_cents`), description (title), and category via the fixed mapping
  §2.3 — prefills editable, link removable. When a price is prefilled, the
  booking's **currency** is prefilled with it, not just the amount (15000 JPY
  must never land as "15000 USD"). (Q2-051, ruled 2026-09-19)
- **R-cmoney-12 (edit mode):** WHEN opened with `?expenseId=` THE SYSTEM
  SHALL prefill all fields from the expense and open the split editor in
  `exact` mode showing current shares (equal splits detectable within
  remainder tolerance may display "split equally"), submitting a
  **changed-fields-only PATCH**: a shares payload (full replacement of the
  share set, api money spec §3.2) is sent only when the split actually
  changed. The server validates INCOMING `paid_by` / `shares[].user_id`
  against current members even on PATCH (R-money-5), so a literal "full
  shares replacement on every save" cannot hold for legacy splits naming a
  departed member: an **untouched** split or payer naming an ex-member
  survives by omission, while a **changed** split that still names a former
  member is save-blocked with visible copy (never a guaranteed 400);
  former members render in the split editor as removable-only rows.
  (Q2-047, ruled 2026-09-19) WHEN `?expenseId=` is malformed THE SYSTEM
  SHALL render the "gone" EmptyState — never a blank create form, since a
  surprise duplicate is worse than a dead end. (Q2-054, ruled 2026-09-19)
  Resolved at `.specs/api/money.spec.md`:§R-money-29 (Gate 2, 2026-07-09):
  resolved cents only persist in v1 — no `split_meta`; derive-on-read is the
  decided UX.

### Expense detail (`expense-detail` — push)

- **R-cmoney-13 (detail):** WHEN an expense detail renders THE SYSTEM SHALL
  show amount/currency, payer, date, category, the full shares breakdown per
  member, the linked booking (tappable through to its detail) when present,
  and edit/delete actions (expense creator or trip owner — R-money-26,
  resolved Gate 2); delete SHALL require a ConfirmDialog (R-ds-18) and is a
  **soft delete with a visible audit trail** — the deletion renders as an
  audit entry ("Sean deleted 'Dinner ¥12,000'") in the expense history and
  balances exclude the deleted expense. Resolved at
  `.specs/database/schema.spec.md`:§3.3.12 (Gate 2, 2026-07-09). **Audit
  trail, v1 as shipped (Q2-046 — open: whether the expense history lists
  deletions; needs a wire-param ruling):** the audit entry renders on the
  expense **detail** screen (E3 returns the soft-deleted row with its
  `deleted_at` / `deleted_by` pair); the expense **list** does not show
  deletions, because E2 always excludes soft-deleted rows and the list query
  has no include-deleted switch. Delete success routes back
  (`router.back()`) and E2 excludes the deleted row, so today the audit
  entry is reachable only by a direct deep link to the deleted expense.
  Listing deleted entries in the history needs a wire change (an
  include-deleted param or a dedicated history read). (Q2-046 — as shipped;
  Sean pick pending: the history lists deletions (needs a wire param) / it
  never does.) [NEEDS CLARIFICATION: Q2-046 — should the expense history
  list deleted entries (needs a wire param), or never?]

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
  when the handle exists. A **throwing** `canOpenURL` (Android 11+ without
  the venmo `<queries>` entry) is treated exactly like a false probe and
  folds into the web-fallback arm — never a crash; the manifest entry itself
  rides the Android pre-launch pass (iOS declares `LSApplicationQueriesSchemes`
  now). (Q2-038, ruled 2026-09-19)
- **R-cmoney-17 (link formats):** WHEN a rail button fires THE SYSTEM SHALL
  build the URL exactly per the live-probed formats table §2.5 — usernames
  without `@`, cashtags with `$` prefixed at render (stored bare), amounts
  dot-decimal with the currency's minor-unit digits, notes URL-encoded,
  PayPal amounts always currency-pinned.
- **R-cmoney-18 (US-rail gating):** WHEN the trip's base currency is not USD
  THE SYSTEM SHALL hide the Venmo, Cash App, and Zelle buttons (USD-only
  rails) — PayPal (multi-currency) and mark-as-settled remain.
- **R-cmoney-19 (Zelle):** WHEN the counterparty has a Zelle handle THE
  SYSTEM SHALL render it as a copyable handle (tap = clipboard + inline
  "Copied" confirmation + success haptic — the design system has no toast
  component, so every copy/record confirmation in settle-up renders as inline
  state plus a haptic; Q2-034, ruled 2026-09-19) beside their
  `zelle_display_name` — falling back to the raw handle when
  `zelle_display_name` is null (legacy rows; Q2-037, ruled 2026-09-19) — and
  the amount for manual entry — no deeplink exists (research: no link, no
  API, no scheme; the unofficial QR format is LOW-stability and out of scope
  v1).
- **R-cmoney-20 (mark as settled — unconditional):** WHEN the settle screen
  renders THE SYSTEM SHALL ALWAYS present "Mark as settled" — regardless of
  handles, rails, or how payment happened (research red line: every deeplink
  is best-effort UX sugar, killable without notice; this action must always
  work standalone) — opening a Sheet with amount (prefilled), method picker
  (default `cash`), and optional note, recording via
  `POST /settlements` on confirm. At a net-zero balance the sheet records
  caller → counterparty by default (pay framing; a wrong direction is
  reversible through api money spec R-money-15's 24 h delete +
  counter-entry — Q2-036, ruled 2026-09-19). A settled net-zero pair keeps
  Mark as settled reachable through the debtor-arm handoff sheet, with the
  amount field empty until typed (Q2-044, ruled 2026-09-19).
- **R-cmoney-21 (return prompt):** WHEN the app returns to foreground within
  30 minutes of a rail deeplink-out THE SYSTEM SHALL present exactly once a
  "Did you complete the payment?" Sheet prefilled with that rail's method
  and amount — confirm records the settlement, decline/dismiss clears the
  pending record (same mechanics as the R-nav-18 booking-return pattern:
  stash `{counterparty, method, amount_cents, timestamp}` on tap, check on
  `AppState → active`, clear after prompting). The prompt host mounts on the
  **settle and request screens only** — the deeplink-out origins, where a
  foreground return lands — not on global chrome; if the app is killed and
  returns onto another surface, the record simply expires inside its
  30-minute window without prompting. (Q2-035, ruled 2026-09-19)
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
  prefilled from the displayed balance, editable; the sheet **always POSTs
  an explicit `amount_cents`** — the API's defaulting arm is reachable only
  by a race, and its 409 still maps to specific copy; Q2-040, ruled
  2026-09-19) and open the iOS share
  sheet with the returned GoGo universal link
  (`https://<domain>/t/<tripId>/request/<requestId>`, per navigation spec
  §2.3) plus message text carrying amount + trip name. Universal-link
  domain — Resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2,
  2026-07-09): Sean picks/buys the domain (gogo.travel / gogotravel.app /
  seantokuzo.dev subdomain); the link format is domain-agnostic and
  `gogo://` remains the fallback scheme.
- **R-cmoney-26 (recipient screen):** WHEN a settle-request link opens the
  app (R-nav-13) THE SYSTEM SHALL render the request screen inside the
  trip's money context with: requester + trip name, amount owed, the same
  rail machinery as the settle screen (R-cmoney-15..22, built from the
  requester's handles), and mark-as-settled; WHEN the request is `settled`,
  `cancelled`, or `resolved` THE SYSTEM SHALL render a resolved state (no
  pay buttons; who settled and when — see below); WHEN the id is unknown THE
  SYSTEM SHALL render an EmptyState with a path back to the money tab
  (navigation registry: "missing/settled request → request screen's
  resolved/empty state"). Rulings (2026-09-19): the on-screen amount is
  **fixed at the request amount** — this requirement imports R-cmoney-15..22,
  not R-cmoney-14, so the editable amount field is settle-screen-only, while
  the mark-as-settled sheet's amount stays editable (partial pay-through is
  legal) (Q2-033); an **uninvolved member** (neither requester nor debtor)
  gets a read-only summary with no action affordances, since the settlement
  party rule (api money spec R-money-12) would reject any action they took
  (Q2-041); the request's creator sees the status and a cancel action via
  ConfirmDialog (Q2-002); the unknown-id EmptyState's path back is a
  **same-tab `router.replace`** onto the money tab (Q2-042); and "who
  settled, when" is a best-effort lookup of the linked settlement in the S2
  first page — because the request wire carries no `settled_by` /
  `settled_at`, anything beyond the first page degrades to a generic
  resolved line, and that holds until/unless Q2-031 resolves to (a) and the
  wire gains those fields (api money spec R-money-33; Q2-031 — as shipped;
  Sean pick pending: (a) add the fields at the next settle-request touch /
  (b) accept the degrade permanently). [NEEDS CLARIFICATION: Q2-031 — (a)
  add `settled_by` / `settled_at` at the next settle-request touch, or (b)
  accept the degrade permanently?] (Q2-002, Q2-033, Q2-041, Q2-042 ruled
  2026-09-19; Q2-031 pending as above.)
- **R-cmoney-27 (non-member recipients):** Resolved at
  `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09): settle-up
  request links require app install + an account in v1 (no web surface
  exists; revisit with any web phase) — this screen is members-only and
  non-member openers get the R-nav-15 no-access state.
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
  SYSTEM SHALL render ErrorBanner with retry (R-ds-17). "Budget untouched"
  means no overall cap, no per-category cap, and no AI estimate — it is
  **spend-agnostic** and still shows when expenses exist. For editor+ the
  EmptyState carries a set-caps action that reveals the row editor in
  place, so nothing is hidden after one tap; a **viewer** (who cannot edit
  caps — R-cmoney-2) sees the same EmptyState without that action, plus the
  visible disabled AI-estimate CTA, until an editor sets a cap or an
  estimate exists. (Q2-003, ruled 2026-09-19)
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
  refetch-on-focus). **Budget cap edits are the exception:**
  `PUT /budgets/:category` is NOT optimistic — optimism is reserved for
  interaction-continuity cases such as drag, and the PUT response is itself
  the recomputed budgets document, which replaces the cached one. A cap edit
  changes no expense or balance row, so it is not a trio site. (Q2-011,
  ruled 2026-09-19) Settle-up success goes **beyond the trio**: a recorded
  settlement also invalidates the settlements list and, when it was posted
  with a `request_id`, that request's detail; cancelling a request
  invalidates that request's detail; creating a request changes no balance
  and invalidates nothing. (Q2-043, ruled 2026-09-19)
- **R-cmoney-33 (display shape):** WHEN a money amount renders on any money
  surface THE SYSTEM SHALL use the display shape currency-code, space,
  amount — `USD 25.50`, `JPY 2550` — produced only by the shared ISO-4217
  minor-unit formatter (the same shape as the itinerary idea-price
  formatter, so money copy reads identically across surfaces). Signed net
  positions wrap a `+` or `-` around that shape (`+USD 25.50`,
  `-USD 25.50`; zero renders unsigned as `USD 0.00`), the sign handled by
  integer negation only. No local digit math and no float division, ever
  (Law #2). Prose examples in this spec that write `$25.50` illustrate
  magnitude, not the rendered shape. (Q2-007, ruled 2026-09-19)
- **R-cmoney-34 (former members):** WHEN a balance party is missing from the
  live member roster (a departed member whose history survives — api money
  spec R-money-8/28) THE SYSTEM SHALL label them **"Former member"** —
  never blank, never a raw id. The same label covers a departed expense
  payer or settle counterparty, who render no payment rails (handles come
  from the live roster only, R-cmoney-31). (Q2-008, ruled 2026-09-19)
- **R-cmoney-35 (cache keys):** WHEN money server-state is cached THE
  SYSTEM SHALL key it under the trip's detail subtree, the key prefix
  `["trips", tripId]` — balances, budgets, and the expenses root that
  R-cmoney-32 invalidates — **not** under a disjoint root, so it is evicted
  with the trip. Money reads are membership-gated (api R-money-25), so the
  guard-404 scrub and the trip-subtree eviction clear them exactly as they
  clear the rest of the trip (the NAV-4 zero-trip-data posture). (Q2-012,
  ruled 2026-09-19)
- **R-cmoney-36 (offline posture):** WHEN the active trip is offline THE
  SYSTEM SHALL follow the R-itin-29 pattern verbatim on each money segment:
  render the cached data with a warning banner and **no retry affordance**
  (offline is a state, not a fetch error — no retry lie); WHEN there is no
  cache THE SYSTEM SHALL show the offline-flavored no-cache error. The
  posture is scoped per segment, since only one segment mounts at a time.
  Mutations while offline remain the offline spec's queue (§2.10).
  (Q2-013, ruled 2026-09-19)

---

## 2. Design

### 2.1 Screen map (routes are canonical in navigation spec §2.1)

| Route                           | Screen                                                                  | Presentation                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `money/index.tsx`               | Money tab — segmented budget · expenses · balances                      | tab root                                                                     |
| `money/expense/new.tsx`         | Add/edit expense (`?expenseId=` = edit, mirroring `itinerary/item/new`) | modal — form                                                                 |
| `money/expense/[expenseId].tsx` | Expense detail                                                          | push                                                                         |
| `money/settle/[memberId].tsx`   | Settle screen (counterparty = memberId)                                 | push; rail handoff + confirms in Sheets (nav §2.6: "settle handoff options") |
| `money/request/[requestId].tsx` | Settle-request recipient view                                           | push; deep-link target (R-nav-13)                                            |

Entry points beyond the tab: today-tab quick action "add expense" (nav
§2.4) opens `expense-new`; balances rows open `settle`/send-the-bill;
request deep links land on `request/[requestId]` after auth stash-resume
(R-nav-14).

Note for the design system: the segmented control needed by R-cmoney-1 is
not in the tokens spec §2.9 inventory — flag `SegmentedControl` as an
additive DS component (tokens spec owns it; testID element noun `segment`
already exists in the nav grammar).

### 2.2 Money tab segments

**Budget** — header: total spent vs the editable overall trip cap
(R-cmoney-2, resolved Gate 2; editor+ edits it like any cap); rows per
category (full taxonomy from `GET /budgets`): category name, progress bar
(spent vs cap, warning ≥80%, over >100%), `cap` — an **always-inline** cents
input for editor+ (the field itself is the tap target; there is no separate
display→edit morph state, so the §2.8 inventory pins input ids only, and
viewers see the cap as plain text and never mount the input — Q2-006, ruled
2026-09-19), and the AI estimate with its `ai_estimated_at` timestamp
rendered **only where an estimate exists** (per row: `ai_estimate_cents`
and `ai_estimated_at` non-null) — never as a placeholder dash, so a trip
with no estimates shows no AI-estimate content at all (Q2-004, ruled
2026-09-19); footer: "Estimate with AI" Button (R-cmoney-3 states; loading
per R-ds-14).

**Expenses** — ListItem rows: description, category Badge, "Paid by
{name}", `spent_at`, amount (logged currency), subdued "your share" line;
filter button opens Sheet (member picker + category picker + clear); FAB →
`expense-new`. Infinite scroll on the `Paginated` cursor.

**Balances** — headline Card (caller's net position); member chips row
(net per member, signed color tokens); transfer list — pairwise by
default with the "Simplify debts" toggle switching to the API
`simplified` array (R-cmoney-6, resolved Gate 2): "{A} → {B} {amount}";
rows involving the caller carry the action chevron, and **both seats open
`settle/[memberId]`** — the debtor arm settles there, the creditor arm lands
on that screen's creditor view, which carries "Request payment" (Q2-001,
ruled 2026-09-19; no separate request route). "All settled up" EmptyState
when no transfers.

### 2.3 Booking → expense prefill mapping (R-cmoney-11)

Deterministic mapping, defined once in `@gogo/shared` config (right-hand
values are the fixed Gate-2 taxonomy):

| `booking_category`                                 | `expense_category` |
| -------------------------------------------------- | ------------------ |
| `lodging`                                          | `lodging`          |
| `flight` · `train` · `car_rental` · `moped_rental` | `transport`        |
| `activity`                                         | `activities`       |
| `restaurant`                                       | `food`             |
| `other`                                            | `other`            |

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

| Rail                 | Format                                                                            | Notes                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venmo (app)          | `venmo://paycharge?txn=pay&recipients=<user>&amount=25.50&note=<urlenc>`          | `<user>` = `venmo_username` (stored bare — strip `@` at save); `txn=charge` reserved for R-cmoney-28. `venmo://users/<username>` is DEAD — never use |
| Venmo (web fallback) | `https://account.venmo.com/pay?txn=pay&recipients=<user>&amount=25.50&note=<enc>` | Used when `canOpenURL` fails (R-cmoney-16)                                                                                                           |
| Cash App             | `https://cash.app/$<cashtag>/25.50`                                               | dot-decimal 2dp; **no note support**; cashtag stored bare, `$` prefixed at render; handle HEAD-validated at save (users spec side)                   |
| PayPal.me            | `https://paypal.me/<user>/25.50USD`                                               | **always pin the currency code** (trip base) or the recipient's default currency applies                                                             |
| Zelle                | no link — copyable `zelle_handle` + `zelle_display_name` + amount shown adjacent  | R-cmoney-19; unofficial QR format skipped v1                                                                                                         |

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
   (method = rail, amount = stashed) → inline success state + success
   haptic (no toast — Q2-034) + R-cmoney-32 invalidation; [Not yet] clears
   the stash.
6. "Mark as settled" (any time) → method/amount/note Sheet → post → same
   invalidation. Works with zero handles, zero rails, zero deeplinks.

Creditor variant (R-cmoney-23): headline flips; actions are "Request
payment" (→ §2.7) and "Mark as settled" (records received money).

### 2.7 Send-the-bill sequence

1. Entry: the settle screen's creditor view — a balances row or member chip
   where the caller is creditor routes there (Q2-001, ruled 2026-09-19;
   `request/[requestId]` is the recipient screen only).
2. Amount Sheet (prefilled from displayed balance, editable) + optional note
   → `POST /settle-requests`.
3. iOS share sheet opens with message text in exactly this shape
   (Q2-039, ruled 2026-09-19) — the `gogo://` deep link first, the returned
   https `link` as the web fallback:
   `<requester> requests <amount> for <trip> — settle up in GoGo: <gogo://…> (web: <https://…>)`.
   Copy affordance as fallback.
4. Recipient opens link → R-nav-13 routing (auth stash-resume per R-nav-14)
   → `request/[requestId]` renders per R-cmoney-26; paying through it links
   the settlement to the request (`request_id` on the POST — api money spec
   R-money-18), flipping it to settled for both parties.
5. Open requests the caller sent render on the balances segment as subdued
   "requested <amount> on <date>" annotations on the relevant transfer
   rows. **Ruled (Q2-002, 2026-09-19): this ships as an empty seam** — the
   balances segment accepts an open-requests input and renders the
   annotations, but nothing feeds it, because no settle-request LIST
   endpoint exists on the wire (api money spec Q1–Q3 are create / read /
   cancel by id). The proposed path to make it live is a LIST read (api
   money spec R-money-32; Q2-030 — as shipped; Sean ruling pending)
   [NEEDS CLARIFICATION: Q2-030 — add a settle-request LIST endpoint so
   annotations go live, or leave the seam empty?]; until one ships the seam
   stays empty in production. Cancel does
   not wait on the annotation: the request's creator cancels from the
   request screen's creditor view via ConfirmDialog
   (→ `DELETE /settle-requests/:id`).

### 2.8 testID inventory (grammar: navigation spec §2.7 — `<screen>-<element>[-qualifier]`)

Screen roots: `money-screen`, `expense-new-screen`, `expense-detail-screen`,
`settle-screen`, `settle-request-screen`.

| Surface          | testIDs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Money tab        | `money-segment-budget` · `money-segment-expenses` · `money-segment-balances` · `money-fab-add-expense` · `money-button-ai-estimate` · `money-toggle-simplify` · `money-input-cap-total` · `money-budget-list-item-{category}` · `money-input-cap-{category}` · `money-expense-list` · `money-expense-list-item-{expenseId}` · `money-button-filter` · `money-sheet-filter` · `money-balance-list-item-{userId}` · `money-transfer-list-item-{fromUserId}-{toUserId}`                                                                                         |
| Add/edit expense | `expense-new-input-amount` · `expense-new-input-description` · `expense-new-picker-currency` · `expense-new-input-fx-rate` · `expense-new-input-base-amount` · `expense-new-picker-category` · `expense-new-picker-payer` · `expense-new-input-date` · `expense-new-toggle-participant-{userId}` · `expense-new-segment-split-equal` / `-exact` / `-percent` / `-shares` · `expense-new-input-share-{userId}` · `expense-new-input-percent-{userId}` · `expense-new-stepper-weight-{userId}` · `expense-new-button-booking-link` · `expense-new-button-save` |
| Expense detail   | `expense-detail-list-item-share-{userId}` · `expense-detail-button-booking` · `expense-detail-button-edit` · `expense-detail-button-delete` (ConfirmDialog derives `-confirm`/`-cancel`)                                                                                                                                                                                                                                                                                                                                                                     |
| Settle           | `settle-button-settle-up` · `settle-input-amount` · `settle-sheet-handoff` · `settle-button-venmo` · `settle-button-cashapp` · `settle-button-paypal` · `settle-button-zelle-copy` · `settle-button-mark-settled` · `settle-picker-method` · `settle-sheet-return` (+ `-confirm`/`-cancel`) · `settle-button-request`                                                                                                                                                                                                                                        |
| Settle request   | `settle-request-button-venmo` · `-cashapp` · `-paypal` · `-zelle-copy` · `settle-request-button-mark-settled` · `settle-request-button-back`                                                                                                                                                                                                                                                                                                                                                                                                                 |

(`settle-button-venmo` matches the worked example already in the navigation
spec §2.7 — kept identical.)

`settle-input-amount` is the **screen** field (R-cmoney-14). Sheet-internal
ids derive from each sheet's base per navigation spec §2.7 rule 4 — e.g.
`settle-sheet-mark-settled-*` and `settle-sheet-request-*` — and the pinned
`settle-picker-method` lives on the mark-as-settled sheet's method segments
(per-segment `-{method}` derivation). (Q2-032, ruled 2026-09-19)

`expense-new-picker-currency` is an uppercase 3-letter **code field**
(characters keyboard, no autocorrect, max length 3, as-you-type uppercase —
the BookingForm/B-20 precedent) carrying the pinned inventory id: this spec
pins the id, not the control style. (Q2-049, ruled 2026-09-19)

### 2.9 Empty / edge / error states

| Surface  | Condition                                 | Behavior                                                                                                            |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Budget   | no overall cap, no caps, no estimates     | EmptyState: "Plan your spending" + set-caps + AI CTA — spend-agnostic, even when spend exists (R-cmoney-29)         |
| Budget   | AI cap / kill-switch / offline / dateless | R-cmoney-3 state table                                                                                              |
| Expenses | none                                      | EmptyState + FAB pulse hint — finite 3-cycle ring, `useReduceMotion` honored, never an infinite loop (Q2-053)       |
| Expenses | filter yields none                        | "No matches" EmptyState + clear-filters action                                                                      |
| Expenses | malformed `?expenseId=` edit link         | "gone" EmptyState — never a blank create form (R-cmoney-12, Q2-054)                                                 |
| Balances | all zero                                  | "All settled up" EmptyState                                                                                         |
| Settle   | counterparty has zero handles             | hint + mark-as-settled only (R-cmoney-15)                                                                           |
| Settle   | non-USD base trip                         | USD rails hidden (R-cmoney-18)                                                                                      |
| Settle   | rail open failure                         | non-blocking error; screen stays usable (R-cmoney-22)                                                               |
| Request  | settled / cancelled / resolved            | resolved state, no pay buttons (R-cmoney-26)                                                                        |
| Request  | unknown id                                | EmptyState + back to money tab                                                                                      |
| Request  | non-member opener                         | R-nav-15 no-access state (members-only v1 — R-cmoney-27, resolved Gate 2)                                           |
| All      | query error                               | ErrorBanner + retry (R-ds-17)                                                                                       |
| All      | offline, active trip                      | segments mount from cache (nav §2.8 note); mutations while offline are the offline spec's queue — out of scope here |

### 2.10 Out of scope (explicit)

- Wire contracts, split/balance algorithms, authz — `.specs/api/money.spec.md`.
- Payment-handle entry/edit UX (profile/onboarding) — users/profile spec;
  the navigation spec's onboarding + profile-surface markers cover where it
  lives.
- Offline mutation queueing for money writes — offline/sync spec.
- Push notifications ("Alex added an expense", "request received") —
  notifications spec.
- Currency converter surface (PLANNING extra) — not a money-tab v1
  feature (the Gate-2 FX resolution powers expense entry only).
- Apple Cash — dead end per research (no third-party write path); not
  rendered even as a handle type.
- Zelle QR rendering — unofficial format, LOW stability (research); v1 is
  copy-only.

---

## 3. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on: MON-* API tasks, NAV-5 (deep-link registry), DS components
(+ the SegmentedControl addition flagged in §2.1).

| ID     | Task                                                                                                                     | Covers                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| CMON-1 | Money tab shell: segments + budget overview (rows, caps editing, progress states) + AI estimate CTA state machine.       | R-cmoney-1..4, 29, 30      |
| CMON-2 | Expense list + filters Sheet + expense detail (+ delete Confirm).                                                        | R-cmoney-5, 13, 29, 30, 32 |
| CMON-3 | Add/edit expense modal: integer-cents input, split picker × 4 with live shared-math preview, booking-link prefill.       | R-cmoney-7..12             |
| CMON-4 | Balances segment: nets, transfer rows, actions, request annotations.                                                     | R-cmoney-6, 29, 32         |
| CMON-5 | Settle screen: rail buttons + gating, link builder (shared formatter), Zelle copy, mark-as-settled Sheet, return prompt. | R-cmoney-14..24            |
| CMON-6 | Send-the-bill flow + request recipient screen + deep-link wiring.                                                        | R-cmoney-25..28            |

**Tests required (unit/integration):**

- [ ] Amount parser: `"25.50"` → 2550; `"25.5"` → 2550; JPY `"2550"` → 2550;
      rejects `"25.505"`; no float appears in the pipeline (Law #2)
- [ ] Split preview parity: client preview === shared `computeShares` output
      for all four types (property test over random inputs)
- [ ] Simplify toggle: pairwise renders by default; toggle switches to
      simplified and back; toggle state not persisted across mounts
- [ ] Multi-currency entry: online → rate prefetched + base prefilled,
      manual override respected; offline/FX-failure → manual rate required
      before save
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

_Trace: R-cmoney-N ↔ §2 sections inline. All 8 repeated markers resolved
at their canonical homes at Gate 2 (2026-07-09): overall cap (yes,
optional), taxonomy (fixed 6-value enum), FX (entry-time rate + manual
override), expense deletion (soft-delete + audit) — schema spec;
simplification (off by default, one-tap toggle) + split metadata (resolved
cents only) — api money spec; universal-link domain (Sean purchasing) +
non-member recipients (app + account required) — navigation spec. Zero
markers remain._
