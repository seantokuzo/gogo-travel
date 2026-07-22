# API — Auth, Users & Entitlements — `.specs/api/auth-users.spec.md`

> **Task:** T-2.3 (bundle: auth/users/entitlements) · **Status:** DRAFT —
> pending Sean approval (P-2). Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (auth LOCKED at Gate 1:
> Apple + Google via Expo AuthSession, `jose` JWTs, short-lived access +
> refresh rotation, zero passwords), ADR-004 (stack), ADR-005 (entitlement
> seams), `.specs/database/schema.spec.md` (CANONICAL for `users`,
> `entitlements`, `push_tokens` — never contradicted here),
> `.specs/shared/contracts.spec.md` (CANONICAL for envelope/errors/schema
> naming), `.specs/client/navigation.spec.md` (auth gating R-nav-1..4,
> secure-store hydration), `.specs/research/payments-settle-up.md`
> (payment-handle formats, HEAD validation, ToS red lines).
>
> **Sensitive path:** auth — auto-escalates to deep review on first round
> (PLANNING § Security; CLAUDE.md Autonomy Contract #4 applies to any
> deviation from this spec's security model).
>
> **Owns (per schema spec §3.7 delegation):** auth session/refresh-token
> storage — this spec adds `auth_sessions`, `refresh_tokens`, and
> `apple_credentials` tables + their migration, honoring every schema-spec
> convention (§3.3 below).

---

## 1. Scope

The `auth`, `users` (profile, payment handles, push tokens), and
`entitlements` Hono routers in `apps/server`, plus the three authz middleware
conventions every other API spec builds on (`requireAuth`,
`requireTripMember`, `requireAiQuota`). Client-side mechanics (AuthSession
flows, secure storage, nav gating) belong to the mobile scaffold and
`.specs/client/navigation.spec.md`; this spec pins the server contract and
the device-storage security rules.

Out of scope: see §3.8.

---

## 2. Requirements (EARS)

### 2.1 Sign-in & identity (R-auth)

- **R-auth-1 (Apple verification):** WHEN a client posts an Apple identity
  token to `/auth/apple` THE SYSTEM SHALL verify it server-side before any
  account logic: signature against Apple's published JWKS (cached, `kid`
  keyed), `iss = https://appleid.apple.com`, `aud` = our bundle/client id,
  `exp` in the future, and nonce binding (§2.1 R-auth-3). Failures return
  401 `UNAUTHENTICATED` without revealing which check failed.
- **R-auth-2 (Google verification):** WHEN a client posts a Google ID token
  to `/auth/google` THE SYSTEM SHALL verify identically against Google's
  JWKS with `iss ∈ {accounts.google.com, https://accounts.google.com}` and
  `aud` = our OAuth client id(s).
- **R-auth-3 (nonce binding):** WHEN a provider token is verified THE SYSTEM
  SHALL require the request's `raw_nonce` to match the token's `nonce` claim
  (Apple: `nonce = SHA-256(raw_nonce)`; Google: raw match) — a token minted
  for a different sign-in attempt SHALL be rejected 401. *(Synced
  2026-07-22, post-T-5.2: the Apple binding is `SHA-256(raw_nonce)`
  encoded as LOWERCASE hex — a cross-workspace wire contract the T-5.7
  mobile client MUST match (hashing to uppercase hex fails every Apple
  sign-in); Google compares `raw_nonce` verbatim. Both sides are hashed
  before the constant-time compare, so nonce length never
  short-circuits.)*
- **R-auth-4 (returning user):** WHEN a verified token's `sub` matches an
  existing `users.apple_sub` / `users.google_sub` THE SYSTEM SHALL sign in
  that user — never create a second account for a known sub.
- **R-auth-5 (new account):** WHEN a verified token's `sub` is unknown AND
  its email matches no existing account THE SYSTEM SHALL create the `users`
  row and its `entitlements` row (`plan = 'free'`) in a single transaction
  (mirror of schema spec R-db-5) and return `is_new_user: true`.
  `display_name` seeds from the provider name fields when present (Apple
  sends them only on first authorization — client MUST forward them), else
  from the email local part; the user edits it at onboarding. *(Synced
  2026-07-22, post-T-5.2: an unknown-`sub` token whose email is
  UNVERIFIED or ABSENT is DENIED 401, never created — the creation-side
  twin of R-auth-6's gate. This preserves the invariant that every
  stored `users.email` was verified at intake, which R-auth-6 auto-link
  silently depends on: an account planted on an unverified email would
  let a victim's later verified sign-in auto-link into an attacker's
  account, §3.6.2.)*
- **R-auth-6 (email collision — auto-link):** WHEN a verified token's `sub`
  is unknown AND `lower(email)` matches an existing account THE SYSTEM SHALL
  auto-link the new provider identity to that account (set the missing
  `apple_sub`/`google_sub` on the existing `users` row) and sign the user in
  — provided the incoming email is verified (Google: `email_verified` claim
  true; Apple: verified by construction). Unverified email → 401, no link.
  Resolved at `.specs/database/schema.spec.md`:§3.3.1 `users` (Gate 2,
  2026-07-09): auto-link on verified matching email. *(Synced
  2026-07-22, post-T-5.2: if the email-matched account already holds a
  DIFFERENT `sub` in the incoming provider's slot, the sign-in is
  REJECTED 401 — the slot is NEVER overwritten (silent overwrite =
  identity takeover; a second account is impossible under `lower(email)`
  uniqueness, and v1 has no recovery flow). Only a genuinely empty slot
  is linked.)*
- **R-auth-7 (Apple revocation credential):** WHEN Apple sign-in completes
  THE SYSTEM SHALL exchange the request's `authorization_code` with Apple's
  token endpoint and store the returned Apple refresh token encrypted
  (`apple_credentials`, §3.3.3) — required to perform the App-Store-mandated
  token revocation at account deletion (guideline 5.1.1(v)). Exchange failure
  SHALL NOT fail the sign-in (logged; retried at next sign-in).

### 2.2 Tokens, sessions & rotation (R-auth cont.)

