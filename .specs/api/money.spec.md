# Money API Spec — expenses · splits · balances · settlements · budgets · AI estimate — `.specs/api/money.spec.md`

> **Task:** T-2.3 (MONEY bundle) · **Status:** DRAFT — pending Sean approval
> (P-2 gate 3). Not approvable until zero `[NEEDS CLARIFICATION]` markers
> remain.
>
> **Sources:** `CLAUDE.md` Law #2 (integer cents) · `docs/PLANNING.md
> § Architecture` (money entities; P-7) ·
> `.specs/database/schema.spec.md` §§3.3.12–3.3.15, 3.3.18–3.3.19 (**CANONICAL**
> — `expenses`, `expense_shares`, `settlements`, `budgets`, `ai_usage`,
> `ai_cache`; R-db-2/5/10/13/14/16) · `.specs/shared/contracts.spec.md`
> (**CANONICAL** — envelope, scalars, `domains/money.ts`,
> `ai/expense-estimate.ts`, descriptors) ·
> `.specs/research/payments-settle-up.md` (record-only ledger; settlement =
> first-class ledger entry; self-report everywhere) ·
> `.specs/research/ai-architecture.md` (Haiku, destination cache, caps) ·
> ADR-005 (entitlement seams; splitting free forever) ·
> `.specs/client/navigation.spec.md` (settle-request deep link, R-nav-13).
>
> **Companion:** `.specs/client/money.spec.md` — the screens consuming these
> endpoints. This file owns wire contracts + server behavior; that file owns
> UX. They must never drift.

---

## 1. Scope & conventions

Hono routers `expenses` and `settlements` (PLANNING § Component map) plus the
money-facing slice of the `ai` router: expense CRUD with atomic splits,
computed balances (pairwise + debt simplification), record-only settlements,
settle-up requests ("send the bill"), per-category budgets, and the AI
expense-estimation endpoint.

Conventions inherited wholesale (not restated per endpoint):

- **Validation:** every body/param/query validated by `@gogo/shared` schemas
  via `@hono/zod-validator` before handler logic (contracts spec R-shared-3).
- **Envelope:** success = documented schema, no wrapper; lists =
  `Paginated<T>`; every failure = `ApiError` with a shared `ErrorCode`
  (contracts spec §3.5). Non-members receive `NOT_FOUND` indistinguishable
  from absent resources (IDOR posture, PLANNING § Security).
- **Money on the wire:** integer cents via `Cents`/`PositiveCents`; floats
  fail validation (contracts spec R-shared-6; Law #2). "Cents" = ISO-4217
  minor units (JPY minor unit is 1 yen).
- **Descriptors:** every endpoint below is mirrored as an
  `EndpointDescriptor` in `@gogo/shared/domains/money` (contracts spec §3.6).
- **Transactions:** all multi-row writes run on the transaction-capable
  driver (Neon Postgres / `postgres-js` in tests — ADR-004; PLANNING:
  "expense + shares written atomically (transaction-capable driver only)").
- **Free forever:** no money endpoint except the AI estimate carries an
  entitlement check — ADR-005 binds splitting/settlement as never gated.

---

## 2. Requirements (EARS)

### Expenses & splits

- **R-money-1 (atomic writes):** WHEN an expense is created, or its amount or
  split is modified, THE SYSTEM SHALL write the `expenses` row and all its
  `expense_shares` rows in a single database transaction — never partially
  (mirror of schema spec R-db-2).
- **R-money-2 (exact-sum invariant):** WHEN an expense write carries shares
  THE SYSTEM SHALL reject it with `VALIDATION_FAILED` unless
  `SUM(share_cents) = amount_cents` exactly and every `share_cents ≥ 0`;
  no rounding remainder is ever dropped (schema spec R-db-2).
- **R-money-3 (deterministic split math):** WHEN a split of type `equal`,
  `percent`, or `shares` is computed THE SYSTEM SHALL use the single shared
  largest-remainder algorithm pinned in §3.3 (implemented once in
  `@gogo/shared`, used by client preview and tests), with remainder cents
  assigned by ascending `user_id`; identical inputs SHALL always produce
  identical shares.
- **R-money-4 (wire money):** WHEN any monetary amount crosses the wire on a
  money endpoint THE SYSTEM SHALL encode it as integer cents; float or
  negative amounts SHALL fail validation (contracts spec R-shared-6; Law #2).
- **R-money-5 (participants are members):** WHEN an expense is written THE
  SYSTEM SHALL verify `paid_by` and every `shares[].user_id` are current
  members of the trip, rejecting otherwise with `VALIDATION_FAILED`
  (ex-members remain in historical rows — see R-money-8 and R-money-28).
- **R-money-6 (FX gate):** WHEN an expense's `currency` differs from the
  trip's `base_currency` THE SYSTEM SHALL require `fx_rate` and
  `base_amount_cents` to be present and consistent, rejecting otherwise
  with `VALIDATION_FAILED`. Resolved at
  `.specs/database/schema.spec.md`:§3.3.12 (Gate 2, 2026-07-09): store
  original cents + base cents + the rate captured at entry; the rate is
  auto-fetched when online (free FX API — approved new dependency,
  candidates picked at build) with manual override always available; rates
  are never re-fetched after entry, and balances are always shown in trip
  base currency.
- **R-money-7 (category taxonomy):** WHEN an expense or budget is written THE
  SYSTEM SHALL validate `category` against the shared `expense_category`
  enum. Resolved at `.specs/database/schema.spec.md`:§3.2
  `expense_category` (Gate 2, 2026-07-09): fixed enum v1 — lodging,
  transport, food, activities, shopping, other (aligned with booking
  categories); not user-definable.

### Balances

- **R-money-8 (computed, never stored):** WHEN balances are requested THE
  SYSTEM SHALL compute them on read from `expenses` + `expense_shares` +
  `settlements` per trip in the trip's base currency (schema spec §3.3.12:
  "Balances are computed, never stored"); every user referenced by those rows
  participates in the math whether or not they are still a member; the sum of
  all members' net positions SHALL equal zero exactly.
- **R-money-9 (base-currency allocation):** WHEN a non-base-currency
  expense enters balance math THE SYSTEM SHALL derive base-currency shares by
  allocating `base_amount_cents` across shares proportionally via the §3.3
  largest-remainder method — never by rounding each share independently — so
  allocated base shares always sum to `base_amount_cents` exactly.
- **R-money-10 (simplification):** WHEN simplified transfers are requested
  THE SYSTEM SHALL produce them with the deterministic greedy algorithm in
  §3.5: at most `members − 1` transfers, preserving every member's net
  position exactly, identical output for identical inputs. Display default
  — decided: simplification is **off by default**; the balances screen
  shows pairwise who-owes-who with a one-tap "simplify debts" view toggle
  (Splitwise trust precedent — simplification changes who pays whom). The
  API always returns both; the toggle is client-side (client money spec).
  (Resolved 2026-07-09, Gate 2)

### Settlements

- **R-money-11 (record-only):** THE SYSTEM SHALL store settlements as ledger
  entries only — no external transaction IDs, no payment-state machine, no
  money movement (mirror of schema spec R-db-14; research: no rail has
  webhooks — settlement confirmation is user self-report, everywhere).
- **R-money-12 (who can record):** WHEN a settlement is recorded THE SYSTEM
  SHALL require the caller to be a current trip member AND one of the two
  parties (`from_user_id` or `to_user_id`) regardless of role (schema spec
  §3.3.14 `created_by`: "either party may"); any other caller receives
  `FORBIDDEN`.
- **R-money-13 (base currency):** WHEN a settlement is recorded THE SYSTEM
  SHALL require `currency = trip.base_currency` (schema spec §3.3.14:
  base by convention) and `amount_cents > 0`, `from ≠ to`.
- **R-money-14 (immediate effect):** WHEN a settlement write commits THE
  SYSTEM SHALL reflect it in any subsequent balance read (no async
  settlement pipeline exists to wait on).
- **R-money-15 (correction path):** WHEN the recorder of a settlement
  (`created_by = caller`) deletes it within 24 hours of `created_at` THE
  SYSTEM SHALL hard-delete the row (fat-finger window); WHEN 24 hours have
  passed, or the caller is not the recorder, THE SYSTEM SHALL reject with
  `FORBIDDEN` — the correction path after the window is a counter-entry
  (record a settlement in the opposite direction), preserving the visible
  ledger. (Resolved 2026-07-09, Gate 2)

### Settle-up requests ("send the bill")

- **R-money-16 (creation):** WHEN a settle-up request is created THE SYSTEM
  SHALL require the caller to be the creditor (`to_user_id = caller`), a
  current trip member, and SHALL default `amount_cents` to the current
  pairwise debt from `from_user_id` to the caller (rejecting with `CONFLICT`
  when that debt is zero or negative and no explicit amount is given); the
  response SHALL include the universal link
  `https://<domain>/t/<tripId>/request/<requestId>` per the navigation spec
  deep-link registry (§2.3), mirrored on the `gogo://` scheme.
