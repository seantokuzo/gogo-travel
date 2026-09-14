/**
 * Main-guard pins for the E2E cleanup entry points (review round 1
 * adversarial finding 4 — the PR body's "both are main-guarded" claim was
 * FALSE at round 1: `cleanup-cli.ts` had a bare top-level `await main();`
 * and `scripts/e2e-cleanup.mjs` ran its DATABASE_URL check and `spawn()` at
 * module scope). No DB, no Docker — this only proves nothing fires at
 * IMPORT time, which is exactly what a main-guard is for.
 */
import { describe, expect, it, vi } from "vitest";

describe("e2e cleanup entry points are main-guarded (review round 1 adversarial finding 4)", () => {
  it("importing cleanup-cli.ts opens no DB connection", async () => {
    vi.resetModules();
    const originalDatabaseUrl = process.env.DATABASE_URL;
    // A real (well-formed, unreachable) URL — proves the guard itself is
    // what stops execution, not an incidental missing-env short-circuit
    // inside `main()` (which returns before ever calling `postgres(...)`).
    process.env.DATABASE_URL = "postgresql://fake:fake@127.0.0.1:1/fake";
    const postgresFactory = vi.fn(() => ({ end: vi.fn() }));
    vi.doMock("postgres", () => ({ default: postgresFactory }));

    try {
      // Falsification: drop the `if (isMainModule()) { await main(); }`
      // guard in `cleanup-cli.ts` (bare `await main();`) and this goes RED
      // — `main()` calls `postgres(databaseUrl, ...)` unconditionally.
      await import("./cleanup-cli.js");
    } finally {
      vi.doUnmock("postgres");
      vi.resetModules();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }

    expect(postgresFactory).not.toHaveBeenCalled();
  });

  it("importing scripts/e2e-cleanup.mjs spawns no child process", async () => {
    vi.resetModules();
    const originalDatabaseUrl = process.env.DATABASE_URL;
    // Same rationale as above: get PAST the DATABASE_URL check (which would
    // otherwise call `process.exit(1)` and mask whether the guard works) so
    // the only thing standing between import and `spawn()` is the guard.
    process.env.DATABASE_URL = "postgresql://fake:fake@127.0.0.1:1/fake";
    const spawnSpy = vi.fn(() => ({ on: vi.fn() }));
    vi.doMock("node:child_process", () => ({ spawn: spawnSpy }));

    try {
      // Falsification: drop the `if (isMainModule()) { main(); }` guard in
      // the .mjs (bare top-level calls) and this goes RED — unguarded, the
      // script calls `spawn(...)` unconditionally at import time (and,
      // absent DATABASE_URL, `process.exit(1)` before even reaching that —
      // the exact "kill the vitest worker" scenario the finding named).
      // @ts-expect-error — a root-level .mjs script, outside this package's
      // tsconfig `include`; only imported for its side effects (or lack
      // thereof), never for a typed export.
      await import("../../../../scripts/e2e-cleanup.mjs");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