- **R-auth-8 (issuance):** WHEN sign-in or refresh succeeds THE SYSTEM SHALL
  issue (a) a `jose`-signed **ES256** access token, TTL
  `ACCESS_TOKEN_TTL = 15 min`, claims exactly `{iss, aud, sub, sid, iat,
  exp}` (§3.2), and (b) an opaque **256-bit** random refresh token, TTL
  `REFRESH_TOKEN_TTL = 30 days` from issuance (sliding via rotation).
- **R-auth-9 (hash-only persistence):** THE SYSTEM SHALL persist refresh
  tokens as SHA-256 hashes only; plaintext refresh/access tokens SHALL never
  be stored server-side or written to logs (Quality gate #5).
- **R-auth-10 (rotation):** WHEN a current, unexpired refresh token is
  presented to `/auth/refresh` THE SYSTEM SHALL rotate atomically in one
  transaction: stamp the presented token `rotated_at`, insert its
  replacement, bump the session's `last_used_at`, and return a fresh
  access + refresh pair.
- **R-auth-11 (reuse = theft):** WHEN a refresh token that is already
  rotated, or whose session is revoked, is presented THE SYSTEM SHALL revoke
  the entire session (session `revoked_at` + all its refresh tokens) and
  return 401 — the legitimate device is forced to re-authenticate. Expired
  (but never-rotated) tokens return plain 401 without family revocation.
- **R-auth-12 (stateless access verification):** WHEN a protected route runs
  `requireAuth` THE SYSTEM SHALL verify the access token statelessly (no DB
  read): pinned algorithm allowlist `[ES256]` (reject `none`/HS-family),
  `iss`/`aud` match, `exp` valid — 401 `UNAUTHENTICATED` otherwise. Session
  revocation therefore takes effect at the next refresh boundary
  (≤ `ACCESS_TOKEN_TTL`); this bounded latency is accepted by design.
- **R-auth-13 (logout & session control):** WHEN `/auth/logout` is called
  THE SYSTEM SHALL revoke the calling session (from the `sid` claim) and
  delete the supplied push-token id if present; sessions SHALL be listable
  and individually revocable by their owner, and a session id not owned by
  the caller SHALL return 404 (indistinguishable from absent).
- **R-auth-14 (rate limits):** WHEN any auth surface exceeds its rate limit
  (§3.6.3 table) THE SYSTEM SHALL return 429 `RATE_LIMITED` with a
  `Retry-After` header and process nothing.
- **R-auth-15 (≥1 identity invariant):** THE SYSTEM SHALL never produce a
  `users` row with both `apple_sub` and `google_sub` NULL (mirror of the
  schema-spec check; unlink flows don't exist in v1, so the invariant is
  create-time only).

### 2.3 Profile, avatar, payment handles, push tokens (R-user)

- **R-user-1 (own profile):** WHEN an authenticated user requests
  `/users/me` THE SYSTEM SHALL return the full `User` shape (email, prefs,
  payment handles, `forward_email_slug`); no other principal can ever
  retrieve another user's full `User`.
- **R-user-2 (profile update):** WHEN `/users/me` is PATCHed THE SYSTEM
  SHALL accept only `display_name`, `prefs`, and `avatar_key`; `email`,
  provider subs, and `forward_email_slug` are not client-writable. `prefs`
  is validated by the shared `UserPrefs` schema with unknown keys stripped
  (R-shared-10 / R-db-17) and replaces the stored object whole (client sends
  the full prefs object; no server-side deep merge).
- **R-user-3 (avatar presign flow):** WHEN an avatar upload is requested THE
  SYSTEM SHALL issue a provider-agnostic presigned upload ticket through the
  `ObjectStorage` port (§3.4.3): content type ∈ {`image/jpeg`, `image/png`,
  `image/webp`}, `byte_size ≤ AVATAR_MAX_BYTES = 5 MB`, ticket TTL ≤ 10 min,
  key namespaced `avatars/{user_id}/{uuid}`. A PATCH committing `avatar_key`
  SHALL accept only a key the server issued **to that user** whose object
  exists in storage — arbitrary keys are rejected 400.
- **R-user-4 (member profile visibility):** WHEN a user requests
  `/users/:userId` THE SYSTEM SHALL return the `UserProfile` view (id,
  display_name, avatar_key, payment handles — deliberately member-visible;
  contracts spec §3.4) iff the caller shares ≥ 1 trip with the target;
  otherwise 404 `NOT_FOUND`, indistinguishable from a nonexistent user
  (IDOR posture, PLANNING § Security / R-nav-15 mirror).
- **R-user-5 (handle normalization & validation):** WHEN payment handles are
  written THE SYSTEM SHALL normalize and validate server-side:
  `venmo_username` stripped of leading `@`; `cashtag` stripped of leading
  `$`; both plus `paypalme_username` checked against their rails' handle
  charset (alphanumeric + `-`/`_`/`.` per rail); `zelle_handle` must be an
  email or E.164 US phone, and setting it requires `zelle_display_name`
  (research: payer must be able to verify the recipient). `null` clears a
  handle; absent fields are untouched.
- **R-user-6 (cashtag HEAD validation):** WHEN a `cashtag` is saved THE
  SYSTEM SHALL issue `HEAD https://cash.app/$<cashtag>`: 404 → reject 400
  `VALIDATION_FAILED` (`details.cashtag = 'not_found'`); 2xx/3xx → accept.
  WHEN cash.app is unreachable or 5xx THE SYSTEM SHALL accept the save
  (fail-open — deeplinks are best-effort UX sugar per research; a save must
  not depend on a third party's uptime).
- **R-user-7 (no Venmo scraping):** THE SYSTEM SHALL make **no** requests to
  Venmo for validation, profile lookup, or any other purpose — deeplink
  handoff is client-side only (research ToS red line: scraping is the
  prohibited activity). Venmo handles get format validation only.
- **R-user-8 (push-token registration):** WHEN a push token is registered
  THE SYSTEM SHALL upsert on the unique `token` — a token already registered
  to another account **moves** to the caller (schema spec §3.3.3 semantics) —
  and bump `last_seen_at`; re-registration on app foreground is the
  keep-alive. Deletion by id is restricted to the owning user (foreign id →
  404).
- **R-user-9 (account deletion):**
  THE SYSTEM SHALL expose `DELETE /users/me` (App Store requires account
  deletion to exist). WHEN invoked THE SYSTEM SHALL immediately: revoke all
  of the user's sessions and refresh tokens, delete all their push tokens,
  and revoke their Apple refresh token via Apple's REST revocation endpoint
  (consuming `apple_credentials`, R-auth-7). Data disposition — Resolved at
  `.specs/database/schema.spec.md`:§R-db-16 (Gate 2, 2026-07-09):
  soft-delete + PII scrub; expense/settlement ledger rows survive, surfaced
  to other members as "Deleted user". Deletion of an owner of a trip that
  still has other members follows the ownership-transfer rule (schema spec
  §3.3.5, resolved Gate 2: owner may transfer; leaving requires transfer
  first) — the owner must transfer ownership before the account can be
  deleted.

### 2.4 Entitlements (R-ent)

- **R-ent-1 (read endpoint):** WHEN `/users/me/entitlements` is requested
  THE SYSTEM SHALL return the caller's **effective** entitlements computed
  solely by the shared `resolveEntitlements()` (`overrides ?? PLAN_DEFAULTS
  [plan]`) — the only resolution path (R-shared-12); handlers SHALL never
  read `overrides` or plan defaults directly.
- **R-ent-2 (server-side cap seam):** WHEN any AI endpoint executes THE
  SYSTEM SHALL run `requireAiQuota(feature)` within the request, **before**
  any model call (ADR-005; schema spec R-db-5): read `entitlements` +
  today's `ai_usage` for the caller; at/over the effective cap → 429
  `AI_CAP_EXCEEDED`; global kill-switch tripped → 503 `AI_DISABLED`. Any
  client-side entitlement value is display-only — the server check is the
  enforcement, always.
- **R-ent-3 (read-only in v1):** THE SYSTEM SHALL expose no entitlement
  write endpoint in v1 — everyone is `free` (ADR-005); plan/override changes
  are operator actions, not API surface.

### 2.5 Authz middleware conventions (R-authz) — binding on every API spec

- **R-authz-1 (default-authenticated):** WHEN any route outside the public
  allowlist (`POST /auth/apple`, `POST /auth/google`, `POST /auth/refresh`,
  health check) is invoked THE SYSTEM SHALL run `requireAuth` first;
  unauthenticated access returns 401 with zero handler execution.
- **R-authz-2 (trip-membership guard):** WHEN any `/trips/:tripId/*` route
  is invoked THE SYSTEM SHALL run `requireTripMember` before the handler:
  load the caller's `trip_members` row for `:tripId`; absent membership OR
  absent trip → 404 `NOT_FOUND`, indistinguishable (contracts spec §3.5;
  Law #3 posture; server twin of R-nav-15/20). **Every trip-scoped endpoint
  in every API spec declares its minimum role and gets an authz test** —
  a trip-scoped route without this guard is a blocking review finding.
- **R-authz-3 (role ladder):** THE SYSTEM SHALL enforce roles as
  `viewer < editor < owner`: reads need `viewer`, mutations need `editor`,
  membership/role/invite/trip-deletion management needs `owner` (per-endpoint
  declarations may only tighten, never loosen). A **member** with
  insufficient role gets 403 `FORBIDDEN` (their membership already proves the
  trip exists — no information leak).
- **R-authz-4 (middleware order):** THE SYSTEM SHALL apply middleware in the
  fixed order `requireAuth → zod validation (@hono/zod-validator, shared
  schemas) → resource authz (requireTripMember / ownership checks /
  requireAiQuota) → handler`, and all errors SHALL serialize through the
  shared error middleware as the `ApiError` envelope — never an ad-hoc shape
  (R-shared-4).

---

## 3. Design

### 3.1 Sign-in flow (server contract)

```
Expo client                      apps/server                    Provider
───────────                      ───────────                    ────────
generate raw_nonce
→ provider auth UI  ──────────────────────────────────────────▶ Apple/Google
◀ identity/id token (+ Apple authorization_code, first-auth name)
POST /auth/{apple|google}  ────▶ verify JWT: JWKS sig, iss,
  {token, raw_nonce, device}       aud, exp, nonce binding
                                 find user by provider sub
                                 ├─ found        → sign in (R-auth-4)
                                 ├─ new email    → create user +
                                 │                 entitlements txn (R-auth-5)
                                 └─ email collides → auto-link verified
                                                     email (R-auth-6)
                                 [Apple] exchange authorization_code,
                                   store encrypted refresh token (R-auth-7)
                                 create auth_session + refresh token
◀ { user, tokens, is_new_user }  sign ES256 access (jose)
```

- Client mechanism: Apple sign-in uses the native
  `expo-apple-authentication` module (ASAuthorization) on iOS — the
  App-Review-favored presentation, accepted as a valid reading of the
  Gate-1 lock; Google uses Expo AuthSession (auth code + PKCE → ID token).
  Both produce the identical identity token this server contract consumes,
  so the server is mechanism-agnostic. (Resolved 2026-07-09, Gate 2)
- Provider JWKS are fetched via `jose`'s remote JWK set with caching;
  unknown `kid` triggers one refetch (key-rotation tolerance) then fails.
- Replay posture: nonce binding (R-auth-3) ties each provider token to one
  sign-in attempt; residual replay of a stolen token+nonce pair is bounded
  by the provider token's own `exp` (≤ 10 min) and TLS everywhere.
- `is_new_user` drives the client's first-run onboarding branch (navigation
  spec §2.2 `firstRun`); onboarding completion is client-tracked. Onboarding
  contents resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2,
  2026-07-09): name/avatar → home currency → payment handles (skippable) →
  notification priming, with `travel_style` as an optional prompt — every
  field it collects is writable via this spec's endpoints.

### 3.2 Token model

| Token | Form | TTL | Claims / content | Transport |
|---|---|---|---|---|
| Access | `jose` JWS, **ES256** (alg allowlist `[ES256]` — reject `none`/HS) | `ACCESS_TOKEN_TTL` = 15 min | `iss: 'gogo-api'`, `aud: 'gogo-mobile'`, `sub` = user id, `sid` = session id, `iat`, `exp` — nothing else (no email/PII in tokens) | `Authorization: Bearer` header |
| Refresh | opaque, 256-bit CSPRNG, URL-safe | `REFRESH_TOKEN_TTL` = 30 days from issuance (sliding via rotation) | none (random); stored as SHA-256 hash only (R-auth-9) | request body of `/auth/refresh` only |

- Signing key: ES256 private key from server env (Law #1 — never in git);
  public part embedded in verification config. Tokens carry `kid`; rotation
  = add new key, verify against the key set, retire old after
  `ACCESS_TOKEN_TTL` — no downtime, no schema impact.
- TTLs and limits in this spec are server config constants (single config
  module), pinned here so tests assert them; changing them is a config PR,
  not a spec change, unless semantics change.
- No absolute session lifetime in v1 (mobile norm: active devices stay
  signed in via rotation; 30 days idle → re-auth).

### 3.3 Session/device model — auth-owned tables

Schema-spec conventions (§1 there) apply: uuid PKs via `gen_random_uuid()`,
`timestamptz` UTC, FK btree indexes, migration in the same PR (Law #6 /
R-db-12).

#### 3.3.1 `auth_sessions` — one row per signed-in device

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK; the access token's `sid` claim |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE |
| `device_name` | `text` | yes | — | Client-supplied ("Sean's iPhone 17"); display only |
| `platform` | `push_platform` | no | — | Reuses the shared enum (`ios`/`android`) — no new enum |
| `last_used_at` | `timestamptz` | no | `now()` | Bumped on each refresh |
| `revoked_at` | `timestamptz` | yes | — | Set by logout / remote revoke / reuse-theft response / account deletion |

- `created_at`/`updated_at` per convention (mutable table). **Indexes:**
  `(user_id)` — session list + revoke-all-on-deletion.

#### 3.3.2 `refresh_tokens` — one row per issued refresh token

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `session_id` | `uuid` | no | — | FK → `auth_sessions.id` ON DELETE CASCADE |
| `token_hash` | `text` | no | — | SHA-256 hex of the token; UNIQUE — the lookup key (R-auth-9) |
| `expires_at` | `timestamptz` | no | — | issuance + `REFRESH_TOKEN_TTL` |
| `rotated_at` | `timestamptz` | yes | — | Set when replaced; a presented token with this set = reuse → family revoke (R-auth-11) |

- Write-once + a single `rotated_at` stamp → no `updated_at` (same
  justification as the schema spec's immutable ledger tables). **Indexes:**
  unique `token_hash`; FK index `(session_id)`.
- Prune job: delete rows `expires_at < now() - 30d`, and revoked sessions
  older than 90d (pairs with the schema spec's stale push-token prune).
- "Revoked sessions older than 90d" is measured from `revoked_at`: the rule
  is `revoked_at IS NOT NULL AND revoked_at < now() - 90d` (strict `<`; a
  never-revoked session is unprunable at any age — no absolute session
  lifetime, §3.2). *(Synced 2026-07-22, post-T-5.1)*

#### 3.3.3 `apple_credentials` — Apple revocation material (R-auth-7)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `uuid` | no | — | PK; FK → `users.id` ON DELETE CASCADE |
| `refresh_token_ciphertext` | `text` | no | — | Apple refresh token, AES-256-GCM app-level encryption, key from server env (Law #1); consumed only by account deletion (R-user-9) |

- `created_at`/`updated_at` per convention (refreshed on each Apple
  sign-in). Never returned by any endpoint; never logged.

### 3.4 Endpoints

Envelope, error codes, and `Paginated<T>` exactly per contracts spec §3.5 —
this spec adds **no** new `ErrorCode` values. All request/response schemas
are `@gogo/shared` schemas; new ones live in `domains/auth.ts` (added per
R-shared-14; §3.7 below), existing ones in `domains/user.ts` /
`domains/entitlement.ts`. Endpoint descriptors are exported alongside
(contracts spec §3.6).

#### 3.4.1 Auth

---

### POST /auth/apple

Verify an Apple identity token; sign in or create the account; issue tokens.
**Auth**: None (rate-limited, §3.6.3)

**Request** `AppleSignInRequest`:
`{ identity_token: string, authorization_code: string, raw_nonce: string,
device: { device_name?: string, platform: 'ios' | 'android' },
given_name?: string, family_name?: string }` (name fields arrive on first
Apple authorization only — client forwards them or they're gone, R-auth-5)

**Response 200** `SignInResponse`:
`{ user: User, tokens: AuthTokens, is_new_user: boolean }` where
`AuthTokens = { access_token: string, refresh_token: string,
expires_in: number }` (seconds, = `ACCESS_TOKEN_TTL`)

**Errors**: 400 `VALIDATION_FAILED` — malformed body; 401 `UNAUTHENTICATED`
— signature/iss/aud/exp/nonce failure (undifferentiated, R-auth-1); 429
`RATE_LIMITED`.

**Requirements covered**: R-auth-1, R-auth-3, R-auth-4, R-auth-5, R-auth-6,
R-auth-7, R-auth-8, R-auth-14, R-auth-15

**Tests required**:
- [ ] Happy path: new user → user + entitlements row in one txn, `is_new_user: true`, valid ES256 access token with `sub`/`sid`, refresh stored hashed
- [ ] Happy path: returning `apple_sub` → same user id, `is_new_user: false`, new session created
- [ ] Happy path: unknown `apple_sub`, email matches existing Google-created account → linked (`apple_sub` set on the existing row), signed in, no second account (R-auth-6)
- [ ] Error: tampered signature, wrong `aud`, expired token, nonce mismatch → all 401, indistinguishable bodies
- [ ] Error: Apple code-exchange failure → sign-in still succeeds (R-auth-7), failure logged
- [ ] Authz: none (public endpoint) — but rate limit fires 429 at threshold

---

### POST /auth/google

Verify a Google ID token; sign in or create the account; issue tokens.
**Auth**: None (rate-limited)

**Request** `GoogleSignInRequest`:
`{ id_token: string, raw_nonce: string, device: { device_name?: string,
platform: 'ios' | 'android' } }`

**Response 200** `SignInResponse` (as above)

**Errors**: 400 `VALIDATION_FAILED`; 401 `UNAUTHENTICATED` (verification
failure, incl. email collision with `email_verified` false — no link);
429 `RATE_LIMITED`.

**Requirements covered**: R-auth-2, R-auth-3, R-auth-4, R-auth-5, R-auth-6,
R-auth-8, R-auth-14, R-auth-15

**Tests required**:
- [ ] Happy path: new + returning user (as Apple tests, keyed on `google_sub`)
- [ ] Happy path: unknown `google_sub`, verified email matches existing Apple-created account → linked, signed in (R-auth-6)
- [ ] Error: email collision with `email_verified: false` → 401, no link, no new account (R-auth-6)
- [ ] Error: wrong `iss`/`aud`, expired, nonce mismatch → 401
- [ ] Authz: rate limit 429 at threshold

---

### POST /auth/refresh

Rotate a refresh token; issue a fresh token pair.
**Auth**: None (the refresh token IS the credential; rate-limited)

**Request** `RefreshRequest`: `{ refresh_token: string }`

**Response 200** `AuthTokens`

**Errors**: 400 `VALIDATION_FAILED`; 401 `UNAUTHENTICATED` — unknown or
expired token (no family revoke), or rotated/revoked token (family revoke
fires first, R-auth-11); 429 `RATE_LIMITED`

**Requirements covered**: R-auth-8, R-auth-9, R-auth-10, R-auth-11,
R-auth-14

**Tests required**:
- [ ] Happy path: valid refresh → old token `rotated_at` set, new pair returned, session `last_used_at` bumped — atomically
- [ ] Error: expired-but-never-rotated → 401, session NOT revoked
- [ ] Error (theft): presenting a rotated token → 401 AND session + all its tokens revoked; the previously-issued "legitimate" token now also 401s
- [ ] Error: token of a revoked session → 401
- [ ] Authz: refresh token from user A never yields tokens for user B (hash lookup isolation)

---

### POST /auth/logout

Revoke the calling session; optionally deregister this device's push token.
**Auth**: Required

**Request** `LogoutRequest`: `{ push_token_id?: Uuid }`

**Response 204** (no body)

**Errors**: 401 `UNAUTHENTICATED`

**Requirements covered**: R-auth-13, R-user-8

**Tests required**:
- [ ] Happy path: session `revoked_at` set; its refresh token stops working; supplied push token deleted
- [ ] Happy path: no `push_token_id` → session revoked, push tokens untouched
- [ ] Error: no/expired access token → 401
- [ ] Authz: `push_token_id` belonging to another user → session still revoked, foreign token untouched (silently skipped)

---

### GET /auth/sessions

List the caller's signed-in devices. **Auth**: Required

**Query**: `{ cursor? }` — the standard `Paginated<T>` page cursor
(contracts spec §3.5; `CursorQuerySchema`). *(Synced 2026-07-22, post-T-5.1
— the response was already `Paginated<AuthSessionInfo>`; the request-side
param that round-trips `nextCursor` is now pinned.)*

**Response 200** `Paginated<AuthSessionInfo>` where `AuthSessionInfo =
{ id: Uuid, device_name: string | null, platform: 'ios' | 'android',
created_at: ISODateTime, last_used_at: ISODateTime, current: boolean }`
(revoked sessions excluded; `current` = matches the caller's `sid`)

**Errors**: 401 `UNAUTHENTICATED`

**Requirements covered**: R-auth-13

**Tests required**:
- [ ] Happy path: two devices → both listed, `current` true exactly once
- [ ] Error: unauthenticated → 401
- [ ] Authz: user A never sees user B's sessions

---

### DELETE /auth/sessions/:sessionId

Revoke one of the caller's sessions (remote sign-out; revoking the current
session ≡ logout). **Auth**: Required

**Response 204** (no body)

**Errors**: 401 `UNAUTHENTICATED`; 404 `NOT_FOUND` — absent, already
revoked, or not owned by the caller (indistinguishable, R-auth-13)

**Requirements covered**: R-auth-13, R-auth-12

**Tests required**:
- [ ] Happy path: other-device session revoked → its refresh 401s immediately; its unexpired access token works until `exp` (≤ 15 min — R-auth-12 documented latency)
- [ ] Error: unknown session id → 404
- [ ] Authz: user B's session id → 404, session untouched

*Scope note:* v1 ships both the endpoints and a minimal session list/revoke
screen in settings (the profile surface lives off the trips-list header
avatar button — navigation spec §1). `GET /auth/sessions` +
`DELETE /auth/sessions/:id` stay in v1. (Resolved 2026-07-09, Gate 2)

#### 3.4.2 Users & profile

---

### GET /users/me

The caller's full profile. **Auth**: Required

**Response 200** `User`:
`{ id: Uuid, email: string, display_name: string, avatar_key: string | null,
prefs: UserPrefs, venmo_username: string | null, cashtag: string | null,
paypalme_username: string | null, zelle_handle: string | null,
zelle_display_name: string | null, forward_email_slug: string | null,
created_at: ISODateTime }` — `UserPrefs = { travel_style?, home_currency?:
CurrencyCode, units?: 'metric' | 'imperial' }` (contracts spec §3.4)

**Errors**: 401 `UNAUTHENTICATED`

**Requirements covered**: R-user-1

**Tests required**:
- [ ] Happy path: full shape returned incl. handles + prefs
- [ ] Error: unauthenticated → 401
- [ ] Authz: response is always the token's `sub` — no parameterization to reach another user

---

### PATCH /users/me

Update profile fields. **Auth**: Required

**Request** `UserUpdate`: `{ display_name?: string (1–50 chars, trimmed,
no control chars), prefs?: UserPrefs (whole-object replace, unknown keys
stripped), avatar_key?: string | null (server-issued key only, R-user-3;
null clears) }`

**Response 200** `User` (updated)

**Errors**: 400 `VALIDATION_FAILED` — bad display_name, invalid prefs,
foreign/never-issued/missing-object `avatar_key`; 401 `UNAUTHENTICATED`

**Requirements covered**: R-user-2, R-user-3

**Tests required**:
- [ ] Happy path: display_name + prefs update round-trips; unknown prefs keys stripped
- [ ] Happy path: commit issued `avatar_key`; clear with null
- [ ] Error: `avatar_key` not issued to this user (incl. another user's valid key) → 400
- [ ] Error: attempt to write `email` / `apple_sub` / `forward_email_slug` → stripped or 400 (unknown-key policy), never persisted
- [ ] Authz: user A's PATCH can never mutate user B

Note on `travel_style` (writable via `prefs`): Resolved at
`.specs/shared/contracts.spec.md`:§3.4 `user.ts` (Gate 2, 2026-07-09):
multi-tag from the fixed set budget, comfort, luxury, foodie, adventure,
culture, nightlife, family, relaxation — the shared schema there is the
validator.

`home_currency` is stored here; its consumption (proposed: default
`base_currency` for new trips) is the trips spec's to pin.

---

### POST /users/me/avatar-upload

Issue a presigned avatar upload ticket (provider-agnostic — storage provider
is a P-3 escalation, schema spec §3.7; this contract survives any choice).
**Auth**: Required (rate-limited)

**Request** `AvatarUploadRequest`:
`{ content_type: 'image/jpeg' | 'image/png' | 'image/webp',
byte_size: number }`

**Response 200** `AvatarUploadTicket`:
`{ upload_url: string, method: 'PUT', headers: Record<string, string>,
storage_key: string, expires_at: ISODateTime }` — client PUTs the bytes to
`upload_url`, then commits via `PATCH /users/me { avatar_key: storage_key }`.
Client downscales to ≤ 1024 px before upload; no server-side image pipeline
in v1 (old avatar object cleanup joins the storage reconciliation job noted
in schema spec §3.3.17).

**Errors**: 400 `VALIDATION_FAILED` — disallowed content type; 413
`PAYLOAD_TOO_LARGE` — `byte_size > AVATAR_MAX_BYTES` (5 MB); 401
`UNAUTHENTICATED`; 429 `RATE_LIMITED`

**Requirements covered**: R-user-3

**Tests required**:
- [ ] Happy path: ticket issued, key namespaced `avatars/{user_id}/…`, TTL ≤ 10 min
- [ ] Error: `image/gif` → 400; 6 MB → 413
- [ ] Authz: issued key commits only for the requesting user (cross-user commit → 400, covered in PATCH tests)

---

### PATCH /users/me/payment-handles

Set/clear payment handles (the settle-up spine). **Auth**: Required
(rate-limited — bounds outbound cash.app HEADs)

**Request** `PaymentHandlesUpdate`: `{ venmo_username?: string | null,
cashtag?: string | null, paypalme_username?: string | null, zelle_handle?:
string | null, zelle_display_name?: string | null }` — absent = untouched,
null = clear; normalization per R-user-5 (`@`/`$` stripped before
validation and storage, matching the shared `PaymentHandles` refinements)

**Response 200** `PaymentHandles` (current stored state)

**Errors**: 400 `VALIDATION_FAILED` — charset violation; cashtag HEAD 404
(`details.cashtag = 'not_found'`, R-user-6); `zelle_handle` set without
`zelle_display_name`; `zelle_handle` neither email nor E.164; 401
`UNAUTHENTICATED`; 429 `RATE_LIMITED`

**Requirements covered**: R-user-5, R-user-6, R-user-7

**Tests required**:
- [ ] Happy path: set all four rails (+ zelle display name); `@`/`$` prefixes stripped in stored + returned values
- [ ] Happy path: null clears a handle; absent fields untouched
- [ ] Error: cashtag HEAD 404 → 400 with details; HEAD timeout/5xx → save succeeds (fail-open)
- [ ] Error: zelle handle without display name → 400; non-email/non-E.164 zelle → 400
- [ ] Error: **no outbound request to any venmo.com host during validation** (R-user-7 — asserted via mocked transport)
- [ ] Authz: only the caller's own row is writable

---

### GET /users/:userId

Another user's member-visible profile (settle screens render the payee's
buttons from its handles). **Auth**: Required

**Response 200** `UserProfile`:
`{ id: Uuid, display_name: string, avatar_key: string | null,
venmo_username: string | null, cashtag: string | null, paypalme_username:
string | null, zelle_handle: string | null, zelle_display_name: string |
null }` (contracts spec §3.4 — handles deliberately member-visible; never
`email`, `prefs`, or `forward_email_slug`)

**Errors**: 401 `UNAUTHENTICATED`; 404 `NOT_FOUND` — nonexistent user OR no
shared trip (indistinguishable, R-user-4)

**Requirements covered**: R-user-4

**Tests required**:
- [ ] Happy path: co-member of any trip → profile with handles
- [ ] Error: unknown uuid → 404
- [ ] Authz: real user, zero shared trips → 404 with body identical to the unknown-uuid case; response never includes email/prefs

Trip-member lists (`GET /trips/:tripId/members`, trips spec) embed this same
`UserProfile` shape — one schema, no drift.

---

### POST /users/me/push-tokens

Register (or keep alive) this device's Expo push token. **Auth**: Required

**Request** `PushTokenCreate`:
`{ token: string, platform: 'ios' | 'android' }`

**Response 200** `PushToken`:
`{ id: Uuid, token: string, platform: 'ios' | 'android',
last_seen_at: ISODateTime }` — upsert: same token re-registered returns the
existing row with `last_seen_at` bumped; a token owned by another account
**moves** to the caller (R-user-8)

**Errors**: 400 `VALIDATION_FAILED` — not an Expo push token shape; 401
`UNAUTHENTICATED`

**Requirements covered**: R-user-8

**Tests required**:
- [ ] Happy path: register → row created; re-register → same id, `last_seen_at` bumped
- [ ] Happy path: token previously on account B, registered by A → now owned by A only (moved, not duplicated)
- [ ] Error: malformed token → 400
- [ ] Authz: rows created only under the caller's user_id

---

### DELETE /users/me/push-tokens/:pushTokenId

Deregister a push token (sign-out path uses `LogoutRequest.push_token_id`
instead; this covers settings-driven disable). **Auth**: Required

**Response 204** (no body)

**Errors**: 401 `UNAUTHENTICATED`; 404 `NOT_FOUND` — absent or owned by
another user (indistinguishable)

**Requirements covered**: R-user-8

**Tests required**:
- [ ] Happy path: own token deleted
- [ ] Error: unknown id → 404
- [ ] Authz: user B's token id → 404, row untouched

---

### DELETE /users/me

Delete the caller's account (App-Store-mandated surface). **Auth**: Required
(rate-limited)

**Response 204** (no body)

**Effects** (R-user-9): all sessions + refresh tokens revoked; all push
tokens deleted; Apple refresh token revoked via Apple's REST API
(`apple_credentials` consumed); the device is signed out. Data disposition
— Resolved at `.specs/database/schema.spec.md`:§R-db-16 (Gate 2,
2026-07-09): soft-delete + PII scrub; ledger rows survive as "Deleted
user".

**Errors**: 401 `UNAUTHENTICATED`; 429 `RATE_LIMITED`; 409 `CONFLICT` —
caller still owns a trip with other members (ownership transfer required
first, R-user-9 / schema spec §3.3.5)

**Requirements covered**: R-user-9, R-auth-7, R-auth-13

**Tests required**:
- [ ] Happy path: fixed effects all fire (sessions revoked, push tokens gone, Apple revocation called — mocked)
- [ ] Happy path: disposition — user row soft-deleted + PII scrubbed; surviving trip members still see ledger rows attributed to "Deleted user"
- [ ] Error: unauthenticated → 401
- [ ] Error: caller owns a trip with other members → 409, nothing revoked or scrubbed
- [ ] Authz: deletes exactly the token's `sub`; no parameterization

#### 3.4.3 Entitlements

---

### GET /users/me/entitlements

The caller's effective entitlements (ADR-005 seam, read side). **Auth**:
Required

**Response 200** `EffectiveEntitlements`:
`{ plan: 'free', ai_calls_per_day: number, alerts_enabled: boolean,
premium_place_details: boolean }` — computed by shared
`resolveEntitlements(entitlements_row)` (R-ent-1); values are display-only
on the client (R-ent-2). Remaining-quota display (calls used today) is the
AI spec's surface, not this endpoint.

**Errors**: 401 `UNAUTHENTICATED`

**Requirements covered**: R-ent-1, R-ent-3

**Tests required**:
- [ ] Happy path: free plan defaults (`ai_calls_per_day = 30`) returned
- [ ] Happy path: row with `overrides.ai_calls_per_day = 100` → 100 (resolver precedence)
- [ ] Error: unauthenticated → 401
- [ ] Authz: always the caller's row; no user parameter exists

---

### 3.5 Middleware contracts (consumed by every other API spec)

No implementation here — these are the behavioral contracts the server
middleware must satisfy and other specs reference by name.

| Middleware | Applies to | Behavior | Failure |
|---|---|---|---|
| `requireAuth` | every route outside the public allowlist (R-authz-1) | Verify `Authorization: Bearer` access token per R-auth-12 (stateless, ES256-only, iss/aud/exp); attach auth context `{ user_id, session_id }` to the request | 401 `UNAUTHENTICATED` |
| `requireTripMember(minRole = 'viewer')` | every `/trips/:tripId/*` route in every spec (R-authz-2) | Load caller's `trip_members` row for `:tripId`; attach `{ trip_id, role }` trip context | no membership / no trip → 404 `NOT_FOUND` (indistinguishable); member below `minRole` → 403 `FORBIDDEN` (R-authz-3) |
| `requireAiQuota(feature: ai_feature)` | every AI endpoint (R-ent-2) | Within the request, before any model call: kill-switch check, then `resolveEntitlements` + today's `ai_usage[feature]` for the caller | cap reached → 429 `AI_CAP_EXCEEDED`; kill switch → 503 `AI_DISABLED` |

- Order fixed by R-authz-4: `requireAuth → validation → resource authz →
  handler`; all failures serialize as `ApiError` via the shared error
  middleware.
- `capture_parse` vs the AI cap — Resolved at
  `.specs/database/schema.spec.md`:§3.2 `ai_feature` (Gate 2, 2026-07-09):
  capture parsing does NOT count against the user's AI cap; it has its own
  structural ceiling (20 captures/day). Capture call sites skip
  `requireAiQuota` (kill-switch check still applies); the middleware
  signature above is unaffected.
- Usage increment (`ai_usage` upsert) happens after a successful model call
  — the AI spec owns increment semantics; this spec owns the gate.

### 3.6 Security

#### 3.6.1 Token storage on device

- Refresh token: **expo-secure-store** (iOS Keychain / Android Keystore) —
  never AsyncStorage, never MMKV, never the TanStack Query persist layer.
  Navigation spec §2.2 (session hydration from secure storage, R-nav-3) is
  the consuming contract.
- Access token: held in memory (Zustand session store); persisting it buys
  nothing (15-min TTL) and widens exposure. `TokenProvider.getAccessToken()`
  (contracts spec §3.6) refreshes through `/auth/refresh` on expiry —
  single-flight: concurrent 401s trigger exactly one refresh (rotation makes
  parallel refreshes self-defeating, R-auth-11).
- Sign-out (local): clear secure store + memory + query cache (R-nav-4)
  after calling `/auth/logout` — best-effort: local clearing never blocks on
  network.
- Tokens never appear in logs, analytics, error reports, or URLs (Quality
  gate #5; refresh token travels only in POST bodies).

#### 3.6.2 Apple identity-linking policy

Resolved at `.specs/database/schema.spec.md`:§3.3.1 `users` (Gate 2,
2026-07-09): auto-link on verified matching email — implemented by this
spec's R-auth-6 branch. Security constraints that shaped the rule still
bind the implementation: linking requires the incoming email to be verified
(Google tokens carry `email_verified` — require it true; Apple emails are
verified by construction), because auto-linking on an unverified email is
an account-takeover vector. Apple private-relay addresses mean the same
human can still present different emails and end up with two accounts —
accepted v1 behavior; `users.email` uniqueness holds.

#### 3.6.3 Rate limits on auth surfaces (R-auth-14)

| Surface | Limit | Key | Rationale |
|---|---|---|---|
| `POST /auth/apple`, `POST /auth/google` | 10/min, 50/day | IP | credential-stuffing / token-grinding |
| `POST /auth/refresh` | 30/hour | session (`sid` via token row) + 60/hour per IP | rotation abuse; theft probing |
| `POST /users/me/avatar-upload` | 10/hour | user | presign farming |
| `PATCH /users/me/payment-handles` | 10/hour | user | bounds outbound cash.app HEADs (we are a polite client) |
| `DELETE /users/me` | 3/day | user | fat-finger + abuse containment |

All limits are server config constants; exceeding any returns 429
`RATE_LIMITED` + `Retry-After`. Backing store (in-memory vs Postgres
counter) is a P-3 infra decision — single-instance in-memory is acceptable
until there are ≥ 2 server instances.

#### 3.6.4 Misc posture

- ES256 key handling per §3.2 (env-only, `kid` rotation).
- `apple_credentials` ciphertext: AES-256-GCM, env key, never serialized
  outward (§3.3.3).
- Error bodies on auth failures are uniform (R-auth-1) — no oracle for
  "which check failed" or "does this account exist".
- `requestId` present on every `ApiError` (contracts spec §3.5) — auth
  failures correlate in logs without logging tokens.
- Payment-handle writes are format+HEAD validation only; no Venmo traffic
  ever (R-user-7 — ToS red line, research § ToS red lines).

### 3.7 `@gogo/shared` additions (per R-shared-14 module pattern)

New module `domains/auth.ts` (schemas + endpoint descriptors):
`AppleSignInRequest`, `GoogleSignInRequest`, `RefreshRequest`,
`SignInResponse`, `AuthTokens`, `LogoutRequest`, `AuthSessionInfo`.
Additions to existing modules: `UserUpdate`, `PaymentHandlesUpdate`,
`AvatarUploadRequest`, `AvatarUploadTicket`, `PushTokenCreate`, `PushToken`
(`domains/user.ts`); `EffectiveEntitlements` (`domains/entitlement.ts` —
the return type of `resolveEntitlements`, R-shared-12). No new enums; no
new `ErrorCode` values. Server-only material (JWT claims, hashes,
ciphertext) gets **no** shared schema — it never crosses the wire.

`ObjectStorage` port (server-side interface, not shared — it's I/O):
`createPresignedUpload(key, content_type, byte_size, ttl)` +
`objectExists(key)`; implemented per provider at P-3 (schema spec §3.7
escalation). The avatar endpoints depend only on the port.

### 3.8 Out of scope (explicit)

- **Trip membership data model + member/invite endpoints** — trips spec
  (this spec defines the `requireTripMember` contract those routes run
  under).
- **`ai_usage` increment + remaining-quota display + kill-switch job** — AI
  spec (this spec owns the gate middleware only).
- **`forward_email_slug` generation + capture webhook auth** — capture spec.
- **Onboarding contents/order** — navigation spec marker (lines 104–107);
  all candidate fields are writable via §3.4.2 endpoints.
- **Passkeys** — explicitly deferred non-breaking enhancement (Gate-1 lock).
- **Apple server-to-server notifications** (credential revoked/email
  changed): additive later; `apple_credentials` doesn't preclude it.
- **Object-storage provider choice + storage-side encryption/ACLs** — P-3
  infra escalation (schema spec §3.7).
- **Exact package versions** (`jose`, `expo-secure-store`,
  `expo-apple-authentication`) — pinned at P-3 via `npm view` + Context7
  (R-shared-13; CLAUDE.md § Before you code).

---

## 4. Tasks

Sized to one agent session each; become `T-N.M` rows at build time.
Sequencing: AU-1 → AU-2 → (AU-3, AU-4) → AU-5 → (AU-6, AU-7) → AU-8.
Depends on SH-1 (shared scaffold) and DB-1 (users/entitlements/push_tokens
tables) landing first.

| ID | Task | Covers | Blocked by markers? |
|---|---|---|---|
| AU-1 | `@gogo/shared` auth additions: `domains/auth.ts`, user/entitlement schema additions, endpoint descriptors (§3.7) | R-shared-14 pattern; all request/response shapes | no (`travel_style` enum resolved at contracts spec §3.4) |
| AU-2 | Auth tables + migration: `auth_sessions`, `refresh_tokens`, `apple_credentials` (§3.3), prune job | R-auth-9, R-auth-11 structure, R-auth-7 storage | no |
| AU-3 | Provider verification + sign-in endpoints: JWKS verify, nonce binding, find-or-create + entitlements txn, auto-link on verified email collision, Apple code exchange | R-auth-1..7, R-auth-15 | no (identity linking resolved Gate 2) |
| AU-4 | Token issuance/rotation: ES256 signing, `/auth/refresh` rotation + reuse revocation, `/auth/logout`, sessions list/revoke | R-auth-8..13 | no (session list/revoke confirmed in v1, Gate 2) |
| AU-5 | Middleware trio + error mapping + rate limiting: `requireAuth`, `requireTripMember`, `requireAiQuota`, shared `ApiError` serializer, limit table | R-authz-1..4, R-ent-2, R-auth-14 | no (`capture_parse` excluded from the AI cap, Gate 2) |
| AU-6 | Profile endpoints: `/users/me` GET/PATCH, avatar presign + commit validation, payment handles (HEAD validation, fail-open), push tokens, `/users/:userId` shared-trip guard | R-user-1..8 | no |
| AU-7 | Entitlements read endpoint wired to shared resolver | R-ent-1, R-ent-3 | no |
| AU-8 | Account deletion: fixed effects (session/push/Apple revocation) + soft-delete/PII-scrub disposition, owner-transfer guard | R-user-9 | no (disposition resolved Gate 2: soft-delete + PII scrub) |

**Cross-cutting tests required** (beyond the per-endpoint lists):

- [ ] Middleware order: invalid token + invalid body → 401 (auth precedes validation, R-authz-4)
- [ ] `requireTripMember` harness: non-member and nonexistent trip produce byte-identical 404 bodies; viewer blocked from an editor route with 403 (R-authz-2/3) — the reusable test fixture every trip-scoped spec's authz tests build on
- [ ] `requireAiQuota`: at cap → 429 `AI_CAP_EXCEEDED`; kill switch → 503 `AI_DISABLED`; check runs before any (mocked) model call (R-ent-2)
- [ ] Token hygiene sweep: log output of a full sign-in/refresh/logout cycle contains no token material (R-auth-9)
- [ ] Rate limiter: each §3.6.3 row returns 429 + `Retry-After` at threshold, resets after window

---

*Trace: every R-auth/R-user/R-ent/R-authz cites its design section and
endpoints inline. All six markers resolved at Gate 2 (2026-07-09) — four at
their canonical homes (identity linking → auto-link on verified email;
account deletion → soft-delete + PII scrub; `travel_style` → fixed
multi-tag set; `capture_parse` → outside the AI cap), two owned here (Apple
client mechanism → native module; session-management UI → endpoints + UI
ship in v1). Zero markers remain.*
