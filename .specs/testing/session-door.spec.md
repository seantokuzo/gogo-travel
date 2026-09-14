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

- **R-door-1 (server triple gate, positive opt-in):** WHEN the server boots
  THE SYSTEM SHALL mount `POST /auth/e2e/session` only if ALL of: (a)
  `process.env.NODE_ENV` was **explicitly provided** and is `development` or
  `test` — a defaulted/absent `NODE_ENV` SHALL NOT satisfy this condition;
  (b) `E2E_SESSION_DOOR_SECRET` is set and >= 32 chars; (c)
  `E2E_SESSION_DOOR=1` is set explicitly. Otherwise the route SHALL NOT
  exist. (Review round 1, B3: closes the "hosted deploy forgets to set
  `NODE_ENV`" hole — see §3.8. `env.ts` exposes condition (a) cheaply as
  `NODE_ENV_EXPLICIT: z.boolean()`, derived in `loadEnv` from
  `source.NODE_ENV !== undefined`, keeping `loadEnv()` the only
  `process.env` reader per `.claude/rules/server.md`.)
- **R-door-2 (fail closed in production):** WHEN `NODE_ENV` is `production`
  AND (`E2E_SESSION_DOOR_SECRET` is set OR `E2E_SESSION_DOOR` is set) THE
  SYSTEM SHALL refuse to boot with an error naming the offending variable(s)
  and never a value.
- **R-door-3 (no oracle):** WHEN a request to `POST /auth/e2e/session` fails
  for any reason — route absent, wrong secret, disallowed or unresolvable
  request peer, malformed body, oversized body, ineligible fixture row, rate
  limited — THE SYSTEM SHALL return the identical `401 UNAUTHENTICATED`
  envelope an unauthenticated request to an unknown path returns, and SHALL
  record the real reason only in the server log with the `requestId`.
  (Review round 1, B4: "oversized body" and "disallowed or unresolvable
  request peer" were added to the enumeration — see §3.6's body-size-ordering
  note and R-door-11.)
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
- **R-door-7 (client build gate + local-destination gate):** THE SYSTEM
  SHALL open the client door only when `EXPO_PUBLIC_E2E_DOOR_SECRET` was
  inlined at build time with at least 32 characters **AND** the resolved API
  base URL's host satisfies `isLocalOrPrivateHost`
  (`apps/mobile/src/auth/config.ts:28` — currently module-private; T4 SHALL
  add `export` to it so the door module can import the same predicate the
  rest of the client already trusts, rather than duplicating the host list).
  A build failing either condition SHALL
  render an inert, non-zero-framed marker at `gogo://e2e-session` and SHALL
  issue no network request; the secret SHALL NEVER be transmitted to a
  non-local host. (Review round 1, B5 scenario A: the build-inlined secret
  must not leave the rig over the wire just because the same build was later
  pointed at a hosted API base.)
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
- **R-door-11 (request peer gate):** WHEN the door receives a request THE
  SYSTEM SHALL derive the caller address from the **socket peer** (`clientIp`
  / `getConnInfo(c).remote.address`, `apps/server/src/http/rate-limit.ts:137`)
  — NEVER from the `Host`, `X-Forwarded-For`, `X-Real-IP`, or `Forwarded`
  headers — and SHALL reject with the uniform 401 unless the peer, after
  normalisation (stripping an IPv4-mapped IPv6 prefix `::ffff:` and bracket
  forms `[::1]` → `::1`), is IPv4/IPv6 loopback (`127.0.0.0/8`, `::1`) or a
  private range (RFC-1918, ULA `fc00::/7`), evaluated before the secret
  comparison and before any database access. `0.0.0.0`, link-local addresses,
  and any name-based match (`.local` or otherwise) SHALL be rejected. An
  unresolvable peer (including the `"unknown"` value `clientIp` returns when
  there is no socket, e.g. under `app.request()`) SHALL be treated as
  **disallowed**. The peer resolver SHALL be injectable
  (`peerOf?: (c) => string | null`, defaulting to `clientIp`) so tests can
  drive both the allowed and disallowed sides without a real socket. (Review
  round 1, B1: replaces the original `Host`-header predicate, which an
  attacker fully controls. Defense-in-depth relative to R-door-1 — see §3.8.)
  **Implementation location (review round 1, adversarial-verifier F3):**
  this is a **new, server-only** predicate — `isLoopbackOrPrivatePeer(addr:
string): boolean` — co-located with `clientIp` in
  `apps/server/src/http/rate-limit.ts`. It SHALL NOT import
  `apps/mobile/src/auth/config.ts`'s `isLocalOrPrivateHost`: that function is
  (a) unexported, (b) lives in a different app with no import path from
  `apps/server`, and (c) checks a client-chosen **hostname** (`.local`
  included) rather than an **IP-literal socket peer** — a different trust
  boundary and a different input shape entirely. The two predicates share no
  code by design; R-door-7's client-side check and R-door-11's server-side
  check are independent implementations of the same policy on opposite sides
  of the trust boundary.
- **R-door-12 (constant-time secret):** WHEN the door compares the presented
  secret THE SYSTEM SHALL compare SHA-256 digests with
  `crypto.timingSafeEqual` and SHALL NOT use `===`, `==`, `.localeCompare`,
  or any short-circuiting comparison. (Review round 1, B2: promotes §3.5's
  prose-only comparison method to a normative, test-obligated requirement.)
- **R-door-13 (constant-work floor, SHOULD):** WHEN the door rejects a
  request for any reason THE SYSTEM SHOULD perform the same
  SHA-256-digest-and-`timingSafeEqual` work it performs on a valid attempt —
  including when the route is not mounted (a fixed-cost dummy comparison) or
  the body fails to parse — so response latency does not reveal whether the
  route exists. Advisory strength (SHOULD, not SHALL): closes the review
  round 1 A2 timing side-channel but is not required for the primary
  security property, since R-door-1's positive opt-in and R-door-11's peer
  gate already prevent exploitation without both a deliberately-configured
  rig and network access to it.
