# ADR-006: Testing strategy overhaul — four layers above unit tests

**Status:** Proposed
**Date:** 2026-08-30
**Supersedes:** none
**Superseded by:** none

## Context

Device QA on 2026-08-29 surfaced five bugs (B-4 Google nonce, B-5 localhost
base URL, B-6 bare catch, B-7 places cold-start deadlock, B-8 timezone
Z-stamping). At that moment the repo carried roughly **3,000 green tests**
(W2 merged-tree gate 2026-08-26: server 817 · shared 484 · tokens 323 ·
mobile 1355+). **Not one of them could have caught any of the five.** That is
not a coverage gap — it is a structural blindness, different in kind per bug:

| Bug | Structural reason no unit test could catch it |
| --- | --- |
| B-4 nonce | `jest.setup.js` + `google.test.ts` mocked `expo-auth-session/providers/google` with `request.nonce` present. The REAL library (verified `build/providers/Google.js:66-70`) generates a nonce **only** under `ResponseType.IdToken`, and on native `useIdTokenAuthRequest` resolves to `ResponseType.Code` (`Google.js:125-139`) — so `request.nonce` is **always undefined on iOS**. Every test downstream verified our code against a fiction; more tests on the same mock would have verified more fiction. |
| B-5 localhost | `resolveApiBaseUrl()` tier 2 reads `Constants.expoConfig.hostUri` — a value only a device runtime defines (or, as it turned out, fails to define in a dev-client build). `config.test.ts` pins tier 1 (explicit override) only; a tier-2 unit test would have **encoded the same false assumption** (hostUri present). The falsifying fact lived on hardware. |
| B-6 bare catch | `} catch {` in `sign-in.tsx:141` destroys the error cause. Screen tests mock `@/auth` wholesale (sanctioned — mobile.md) and assert the generic banner on failure — an assertion that passes whether the cause is preserved or destroyed. Diagnosability is not a unit-assertable outcome; its absence cost two full debugging rounds on device. |
| B-7 deadlock | Every DB suite seeds users/trips/places in `beforeAll`. Nobody ever ran the first-user path against a 0-row `places` table, so the circular dependency (no places → no trip → no ingest trigger → no places) was unreachable by construction. |
| B-8 timezone | `form-model.ts:205` composes `` `${date}T${time}:00Z` ``. Every fixture in ~3,000 tests uses one timezone, so the ordering validation never met a legitimate eastbound date-line flight that Z-stamping inverts. |

Compounding this, the **test env is not the prod env shape**. Server auth env
is all-or-nothing across 8 vars (`buildAuthDepsFromEnv` — partial set throws
at boot; empty set boots health-only). Server suites never read env at all —
they inject `AuthRouterDeps` built from in-test jose keys (good DI, but it
means the composition root `src/index.ts` — loadEnv → wire → serve — is
exercised by **zero tests**), and CI runs with no env beyond `CI=true`. The
full authed boot shape has never run under any test harness; it first ran on
Sean's QA rig, by hand, with hand-generated throwaway keys.

Also standing: the Testcontainers contention problem (QUEUE P1) — 21 server
DB suites each boot their own Postgres container; under vitest file
parallelism this has wedged the local Docker daemon, and the documented
workaround (`--no-file-parallelism`) serializes the whole server suite.

