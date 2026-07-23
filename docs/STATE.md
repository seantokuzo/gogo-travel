# GoGo Travel — Active State

> **Short-term active context** for in-flight work. Advisory cap ~800–1000 lines.
> Locked decisions → `docs/decisions/ADR-NNN-*.md`. Completed phases → `docs/history/`.
> Stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) per [ADR-001](decisions/ADR-001-naming-convention.md).
> Log **failed approaches** here too ("Tried X, didn't work because Y") — fresh
> sessions must not re-walk dead ends.

---

## CURRENT DIRECTION

Building **GoGo Travel** — a mobile travel app covering everything a person needs
for planning AND using during a trip. Multiple trips per user; itinerary/calendar,
bookings by category (lodging / flights / trains / car+moped rentals / activities),
maps with saved places + travel times, budgeting + AI expense estimates, AI
recommendations + AI tour guide, Splitwise-style expense splitting with Venmo/Zelle
handoff, photo albums pinned to map/itinerary (private/public), deeplink-first
booking integrations, minimal customizable design system.

**Operating model:** high-autonomy Claude builds from upfront specs; Sean is
planner/spec-maker/QA. Human-in-the-loop ONLY at the escalation triggers in
`CLAUDE.md § Autonomy Contract`. Reviews are **local in-session**
([ADR-003](decisions/ADR-003-local-in-session-reviews.md)) — no GitHub Claude app.

## Active phase context

### P-5 — Auth, profiles & entitlements (ACTIVE since 2026-07-22)

- **Sensitive path: auth — every review round auto-escalates.** 8 tasks
  T-5.1..T-5.8 (PLANNING § P-5). Specs: `api/auth-users`,
  `client/navigation` (NAV-2), `shared/contracts`. Ledger F-018..F-029.
- Security invariants from the approved spec set: Apple + Google OAuth only,
  ES256 access + rotating refresh tokens w/ reuse-theft family revocation,
  refresh token in expo-secure-store ONLY (never AsyncStorage/MMKV),
  middleware trio `requireAuth`/`requireTripMember`/`requireAiQuota`,
  404-indistinguishable authz, zero passwords stored.
- **T-5.1 MERGED (de98def)** — 15 endpoint descriptors (auth 6 / users 8 /
  entitlements 1), credential length caps, `pruneAuthRows` (strict-lt,
  revoked_at-anchored, mutation-pinned), shared 317 + server 63 tests.
  Reconciliation: AU-1 schemas + AU-2 tables pre-existed spec-exact
  (T-3.2/T-3.3); drizzle zero-delta verified by engineer AND correctness
  lane — no migration owed. 5-lane 0-blocking SHIP (14 advisories: 7 fixed,
  4 deferred w/ QUEUE rows, 1 parked for Sean, 2 spec syncs); judge
  merge/high. **Judge directive: spend Sean's /code-review ultra on T-5.2
  (provider verify) or T-5.4 (middleware) — the real crypto/authz surface.**
- **T-5.2 MERGED (bc58180)** — Apple/Google JWKS verify, nonce binding
  (Apple SHA-256(raw_nonce) lowercase hex / Google raw), auto-link,
  AES-256-GCM Apple-credential store, ES256 access + CSPRNG refresh
  issuance. Server 63→143. **First HITL gate exercised end-to-end**:
  round-1 fix-then-ship (5 blocking fixed) → judge routed to human →
  Sean ran `/code-review ultra` (1st of 3 free) → bug_001 (unawaited
  Apple key import: malformed key passed boot, every Apple sign-in
  silently skipped credential store → App-Store revocation broken) →
  fixed 3deb831 (await import at boot, mirror ES256 key) + re-judged
  merge/high. jose@6.2.4 + @hono/zod-validator@0.9.0 added. Landmines
  codified in rules/server.md (boot-parse-secrets-awaited; no raw
  control bytes in test literals). Spec syncs applied (R-auth-3/5/6
  interpretations, contracts §3.6 /api base). Prettier reflows locked
  .md/.yaml on edit — apply spec/YAML syncs SURGICALLY via Bash, the
  Write/Edit hook matcher doesn't catch it.
- **T-5.3 MERGED (3abfac4)** — refresh rotation, reuse-theft family
  revocation (session-scoped: rotate A→B, replay A ⇒ whole family dies),
  atomic CAS double-spend guard (`WHERE rotated_at IS NULL`), STATELESS
  requireAuth (ES256 verify, zero DB/request), session list/revoke,
  /auth/refresh + /auth/logout. Server 143→179. New modules:
  access-verify / token-rotation / session-service / require-auth.
  5-lane 0-blocking SHIP (security ~60 probes cleared cascade + CAS +
  alg-confusion); 6 advisories fixed (require `exp` present on verify;
  session cursor → integer epoch-MICROSECONDS, crash-safe on malformed
  input, closes a sub-ms keyset skip; +pagination/latency/no-oracle
  tests); judge merge/high, large-diff escalation WAIVED (crypto core
  untouched by fixes). Session cursor lesson: keyset must carry full
  µs precision, NOT a JS-Date ISO round-trip (ms-truncates → skips rows).
