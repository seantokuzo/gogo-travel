/**
 * Unit suite for the destination-zone chain (B-30; `destination-tz.ts`).
 * DB-free: the booking-zone query and the routes' use of the chain are
 * exercised against real Postgres in `destination-tz.db.test.ts`; the
 * tz-lookup vs geo-tz accuracy gate is `destination-tz.accuracy.test.ts`.
 *
 * Falsification is stated per group; each was exercised (PR body).
 */
import { describe, expect, it } from "vitest";
import {
  deriveZoneFromCoords,
  resolveDestinationTz,
  storedDestinationTz,
  type BookingZones,
} from "./destination-tz.js";

const KYOTO = { lat: 35.0116, lng: 135.7681 };
const LOS_ANGELES = { lat: 34.0522, lng: -118.2437 };

const booking = (arrivesTz: string | null, departsTz: string | null = null): BookingZones => ({
  arrivesTz,
  departsTz,
});

describe("deriveZoneFromCoords (chain step 2)", () => {
  it("maps real coordinates to the destination's IANA zone", () => {
    expect(deriveZoneFromCoords(KYOTO.lat, KYOTO.lng)).toBe("Asia/Tokyo");
    expect(deriveZoneFromCoords(LOS_ANGELES.lat, LOS_ANGELES.lng)).toBe("America/Los_Angeles");
    expect(deriveZoneFromCoords(38.722252, -9.139337)).toBe("Europe/Lisbon");
    expect(deriveZoneFromCoords(-33.8688, 151.2093)).toBe("Australia/Sydney");
  });

  it("no coordinates → null (a coordinate-less custom destination derives nothing)", () => {
    expect(deriveZoneFromCoords(null, null)).toBeNull();
    expect(deriveZoneFromCoords(35, null)).toBeNull();
    expect(deriveZoneFromCoords(null, 139)).toBeNull();
  });

  it("hostile coordinates never throw: NaN / out-of-range → null (tz-lookup throws RangeError; we swallow it)", () => {
    expect(deriveZoneFromCoords(Number.NaN, 0)).toBeNull();
    expect(deriveZoneFromCoords(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(deriveZoneFromCoords(91, 0)).toBeNull();
    expect(deriveZoneFromCoords(0, -181)).toBeNull();
  });

  it("the poles and the open ocean still resolve to a usable zone (never a throw, never empty)", () => {
    for (const [lat, lng] of [
      [90, 0],
      [-90, 0],
      [0, 0], // Null Island: ocean → an Etc/GMT zone
      [0, 179.99],
      [0, -179.99],
    ] as const) {
      const zone = deriveZoneFromCoords(lat, lng);
      expect(zone, `${lat},${lng}`).toEqual(expect.any(String));
      expect(zone).not.toBe("");
    }
  });
});

describe("storedDestinationTz (write path: chain steps 1–2 only)", () => {
  it("an explicit zone is stored as given, ahead of the coordinates", () => {
    expect(storedDestinationTz({ explicit: "Europe/Paris", ...KYOTO })).toBe("Europe/Paris");
  });

  it("no explicit zone → derived from the coordinates", () => {
    expect(storedDestinationTz({ explicit: undefined, ...KYOTO })).toBe("Asia/Tokyo");
    expect(storedDestinationTz({ explicit: null, ...KYOTO })).toBe("Asia/Tokyo");
  });

  it("nothing storable → null (steps 3–4 NEVER write: no booking / UTC default is ever persisted)", () => {
    expect(storedDestinationTz({ lat: null, lng: null })).toBeNull();
  });
});

describe("resolveDestinationTz (the full chain: explicit → derived → booking → UTC)", () => {
  it("1. a valid explicit zone beats a coordinate derivation and bookings", () => {
    expect(
      resolveDestinationTz({
        explicit: "Pacific/Auckland",
        ...KYOTO,
        bookings: [booking("America/Chicago")],
      }),
    ).toEqual({ zone: "Pacific/Auckland", source: "explicit" });
  });

  it("an INVALID stored/explicit value is skipped, not trusted: falls to the derivation", () => {
    expect(resolveDestinationTz({ explicit: "Not/AZone", ...KYOTO })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
    expect(resolveDestinationTz({ explicit: "+09:00", ...LOS_ANGELES }).zone).toBe(
      "America/Los_Angeles",
    );
  });

  it("2. derived from coordinates when nothing explicit, beating bookings", () => {
    expect(resolveDestinationTz({ ...KYOTO, bookings: [booking("America/Chicago")] })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
  });

  it("3. no coordinates: the EARLIEST booking's arrives_tz (callers pass earliest-first)", () => {
    expect(
      resolveDestinationTz({
        lat: null,
        lng: null,
        bookings: [booking("Asia/Tokyo"), booking("Europe/Paris")],
      }),
    ).toEqual({ zone: "Asia/Tokyo", source: "booking" });
    // Falsification: skip the bookings loop → "UTC" / source "default".
  });

  it("3. arrives_tz first; departs_tz only when arrives_tz is missing or unusable", () => {
    const none = { lat: null, lng: null };
    expect(
      resolveDestinationTz({ ...none, bookings: [booking(null, "America/Chicago")] }).zone,
    ).toBe("America/Chicago");
    expect(
      resolveDestinationTz({ ...none, bookings: [booking("Not/AZone", "America/Chicago")] }).zone,
    ).toBe("America/Chicago");
    expect(
      resolveDestinationTz({ ...none, bookings: [booking("Asia/Tokyo", "America/Chicago")] }).zone,
    ).toBe("Asia/Tokyo");
  });

  it("3. a booking with NO usable zone is skipped — the next booking is consulted", () => {
    expect(
      resolveDestinationTz({
        lat: null,
        lng: null,
        bookings: [booking("Not/AZone", "+05:00"), booking(null, null), booking("Europe/Paris")],
      }),
    ).toEqual({ zone: "Europe/Paris", source: "booking" });
  });

  it("4. nothing at all → UTC, flagged as the default", () => {
    expect(resolveDestinationTz({ lat: null, lng: null })).toEqual({
      zone: "UTC",
      source: "default",
    });
    expect(resolveDestinationTz({ lat: null, lng: null, bookings: [] }).source).toBe("default");
    expect(
      resolveDestinationTz({ lat: null, lng: null, bookings: [booking("Not/AZone", "Also/Bad")] })
        .zone,
    ).toBe("UTC");
  });
});
