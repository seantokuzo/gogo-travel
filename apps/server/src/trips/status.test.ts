/**
 * Unit suite for the status reconciliation seam (trips spec §3.4, R-trips-7).
 * The write path (`reconcileStoredStatuses` against real rows, `updated_at`
 * preservation) runs in `routes.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { effectiveTripStatus, tripToday } from "./status.js";

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

describe("tripToday (B-30 — the calendar day at the trip's DESTINATION, not the server's UTC day)", () => {
  it("is the destination zone's date, not the UTC date, whenever they differ", () => {
    // 2026-08-01T20:00Z: UTC still says Aug 1; Tokyo (UTC+9) is already Aug 2.
    expect(tripToday(new Date("2026-08-01T20:00:00.000Z"), "Asia/Tokyo")).toBe("2026-08-02");
    // 2026-08-02T03:00Z: UTC says Aug 2; Los Angeles (PDT, UTC-7) is still Aug 1.
    expect(tripToday(new Date("2026-08-02T03:00:00.000Z"), "America/Los_Angeles")).toBe(
      "2026-08-01",
    );
    // Falsification: make `tripToday` return the UTC date → both go red.
  });

  it("an unknown or missing zone degrades to the UTC date (never throws)", () => {
    const now = new Date("2026-08-01T20:00:00.000Z");
    expect(tripToday(now, null)).toBe("2026-08-01");
    expect(tripToday(now, undefined)).toBe("2026-08-01");
    expect(tripToday(now, "Not/AZone")).toBe("2026-08-01");
  });

  it("feeds the status rule: the SAME single-day trip is active in Tokyo and still planning in UTC (the B-30 repro)", () => {
    const singleDay = trip(null, "2026-08-02", "2026-08-02");
    const now = new Date("2026-08-01T20:00:00.000Z"); // after 17:00 PDT, before UTC midnight
    expect(effectiveTripStatus(singleDay, tripToday(now, "Asia/Tokyo"))).toBe("active");
    expect(effectiveTripStatus(singleDay, tripToday(now, "UTC"))).toBe("planning");
  });

  it("feeds the status rule west of UTC: a trip ending 'today' in Los Angeles is not yet past", () => {
    const endsToday = trip(null, "2026-07-25", "2026-08-01");
    const now = new Date("2026-08-02T03:00:00.000Z"); // 20:00 PDT on Aug 1
    expect(effectiveTripStatus(endsToday, tripToday(now, "America/Los_Angeles"))).toBe("active");
    expect(effectiveTripStatus(endsToday, tripToday(now, "UTC"))).toBe("past");
  });
});
