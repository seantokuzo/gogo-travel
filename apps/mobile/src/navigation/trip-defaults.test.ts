/**
 * §2.5 default-tab rules (T-6.6 / NAV-3; R-nav-7/8). `tripIsActive` needs
 * BOTH the server's effective status AND the local-tz date window — either
 * alone must not open the today tab.
 */
import { initialTabFor, isTripActive, localTodayISO } from "./trip-defaults";

const TODAY = "2026-07-26";

function fields(status: "planning" | "active" | "past", start: string, end: string) {
  return { status, start_date: start, end_date: end } as const;
}

describe("isTripActive (§2.5 — both conditions, not either)", () => {
  it("active status + today inside the window → active", () => {
    expect(isTripActive(fields("active", "2026-07-25", "2026-07-28"), TODAY)).toBe(true);
  });

  it("boundary days are INSIDE the window (deriveTripStatus is inclusive)", () => {
    expect(isTripActive(fields("active", TODAY, TODAY), TODAY)).toBe(true);
  });

  it("status says active but the local date window disagrees → not active", () => {
    // e.g. the server evaluated a different day than the device tz.
    expect(isTripActive(fields("active", "2026-07-27", "2026-07-30"), TODAY)).toBe(false);
  });

  it("window contains today but the owner override says past → not active", () => {
    // status is EFFECTIVE (override wins, R-db-19) — an archived trip never
    // counts as active no matter its dates.
    expect(isTripActive(fields("past", "2026-07-25", "2026-07-28"), TODAY)).toBe(false);
  });
});

describe("initialTabFor (R-nav-7/8)", () => {
  it("active trip → today", () => {
    expect(initialTabFor(fields("active", "2026-07-25", "2026-07-28"), TODAY)).toBe("today");
  });

  it("planning trip → itinerary", () => {
    expect(initialTabFor(fields("planning", "2026-08-10", "2026-08-17"), TODAY)).toBe("itinerary");
  });

  it("past trip → itinerary", () => {
    expect(initialTabFor(fields("past", "2026-06-01", "2026-06-08"), TODAY)).toBe("itinerary");
  });
});

describe("localTodayISO", () => {
  it("formats the device-local date as YYYY-MM-DD", () => {
    expect(localTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    expect(localTodayISO()).toBe(
      `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    );
  });
});
