/**
 * T-7.3 worker unit suite (spec §3.5 step 1, R-ib-19): debounce coalescing,
 * fixed-window bounded settlement, serial drain, never-throws/never-wedges,
 * stop/idle semantics — all DETERMINISTIC via an injected manual scheduler
 * (no real sleeps, task contract). Also pins the filled `createDirtyDayMarker`
 * seam arms (bookings/dirty-days.ts).
 */
import { describe, expect, it } from "vitest";
import { createDirtyDayMarker } from "../bookings/dirty-days.js";
import { ProviderRequestError } from "./providers.js";
import { createTravelLegWorker, safeErrorLabel, type LegBatch } from "./worker.js";

/**
 * Manual scheduler: tasks run only when the test fires them. Carries
 * LIFETIME counters (`totalScheduled` / `cancelled`) so fixed-window pins
 * can tell "one deadline ever" from "cancel + reschedule per mark" — a
 * sliding-window regression also ends with exactly one PENDING task, so
 * `count` alone cannot falsify it.
 */
function fakeScheduler() {
  let nextId = 1;
  let totalScheduled = 0;
  let cancelled = 0;
  const tasks = new Map<number, { fn: () => void; delayMs: number }>();
  return {
    scheduler: {
      schedule(fn: () => void, delayMs: number): unknown {
        totalScheduled += 1;
        const id = nextId++;
        tasks.set(id, { fn, delayMs });
        return id;
      },
      cancel(handle: unknown): void {
        cancelled += 1;
        tasks.delete(handle as number);
      },
    },
    /** Fire every pending task (a debounce window elapsing). */
    fireAll(): void {
      const pending = [...tasks.entries()];
      tasks.clear();
      for (const [, task] of pending) task.fn();
    },
    get count(): number {
      return tasks.size;
    },
    /** Every schedule() call ever made (fired or not). */
    get totalScheduled(): number {
      return totalScheduled;
    },
    /** Every cancel() call ever made. */
    get cancelled(): number {
      return cancelled;
    },
    get delays(): number[] {
      return [...tasks.values()].map((t) => t.delayMs);
    },
  };
}

/** Recording recompute with optional per-call control. */
function recordingRecompute(impl?: (batch: LegBatch) => Promise<void>) {
  const batches: LegBatch[] = [];
  return {
    batches,
    recompute: (batch: LegBatch) => {
      batches.push({ tripId: batch.tripId, days: [...batch.days].sort() });
      return impl ? impl(batch) : Promise.resolve();
    },
  };
}

const TRIP_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TRIP_B = "bbbbbbbb-0000-4000-8000-00000000000b";

describe("debounce coalescing (§3.5 step 1)", () => {
  it("marks within one window coalesce into ONE recompute with the day union", async () => {
    const fake = fakeScheduler();
    const rec = recordingRecompute();
    const worker = createTravelLegWorker({
      recompute: rec.recompute,
      scheduler: fake.scheduler,
      debounceMs: 3000,
    });

    worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }]);
    worker.markDaysDirty([
      { tripId: TRIP_A, day: "2026-09-01" }, // duplicate — callers do not pre-dedupe
      { tripId: TRIP_A, day: "2026-09-02" },
    ]);

    expect(rec.batches).toHaveLength(0); // nothing before the window elapses
    expect(fake.count).toBe(1); // ONE window per trip
    expect(fake.delays).toEqual([3000]);

    fake.fireAll();
    await worker.idle();
    expect(rec.batches).toEqual([{ tripId: TRIP_A, days: ["2026-09-01", "2026-09-02"] }]);
  });

  it("window is FIXED from the first mark — later marks never extend it (bounded settlement)", () => {
    const fake = fakeScheduler();
    const rec = recordingRecompute();
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });

    worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }]);
    for (let i = 0; i < 50; i += 1) {
      worker.markDaysDirty([{ tripId: TRIP_A, day: `2026-09-0${(i % 9) + 1}` }]);
    }
    // A mark storm schedules NOTHING new — one deadline, one recompute.
    // LIFETIME counters, not pending count: a sliding-window regression
    // (cancel + reschedule per mark) also leaves exactly one pending task,
    // so only totalScheduled/cancelled can falsify it.
    expect(fake.count).toBe(1);
    expect(fake.totalScheduled).toBe(1);
    expect(fake.cancelled).toBe(0);
  });

  it("separate trips get separate windows and separate batches", async () => {
    const fake = fakeScheduler();
    const rec = recordingRecompute();
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });

    worker.markDaysDirty([
      { tripId: TRIP_A, day: "2026-09-01" },
      { tripId: TRIP_B, day: "2026-10-01" },
    ]);
    expect(fake.count).toBe(2);
    fake.fireAll();
    await worker.idle();
    expect(rec.batches).toEqual([
      { tripId: TRIP_A, days: ["2026-09-01"] },
      { tripId: TRIP_B, days: ["2026-10-01"] },
    ]);
  });

  it("marks arriving while a batch drains open a FRESH window — nothing lost", async () => {
    const fake = fakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rec = recordingRecompute(() => gate);
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });

    worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }]);
    fake.fireAll(); // batch 1 in flight (held by the gate)
    worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-02" }]); // during drain
    expect(fake.count).toBe(1); // new window opened

    release();
    fake.fireAll();
    await worker.idle();
    expect(rec.batches).toEqual([
      { tripId: TRIP_A, days: ["2026-09-01"] },
      { tripId: TRIP_A, days: ["2026-09-02"] },
    ]);
  });
});

