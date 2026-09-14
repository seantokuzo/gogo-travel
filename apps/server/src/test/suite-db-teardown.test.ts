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
 * Falsification (bound): in `suite-db.ts`, replace `boundedTolerantTeardown`'s
 * body with a bare `await step()` (drop the `Promise.race` against
 * `timedOut`) and the "hung pool end()" case below goes RED — it stops
 * resolving within the assertion's own margin and instead rides out
 * vitest's default `testTimeout`, because nothing bounds the wait anymore.
 * Verified during this change (evidence pasted in the PR body); left
 * bounded here.
 *
 * Timing pins use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`
 * (round-1 review finding, was: real wall-clock margins — `toBeLessThan(500)`
 * on a 50ms bound — that false-red under the exact heavy-load regime this
 * PR exists to fix; probed at 602ms elapsed under 600ms of synchronous
 * thread-blocking work). Under the fake clock, `Date.now()` only advances
 * when we explicitly advance it, so elapsed time is exact and independent of
 * real scheduling delays — no margin to blow, at any load.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedTolerantTeardown } from "./suite-db.js";

function taggedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("boundedTolerantTeardown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("happy path: a step that settles well inside the bound resolves promptly and logs nothing", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = Date.now();
    await boundedTolerantTeardown("ok step", () => Promise.resolve("done"), 5_000);
    // Settles via microtasks alone — zero fake-clock time elapses, no
    // real-time margin needed at all.
    expect(Date.now() - start).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("bounds a step whose promise never settles (a hung pool end() under load) and logs exactly once", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Models the exact failure mode reported today: `client.end()` (or the
    // admin `DROP DATABASE` connection) never calling back because Docker
    // Desktop's VM is pegged. No reject, no resolve — ever.
    const hungEnd = () => new Promise<never>(() => {});

    const start = Date.now();
    const dropped = boundedTolerantTeardown("hung pool end()", hungEnd, 50);
    // Drive the internal `setTimeout(…, 50)` deterministically — advancing
    // the fake clock also flushes the microtasks `Promise.race` needs to
    // observe the timeout side winning.
    await vi.advanceTimersByTimeAsync(50);
    await dropped;
    const elapsedMs = Date.now() - start;

    // Bounded: resolves at EXACTLY the fake-clock budget — no real-time
    // scheduling slop to leave a margin for, at any load.
    expect(elapsedMs).toBe(50);
    // Tolerant: exactly one warning, never a thrown/rejected drop().
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message: unknown = warnSpy.mock.calls[0]?.[0];
    expect(String(message)).toContain("hung pool end()");
    expect(String(message)).toContain("50ms");
  });

  it("tolerates a step that rejects with a load-induced error (e.g. DROP DATABASE cancelled by statement_timeout, SQLSTATE 57014) and logs exactly once", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = Date.now();
    await boundedTolerantTeardown(
      "rejecting step",
      () => Promise.reject(taggedError("canceling statement due to statement timeout", "57014")),
      5_000,
    );

    // Rejection resolves via microtasks alone — zero fake-clock time
    // elapses, so it must not wait out any part of the bound.
    expect(Date.now() - start).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message: unknown = warnSpy.mock.calls[0]?.[0];
    expect(String(message)).toContain("rejecting step");
    expect(String(message)).toContain("statement timeout");
  });

  it("discrimination: rethrows SQLSTATE 55006 (object_in_use) instead of swallowing it — a suite's leaked, reconnecting listener must still red that suite by name", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const objectInUse = taggedError(
      'database "suite_db_abc123" is being accessed by other users',
      "55006",
    );

    await expect(
      boundedTolerantTeardown("DROP DATABASE step", () => Promise.reject(objectInUse), 5_000),
    ).rejects.toBe(objectInUse);
    // Not tolerated: no warning logged on the way out — this is a rethrow,
    // not a swallow-and-continue.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("discrimination: tolerates ECONNREFUSED and postgres-js's CONNECTION_* family the same way as 57014", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      boundedTolerantTeardown(
        "connection-refused step",
        () => Promise.reject(taggedError("connect ECONNREFUSED", "ECONNREFUSED")),
        5_000,
      ),
    ).resolves.toBeUndefined();
    await expect(
      boundedTolerantTeardown(
        "connection-destroyed step",
        () => Promise.reject(taggedError("write CONNECTION_DESTROYED", "CONNECTION_DESTROYED")),
        5_000,
      ),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("adversarial: a step that throws synchronously with a tolerated code (instead of returning a rejected promise) never escapes drop()", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      boundedTolerantTeardown(
        "throws synchronously",
        () => {
          throw taggedError("connect ECONNREFUSED", "ECONNREFUSED");
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

  it("adversarial: a step that rejects AFTER the bound has already resolved (late-rejecting race loser) produces no unhandledRejection", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      let rejectLoser: ((error: Error) => void) | undefined;
      // Never settles on its own — the bound MUST win the race (deterministic,
      // not a real timing race: nothing else can resolve/reject this promise
      // until we call `rejectLoser` ourselves, below).
      const lateRejectingStep = () =>
        new Promise<never>((_resolve, reject) => {
          rejectLoser = reject;
        });

      // The chosen design's own internal shape: `Promise.race` has already
      // attached a rejection handler to `step().then(...)` by the time the
      // bound wins, so a rejection arriving after `drop()` has resolved is
      // absorbed instead of surfacing as `unhandledRejection` — the exact
      // failure the PR body rejected option B over.
      await boundedTolerantTeardown("late-rejecting loser", lateRejectingStep, 50);
      expect(warnSpy).toHaveBeenCalledTimes(1); // the bound's own timeout warning

      rejectLoser?.(new Error("rejected after the bound already resolved"));
      // Flush microtasks + a macrotask tick so Node's unhandledRejection
      // detection (which runs after the current tick) has had its chance.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
