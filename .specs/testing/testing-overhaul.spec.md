# Testing Overhaul Spec — `.specs/testing/testing-overhaul.spec.md`

> **Task:** S-3 (spike deliverable) · **Status:** PROPOSED — pending Sean
> approval alongside ADR-006.
>
> **Sources:** ADR-006 (the strategy decision — read it first; this spec is
> the build plan), `docs/STATE.md` § "Stream B — the testing overhaul",
> `docs/QUEUE.md` rows B-5..B-9 + the Testcontainers P1 row,
> `.claude/rules/mobile.md` (vacuous-pin taxonomy = the quality bar),
> `.claude/rules/server.md`, `.claude/rules/ci.md`, memory
> `gogo-sim-qa-toolkit` (no tap automation; in-app QA-driver pattern).

---

## 1. Scope

Build the four layers ADR-006 decides — mock-fidelity contract suites, device
smoke, fresh-database suite, hostile fixtures — plus the faithful test-env
machinery and the shared-container Testcontainers fix. Five atomic tasks,
one task = one commit/PR, three waves.

**Non-goals:** fixing B-5..B-9 themselves (they are their own QUEUE rows with
their own owners — this stream builds the harness that would have caught
them, and hands each open bug an executable acceptance pin); editing
`docs/QUEUE.md` / `docs/STATE.md` / `feature-ledger.json` (orchestrator
does docs); any new paid service, account, or API key; any tap-automation
framework (parked — ADR-006 alternatives).

## 2. Requirements (EARS)

- **R-test-1 (mock fidelity):** WHEN a library is globally stubbed in
  `jest.setup.js` THE SYSTEM SHALL carry a contract suite that imports the
  REAL library (stubbing only bottom-layer native primitives, never library
  logic) and asserts every behavioral fact the stub encodes; the stub SHALL
  carry a comment pointing at its contract suite.
- **R-test-2 (device evidence):** WHEN a fact depends on device runtime state
  (resolved base URL, native module behavior, reachability) THE SYSTEM SHALL
  provide a `__DEV__`-gated diagnostics surface that measures it ON the
  device and renders PASS/FAIL + copyable evidence; claims about device
  behavior SHALL originate from the device, never from the Mac side.
- **R-test-3 (fresh database):** THE SYSTEM SHALL keep a suite that boots the
  full authed app against an empty migrated database with ZERO fixtures and
  walks first-user/first-run paths; fixture seeding inside this suite is a
  blocking review finding.
- **R-test-4 (hostile fixtures):** THE SYSTEM SHALL export a platform-
  agnostic hostile fixture pack from `@gogo/shared/testing` (date-line
  flight, multi-zone trip, zero-decimal currency, DST boundary, empty
  states), and new date/money/list logic SHALL be exercised against it.