- **R-door-14 (fixture cap):** WHEN a find-or-create for a new `user_key`
  would create the **N+1**th distinct `e2e:`-prefixed fixture user on the
  server (N = `E2E_DOOR_MAX_FIXTURE_USERS`, a boot constant defaulting to
  **500**) THE SYSTEM SHALL reject with the uniform 401
  (`reason=fixture_cap`) instead of creating the row; lookups of **already
  existing** keys are unaffected. The wire response SHALL stay byte-identical
  to every other rejection (R-door-3) — no field, header, or status leaks the
  cap to the client — but the server SHALL additionally emit a log line
  distinguishable from every other rejection reason, same
  `[auth] e2e door rejected (requestId=..., reason=...)` shape §3.6 already
  requires, with `reason=fixture_cap` plus the current count and the
  configured max, so an operator debugging a stalled lane can tell "the cap
  is hit" apart from "the secret is wrong" from server logs alone, without
  the wire contract moving at all. This is a bounded escape hatch, not a
  reset — it never deletes a row, and it is not reachable through the door
  (see §5.4's fixture-cleanup note, now a **mandatory T3 deliverable**, not a
  someday script). (Review round 1, A3; review round 2 adds the log-line and
  T3-deliverable clauses — a cap with no distinguishable signal and no
  scheduled cleanup owner stalls the lane silently after roughly 80 runs with
  no way to tell why, see §5.4.)
- **R-door-15 (E2E runner/flow app-id parameterization, review round 2,
  revised round 3 — lane-scoped defaults):** THE SYSTEM SHALL NOT hard-code
  a single bundle identifier for every lane in `scripts/e2e.sh` or in any
  `.maestro/**/*.yaml` flow's `appId:` field — there is no one hard-coded
  default; each lane resolves its own, and every lane's default is
  env-overridable. `scripts/e2e.sh` SHALL accept a `--variant
door|dev|doorfree` flag selecting which lane's default applies. When
  `--variant` is omitted the runner SHALL derive it from the existing
  `--tags` selection: `--tags dev` (today's dev-build-only filter) implies
  `dev`; every other invocation — including the default, no-flag run, which
  is today's default merge-gate cadence (§5.2) — implies `door`. The runner
  SHALL NOT derive `doorfree` from `--tags`/`--flow`: the periodic door-free
  proof (`session-door-absent`, §5.2) selects the **same** default tag
  filter as the door lane (both exclude only `dev`) and differs _only_ in
  which build is installed, so a caller running that proof SHALL pass
  `--variant doorfree` explicitly (or set `GOGO_E2E_APP_ID` directly). Each
  variant's default app id:

  - `door` (default merge gate, §5.2) → `app.gogotravel.e2edoor`
  - `dev` (`--tags dev`, Debug build, flow AUTHORING only) → `app.gogotravel`
  - `doorfree` (the periodic door-free proof) → `app.gogotravel`

  `GOGO_E2E_APP_ID` (operator-settable, the same override pattern as
  `MAESTRO_EXPECTED_VERSION`/`--device`), when set, SHALL override the
  `--variant`-derived default outright, for any variant. Every flow's
  `appId:` field SHALL read `${APP_ID}` — Maestro's own env-var
  substitution, the documented pattern for a cross-build app id (`appId:
${APP_ID}` in the flow, `-e APP_ID=<value>`/`--env APP_ID=<value>` on the
  CLI) — rather than a literal, with the runner injecting the resolved
  value via `-e APP_ID=<value>` on the `maestro test` invocation it already
  builds. The existing installed-app check (`scripts/e2e.sh:168`) SHALL run
  against the resolved value instead of the literal, so it doubles as the
  runner's own lane self-check: an install of the wrong variant fails this
  check by construction (the resolved id is simply not what is installed),
  and the `die()` message SHALL name both the resolved id and the active
  `--variant`, not a fixed string, so a wrong-variant run is diagnosable
  from the failure text alone.

  (Review round 2: the previous hard-coded `app.gogotravel` in both the
  script and all seven flow files contradicted §5.2's own default-cadence
  decision — see §5.2. Review round 3, fix-verifier round 2: round 2's
  single **global** default of `app.gogotravel.e2edoor` silently broke the
  `dev` lane — `bash scripts/e2e.sh --tags dev` runs against a Debug build
  whose id is the un-suffixed `app.gogotravel`
  (`.maestro/diagnostics-panel-dev.yaml`), so it would resolve `.e2edoor`,
  find nothing installed, and `die()` on every dev-lane run — and the
  requirement's own first two sentences self-contradicted, hard-coding
  `.e2edoor` as THE default in the same breath as forbidding hard-coding a
  bundle id. Fixed by making the default **lane-specific** instead of
  global, per above: no single hard-coded id, only lane defaults, every one
  overridable.)

- **R-door-16 (third client gate: installed bundle id, review round 1 B1
  hardening):** THE SYSTEM SHALL open the client door ONLY when, in addition
  to R-door-7's two conditions, the REAL installed bundle id (read via
  `expo-application`'s `applicationId` at runtime — NOT a value derived from
  the app config, which reflects what was CONFIGURED rather than what was
  actually prebuilt/archived) carries the `.e2edoor` suffix `app.config.ts`'s
  `withDoorVariant` appends. This closes the process-failure path where a
  build recipe skips `expo prebuild` (§5.2) and produces a binary that
  carries the build-inlined secret and a local API base but still wears the
  SHIPPING `CFBundleIdentifier` — R-door-7's two conditions alone cannot
  detect that case, since neither depends on what was actually prebuilt.
  Additionally, THE build recipe SHALL make a prebuild non-optional on every
  door/door-free build (`apps/mobile/package.json`'s `ios:door` /
  `ios:doorfree` scripts, §5.2) rather than relying on operator discipline.

### 2.1 Test obligations (review round 1, B2)

No requirement above is satisfied by a reading of the code; each is
satisfied by a test that T3, T4, or T5 ships in the same commit as the
behavior — T5 for R-door-10 alone, since its behavior lives in
`scripts/e2e.sh` rather than the door route or the mobile entry surface.
This table is the floor, not the ceiling — ordinary matrix coverage
(happy/error/boundary/adversarial per `.claude/rules/testing.md`) still
applies on top.

