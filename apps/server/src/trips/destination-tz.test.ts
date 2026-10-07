/**
 * Unit suite for the destination-zone resolver (B-30; `destination-tz.ts`):
 * the READ chain (user > derived > booking > device > UTC) and the pure WRITE
 * resolver shared by create and PATCH. DB-free: the booking-zone query and the
 * routes' use of both are exercised against real Postgres in
 * `destination-tz.db.test.ts`; the tz-lookup vs geo-tz accuracy gate is
 * `destination-tz.accuracy.test.ts`; the allow-list is `zone-canon.test.ts`.
 *
 * Falsification is stated per group; each was exercised (PR body).
 */
import { describe, expect, it } from "vitest";
import {
  applyZoneWrite,
  deriveZoneFromCoords,
  resolveDestinationTz,
  resolveZoneWrite,
  storedZoneOf,
  type BookingZones,
  type StoredZone,
  type ZoneWrite,
} from "./destination-tz.js";

const KYOTO = { lat: 35.0116, lng: 135.7681 }; // Asia/Tokyo
const LOS_ANGELES = { lat: 34.0522, lng: -118.2437 }; // America/Los_Angeles
const NO_COORDS = { lat: null, lng: null };

const booking = (arrivesTz: string | null, departsTz: string | null = null): BookingZones => ({
  arrivesTz,
  departsTz,
});
const user = (zone: string): StoredZone => ({ zone, source: "user" });
const derivedZone = (zone: string): StoredZone => ({ zone, source: "derived" });
const device = (zone: string): StoredZone => ({ zone, source: "device" });