- **R-money-17 (minimum disclosure):** WHEN a request detail is read THE
  SYSTEM SHALL expose only: the requester's `UserProfile` (display name,
  avatar, payment handles — deliberately member-visible per contracts spec
  §3.4), trip name, amount + currency, note, status, and timestamps — never
  the trip's wider expense data.
- **R-money-18 (resolution):** WHEN a settlement is recorded through a
  request THE SYSTEM SHALL link it (`settlement_id`) and set the request
  `status = 'settled'` in the same transaction; WHEN a request is read while
  the pairwise debt from → to has reached zero by any other path THE SYSTEM
  SHALL report it as resolved (derived flag) even if `status` is still
  `'open'`.
- **R-money-19 (entity approved):** The `settlement_requests` table is an
  **approved** entity-list addition — the §3.6 design lands verbatim in
  `.specs/database/schema.spec.md` §3.3 with its migration (one-source
  rule; the schema spec is folding it in). Persisted requests (not
  stateless links) are the decided shape, powering the nav spec's
  "missing/settled request" states. (Resolved 2026-07-09, Gate 2)
- Non-member recipients of request links — Resolved at
  `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09): v1 requires
  app install + an account (no web surface exists); this API's
  request-detail endpoint requires trip membership.

### Budgets

- **R-money-20 (per-category caps + overall cap):** WHEN a budget cap is
  set THE SYSTEM SHALL upsert the `(trip_id, category)` row (schema spec
  §3.3.15 unique) with `cap_cents ≥ 0` or `null` (= no cap, estimate only),
  `currency = trip.base_currency`; actual spend per category SHALL be
  computed on read from expenses (effective base amounts), never stored.
  Resolved at `.specs/database/schema.spec.md`:§3.3.15 (Gate 2,
  2026-07-09): an optional **overall trip cap** exists alongside the
  per-category caps — it rides the same read/write surface as the `total`
  block (storage mechanism is the schema spec's canonical call).

### AI expense estimation

- **R-money-21 (gate order):** WHEN the estimate endpoint executes THE SYSTEM
  SHALL, in order: authenticate → verify membership → require trip
  `start_date` AND `end_date` (else `VALIDATION_FAILED`) → check the
  destination cache → only on cache miss read `entitlements` + `ai_usage`
  within the request before calling the model (mirror of schema spec R-db-5;
  ADR-005), rejecting with `AI_CAP_EXCEEDED` (429) at the user's effective
  daily cap or `AI_DISABLED` (503) when the global kill-switch is tripped.
- **R-money-22 (cache-first):** WHEN the destination cache holds an
  unexpired entry for the derived key (schema spec R-db-10:
  `hash(feature, destination, travel_style, season, schema_version)`, no user
  identifier) THE SYSTEM SHALL serve it without calling the model and without
  incrementing `ai_usage`; both hit and miss paths SHALL upsert the trip's
  `budgets.ai_estimate_cents` values (the cache is destination-level; the
  budget write is trip-level).
- **R-money-23 (validated output):** WHEN the model responds THE SYSTEM SHALL
  parse it against the `ai/expense-estimate` schema (`zodOutputFormat`) and
  run the paired server-side refinement (contracts spec R-shared-7: numeric
  ranges post-parse — `0 ≤ low_cents ≤ high_cents`, known categories, known
  basis) before caching or returning; refinement failure is `INTERNAL`, never
  a write of unvalidated JSONB (schema spec R-db-17).
- **R-money-24 (style input):** WHEN deriving the cache key THE SYSTEM SHALL
  use the caller's `UserPrefs.travel_style` (fallback key segment `default`
  when unset). Resolved at `.specs/shared/contracts.spec.md`:§3.4 `user.ts`
  (Gate 2, 2026-07-09): multi-tag from the fixed set budget, comfort,
  luxury, foodie, adventure, culture, nightlife, family, relaxation — the
  key segment is the sorted tag list (canonical serialization per the
  contracts spec).

### Authz & deletion

- **R-money-25 (read scope):** WHEN any money read executes THE SYSTEM SHALL
  require current trip membership (any role); non-members receive `NOT_FOUND`
  indistinguishable from absence (contracts spec §3.5; R-nav-15 posture).
- **R-money-26 (write roles):** WHEN an expense is created THE SYSTEM SHALL
  allow any current member **including `viewer`** (viewers are travelers,
  not spectators — trips spec §3.2 / R-trips-21); WHEN an expense is edited
  or deleted THE SYSTEM SHALL require the caller to be its creator
  (`created_by`) or the trip `owner` (dispute-breaker — trips spec §3.2
  "Edit / delete any expense"); WHEN a budget write executes THE SYSTEM
  SHALL require role `owner` or `editor`. Settlements and settle-up
  requests follow the party rules (R-money-12/16) regardless of role — a
  viewer must always be able to settle their own debts. (Resolved
  2026-07-09, Gate 2)
- **R-money-27 (expense deletion):** WHEN an expense is deleted THE SYSTEM
  SHALL **soft-delete** it — set `deleted_at`/`deleted_by` (schema spec
  §3.3.12 owns the columns), exclude it and its shares from balance math
  and default lists, and keep a visible audit-trail entry ("Sean deleted
  'Dinner ¥12,000'") in the expense history. Resolved at
  `.specs/database/schema.spec.md`:§3.3.12 (Gate 2, 2026-07-09):
  soft-delete with visible audit trail.
- **R-money-28 (member removal):** WHEN a member with a nonzero balance is
  removed or leaves THE SYSTEM SHALL allow it — removal is never blocked on
  balances; their expense/share/settlement rows survive (R-db-16 posture,
  R-money-8) and balances involving the departed member remain computed and
  shown to remaining members. (Resolved 2026-07-09, Gate 2)
- **R-money-29 (split metadata):** Decided: persist **resolved cents only**
  in v1 (schema spec §3.3.13 stands unchanged; no `split_meta` column) —
  expense detail/edit derives display mode on read (equal is detectable
  within remainder tolerance; percent/shares re-open as exact). Revisit
  `split_meta` only if re-edit demand materializes. (Resolved 2026-07-09,
  Gate 2)

---

## 3. Design

### 3.1 Route inventory

All routes trip-scoped; `Auth: Required` throughout (JWT — Gate-1 auth lock).

| # | Method + path | Purpose | Role |
|---|---|---|---|
| E1 | `POST /trips/:tripId/expenses` | Create expense + shares (atomic) | member incl. viewer (R-money-26) |
| E2 | `GET /trips/:tripId/expenses` | List/filter expenses | member |
| E3 | `GET /trips/:tripId/expenses/:expenseId` | Expense detail + shares | member |
| E4 | `PATCH /trips/:tripId/expenses/:expenseId` | Update expense/split (atomic) | creator or owner (R-money-26) |
| E5 | `DELETE /trips/:tripId/expenses/:expenseId` | Soft-delete expense (audit trail — R-money-27) | creator or owner (R-money-26) |
| B1 | `GET /trips/:tripId/balances` | Pairwise nets + simplified transfers | member |
| S1 | `POST /trips/:tripId/settlements` | Record a settlement | party (R-money-12) |
| S2 | `GET /trips/:tripId/settlements` | List settlements | member |
| S3 | `DELETE /trips/:tripId/settlements/:settlementId` | Delete own settlement ≤ 24 h (R-money-15) | recorder only |
| Q1 | `POST /trips/:tripId/settle-requests` | Create request + link | creditor (R-money-16) |
| Q2 | `GET /trips/:tripId/settle-requests/:requestId` | Request detail (deep-link data) | member (v1 — resolved Gate 2) |
| Q3 | `DELETE /trips/:tripId/settle-requests/:requestId` | Cancel request (`status = 'cancelled'`) | request creator |
| G1 | `GET /trips/:tripId/budgets` | Budget rows + computed spend | member |
| G2 | `PUT /trips/:tripId/budgets/:category` | Upsert category cap | editor+ |
| A1 | `POST /trips/:tripId/ai/expense-estimate` | AI per-category estimates | editor+ (writes budgets); cap-checked |

(Research names the flat path `POST /ai/expense-estimate`; pinned trip-scoped
here because every grounding input — destination, dates, party size — and the
budget write are trip-scoped. The `ai_feature` value is `expense_estimate`.)

### 3.2 Endpoint contracts

Shapes reference `@gogo/shared` names; field-exact Zod lives there
(contracts spec §3.4 `money.ts`). Wire casing is `snake_case` = DB columns.

#### POST /trips/:tripId/expenses

Create an expense with its shares atomically. **Auth**: Required (any
member incl. viewer — R-money-26, resolved Gate 2).

**Request** — `ExpenseCreate`:

```
{ description: string, category: expense_category, paid_by: Uuid,
  amount_cents: PositiveCents, currency: CurrencyCode,
  fx_rate?: string, base_amount_cents?: PositiveCents,   // REQUIRED pair when currency ≠ base; rate
                                                          //   auto-fetched client-side when online,
                                                          //   manual override always (R-money-6)
  booking_id?: Uuid, spent_at?: ISODate,                  // default: server CURRENT_DATE
  shares: Array<{ user_id: Uuid, share_cents: Cents }> }  // resolved cents; SUM == amount_cents
