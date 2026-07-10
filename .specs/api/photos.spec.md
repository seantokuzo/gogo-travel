# API — Photos (`.specs/api/photos.spec.md`)

> **Task:** T-2.3 (PHOTOS + MEMORIES bundle) · **Status:** DRAFT — pending
> Sean approval (P-2 gate 3). Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `CLAUDE.md` Law #3 (privacy is a boundary; default private),
> `docs/PLANNING.md § Overview` (photos bullet: "uploads pinned to map +
> itinerary; see pictures by place; private/public visibility so others
> planning the same destination can see experiences/reviews") +
> `§ Architecture` (component map: `photos` router; data model `photos`),
> `.specs/database/schema.spec.md §3.3.17` (**CANONICAL** — photos table,
> `photo_visibility` enum, index set incl. the public partial index),
> `.specs/shared/contracts.spec.md` (**CANONICAL** — envelope, `ErrorCode`,
> `Paginated`, `canViewPhoto`, endpoint descriptors),
> `.specs/research/competitors.md` (Polarsteps: journaling merged INTO the
> planner is the opening).
>
> **Companion:** `.specs/client/photos.spec.md` (screen-level UX).
> **Cross-spec:** map surface = maps/places bundle (sibling T-2.3);
> role matrix = trips/members bundle (sibling T-2.3).

---

## 1. Scope & conventions

The `photos` router in `apps/server` (PLANNING § Component map): upload
(provider-agnostic presigned pattern), server-side EXIF + blurhash
processing, auto-association suggestions, gallery queries, visibility
transitions, deletion, and the storage GC job that
`.specs/database/schema.spec.md §3.3.17` explicitly delegates here
("a cleanup job reconciles orphaned `storage_key`s (photos-domain spec owns
this)").

Conventions inherited wholesale (not restated): API envelope + `ErrorCode`
table (contracts spec §3.5), `Paginated<T>` for lists (R-shared-5),
snake_case wire fields mirroring DB columns (contracts spec §3.1), Zod
validation at the boundary (R-shared-3), JSONB/enum single-sourcing
(R-shared-1/2). All new wire shapes land in `@gogo/shared`
`domains/photo.ts` (contracts spec §3.4 already reserves it, including
`canViewPhoto`).

**Storage is provider-agnostic.** The object-storage provider choice is a
P-3 infra escalation (schema spec §3.7; Autonomy Contract §3 — new external
dependency). This spec defines a server-side `StoragePort` (§3.1) and never
names a provider. Nothing here may assume S3/R2/GCS specifics beyond
"presigned PUT/GET URLs + HEAD + DELETE + LIST-by-prefix", which every
candidate supports.

---

## 2. Requirements (EARS)

### Upload

- **R-photo-1 (presigned slots):** WHEN a trip member with write access
  requests upload slots THE SYSTEM SHALL validate `content_type` and
  declared `byte_size` against the accepted-type and size limits (§3.9),
  mint per-photo storage keys, and return presigned PUT URLs plus
  HMAC-signed upload tickets — the server never proxies photo bytes.
- **R-photo-2 (finalize creates the row):** WHEN a client finalizes an
  upload with a valid, unexpired ticket THE SYSTEM SHALL verify via
  `StoragePort.head` that the object exists and is within limits, extract
  EXIF server-side (`taken_at`, GPS per R-photo-3), decode the image to
  produce `blurhash`, `width`, `height`, and EXIF-stripped display/thumb
  renditions, and insert the `photos` row — with `visibility = 'private'`
  unless the request explicitly says otherwise (schema spec R-db-3).
- **R-photo-3 (location consent):** WHEN a finalize request does not carry
  `extract_location: true` THE SYSTEM SHALL persist `lat`/`lng` as NULL and
  discard EXIF GPS; regardless of consent, served renditions SHALL always be
  EXIF-stripped (Law #3 — a public object must not leak GPS via metadata).
- **R-photo-4 (idempotent finalize):** WHEN a finalize is retried for a
  ticket whose photo row already exists THE SYSTEM SHALL return the existing
  row (200) rather than erroring — offline clients retry.

### Auto-association

- **R-photo-5 (suggest, never auto-pin):** WHEN a finalized photo has
  `lat`/`lng` THE SYSTEM SHALL compute the nearest saved place and a
  same-day itinerary-item candidate within `PHOTO_ASSOC_RADIUS_M` (§3.5) and
  return them as suggestions; THE SYSTEM SHALL NOT persist `place_id` or
  `itinerary_item_id` without an explicit user-confirmed write (PATCH).

### Visibility (Law #3)

- **R-photo-6 (check on every read):** WHEN any photo row, filtered list, or
  asset URL is served THE SYSTEM SHALL apply the shared `canViewPhoto`
  helper (contracts spec §3.4 — the single implementation of Law #3's
  check); photos hidden by visibility SHALL be indistinguishable from absent
  (`NOT_FOUND`, per the contracts spec `ErrorCode` table).
- **R-photo-7 (visibility authority is the uploader):** WHEN a visibility
  change is requested THE SYSTEM SHALL accept it only from the photo's
  `user_id` — no trip role, including trip owner, may change another
  member's photo visibility (Law #3: privacy authority never delegates).
- **R-photo-8 (transitions are reversible):** WHEN the owner narrows
  visibility (`public → trip`, `trip → private`, `public → private`) THE
  SYSTEM SHALL apply it immediately; subsequent reads and URL mints reflect
  the new level, and previously minted signed URLs expire within the GET-URL
  TTL (§3.6 — retraction is a privacy control, so transitions are two-way by
  design; already-viewed content cannot be recalled and the client spec owns
  saying so at widen time).
- **R-photo-9 (location redaction on the wire):** WHEN a photo is serialized
  THE SYSTEM SHALL include `lat`/`lng` only for the owner and for trip
  members reading `trip`/`public` rows; the non-member public shape (§3.7.8)
  SHALL never include raw GPS, `trip_id`, or `itinerary_item_id` — place
  granularity (`place_id`) is the maximum location precision a non-member
  ever receives.

### Gallery

- **R-photo-10 (trip gallery floor):** WHEN a trip member lists a trip's
  photos THE SYSTEM SHALL return only rows where the caller is the owner OR
  `visibility IN ('trip','public')` — a member never sees another member's
  `private` rows (R-db-4).
- **R-photo-11 (public-by-place):** WHEN any authenticated user (member or
  not) lists a place's photos THE SYSTEM SHALL return ONLY
  `visibility = 'public'` rows (the partial index
  `(place_id) WHERE visibility='public'` makes this the cheap path —
  R-db-4), serialized in the redacted public shape (R-photo-9).

### Deletion & GC

- **R-photo-12 (delete):** WHEN a photo is deleted THE SYSTEM SHALL remove
  the row transactionally and schedule storage-object deletion (all
  renditions); asset disappearance is bounded by the GET-URL TTL.
- **R-photo-13 (GC reconciliation):** THE SYSTEM SHALL run a scheduled
  (non-LLM) GC job that (a) deletes storage objects with no matching
  `photos` row older than the orphan threshold — covering abandoned uploads,
  post-delete leftovers, and trip-cascade leftovers (schema spec §3.6: trip
  CASCADE does not touch storage) — and (b) flags rows whose objects are
  missing; GC never deletes an object younger than the threshold (in-flight
  uploads).

### Limits & abuse

- **R-photo-14 (limits):** WHEN an upload exceeds `MAX_PHOTO_BYTES` or an
  unaccepted content type THE SYSTEM SHALL reject at slot-mint time
  (`VALIDATION_FAILED` / `PAYLOAD_TOO_LARGE`) and again at finalize via
  HEAD verification (a client can lie at mint time; the object can't);
  slot minting SHALL be rate-limited per user (`RATE_LIMITED`).

### Resolved questions (Gate 2, 2026-07-09)

Canonical resolutions inherited from the schema spec:

- Resolved at `.specs/database/schema.spec.md`:§3.3.17 (Gate 2,
  2026-07-09): photo + caption IS the whole v1 review surface — no
  separate review/rating entity.
- Resolved at `.specs/database/schema.spec.md`:§3.3.17 (Gate 2,
  2026-07-09): public photos surface for non-members on the **place detail
  sheet only** in v1 (destination gallery is a later phase). §3.7.8's
  route placement is therefore settled (consumed by the place detail
  sheet), the shape stays unattributed (no uploader named v1), and
  `created_at DESC` ordering over the minimal partial index suffices at
  place-detail scale.

Decisions owned by this spec (formerly new markers):

- **Photo moderation — decided:** the trip owner MAY delete any photo
  within the trip (content governance in shared albums); deletion is the
  only moderation power — visibility authority stays uploader-only per
  R-photo-7. See R-photo-15. (Resolved 2026-07-09, Gate 2)
- **Member departure — decided:** when a member leaves or is removed,
  their photos remain in the trip (history preserved) and the uploader
  retains owner rights (edit/visibility/delete) via `user_id`. See
  R-photo-16. (Resolved 2026-07-09, Gate 2)
- **Location-consent posture — decided:** EXIF GPS extraction (R-photo-3)
  is per-upload opt-in via the priming flow; after the first consent the
  client remembers the choice as the default toggle state for subsequent
  uploads (still per-upload, always flippable — client photos spec owns
  the UI). (Resolved 2026-07-09, Gate 2)

- **R-photo-15 (owner moderation):** WHEN the trip owner deletes another
  member's photo THE SYSTEM SHALL allow it (deletion only — R-photo-12
  mechanics apply); no role other than uploader and trip owner may delete,
  and no role but the uploader may edit caption/pins/visibility. (Resolved
  2026-07-09, Gate 2)
- **R-photo-16 (departed members' photos):** WHEN a member leaves or is
  removed from a trip THE SYSTEM SHALL leave their `photos` rows unchanged
  (visibility included); the departed uploader retains owner rights over
  their photos via `user_id`. (Resolved 2026-07-09, Gate 2)

---

## 3. Design

### 3.1 StoragePort & key scheme

Server-side port (lives in `apps/server` — it is I/O, so it cannot live in
`@gogo/shared` per R-shared-9); the provider adapter is chosen at the P-3
escalation:

```
StoragePort {
  presignPut(key, contentType, maxBytes, ttlSeconds) → url
  presignGet(key, ttlSeconds) → url
  head(key) → { byteSize, contentType } | null
  delete(keys[])                                  // batch
  list(prefix, olderThan?) → keys[]               // GC + trip sweep
}
```

**Key scheme:** `photos.storage_key` (UNIQUE, schema spec §3.3.17) stores
the base key `photos/{trip_id}/{photo_id}`. Renditions derive
deterministically — no extra columns, no schema drift:

| Object | Key | Access |
|---|---|---|
| Original (as uploaded, EXIF intact) | `{storage_key}/orig` | Owner only — full quality + metadata |
| Display (long edge ≤ 2048 px, JPEG, EXIF-stripped) | `{storage_key}/display` | Anyone passing `canViewPhoto` |
| Thumb (long edge ≤ 400 px, JPEG, EXIF-stripped) | `{storage_key}/thumb` | Anyone passing `canViewPhoto` |

The trip-id prefix makes trip-cascade GC a single `list('photos/{trip_id}/')`
sweep. Buckets are private; **every** byte served to a client flows through
a per-request `presignGet` minted *after* the `canViewPhoto` check
(R-photo-6). No public bucket, no permanent URLs.

### 3.2 Upload flow (two-phase, stateless between phases)

```
client                          server                        storage
  │ 1. POST …/photos/uploads      │                              │
  │──────────────────────────────▶│ validate type/size/rate      │
  │   slots: [{photo_id,          │ mint photo_id + keys         │
  │     put_url, ticket}]         │ sign tickets (HMAC)          │
  │◀──────────────────────────────│                              │
  │ 2. PUT bytes (per slot)       │                              │
  │───────────────────────────────┼─────────────────────────────▶│
  │ 3. POST …/photos (finalize)   │                              │
  │──────────────────────────────▶│ verify ticket + HEAD ────────▶│
  │                               │ EXIF · blurhash · renditions │
  │   201 Photo + suggestions     │ INSERT photos row            │
  │◀──────────────────────────────│                              │
```

No pending DB row exists between phases — the ticket is the state. Ticket =
HMAC-signed payload `{ photo_id, trip_id, user_id, storage_key,
content_type, max_bytes, exp }` (PUT-URL TTL §3.9). Abandoned uploads (PUT
happened, finalize never came) are exactly the R-photo-13(a) orphans; the
threshold exceeds the ticket TTL so GC never races an in-flight upload.
Finalize re-derives everything from the ticket — a forged or cross-user
ticket fails HMAC; a replayed ticket hits the idempotency path (R-photo-4,
enforced by the `storage_key` unique constraint).

### 3.3 EXIF extraction (server-side, at finalize)

- **`taken_at`** — deterministic resolution chain:
  1. `DateTimeOriginal` + `OffsetTimeOriginal` → exact instant;
  2. else GPS date/time stamps (UTC by definition) → instant;
  3. else naive `DateTimeOriginal` interpreted in the trip's destination
     timezone (offline tz lookup from `trips.destination_lat/lng` when
     present — no external service), else UTC;
  4. else NULL (clients fall back to `created_at` for grouping).
- **`lat`/`lng`** — extracted from EXIF GPS only when the finalize request
  carries `extract_location: true` (R-photo-3; per-upload opt-in posture,
  §2, resolved Gate 2). Values
  are validated into range (±90/±180) and stored at the schema's
  `numeric(9,6)` precision.
- **Renditions** are always regenerated with metadata stripped — consent
  governs what lands in the DB, stripping governs what can ever leak from
  an object (the original keeps its EXIF but is owner-only by §3.1).
- HEIC/HEIF decode support is required (iPhone default format); library
  selection at build time via Context7 + `npm view` (Law: never guess APIs).

### 3.4 Blurhash & dimensions

Computed at finalize from the decoded image: `blurhash` (standard 4×3-ish
component encoding — exact params are an implementation constant), `width`,
`height` from the decoded original. Stored on the row (schema spec §3.3.17);
clients render blurhash placeholders before thumb fetch (client spec).

### 3.5 Auto-association (suggestion engine)

Inputs: photo `lat`/`lng` (when consented) and `taken_at`. Config:
`PHOTO_ASSOC_RADIUS_M = 250` (server config).

1. **Place candidate:** the trip's `saved_places` joined to `places`,
   bbox-prefiltered then haversine-ranked (no PostGIS — schema spec §1
   conventions); nearest within radius wins. Booking-pinned places
   (`bookings.place_id`) are included as candidates — a hotel photo should
   suggest the hotel.
2. **Itinerary-item candidate:** items of the same trip whose `day` equals
   `taken_at`'s trip-local day AND whose resolved place (own `place_id` or
   via booking) is within radius; nearest wins; tie → the item whose time
   window contains `taken_at`.
3. Returned as `suggestions: { place_id?, itinerary_item_id? }` on the
   finalize response and on demand via §3.7.6 (re-pin flows). Never
   persisted server-side (R-photo-5) — the confirming PATCH (§3.7.5) is the
   only write path.

No `lat`/`lng` → no suggestions (empty object). Suggestions are computed
against data the *owner* can see (their own trip), so no visibility
question arises.

### 3.6 Visibility semantics

- Levels + truth table are canonical elsewhere: `photo_visibility` enum
  (schema spec §3.2), `canViewPhoto(viewer: {isOwner, isTripMember},
  visibility)` (contracts spec §3.4) — owner sees all; member sees
  `trip` + `public`; stranger sees `public` only. This spec adds no new
  levels and no bypass paths.
- Transitions: any → any, owner-only (R-photo-7/8). Widening to `public` is
  a single-photo, explicit act — there is no bulk "make all public"
  endpoint in v1 (deliberate friction on the privacy boundary; the client
  spec owns the confirmation UX).
- Retraction convergence: signed GET URLs expire per §3.9 TTL, so a
  narrowed photo is unreachable within minutes even by clients holding old
  URLs. That bound is the guarantee; CDN-layer caching (if any lands at P-3)
  must respect it (constraint on the infra escalation).
- Where `public` rows surface: the place detail sheet only in v1 (§2,
  resolved Gate 2). The API contract (§3.7.8) remains surface-agnostic by
  design.

### 3.7 Endpoints

All routes require auth (`UNAUTHENTICATED` 401 otherwise). Trip-scoped
routes 404 for non-members (indistinguishable from absent — contracts spec
`NOT_FOUND` semantics, navigation spec R-nav-15 posture). Write routes
require role owner/editor (role matrix canonical in the trips/members
bundle spec; viewers are read-only). Wire shapes live in
`@gogo/shared/domains/photo.ts`; every route exports an
`EndpointDescriptor` (contracts spec §3.6).

`Photo` (member-facing wire shape) = row mirror (`id`, `trip_id`,
`user_id`, `taken_at`, `lat`, `lng` — redacted per R-photo-9, `place_id`,
`itinerary_item_id`, `visibility`, `caption`, `blurhash`, `width`,
`height`, `created_at`) + ephemeral `thumb_url`, `display_url`, and
`original_url` (owner only). URLs are minted per response and never stored.

#### 3.7.1 POST `/trips/:tripId/photos/uploads`

Mint 1–`MAX_UPLOAD_SLOTS_PER_REQUEST` upload slots. **Auth**: Required
(member, owner/editor).

**Request** `{ items: Array<{ content_type, byte_size }> }` (1–20)

**Response 201** `{ slots: Array<{ photo_id: Uuid, put_url: string,
ticket: string, expires_at: ISODateTime }> }`

**Errors**: 400 `VALIDATION_FAILED` — unaccepted type, zero/negative size,
>20 items; 413 `PAYLOAD_TOO_LARGE` — declared size over cap; 429
`RATE_LIMITED` — slot budget exhausted; 404 `NOT_FOUND` — non-member/no trip.

**Requirements covered**: R-photo-1, R-photo-14

**Tests required**:
- [ ] Happy path: N slots minted, distinct keys under `photos/{trip_id}/`
- [ ] Unaccepted MIME + oversize + >20 items rejected
- [ ] Rate limit trips at configured budget
- [ ] Authz: non-member 404; viewer-role 403/404 per role matrix; wrong trip

#### 3.7.2 POST `/trips/:tripId/photos`

Finalize an upload → create the row. **Auth**: Required (member,
owner/editor; ticket must match caller + trip).

**Request** `{ ticket: string, extract_location: boolean,
caption?: string, place_id?: Uuid, itinerary_item_id?: Uuid,
visibility?: PhotoVisibility }` (visibility omitted ⇒ DB default
`'private'`, R-db-3; pins provided here are user-initiated, not
suggestions)

**Response 201** `{ photo: Photo, suggestions: { place_id?: Uuid,
itinerary_item_id?: Uuid } }` — **200** with the existing row on
idempotent replay (R-photo-4)

**Errors**: 400 `VALIDATION_FAILED` — bad/expired ticket, object missing at
HEAD, undecodable image, pin references outside the trip; 413
`PAYLOAD_TOO_LARGE` — actual object size over cap (HEAD re-check); 404 —
non-member.

**Requirements covered**: R-photo-2, R-photo-3, R-photo-4, R-photo-5,
R-photo-14

**Tests required**:
- [ ] Happy path: row inserted, blurhash/width/height set, renditions exist,
      EXIF-stripped display/thumb verified
- [ ] `extract_location: false` ⇒ lat/lng NULL even with GPS EXIF present
- [ ] `extract_location: true` ⇒ lat/lng persisted; suggestions returned
      when a saved place is within radius
- [ ] Default visibility `'private'` when omitted (R-db-3)
- [ ] Replayed ticket → 200 same row, no duplicate (unique `storage_key`)
- [ ] Forged/expired ticket, missing object, other-user's ticket rejected
- [ ] `taken_at` chain: offset EXIF → GPS time → naive+destination-tz → NULL

#### 3.7.3 GET `/trips/:tripId/photos`

Trip gallery list. **Auth**: Required (member).

**Request** query: `taken_after?`/`taken_before?` (ISODateTime — clients
compute trip-local day windows; the server stays tz-agnostic),
`place_id?`, `user_id?`, `unpinned?` (no place AND no item),
`visibility?` (filters *within* the authz floor, never widens it),
`order?` = `taken_at_asc | taken_at_desc` (default asc; NULL `taken_at`
sorts by `created_at` into position), `cursor?`, `limit?`

**Response 200** `Paginated<Photo>` — rows pass R-photo-10; uses
`(trip_id, taken_at)` / `(trip_id, place_id)` indexes (schema spec §3.5)

**Errors**: 404 — non-member; 400 — bad params.

**Requirements covered**: R-photo-6, R-photo-9, R-photo-10

**Tests required**:
- [ ] Member A never receives member B's `private` rows; own `private`
      rows included (canViewPhoto truth table, Law #3)
- [ ] `place_id` filter + time-window filter + `unpinned` behave
- [ ] `visibility` param cannot widen (e.g. `?visibility=private` returns
      only caller's own)
- [ ] Pagination stable across inserts; authz wrong trip 404

#### 3.7.4 GET `/trips/:tripId/photos/:photoId`

Single photo detail. **Auth**: Required (member + `canViewPhoto`).

**Response 200** `Photo` (with `original_url` iff owner)

**Errors**: 404 — non-member, absent, or hidden by visibility
(indistinguishable, R-photo-6).

**Requirements covered**: R-photo-6, R-photo-9

**Tests required**:
- [ ] Owner gets `original_url`; member does not
- [ ] Member fetching another's `private` photo → 404 (not 403)
- [ ] Non-member → 404; URLs expire per TTL

#### 3.7.5 PATCH `/trips/:tripId/photos/:photoId`

Edit caption / pins / visibility. **Auth**: Required (photo owner only —
R-photo-7; pins and caption are likewise owner-only. The only non-owner
power is trip-owner deletion — R-photo-15, resolved Gate 2).

**Request** `{ caption?: string | null, place_id?: Uuid | null,
itinerary_item_id?: Uuid | null, visibility?: PhotoVisibility }` — pin
writes are the confirmation step of §3.5 suggestions or manual re-pins;
`null` unpins.

**Response 200** `Photo`

**Errors**: 404 — not owner/absent/hidden; 400 — pin target outside this
trip.

**Requirements covered**: R-photo-5 (confirm path), R-photo-7, R-photo-8

**Tests required**:
- [ ] Owner sets/clears pins; cross-trip pin target rejected
- [ ] Non-owner member PATCH → 404; trip owner PATCHing another's
      visibility → 404 (R-photo-7)
- [ ] Widen `private→trip→public` and narrow `public→private` round-trip;
      narrowed row vanishes from member list and place surface immediately
- [ ] Caption write round-trips (caption IS the v1 review surface —
      resolved Gate 2)

#### 3.7.6 GET `/trips/:tripId/photos/:photoId/suggestions`

Recompute association suggestions (re-pin flow, or post-hoc after saving a
new place). **Auth**: Required (photo owner).

**Response 200** `{ place_id?: Uuid, itinerary_item_id?: Uuid }`

**Errors**: 404 — not owner/absent.

**Requirements covered**: R-photo-5

**Tests required**:
- [ ] Suggests newly saved place for an old unpinned photo
- [ ] No location ⇒ empty object; non-owner 404

#### 3.7.7 DELETE `/trips/:tripId/photos/:photoId`

Delete a photo. **Auth**: Required (photo owner, or trip owner as
moderation — R-photo-15, resolved Gate 2).

**Response 204**

**Errors**: 404 — caller neither uploader nor trip owner / absent / hidden.

**Requirements covered**: R-photo-12, R-photo-15

**Tests required**:
- [ ] Row gone; objects scheduled for deletion (all three renditions)
- [ ] Trip owner deletes another member's photo → 204 (R-photo-15); editor
      deleting another's photo → 404
- [ ] Non-owner non-trip-owner 404; idempotent second delete 404
- [ ] Expense of a deleted photo's trip unaffected (no cross-domain cascade)

#### 3.7.8 GET `/places/:placeId/photos`

Public photos at a place, for users planning their own trips (PLANNING
§ Overview). **Auth**: Required (any signed-in user; membership NOT
required — this is the sanctioned cross-user surface). Product surface
resolved Gate 2: consumed by the **place detail sheet only** in v1.

**Request** query: `cursor?`, `limit?`

**Response 200** `Paginated<PublicPlacePhoto>` where `PublicPlacePhoto =
{ id, place_id, caption, taken_at, blurhash, width, height, thumb_url,
display_url }` — no `trip_id`, no `user_id`/attribution (unattributed v1
per the §2 resolution), no `lat`/`lng` (R-photo-9). Only
`visibility = 'public'` rows (R-photo-11), via the partial index; ordered
`created_at DESC` v1 — sufficient for the place-detail-sheet surface
(resolved Gate 2; a destination gallery would revisit ordering/indexing).

**Errors**: 404 — unknown place.

**Requirements covered**: R-photo-6, R-photo-9, R-photo-11

**Tests required**:
- [ ] Returns ONLY public rows across multiple trips; `trip` and `private`
      rows at the same place never appear (Law #3 boundary test — blocking
      review criterion per PLANNING § Review Pipeline)
- [ ] Shape contains no `trip_id`/`user_id`/`lat`/`lng`
- [ ] Photo narrowed from public disappears on next read
- [ ] Non-member caller succeeds; unauthenticated 401

### 3.8 Deletion & storage GC

- **Row-first deletion:** the DB row is authoritative; §3.7.7 deletes the
  row in-request and enqueues object deletion (best-effort immediate
  `StoragePort.delete`, GC as the backstop). Never the reverse order — an
  object without a row is a benign orphan; a row without an object is a
  broken photo.
- **GC job** (scheduled, non-LLM — consistent with PLANNING's job roster;
  sanctioned by schema spec §3.3.17's delegation note):
  1. `list` bucket prefixes; any object whose base key has no `photos` row
     and whose age > `GC_ORPHAN_THRESHOLD` (§3.9) → delete (R-photo-13a).
  2. Any row whose `{storage_key}/orig` HEADs to null → log + flag for
     ops review; never auto-delete rows (R-photo-13b).
  3. Trip deletion: rows cascade (schema spec §3.6); the next GC pass
     sweeps `photos/{trip_id}/` clean.
- Trip deletion is an Autonomy-Contract irreversible op on the client side
  (ConfirmDialog per navigation spec); server-side it is just the cascade +
  GC above.

### 3.9 Limits & config (server config unless noted)

| Constant | Value (v1) | Notes |
|---|---|---|
| `ACCEPTED_PHOTO_MIME` | `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `image/webp` | Exported from `@gogo/shared/domains/photo.ts` (client mirrors it) |
| `MAX_PHOTO_BYTES` | 25 MB | Shared constant; covers 48 MP HEIC; RAW/DNG excluded v1 |
| `MAX_UPLOAD_SLOTS_PER_REQUEST` | 20 | Shared constant; client batches above it |
| `PUT_URL_TTL` | 30 min | Ticket `exp` matches |
| `GET_URL_TTL` | 15 min | Retraction convergence bound (R-photo-8) |
| `PHOTO_ASSOC_RADIUS_M` | 250 m | §3.5 |
| `SLOT_RATE_LIMIT` | 500 slots/user/day | Storage-abuse guard; `RATE_LIMITED` |
| `GC_ORPHAN_THRESHOLD` | 24 h | > PUT TTL by design |
| Display / thumb long edge | 2048 px / 400 px | JPEG, EXIF-stripped |

No per-user/per-trip photo *quota*: storage quotas would be a new
entitlement seam, and ADR-005 says nothing grows a seam without an ADR —
the abuse guards above are deliberately not product limits.

### 3.10 Out of scope (explicit)

- **Video** — PLANNING commits "Photos / albums"; video upload/playback is
  a future scope change (new spec + likely new limits/transcoding infra).
- **Public share links / web viewer** for photos — navigation spec §2.8
  already parks these as future deep-link registry entries.
- **Map pin rendering & clustering** — maps/places bundle (sibling T-2.3);
  it consumes §3.7.3 (already visibility-filtered server-side).
- **Avatar / document / capture-raw storage** — same `StoragePort`, owned by
  their domain specs; only photo keys live under `photos/`.
- **Post-trip recap generation & persistence (the MEMORIES surface beyond
  the album).** The trip album (by day/place) IS the in-trip journal — the
  Polarsteps lesson is that journaling must live inside the planner
  (`.specs/research/competitors.md` "What users love" #5), which this spec
  delivers via pins + galleries, not a separate journaling artifact.
  Recap persistence — Resolved at `.specs/database/schema.spec.md`:§3.7
  (Gate 2, 2026-07-09): the new `recaps` table is approved; the AI spec
  owns the recap pipeline.
- **Storage-side encryption/ACL hardening** — threat model + P-3 infra
  escalation (schema spec §3.7).
- **Account-deletion interaction with `photos.user_id` RESTRICT** —
  resolved at schema spec R-db-16 (Gate 2): soft-delete + PII scrub, so
  user rows survive and RESTRICT never fires on account deletion; not
  restated here.

---

## 4. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on DB-1 (photos table) + SH-1 (`domains/photo.ts`, envelope).

| ID | Task | Covers |
|---|---|---|
| PH-1 | `@gogo/shared` photo wire shapes + constants + endpoint descriptors (`Photo`, `PublicPlacePhoto`, upload slot/finalize/patch schemas; `ACCEPTED_PHOTO_MIME`, size/batch constants) — extends `domains/photo.ts` beside the existing `canViewPhoto`. | R-photo-1..5, 9 (shapes) |
| PH-2 | StoragePort + provider adapter stub + upload pipeline: slot mint (ticket HMAC, rate limit), finalize (HEAD verify, EXIF chain, blurhash, renditions, insert). **Provider selection is the P-3 escalation — adapter lands behind the port.** | R-photo-1..4, 14 |
| PH-3 | Gallery + detail + PATCH + suggestions + DELETE (uploader or trip-owner moderation) with `canViewPhoto` enforcement and URL minting; suggestion engine. | R-photo-5..10, 12, 15, 16 |
| PH-4 | Public-by-place endpoint (surface resolved Gate 2: place detail sheet only v1). | R-photo-11 |
| PH-5 | GC job: orphan sweep, missing-object flagging, trip-prefix sweep; scheduling wiring. | R-photo-13 |

**Cross-cutting tests required** (beyond per-endpoint lists): the
`canViewPhoto` truth table exercised end-to-end (owner/member/stranger ×
private/trip/public × row-read/list/URL-mint) — photo visibility is a
sensitive path (PLANNING § Review Pipeline: auto-escalate).

---

*Requirements → design trace inline. All six markers resolved at Gate 2
(2026-07-09): two at schema spec §3.3.17 (caption is the v1 review
surface; public surface = place detail sheet only), one at schema spec
§3.7 (`recaps` table approved), three owned here (owner moderation →
R-photo-15; departed members' photos remain → R-photo-16; per-upload
location consent with remembered default). Zero markers remain.*
