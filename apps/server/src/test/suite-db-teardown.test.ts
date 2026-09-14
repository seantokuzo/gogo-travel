/**
 * QUEUE "Shared PG container afterAll teardown timeout under concurrent
 * gates" — unit-level pin for `boundedTolerantTeardown` (`suite-db.ts`),
 * the primitive `drop()` uses to bound pool-close and `DROP DATABASE`
 * against machine load instead of relying solely on vitest's `hookTimeout`.
 *
 * Deliberately NOT a `.db.test.ts`: no Docker, no container, no
 * `createSuiteDb` — this pins the timeout/tolerance wrapper in isolation by
 * feeding it fake steps (including one that never settles, modelling a
 * pool `end()` wedged by an overloaded Docker VM), so it runs everywhere
 * `pnpm test` runs, load or no load, Docker or no Docker.
 *
 * Falsification: in `suite-db.ts`, replace `boundedTolerantTeardown`'s body
 * with a bare `await step()` (drop the `Promise.race` against `timedOut`)
 * and the "hung pool end()" case below goes RED — it stops resolving within
 * the assertion's own margin and instead rides out vitest's default
 * `testTimeout`, because nothing bounds the wait anymore. Verified during
 * this change (evidence pasted in the PR body); left bounded here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedTolerantTeardown } from "./suite-db.js";

describe("boundedTolerantTeardown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: a step that settles well inside the bound resolves promptly and logs nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = Date.now();
    await boundedTolerantTeardown("ok step", () => Promise.resolve("done"), 5_000);
    expect(Date.now() - start).toBeLessThan(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("bounds a step whose promise never settles (a hung pool end() under load) and logs exactly once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Models the exact failure mode reported today: `client.end()` (or the
    // admin `DROP DATABASE` connection) never calling back because Docker
    // Desktop's VM is pegged. No reject, no resolve — ever.
    const hungEnd = () => new Promise<never>(() => {});

    const start = Date.now();
    await boundedTolerantTeardown("hung pool end()", hungEnd, 50);
    const elapsedMs = Date.now() - start;

    // Bounded: resolves close to the 50ms budget, not left hanging.
    expect(elapsedMs).toBeLessThan(500);
    // Tolerant: exactly one warning, never a thrown/rejected drop().
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message: unknown = warnSpy.mock.calls[0]?.[0];
    expect(String(message)).toContain("hung pool end()");
    expect(String(message)).toContain("50ms");
  });

  it("tolerates a step that rejects (e.g. DROP DATABASE cancelled by statement_timeout) and logs exactly once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = Date.now();
    await boundedTolerantTeardown(
      "rejecting step",
      () => Promise.reject(new Error("SQLSTATE 57014 query_canceled")),
      5_000,
    );

    // Rejection resolves immediately — it must not wait out the full bound.
    expect(Date.now() - start).toBeLessThan(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message: unknown = warnSpy.mock.calls[0]?.[0];
    expect(String(message)).toContain("rejecting step");
    expect(String(message)).toContain("query_canceled");
  });

  it("adversarial: a step that throws synchronously (instead of returning a rejected promise) never escapes drop()", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      boundedTolerantTeardown(
        "throws synchronously",
        () => {
          throw new Error("boom");
        },
        5_000,
      ),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("boundary: zero timeout still resolves (does not divide-by-zero or hang) and is tolerant of an immediately-losing step", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      boundedTolerantTeardown("zero budget", () => new Promise<never>(() => {}), 0),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
