/**
 * §2.5 default-tab rules (T-6.6 / NAV-3; R-nav-7/8). `tripIsActive` needs
 * BOTH the server's effective status AND the date window — either alone must
 * not open the today tab. B-30 (Sean ruling 2026-09-19): the window is
 * evaluated at the trip's DESTINATION day (`todayInZone(now, destination_tz)`),
 * never the device's. Every case injects an explicit instant; nothing here
 * reads the real clock or depends on the host zone (the PR runs the suite
 * under several `TZ=` values).
 *
 * Falsification for the boundary table: make `tripTodayISO` / `isTripActive`
 * read the DEVICE day (`localTodayISO()`) → the east/west rows go red on any
 * host whose zone differs from the row's.
 */
import { initialTabFor, isTripActive, localTodayISO, tripTodayISO } from "./trip-defaults";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function fields(
  status: "planning" | "active" | "past",
  start: string,
  end: string,
  destination_tz = "UTC",
) {
  return { status, start_date: start, end_date: end, destination_tz } as const;
}

describe("isTripActive (§2.5 — both conditions, not either)", () => {
  it("active status + today inside the window → active", () => {
    expect(isTripActive(fields("active", "2026-07-25", "2026-07-28"), NOW)).toBe(true);
  });

  it("boundary days are INSIDE the window (deriveTripStatus is inclusive)", () => {
    expect(isTripActive(fields("active", "2026-07-26", "2026-07-26"), NOW)).toBe(true);
  });

  it("status says active but the date window disagrees → not active", () => {
    expect(isTripActive(fields("active", "2026-07-27", "2026-07-30"), NOW)).toBe(false);
  });

  it("window contains today but the owner override says past → not active", () => {
    // status is EFFECTIVE (override wins, R-db-19) — an archived trip never
    // counts as active no matter its dates.
    expect(isTripActive(fields("past", "2026-07-25", "2026-07-28"), NOW)).toBe(false);
  });

  it("window contains today but the status says planning → not active (status is the other half)", () => {
    expect(isTripActive(fields("planning", "2026-07-25", "2026-07-28"), NOW)).toBe(false);
  });
});

describe("initialTabFor (R-nav-7/8)", () => {
  it("active trip → today", () => {
    expect(initialTabFor(fields("active", "2026-07-25", "2026-07-28"), NOW)).toBe("today");
  });

  it("planning trip → itinerary", () => {
    expect(initialTabFor(fields("planning", "2026-08-10", "2026-08-17"), NOW)).toBe("itinerary");
  });

  it("past trip → itinerary", () => {
    expect(initialTabFor(fields("past", "2026-06-01", "2026-06-08"), NOW)).toBe("itinerary");
  });
});

/**
 * One row = (zone, instant, window) → does the window hold at the
 * DESTINATION's day? `status` is "active" throughout so the date window is
 * the only variable (the server's verdict is presumed correct; the client
 * re-checks the window).
 */