```

The wire always carries **resolved shares** (contracts spec §3.4 locks
`ExpenseCreate` with inline shares + sum `superRefine`); split-type math runs
client-side through the shared §3.3 algorithm. Zero shares are legal (payer
covered someone entirely); participants not in `shares` simply owe nothing.

**Response 201** — `Expense` (row + `shares[]` + `effective_base_cents`).

**Errors**: 400 `VALIDATION_FAILED` — sum mismatch, non-member participant,
non-base currency without the `fx_rate` + `base_amount_cents` pair
(R-money-6), unknown category, `booking_id` not in this trip; 404
`NOT_FOUND` — non-member caller or missing trip.

**Requirements covered**: R-money-1..7, R-money-25/26

**Tests required**:
- [ ] Happy path: expense + N shares committed atomically; sum invariant holds
- [ ] Sum mismatch by 1 cent → 400, zero rows written (transaction rollback)
- [ ] Share user not a member → 400; booking from another trip → 400
- [ ] Non-base currency without fx pair → 400; with pair → 201 (R-money-6)
- [ ] Authz: non-member → 404; viewer CAN create (R-money-26)
- [ ] Mid-transaction failure injection leaves zero orphan rows (R-money-1)

#### GET /trips/:tripId/expenses

Paginated expense list, newest first. **Auth**: Required (member).

**Request query**: `cursor?`, `limit?` (server-capped), `category?`,
`member?` (Uuid — payer OR share-holder), `from?`/`to?` (ISODate on
`spent_at`).

**Response 200** — `Paginated<Expense>`; ordered `spent_at DESC,
created_at DESC` (matches `(trip_id, spent_at)` index, schema spec §3.5).

**Errors**: 404 non-member; 400 bad query.

**Requirements covered**: R-money-25

**Tests required**:
- [ ] Pagination cursor round-trip; filters (category, member-as-payer,
      member-as-share-holder, date range)
- [ ] Authz: non-member → 404

#### GET /trips/:tripId/expenses/:expenseId · PATCH · DELETE

Detail / update / delete. **Auth**: Required (member read; write = expense
creator or trip owner — R-money-26, resolved Gate 2).

**PATCH request** — `ExpenseUpdate`: any `ExpenseCreate` field optional, with
the coupling rule: a body containing `amount_cents` MUST contain `shares`;
`shares` alone is allowed iff it sums to the stored amount. Any accepted
shares payload **replaces** the full share set in one transaction
(R-money-1/2 re-run in full).

**DELETE**: soft-delete (sets `deleted_at`/`deleted_by`; shares excluded
from balance math with the expense) behind a client-side ConfirmDialog;
the deletion appears as a visible audit-trail entry (R-money-27, resolved
Gate 2).

**Errors**: 404 (missing id, or non-member — indistinguishable); 400 sum/
coupling violations; 403 — caller is neither creator nor owner.

**Requirements covered**: R-money-1/2/5, R-money-26/27

**Tests required**:
- [ ] PATCH amount without shares → 400; shares-only summing to stored
      amount → 200; stale share set fully replaced (no orphans)
- [ ] DELETE soft-deletes; balances + default lists exclude it; audit entry
      visible; row survives in DB (R-money-27)
- [ ] Authz: creator (any role) edits/deletes own; owner edits/deletes any;
      editor on another's expense → 403; wrong trip's expenseId → 404

#### GET /trips/:tripId/balances

Computed balances document. **Auth**: Required (member).

**Response 200**:

```
{ currency: CurrencyCode,                                  // trip base
  members: Array<{ user_id: Uuid, net_cents: number }>,    // signed; + = is owed; Σ = 0
  pairwise: Array<Balance>,                                 // contracts spec §3.4: { trip_id, user_id,
                                                            //   counterparty_id, net_cents } — one row per
                                                            //   unordered pair (user_id < counterparty_id),
                                                            //   net_cents signed: + = counterparty owes user_id
  simplified: Array<{ from_user_id: Uuid, to_user_id: Uuid, amount_cents: PositiveCents }> }
