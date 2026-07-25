# PHASE-005 — Auth, profiles & entitlements

> **Append-only archive.** Active from 2026-07-22; **code-complete 2026-07-25**
> (T-5.1..T-5.8 merged, CI-green). Ledger **F-018..F-029 pending on-device QA**
> (blocked on OAuth credentials + server env — Sean). Sensitive path: every
> review round auto-escalated. Specs: `api/auth-users`, `client/navigation`
> (NAV-2), `shared/contracts`.

## Outcome

The full auth stack — server + client — is built, reviewed (5-lane local
pipeline + fresh impartial judge every task), and merged CI-green. The
**ledger is NOT flipped**: F-018..F-029 verification requires the feature
exercised in the running app (Law #7), which needs Apple Sign-In entitlement +
Google iOS OAuth client id + the server running with `APPLE_CLIENT_ID` /
`GOOGLE_CLIENT_IDS` + keys — Sean's to wire. Same pattern as P-4 (F-010..F-017
flipped only after device QA).

## Security invariants delivered (from the approved spec set)

Apple + Google OAuth only, zero passwords · ES256 access + rotating refresh
with reuse-theft family revocation · refresh token in **expo-secure-store
ONLY** (never AsyncStorage/MMKV/query-cache) · middleware trio
`requireAuth` / `requireTripMember` / `requireAiQuota` · 404-indistinguishable
authz · in-memory query cache holds no tokens, evicted on sign-out.

## Task record

- **T-5.1 (de98def)** — 15 endpoint descriptors (auth 6 / users 8 / entitlements
  1), credential length caps, `pruneAuthRows`. shared 317 + server 63. AU-1/AU-2
  pre-satisfied by T-3.2/T-3.3 (drizzle zero-delta, no migration owed). 5-lane
  0-blocking SHIP; judge routed the free ultra at T-5.2/T-5.4.
- **T-5.2 (bc58180)** — Apple/Google JWKS verify, nonce binding (Apple
  SHA-256(raw_nonce) lowercase hex / Google raw), auto-link, AES-256-GCM Apple
  credential store, ES256 access + CSPRNG refresh. Server 63→143. **First HITL
  gate**: round-1 fix-then-ship (5 blocking) → judge→human → Sean's
  `/code-review ultra` found **bug_001** (unawaited Apple key import → malformed
  key passed boot → every Apple sign-in silently skipped the credential store →
  App-Store revocation broken) → fixed 3deb831 + re-judged merge/high.
  `jose@6.2.4`, `@hono/zod-validator@0.9.0`. Landmines: boot-parse-secrets-awaited;
  no raw control bytes in test literals; prettier reflows locked .md/.yaml
  (apply syncs surgically via Bash).
- **T-5.3 (3abfac4)** — refresh rotation, session-scoped reuse-theft family
  revocation (replay A after A→B ⇒ family dies), atomic CAS double-spend guard,
  STATELESS requireAuth, session list/revoke, /auth/refresh + /auth/logout.
  Server 143→179. 6 advisories fixed (require `exp`; cursor → integer epoch-µs,
  crash-safe). Lesson: keyset cursor must carry full µs precision, not a JS-Date
  ISO round-trip (ms-truncates → skips rows).
- **T-5.4 (d422cf0)** — authz middleware trio + error envelope + rate limits.
  requireAuth promoted app-wide (one impl); requireTripMember **404-
  indistinguishable** (one `trip_members` query, never touches `trips` → no
  oracle) — the fixture every later domain inherits; requireAiQuota seam; public
  allowlist; IP=socket-peer rate limits. requireTripMember/requireAiQuota DORMANT
  until trips/AI phases. Server 179→219. **Ultra WAIVED → deep local self-review
  caught HEAD /api/health→401** (LB probe marks instance unhealthy) → fixed +
  drift-guard tests. 4 advisories → QUEUE (P-10 atomic AI-increment is a P0
  blocker for P-10; ai_usage index; trusted-proxy ipOf; NAT lockout accepted).
- **T-5.5 (d408cac)** — GET/PATCH /users/me (code-point display-name clamp both
  sides), member profile GET (404-indistinguishable, member-safe fields), avatar
  presign+commit (own-key-only, namespace-checked), payment-handle normalize
  (cashtag host-PINNED to cash.app, redirect:manual, fail-open; no Venmo fetch),
  push-token upsert-move, entitlements read (shared resolver). Server 219→271,
  shared 320. ~50 security probes cleared avatar-traversal / cashtag-SSRF /
  push-move / IDOR. **Avatar object storage → Sean escalation** (see Deferrals).
