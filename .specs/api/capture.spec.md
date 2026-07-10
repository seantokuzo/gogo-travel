# Booking Capture API Spec — `.specs/api/capture.spec.md`

> **Task:** T-2.3 · **Status:** DRAFT — pending Sean approval (P-2 gates). Not
> approvable until zero `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (capture pipeline pattern,
> provider table row "Booking capture"), `.specs/database/schema.spec.md`
> (CANONICAL — `capture_inbox` §3.3.16, `bookings` §3.3.9,
> `users.forward_email_slug` §3.3.1, `ProposedBooking` §3.4.2, R-db-7/R-db-11),
> `.specs/shared/contracts.spec.md` (CANONICAL — envelope §3.5, `capture.ts`
> §3.4, `ai/capture-extract.ts` §3.7), `.specs/research/booking-integrations.md`
> (§ email/share-sheet capture pipeline), `.specs/research/ai-architecture.md`
> (structured outputs, Haiku, caps/kill-switch), CLAUDE.md Laws #3/#5,
> ADR-005 (entitlements).
>
> **Companion spec:** `.specs/client/capture.spec.md` — the mobile surface for
> everything below (share-intent ingestion, review-queue UX, onboarding).

---

## 1. Scope

The `capture` router in `apps/server` (component map: "capture (email webhook +
share parse)"): CloudMailin inbound-email webhook, share-sheet upload endpoint,
the parse pipeline (schema.org JSON-LD → Haiku structured-output fallback →
confidence routing → date-overlap auto-file), the needs-review queue API
(list / detail / confirm / reject / reparse), the parse-reply result email, and
the privacy posture of raw payloads.

Non-goals (see §3.9): booking deeplink-out catalogs, the manual booking form,
OAuth inbox sync (explicitly skipped at MVP — research: CASA tax), push
notifications, Siri/Calendar donation.

### Pipeline at a glance (PLANNING § Cross-cutting patterns, verbatim shape)

```
webhook/share → capture_inbox (pending) → schema.org JSON-LD parse
             → LLM fallback (Haiku, structured output) → ProposedBooking
             → confidence routing → auto-file by date-overlap  → bookings row
                                  ↘ needs_review queue → user confirm/edit → bookings row