```

Zero-net pairs omitted from `pairwise`; ex-members appear wherever history
references them (R-money-8). Clients render `pairwise` by default with a
one-tap simplify toggle (R-money-10, resolved Gate 2) — the API always
returns both.

**Requirements covered**: R-money-8/9/10

**Tests required**:
- [ ] Formula fixtures (§3.4): multi-expense, multi-payer, settlement-offset,
      zero-share cases; Σ member nets = 0 in every fixture
- [ ] Non-base-currency expense allocated per §3.3 (no per-share rounding
      drift) — fixture with a prime amount ÷ 3
- [ ] Simplified: ≤ n−1 transfers; per-member nets preserved; deterministic
      across runs and row orderings
- [ ] Ex-member with history still appears; authz: non-member → 404

#### POST /trips/:tripId/settlements

Record a settlement (record-only ledger entry). **Auth**: Required (party —
R-money-12).

**Request** — `SettlementCreate`:

```
{ from_user_id: Uuid, to_user_id: Uuid, amount_cents: PositiveCents,
  currency: CurrencyCode,            // must equal trip base (R-money-13)
  method: settlement_method,         // venmo | cashapp | paypal | zelle | cash (schema spec §3.2)
  note?: string, settled_at?: ISODateTime,   // default now; not future
  request_id?: Uuid }                // links + settles an open request (R-money-18)