- **T-5.4 ACTIVE** (engineer subagent): middleware trio + error envelope
  - rate limits [AU-5], branch `P-5/T-5-4-middleware`. **PROMOTE-AND-
    REPLACE** the local `auth/require-auth.ts` from T-5.3 (don't rebuild);
    add requireTripMember + requireAiQuota, app-wide error serializer,
    public allowlist, refresh rate-limit (§3.6.3). Judge-flagged as the
    high-value target for Sean's remaining `/code-review ultra` (2 left).

### P-4 — Design system + navigation skeleton (CLOSED 2026-07-22)

- **4/4 build tasks + 2 direct commits merged; ledger F-010..F-017 ALL
  flipped** (sim evidence sweep + Sean's full device-QA pass on iPhone 15
  Pro — checklist cleared 2026-07-22). Archive:
  `docs/history/PHASE-004-design-system-navigation.md` (incl. the
  device-install bootstrap recipe + landmine list). Mobile suite 152 tests.
- First native builds: simulator AND Sean's iPhone. Dev QA doors on trip
  list: Component gallery + Open sample trip (both `__DEV__`-only).
- Gotchas for future sessions: node >=22.9 (env-file flag); mobile TS ~6.0.3
  is Expo's pin; guard-job comments must never contain literal trigger keys;
  PG assignment cast rounds numeric->bigint (app-boundary z.int is the gate);
  CocoaPods needs UTF-8 locale; JS-only changes reach the device app via
  kill+reopen (Metro), no rebuild.

### P-2 — Upfront spec suite (CLOSED 2026-07-10; P-1 push still pending)

- **Where we are:** Gates 1 AND 2 passed 2026-07-09. Full spec suite written
  (18 files, ~280 EARS requirements) by 11 parallel spec agents; all 59
  punch-list questions approved wholesale (see `.specs/OPEN-QUESTIONS.md` —
  now the decision record); both resolution agents ran — **zero markers
  remain**. Cross-agent sync items applied (push_tokens.timezone, packing
  live-uncached, map search bar). Judgment calls flagged by resolvers are
  logged in their reports; notable: editors can only edit/delete their OWN
  expenses (per approved permission matrix), sole-owner account deletion →
  409 transfer-first.
- **T-2.4 DONE:** `feature-ledger.json` (118 features, F-001..F-118, all
  `passes:false`, 466 requirement IDs verified) + frozen roadmap **P-3..P-14**
  (12 phases, ~62 PRs) in PLANNING § Phase Detail. **GATE 3 OPEN — Sean
  approves the phase plan → P-3 build starts.**
- Sequencing notes from T-2.4 (binding): places spine ships with trips (P-6);
  AI expense-estimate CTA stubs in P-9, wires in P-10; capture (P-11) needs
  the AI platform (P-10); push emitter stubs P-6, transport lands P-13.
- Sean's open action items: **Gate 3 approval** · palette pick (artifact
  claude.ai/code/artifact/229f853e-c9d3-49a9-b439-96a0c27f914f) · gh auth
  login (push) · (later, P-14) buy universal-link domain.
- **Port sources, for archaeology:** `../the-bach` (in-session 5-lane review
  pipeline — its ADR-002 is our ADR-003; commands; hooks), `../get-sean-done`
  (canonical GSD template: doc system, autonomous loop, naming ADRs),
  `../bartling-bachelor` (product exemplar — mobile PWA, design system, itinerary
  UX), `../roi-gen` (STATE discipline), `../seantokuzo-mcp` (rules/hooks patterns).
- **Research base:** autonomous-build patterns synthesis (Anthropic harness
  posts, Spec Kit, Kiro, Ralph loop) — see PLANNING.md § P-2 for how it lands.

## In-flight decisions

- ~~S-1 stack~~ → **LOCKED 2026-07-09 as
  [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md)**: Expo/RN +
  Hono + Drizzle/Postgres monorepo, iOS-first, StyleSheet+tokens styling.
  Extras all approved (live-trip, utilities, collab, recap).
- ~~S-2 product research~~ → **DONE 2026-07-09.** All five streams banked in
  `.specs/research/`: `competitors.md`, `booking-integrations.md`,
  `maps-places.md`, `payments-settle-up.md`, `ai-architecture.md`.
  Headlines: all-in-one slot validated w/ no good competitor execution;
  splitting+payment-handoff is uncontested; **Mapbox over Google (Google ToS
  bans Places/Routes content on non-Google maps + AI use — this supersedes
  the AI report's Google-Places grounding; ground AI in our Overture/FSQ-OS
  POI spine instead)**; settle-up = record-only ledger + handle deeplinks
  (formats live-probed); Viator + Ticketmaster APIs instant-approve day one;
  Amadeus self-serve dies 2026-07-17 (we never touch it). Total run-rate
  ~$40–120/mo at 1k MAU. Spec-shaping sign-offs pending (see Blockers).

## Blockers / Waiting on Sean

- ~~Push blocked~~ → RESOLVED 2026-07-16: pushed to origin.
- ~~All P-2 gates~~ → passed. No open Sean items except: (P-14) buy the
  universal-link domain.