Failures visible, never silent (R-db-7).
```

---

## 2. Requirements (EARS)

### Ingest — email

- **R-cap-1 (webhook authentication):** WHEN the inbound-email endpoint
  receives a request THE SYSTEM SHALL verify it originates from CloudMailin —
  shared-secret credential (HTTP Basic auth embedded in the webhook target
  URL) and/or CloudMailin's documented request signature — before any parsing
  or storage; unverified requests SHALL be rejected 401 with no
  `capture_inbox` row and no object-storage write. (Exact mechanism is pinned
  from CloudMailin's current docs at build time — CLAUDE.md: never trust
  training data for provider APIs.)
- **R-cap-2 (recipient routing):** WHEN a verified inbound email arrives THE
  SYSTEM SHALL resolve the recipient address's local part case-insensitively
  against `users.forward_email_slug` and attribute the capture to that user;
  WHEN no user matches THE SYSTEM SHALL respond with a rejecting status so
  CloudMailin bounces the message to the sender, creating no capture row.
- **R-cap-3 (sender policy):** WHEN the recipient slug resolves to a user but
  the SMTP `From` address does not match a registered sender address for that
  user THE SYSTEM SHALL reject the delivery (CloudMailin bounce to sender —
  the failure is visible to the forwarder, never silent) and create no
  capture row. v1 registered-sender set: the account email
  (`lower(users.email)`) only, pending the marker below.
  [NEEDS CLARIFICATION: registered sender addresses — is From-matching against
  the account email alone sufficient for v1? Apple-sign-in users have
  private-relay account emails but forward from their real mailbox, so their
  forwards would always bounce; the fix is a "verified additional sender
  addresses" list, which is a new table (entity-list addition per schema spec
  conventions) plus a verification flow. User-visible and a schema change —
  Sean's call.]
- **R-cap-4 (durable ingest):** WHEN an inbound capture (email or share) is
  accepted THE SYSTEM SHALL persist the raw payload to object storage
  (`raw_ref`) and insert the `capture_inbox` row with `parse_status
  'pending'` before acknowledging success; acknowledgement implies the
  capture cannot be lost by a subsequent crash of the parse worker.
- **R-cap-5 (idempotent delivery):** WHEN the same email is delivered more
  than once (webhook retry, duplicate forward of the identical message) THE
  SYSTEM SHALL create at most one `capture_inbox` row per
  `(user, RFC-5322 Message-ID)`.
- **R-cap-6 (email size cap):** WHEN an inbound email's total size exceeds the
  configured limit (10 MB v1) THE SYSTEM SHALL reject it (CloudMailin bounce)
  rather than partially ingest it.

### Ingest — share sheet

- **R-cap-7 (share upload):** WHEN an authenticated user submits a supported
  payload — PDF, image (JPEG/PNG/HEIC/WebP), plain text, or URL — THE SYSTEM
  SHALL store the raw payload, insert a `capture_inbox` row (`source
  'share'`, attributed via session), enqueue parsing, and respond 202 with
  the created `CaptureItem`.
- **R-cap-8 (share limits):** WHEN a share upload exceeds 10 MB THE SYSTEM
  SHALL respond 413 `PAYLOAD_TOO_LARGE`; WHEN the content type is unsupported
  THE SYSTEM SHALL respond 400 `VALIDATION_FAILED`; per-user upload rate
  limits exceeded SHALL respond 429 `RATE_LIMITED`. In every rejection case
  no capture row is created (the client still holds the payload — companion
  spec R-capc-4 guarantees it is never dropped client-side).

### Parse pipeline

- **R-cap-9 (JSON-LD first):** WHEN a capture has HTML or text content THE
  SYSTEM SHALL first attempt schema.org JSON-LD extraction
  (`FlightReservation`, `LodgingReservation`, `TrainReservation`,
  `RentalCarReservation`, `EventReservation`, `FoodEstablishmentReservation`)
  and SHALL only invoke the LLM when no usable reservation object is found
  (research: Gmail-spec markup; airline adoption inconsistent; Booking/Agoda
  provably don't embed it — KDE kitinerary's custom extractors are the prior
  art for what JSON-LD misses).
- **R-cap-10 (LLM fallback):** WHEN JSON-LD yields nothing usable, or the
  payload is a PDF/image, THE SYSTEM SHALL call Claude Haiku 4.5
  (`claude-haiku-4-5`, per `@gogo/shared` `config/ai-pricing.ts` feature→model
  map) server-side with structured output — `client.messages.parse()` +
  `zodOutputFormat` against the `ProposedBooking` extraction schema
  (`ai/capture-extract.ts`) — followed by the paired server-side refinement
  step (contracts spec R-shared-7); responses are never cached (contracts
  §3.7: per-email). No API keys in the app — all calls in `apps/server`.
- **R-cap-11 (confidence threshold — pinned here):** WHEN parsing completes
  THE SYSTEM SHALL set `parse_status 'parsed'` iff
  `parser = 'jsonld'` OR (`parser = 'llm'` AND `confidence = 'high'`), AND
  the proposal passes server heuristics (a `category` plus at least one
  parseable date or a `confirmation_code`); otherwise `'needs_review'`.
  (This pins the threshold that schema spec §3.4.2 delegates to this spec:
  JSON-LD or high-confidence LLM → `parsed`; low/medium → `needs_review`.)
- **R-cap-12 (trip inference by date overlap):** WHEN a proposal has a usable
  date range THE SYSTEM SHALL compute candidate trips — trips where the
  capture's owner has role `owner` or `editor`, both trip dates are non-null,
  and `[start_date − 1 day, end_date + 1 day]` overlaps the proposal's date
  range — and SHALL set `ProposedBooking.trip_guess` iff exactly one
  candidate exists (0 or 2+ candidates → no guess; user assigns at review).
- **R-cap-13 (auto-file):** WHEN a capture reaches `parse_status 'parsed'`
  AND `trip_guess` is set THE SYSTEM SHALL create the booking automatically
  in the same transaction — via the same internal booking-creation path as
  the bookings API (so itinerary-item side effects live in one place) — with
  `source` = the capture's source, `status 'booked'`, `capture_id` linked,
  `created_by` = the capture's owner; `parsed` captures without a guess wait
  in the queue for trip assignment.
  [NEEDS CLARIFICATION: auto-file vs always-confirm — this spec auto-creates
  the booking when confidence is high AND exactly one trip matches by date
  overlap (the TripIt trust model; T-2.3 direction), notifying via the
  parse-reply email and keeping the capture visible as queue history.
  PLANNING § Cross-cutting patterns reads "proposed booking → user
  confirms/edits → lands in trip", which can be read as every capture
  requiring a confirm tap. Which is it? User-visible either way: bookings
  appearing in trips without a tap, vs an extra confirmation step on every
  forwarded email.]
- **R-cap-14 (failures are visible, never silent):** WHEN any pipeline stage
  fails (unparseable payload, LLM error, refinement rejection, cap/kill-switch
  block) THE SYSTEM SHALL persist the row as `'failed'` or `'needs_review'`
  with a user-visible `error` string; capture rows SHALL never be deleted as
  a failure-handling path (mirror of schema spec R-db-7).
- **R-cap-15 (parse-reply email — the TripIt trust mechanism):** WHEN an
  email capture reaches a terminal parse state THE SYSTEM SHALL send a reply
  email to the sender within 60 seconds (p95) of webhook receipt stating the
  outcome — filed ("Added to *Tokyo* — Park Hyatt, May 3–7" + deep link to
  the booking), needs review ("We couldn't read everything — review it in
  GoGo" + deep link to the queue), or failed (reason + queue link). Links go
  through the deep-link registry (navigation spec §2.3; universal-link domain
  has an open marker there — this spec takes the registry as given).
- **R-cap-16 (LLM budget enforcement):** WHEN the global AI kill-switch is
  tripped (`AI_DISABLED` state) or the user's applicable cap is exhausted THE
  SYSTEM SHALL still run the JSON-LD stage, SHALL skip the LLM stage, and
  SHALL route JSON-LD misses to `'needs_review'` with error
  `'ai_unavailable'` — degraded, visible, never silent. Whether capture
  parsing draws down the user's 30/day cap pends the canonical marker,
  repeated verbatim from schema spec §3.2 (`ai_feature`):
  [NEEDS CLARIFICATION: does the capture-pipeline LLM fallback count against
  the user's 30/day AI cap (i.e., is `capture_parse` an `ai_feature` value
  tracked in `ai_usage`)? It costs money per the kill-switch policy either
  way, but charging it to the user cap is user-visible — a heavy
  email-forwarder could exhaust their recommendations quota.]
  Regardless of the cap answer, every capture LLM call SHALL record token
  usage for the $50-alert/$100-kill-switch rollup.

### Queue API

- **R-cap-17 (owner scoping):** WHEN any capture endpoint is called THE
  SYSTEM SHALL scope reads and writes to `capture_inbox.user_id = caller`;
  requests for another user's capture SHALL return 404 `NOT_FOUND`
  (indistinguishable from absent — Law #3 posture).
- **R-cap-18 (list):** WHEN the queue is listed THE SYSTEM SHALL return
  `Paginated<CaptureItem>` newest-first, filterable by `open` (default: rows
  with no landed booking — pending/parsed-unlanded/needs_review/failed),
  `landed`, or `all`; "landed" is derived from the `bookings.capture_id`
  reverse reference (schema spec §3.2 `parse_status` note), never from a
  status value.
- **R-cap-19 (confirm lands atomically):** WHEN the owner confirms a capture
  — supplying `trip_id` and optional field overrides — THE SYSTEM SHALL
  validate the merged proposal against the shared booking schemas
  (discriminated `details` union must match `category`; unknown keys
  stripped — R-db-11/R-shared-10) and create the booking + capture link in a
  single transaction; a second confirm of the same capture SHALL fail 409
  `CONFLICT` (enforced by the partial unique index on `bookings.capture_id`).
- **R-cap-20 (confirm authz):** WHEN a confirm names a trip THE SYSTEM SHALL
  require the caller to be an `owner` or `editor` member of it: non-member →
  404 `NOT_FOUND` (IDOR posture, navigation spec R-nav-15's server twin);
  `viewer` member → 403 `FORBIDDEN`.
- **R-cap-21 (reject deletes):** WHEN the owner rejects a capture THE SYSTEM
  SHALL hard-delete the `capture_inbox` row and its raw object. This is
  user-initiated disposal, not failure handling, so R-db-7 is not violated;
  it is the privacy-positive default (the PII-bearing original is gone on
  request). A landed capture may also be rejected: the booking survives
  (`bookings.capture_id` SET NULL per schema §3.6) — only the capture record
  and raw email/file are removed.
- **R-cap-22 (reparse):** WHEN the owner requests a reparse of a
  `needs_review` or `failed` capture THE SYSTEM SHALL re-run the full
  pipeline from the retained raw payload (retention marker below governs how
  long this stays possible); reparse LLM usage is accounted identically to
  first-parse usage (R-cap-16) and the endpoint is rate-limited.
- **R-cap-23 (raw access):** WHEN the owner requests the original payload THE
  SYSTEM SHALL return a short-lived (≤ 5 min) signed URL to the raw object;
  raw payloads SHALL never be served to any other principal or embedded in
  list/detail response bodies.

### Privacy

- **R-cap-24 (no PII in logs):** WHEN the capture pipeline logs THE SYSTEM
  SHALL log capture ids, statuses, parser used, timings, and token counts
  only — never subjects, bodies, sender addresses, attachment contents, or
  parsed field values (Quality gate #5).
- **R-cap-25 (SSRF guard):** WHEN a shared URL is fetched server-side THE
  SYSTEM SHALL fetch only `http(s)` targets resolving to public addresses
  (deny private/link-local/loopback/metadata ranges, re-checked after each
  redirect), cap redirects (≤ 3), response size (≤ 5 MB), and time (≤ 10 s);
  fetch failure or an auth-walled page routes the capture to `needs_review`
  with the URL preserved as the raw payload.
- **R-cap-26 (retention — canonical marker):** Raw payload retention is
  governed by the schema spec's open marker, repeated verbatim from
  §3.3.16 `capture_inbox`:
  [NEEDS CLARIFICATION: raw capture retention — forwarded emails are
  PII-heavy (names, loyalty numbers, sometimes payment tails). Delete
  `raw_ref` object after successful landing? After N days? Keep indefinitely
  for re-parse? Privacy-policy disclosure (already flagged in research)
  depends on this answer.]
  Until resolved, this spec adds no retention job; R-cap-21 (reject) is the
  only deletion path.

---

## 3. Design

### 3.1 Endpoints

All non-webhook endpoints use the shared envelope conventions (contracts spec
§3.5) and export `EndpointDescriptor`s from `@gogo/shared/capture`
(contracts §3.6). `CaptureItem` is the `capture_inbox` row as the API returns
it (contracts §3.1 convention) **plus one derived field**: `booking_id`
(nullable `Uuid` — the reverse `bookings.capture_id` reference; non-null =
landed).

---

#### POST /capture/inbound-email

CloudMailin inbound webhook. Routes by recipient slug, enforces sender policy,
stores raw MIME, inserts the pending row, enqueues parse. **Auth**: None
(webhook credential/signature per R-cap-1 — not a user session).

**Request**: CloudMailin's delivery format (JSON/multipart; exact shape pinned
from CloudMailin docs at build time). Load-bearing fields: envelope recipient
(slug), envelope/`From` sender, `Message-ID`, HTML/plain parts, attachments.

**Response 200**: `{}` — accepted (row created or duplicate ignored per
R-cap-5).

**Errors** (CloudMailin converts non-2xx into a bounce to the sender — the
visible-failure channel; exact status semantics verified against CloudMailin
docs at build):
- 401 — webhook credential/signature invalid (no bounce concern; attacker)
- 404 — recipient slug unknown (R-cap-2)
- 403 — sender not registered for the slug's user (R-cap-3)
- 413 — message exceeds size cap (R-cap-6)

**Requirements covered**: R-cap-1..6, R-cap-4

**Tests required**:
- [ ] Happy path: valid slug + registered sender → 200, pending row, raw object stored
- [ ] Unverified request → 401, no row, no object
- [ ] Unknown slug → 404, no row; mismatched sender → 403, no row
- [ ] Duplicate Message-ID delivery → single row (R-cap-5)
- [ ] Oversize message → 413, no partial ingest
- [ ] Crash-after-ack simulation: row exists `pending`, worker picks it up (R-cap-4)

---

#### POST /capture/address

Provision-or-return the caller's permanent forward address. Idempotent: first
call generates `users.forward_email_slug` ("generated at first capture-feature
use", schema §3.3.1); later calls return the same address. **Auth**: Required.

**Request**: empty body.

**Response 200**: `{ address: string }` — `"<slug>@in.<domain>"`. Slug: random
lowercase alphanumeric, ≥ 64 bits entropy, never user-chosen in v1 (copy-paste
from the app, not memorized; entropy blunts queue-spam guessing alongside
R-cap-3).

**Errors**: 401 — unauthenticated.

**Requirements covered**: R-cap-2 (slug provisioning side)

**Tests required**:
- [ ] First call creates slug; second call returns identical address
- [ ] Slug uniqueness collision retried transparently

---

#### POST /capture/share

Share-sheet ingestion. **Auth**: Required.

**Request**: `multipart/form-data` with exactly one of:
- `file` — `application/pdf`, `image/jpeg`, `image/png`, `image/heic`,
  `image/webp` (≤ 10 MB)
- `text` — plain text (≤ 100 KB)
- `url` — `http(s)` URL (≤ 2 KB)

**Response 202**: `CaptureItem` (`source 'share'`, `parse_status 'pending'`).

**Errors**: 401 — unauthenticated; 400 `VALIDATION_FAILED` — unsupported
type / zero or multiple parts; 413 `PAYLOAD_TOO_LARGE`; 429 `RATE_LIMITED`.

**Requirements covered**: R-cap-7, R-cap-8, R-cap-4

**Tests required**:
- [ ] Happy path per payload kind (PDF, image, text, URL) → 202 + pending row
- [ ] Oversize file → 413; unsupported type → 400; both create no row
- [ ] Rate limit → 429
- [ ] Authz: unauthenticated → 401

---

#### GET /capture

The review-queue list. **Auth**: Required.

**Request** query: `filter=open|landed|all` (default `open`),
`cursor?`, `limit?` (server-capped).

**Response 200**: `Paginated<CaptureItem>` newest-first.

**Errors**: 401.

**Requirements covered**: R-cap-17, R-cap-18

**Tests required**:
- [ ] `open` excludes landed rows; `landed` returns only rows with a `booking_id`
- [ ] Only caller's rows ever returned (authz: second user sees nothing)
- [ ] Pagination cursor round-trip

---

#### GET /capture/:captureId

Capture detail + raw-payload access. **Auth**: Required (owner).

**Response 200**: `CaptureItem & { raw_url: string }` — `raw_url` is the
short-lived signed URL (R-cap-23).

**Errors**: 401; 404 `NOT_FOUND` — absent or not owned (indistinguishable).

**Requirements covered**: R-cap-17, R-cap-23

**Tests required**:
- [ ] Owner gets detail + working signed URL; URL expires ≤ 5 min
- [ ] Other user → 404 (not 403)

---

#### POST /capture/:captureId/confirm

Land a capture as a booking — the edit path rides this call (overrides are the
user's edits; there is deliberately no separate persisted "draft edit" state).
**Auth**: Required (owner).

**Request**:
```
{
  trip_id: Uuid,
  overrides?: {
    category?, title?, details?, price_cents?, currency?,
    confirmation_code?, status?   // booking_status; default 'booked'
  }
}
```
Merge order: `parsed` proposal ← overrides; merged result validated as a
booking create (shared schemas; `details` union must match final `category`).

**Response 201**: the created `Booking` (shared `booking.ts` shape).

**Errors**: 401; 404 — capture absent/not owned, or trip absent/non-member
(R-cap-20); 403 `FORBIDDEN` — caller is a `viewer` on the trip; 400
`VALIDATION_FAILED` — merged proposal invalid; 409 `CONFLICT` — already
landed.

**Requirements covered**: R-cap-19, R-cap-20, R-cap-17

**Tests required**:
- [ ] Happy path: proposal + trip → booking created, `capture_id` linked, one transaction
- [ ] Overrides applied; category/details mismatch rejected 400
- [ ] Second confirm → 409
- [ ] Authz matrix: non-owner capture 404; non-member trip 404; viewer trip 403
- [ ] Booking `source` equals the capture's source (`email`/`share`)

---

#### POST /capture/:captureId/reparse

Re-run the pipeline on a `needs_review` or `failed` capture. **Auth**:
Required (owner).

**Response 202**: `CaptureItem` (back to `parse_status 'pending'`).

**Errors**: 401; 404; 409 `CONFLICT` — capture is `pending` or already landed;
429 `RATE_LIMITED`.

**Requirements covered**: R-cap-22, R-cap-16

**Tests required**:
- [ ] Failed capture reparsed from retained raw; terminal state re-reached
- [ ] Landed/pending capture → 409
- [ ] Rate limit → 429; LLM usage recorded on reparse

---

#### DELETE /capture/:captureId

Reject/dismiss — hard-deletes row + raw object (R-cap-21). **Auth**: Required
(owner).

**Response 204**.

**Errors**: 401; 404.

**Requirements covered**: R-cap-21, R-cap-17

**Tests required**:
- [ ] Row and raw object both gone after delete
- [ ] Rejecting a landed capture leaves the booking with `capture_id = NULL`
- [ ] Other user → 404

---

### 3.2 Parse pipeline stages (worker; async after ingest ack)

```
[stage 0] load raw payload from raw_ref
[stage 1] JSON-LD extraction (HTML/text payloads only)
          - scan <script type="application/ld+json"> blocks
          - map schema.org type → booking_category (table §3.3)
          - map fields → per-category BookingDetails shape
          - success → ProposedBooking{parser:'jsonld', confidence:'high'}