- **T-5.6 (e82618b)** — DELETE /users/me: soft-delete + FULL PII scrub (every
  users column, security-enumerated) in one atomic txn on the WS-Pool driver;
  sole-owner-409 blocks before any write; all sessions/refresh revoked (no
  resurrection); Apple token revocation post-commit (can't roll back local
  deletion). Idempotent 204. Server 271→288. Extracted shared
  apple-client-secret signer. **All P-5 server tasks done.**
- **T-5.7 (afeb862)** — client auth gate + sign-in screen [NAV-2]: Zustand
  session store (refresh token expo-secure-store ONLY), ApiClient single-flight
  refresh-on-401, redirect gate, Apple+Google sign-in. Mobile 152→212. Round-1
  fix-then-ship, **2 blocking both masked by green CI**: (1) `useGoogleSignIn()`
  threw during render when Google unconfigured → whole sign-in screen crashed →
  render-gated via `GoogleSignInButton` subcomponent, **revert-proven**; (2)
  untested sign-in composition hid #1 → real-tree renderRouter test. Codified
  **crash-masked-by-mocks** landmine → `rules/mobile.md`.
- **T-5.8 (a17cfea)** — onboarding + profile screens + the server-state layer.
  First-run onboarding (name → currency → travel-style → payment handles, all
  skippable after name; finishes via `completeOnboarding()`) + profile/settings
  (edit, handles, appearance/accent theme, session list + revoke, read-only
  entitlements, hard-confirmed delete-account, sign-out). **TanStack Query**
  introduced per ADR-004: `QueryClientProvider` + typed hooks over `@gogo/shared`
  descriptors; `signOut` clears the query cache (nav §2.2). Mobile 152→247.
  Round-1 fix-then-ship, 1 blocking + 12 advisory: the blocker was a **coverage
  gap** (payment-handle clear-to-null branch untested → a regression omitting
  instead of sending `null` = "user can never remove a handle" ships green — the
  T-5.7 class) → `diffField` unit test + integration test asserting explicit
  nulls, **revert-proven twice** (fixer + judge). Round-2 judge merge/high.

## The local review pipeline earned its keep

Every task all-green CI passed; the 5-lane pipeline + judge caught real defects
CI missed each time it mattered:

- **T-5.2** — unawaited Apple key import (App-Store revocation risk) — via Sean's ultra.
- **T-5.4** — HEAD /api/health → 401 (LB probe) — via deep local self-review.
- **T-5.7** — `useGoogleSignIn()` render crash (whole sign-in screen down) — via lanes.
- **T-5.8** — payment-handle clear-to-null data-integrity coverage gap — via lanes.

## Deferrals / carve-outs (all tracked in QUEUE)

- **Avatar UPLOAD → P-12** — depends on object storage, which Sean deferred
  2026-07-24. Presign/commit fail safe (500/400) until configured; the client
  ships avatar **display** only (initials placeholder). F-025 avatar sub-criterion
  verifies at P-12. Security note carried to the P-12 row: `avatar_key` must
  resolve to a **server-signed read URL**, never a raw user-supplied string
  (else client-side SSRF / tracking-pixel via `expo-image`).
- **Notification-priming onboarding step → P-6 push seam** — needs EAS
  `projectId` + push-token mobile flow. Onboarding v1 ships without it (skippable).
- **Query keys are unscoped** (`["me"]`/`["sessions"]`/`["entitlements"]`) — safe
  ONLY because `signOut()` clears the cache (unit-tested + documented at the seam).

## Landmines codified this phase

`rules/server.md`: boot-parse-secrets-awaited (T-5.2 bug_001 class); no raw
control bytes in test literals; keyset cursor full-µs precision; prettier
reflows locked .md/.yaml → surgical Bash edits. `rules/mobile.md`:
crash-masked-by-mocks (a screen test mocking the whole feature module can't see
a render-time crash — keep one renderRouter test with the REAL hook in its
unconfigured state).

## On-device QA recipe

See [`memory/gogo-sim-qa-toolkit.md`] and PHASE-004's device-install recipe.
P-5 QA prerequisites Sean must provide: Apple Sign-In entitlement on the dev
build, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, server running with
`APPLE_CLIENT_ID` / `GOOGLE_CLIENT_IDS` + ES256/Apple keys. Golden path:
fresh install → Apple **or** Google sign-in → onboarding (name → currency →
style → handles, skip-all also valid) → trip list → profile (edit, handles,
theme, sessions, sign-out, delete). Ledger F-018..F-029 flips after this passes.