describe("serial drain — never wedges, never leaks (R-ib-19)", () => {
  it("drains batches ONE at a time", async () => {
    const fake = fakeScheduler();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const rec = recordingRecompute((batch) => {
      order.push(`start:${batch.tripId}`);
      return batch.tripId === TRIP_A
        ? firstGate.then(() => order.push(`end:${TRIP_A}`)).then(() => undefined)
        : Promise.resolve(void order.push(`end:${TRIP_B}`));
    });
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });

    worker.markDaysDirty([
      { tripId: TRIP_A, day: "2026-09-01" },
      { tripId: TRIP_B, day: "2026-10-01" },
    ]);
    fake.fireAll();
    await Promise.resolve(); // let the drain reach the first await
    expect(order).toEqual([`start:${TRIP_A}`]); // B has NOT started — serial

    releaseFirst();
    await worker.idle();
    expect(order).toEqual([`start:${TRIP_A}`, `end:${TRIP_A}`, `start:${TRIP_B}`, `end:${TRIP_B}`]);
  });

  it("a rejecting recompute is logged (redacted) and the drain continues", async () => {
    const fake = fakeScheduler();
    const warnings: string[] = [];
    const rec = recordingRecompute((batch) =>
      batch.tripId === TRIP_A
        ? Promise.reject(new Error("boom with access_token=pk.secret-000"))
        : Promise.resolve(),
    );
    const worker = createTravelLegWorker({
      recompute: rec.recompute,
      scheduler: fake.scheduler,
      logger: { warn: (m) => void warnings.push(m) },
    });

    worker.markDaysDirty([
      { tripId: TRIP_A, day: "2026-09-01" },
      { tripId: TRIP_B, day: "2026-10-01" },
    ]);
    fake.fireAll();
    await worker.idle();

    expect(rec.batches).toHaveLength(2); // B still ran after A failed
    expect(warnings).toHaveLength(1);
    // Redaction: an unknown error logs its NAME only — never its message
    // (which here embeds a token-shaped secret).
    expect(warnings[0]).toContain("Error");
    expect(warnings[0]).not.toContain("pk.secret-000");
  });

  it("markDaysDirty NEVER throws — even against a throwing scheduler and logger", () => {
    const worker = createTravelLegWorker({
      recompute: () => Promise.resolve(),
      scheduler: {
        schedule: () => {
          throw new Error("scheduler down");
        },
        cancel: () => undefined,
      },
      logger: {
        warn: () => {
          throw new Error("logger down too");
        },
      },
    });
    expect(() => worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }])).not.toThrow();
    expect(() => worker.markDaysDirty([])).not.toThrow();
  });

  it("stop() cancels pending windows and drops marks; later marks are ignored", async () => {
    const fake = fakeScheduler();
    const rec = recordingRecompute();
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });

    worker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }]);
    worker.stop();
    expect(fake.count).toBe(0); // window cancelled
    worker.markDaysDirty([{ tripId: TRIP_B, day: "2026-10-01" }]);
    fake.fireAll();
    await worker.idle();
    expect(rec.batches).toHaveLength(0);
  });
});

describe("createDirtyDayMarker seam arms (dirty-days.ts, internals filled)", () => {
  it("live arm forwards marks to the worker", async () => {
    const fake = fakeScheduler();
    const rec = recordingRecompute();
    const worker = createTravelLegWorker({ recompute: rec.recompute, scheduler: fake.scheduler });
    const marker = createDirtyDayMarker(worker);

    marker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }]);
    fake.fireAll();
    await worker.idle();
    expect(rec.batches).toEqual([{ tripId: TRIP_A, days: ["2026-09-01"] }]);
  });

  it("live arm swallows a throwing worker (never-throws at the seam)", () => {
    const marker = createDirtyDayMarker({
      markDaysDirty: () => {
        throw new Error("worker exploded");
      },
    });
    expect(() => marker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }])).not.toThrow();
  });

  it("dormant arm (no worker) accepts and drops marks", () => {
    const marker = createDirtyDayMarker();
    expect(() => marker.markDaysDirty([{ tripId: TRIP_A, day: "2026-09-01" }])).not.toThrow();
  });
});

describe("safeErrorLabel redaction", () => {
  it("passes sanitized ProviderRequestError messages through; redacts everything else", () => {
    expect(safeErrorLabel(new ProviderRequestError("mapbox", "HTTP 401"))).toBe(
      "mapbox routing request failed: HTTP 401",
    );
    const leaky = new Error("https://api.mapbox.com/?access_token=pk.leak");
    expect(safeErrorLabel(leaky)).toBe("Error");
    expect(safeErrorLabel("string throw")).toBe("unknown error");
  });
});