```

**Response 201** — `Settlement`.

**Errors**: 403 caller not a party; 400 self-settlement / non-base currency /
future `settled_at`; 404 non-member; 409 `CONFLICT` — `request_id` present
but that request is not `open` or is between a different pair.

**Requirements covered**: R-money-11..14, R-money-18

**Tests required**:
- [ ] Happy path both directions (payer records; payee records)
- [ ] Third member (non-party) → 403; non-member → 404
- [ ] Non-base currency → 400; from = to → 400
- [ ] With `request_id`: settlement + request status flip in one transaction
- [ ] Balance read immediately reflects the settlement (R-money-14)

#### GET /trips/:tripId/settlements

**Auth**: Required (member). **Request query**: `cursor?`, `limit?`.
**Response 200** — `Paginated<Settlement>`, `settled_at DESC`.
**Requirements covered**: R-money-25.
**Tests required**: [ ] list + pagination; [ ] authz non-member → 404.

#### DELETE /trips/:tripId/settlements/:settlementId

Fat-finger correction window (R-money-15, resolved Gate 2). **Auth**:
Required (recorder only, ≤ 24 h after `created_at`).

**Response 204** — hard delete; any linked settle-request reverts to
`status = 'open'` (`settlement_id` cleared) in the same transaction.

**Errors**: 403 `FORBIDDEN` — caller is not the recorder, or the 24-hour
window has passed (correction path: counter-entry); 404 non-member/missing.

**Requirements covered**: R-money-15

**Tests required**:
- [ ] Recorder deletes within 24 h → 204; balances recompute; linked request reopens
- [ ] Recorder after 24 h → 403; other party any time → 403
- [ ] Authz: non-member → 404

#### POST /trips/:tripId/settle-requests · GET :requestId · DELETE :requestId

"Send the bill." **Auth**: Required (create: creditor = caller; read:
member — non-member recipients require app install + account v1, resolved
Gate 2 at the navigation spec; cancel: request creator).

**Create request** — `SettleRequestCreate`:

```
{ from_user_id: Uuid,                // the debtor being billed
  amount_cents?: PositiveCents,      // default: current pairwise debt from_user → caller
  note?: string }
```

**Response 201** — `SettleRequest`:

```
{ id, trip_id, from_user_id, to_user_id, amount_cents, currency,   // trip base
  note?, status: 'open' | 'settled' | 'cancelled', resolved: boolean,  // derived (R-money-18)
  settlement_id?: Uuid, created_by, created_at,
  link: string }    // https://<domain>/t/<tripId>/request/<requestId> — domain resolved at nav
                    //   spec §1 (Gate 2: Sean purchasing; format domain-agnostic)
```

**GET Response 200** — `SettleRequest` plus requester `UserProfile`
(R-money-17 minimum disclosure). **DELETE** sets `status = 'cancelled'`
(soft — the link must render a resolved/cancelled state, not 404, per the
navigation registry's "missing/settled request" row).

**Errors**: 409 `CONFLICT` — no positive debt and no explicit amount, or
cancel of a non-open request; 404 non-member/missing; 400 debtor not a
member / debtor = caller.

**Requirements covered**: R-money-16..19

**Tests required**:
- [ ] Default amount = current pairwise debt; zero debt without explicit
      amount → 409
- [ ] Detail exposes only R-money-17 fields (snapshot test against a rich trip)
- [ ] Settled-elsewhere pair → `resolved: true` while `status = 'open'`
- [ ] Cancel by non-creator → 403; authz: non-member → 404

#### GET /trips/:tripId/budgets · PUT /trips/:tripId/budgets/:category

Budget rows + computed actuals; upsert caps. **Auth**: Required (member read;
editor+ write).

**GET Response 200**:

```
{ items: Array<{ category: expense_category, cap_cents: Cents | null,
                 ai_estimate_cents: Cents | null, ai_estimated_at: ISODateTime | null,
                 currency: CurrencyCode, spent_cents: Cents }>,   // computed: Σ effective base per category
  total: { cap_cents: Cents | null,    // optional overall trip cap (R-money-20, resolved Gate 2)
           spent_cents: Cents, ai_estimate_cents: Cents | null } }