const BOUNDARY_ROWS: readonly {
  label: string;
  tz: string;
  now: string;
  start: string;
  end: string;
  inWindow: boolean;
}[] = [
  // ---- east of UTC: the destination's day runs AHEAD of UTC's and the device's
  {
    label: "Tokyo is already Aug 2 while UTC and Los Angeles are Aug 1 (the B-30 repro)",
    tz: "Asia/Tokyo",
    now: "2026-08-01T20:00:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: true,
  },
  {
    label: "one ms before Tokyo midnight the window has not opened",
    tz: "Asia/Tokyo",
    now: "2026-08-01T14:59:59.999Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: false,
  },
  {
    label: "at Tokyo midnight the window opens",
    tz: "Asia/Tokyo",
    now: "2026-08-01T15:00:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: true,
  },
  {
    label: "UTC+14 (Kiritimati) opens its Aug 2 at 10:00Z",
    tz: "Pacific/Kiritimati",
    now: "2026-08-01T10:00:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: true,
  },
  {
    label: "UTC+14 (Kiritimati) one ms earlier is still Aug 1",
    tz: "Pacific/Kiritimati",
    now: "2026-08-01T09:59:59.999Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: false,
  },
  // ---- west of UTC: the destination's day runs BEHIND UTC's
  {
    label: "Los Angeles is still Aug 1 after UTC rolled to Aug 2 (west-of-UTC pin)",
    tz: "America/Los_Angeles",
    now: "2026-08-02T03:00:00.000Z",
    start: "2026-07-30",
    end: "2026-08-01",
    inWindow: true,
  },
  {
    label: "one ms before LA midnight the last day still counts",
    tz: "America/Los_Angeles",
    now: "2026-08-02T06:59:59.999Z",
    start: "2026-07-30",
    end: "2026-08-01",
    inWindow: true,
  },
  {
    label: "at LA midnight the window is over",
    tz: "America/Los_Angeles",
    now: "2026-08-02T07:00:00.000Z",
    start: "2026-07-30",
    end: "2026-08-01",
    inWindow: false,
  },
  {
    label: "UTC-12 (Etc/GMT+12) is still Aug 1 until 12:00Z",
    tz: "Etc/GMT+12",
    now: "2026-08-02T11:59:59.999Z",
    start: "2026-08-01",
    end: "2026-08-01",
    inWindow: true,
  },
  {
    label: "UTC-12 (Etc/GMT+12) is Aug 2 from 12:00Z",
    tz: "Etc/GMT+12",
    now: "2026-08-02T12:00:00.000Z",
    start: "2026-08-01",
    end: "2026-08-01",
    inWindow: false,
  },
  // ---- DST edges (America/New_York 2026: spring forward Mar 8, fall back Nov 1)
  {
    label: "spring-forward day (23h): Mar 8 ends at 04:00Z, not 05:00Z",
    tz: "America/New_York",
    now: "2026-03-09T03:59:59.999Z",
    start: "2026-03-08",
    end: "2026-03-08",
    inWindow: true,
  },
  {
    label: "…and Mar 9 starts at 04:00Z",
    tz: "America/New_York",
    now: "2026-03-09T04:00:00.000Z",
    start: "2026-03-08",
    end: "2026-03-08",
    inWindow: false,
  },
  {
    label: "fall-back day (25h): Nov 1 still holds one ms before 05:00Z the next day",
    tz: "America/New_York",
    now: "2026-11-02T04:59:59.999Z",
    start: "2026-11-01",
    end: "2026-11-01",
    inWindow: true,
  },
  // ---- half-hour offset + tzdb backward link
  {
    label: "Asia/Calcutta (a backward link, UTC+5:30) opens Aug 2 at 18:30Z",
    tz: "Asia/Calcutta",
    now: "2026-08-01T18:30:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: true,
  },
  {
    label: "…and not a minute earlier",
    tz: "Asia/Calcutta",
    now: "2026-08-01T18:29:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: false,
  },
  // ---- adversarial: an unusable zone degrades to UTC, never a throw
  {
    label: "an unknown zone id degrades to the UTC day (Aug 1 here)",
    tz: "Not/AZone",
    now: "2026-08-01T20:00:00.000Z",
    start: "2026-08-01",
    end: "2026-08-01",
    inWindow: true,
  },
  {
    label: "…so a window that is only true at Tokyo's Aug 2 is false for it",
    tz: "Not/AZone",
    now: "2026-08-01T20:00:00.000Z",
    start: "2026-08-02",
    end: "2026-08-02",
    inWindow: false,
  },
];

describe("isTripActive / initialTabFor — the window holds at the DESTINATION day (B-30)", () => {
  it.each(BOUNDARY_ROWS)("$label", ({ tz, now, start, end, inWindow }) => {
    const trip = fields("active", start, end, tz);
    expect(isTripActive(trip, new Date(now))).toBe(inWindow);
    expect(initialTabFor(trip, new Date(now))).toBe(inWindow ? "today" : "itinerary");
  });

  it("the SAME instant is a different day for different trips — judged per trip, not once per device", () => {
    const now = new Date("2026-08-01T20:00:00.000Z");
    const tokyo = fields("active", "2026-08-02", "2026-08-02", "Asia/Tokyo");
    const losAngeles = fields("active", "2026-08-02", "2026-08-02", "America/Los_Angeles");
    expect(isTripActive(tokyo, now)).toBe(true); // Aug 2 in Tokyo
    expect(isTripActive(losAngeles, now)).toBe(false); // Aug 1 in LA
    // Falsification: evaluate one `today` for both (device-local or UTC) → one of these flips.
  });
});

describe("tripTodayISO (B-30)", () => {
  it("is the destination zone's calendar day at the instant", () => {
    expect(tripTodayISO({ destination_tz: "Asia/Tokyo" }, new Date("2026-08-01T20:00:00Z"))).toBe(
      "2026-08-02",
    );
    expect(
      tripTodayISO({ destination_tz: "America/Los_Angeles" }, new Date("2026-08-02T03:00:00Z")),
    ).toBe("2026-08-01");
  });
});

describe("localTodayISO (device-local — NOT the trip-status clock since B-30)", () => {
  it("formats the device-local date as YYYY-MM-DD", () => {
    expect(localTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    expect(localTodayISO()).toBe(
      `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    );
  });
});
