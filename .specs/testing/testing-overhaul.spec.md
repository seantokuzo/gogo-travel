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
bytes etc.). Filename grammar: `<lib>.contract.test.ts`, co-located; the
`.test.ts` tail is LOAD-BEARING (jest testMatch pickup — a `.contract.ts`
file would exist, pass pointer review, and never run). Cheap second front:
a type-parity module asserting each
`jest.setup.js` stub's shape `satisfies` a `Pick` of the real package's
types, so typecheck catches shape drift in the location/network/mapbox stubs.

### 3.2 Device smoke

New unauthed-reachable route `(auth)/diagnostics` (file-based — no
`_layout.tsx` edit; sibling of `sign-in.tsx`, which is NOT
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
rider #3 (§5) — originally gated on `qa/device-integration`, which merged
to main (d4f7637), so it is plain dispatchable; it stays outside T-S3.5's
file set to keep the wave disjoint.
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
Filename grammar (mirrors §3.1's contract line): consumer suites are
`<subject>.hostile.test.ts` — the `.test.ts` tail is LOAD-BEARING
(test-runner pickup); the pack `packages/shared/src/testing/hostile.ts`
itself is NOT a test.
Consumers are NEW test files only: mobile `form-model.hostile.test.ts`
(`it.fails` — the real NRT→LAX flight produces inverted instants today; this
is B-8's executable repro and its client fix's acceptance harness), the
shared consumers (as shipped, PR #45's documented disposition, merged
65a8ac1 — the owns-list is the authority: money pins FOLDED into
`booking.hostile.test.ts` alongside the schema pins, plus the pack
self-test and the mobile suite; a dedicated `config/money.hostile.test.ts`
stands recorded as an optional cheap follow-up), and a minimal pure server
consumer (import-only
use of `bookings/service.ts`; grace-window-sensitive pins marked — the B-8
12h transport grace is on main since the qa merge (d4f7637) and its removal
is B-9's definition of done, so those pins flip again with B-9).

### 3.5 Env faithfulness

`makeFullAuthTestEnv()` in-memory builder (jose `generateKeyPair` → PKCS#8
PEM, `randomBytes(32)` base64 AES, fixed fake client ids) + boot-shape suite:
full-shape `buildAuthDepsFromEnv` non-null, partial-shape throws naming vars,
both env-file PEM arrival shapes through `loadEnv` — the SETTLED fact
(char-code probes, twice; PR #41 R1 blocker was an inverted "verified" stamp
on it): node `--env-file` expands `\n` to a real newline inside
double-quoted values, while single-quoted/unquoted values keep the literal
two characters (the case `wire.ts` `pem()` normalizes),
`createApp` mounts `/auth` with the built deps, and the
production-never-boots-health-only guard pinned at logic level (the
composition root `index.ts` stays untouched — extracting a testable
`boot()` is rider #2, §5). `scripts/gen-test-env.mjs` writes the
same material to gitignored `apps/server/.env.test` for the live rig +
`pnpm --filter @gogo/server dev:testenv`.

## 4. Tasks

> One task = one commit/PR. Branch names `S-3/<slug>` with the task id as a
> `[T-S3.N]` tag in PR titles and commit subjects (the W1 practice, and it
> satisfies CLAUDE.md's `S-N/slug` grammar — the earlier `S-3/T-S3.N-slug`
> form was never used). File-ownership sets are exclusive within a wave.
> Acceptance criteria all inherit R-test-7
> (falsification stated; mutation-verify blocking pins) and the root gate
> (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).

### T-S3.1 — Faithful server test env + boot-shape suite

- **Goal:** the full authed boot shape runs under test (R-test-5).
- **Files (owns):** `apps/server/src/test/env-builder.ts` (new),
  `apps/server/src/boot-shape.test.ts` (new), `scripts/gen-test-env.mjs`
  (new), `apps/server/package.json` (add `dev:testenv` script),
  `.gitignore` (add `.env.test`), `.env.example` (document the generator).
- **Reads, must NOT edit:** `apps/server/src/env.ts`,
  `apps/server/src/auth/wire.ts`, `apps/server/src/index.ts` (rider #2
  target; the original "qa-owned" reason dissolved with the d4f7637 merge —
  T-S3.1 shipped without touching it).
- **Acceptance:** boot-shape suite green in CI with generated throwaways
  (no secrets, no accounts); partial-env test red if the all-or-nothing
  gate is removed (mutation-verified); `gen-test-env.mjs` output boots the
  dev server fully authed (`dev:testenv`, manual evidence pasted in PR);
  no PEM/key material in the diff.
- **Depends on:** —.
- **Landed note (PR #41, merged 0643621):** env-builder shipped at
  `src/test/env-builder.ts`, which needed a `src/test/**` build exclude to
  stay out of `dist/`. Guidance for future non-`.test.ts` test files: the
  repo's existing `*.test-util.ts` suffix (see `http/idor-404.test-util.ts`)
  avoids both the dist-emit hazard and the extra directory — prefer it
  unless the directory is earning its keep.

### T-S3.2 — Mock-fidelity contract suites (mobile)

- **Goal:** the B-4 class becomes impossible to ship silently (R-test-1).
- **Files (owns):** `apps/mobile/jest.setup.js` (**exclusive to this stream**
  — annotations + any stub-shape correction),
  `apps/mobile/src/auth/google-provider.contract.test.ts` (new),
  `apps/mobile/src/testing/mock-shape-parity.ts` (new, type-level).
- **Must NOT touch:** `apps/mobile/src/auth/google.ts` / `google.test.ts` /
  `api-client.ts` (qa-owned); any component file (Stream A).
  **DISSOLVED (2026-08-30):** the qa-owned guard died before any W1 branch
  cut — `qa/device-integration` merged to main (d4f7637) first. PR #42's
  relocation of the real-AuthRequest contract test out of `google.test.ts`
  into `google-provider.contract.test.ts` was sanctioned and audited
  lossless. Do not treat the dead constraint as live in future collision
  analysis; the Stream-A component guard still stands.
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
  `apps/server/src/test/suite-db-isolation-a.db.test.ts` +
  `suite-db-isolation-b.db.test.ts` + `suite-db-isolation.shared.ts`
  (landed addition, PR #44 — permanent falsification probes proving
  cross-suite template-clone isolation; recorded here because this
  owns-list is the collision-analysis source of truth and must match the
  tree), `apps/server/src/fresh-install.db.test.ts` (new), and the mechanical
  conversion of the DB suites **EXCEPT** any suite with an in-flight PR
  touching it at dispatch time (check open PRs for `expenses/`,
  `settlements/`, `settle-requests/` test files — T-9 W3/W4; excluded
  suites coexist on per-file containers and get riders).
  **DISSOLVED (2026-08-30):** the original
  `apps/server/src/bookings/routes.db.test.ts` exclusion was "qa-owned" —
  that reason died when `qa/device-integration` merged to main (d4f7637).
  Including the bookings suite in the conversion is now a plain
  dispatch-time call under the same in-flight-PR check as every other
  suite.
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
  one minimal pure server consumer (new file; imports `bookings/service.ts`
  read-only; grace-sensitive pins labeled — see §3.4).
- **Must NOT touch:** `form-model.ts` itself, any existing test file, any
  Stream-A file.
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
  **Sanctioned production touches (landed, PR #43 — recorded so a future
  auditor reads them as sanctioned, not drift):**
  `apps/mobile/src/auth/config.ts` (`explainApiBaseUrl` pure helper +
  `resolveApiBaseUrl` delegation onto it — the tier decision became
  reportable without behavior change), `apps/mobile/src/auth/api-client.ts`
  (dev-warn path-template change, from PR #43's R1), and the route-audit
  allowlist entry for the diagnostics route.
- **Must NOT touch:** `apps/mobile/src/app/(auth)/sign-in.tsx` (the entry
  link is rider #3 — the "qa-owned" reason dissolved d4f7637; the guard
  stays to keep T-S3.5's file set disjoint), `_layout.tsx`, any Stream-A
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
| W1 | T-S3.1 ∥ T-S3.2 — **MERGED** (PR #41 0643621 ∥ PR #42 aaf0742, full pipeline) | Disjoint: server+scripts+root dotfiles vs mobile jest surface. |
| W2 | T-S3.3 ∥ T-S3.5 — **MERGED** (PR #44 b903017 ∥ PR #43 3754a4e, full pipeline, judge merge/high) | Disjoint: server test infra vs new mobile dev-feature files. |
| W3 | T-S3.4 (solo) — **MERGED** (PR #45, 65a8ac1) | Touches all three workspaces — ran alone, after the others merged. |

**S-3 BUILD COMPLETE (2026-08-30):** all five tasks T-S3.1..T-S3.5 are on
main (PRs #41–#45, full pipeline each). ADR-006 remains **Proposed**
pending Sean's read of this PR.

### Collision matrix (checked 2026-08-30 against `git diff --name-only origin/main qa/device-integration` and QUEUE)

| Other stream | Their files | Our exposure | Mitigation |
| --- | --- | --- | --- |
| `qa/device-integration` — **DISSOLVED: merged to main d4f7637 before any W1 branch cut** | `apps/mobile/src/auth/{google.ts,google.test.ts,api-client.ts}`, `app/(auth)/sign-in.tsx`, `apps/server/src/{index.ts,app.ts,bookings/service.ts,bookings/routes.db.test.ts,http/dev-request-log.*}`, migration 0001 | ~~T-S3.2 (auth tests), T-S3.3 (bookings db suite), T-S3.1 (index.ts), T-S3.5 (sign-in entry link)~~ none — guard dead | Row kept for the record only; the riders below became plain dispatchable follow-ups. |
| Stream A polish (B-10..B-13) | `DateField.tsx`, itinerary day-list/grid, bookings list bins | None | No task touches components. `jest.setup.js` is Stream-B-exclusive (STATE ruling) — Stream A must not edit it. |
| P-9 money W3/W4 (T-9.4/T-9.5 dispatched; T-9.6/T-9.7 queued) | server money src + tests; mobile money screens | T-S3.3's conversion of `expenses/`/`settlements/` db suites; T-S3.4's shared `package.json` export | Conversion list finalized at T-S3.3 dispatch against open PRs (exclude + rider if in flight); T-S3.4 runs W3 solo and rebases on merged main. |

### Riders (were gated on the qa merge — that landed d4f7637, so all are dispatchable now; record as QUEUE rows at dispatch)

1. Convert `bookings/routes.db.test.ts` to the shared container — now a
   T-S3.3 dispatch-time call (see the dissolved note in §T-S3.3).
2. Extract a testable `boot()` from `index.ts`; boot-shape suite drives it.
3. `__DEV__` diagnostics link in the sign-in footer.
4. Align `google.test.ts`'s file-local mock with the contract suite's facts
   (partially superseded: PR #42 already relocated the real-AuthRequest
   contract test into `google-provider.contract.test.ts`, audited lossless).

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
2. **Diagnostics entry:** deeplink-only for v1, then the sign-in footer
   link as rider #3 (recommended; no longer gated — qa merged d4f7637) — or
   do you want a launcher-visible entry sooner?
3. **Generated `.env.test`** (recommended, Law #1-clean) vs committing
   throwaway keys — confirm the generator approach.
