/**
 * Unit suite for the status reconciliation seam (trips spec §3.4, R-trips-7).
 * The write path (`reconcileStoredStatuses` against real rows, `updated_at`
 * preservation) runs in `routes.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { effectiveTripStatus, todayUtc } from "./status.js";

const trip = (
  statusOverride: "planning" | "active" | "past" | null,
  startDate = "2026-08-01",
  endDate = "2026-08-10",
) => ({ statusOverride, startDate, endDate });

describe("effectiveTripStatus (override wins until cleared — §3.4, Gate 2)", () => {
  it("derives from dates when no override is set", () => {
    expect(effectiveTripStatus(trip(null), "2026-07-25")).toBe("planning");
    expect(effectiveTripStatus(trip(null), "2026-08-05")).toBe("active");
    expect(effectiveTripStatus(trip(null), "2026-08-11")).toBe("past");
  });

  it("the manual override beats the derived value in every direction", () => {
    // "Archive" mid-trip: override to 'past' while dates say active.
    expect(effectiveTripStatus(trip("past"), "2026-08-05")).toBe("past");
    // Un-archive-style override to planning after the trip ended.
    expect(effectiveTripStatus(trip("planning"), "2026-09-01")).toBe("planning");
    expect(effectiveTripStatus(trip("active"), "2026-07-01")).toBe("active");
  });

  it("clearing the override (null) resumes derivation", () => {
    expect(effectiveTripStatus(trip(null), "2026-09-01")).toBe("past");
  });

  it("boundary days are inclusive (same shared helper as the client — §3.4)", () => {
    expect(effectiveTripStatus(trip(null), "2026-08-01")).toBe("active");
    expect(effectiveTripStatus(trip(null), "2026-08-10")).toBe("active");
  });
});

describe("todayUtc", () => {
  it("is the UTC calendar date of the injected clock", () => {
    expect(todayUtc(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08-01");
    // 23:59 UTC is still the same UTC day regardless of host tz.
    expect(todayUtc(new Date("2026-08-01T23:59:59.999Z"))).toBe("2026-08-01");
  });
});
