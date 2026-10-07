/**
 * Entry-redirect resolver unit tests (T-6.6 / NAV-3; §2.2 ladder). The pure
 * decision — the flow-level proof against the real tree lives in
 * src/__tests__/entry-redirect-flow.test.tsx.
 *
 * B-30: "active" is judged per trip at ITS destination day (`isTripActive`),
 * so the resolver takes an INSTANT, not a precomputed date.
 */
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  makeTrip,
} from "@/test-utils/trip-fixtures";

import { resolveEntryTarget } from "./entry-redirect";

const now = new Date();

describe("resolveEntryTarget (§2.2)", () => {
  it("R-nav-5: no trips at all → trip list", () => {
    expect(resolveEntryTarget([], null, now)).toBe("/(trips)");
  });

  it("R-nav-5: trips exist but none active → trip list", () => {
    const trips = [makePlanningTrip(TEST_TRIP_ID), makePastTrip(TRIP_B_ID)];
    expect(resolveEntryTarget(trips, null, now)).toBe("/(trips)");
  });

  it("R-nav-6: exactly one active trip → its today tab", () => {
    const trips = [makePlanningTrip(TEST_TRIP_ID), makeActiveTrip(TRIP_B_ID)];
    expect(resolveEntryTarget(trips, null, now)).toBe(`/${TRIP_B_ID}/today`);
  });

  it("R-nav-6: a single active trip ignores a stale stamp for another trip", () => {
    const trips = [makeActiveTrip(TRIP_B_ID)];
    const stamp = { tripId: TEST_TRIP_ID, viewedAt: 1 };
    expect(resolveEntryTarget(trips, stamp, now)).toBe(`/${TRIP_B_ID}/today`);
  });

  it("R-nav-23: 2+ active → the most-recently-viewed active trip's today tab", () => {
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    const stamp = { tripId: TRIP_C_ID, viewedAt: 123 };
    expect(resolveEntryTarget(trips, stamp, now)).toBe(`/${TRIP_C_ID}/today`);
  });

  it("R-nav-23: 2+ active, never viewed → trip list", () => {
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    expect(resolveEntryTarget(trips, null, now)).toBe("/(trips)");
  });

  it("R-nav-23: 2+ active, stamp points OUTSIDE the active set → trip list", () => {
    // A stamp for a no-longer-active (or other-account) trip ranks nothing —
    // same outcome as never-viewed; never navigate blindly into the stamp.
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    const stamp = { tripId: TEST_TRIP_ID, viewedAt: 999 };
    expect(resolveEntryTarget(trips, stamp, now)).toBe("/(trips)");
  });
});

describe("resolveEntryTarget — active is judged PER TRIP at its destination day (B-30)", () => {
  /** A trip whose single-day window is Aug 2; `status: "active"` is the server's verdict. */
  const augSecond = (id: string, destination_tz: string) =>
    makeTrip({
      id,
      destination_tz,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      status: "active",
    });

  it("one instant, two zones: Tokyo's trip is active (Aug 2) while Los Angeles's (still Aug 1) is not → a single active trip redirects to Tokyo's today tab", () => {
    const instant = new Date("2026-08-01T20:00:00.000Z");
    const trips = [augSecond(TRIP_B_ID, "America/Los_Angeles"), augSecond(TRIP_C_ID, "Asia/Tokyo")];
    expect(resolveEntryTarget(trips, null, instant)).toBe(`/${TRIP_C_ID}/today`);
    // Falsification: judge every trip at one `today` (device-local or UTC) →
    // both or neither are active, and this either lands on the trip list
    // (2 active, never viewed) or on the wrong trip.
  });

  it("west of UTC: the evening-of-the-last-day trip is still active in Los Angeles after UTC has rolled over", () => {
    const instant = new Date("2026-08-02T03:00:00.000Z"); // Aug 1, 20:00 PDT
    const lastDay = makeTrip({
      id: TRIP_B_ID,
      destination_tz: "America/Los_Angeles",
      start_date: "2026-07-30",
      end_date: "2026-08-01",
      status: "active",
    });
    expect(resolveEntryTarget([lastDay], null, instant)).toBe(`/${TRIP_B_ID}/today`);
    // …and one ms past LA midnight it is not.
    expect(resolveEntryTarget([lastDay], null, new Date("2026-08-02T07:00:00.000Z"))).toBe(
      "/(trips)",
    );
  });

  it("two trips on different calendar days can BOTH be active; the stamp then picks between them", () => {
    const instant = new Date("2026-08-01T20:00:00.000Z");
    const trips = [
      makeTrip({
        id: TRIP_B_ID,
        destination_tz: "Asia/Tokyo",
        start_date: "2026-08-02",
        end_date: "2026-08-02",
        status: "active",
      }),
      makeTrip({
        id: TRIP_C_ID,
        destination_tz: "America/Los_Angeles",
        start_date: "2026-08-01",
        end_date: "2026-08-01",
        status: "active",
      }),
    ];
    expect(resolveEntryTarget(trips, { tripId: TRIP_C_ID, viewedAt: 1 }, instant)).toBe(
      `/${TRIP_C_ID}/today`,
    );
    expect(resolveEntryTarget(trips, null, instant)).toBe("/(trips)");
  });
});
