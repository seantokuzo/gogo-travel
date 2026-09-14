import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // T-S3.3 (R-test-6): ONE Postgres testcontainer per run; DB suites clone
    // per-suite databases off its migrated template (src/test/suite-db.ts).
    // This is what retired the `--no-file-parallelism` workaround (QUEUE P1):
    // files run parallel again without wedging the Docker daemon.
    globalSetup: ["./src/test/global-setup.ts"],
    // QUEUE "Shared PG container afterAll teardown timeout under concurrent
    // gates": `afterAll(() => suiteDb?.drop())` across every `.db.test.ts`
    // has NO per-hook override (unlike the 240s `beforeAll` boot budget), so
    // it inherited vitest's 10s default and blew it under machine load
    // (several worktrees' gates + Docker Desktop pegged) with ZERO assertion
    // failures — pure false-red noise. `hookTimeout` is the knob that governs
    // `afterAll` (confirmed against vitest docs: `teardownTimeout` is a
    // separate worker/process force-exit budget, NOT applied to `afterAll`).
    // 30s comfortably covers `suite-db.ts#drop()`'s own internal bound
    // (~24s worst case: 5s pool-close + 14s DROP DATABASE race
    // (DROP_STATEMENT_TIMEOUT_MS=12s + 2s headroom) + 5s admin pool-close —
    // round-1 review raised DROP_STATEMENT_TIMEOUT_MS from 5s to 12s after
    // the PR's own root-gate evidence showed 5s cancelling DROPs that would
    // have finished, slowly, inside the OLD 10s hook budget) plus scheduling
    // slop under load — belt-and-suspenders with `drop()` itself now being
    // bounded and tolerant rather than relying on this alone to paper over a
    // hang.
    hookTimeout: 30_000,
  },
});