```

`items` always contains every `expense_category` value (absent rows
synthesized with nulls) so the client renders the full taxonomy.

**PUT Request**: `{ cap_cents: Cents | null }` — upsert on
`(trip_id, category)`; `null` clears the cap, preserving any AI estimate.
The overall cap rides the same verb with the `total` pseudo-category path
segment (storage mechanism per schema spec §3.3.15, resolved Gate 2).

**Errors**: 400 unknown category / negative cap; 403 viewer; 404 non-member.

**Requirements covered**: R-money-20, R-money-25/26

**Tests required**:
- [ ] Upsert create-then-update; null clears cap, estimate survives
- [ ] Overall (`total`) cap set/cleared; returned in the `total` block
- [ ] `spent_cents` matches expense fixtures incl. FX-allocated ones
- [ ] Unknown category → 400; authz both verbs

#### POST /trips/:tripId/ai/expense-estimate

Destination-cached, Haiku-backed per-category estimation; writes
`budgets.ai_estimate_cents`. **Auth**: Required (editor+; entitlement/cap per
R-money-21).

**Request**: `{}` — all inputs server-derived: `destination_name` (+
hemisphere from `destination_lat` when present), `start_date`/`end_date`,
party size = current member count, caller's `travel_style` (R-money-24).

**Response 200**:

```
{ currency: 'USD',            // v1: cached estimates are USD (cache key has no currency
                              //   input per R-db-10); non-USD base trips convert at write
                              //   time via the R-money-6 FX source (resolved Gate 2, §3.7)
  party_size: int, days: int, nights: int,
  estimates: Array<{ category: expense_category,
                     basis: 'per_person_per_day' | 'per_person_per_night' | 'per_person_total',
                     low_cents: Cents, high_cents: Cents,          // per-basis, from the model
                     low_total_cents: Cents, high_total_cents: Cents,   // ×days/nights ×party (§3.7)
                     estimate_cents: Cents }],                      // midpoint written to budgets
  cached: boolean, model: string, estimated_at: ISODateTime }