[stage 2] LLM fallback (JSON-LD miss, or PDF/image payload)
          - guard: kill-switch + cap check (R-cap-16; cap question pends marker)
          - input: subject + stripped body text, or the PDF/image content
            (PDFs > 25 pages → needs_review 'unsupported_document'; booking
            confirmations are 1–3 pages)
          - claude-haiku-4-5, client.messages.parse() + zodOutputFormat
            (ProposedBooking extraction schema, ai/capture-extract.ts)
          - server-side refine step (numeric/cross-field rules — R-shared-7)
[stage 3] heuristic gate + confidence routing (R-cap-11) → parsed | needs_review
[stage 4] trip inference by date overlap (R-cap-12) → trip_guess?
[stage 5] auto-file when parsed + trip_guess (R-cap-13; marker pending)
[stage 6] parse-reply email for source='email' (R-cap-15)
[error]   any stage → parse_status 'failed'/'needs_review' + error (R-cap-14)
```

- Stage transitions write `parsed`, `parsed_at`, `error` per schema §3.3.16.
- The worker is the only writer of `parse_status` transitions out of
  `pending`; ingest endpoints only create `pending` rows.
- Date extraction per category (primary range used by stages 3–4): `lodging`
  check_in→check_out · `flight`/`train` departs_at→arrives_at (first→last
  segment) · `car_rental`/`moped_rental` pickup_at→dropoff_at · `activity`
  starts_at→ends_at · `restaurant` reserved_at · `other` starts_at→ends_at.

### 3.3 schema.org type → `booking_category` mapping

| JSON-LD `@type` | `booking_category` |
|---|---|
| `FlightReservation` | `flight` |
| `LodgingReservation` | `lodging` |
| `TrainReservation` | `train` |
| `RentalCarReservation` | `car_rental` |
| `EventReservation` | `activity` |
| `FoodEstablishmentReservation` | `restaurant` |
| any other `Reservation` subtype | `other` |

Unmapped/malformed JSON-LD is treated as a miss → stage 2 (never a hard fail).

### 3.4 Auto-file semantics (pending R-cap-13 marker)

- Auto-filed bookings: `status 'booked'`, `source` = capture source,
  `created_by` = capture owner, `trip_id` = the single date-overlap candidate,
  `title` from proposal (fallback: derived from details, e.g. "UA 837
  SFO→NRT" / property_name).
- Booking creation goes through the same internal service as
  `POST /trips/:tripId/bookings` (bookings spec owns it) so
  itinerary-item creation and `starts_at`/`ends_at` denormalization stay a
  single code path.
- The capture row stays `parsed` and becomes queue *history* (landed) via the
  reverse FK — auto-file is never invisible: parse-reply email (email source)
  + the landed row in the queue. Wrong-trip corrections are booking edits
  (bookings domain), not capture operations.

### 3.5 Parse-reply email (R-cap-15)

- Sent only for `source 'email'` (share captures have the app open in front
  of the user).
- Three templates: filed / needs-review / failed. Each carries the outcome in
  the subject line ("✔ Added to Tokyo", "Needs review", "Couldn't read this")
  and one deep link (booking or queue) through the deep-link registry.
- Reply goes to the verified sender address (R-cap-3), From:
  `GoGo <no-reply@in.<domain>>` (or the capture address itself, provider
  permitting).
- Latency budget: webhook ack < 5 s; JSON-LD path ~instant; Haiku path a few
  seconds — 60 s p95 end-to-end is comfortable and is the requirement.
- **Outbound transport is an open provider decision** (CloudMailin is
  inbound; outbound = CloudMailin Outbound or SES) — a new external
  dependency, escalated per Autonomy Contract §3 at build time alongside the
  research-flagged CloudMailin account signup. Not a spec marker: the
  behavior above is fixed; only the vendor is not.

### 3.6 LLM cap accounting

- Every capture LLM call records `input_tokens`/`output_tokens` for the
  kill-switch rollup (ai-architecture: $50 alert / $100 hard stop). Whether it
  increments the user's daily `ai_usage` cap pends the R-cap-16 marker
  (canonical home: schema spec §3.2 `ai_feature`); if yes, the feature value
  is `capture_parse` and cap-exhausted behavior is R-cap-16's degraded path
  (JSON-LD only, misses → `needs_review 'ai_unavailable'`) — never a dropped
  capture, never an opaque failure.
- Cost expectation from research: ~$0.005/email on the Haiku path; JSON-LD
  path is free.

### 3.7 Privacy & compliance notes

- **Privacy-policy LLM disclosure (launch-readiness item):** forwarded email
  contents and shared files are transmitted to a third-party LLM (Anthropic)
  for parsing. Research flags this disclosure as required; it must land in
  the privacy policy before the capture feature ships. Tracked here so the
  launch checklist can trace it to a spec.
- Raw payload retention pends the R-cap-26 marker (schema spec §3.3.16 is
  the canonical home). No retention/cleanup job is specced until it resolves.
- Logging: R-cap-24. Signed-URL raw access: R-cap-23. Sender bounce policy
  keeps failure visibility outside the app (R-cap-3) without leaking whether
  a slug exists beyond what the bounce itself implies — acceptable: slugs
  are high-entropy (POST /capture/address) and sender-gated.

### 3.8 Shared-package touchpoints (contracts spec owns shapes)

- `domains/capture.ts`: `CaptureItem` (+ derived `booking_id`),
  `ProposedBooking`, confirm-request schema, endpoint descriptors.
- `ai/capture-extract.ts`: extraction schema (reuses the flat
  `BookingDetails` shapes — the reason they stay flat), `SCHEMA_VERSION`,
  paired refiner.
- `config/ai-pricing.ts`: `capture_parse → claude-haiku-4-5` mapping (feature
  key lands regardless of the cap marker; the marker only decides `ai_usage`
  attribution).

### 3.9 Out of scope (explicit)

- Manual booking creation & booking editing — bookings API spec (capture
  calls its internal create path, §3.4).
- Deeplink-out catalog + "Did you book it?" return prompt — research doc +
  navigation spec R-nav-18.
- OAuth inbox scanning — explicitly skipped at MVP (research: CASA
  compliance tax); revisit post-traction.
- Push notification on parse completion — notifications spec (it will link
  through the same deep-link registry).
- Siri/Calendar reservation donation — client-side future enhancement
  (research item 4), not v1.
- Object-storage provider + outbound email provider selection — P-3 infra
  escalations (Autonomy Contract §3).
- Client screens/UX — companion spec `.specs/client/capture.spec.md`.

---

## 4. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
**Depends on:** SH-1 (shared capture/ai modules) and DB-1 (schema) landing
first or in the same PR; blocked on markers resolving (P-2 interview).

### CAP-1 — Forward address + CloudMailin webhook ingest

**Covers:** R-cap-1..6, R-cap-4, R-cap-24.

- [ ] `POST /capture/address` (idempotent slug provisioning)
- [ ] `POST /capture/inbound-email`: credential/signature verify (mechanism
      pinned from CloudMailin docs), slug routing, sender policy, size cap,
      Message-ID dedupe, raw MIME → object storage, pending row
- [ ] Structured logs with zero PII

**Tests required**: all listed under the two endpoints in §3.1.

### CAP-2 — Share upload endpoint

**Covers:** R-cap-7, R-cap-8, R-cap-25 (URL guard shared with CAP-3).

- [ ] `POST /capture/share` with type/size/rate validation
- [ ] Raw payload storage + pending row + worker enqueue

**Tests required**: as listed under `POST /capture/share`; SSRF guard unit
tests (private/link-local/metadata targets rejected; redirect re-check).

### CAP-3 — Parse pipeline worker

**Covers:** R-cap-9..14, R-cap-16, R-cap-25.

- [ ] JSON-LD extractor + §3.3 mapping table
- [ ] Haiku structured-output fallback (`client.messages.parse()` +
      `zodOutputFormat`, capture-extract schema, refine step) with
      kill-switch/cap guard
- [ ] Confidence routing (R-cap-11 threshold), heuristic gate, trip
      inference (R-cap-12), auto-file transaction (R-cap-13)
- [ ] Failure writes (`failed`/`needs_review` + `error`) for every stage

**Tests required**:
- [ ] JSON-LD fixtures per reservation type → correct category/details, `parser 'jsonld'`
- [ ] Booking/Agoda-style no-JSON-LD fixture → LLM path invoked
- [ ] LLM high/medium/low confidence → parsed vs needs_review (threshold pinned)
- [ ] Heuristic gate: no dates + no confirmation code → needs_review even at high confidence
- [ ] Trip inference: 0/1/2 overlapping trips → guess only at exactly 1; ±1-day buffer honored; viewer-role trips excluded
- [ ] Auto-file: booking + capture link in one transaction; no auto-file without guess
- [ ] Kill-switch/cap on: JSON-LD still runs; miss → needs_review `ai_unavailable`
- [ ] Token usage recorded per LLM call

### CAP-4 — Queue API + parse-reply email

**Covers:** R-cap-15, R-cap-17..23, R-cap-26 (marker-gated: no retention job).

- [ ] `GET /capture`, `GET /capture/:id` (+ signed raw URL),
      `POST /:id/confirm`, `POST /:id/reparse`, `DELETE /:id`
- [ ] Parse-reply templates (filed / needs-review / failed) + 60 s p95 send
      (transport provider escalated at build)

**Tests required**: all listed under the queue endpoints in §3.1, plus:
- [ ] Parse-reply fires once per email capture, correct template per outcome,
      within budget in the test harness (timer faked)
- [ ] No reply email for share captures

---

*Trace: every R-cap-N cites its endpoint/stage inline. Markers in this file:
three canonical repeats (schema §3.2 `ai_feature` in R-cap-16; schema §3.3.16
retention in R-cap-26; the navigation queue-surface marker is repeated in the
companion client spec, which owns that dependency) and two new ones (R-cap-3
registered senders; R-cap-13 auto-file vs always-confirm). Zero markers =
approvable.*