| Requirement | Test obligation (at minimum)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-door-1    | Mount matrix crossing `NODE_ENV` (unset/defaulted, misspelled e.g. `"Production"`, `production`, explicit `development`, explicit `test`) × `E2E_SESSION_DOOR` (unset, `"1"`) × secret (absent, 31 chars, 32+ chars). Only the all-pass cell mounts the route; every other cell does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-door-2    | `NODE_ENV=production` + secret set, and separately + `E2E_SESSION_DOOR=1` set with no secret — both throw at `loadEnv()`; assert the thrown message contains the variable NAME(s) and never a value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R-door-3    | For every failure mode — route absent, secret wrong, secret prefix-correct-but-wrong (e.g. right length, one byte off), disallowed peer, unresolvable (`"unknown"`) peer, malformed body, oversized body (over `BODY_LIMIT_MAX_BYTES`), ineligible fixture row (`google_sub` set / `deleted_at` set), rate-limited, a replayed/reused secret across calls — assert byte-identical status, body, and header set against a request to an unmounted/unknown path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R-door-4    | Mint via the door → rotate once → replay the original refresh token → assert the token family is revoked (mirrors the real-sign-in assertion in `tokens-routes.db.test.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R-door-5    | A row matching `apple_sub = e2e:K` that instead carries a `google_sub`, and separately one with a non-null `deleted_at`, are both rejected with `reason=fixture_conflict` and the uniform 401.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R-door-6    | A mint call's log output — the server log line the fixture-cap/rejection lines already use, and anything Maestro's `commands.json`/`maestro.log` could capture from a live door call — is asserted to never contain the raw `E2E_SESSION_DOOR_SECRET` value, the minted access or refresh token strings, or the fixture email; only `requestId`, `sessionId`, `user_key`, and the created-vs-found boolean appear. Separately, the boot-time warning string is asserted ASCII-only and to name the route path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R-door-7    | `https://api.<prod-host>` as the resolved API base is pinned inert-with-no-request (spy the injected `api`, assert zero calls); a local/private base with the secret inlined issues the request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R-door-8    | Run the door flow once for `user_key` K with the session store, secure-store refresh token, query cache, tab memory, last-viewed trip, money-segment memory, deeplink-return/settle-return records, and last-zone map all populated from a prior sign-in; run it again for the SAME `user_key`; assert every one of those is back at its cold-boot empty value before the run-2 session is applied — a second run does not inherit run-1's local state. Separately pin the ordering itself (§4.5): `resetLocalSession` is called and its promise awaited strictly before `openSessionDoor` is invoked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R-door-9    | The 21st call from one peer inside a fake-clock minute gets the same uniform 401 with **no** `Retry-After` header present (not a `429`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R-door-10   | **T5 obligation** (its behavior lives in `scripts/e2e.sh`, not T3/T4): with `HOME` pointed at a fake directory, run a completed lane and assert the JUnit report and the run's artifact directory are copied to a directory outside the repo worktree created with mode `0700`, and that the script prints that directory's path, the copied JUnit path, and the run's `~/.maestro/tests/<ts>/maestro.log` path; separately, force the copy to fail (an unwritable or missing destination parent) and assert the script exits non-zero and prints no success line. `scripts/e2e.sh` has no existing automated test harness in this repo; T5 SHALL add one (a child-process-driven script test is sufficient) rather than leave this pinned only by manual inspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R-door-11   | Peer `127.0.0.1` / `::1` → allowed; `::ffff:10.0.0.5` (normalised to a private address) → allowed; a public peer → 401; peer `"unknown"` (the `app.request()` default) → 401; a spoofed `Host: 127.0.0.1` header from an injected non-loopback peer → 401 (proves the header is ignored). Separately, unit-pin `isLoopbackOrPrivatePeer` directly (no `app.request()` needed): `127.0.0.1`, `::1`, `10.0.0.1`, `172.16.0.1`, `192.168.0.1`, `fc00::1`, `::ffff:10.0.0.5`, `[::1]` → `true`; `8.8.8.8`, `0.0.0.0`, `169.254.0.1`, `fe80::1`, `"unknown"`, `""`, `null` → `false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R-door-12   | Mutation-verify: swap `timingSafeEqual` for `===` in the door's compare and confirm a pin goes RED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R-door-14   | With `E2E_DOOR_MAX_FIXTURE_USERS` set low (e.g. 2) via test config, the 3rd distinct `user_key` is rejected with the uniform 401 while the first 2 keys still resolve; no existing row is touched; the rejection's wire response is byte-identical to every other 401 (folded into R-door-3) while its server log line carries `reason=fixture_cap`, distinguishable from a `reason=secret_mismatch` log line for the same request shape. Separately (T3, `scripts/e2e-cleanup.mjs`): running cleanup against a mixed set — `e2e:`-prefixed fixture users plus a real, non-`e2e:` user who owns a trip — removes only the `e2e:`-prefixed rows and their owned trips/memberships, leaves the real user and trip untouched, and afterward a find-or-create for a previously-capped key succeeds again (proves capacity was actually freed, not just rows renamed). (Review round 3, §5.4 ordering:) a trip with one `e2e:`-prefixed owner and one real, non-`e2e:` member survives cleanup byte-for-byte untouched and the fixture owner is logged skipped (not deleted, not retried) — the mixed-membership skip; a trip whose members are ALL `e2e:`-prefixed (the flows 6-10 shape, owner + at least one other fixture member) is deleted in step 1 and every fixture that was on it is freed — the multi-fixture-member trip case; and a fixture user whose step-3 `deleteAccount` call transiently loses a race with a step-1 trip delete still in flight succeeds on the retry pass with no operator action — the retry pass. The trip-delete core extraction (§5.4 step 1) SHALL leave `DELETE /trips/:tripId`'s existing test suite green with no behavior change, and the cleanup test SHALL exercise the extracted core directly (in-process, not via HTTP) rather than re-testing the route. |
| R-door-15   | Lane-default matrix: the default invocation (no `--variant`, no `--tags dev`) resolves `app.gogotravel.e2edoor`; `--tags dev` with no explicit `--variant` resolves `app.gogotravel`; `--variant doorfree` resolves `app.gogotravel`; `GOGO_E2E_APP_ID` set explicitly overrides every lane's default, including `door` and `dev`. Mismatch: run any variant against a simulator with the wrong app id installed and assert `scripts/e2e.sh:168`'s check hard-fails with a named, non-generic `die()` message — the text names both the resolved app id and the active `--variant`, not a fixed string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R-door-16   | Unit-pin `isDoorBundleId` directly: a `.e2edoor`-suffixed id -> door build; the bare shipping id -> not; `null`/`undefined` (web, or the module unavailable) -> not; the real default reads `expo-application`, mocked both ways. Integration: `openSessionDoor` and the route's render gate each pinned with the OTHER two R-door-7 conditions satisfied and ONLY the bundle id wrong -> `disabled`/inert, zero network calls -- proves the third gate is independently effective, not redundant with the other two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Test-design note, recorded not required (review round 1, A5/Finding 10):**
under `app.request()` every in-process request shares the same unresolvable
`"unknown"` peer. Combined with R-door-9's per-peer rate limit, this means
every in-process door test in one suite file shares **one** rate-limit
bucket keyed on `"unknown"`. A suite that calls the door route more than 20
times against a fake clock inside one simulated minute will start 401-ing
for reasons unrelated to what it asserts. T3's suite SHALL either inject
distinct peers per test case (via R-door-11's injectable resolver) or
reset/advance the rate-limit store between cases that are not themselves
testing R-door-9.

**Test-design note, recorded not required (review round 2, A5 residual):** a
warm-authed door open — `gogo://e2e-session` opened while the app already
has a live session, rather than from a cold, signed-out start — is not a
supported lane path; every default Maestro flow (§5.1) begins from
`clearState`/a signed-out simulator, so T4's `AuthGate` redirect handling is
not required to special-case a warm-authed open, and no test is required to
cover it.

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

| #                    | Side   | Gate                                | Allowed value                                                                                                                                                                                                                                                             | Default                                                  |
| -------------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **G0 (added, R2)**   | server | `E2E_SESSION_DOOR`                  | must be **explicitly** `1`; anything else (including absent) means the route is not mounted                                                                                                                                                                               | absent                                                   |
| **G1 (revised, R2)** | server | `NODE_ENV`                          | must be **explicitly provided** (not defaulted) and `development` or `test` (enum stays `development` / `test` / `production` — see §3.3)                                                                                                                                 | absent/defaulted ⇒ fails this gate                       |
| G2                   | server | `E2E_SESSION_DOOR_SECRET`           | string, **>=32 chars**; absent means the route is not mounted                                                                                                                                                                                                             | absent                                                   |
| G3                   | client | `EXPO_PUBLIC_E2E_DOOR_SECRET`       | string, **>=32 chars**, inlined by Metro at build time; absent means the door module never issues a request and the route renders an inert marker                                                                                                                         | absent                                                   |
| **G4 (revised, R2)** | server | boot refusal                        | `NODE_ENV === "production"` **AND** (G2 set OR G0 set) means `loadEnv()` throws, so the process never reaches `serve()`                                                                                                                                                   | —                                                        |
| **G5 (revised, R2)** | server | **request peer** (defense-in-depth) | the **socket peer** (never a header) SHALL be loopback or private-range per the new server-side `isLoopbackOrPrivatePeer` predicate, normalised for IPv4-mapped/bracketed forms (R-door-11); the door SHALL reject with the uniform 401 otherwise, regardless of G0/G1/G2 | n/a — enforced unconditionally when the route is mounted |

The door exists only at `G0 AND G1 AND G2 AND G5` on the server and only
works at `G0 AND G1 AND G2 AND G3 AND G5` end to end.

**G5 was revised in review round 1 (B1/B3).** The original draft evaluated
the request `Host` header against the same loopback/RFC-1918/`.local`
predicate the client uses for its cleartext-transport guard
(`apps/mobile/src/auth/config.ts`). That header is attacker-controlled — a
`Host: 127.0.0.1` line in a curl request passes the predicate from anywhere
on the internet — and, separately, `apps/server` has no import path to
`apps/mobile` at all (different deployables) even had that predicate stayed
exported (adversarial-verifier F3, round 1) — so G5 now reads the **socket
peer** through its own, server-only predicate (R-door-11's
`isLoopbackOrPrivatePeer`, never a cross-app import), and is
**defense-in-depth**, not the primary closure of the
"forgot to configure anything" deploy risk. That closure is now G0+G1
(R-door-1): the door requires `E2E_SESSION_DOOR=1` and an explicitly
provided `NODE_ENV`, so a server that never had either variable touched
never mounts the route, full stop, independent of what network it is
reachable from. See §3.8 for why G5 alone is insufficient behind a reverse
proxy. A physical-device rig on the LAN still works (RFC-1918 peers are
allowed); a tunnelled rig (ngrok and friends) needs a deliberate override,
out of scope for T1–T4.

Nothing in the repo, in `.env.example`, in `app.json`, or in any default
build command sets G2 or G3. Both come from `scripts/gen-test-env.mjs`, which
writes to the **gitignored** `apps/server/.env.test` (mode 600) — the same
throwaway-material pattern T-S3.1 already established for the 8 auth vars.

### 3.3 Why not `NODE_ENV="e2e"`

Sean's "if we want to be more targeted" is served by G0 (`E2E_SESSION_DOOR`)
and G2 (the secret), not by a new `NODE_ENV` value. `apps/server/src/env.ts` pins
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
- `env.ts` **defaults `NODE_ENV` to `development`** when the var is absent —
  but G1 (R-door-1) now requires `NODE_ENV` to be **explicitly** provided, so
  a hosted environment that forgets to set it fails G1 outright and never
  reaches G0/G2. (Review round 1, B3: before that fix, G1 accepted the
  default, and only the secret — plus a since-revised, header-based G5 —
  held; see §3.8.)
- A preview/staging deploy that inherits a **whole** rig env file — where
  `NODE_ENV=development`, `E2E_SESSION_DOOR=1`, and the secret are all
  present because they were copied wholesale — passes G0 and G1 regardless.
  The secret (G2) is what holds in that specific case; G5 is a second line
  behind it.

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

1. `200` + `SignInResponse` — secret correct, door mounted, peer allowed
   (G5), not rate-limited.
2. `401` + the identical `UNAUTHENTICATED` envelope
   (`apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE)`) for **every**
   other outcome: route not mounted (`requireAuth`'s own 401 fires), wrong
   secret, disallowed or unresolvable request peer, malformed body, oversized
   body, bad `user_key` shape, ineligible fixture row, rate limited.

This deliberately **deviates from `rejectInvalidBody`** (which the rest of
the server uses to return `400 VALIDATION_FAILED`): a 400 would prove the
route exists, which is exactly the oracle `auth-users.spec.md` §3.6.4 forbids.
The route's `zValidator` hook returns the uniform 401 instead. Same reason
there is no `Retry-After` on the rate-limit path.

The real reason is logged server-side with the `requestId` — that is how a
misconfigured rig gets debugged:
`[auth] e2e door rejected (requestId=..., reason=secret_mismatch)`.

**Body-size ordering (review round 1, B4).** `apps/server/src/app.ts` mounts
`createRequireAuth` (`:198`) before the app-wide `bodyLimit` (`:213`) —
deliberately, per the ordering comment at `:204-210` and the pin at
`app.test.ts:297` ("an oversized UNAUTHENTICATED body is the uniform 401,
never a 413 oracle"). That ordering means a request to an **allowlisted**
path — which the door path becomes once mounted (§4.3) — sails past
`requireAuth` and hits the app-wide `bodyLimit`, which answers with `413
PAYLOAD_TOO_LARGE`. A `413` on the door path and a `401` on an unrecognised
path is exactly the oracle this section forbids: it tells an attacker the
route exists without ever guessing the secret. The door router SHALL
therefore mount its **own** body guard, evaluated **before** the app-wide
`bodyLimit` can observe the request — a per-route `bodyLimit` whose
`onError` returns `apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE)`
(never `PAYLOAD_TOO_LARGE`), capped at or below `BODY_LIMIT_MAX_BYTES`
(`apps/server/src/config.ts:371`). A test SHALL assert that an oversized
body to the door path and an oversized body to an unknown path produce
byte-identical status, body, and header sets (folded into R-door-3).

### 3.7 Rate limit + audit posture

- **Rate limit** (new `RATE_LIMITS.e2eDoor`, `apps/server/src/config.ts`):
  **20/min and 200/day per IP**, keyed with the same peer resolver R-door-11
  uses (never `X-Forwarded-For` — `.claude/rules/server.md`). Sized off the
  measured lane: PR #61's four-flow release run took 178.188 s, i.e. roughly
  one door call per 30 s; 20/min leaves headroom for `--flow`-loop authoring
  without leaving a secret-grinding surface open. Deliberately not reusing
  `RATE_LIMITS.signIn` (10/min) — a tight authoring loop would trip it.
  **The door does NOT mount the generic `rateLimit([...])` middleware**
  (review round 1, A1) — that middleware's only rejection is `429
RATE_LIMITED` plus a `Retry-After` header, which would itself be a
  door-exists oracle and a direct R-door-3/R-door-9 violation. Instead the
  handler charges the rate-limit store directly
  (`deps.store.hit("e2eDoor:" + peer, ...)`) and, on a limit hit, falls
  through to the exact same uniform 401 every other failure mode returns —
  own bucket, no `429`, no `Retry-After`, ever.
- **Constant-work floor** (R-door-13, SHOULD, review round 1 A2): perform the
  digest-compare-and-`timingSafeEqual` work on every rejection path —
  including a fixed-cost dummy comparison when the route would not even be
  mounted, and when the body fails to parse — so response latency does not
  additionally reveal whether the door exists on a quiet host.
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

Five layers, in order of firing:

1. **G4 / `loadEnv` throws.** A cross-field check in `EnvSchema`
   (`superRefine`): `NODE_ENV === "production" && (E2E_SESSION_DOOR_SECRET !== undefined || E2E_SESSION_DOOR !== undefined)`
   yields `Invalid environment configuration - E2E_SESSION_DOOR_SECRET (or E2E_SESSION_DOOR): must not be set when NODE_ENV is production`.
   `loadEnv()` is called at the top of `index.ts` before anything else, and
   it reports **names only, never values** — keep that. The process exits
   non-zero; the deploy's health check never goes green; the platform rolls
   back. It does **not** "ignore the variable and carry on", because a server
   that silently drops a security-relevant config value teaches operators
   that the value is inert.
2. **G0/G1 positive opt-in.** Even outside `production`, the route mounts
   only if `E2E_SESSION_DOOR=1` was explicitly set AND `NODE_ENV` was
   explicitly provided as `development` or `test`. A server that never had
   either variable touched — which is every server that did not deliberately
   opt in — never reaches layer 3, regardless of what `NODE_ENV` defaults to
   or what network it sits on. This is the layer that actually closes the
   "forgot to configure anything" deploy risk (see Residual risk below).
3. **Router builder returns `null`.** Even if layers 1–2 were bypassed (a
   future caller constructing `Env` by hand), `buildE2eDoorDeps(env)` returns
   `null` unless G0 AND G1 AND G2 all hold. `createApp` mounts nothing for
   `null`.
4. **G5 peer check (defense-in-depth).** Even if layers 1–3 were bypassed (a
   future caller mounting the router directly), every request the handler
   sees is still checked against the loopback/RFC-1918/ULA **socket peer**
   before anything else runs, and rejected with the uniform 401 otherwise.
5. **Client.** A build without G3, or whose resolved API base is not
   local/private (R-door-7), renders `e2e-session-screen-inert` and issues no
   request.

**Residual risk, named — and NOT fully closed by G5 (review round 1, B3):**
the risk this section originally worried about was a production deploy that
forgets `NODE_ENV` entirely, which defaults to `development` and clears the
old G1. **G0/G1's positive opt-in closes that risk directly** — a server
that never had `E2E_SESSION_DOOR=1` and an explicit `NODE_ENV` set never
mounts the route, independent of any default. G5 is retained as a second
line, but it is **not** sufficient on its own behind the deploy topology
this app actually uses: a container behind a reverse proxy or load balancer
(Fly, Render, ECS, k8s — every realistic host for this stack) sees the proxy
as its socket peer, typically at an RFC-1918 address (`10.x.x.x`,
`172.17.x.x`) — **peer-is-private is the normal state of a proxied
production app, not evidence of a local rig.** If G0/G1 were ever bypassed
on such a host, G5 would clear too and would not save it. G5's real value is
against a _direct_, unproxied exposure (a dev server bound to `0.0.0.0`
reachable from a LAN or the open internet with no proxy in front) — it is
not a backstop for the proxied-production case, which is exactly why making
G0/G1 a positive opt-in rather than a default is load-bearing.

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
  `accessToken` / `user`; (2) `await resetLocalSession()` — **the LOCAL HALF
  of `signOut()`** (the shared `clearLocalSessionState()` helper, session-
  store.ts): query cache, tab memory, last-viewed trip, money-segment
  memory, deeplink-return and settle-return records, and the per-trip
  last-zone map — deliberately **NOT** `signOut()` itself: `signOut()`
  additionally fires a best-effort `/auth/logout` POST first, which
  `resetLocalSession()` skips on purpose, so the reset never waits on the
  client's 12s request-timeout cap on an offline/black-holed rig (review
  round 1 security A2 — not a reachability concern; `signOut()`'s logout
  call already swallows its own failure). Skipping the local clear entirely
  leaks the previous run's account state into the flow, the exact Law-#3
  class this repo has fixed five separate times; (3) `await
openSessionDoor(...)`, then `applySignIn(response)`; (4) **do not
  navigate** — `AuthGate`'s `resume` branch (`authed && inAuthGroup`) fires
  `router.replace(dest ?? "/")` on the next effect cycle and takes the app
  out of `(auth)` by itself.

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

🔴 **A prebuild is MANDATORY on every variant switch (review round 1, B1).**
`expo run:ios` alone only prebuilds when `apps/mobile/ios/` does not already
exist (`ensureNativeProject.js`) — on any machine where that directory is
already checked out or was left over from a previous build, `expo run:ios`
reuses whatever `PRODUCT_BUNDLE_IDENTIFIER` the LAST prebuild wrote and never
re-consults `app.config.ts` at all. That produces a Release `.app` carrying
the door secret while `CFBundleIdentifier` is still the SHIPPING id — exactly
the archival hole this guard exists to close — and it fails **silently**:
nothing in the build output signals it. Use the `pnpm ios:door` /
`pnpm ios:doorfree` scripts (`apps/mobile/package.json`), which always run
`expo prebuild --platform ios` first; never invoke `expo run:ios` directly
for a door/door-free build.

```bash
# door-free (App-Store-shaped) - flows 1-4 + session-door-absent
cd apps/mobile && LANG=en_US.UTF-8 pnpm ios:doorfree

# door build - flows 5-10. Secret sourced from the gitignored, mode-600
# apps/server/.env.test (scripts/gen-test-env.mjs) -- NEVER typed inline: an
# inline assignment lands in shell history verbatim and is visible in
# `ps -e` to any local process while the build runs (review round 1, B5
# scenario C). T3 extends gen-test-env.mjs to also write
# E2E_SESSION_DOOR_SECRET / EXPO_PUBLIC_E2E_DOOR_SECRET into that file.
cd apps/mobile && set -a && . ../server/.env.test && set +a && \
  LANG=en_US.UTF-8 pnpm ios:door
```

**Bundle-identity guard (review round 1, B5 scenario B).** A door build and
a door-free build are otherwise byte-identical at the point of upload — the
only difference is a string literal folded into the Hermes bundle by
`babel-preset-expo`'s `inline-env-vars` plugin, which no human inspecting an
`.ipa`/`.app` can tell apart (§3.4 already forbids trying to prove this with
`strings | grep`). `apps/mobile/app.json` is currently **static** (no
`app.config.js`/`.ts`), so nothing in the repo can vary the bundle
identifier per build today. T4 SHALL convert it to a dynamic
`app.config.ts` (Expo SDK 57 supports `.js`/`.ts` config alongside or in
place of `app.json` — verify the exact API against the installed version via
Context7 before implementing; CLAUDE.md "What NOT to do": never guess a
library API or version) whose exported config function reads
`process.env.EXPO_PUBLIC_E2E_DOOR_SECRET` **at prebuild/build time** — this
runs as a plain Node script during `expo prebuild`/`expo run`, not inside
the JS bundle, so it sees the shell env directly and needs no babel inlining
— and, when the var is present, appends `.e2edoor` to `ios.bundleIdentifier`
(`app.gogotravel` → `app.gogotravel.e2edoor`) and ` (E2E)` to `name`. A door
build can then never be archived or uploaded under the shipping app's App
Store Connect record: Apple's upload pipeline keys off `CFBundleIdentifier`,
and `app.gogotravel.e2edoor` has no matching App Store Connect app record to
receive it. **Verification:** a test (T4) invokes the `app.config.ts` export
directly with and without the env var set and asserts the two resulting
`bundleIdentifier`/`name` values differ — no native build needed for the
pin. The black-box `session-door-absent` Maestro flow (§3.4) separately
proves the door-free build's runtime _behavior_; this proves the door
build's _identity_ can never collide with the shippable one.

**Third client gate: the installed bundle id itself (R-door-16, review round
1 B1 hardening).** Because a build recipe failure (the missing-prebuild
scenario above) is a PROCESS mistake, not something the app can see in its
own config, R-door-7's two checks (secret + local/private API base) are
insufficient on their own to keep the property FAIL-CLOSED — a mis-built
binary can satisfy both while still wearing the shipping identity. T4 adds a
third, synchronous condition to the client gate
(`features/dev/e2e-door/door.ts`'s `isDoorBundleId`): the REAL installed
bundle id, read via `expo-application`'s `applicationId` (NOT
`Constants.expoConfig?.ios?.bundleIdentifier`, which reflects the resolved
app CONFIG rather than what was actually prebuilt/archived, and would report
the suffixed id even for a mis-built binary that skipped prebuild), must
carry the `.e2edoor` suffix. All three conditions are checked in both
`openSessionDoor` and the route's own synchronous render gate. This makes
the identity and the capability inseparable regardless of how the binary was
produced: a door build can open the door only while ALSO wearing the
`.e2edoor` identity, and a binary wearing the shipping identity can never
open the door no matter what secret got folded into it.

**Runner/flow app-id collision, and the fix (review round 2).** The distinct
bundle id above is deliberate — it is what makes a door build unable to ever
land on the shipping App Store Connect record — but round 2 caught that
nothing on the consuming side knew about it. `scripts/e2e.sh` hard-codes
`APP_ID="app.gogotravel"` (`:23`) and `die()`s at `:168`
(`"$APP_ID is not installed"`) when that literal is not what is installed,
and all seven current `.maestro/*.yaml` flows (`sign-in-renders.yaml`,
`smoke-diagnostics-cold.yaml`, `deeplink-matrix.yaml`,
`sign-in-cancel-surface.yaml`, `diagnostics-panel-dev.yaml`,
`subflows/cold-open.yaml`, `subflows/warm-open.yaml`) hard-code
`appId: app.gogotravel` too. Since the cadence below makes the **door** build
(`app.gogotravel.e2edoor`) the default merge-gate install, an ordinary gate
run installs the `.e2edoor` app and then has the runner die looking for the
un-suffixed one — every default-cadence run would hard-fail, not because
anything is actually broken, but because the runner and the flow files never
learned the bundle-identity decision existed. Fixed normatively by R-door-15:
the bundle id becomes a per-lane, env-driven value the runner resolves
(door lane, dev lane, door-free lane each with their own default, every one
`GOGO_E2E_APP_ID`-overridable) and threads through every flow file via
Maestro's own `-e`/`${VAR}` mechanism, instead of a literal baked into eight
separate files.

**Decided cadence:** the door-free build + `session-door-absent` run on every
PR that touches door code (server gate, client gate, the route, or the
descriptor) and at each phase close. The default merge gate stays one build
(the door build) — running the door-free proof on every merge gate would
roughly double the gate's wall time for a claim that only changes when door
code changes.

### 5.3 The reusable subflow — `.maestro/subflows/session-door.yaml` (T5)

The interface flows 6–10 consume, written out in full in the design doc so
the command sequence itself needs no further design at T5 — what T5 still
designs is R-door-15's app-id parameterization (§5.2), which this subflow's
own `appId:` field depends on exactly like every other flow file. `launchApp`
with `clearState` AND
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
the local dev DB accumulates fixture users. **Revised, review round 3:**
dropping and re-migrating the dev database remains available as a **local
developer convenience**, for a throwaway dev DB nobody else depends on — it
is not, and was never meant to be, the lane's cleanup mechanism, and stating
it here read as though it were (fix-verifier round 2 flagged this as a
standing contradiction with the T3 mechanism below). `scripts/e2e-cleanup.mjs`
(below) is the mechanism for any shared or long-lived database, and the only
one the lane itself relies on to reclaim R-door-14 capacity.

**Bounded growth guard (R-door-14, review round 1 A3).** Without a cap, the
door is an unbounded authenticated-principal factory: every distinct
`user_key` find-or-creates a `users` row plus an `entitlements` row,
R-door-9 only bounds the _rate_ (200/day per peer) not the _total_, and
every per-user quota in the system (avatar upload, payment handles, the AI
daily caps) becomes effectively unbounded once enough fixture principals
exist. `E2E_DOOR_MAX_FIXTURE_USERS` (boot constant, default **500**) caps
the total distinct `e2e:`-prefixed users the door will ever create; past the
cap, find-or-create for a _new_ key rejects with the uniform 401
(`reason=fixture_cap`) while lookups of **existing** keys keep working. This
is not the rejected reset primitive below — it never deletes anything, it
only stops creating more.

**Cap rationale, stated (review round 2).** The key shape above,
`<flow>-${RUN_ID}`, mints one distinct key per **flow** that calls the door,
not one per lane run — `RUN_ID` is shared across a single `scripts/e2e.sh`
invocation, but each door-touching flow name differs, so each flow it runs
contributes its own key. The six door-touching flows (5–10) each mint at
least one fixture key per lane run, so one full run of that suite consumes
roughly 6 keys. At the default cap of 500 that is roughly **80 full lane
runs** before the cap is reached — after which every door-touching flow
starts failing with the uniform 401 (R-door-3), indistinguishable on the
wire from a wrong secret, a stale build, or a peer-gate misconfiguration,
with nothing to recover it short of an operator noticing and acting. Stating
the number here is itself part of the fix: an operator running the lane
daily hits this in about three months and now has a named, expected cause to
check server logs for (`reason=fixture_cap`, R-door-14) instead of
re-debugging the secret, the build, or the peer gate from scratch.

**Cleanup is a T3 deliverable, not deferred (review round 2).** Round 1 left
the cleanup script as "T3/T5 to land and name it" — unowned enough that
neither task's done-condition actually required it, which is how a cap with
no working release valve reached this spec unnoticed. **Decided: T3 lands
`scripts/e2e-cleanup.mjs` in the same commit as the door route**, not a
follow-up task — and, since no callable trip-delete function exists today,
**T3 also extracts one, in that same commit**, from the
`DELETE /trips/:tripId` handler (`apps/server/src/trips/routes.ts:518`) for
§5.4 step 1 below and the cleanup script to share (see step 1's shape). It
SHALL be invoked explicitly and manually only — never by
the door itself, never automatically per-run, never on any schedule —
matching Sean's no-destructive-reset ruling, which constrains what the
**door** does on a request; it does not forbid an **operator-invoked,
offline** maintenance script, which is what this is.

**What it does, and why it reuses `deleteAccount` instead of a hand-rolled
hard delete.** `apps/server/src/users/account-deletion.ts`'s `deleteAccount`
is the existing, reviewed, tested code path for "remove one user and
everything that must go with it": under lock, it deletes the user's owned
trips (cascading their children per schema §3.6) and remaining trip
memberships, consumes and deletes any `apple_credentials` row, revokes every
`auth_sessions` row, deletes every `push_tokens` row, and scrubs the `users`
row itself (PII columns nulled/tombstoned, `apple_sub` set to `null`,
`deleted_at` stamped) — `entitlements` needs no explicit touch, since its FK
already cascades (`onDelete: "cascade"` on `entitlements.userId`,
`identity.ts:58`). Several of this app's domains (`money.ts`, `itinerary.ts`,
`photos.ts`, `bookings.ts`, `places.ts`) FK-reference `users.id` with
`onDelete: "restrict"`, specifically so a real account can never vanish out
from under financial or itinerary history (R-trips-12) — which means a
**hard** `DELETE FROM users` for a fixture user that had, say, minted an
expense (flows 6–10, out of scope for T1–T5 but coming) would foreign-key-
violate and abort mid-cleanup. Reusing `deleteAccount`'s soft-delete
sidesteps all of that: it already satisfies every one of those constraints
for a real account, so it satisfies them for a disposable fixture account
for free, with no second hard-delete implementation to keep in sync with the
schema as new domains land. `scripts/e2e-cleanup.mjs` SHALL select every
`users.id` whose `apple_sub` matches `e2e:%` — never any other row; this is
the entire scoping guarantee against ever touching a real account — as the
candidate set; **the ordering below (review round 3) governs the sequence**
in which it calls `deleteAccount` against that set, so `deleteAccount`'s
existing owner-transfer guard (`OwnerTransferRequiredError`,
`account-deletion.ts:184`) does not stall on the very multi-member fixture
trips (flows 6–10) this cleanup exists to reclaim. A scrubbed row's
`apple_sub` becomes `null`, so it no longer matches the door's `WHERE
apple_sub = 'e2e:' || K` find-or-create lookup or R-door-14's cap count:
**this is what "clearing capacity" means** — the cap counts _live_
`e2e:`-prefixed identities, and cleanup drives that count back to zero
without a single hard delete. The scrubbed row itself persists (the same
trade-off a real deletion already accepts), and a subsequent door call for
the same `user_key` finds no live match and creates a fresh row, exactly as
R-door-5's find-or-create already specifies for a key with no live identity.

**Ordering — the release valve must not jam on its own target case (review
round 2 A3 named the cap; fix-verifier round 2 found the naive "call
`deleteAccount` for every row, any order" cleanup stalls on exactly the case
it exists to fix).** `deleteAccount` throws `OwnerTransferRequiredError`
(`account-deletion.ts:184`) before any write when its caller solely owns a
trip that still has another **live** member — fixture or real, the guard
does not distinguish. Flows 6–10 (expense splitting) are specified to leave
multi-member fixture trips (fixture user A owns a trip fixture user B still
belongs to), which is exactly that shape. `scripts/e2e-cleanup.mjs` SHALL
run in this order:

1. **All-fixture trips first.** Classify every trip the candidate set owns
   by whether ALL of its live members are `e2e:`-prefixed. For every trip
   that is, delete the trip in-process by calling a **callable trip-delete
   core** — a plain exported function taking the db client, the trip id,
   and the actor user id, the same exported-core shape as `pruneAuthRows`
   (`apps/server/src/db/prune-auth.ts`: no service layer, a plain function
   doing the raw drizzle deletes directly). No such callable exists today —
   the whole delete lives inline in the `DELETE /trips/:tripId` handler's
   closure (`apps/server/src/trips/routes.ts:518`) — so **T3 extracts one
   from that handler**, preserving its `FOR UPDATE` membership fence (T-6.2)
   and the schema §3.6 cascade byte-for-byte, and changes the route handler
   to call the extracted core instead of keeping its own copy of the delete
   body, so the two can never drift apart. The cleanup script calls that
   same core in-process with the fixture owner's user id as the actor
   (R-trips-8); this is **not** `DELETE /trips/:tripId` (that route sits
   behind `requireTripMember("owner")`, and an offline script has no session
   to satisfy it), so no HTTP request, no credentials, and no session door
   are involved — **never** via `deleteAccount` for this step — so the
   multi-fixture-member case is gone before any fixture's `deleteAccount`
   call can trip the owner guard on it.
2. **Ownerless fixtures next.** Call `deleteAccount` for every remaining
   `e2e:`-prefixed user who, after step 1, owns no trip at all. These can
   never hit `OwnerTransferRequiredError` — the guard only fires for an
   owner — so they always succeed.
3. **Remaining fixture owners.** Call `deleteAccount` for every
   `e2e:`-prefixed user who still owns a trip. By construction (step 1
   removed every all-fixture trip) any trip such a user still owns has at
   least one live **non-fixture** member, so `deleteAccount` throws
   `OwnerTransferRequiredError` for it. This is expected, not a failure to
   retry: catch it, log `skip: trip <id> has a non-fixture member — never
deleted or reassigned`, and leave both the user and the trip untouched.
   This is the "never touches a trip with a non-fixture member" guarantee —
   enforced by the guard `deleteAccount` already has, not a second check the
   script re-implements. A fixture that OWNS a trip with a live non-fixture
   member is skipped and reported by id, not deleted or reassigned — a
   fixture that is merely a **member**, not the owner, of a real trip has no
   owned trip and is fully handled by step 2 instead — and the skipped
   owner keeps its `E2E_DOOR_MAX_FIXTURE_USERS` cap slot until an operator
   resolves it manually (transfer the trip's ownership, or remove the real
   member), so the script's non-zero exit (step 6) names these skipped-owner
   ids separately from any transient per-user failure logged under step 5.
4. **Retry pass.** Re-run steps 1–3 once more against whatever `e2e:`-
   prefixed rows are still live. A trip's membership can change between the
   classification query and a given `deleteAccount` call (e.g. a step-1
   trip delete for one fixture's trip completes while a step-3 call for
   another fixture on a different trip is in flight), so a second pass
   resolves anything the first pass's snapshot missed, with no operator
   action.
5. **Per-user error handling.** Any error other than
   `OwnerTransferRequiredError` that `deleteAccount` throws for a given user
   SHALL be caught, logged with that user's `id` and `user_key`, and SHALL
   NOT abort the run for the remaining users — one bad fixture row must not
   block reclaiming the other 499.
6. **Exit status.** After the retry pass the script SHALL print the count of
   `e2e:`-prefixed rows still live and SHALL exit non-zero if that count is
   greater than zero — whether the reason is a logged mixed-membership skip
   or a genuinely stuck row — so a non-zero exit always means "capacity was
   not fully reclaimed, check the log," never a silent partial run.

**Rejected: a `reset: true` request field that
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
- Never mount without an **explicit** `E2E_SESSION_DOOR=1` and an explicit
  `NODE_ENV` — no default configuration turns it on (§3.2 G0/G1, R-door-1).
- Never accept a request from a non-loopback, non-private **socket peer**,
  even with a correct secret (§3.2 G5, R-door-11).
- Never create more than `E2E_DOOR_MAX_FIXTURE_USERS` fixture users without
  an operator-run cleanup in between (§5.4, R-door-14).
- Never widen `apps/server/src/app.ts`'s exported `PUBLIC_ALLOWLIST` constant
  or change its pinned size (§4.3).