- **R-test-5 (faithful env):** THE SYSTEM SHALL provide one canonical
  full-auth test env (in-memory builder + gitignored generated `.env.test`)
  and a boot-shape suite that runs loadEnv → `buildAuthDepsFromEnv` →
  `createApp` in the FULL authed shape, in CI, with throwaway generated key
  material only (never committed — Law #1).
- **R-test-6 (one container):** THE SYSTEM SHALL boot at most ONE Postgres
  testcontainer per vitest run (globalSetup + template-database clones);
  suites SHALL run file-parallel without wedging Docker.
- **R-test-7 (falsification):** WHEN a new test is added under this overhaul
  THE SYSTEM SHALL state its falsification (what change makes it red) in the
  test or suite doc-comment, and blocking-path pins SHALL be
  mutation-verified (revert the guard, expect RED — mobile.md taxonomy).
- **R-test-8 (open-bug pins):** WHEN a suite pins behavior blocked by a known
  open bug THE SYSTEM SHALL use `it.fails` with the bug id in the test name,
  flipping to `it` in the bug's fix PR — never skipped, never asserted green.

## 3. Design (per layer — the short version; ADR-006 § Decision carries the rationale)

### 3.1 Mock fidelity

First target: `GoogleAuthRequest` from the real
`expo-auth-session/providers/google` (installed build verified:
`Google.js:66-70` — nonce only under `ResponseType.IdToken`; `:125-139` —
native default resolves to `Code`). The contract suite instantiates the real
class, awaits `getAuthRequestConfigAsync()`, and asserts: no nonce under the
code flow (the B-4 fact), nonce present under `IdToken`, and
`extraParams.nonce` carried through (our fix's premise). Use
`jest.requireActual`, mocking only native primitives (`expo-crypto` random
bytes etc.). Cheap second front: a type-parity module asserting each
`jest.setup.js` stub's shape `satisfies` a `Pick` of the real package's
types, so typecheck catches shape drift in the location/network/mapbox stubs.

### 3.2 Device smoke

New unauthed-reachable route `(auth)/diagnostics` (file-based — no
`_layout.tsx` edit; sibling of the qa-owned `sign-in.tsx`, which is NOT
edited). Legs v1, self-running on mount ("run again" button; testIDs per
navigation.spec §2.7):

1. Resolved API base URL + which tier fired + raw `hostUri` value (B-5).
2. `GET /health` round-trip from the phone: status, latency (B-5, wrong-side
   lesson).
3. `EXPO_PUBLIC_*` presence booleans (names only, never values).
4. Google auth-request shape: request non-null, nonce present in the
   authorize URL (B-4).
5. secure-store round-trip (session persistence substrate).
6. Last surfaced auth-error cause (B-6's dev surface, read back).

Entry: on-device deeplink `gogo://diagnostics` (the SpringBoard prompt is
tappable on a physical device — the no-tap constraint is about *automation*)
or the dev-client launcher URL field. A `__DEV__` footer link on sign-in is
a **post-qa-merge rider** (file owned by `qa/device-integration`).
Protocol: run at every dev-client rebuild and before any device-behavior
ledger flip; evidence = screenshot or copied panel text (Law #7).

### 3.3 Fresh database + shared container

`globalSetup` (vitest 4.1.10 `provide`/`inject`, verified installed): probe
Docker once → boot ONE `PostgreSqlContainer` → run drizzle migrations into a
TEMPLATE database → `provide` the URI + availability flag. Suite helper
`createSuiteDb(name)`: `CREATE DATABASE … TEMPLATE …` (instant clone),
returns client + drop(). Existing suites convert mechanically (their
Docker-probe/banner boilerplate collapses into the helper); Docker-less
local = loud skip, CI = hard fail (unchanged posture, now enforced in ONE
place). The fresh-install suite then gets a pristine clone by construction:
first sign-in creates the first user on an empty DB (JWKS seam, same as
`signin-routes.db.test.ts`), zero-state lists page correctly, `places` = 0
rows + no ingest regions pinned, and the B-7 circularity carried as
`it.fails` pins until Sean's spec ruling lands.

### 3.4 Hostile fixtures

`@gogo/shared/src/testing/hostile.ts` (new `./testing` subpath export; pure
data + builders, R-shared-9 clean): NRT→LAX eastbound (arrival wall-clock <
departure wall-clock, instants correctly ordered — the exact B-8 trap),
westbound cross-midnight, 3-zone trip, JPY/KRW zero-decimal amounts, DST
boundary day, empty-state shapes. Self-test asserts the fixtures' invariants.
Consumers are NEW test files only: mobile `form-model.hostile.test.ts`
(`it.fails` — the real NRT→LAX flight produces inverted instants today; this
is B-8's executable repro and its client fix's acceptance harness), shared
schema/money hostile suites, and a minimal pure server consumer (import-only
use of qa-owned source files; grace-window-sensitive pins marked, since the
B-8 12h transport grace on `qa/device-integration` shifts semantics when it
merges).

### 3.5 Env faithfulness

`makeFullAuthTestEnv()` in-memory builder (jose `generateKeyPair` → PKCS#8
PEM, `randomBytes(32)` base64 AES, fixed fake client ids) + boot-shape suite:
full-shape `buildAuthDepsFromEnv` non-null, partial-shape throws naming vars,
\n-escaped PEM normalization through `loadEnv` on an env-file-shaped source,
`createApp` mounts `/auth` with the built deps, and the
production-never-boots-health-only guard pinned at logic level (the
composition root `index.ts` itself is qa-owned; extracting a testable
`boot()` is a post-qa-merge rider). `scripts/gen-test-env.mjs` writes the
same material to gitignored `apps/server/.env.test` for the live rig +
`pnpm --filter @gogo/server dev:testenv`.

## 4. Tasks

> One task = one commit/PR. Branch names `S-3/T-S3.N-slug`. File-ownership
> sets are exclusive within a wave. Acceptance criteria all inherit R-test-7
> (falsification stated; mutation-verify blocking pins) and the root gate
> (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).

### T-S3.1 — Faithful server test env + boot-shape suite

- **Goal:** the full authed boot shape runs under test (R-test-5).
- **Files (owns):** `apps/server/src/test/env-builder.ts` (new),
  `apps/server/src/boot-shape.test.ts` (new), `scripts/gen-test-env.mjs`
  (new), `apps/server/package.json` (add `dev:testenv` script),
  `.gitignore` (add `.env.test`), `.env.example` (document the generator).
- **Reads, must NOT edit:** `apps/server/src/env.ts`,
  `apps/server/src/auth/wire.ts`, `apps/server/src/index.ts` (qa-owned).
- **Acceptance:** boot-shape suite green in CI with generated throwaways
  (no secrets, no accounts); partial-env test red if the all-or-nothing
  gate is removed (mutation-verified); `gen-test-env.mjs` output boots the
  dev server fully authed (`dev:testenv`, manual evidence pasted in PR);
  no PEM/key material in the diff.
- **Depends on:** —.

### T-S3.2 — Mock-fidelity contract suites (mobile)

- **Goal:** the B-4 class becomes impossible to ship silently (R-test-1).
- **Files (owns):** `apps/mobile/jest.setup.js` (**exclusive to this stream**
  — annotations + any stub-shape correction),
  `apps/mobile/src/auth/google-provider.contract.test.ts` (new),
  `apps/mobile/src/testing/mock-shape-parity.ts` (new, type-level).
- **Must NOT touch:** `apps/mobile/src/auth/google.ts` / `google.test.ts` /
  `api-client.ts` (qa-owned); any component file (Stream A).
- **Acceptance:** contract suite RED when the google stub claims a native
  nonce (mutation-verified by flipping the stub); real-library assertions
  match `Google.js:66-70`/`125-139` behavior; every `jest.setup.js` stub
  carries its contract-suite (or type-parity) pointer; full mobile suite
  stays green.
- **Depends on:** —.

### T-S3.3 — Shared PG container + fresh-database suite

- **Goal:** one container per run (R-test-6) + first-run coverage (R-test-3);
  the QUEUE P1 real fix.
- **Files (owns):** `apps/server/vitest.config.ts`,
  `apps/server/src/test/global-setup.ts` (new),
  `apps/server/src/test/suite-db.ts` (new),
  `apps/server/src/test/provided-context.d.ts` (new),
  `apps/server/src/fresh-install.db.test.ts` (new), and the mechanical
  conversion of the DB suites **EXCEPT**
  `apps/server/src/bookings/routes.db.test.ts` (qa-owned — keeps its
  per-file container, converts in a post-qa-merge rider) and any suite with
  an in-flight money PR touching it at dispatch time (check open PRs for
  `expenses/`, `settlements/`, `settle-requests/` test files — T-9 W3/W4;
  excluded suites coexist on per-file containers and get riders).
- **Acceptance:** `pnpm --filter @gogo/server test` green **without**
  `--no-file-parallelism`; exactly one container observed during the run
  (evidence in PR); wall-time before/after reported; fresh-install suite
  uses zero fixtures, pins first-sign-in-creates-first-user, zero-state
  pagination, `places`/`place_ingest_regions` emptiness, and the B-7
  circularity as `it.fails` (R-test-8); Docker-less local skip banner and CI
  hard-fail preserved (single home); converted suites' stale
  `--no-file-parallelism` comments updated in the same pass.
- **Depends on:** T-S3.1 (env-builder for building authed deps in the
  fresh-install suite).

### T-S3.4 — Hostile fixture pack + first consumers

- **Goal:** the B-8 class meets fixtures designed to break it (R-test-4).
- **Files (owns):** `packages/shared/src/testing/hostile.ts` (new),
  `packages/shared/src/testing/hostile.test.ts` (new),
  `packages/shared/package.json` (add `./testing` subpath),
  `apps/mobile/src/features/itinerary/add-edit/form-model.hostile.test.ts`
  (new), `packages/shared/src/domains/booking.hostile.test.ts` (new),
  one minimal pure server consumer (new file; imports qa-owned source
  read-only; grace-sensitive pins labeled).
- **Must NOT touch:** `form-model.ts` itself, any existing test file, any
  qa-owned or Stream-A file.
- **Acceptance:** fixtures platform-agnostic (R-shared-9 — lint/build
  proves it); self-test pins the eastbound wall-clock-inversion invariant;
  `form-model.hostile.test.ts` carries the B-8 repro as `it.fails` with the
  flip instruction in its doc-comment; each consumer names which fix flips
  its pins.
- **Depends on:** T-S3.1 + T-S3.3 merged (keeps workspaces quiet; no code
  dependency beyond the shared build).

### T-S3.5 — Device smoke: diagnostics panel + protocol

- **Goal:** device runtime facts get measured on the device (R-test-2).
- **Files (owns):** `apps/mobile/src/app/(auth)/diagnostics.tsx` (new),
  `apps/mobile/src/features/dev/diagnostics/` (new: legs, runner, panel),
  colocated leg unit tests (new).
- **Must NOT touch:** `apps/mobile/src/app/(auth)/sign-in.tsx` (qa-owned —
  the entry link is a post-qa-merge rider), `_layout.tsx`, any Stream-A
  component.
- **Acceptance:** all six §3.2 legs render PASS/FAIL + copyable evidence;
  route content is `__DEV__`-only (release renders nothing); legs 1/2/3/5
  meaningful on simulator, all six on device; leg 1 demonstrably surfaces
  the tier decision (evidence: run on sim showing localhost tier vs
  explicit-override tier); testIDs per §2.7 grammar; panel works unauthed.
- **Depends on:** —.

## 5. Wave plan

| Wave | Parallel tasks (isolated worktrees) | Why safe |
| --- | --- | --- |
| W1 | T-S3.1 ∥ T-S3.2 | Disjoint: server+scripts+root dotfiles vs mobile jest surface. |
| W2 | T-S3.3 ∥ T-S3.5 | Disjoint: server test infra vs new mobile dev-feature files. |
| W3 | T-S3.4 (solo) | Touches all three workspaces — runs alone, after the others merge. |

### Collision matrix (checked 2026-08-30 against `git diff --name-only origin/main qa/device-integration` and QUEUE)

| Other stream | Their files | Our exposure | Mitigation |
| --- | --- | --- | --- |
| `qa/device-integration` (in flight, unreviewed) | `apps/mobile/src/auth/{google.ts,google.test.ts,api-client.ts}`, `app/(auth)/sign-in.tsx`, `apps/server/src/{index.ts,app.ts,bookings/service.ts,bookings/routes.db.test.ts,http/dev-request-log.*}`, migration 0001 | T-S3.2 (auth tests), T-S3.3 (bookings db suite), T-S3.1 (index.ts), T-S3.5 (sign-in entry link) | New files only in auth; bookings suite excluded from conversion (rider); index.ts read-only (`boot()` extraction = rider); sign-in link = rider. |
| Stream A polish (B-10..B-13) | `DateField.tsx`, itinerary day-list/grid, bookings list bins | None | No task touches components. `jest.setup.js` is Stream-B-exclusive (STATE ruling) — Stream A must not edit it. |
| P-9 money W3/W4 (T-9.4/T-9.5 dispatched; T-9.6/T-9.7 queued) | server money src + tests; mobile money screens | T-S3.3's conversion of `expenses/`/`settlements/` db suites; T-S3.4's shared `package.json` export | Conversion list finalized at T-S3.3 dispatch against open PRs (exclude + rider if in flight); T-S3.4 runs W3 solo and rebases on merged main. |

### Riders (owed after `qa/device-integration` merges — record as QUEUE rows at dispatch)

1. Convert `bookings/routes.db.test.ts` to the shared container.
2. Extract a testable `boot()` from `index.ts`; boot-shape suite drives it.
3. `__DEV__` diagnostics link in the sign-in footer.
4. Align `google.test.ts`'s file-local mock with the contract suite's facts.

## 6. Parked options & open questions for Sean

**Parked (need your call; none adopted — Autonomy Contract #3 / ADR-006):**

- **Tap-automation framework (Maestro or Detox).** $0 OSS; would turn the
  smoke panel into true device E2E. Cost: heavy new dependency, native build
  integration, and this rig's history of automation hangs. Revisit at
  pre-launch Android pass.
- **Device farm SaaS (AWS Device Farm / BrowserStack).** Billed; only worth
  it if multi-device matrix coverage becomes a launch requirement.
- **MSW (or similar) for mobile network-layer tests.** $0 OSS dependency;
  would let screen tests exercise the real `api-client` against faked HTTP
  instead of mocked modules. Natural follow-up AFTER the four layers land;
  `npm view` + Context7 before adopting.

**Open questions:**

1. **B-7 ruling** (existing escalation, QUEUE P0): text-only destination vs
   self-seeding first search. The fresh-install suite pins the circularity
   either way (`it.fails` now; flips with your ruling's fix).
2. **Diagnostics entry:** deeplink-only until the qa branch merges, then a
   sign-in footer link (recommended) — or do you want a launcher-visible
   entry sooner?
3. **Generated `.env.test`** (recommended, Law #1-clean) vs committing
   throwaway keys — confirm the generator approach.
