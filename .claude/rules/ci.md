---
paths: [".github/workflows/**"]
---

# CI Rules

You're editing CI. Hard rules — the `guard` job enforces the first THREE
mechanically; don't fight it.

- **No `schedule:`/`cron:` triggers, ever** (ADR-003). Push / pull_request /
  workflow_dispatch only. A forgotten nightly cron billed a sibling repo for
  months.
- **No LLM, no metered API keys in CI** (Law #5, ADR-003). No
  `ANTHROPIC_API_KEY`, no claude actions. Reviews run in-session on Max.
- **No raw NUL (U+0000) bytes in tracked source** —
  `.github/scripts/check-nul-bytes.mjs`, with its own falsification suite.
  One stray control byte makes git call a `.ts` file BINARY: it vanishes from
  `gh pr diff` (T-7.5 shipped a 182-line module past five review lanes that
  could not see a line of it) and BSD `grep` exits 1 in silence. tsc/eslint
  pass regardless. Write the escape, never the byte.
- **Gate per CLAUDE.md § Quality Gates**; note `lint` includes `lint:root`
  (root configs + `.github/scripts/` — nothing else lints those). The guard
  job also runs `node --test .github/scripts/*.test.mjs`, which covers the
  aggregator AND the NUL guard's exit contract.
- **The DB constraint suite must RUN in CI, never skip**: `CI=true` makes the
  Docker-down path hard-fail (T-3.3). ubuntu-latest has a native Docker
  daemon; testcontainers works without setup.
- **Prod-parity landmine**: tests run `postgres-js` (testcontainers); prod
  runs `@neondatabase/serverless` WebSocket Pool. Driver-class bugs (e.g. the
  neon-http no-transactions trap) are INVISIBLE to CI — parity is enforced by
  convention (`.claude/rules/server.md`), not tests.
- Pin action majors (`@v4`); turbo test task is `cache: false` — a test skip
  must never replay as a cached pass.