describe("deriveZoneFromCoords (rank 2)", () => {
  it("maps real coordinates to the destination's IANA zone", () => {
    expect(deriveZoneFromCoords(KYOTO.lat, KYOTO.lng)).toBe("Asia/Tokyo");
    expect(deriveZoneFromCoords(LOS_ANGELES.lat, LOS_ANGELES.lng)).toBe("America/Los_Angeles");
    expect(deriveZoneFromCoords(38.722252, -9.139337)).toBe("Europe/Lisbon");
    expect(deriveZoneFromCoords(-33.8688, 151.2093)).toBe("Australia/Sydney");
  });

  it("no coordinates -> null (a coordinate-less custom destination derives nothing)", () => {
    expect(deriveZoneFromCoords(null, null)).toBeNull();
    expect(deriveZoneFromCoords(35, null)).toBeNull();
    expect(deriveZoneFromCoords(null, 139)).toBeNull();
  });

  it("hostile coordinates never throw: NaN / out-of-range -> null (tz-lookup throws RangeError; we swallow it)", () => {
    expect(deriveZoneFromCoords(Number.NaN, 0)).toBeNull();
    expect(deriveZoneFromCoords(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(deriveZoneFromCoords(91, 0)).toBeNull();
    expect(deriveZoneFromCoords(0, -181)).toBeNull();
  });

  it("the poles and the open ocean still resolve to a usable zone (never a throw, never empty)", () => {
    for (const [lat, lng] of [
      [90, 0],
      [-90, 0],
      [0, 0], // Null Island: ocean -> an Etc/GMT zone
      [0, 179.99],
      [0, -179.99],
    ] as const) {
      const zone = deriveZoneFromCoords(lat, lng);
      expect(zone, `${lat},${lng}`).toEqual(expect.any(String));
      expect(zone).not.toBe("");
    }
  });
});

describe("storedZoneOf (the row's stored pair)", () => {
  it("reads a valid pair; nothing stored, half a pair, or an unknown source -> null", () => {
    expect(storedZoneOf({ destinationTz: "Asia/Tokyo", destinationTzSource: "user" })).toEqual(
      user("Asia/Tokyo"),
    );
    expect(storedZoneOf({ destinationTz: "Asia/Tokyo", destinationTzSource: "derived" })).toEqual(
      derivedZone("Asia/Tokyo"),
    );
    expect(storedZoneOf({ destinationTz: "Asia/Tokyo", destinationTzSource: "device" })).toEqual(
      device("Asia/Tokyo"),
    );
    expect(storedZoneOf({ destinationTz: null, destinationTzSource: null })).toBeNull();
    expect(storedZoneOf({ destinationTz: "Asia/Tokyo", destinationTzSource: null })).toBeNull();
    expect(storedZoneOf({ destinationTz: null, destinationTzSource: "user" })).toBeNull();
    // 'booking' / 'default' are read-time sources: never a stored value.
    expect(
      storedZoneOf({ destinationTz: "Asia/Tokyo", destinationTzSource: "booking" }),
    ).toBeNull();
  });
});

describe("resolveDestinationTz — the READ chain: user > derived > booking > device > UTC", () => {
  const withEverything = {
    ...KYOTO,
    bookings: [booking("Europe/Paris")],
  };

  it("rank 1: a stored USER zone beats coordinates, bookings and a device hint", () => {
    expect(resolveDestinationTz({ stored: user("Pacific/Auckland"), ...withEverything })).toEqual({
      zone: "Pacific/Auckland",
      source: "user",
    });
    // Falsification: rank derived above user -> Asia/Tokyo, red.
  });

  it("rank 2: a stored DERIVED zone beats a booking zone and is served as stored", () => {
    expect(resolveDestinationTz({ stored: derivedZone("Asia/Tokyo"), ...withEverything })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
    // Served AS STORED (stable across a tz-lookup upgrade), even if live derivation now differs.
    expect(resolveDestinationTz({ stored: derivedZone("Pacific/Auckland"), ...KYOTO })).toEqual({
      zone: "Pacific/Auckland",
      source: "derived",
    });
  });

  it("rank 2 (lazy): nothing stored but coordinates -> derived live (a legacy NULL row), beating bookings", () => {
    expect(resolveDestinationTz({ stored: null, ...withEverything })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
  });

  it("rank 3: no coordinates -> the booking zone, which BEATS a stored device hint", () => {
    expect(
      resolveDestinationTz({
        stored: device("America/Los_Angeles"),
        ...NO_COORDS,
        bookings: [booking("Asia/Tokyo")],
      }),
    ).toEqual({ zone: "Asia/Tokyo", source: "booking" });
    // Falsification: rank device above booking -> America/Los_Angeles, red (the PR #99 round-1 F1 scenario).
  });

  it("rank 3: arrives_tz first; departs_tz only when arrives_tz is missing or off the allow-list; an unusable booking is skipped", () => {
    const resolve = (...bookings: BookingZones[]) =>
      resolveDestinationTz({ stored: null, ...NO_COORDS, bookings }).zone;
    expect(resolve(booking(null, "America/Chicago"))).toBe("America/Chicago");
    expect(resolve(booking("Not/AZone", "America/Chicago"))).toBe("America/Chicago");
    expect(resolve(booking("Asia/Tokyo", "America/Chicago"))).toBe("Asia/Tokyo");
    expect(
      resolve(booking("SystemV/AST4", "+05:00"), booking(null, null), booking("Europe/Paris")),
    ).toBe("Europe/Paris");
  });

  it("rank 3: booking zones are canonicalised (lowercase asia/tokyo is served as Asia/Tokyo)", () => {
    expect(
      resolveDestinationTz({ stored: null, ...NO_COORDS, bookings: [booking("asia/tokyo")] }),
    ).toEqual({ zone: "Asia/Tokyo", source: "booking" });
  });

  it("rank 4: a stored DEVICE hint is used only when no coordinates derive and no booking zone exists", () => {
    expect(
      resolveDestinationTz({ stored: device("America/Los_Angeles"), ...NO_COORDS, bookings: [] }),
    ).toEqual({ zone: "America/Los_Angeles", source: "device" });
    expect(
      resolveDestinationTz({
        stored: device("America/Los_Angeles"),
        ...NO_COORDS,
        bookings: [booking("Not/AZone")],
      }),
    ).toEqual({ zone: "America/Los_Angeles", source: "device" });
  });

  it("a stored device hint never outranks coordinates (derived wins)", () => {
    expect(resolveDestinationTz({ stored: device("America/Los_Angeles"), ...KYOTO })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
  });

  it("rank 5: nothing at all -> UTC flagged 'default'", () => {
    expect(resolveDestinationTz({ stored: null, ...NO_COORDS })).toEqual({
      zone: "UTC",
      source: "default",
    });
    expect(
      resolveDestinationTz({
        stored: null,
        ...NO_COORDS,
        bookings: [booking("Not/AZone", "Also/Bad")],
      }),
    ).toEqual({ zone: "UTC", source: "default" });
  });

  it("a CORRUPT stored zone (off the allow-list) is skipped, never trusted: user -> falls to coordinates; device -> UTC", () => {
    expect(resolveDestinationTz({ stored: user("SystemV/AST4"), ...KYOTO })).toEqual({
      zone: "Asia/Tokyo",
      source: "derived",
    });
    expect(resolveDestinationTz({ stored: device("Japan"), ...NO_COORDS })).toEqual({
      zone: "UTC",
      source: "default",
    });
  });
});

describe("resolveZoneWrite — the pure WRITE resolver (create AND PATCH)", () => {
  const write = (
    input: Partial<Parameters<typeof resolveZoneWrite>[0]> & {
      body?: Parameters<typeof resolveZoneWrite>[0]["body"];
    },
  ) =>
    resolveZoneWrite({
      current: null,
      body: {},
      ...NO_COORDS,
      coordsMoved: false,
      ...input,
    });
  const set = (zone: StoredZone): { ok: true; write: ZoneWrite } => ({
    ok: true,
    write: { kind: "set", zone },
  });
  const UNTOUCHED = { ok: true, write: { kind: "untouched" } } as const;
  const CLEAR = { ok: true, write: { kind: "clear" } } as const;

  describe("create (current null, coordsMoved true)", () => {
    const create = (
      body: Parameters<typeof resolveZoneWrite>[0]["body"],
      coords: { lat: number | null; lng: number | null },
    ) => write({ current: null, body, ...coords, coordsMoved: true });

    it("coordinates derive -> stored 'derived'", () => {
      expect(create({}, KYOTO)).toEqual(set(derivedZone("Asia/Tokyo")));
    });

    it("a user zone wins over the derivation and is stored canonical as 'user' (source absent defaults to user)", () => {
      expect(create({ zone: "Pacific/Auckland" }, KYOTO)).toEqual(set(user("Pacific/Auckland")));
      expect(create({ zone: "asia/tokyo", source: "user" }, NO_COORDS)).toEqual(
        set(user("Asia/Tokyo")),
      );
    });

    it("an unlisted USER zone is rejected (ok:false -> 400)", () => {
      for (const zone of ["Mars/Phobos", "SystemV/AST4", "Japan", "EST", "", "+09:00"]) {
        expect([zone, create({ zone }, KYOTO)]).toEqual([zone, { ok: false }]);
        expect([zone, create({ zone, source: "user" }, NO_COORDS)]).toEqual([zone, { ok: false }]);
      }
    });

    it("a device hint on a coordinate-less create is stored as 'device'", () => {
      expect(create({ zone: "America/Los_Angeles", source: "device" }, NO_COORDS)).toEqual(
        set(device("America/Los_Angeles")),
      );
    });

    it("a device hint is IGNORED when coordinates derive (derived outranks device) — never a 400", () => {
      expect(create({ zone: "America/Los_Angeles", source: "device" }, KYOTO)).toEqual(
        set(derivedZone("Asia/Tokyo")),
      );
    });

    it("an UNUSABLE device hint is treated as absent: coordless -> nothing stored; coords -> derived", () => {
      for (const zone of ["Not/AZone", "SystemV/AST4", "GMT+05:30", ""]) {
        expect([zone, create({ zone, source: "device" }, NO_COORDS)]).toEqual([zone, UNTOUCHED]);
        expect([zone, create({ zone, source: "device" }, KYOTO)]).toEqual([
          zone,
          set(derivedZone("Asia/Tokyo")),
        ]);
      }
      // Falsification: 400 on an unusable device hint -> ok:false, red.
    });

    it("nothing usable at all -> untouched (NULL/NULL; reads fall to booking -> UTC)", () => {
      expect(create({}, NO_COORDS)).toEqual(UNTOUCHED);
    });
  });

  describe("PATCH — durability of a 'user' zone", () => {
    it("a coordinates move NEVER overwrites a user zone (the PR #99 round-1 F4 durability pin)", () => {
      expect(
        write({ current: user("Pacific/Auckland"), ...LOS_ANGELES, coordsMoved: true }),
      ).toEqual(UNTOUCHED);
      expect(write({ current: user("Pacific/Auckland"), ...NO_COORDS, coordsMoved: true })).toEqual(
        UNTOUCHED,
      );
      // Falsification: re-derive whenever coordinates moved (ignore the source) -> set(derived), red.
    });

    it("a device hint never overwrites a user zone either", () => {
      expect(
        write({
          current: user("Pacific/Auckland"),
          body: { zone: "America/Los_Angeles", source: "device" },
          ...NO_COORDS,
          coordsMoved: false,
        }),
      ).toEqual(UNTOUCHED);
    });

    it("a new user zone replaces any current zone", () => {
      for (const current of [null, user("Asia/Tokyo"), derivedZone("Asia/Tokyo"), device("UTC")]) {
        expect(write({ current, body: { zone: "Europe/Paris" }, ...KYOTO })).toEqual(
          set(user("Europe/Paris")),
        );
      }
    });
  });

  describe("PATCH — re-derive on a coordinates move", () => {
    it("derived + coordinates moved to another derivable place -> new derived", () => {
      expect(
        write({ current: derivedZone("Asia/Tokyo"), ...LOS_ANGELES, coordsMoved: true }),
      ).toEqual(set(derivedZone("America/Los_Angeles")));
    });

    it("derived + moved to coordinate-less (no hint) -> the derived zone is CLEARED (the old zone described the old place)", () => {
      expect(
        write({ current: derivedZone("Asia/Tokyo"), ...NO_COORDS, coordsMoved: true }),
      ).toEqual(CLEAR);
    });

    it("derived + moved to coordinate-less WITH a device hint -> device", () => {
      expect(
        write({
          current: derivedZone("Asia/Tokyo"),
          body: { zone: "America/Los_Angeles", source: "device" },
          ...NO_COORDS,
          coordsMoved: true,
        }),
      ).toEqual(set(device("America/Los_Angeles")));
    });

    it("device + coordinates gained (the settings heal) -> derived replaces the device hint", () => {
      expect(
        write({ current: device("America/Los_Angeles"), ...KYOTO, coordsMoved: true }),
      ).toEqual(set(derivedZone("Asia/Tokyo")));
    });

    it("an UNRELATED patch (coordinates not moved by VALUE) leaves every state alone — a legacy NULL row is not written back", () => {
      for (const current of [null, derivedZone("Asia/Tokyo"), device("UTC"), user("Asia/Tokyo")]) {
        expect([current, write({ current, ...KYOTO, coordsMoved: false })]).toEqual([
          current,
          UNTOUCHED,
        ]);
      }
    });

    it("coordless -> coordless (null->null resubmit): a stored device zone survives", () => {
      expect(
        write({ current: device("America/Los_Angeles"), ...NO_COORDS, coordsMoved: false }),
      ).toEqual(UNTOUCHED);
    });
  });

  describe("PATCH — destination_tz: null RESETS to automatic", () => {
    it("clears a user zone and re-derives from the coordinates", () => {
      expect(write({ current: user("Pacific/Auckland"), body: { zone: null }, ...KYOTO })).toEqual(
        set(derivedZone("Asia/Tokyo")),
      );
    });

    it("coordinate-less: clears the pair (reads fall to booking -> UTC)", () => {
      expect(
        write({ current: user("Pacific/Auckland"), body: { zone: null }, ...NO_COORDS }),
      ).toEqual(CLEAR);
      expect(write({ current: null, body: { zone: null }, ...NO_COORDS })).toEqual(CLEAR);
    });

    it("re-derives from the POST-patch coordinates when the same body moves them", () => {
      expect(
        write({
          current: user("Pacific/Auckland"),
          body: { zone: null },
          ...LOS_ANGELES,
          coordsMoved: true,
        }),
      ).toEqual(set(derivedZone("America/Los_Angeles")));
    });
  });

  describe("PATCH — device hint on a coordinate-less trip", () => {
    it("replaces a stored device hint; ignored hint leaves it alone", () => {
      expect(
        write({
          current: device("Europe/Paris"),
          body: { zone: "America/Los_Angeles", source: "device" },
          ...NO_COORDS,
        }),
      ).toEqual(set(device("America/Los_Angeles")));
      expect(
        write({
          current: device("Europe/Paris"),
          body: { zone: "SystemV/AST4", source: "device" },
          ...NO_COORDS,
        }),
      ).toEqual(UNTOUCHED);
    });
  });

  describe("applyZoneWrite", () => {
    it("untouched keeps current; clear -> null; set -> the new pair", () => {
      const current = user("Asia/Tokyo");
      expect(applyZoneWrite(current, { kind: "untouched" })).toBe(current);
      expect(applyZoneWrite(current, { kind: "clear" })).toBeNull();
      expect(applyZoneWrite(current, { kind: "set", zone: device("UTC") })).toEqual(device("UTC"));
      expect(applyZoneWrite(null, { kind: "untouched" })).toBeNull();
    });
  });
});