Constraints: no metered LLM anywhere (Law #5, ADR-003), no new paid services
or accounts (Autonomy Contract #3), no tap automation on the sim/device rig
(memory: sim-QA toolkit — the in-app QA-driver pattern is the proven
approach), verification is evidence (Law #7).

## Decision

**We will not respond to this failure by writing more unit tests.** They
demonstrably would not have caught a single one of the five. Instead we build
four layers, each owning the class of bug the unit suite is structurally
blind to, plus a faithful env strategy underneath them:

1. **Mock fidelity (contract suites).** For every library we globally stub
   (`jest.setup.js` is the registry), a contract suite imports the REAL
   library — stubbing only bottom-layer native primitives, never library
   logic — and asserts the exact facts our mock claims (e.g. instantiate the
   real `GoogleAuthRequest`; assert nonce absent under `ResponseType.Code`,
   present under `IdToken`). A mock drifting from its library goes RED.
   Each global stub in `jest.setup.js` carries a pointer to its contract
   suite; a stub with no contract suite is a review finding.

2. **Device smoke (in-app diagnostics panel).** A committed, `__DEV__`-gated
   diagnostics route, reachable UNAUTHED (base-URL resolution matters exactly
   when sign-in is broken), self-driving per the QA-driver pattern — no tap
   automation required beyond opening it. Legs render PASS/FAIL + copyable
   evidence, starting with **"what base URL did we resolve, via which
   tier?"** (B-5), server /health round-trip **from the phone** (the
   "verified from the wrong side" lesson: evidence must originate on the
   device), auth-request shape (B-4), secure-store round-trip, and the
   surfaced last-error cause (B-6). Runs at every dev-client rebuild and
   before any device-behavior ledger flip.

3. **Fresh-database suite.** One suite boots the full authed app against an
   EMPTY migrated database — zero fixtures — and walks first-user/first-run
   paths: first sign-in creates the first user, zero-state lists page
   correctly, and the B-7 circularity is pinned. Known-open bugs are pinned
   with `it.fails` (the pin flips to `it` when the fix lands, making the
   suite the fix's acceptance harness rather than a merge blocker).

4. **Hostile fixtures.** A shared, platform-agnostic fixture pack
   (`@gogo/shared/testing`): eastbound date-line flight with real wall times
   (arrival wall-clock before departure while instant order is correct — the
   exact B-8 trap), multi-zone trip, zero-decimal currencies, DST-boundary
   day, empty states. Consumer suites in each workspace exercise them, with
   `it.fails` pins where the bug (B-8) is still open.

**Env strategy.** One canonical full-auth test env: an in-memory builder
(`makeFullAuthTestEnv()` — jose-generated P-256 PKCS#8 PEM, 32-byte AES key,
fixed fake client ids) used by a new **boot-shape suite** that runs
loadEnv → `buildAuthDepsFromEnv` → `createApp` in the FULL authed shape
(including the \n-escaped-PEM env-file form and the
production-refuses-health-only guard), locally and in CI. For the live dev
rig, `scripts/gen-test-env.mjs` writes a **gitignored** `apps/server/.env.test`
with the same throwaway material — the pattern the QA rig already proved.
Throwaway keys are **generated, never committed**: they guard nothing, but
Law #1's letter stays clean and secret scanners stay quiet.

**Unit tests: what they are and are not for here.** They ARE for pure logic,
zod contract shapes, error-path handling with real error objects, and
regression pins with a stated falsification. They are NOT for proving
integration with native modules or libraries through hand-rolled mocks
(contract suites own that), proving env/boot correctness (boot-shape suite),
proving first-run viability (fresh-database suite), or proving device runtime
facts (device smoke). A unit test that re-asserts its own mock's behavior is
vacuous by definition.

**Quality bar: the vacuous-pin taxonomy is the bar for ALL new tests** —
generalized repo-wide from `.claude/rules/mobile.md`: no pins on disabled
elements, no proofs via already-settled promises, `git add -N` before diff
probes, deferred promises released in `finally`. Every new test in this
overhaul states its falsification ("what change makes this red"), and
blocking-path pins are mutation-verified (revert the guard, expect RED).

**Testcontainers real fix (in the fresh-database task's scope).** One shared
Postgres container in vitest `globalSetup`: migrate once into a TEMPLATE
database, `provide()` the URI; each suite `inject()`s it (verified against
installed vitest 4.1.10 — `inject` is exported, `dist/index.d.ts:105`) and
clones its own database via `CREATE DATABASE … TEMPLATE` (instant file-copy).
File parallelism is restored, `--no-file-parallelism` retires, one container
total, the Docker daemon stops getting wedged. Docker-less local runs keep
the loud-skip banner; CI keeps the hard-fail.

Build order and file ownership: `.specs/testing/testing-overhaul.spec.md`.

## Alternatives considered

1. **More unit tests / coverage thresholds.** Rejected. The five-bug evidence
   table is the whole case: ~3,000 green tests, zero catches. Coverage
   metrics would have read excellent throughout.
2. **Adopt a tap-automation E2E framework (Maestro / Detox).** Parked, not
   adopted. $0 OSS, but the rig has a no-tap-automation history (TCC hangs,
   SpringBoard prompt stacking — sim-QA toolkit memory), it is a heavy new
   dependency surface, and the in-app QA-driver pattern already works. Revisit
   at pre-launch Android verification if the smoke panel proves insufficient.
3. **Device farm SaaS (AWS Device Farm, BrowserStack).** Parked — billed
   service, Autonomy Contract trigger #3. Recorded as an option for Sean if
   multi-device coverage becomes a launch requirement.
4. **Commit `.env.test` with throwaway keys.** Rejected in favor of a
   committed *generator*. Same convenience, no PEM blocks in git history, no
   scanner noise, no Law-#1 ambiguity.
5. **Per-test transaction rollback on one shared database.** Rejected for the
   contention fix: cross-suite isolation would hinge on every suite honoring
   rollback discipline, and suites that test transaction/locking behavior
   (several do) can't run inside a wrapping transaction. Template-clone
   databases give hard isolation with near-zero cost.

## Consequences

### Positive

- Each of the five bug classes gets an owner layer; a recurrence has a
  specific suite that should have gone red — and "why didn't it?" becomes a
  tractable question about one layer, not a shrug at 3,000 green tests.
- The full authed boot shape finally runs under test, locally and in CI, at
  $0 and with zero new accounts.
- Server suite regains file parallelism; Docker stops wedging; per-suite
  container boots (~10s each × 21) collapse to one boot + cheap clones.
- `it.fails` pins turn open bugs (B-7, B-8) into executable acceptance
  harnesses for their fixes instead of prose.

### Negative

- Contract suites add a maintenance surface tied to library internals; a
  library upgrade can red them for behavior changes that don't affect us.
  (That is also the point — the red is information the mock would swallow.)
- The device-smoke layer still requires a human to open the panel and read
  it (no tap automation) — it is smoke, not regression coverage.
- The fresh-database and hostile-fixture suites lengthen the server test
  wall-time slightly (offset — likely more than offset — by the shared
  container).

### Neutral

- Existing DI-driven integration suites stay as they are — DI is the design,
  not the gap; only the boot path needed a faithful-env test.
- `jest.setup.js` becomes stream-owned (Stream B exclusively) while the
  overhaul is in flight.

## Links

- Evidence: `docs/STATE.md` § "Stream B — the testing overhaul" (five-bug
  table); `docs/QUEUE.md` rows B-5..B-9 + Testcontainers P1 row
- Spec / task decomposition: `.specs/testing/testing-overhaul.spec.md`
- Quality bar: `.claude/rules/mobile.md` (vacuous-pin taxonomy),
  `.claude/rules/server.md`, `.claude/rules/ci.md`
- Constraints: ADR-003 (no LLM/cron in CI), CLAUDE.md Laws #5/#7
- Device constraints: memory `gogo-sim-qa-toolkit` (no tap automation;
  in-app QA-driver pattern)