```

**Errors**: 400 `VALIDATION_FAILED` — trip missing `start_date`/`end_date`;
429 `AI_CAP_EXCEEDED`; 503 `AI_DISABLED`; 403 viewer; 404 non-member;
500 `INTERNAL` — output failed schema/refinement (never cached).

**Requirements covered**: R-money-21..24, R-db-5/10 mirrors

**Tests required**:
- [ ] Gate order: dateless trip 400s before any cache/cap read
- [ ] Cache hit: no model call, no `ai_usage` increment, budgets still upserted
- [ ] Cache miss: cap consumed; at-cap → 429; kill-switch flag → 503
- [ ] Refinement rejects `low > high` / unknown category (mocked model) →
      500, nothing cached, no budget write
- [ ] Totals math per basis (fixtures incl. 1-night trip, solo trip)
- [ ] Key changes with destination/style/season/schema-version; identical for
      two different users (R-db-10 anonymity)

### 3.3 Split computation (the pinned algorithm)

Schema spec §3.3.12 delegates: "exact algorithm is the expenses API spec's to
pin." Pinned here; implemented once as a pure function in
`@gogo/shared/domains/money` (`computeShares`) used by the client's live
preview and by tests — the server never receives split inputs, only resolved
shares, and re-validates the R-money-2 invariant on every write.

Inputs: `amount_cents A > 0`; ordered participant set `P` (deduplicated,
sorted ascending by canonical lowercase `user_id` string — **all ordering in
this spec means this**); per-type inputs. All arithmetic is integer.

| Type | Input | Exact quota per participant `i` | Method |
|---|---|---|---|
| `equal` | none | `A / n` | base `floor(A/n)` each; remainder `r = A − n·floor(A/n)` cents assigned +1 each to the first `r` participants in `user_id` order |
| `percent` | `percent_bp_i` (integer basis points; `Σ = 10000` exactly, else invalid) | `A · percent_bp_i / 10000` | largest-remainder (below) |
| `shares` | integer weight `w_i ≥ 1`; `W = Σ w_i` | `A · w_i / W` | largest-remainder (below) |
| `exact` | `share_cents_i` | as entered | no computation; invalid unless `Σ = A` |

**Largest-remainder:** `base_i = floor(quota_i)`; leftover
`r = A − Σ base_i` (`0 ≤ r < n`); sort participants by fractional remainder
of `quota_i` descending, ties by `user_id` ascending; the first `r` get
`+1` cent. Guarantees `Σ share_i = A` exactly and full determinism
(R-money-3). Percent fractions use exact rational comparison
(`A·bp mod 10000`), never floats — Law #2 applies to intermediates too.

The same function allocates base-currency amounts in §3.4 (quota
`B · share_cents_i / A` with `B = base_amount_cents`).

### 3.4 Balance computation

Per trip, in trip base currency, on read (R-money-8):

1. **Effective base amount** of an expense:
   `B = base_amount_cents ?? amount_cents` (equal iff `currency =
   base_currency`; the pair of FX columns is present exactly when currencies
   differ — R-money-6, schema spec §3.3.12 CHECK).
2. **Base shares**: when `B ≠ amount_cents`, allocate `B` across the
   expense's shares proportionally by §3.3 largest-remainder (R-money-9);
   otherwise base share = `share_cents`.
3. **Debt edges**: for each expense with payer `p`, each base share
   `(w, s)` with `w ≠ p` adds `debt[w→p] += s`. Each settlement `(f, t, a)`
   adds `debt[t→f] += a` — equivalently offsets `debt[f→t]`.
4. **Pairwise net**: `net(u,v) = debt[u→v] − debt[v→u]` (report once per
   unordered pair, sign convention per B1's response shape).
5. **Member net position**: `net(u) = Σ_v (debt[v→u] − debt[u→v])`;
   `Σ_u net(u) = 0` always (each expense contributes `+s` to the payer and
   `−s` to the share-holder; settlements transfer symmetrically).

Implemented as a pure function (`computeBalances`) in
`@gogo/shared/domains/money` over plain row arrays — server is the
authoritative executor; the client may reuse it for optimistic display.

### 3.5 Debt simplification

Greedy max-matching over net positions (`simplifyDebts`, same shared module):

1. From §3.4 nets, split members into debtors (`net < 0`) and creditors
   (`net > 0`); drop zeros.
2. Repeat until empty: take the largest-magnitude debtor and creditor (ties
   → ascending `user_id`); emit transfer `debtor → creditor` of
   `min(−net_d, net_c)`; subtract; drop any party reaching zero.
3. Output sorted by (`from_user_id`, `to_user_id`).

Properties (all test-pinned): terminates in ≤ `members − 1` transfers; every
member's net position is preserved exactly; integer-only; deterministic
(R-money-10). Greedy does not guarantee the theoretical minimum transfer
count (that matching problem is NP-hard) — same trade-off Splitwise ships.
Simplification is **display/suggestion only**: settlements are always
recorded against the real pair that pays (record-only ledger unaffected).

### 3.6 Settle-up request entity (approved — Gate 2, 2026-07-09)

Approved table — moves verbatim into `.specs/database/schema.spec.md` §3.3
(one-source rule; schema spec stays canonical and is folding it in):

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK; the `requestId` in the universal link |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `from_user_id` | `uuid` | no | — | Debtor; FK → `users.id` ON DELETE RESTRICT; `CHECK (from_user_id <> to_user_id)` |
| `to_user_id` | `uuid` | no | — | Creditor = creator; FK → `users.id` ON DELETE RESTRICT |
| `amount_cents` | `bigint` | no | — | `CHECK (> 0)` |
| `currency` | `char(3)` | no | — | Trip base (R-money-13 convention); uppercase check |
| `note` | `text` | yes | — | |
| `status` | `request_status` | no | `'open'` | New pgEnum `open / settled / cancelled` (append-only; lands in `@gogo/shared` enums per contracts spec §3.2) |
| `settlement_id` | `uuid` | yes | — | FK → `settlements.id` ON DELETE SET NULL; set when settled through the request |

- **Indexes:** `(trip_id, status)` — open-requests list; FK indexes.
- Follows all schema-spec §1 conventions (`created_at`/`updated_at`, uuid PK).
- Token entropy note: `requestId` is a uuid in a member-guarded route — it
  is authz-checked (R-money-25), not a bearer secret like `invites.token`.
  Non-member links resolved Gate 2 as app-install + account required (no
  public recipient view v1); if a web phase ever adds one, the id must be
  replaced by a ≥128-bit token per R-db-9's precedent. Flagged for the
  threat model.

### 3.7 AI estimation pipeline

```
auth → membership → dates gate → deriveAiCacheKey → [hit → payload]
     → [miss → entitlement + ai_usage gate → kill-switch gate
        → Haiku 4.5 structured output → server-side refine → ai_cache write]
