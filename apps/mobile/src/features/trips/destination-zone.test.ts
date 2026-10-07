/**
 * `coordinateLessDestinationZone` (B-30): the device zone a coordinate-less
 * custom destination ships with — or `undefined` (omit the key) when the
 * runtime can't name a zone the wire schema will accept.
 */
import { TripCreateSchema } from "@gogo/shared";

import { coordinateLessDestinationZone } from "./destination-zone";

const mockDeviceTimeZone = jest.fn<string, []>();
jest.mock("@/features/itinerary/add-edit/zoned-time", () => ({
  deviceTimeZone: () => mockDeviceTimeZone(),
}));

const createBody = (destination_tz: string | undefined) => ({
  name: "Cabin",
  destination_name: "Cabin",
  destination_lat: null,
  destination_lng: null,
  ...(destination_tz === undefined ? {} : { destination_tz }),
  start_date: "2027-05-01",
  end_date: "2027-05-08",
});

describe("coordinateLessDestinationZone", () => {
  it("returns the device zone when it is an IANA-shaped id — and the create schema accepts it", () => {
    mockDeviceTimeZone.mockReturnValue("America/Los_Angeles");
    const zone = coordinateLessDestinationZone();
    expect(zone).toBe("America/Los_Angeles");
    expect(TripCreateSchema.safeParse(createBody(zone)).success).toBe(true);
  });

  it("'UTC' (deviceTimeZone's own last-resort answer) is a valid zone and is sent", () => {
    mockDeviceTimeZone.mockReturnValue("UTC");
    expect(coordinateLessDestinationZone()).toBe("UTC");
  });

  it("a device id the wire schema would 400 (offset-style, empty, over the 64-char cap) → undefined, so the create is never blocked by it", () => {
    for (const bad of ["GMT+05:30", "+05:30", "", `A${"b".repeat(64)}`, "Not A Zone"]) {
      mockDeviceTimeZone.mockReturnValue(bad);
      expect([bad, coordinateLessDestinationZone()]).toEqual([bad, undefined]);
      // The point of the omission: sending it would have 400'd the whole create.
      expect([bad, TripCreateSchema.safeParse(createBody(bad)).success]).toEqual([bad, false]);
    }
  });
});
