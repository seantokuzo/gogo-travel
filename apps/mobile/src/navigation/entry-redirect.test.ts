/**
 * Entry-redirect resolver unit tests (T-6.6 / NAV-3; §2.2 ladder). The pure
 * decision — the flow-level proof against the real tree lives in
 * src/__tests__/entry-redirect-flow.test.tsx.
 */
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
} from "@/test-utils/trip-fixtures";
import { localTodayISO } from "./trip-defaults";

import { resolveEntryTarget } from "./entry-redirect";

const today = localTodayISO();

describe("resolveEntryTarget (§2.2)", () => {
  it("R-nav-5: no trips at all → trip list", () => {
    expect(resolveEntryTarget([], null, today)).toBe("/(trips)");
  });

  it("R-nav-5: trips exist but none active → trip list", () => {
    const trips = [makePlanningTrip(TEST_TRIP_ID), makePastTrip(TRIP_B_ID)];
    expect(resolveEntryTarget(trips, null, today)).toBe("/(trips)");
  });

  it("R-nav-6: exactly one active trip → its today tab", () => {
    const trips = [makePlanningTrip(TEST_TRIP_ID), makeActiveTrip(TRIP_B_ID)];
    expect(resolveEntryTarget(trips, null, today)).toBe(`/${TRIP_B_ID}/today`);
  });

  it("R-nav-6: a single active trip ignores a stale stamp for another trip", () => {
    const trips = [makeActiveTrip(TRIP_B_ID)];
    const stamp = { tripId: TEST_TRIP_ID, viewedAt: 1 };
    expect(resolveEntryTarget(trips, stamp, today)).toBe(`/${TRIP_B_ID}/today`);
  });

  it("R-nav-23: 2+ active → the most-recently-viewed active trip's today tab", () => {
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    const stamp = { tripId: TRIP_C_ID, viewedAt: 123 };
    expect(resolveEntryTarget(trips, stamp, today)).toBe(`/${TRIP_C_ID}/today`);
  });

  it("R-nav-23: 2+ active, never viewed → trip list", () => {
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    expect(resolveEntryTarget(trips, null, today)).toBe("/(trips)");
  });

  it("R-nav-23: 2+ active, stamp points OUTSIDE the active set → trip list", () => {
    // A stamp for a no-longer-active (or other-account) trip ranks nothing —
    // same outcome as never-viewed; never navigate blindly into the stamp.
    const trips = [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)];
    const stamp = { tripId: TEST_TRIP_ID, viewedAt: 999 };
    expect(resolveEntryTarget(trips, stamp, today)).toBe("/(trips)");
  });
});