→ totals math → budgets upsert (transaction) → ai_usage increment (miss only) → response
```

- **Model/config:** Haiku 4.5, live (research: ~$0.004/call); TTL 14–30d per
  feature config; `ai_feature = 'expense_estimate'`; feature→model map in
  `@gogo/shared/config/ai-pricing.ts`. Server-side only — no keys in the app.
- **Key inputs** (`deriveAiCacheKey`, contracts spec §3.7): `destination` =
  lowercased, whitespace-collapsed `trips.destination_name`; `travel_style`
  per R-money-24; `season` = meteorological season of `start_date`, hemisphere
  from the sign of `destination_lat` (northern assumed when null);
  `schema_version` from `ai/expense-estimate.ts`. Duration and party size are
  deliberately **not** key inputs (R-db-10 fixes the input list) — which
  forces per-person/per-day bases in the cached payload.
- **Prompt contract:** estimates requested per category of the shared
  taxonomy (R-money-7, resolved Gate 2), in USD, per the §3.2 basis enum, with explicit
  permission to omit categories it can't estimate (anti-hallucination:
  permission to not know; omitted categories return `null` estimates, they
  don't invent).
- **Totals math** (integer): `days = end − start + 1`, `nights = end − start`
  (min 1 day / 0 nights guarded by the dates gate); `per_person_per_day` ×
  days × party; `per_person_per_night` × nights × party; `per_person_total`
  × party. `estimate_cents = floor((low_total + high_total) / 2)` — the
  single value upserted into `budgets.ai_estimate_cents` +
  `ai_estimated_at = now()` for every estimated category, in one transaction.
- **Currency:** cached payloads are USD (key has no currency dimension).
  Trips with `base_currency = 'USD'` (the default) write directly; non-USD
  base trips convert the midpoint USD→base at estimate time via the FX
  source resolved in R-money-6 (Gate 2 — free FX API, rate captured at
  conversion time), then floor to integer cents — budget rows stay in trip
  base currency, never mixed. FX-source unavailable → `VALIDATION_FAILED`
  with a client-facing message rather than a mixed-currency write.
- **Re-estimation** is allowed any time (cache makes repeats ~free); the
  budget upsert overwrites prior estimates.

### 3.8 Authz matrix (money domain)

| Action | owner | editor | viewer | non-member |
|---|---|---|---|---|
| Read expenses / balances / settlements / budgets / requests | ✓ | ✓ | ✓ | 404 |
| Create expense | ✓ | ✓ | ✓ (R-money-26, resolved Gate 2) | 404 |
| Edit / delete own-created expense | ✓ | ✓ | ✓ | 404 |
| Edit / delete any expense | ✓ (dispute-breaker) | ✗ | ✗ | 404 |
| Delete own settlement ≤ 24 h | recorder-only | recorder-only | recorder-only | 404 |
| Record settlement | party-only | party-only | party-only | 404 |
| Create settle-request | creditor-only | creditor-only | creditor-only | 404 |
| Cancel settle-request | creator-only | creator-only | creator-only | 404 |
| Upsert budget caps | ✓ | ✓ | ✗ | 404 |
| Trigger AI estimate | ✓ | ✓ | ✗ | 404 |

Payment handles render from `UserProfile` (member-visible by design,
contracts spec §3.4) — no additional read surface added here.

### 3.9 Out of scope (explicit)

- **Client UX** — `.specs/client/money.spec.md` (deeplink handoff, return
  prompts, device-test checklist live there).
- **FX-rate provider selection** — the free FX API is an approved new
  dependency (R-money-6, resolved Gate 2); the specific provider is picked
  at build time (Autonomy Contract §3 escalation already surfaced).
- **Member add/remove flows** — trips/members spec (removal with nonzero
  balance is allowed — R-money-28, resolved Gate 2).
- **Booking→expense creation UX** ("add expense from booking") — bookings
  spec owns the booking side; this API only validates `booking_id`.
- **Offline mutation queue semantics** for money writes — offline/sync spec
  (contracts spec §3.8).
- **Push notifications** for new expenses/requests — notifications spec.
- **Cross-trip "what do I owe" summaries** (`expense_shares (user_id)` index
  exists, schema spec §3.3.13) — no v1 endpoint; future spec change.
- **AI spend kill-switch job** (rollup, $50/$100 thresholds) — AI/ops spec;
  this endpoint only honors the flag (`AI_DISABLED`).

---

## 4. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on DB-1 + SH-1 (schema + shared) having landed.

| ID | Task | Covers |
|---|---|---|
| MON-1 | Shared money math: `computeShares` (4 types, largest-remainder), `computeBalances`, `simplifyDebts`, base-allocation — pure functions + exhaustive property tests (`@gogo/shared/domains/money`). | R-money-3/8/9/10 |
| MON-2 | Expenses CRUD (E1–E5): atomic writes, exact-sum enforcement, FX pair validation, soft-delete + audit trail, filters, creator-or-owner authz. | R-money-1/2/4/5/6/7, 25/26/27 |
| MON-3 | Balances endpoint (B1) over MON-1 functions; fixtures incl. FX allocation + ex-members. | R-money-8/9/10 |
| MON-4 | Settlements (S1–S3): party rule, base-currency rule, request linking, 24 h recorder-delete window. | R-money-11..15, 18 |
| MON-5 | Settle-requests (Q1–Q3) + `settlement_requests` migration (entity approved Gate 2) + link construction (domain-agnostic format; universal-link domain pending Sean's purchase). | R-money-16..19 |
| MON-6 | Budgets (G1, G2): upsert + computed spend + full-taxonomy synthesis. | R-money-20 |
| MON-7 | AI estimate (A1): gate order, cache, refinement, totals, budget write, `ai_usage` accounting. | R-money-21..24 |

**Cross-cutting tests required** (beyond per-endpoint checklists):

- [ ] Property test: for random amounts/participants/types, `computeShares`
      output always sums exactly and is permutation-invariant (input order
      never matters)
- [ ] Property test: `simplifyDebts` preserves nets and never exceeds n−1
      transfers over randomized ledgers
- [ ] Money-law audit: no float enters any money code path (lint/type-level
      + fixture with `amount_cents: 25.5` rejected at validation)
- [ ] Concurrency: two simultaneous PATCHes to one expense leave a
      consistent expense+shares set (last-write-wins, never mixed)
- [ ] Envelope conformance: every error path returns `ApiError` with a
      documented code

---

*Trace: R-money-N ↔ §3 sections inline. All 11 markers resolved at Gate 2
(2026-07-09): 5 at canonical homes (FX = entry-time rate + manual override;
taxonomy = fixed 6-value enum; overall cap = yes, optional; expense
deletion = soft-delete + audit; travel_style = fixed multi-tag set), 6
owned here (simplification off-by-default with one-tap toggle; settlement
correction = recorder delete ≤ 24 h then counter-entry;
`settlement_requests` entity approved; viewer participation per trips
§3.2; member removal allowed with nonzero balance; split metadata =
resolved cents only). Zero markers remain.*
