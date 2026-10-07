/**
 * `deviceZoneHint` (B-30): the device-zone HINT a coordinate-less custom
 * destination ships with — `{ destination_tz, destination_tz_source: 'device' }`
 * — or `undefined` (omit both keys) when the runtime can't name a zone the wire
 * schema will accept. Never a user's explicit choice (that is T-7.17's picker).
 */
import { TripCreateSchema } from "@gogo/shared";

import { deviceZoneHint } from "./destination-zone";

const mockDeviceTimeZone = jest.fn<string, []>();
jest.mock("@/features/itinerary/add-edit/zoned-time", () => ({
  deviceTimeZone: () => mockDeviceTimeZone(),
}));

const createBody = (hint: Record<string, unknown>) => ({
  name: "Cabin",
  destination_name: "Cabin",
  destination_lat: null,
  destination_lng: null,
  ...hint,
  start_date: "2027-05-01",
  end_date: "2027-05-08",
});

describe("deviceZoneHint", () => {
  it("is the device zone tagged source 'device' — and the create schema accepts it", () => {
    mockDeviceTimeZone.mockReturnValue("Pacific/Chatham");
    const hint = deviceZoneHint();
    expect(hint).toEqual({ destination_tz: "Pacific/Chatham", destination_tz_source: "device" });
    expect(TripCreateSchema.safeParse(createBody({ ...hint })).success).toBe(true);
  });

  it("the source is NEVER 'user' (a device guess must not outrank a booking zone)", () => {
    mockDeviceTimeZone.mockReturnValue("America/Los_Angeles");
    expect(deviceZoneHint()?.destination_tz_source).toBe("device");
  });

  it("'UTC' (deviceTimeZone's own last-resort answer) is a valid shape and is sent as a hint", () => {
    mockDeviceTimeZone.mockReturnValue("UTC");
    expect(deviceZoneHint()).toEqual({ destination_tz: "UTC", destination_tz_source: "device" });
  });

  it("a device id that is not IANA-shaped (offset-style, empty, over the 64-char cap) -> undefined: nothing is sent", () => {
    for (const bad of ["GMT+05:30", "+05:30", "", `A${"b".repeat(64)}`, "Not A Zone"]) {
      mockDeviceTimeZone.mockReturnValue(bad);
      expect([bad, deviceZoneHint()]).toEqual([bad, undefined]);
    }
  });

  it("the server tolerates what the shape check lets through: an odd-but-shaped zone still parses as a device hint", () => {
    // The server allow-list decides usability and IGNORES an unusable hint — the
    // schema must not 400 it (a device on exotic tzdata can never block a create).
    mockDeviceTimeZone.mockReturnValue("Made/Up_Zone");
    const hint = deviceZoneHint();
    expect(hint?.destination_tz).toBe("Made/Up_Zone");
    expect(TripCreateSchema.safeParse(createBody({ ...hint })).success).toBe(true);
  });
});
