/**
 * Last-used-zone ladder (B-9) — rungs 3 and 4 of the zone default.
 *
 * The store's whole job is "the next form in THIS trip opens where the last
 * one left off", so the discriminating pins are the per-trip isolation and
 * the device-zone floor — not the setter.
 */
import { defaultZoneFor, rememberTripZone, useLastZoneStore } from "./last-zone-store";
import { deviceTimeZone, isKnownTimeZone } from "./zoned-time";

const TRIP_A = "trip-a";
const TRIP_B = "trip-b";

afterEach(() => {
  useLastZoneStore.getState().reset();
});

describe("defaultZoneFor", () => {
  it("falls back to the DEVICE zone before anything is remembered", () => {
    const fallback = defaultZoneFor(TRIP_A);
    expect(fallback).toBe(deviceTimeZone());
    // The floor must always be composable — a zone the device can't resolve
    // would make every new form's default un-stampable.
    expect(isKnownTimeZone(fallback)).toBe(true);
  });

  it("returns the last zone this trip's forms submitted", () => {
    rememberTripZone(TRIP_A, "Asia/Tokyo");
    expect(defaultZoneFor(TRIP_A)).toBe("Asia/Tokyo");
    // Last write wins — a flight's ARRIVAL zone is where the next leg starts.
    rememberTripZone(TRIP_A, "America/Los_Angeles");
    expect(defaultZoneFor(TRIP_A)).toBe("America/Los_Angeles");
  });

  it("is scoped PER TRIP — a Tokyo trip never seeds a Lisbon trip's form", () => {
    // The pin that makes the trip key load-bearing: drop it and this reds.
    rememberTripZone(TRIP_A, "Asia/Tokyo");
    expect(defaultZoneFor(TRIP_B)).toBe(deviceTimeZone());
    rememberTripZone(TRIP_B, "Europe/Lisbon");
    expect(defaultZoneFor(TRIP_A)).toBe("Asia/Tokyo");
    expect(defaultZoneFor(TRIP_B)).toBe("Europe/Lisbon");
  });
});

describe("rememberTripZone", () => {
  it("ignores an EMPTY zone — an unzoned save must not erase a good default", () => {
    // `""` is the honest "not known" value for a legacy row; recording it
    // would make the next form open unset for no reason.
    rememberTripZone(TRIP_A, "Asia/Tokyo");
    rememberTripZone(TRIP_A, "");
    expect(defaultZoneFor(TRIP_A)).toBe("Asia/Tokyo");
    expect(useLastZoneStore.getState().zonesByTrip).toEqual({ [TRIP_A]: "Asia/Tokyo" });
  });

  it("reset clears every trip (the suite seam)", () => {
    rememberTripZone(TRIP_A, "Asia/Tokyo");
    rememberTripZone(TRIP_B, "Europe/Lisbon");
    useLastZoneStore.getState().reset();
    expect(useLastZoneStore.getState().zonesByTrip).toEqual({});
  });
});
