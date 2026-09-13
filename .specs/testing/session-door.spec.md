# E2E Session Door — `.specs/testing/session-door.spec.md`

> **Task:** S-4 wave 2 (T1) · **Status:** APPROVED — Sean 2026-09-13, Autonomy
> trigger #4 (security-model change) satisfied. All four §8 recommendations of
> the design doc are ruled and written below as decided, not as options.
>
> **Sources:** `docs/STATE.md` § "E2E LANE HANDOFF" (Sean verbatim: "gated on
> env var such as NODE_ENV 'development' or 'testing' or 'e2e' if we want to
> be more targeted" + double-gate so prod builds cannot carry it + full review
> pipeline with a mandatory security lane), [ADR-007](../../docs/decisions/ADR-007-maestro-e2e-lane.md)
> (the Maestro lane this door plugs into), `.specs/api/auth-users.spec.md`
> (the sign-in contract this door reuses byte-for-byte on the response side),
> `.claude/rules/testing.md` (R-test-7 falsification discipline), `.claude/rules/server.md`
> (Neon-HTTP-has-no-transactions landmine), `.claude/rules/mobile.md` (the
> vacuous-pin taxonomy; the PR #61 Hermes-UTF-16 `strings`-probe trap).
>
> **Sensitive path:** this spec defines a route that mints authenticated
> sessions without provider verification. Every requirement below exists to
> keep that route (a) absent from any build that could ship, and (b) useless
> even if a misconfigured server exposes it. CLAUDE.md Autonomy Contract #4
> applies to any deviation from the gates in §3.

---

## 1. Scope

The env-gated E2E "session door" — one unauthenticated server route
(`POST /auth/e2e/session`) that mints a full, real session (real
`auth_sessions` row, real refresh-token family) for a deterministic fixture
user, plus the mobile entry surface that calls it via a deep link. Together
they let a black-box Maestro flow, running against a **Release-configuration**
iOS simulator build, get behind the sign-in gate in one `openLink` and drive
every authenticated surface (bookings, itinerary, timezone composition,
money, reference search) that is currently unreachable to the E2E lane.

This spec (T1) covers the requirements and threat model that T2 (`@gogo/shared`
descriptor), T3 (server route), and T4 (mobile entry route) trace to (Law #4).
The reusable Maestro subflow contract and the flow files themselves are T5's
concern and are described here only as consumers of the interfaces T2–T4
build.

Out of scope (see the design doc's §2 for the full rationale): Maestro flows
6–10 (booking/itinerary/money proof flows); any CI change
(`.github/workflows/ci.yml` is untouched — Law #5, `.claude/rules/ci.md`); any
schema/migration change (Law #6 — the door writes only through
`createUserWithEntitlements` and `createSessionWithTokens`); new `ErrorCode`
values (auth-users spec §3.4 rule; the door adds none); Android (iOS-first
per ADR-004); the `PUBLIC_ALLOWLIST` exported constant or its `size === 5`
pin (§4.3 below); deleting or resetting fixture data (§6 Q3 below — no
destructive reset, ever); universal-link transport (the `links.gogotravel.example`
domain is a placeholder and serves no AASA).

---

## 2. Requirements (EARS)

Numbering continues `auth-users.spec.md`'s `R-auth-*` family as its own
prefix, `R-door-*`, scoped to this spec.

- **R-door-1 (server double gate):** WHEN the server boots THE SYSTEM SHALL
  mount `POST /auth/e2e/session` only if `NODE_ENV` is not `production` AND
  `E2E_SESSION_DOOR_SECRET` is set to a value of at least 32 characters;
  otherwise the route SHALL NOT exist.
- **R-door-2 (fail closed in production):** WHEN `NODE_ENV` is `production`
  AND `E2E_SESSION_DOOR_SECRET` is set THE SYSTEM SHALL refuse to boot with an
  error naming the variable and never its value.
- **R-door-3 (no oracle):** WHEN a request to `POST /auth/e2e/session` fails
  for any reason — route absent, wrong secret, malformed body, ineligible
  fixture row, rate limited — THE SYSTEM SHALL return the identical `401
UNAUTHENTICATED` envelope an unauthenticated request to an unknown path
  returns, and SHALL record the real reason only in the server log with the
  `requestId`.
- **R-door-4 (ordinary session):** WHEN the door mints a session THE SYSTEM
  SHALL create it through the same `createSessionWithTokens` path sign-in
  uses, so rotation, reuse-theft family revocation, `/auth/logout`, session
  listing and session revocation behave identically; the door SHALL introduce
  no new token code path.
- **R-door-5 (fixture identity):** WHEN the door mints a session for
  `user_key` K THE SYSTEM SHALL find-or-create a user whose `apple_sub` is
  `e2e:K`, whose email is `e2e+K@gogotravel.invalid`, and whose entitlements
  row is created in the same transaction; and WHEN a row matching that key
  carries any other provider identity or a non-null `deleted_at` THE SYSTEM
  SHALL reject rather than mint.
- **R-door-6 (audit):** WHEN the door is enabled THE SYSTEM SHALL emit an
  ASCII-only boot warning naming the route, and SHALL log every mint with
  `requestId`, `sessionId`, `user_key` and whether the user was created —
  never the secret, the tokens, or the email.
- **R-door-7 (client build gate):** THE SYSTEM SHALL open the client door
  only when `EXPO_PUBLIC_E2E_DOOR_SECRET` was inlined at build time with at
  least 32 characters; a build without it SHALL render an inert,
  non-zero-framed marker at `gogo://e2e-session` and SHALL issue no network
  request.
- **R-door-8 (clean slate):** WHEN the client door runs THE SYSTEM SHALL
  complete boot hydration, then perform a full local sign-out reset (session
  store, secure-store refresh token, query cache, tab memory, last-viewed
  trip, money-segment memory, deeplink-return and settle-return records,
  last-zone map) BEFORE applying the minted session.
- **R-door-9 (rate bound):** WHEN door calls from one IP exceed 20 per minute
  or 200 per day THE SYSTEM SHALL reject further calls with the same uniform
  401 and no `Retry-After`.
- **R-door-10 (evidence durability):** WHEN `scripts/e2e.sh` completes a run
  THE SYSTEM SHALL copy the JUnit report and the run's artifact directory to a
  mode-700 directory outside the repository worktree and print those paths
  plus the run's `~/.maestro/tests/<ts>/maestro.log` path; a failed copy SHALL
  fail the run.

---

## 3. Threat model + the gates

### 3.1 What the door is

One unauthenticated route that mints a full session **without provider
verification**. It is, by construction, a total bypass of `POST /auth/apple`
/ `POST /auth/google`. If it is ever reachable on an internet-facing host
with a known secret, it is full account takeover of every fixture user and —
because it find-or-creates — an unbounded user-creation primitive. Every
design choice below follows from that.

### 3.2 The gates, named

| #                       | Side   | Gate                          | Allowed value                                                                                                                                     | Default                                                  |
| ----------------------- | ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| G1                      | server | `NODE_ENV`                    | anything **except** `production` (enum stays `development` / `test` / `production` — see §3.3)                                                    | `development`                                            |
| G2                      | server | `E2E_SESSION_DOOR_SECRET`     | string, **>=32 chars**; absent means the route is not mounted                                                                                     | absent                                                   |
| G3                      | client | `EXPO_PUBLIC_E2E_DOOR_SECRET` | string, **>=32 chars**, inlined by Metro at build time; absent means the door module never issues a request and the route renders an inert marker | absent                                                   |
| G4                      | server | boot refusal                  | `NODE_ENV === "production"` **AND** G2 set means `loadEnv()` throws, so the process never reaches `serve()`                                       | —                                                        |
| **G5 (decided, §8 Q4)** | server | **request host**              | the resolved request `Host` SHALL be loopback, RFC-1918, or `.local`; the door SHALL reject with the uniform 401 otherwise, regardless of G1/G2   | n/a — enforced unconditionally when the route is mounted |

The door exists only at `G1 AND G2 AND G5` on the server and only works at
`G1 AND G2 AND G3 AND G5` end to end. G5 uses the **same predicate**
`apps/mobile/src/auth/config.ts` already uses for its cleartext-transport
guard, so the two ends of the rig agree on what "local" means (decided §8 Q4
option (b)) — this closes the residual risk named in §3.8: a hosted
environment that forgets `NODE_ENV` (which defaults to `development`) and
therefore clears G1 is still blocked by G5 unless it is also reachable at a
loopback/private address, which a real deploy is not. A physical-device rig
on the LAN still works (RFC-1918 is allowed); a tunnelled rig (ngrok and
friends) needs a deliberate override, out of scope for T1–T4.

Nothing in the repo, in `.env.example`, in `app.json`, or in any default
build command sets G2 or G3. Both come from `scripts/gen-test-env.mjs`, which
writes to the **gitignored** `apps/server/.env.test` (mode 600) — the same
throwaway-material pattern T-S3.1 already established for the 8 auth vars.

### 3.3 Why not `NODE_ENV="e2e"`

Sean's "if we want to be more targeted" is served by G2, not by a new
`NODE_ENV` value. `apps/server/src/env.ts` pins
`NODE_ENV: z.enum(["development","test","production"])` and `index.ts`/`app.ts`
branch on `=== "development"` / `=== "production"`. Adding a fourth value
silently turns off the dev request log, changes the health-only-boot refusal
branch, and forces an audit of every `NODE_ENV` read for a value none of them
anticipate. A dedicated secret var is strictly more targeted (it names
exactly one capability) and strictly less blast radius. **Decision: the enum
does not change.**

### 3.4 Why `__DEV__` cannot be the client gate

The E2E merge lane builds `--configuration Release` (ADR-007 /
`.maestro/README.md` "The build lane"), where `__DEV__` is `false` — that is
precisely why `.maestro/diagnostics-panel-dev.yaml` is quarantined behind the
`dev` tag and why `(auth)/diagnostics.tsx` renders `diagnostics-screen-inert`
on Release. A `__DEV__` client gate would make the door unreachable on the
only build the lane cares about. G3 is a build-time **env** gate instead.

Mechanism (read out of the installed preset,
`babel-preset-expo`'s `inline-env-vars.js`): in a production (Release) build
the plugin does `path.replaceWith(t.valueToNode(process.env[key]))` for every
`process.env.EXPO_PUBLIC_*` member expression. With the var unset that folds
to the literal `undefined`, so the gate becomes a compile-time
constant-false. An attacker holding the shipped `.ipa` cannot flip it; there
is no runtime input that reaches it.

**Honest limit, do not overclaim.** Metro does not tree-shake by default, so
the door module's _bytes_ may still sit in a door-free bundle even though the
branch is constant-false and the secret literal is absent. The security claim
is therefore **"unreachable and useless"**, not "absent": the gate cannot be
turned on at runtime, the secret is not in the artifact, and a production
server has no door to talk to. The black-box proof of the reachability claim
is the `session-door-absent` Maestro flow (T5), which is a behavioral
assertion on the real Release artifact and dodges the Hermes-encoding trap
that produced three false "not in the bundle" claims in PR #61
(`.claude/rules/mobile.md`). **Do not attempt to prove absence with
`strings | grep`.**

### 3.5 Is a shared secret needed on top of the env gate? — Decided: yes

`NODE_ENV !== "production"` alone is not a security boundary, it is a
configuration accident away from nothing:

- Sean's dev server binds `0.0.0.0:3000` and is reachable from the whole LAN
  (that is how the physical-device rig works — `apps/mobile/src/auth/config.ts`
  tiers 2/3 derive a LAN URL on purpose). Anyone on the coffee-shop wifi
  could mint sessions.
- `env.ts` **defaults `NODE_ENV` to `development`**. A hosted environment
  that forgets to set `NODE_ENV` passes G1. The secret (and now G5) is what
  still holds in that case.
- A preview/staging deploy that inherits a rig's env file passes G1 if it
  runs `NODE_ENV=development`. The secret again holds.

**Decided (§8 Q2, option (a)): secret transport to the client is
build-inlined (G3), never URL-carried.** The deep link carries only
`user_key` and `first_run`. The rejected alternative,
`gogo://e2e-session?secret=...`, needs no rebuild on rotation, but Maestro
records command text into `commands.json` / `maestro.log`, which the evidence
rider (R-door-10) then copies into a durable directory, and iOS additionally
logs `openLink` URLs to the system log. A secret that leaks into durable
evidence is a worse trade than a rebuild.

Comparison is constant-time: SHA-256 both sides, then
`crypto.timingSafeEqual` on the equal-length digests. Hashing first removes
the length leak a raw `timingSafeEqual` has. `sha256Hex` already exists in
`apps/server/src/auth/crypto.ts`.

### 3.6 No oracle — one failure response, byte-identical to an unknown path

`apps/server/src/app.ts` mounts `createRequireAuth` on `"*"` **before
routing**, and `app.test.ts` shows the allowlist is exactly 5 keys.
Consequence: an unauthenticated request to **any** unrecognised path
(`POST /api/auth/nonexistent`) already returns the uniform `401
UNAUTHENTICATED` envelope, not a 404. That is the baseline the door must be
indistinguishable from.

Contract: **`POST /auth/e2e/session` has exactly two observable responses.**

1. `200` + `SignInResponse` — secret correct, door mounted, host allowed
   (G5), not rate-limited.
2. `401` + the identical `UNAUTHENTICATED` envelope
   (`apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE)`) for **every**
   other outcome: route not mounted (`requireAuth`'s own 401 fires), wrong
   secret, disallowed host, malformed body, bad `user_key` shape, ineligible
   fixture row, rate limited.

This deliberately **deviates from `rejectInvalidBody`** (which the rest of
the server uses to return `400 VALIDATION_FAILED`): a 400 would prove the
route exists, which is exactly the oracle `auth-users.spec.md` §3.6.4 forbids.
The route's `zValidator` hook returns the uniform 401 instead. Same reason
there is no `Retry-After` on the rate-limit path.

The real reason is logged server-side with the `requestId` — that is how a
misconfigured rig gets debugged:
`[auth] e2e door rejected (requestId=..., reason=secret_mismatch)`.

### 3.7 Rate limit + audit posture

- **Rate limit** (new `RATE_LIMITS.e2eDoor`, `apps/server/src/config.ts`):
  **20/min and 200/day per IP**, keyed with the existing `clientIp` resolver
  (never `X-Forwarded-For` — `.claude/rules/server.md`). Sized off the
  measured lane: PR #61's four-flow release run took 178.188 s, i.e. roughly
  one door call per 30 s; 20/min leaves headroom for `--flow`-loop authoring
  without leaving a secret-grinding surface open. Deliberately not reusing
  `RATE_LIMITS.signIn` (10/min) — a tight authoring loop would trip it.
- **Boot warning** (`index.ts`, alongside the existing object-storage / Mapbox
  notes): `[boot] E2E SESSION DOOR ENABLED - POST /auth/e2e/session mints sessions without provider verification. Local test rigs only.`
  ASCII only, no em dash: a non-ASCII byte makes Hermes store a literal as
  UTF-16 and every `strings` probe a silent false negative, and the repo
  keeps all build markers greppable.
- **Per-mint audit:** `logger.warn` with `requestId`, `sessionId`,
  `user_key`, and whether the user was created. **Never** the secret, the
  tokens, or the email (Law #1; the `storeAppleCredential` precedent in
  `routes.ts` is the house style).

### 3.8 What happens if the gate is set in production by mistake — fail closed, loudly

Four layers, in order of firing:

1. **G4 / `loadEnv` throws.** A cross-field check in `EnvSchema`
   (`superRefine`): `NODE_ENV === "production" && E2E_SESSION_DOOR_SECRET !== undefined`
   yields `Invalid environment configuration - E2E_SESSION_DOOR_SECRET: must not be set when NODE_ENV is production`.
   `loadEnv()` is called at the top of `index.ts` before anything else, and
   it reports **names only, never values** — keep that. The process exits
   non-zero; the deploy's health check never goes green; the platform rolls
   back. It does **not** "ignore the variable and carry on", because a server
   that silently drops a security-relevant config value teaches operators
   that the value is inert.
2. **Router builder returns `null`.** Even if layer 1 were bypassed (a future
   caller constructing `Env` by hand), `buildE2eDoorDeps(env)` returns `null`
   unless `NODE_ENV !== "production"` **and** the secret is present and >=32
   chars. `createApp` mounts nothing for `null`.
3. **G5 host check.** Even if layers 1–2 were bypassed (a future caller
   mounting the router directly), every request the handler sees is still
   checked against the loopback/RFC-1918/`.local` predicate before anything
   else runs, and rejected with the uniform 401 otherwise.
4. **Client.** A build without G3 renders `e2e-session-screen-inert` and
   issues no request.

**Residual risk, named — and closed by G5:** a production deploy that forgets
`NODE_ENV` entirely defaults to `development` and therefore clears G1. Before
G5, G2 alone would have to hold (nobody sets the secret) with no
environmental backstop; **with G5, that deploy is additionally inert unless
it is reachable at a loopback/private address, which a real deploy is not.**

---

## 4. Interfaces

### 4.1 `@gogo/shared` — new module `packages/shared/src/domains/e2e.ts`

Deliberately **not** re-exported from `packages/shared/src/index.ts`.
Precedent: `ai/sha256` is excluded from the barrel with a comment explaining
why. Consumers import the subpath `@gogo/shared/domains/e2e`, which the
package's `"./*"` export map already resolves to `dist/domains/e2e.js`.
Effect: the production `authEndpoints` object stays clean, and "who can
reach this descriptor" is a two-hit grep a security reviewer can run.

`E2eUserKeySchema` — `^[a-z0-9][a-z0-9-]{0,31}$` (1–32 chars of
`[a-z0-9-]`, first char alphanumeric) — the fixture-identity key; it is
concatenated into `apple_sub`, so its shape IS a security boundary.

`E2eSessionRequestSchema` — `{ secret: string (32-512 chars), user_key:
E2eUserKeySchema, device: DeviceInfoSchema, first_run?: boolean }`. `secret`
min(32) mirrors the server gate; max is DoS headroom. `first_run` decouples
the response's `is_new_user` from whether the row was actually created, so a
flow's onboarding branch is deterministic instead of "true on the first run
after a DB reset." Default false.

`e2eEndpoints.mintSession` — `POST /auth/e2e/session`, body
`E2eSessionRequestSchema`, response `SignInResponseSchema` (reused verbatim —
the door's wire output is bit-compatible with a real sign-in, which is what
lets the mobile side call `applySignIn(response)` with zero new client state
handling).

### 4.2 Which user it mints — fixed-key find-or-create

Rejected: a per-call random user (every flow walks first-run onboarding, and
the DB grows one user per call with no way to re-enter a known state).
Rejected: one single fixed fixture user (all flows share mutable state).

**Decided: keyed find-or-create.** For `user_key = K`:

| Column         | Value                         |
| -------------- | ----------------------------- |
| `apple_sub`    | `e2e:${K}`                    |
| `email`        | `e2e+${K}@gogotravel.invalid` |
| `display_name` | `E2E ${K}`                    |
| `google_sub`   | `null`                        |

`apple_sub` carries the identity because `users_identity_or_scrubbed_ck`
requires a live account to hold at least one provider sub. The `e2e:` prefix
cannot collide with a real Apple `sub` (opaque digits and dots), and the
column is `unique()` so the key is the identity. `.invalid` is the RFC 2606
reserved TLD — the address can never be routed anywhere. Creation goes
through **`createUserWithEntitlements`** so R-db-5 (entitlements row in the
same transaction) holds without a second implementation — this requires a
transaction-capable driver (the Neon **HTTP** driver would throw here,
`.claude/rules/server.md` landmine #1; the door inherits that constraint from
sign-in). **Adversarial guard:** the lookup is `WHERE apple_sub = 'e2e:' || K`.
It can never select a row created by a real sign-in, and if a matched row
somehow carries a `google_sub` or a non-null `deleted_at`, the door rejects
with the uniform 401 (`reason=fixture_conflict`) rather than minting into a
real account.

### 4.3 Server composition — `createApp` and the allowlist

`CreateAppOptions.e2eDoor?: E2eDoorDeps` — present only on a non-production
server holding `E2E_SESSION_DOOR_SECRET`; `buildE2eDoorDeps` returns `null`
otherwise. Pairing check, matching the eleven that already exist:
`if (options.e2eDoor && !options.auth) throw new Error(...)` — door-without-auth
is a wiring bug, rejected at construction like every other surface.

**Allowlist:** the exported `PUBLIC_ALLOWLIST` constant is **not** modified
(`app.test.ts:50` pins `size === 5`, and prod's public surface genuinely
stays at 5). The effective set handed to `createRequireAuth` is built
per-app: `PUBLIC_ALLOWLIST ∪ { "POST <API_BASE>/auth/e2e/session" }` only
when `options.e2eDoor` is present. Without this the door is 401'd by
`requireAuth` before the handler runs — which is, amusingly, the same
response as a failure, so the failure mode is safe, but the door would never
work.

### 4.4 Relationship to the refresh-token family model

**The door introduces zero new token code.** It calls
`createSessionWithTokens(db, { userId, device, signer, now })` — the
identical call `completeSignIn` makes. Every session invariant (one
`auth_sessions` row per call, hash-only refresh persistence, rotation, reuse
= family revoke, logout/session-list/session-revoke) holds because it is the
same code path, not a re-implementation. This is pinned by T3's db-test, not
merely asserted: mint via the door, rotate once, replay the original token,
expect the family revoked — the same assertion `tokens-routes.db.test.ts`
already makes for a real sign-in.

### 4.5 Mobile — the door module and its route

New feature dir `apps/mobile/src/features/dev/e2e-door/` (sits beside
`features/dev/diagnostics`, the established dev-surface home).
`openSessionDoor` is a **pure function over injected deps** (`api`,
`resetLocalSession`, `applySignIn`, an injectable `secret`) — no store
import, no module singletons — so every branch (disabled, 401, network
throw, success) is unit-testable without a router or a query client. The
route file (`apps/mobile/src/app/(auth)/e2e-session.tsx`) does the wiring,
following the `(auth)/diagnostics.tsx` pattern exactly:

- Gate off: `<View style={{ flex: 1 }} testID="e2e-session-screen-inert" />`.
  The `flex: 1` is load-bearing and must be pinned by a test — a zero-frame
  view is excluded from the XCUITest accessibility hierarchy outright, so
  `assertVisible` can never see it (the trap that cost PR #61 a full device
  round).
- Gate on: exactly one state marker at a time, each `style={{ flex: 1 }}`:
  `e2e-session-pending`, then `e2e-session-ready` or `e2e-session-error`. No
  text, no `user_key` rendered — nothing identifying on screen or in a
  screenshot artifact.
- Params via `useLocalSearchParams<{ user_key?: string; first_run?: string }>()`.
  `user_key` missing means `"default"`. `first_run === "true"` means `true`.
- **Ordering (R-door-8), this order exactly:** (1) wait for
  `useSessionStore(s => s.hydrated)` — otherwise boot hydration from a stale
  Keychain refresh token races the mint and can end up the **last** writer of
  `accessToken` / `user`; (2) `await resetLocalSession()` — the real
  `signOut()`, which clears the query cache, tab memory, last-viewed trip,
  money-segment memory, deeplink-return and settle-return records, and the
  per-trip last-zone map — skipping it leaks the previous run's account state
  into the flow, the exact Law-#3 class this repo has fixed five separate
  times; (3) `await openSessionDoor(...)`, then `applySignIn(response)`; (4)
  **do not navigate** — `AuthGate`'s `resume` branch (`authed && inAuthGroup`)
  fires `router.replace(dest ?? "/")` on the next effect cycle and takes the
  app out of `(auth)` by itself.

### 4.6 Deep-link path — no registry change needed

`parseDeepLink` returns `PASSTHROUGH` for a custom-scheme path whose first
segment is neither `invite` nor `t`, and `+native-intent.tsx` returns the
original path for passthrough (query string intact). So
`gogo://e2e-session?user_key=x&first_run=false` routes straight to
`(auth)/e2e-session.tsx` — the same mechanism `gogo://diagnostics` already
uses. `deep-links.ts`, `+native-intent.tsx` and `app.json` are **not**
modified. Use a single hyphenated segment (`e2e-session`), **not**
`gogo://e2e/session` — two segments would not match the route file.

### 4.7 testID additions (navigation.spec §2.7 grammar)

Screen name `e2e-session`; root `e2e-session-screen` (rule 2); markers
`e2e-session-screen-inert` (mirrors `diagnostics-screen-inert`),
`e2e-session-pending`, `e2e-session-ready`, `e2e-session-error`. None are
interactive, so the R-nav-22 lint gate is satisfied by construction. See the
rule-7 sync line added to `.specs/client/navigation.spec.md` §2.7 (T1).

---

## 5. Approach — entry mechanism, two builds, and the flow shape

### 5.1 Entry mechanism: deep link (decided)

`gogo://e2e-session?...` via Maestro `openLink` on a Release build. Works
cold and black-box; needs no native code, no registry change, no new
dependency; reuses the exact mechanism `smoke-diagnostics-cold` already
proves on device. Rejected alternatives: a diagnostics-panel control
(disqualified on fact — `(auth)/diagnostics.tsx` is `__DEV__`-gated and inert
on Release, so the panel does not exist on the lane's build); an
env-seeded token at launch (needs a native module to surface iOS launch
arguments to JS, plus something outside the app to call the server first —
strictly more moving parts for the same result).

### 5.2 Two builds, and why (decided, §8 Q1 option (a))

The lane needs a door build; the security claim needs a door-free build.
Both are Release configuration, Hermes, embedded bundle, `__DEV__ === false`
— the only difference is the inlined secret:

```bash
# door-free (App-Store-shaped) - flows 1-4 + session-door-absent
cd apps/mobile && LANG=en_US.UTF-8 npx expo run:ios --configuration Release

# door build - flows 5-10
cd apps/mobile && EXPO_PUBLIC_E2E_DOOR_SECRET="..." LANG=en_US.UTF-8 npx expo run:ios --configuration Release
```

**Decided cadence:** the door-free build + `session-door-absent` run on every
PR that touches door code (server gate, client gate, the route, or the
descriptor) and at each phase close. The default merge gate stays one build
(the door build) — running the door-free proof on every merge gate would
roughly double the gate's wall time for a claim that only changes when door
code changes.

### 5.3 The reusable subflow — `.maestro/subflows/session-door.yaml` (T5)

The interface flows 6–10 consume, written out in full in the design doc so no
further design work is needed at T5. `launchApp` with `clearState` AND
`clearKeychain` first (the refresh token lives in the iOS Keychain, which
`clearState` alone does not wipe), then `stopApp` so `openLink` is genuinely
cold, then `openLink: gogo://e2e-session?user_key=${USER_KEY}&first_run=${FIRST_RUN}`.
The terminal barrier is `notVisible: e2e-session-screen`, not
`visible: e2e-session-ready` — on success `AuthGate`'s resume branch replaces
out of `(auth)` on the very next effect cycle, so `ready` can unmount before
Maestro's poll sees it. On failure the screen stays, showing
`e2e-session-error`, and the barrier goes red.

### 5.4 Fixture-user state across runs (decided, §8 Q3 option (a))

**Unique `user_key` per run**, `<flow>-${RUN_ID}`, no destructive reset.
Every run starts from a virgin user, so flows are deterministic with no reset
primitive needed. The runner (T5, `scripts/e2e.sh`) generates
`RUN_ID="$STAMP"` (it already computes `STAMP`) and passes `-e RUN_ID="$RUN_ID"`
on every invocation; no secret is ever passed to Maestro. Cost, accepted:
the local dev DB accumulates fixture users; cleaning means dropping and
re-migrating the dev DB. **Rejected: a `reset: true` request field that
deletes the fixture user's trips** — that puts a destructive data operation
behind the secret (Autonomy trigger #5 territory) and is not specified here.
The door SHALL NOT delete or reset any data, ever (this is permanent, not a
placeholder for a future task).

---

## 6. Review pipeline

Sean's condition: **security lane mandatory, non-negotiable.** The panel for
diffs against this spec, per `.claude/rules/review.md`'s path-to-specialist
map:

- **security** (mandatory) — owns §3 in full: the gates (including G5), the
  indistinguishability contract, the timing-safe comparison, the
  fixture-identity guard, log hygiene, and the prod boot refusal. Must
  independently execute the server mutation-verify probes rather than
  reading the claim.
- **correctness** — owns the CI gate run and the testcontainer suite (T3).
- **tests** — owns matrix completeness and the vacuous-pin taxonomy (the
  in-flight deferred promise, the `flex: 1` style pin, `git add -N .` before
  diff probes on new files).
- **mobile** — owns the Release / `__DEV__` reasoning and the `AuthGate`
  interaction (T4).

Reviewers are read-only. Fix verification goes to `fix-verifier`, never the
implementer.

---

## 7. What the door must never do

Stated once, plainly, because it is the thing every other requirement above
protects:

- Never be reachable on a production server, even misconfigured (§3.2 G4,
  §3.8).
- Never return a response distinguishable from "this path does not exist"
  for any failure mode (§3.6, R-door-3).
- Never carry its secret in a URL, a deep link, or any durable evidence
  artifact (§3.5, R-door-7).
- Never log the secret, a token, or a fixture email (§3.7, R-door-6).
- Never delete, reset, or mutate any data beyond find-or-create of its own
  `e2e:`-prefixed fixture rows (§5.4).
- Never introduce a new token-issuance code path — it rides the exact rails
  a real sign-in uses (§4.4, R-door-4).
- Never accept a request from a non-loopback, non-private host, even with a
  correct secret (§3.2 G5, decided §8 Q4).
- Never widen `apps/server/src/app.ts`'s exported `PUBLIC_ALLOWLIST` constant
  or change its pinned size (§4.3).
