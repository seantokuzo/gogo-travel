/**
 * Transport reference domain (B-9): wire shapes, query caps (caps on every
 * schema class — T-7.1), and the canonical flight-number parser both sides
 * of the wire share.
 */
import { describe, expect, it } from "vitest";
import {
  AirlineSchema,
  AirlineSearchQuerySchema,
  airportEndpoints,
  AirportSchema,
  AirportSearchQuerySchema,
  FlightAirlineLookupQuerySchema,
  FlightAirlineLookupResponseSchema,
  parseFlightNumber,
} from "./airport.js";

const NRT = {
  iata: "NRT",
  icao: "RJAA",
  name: "Narita International Airport",
  city: "Narita",
  country: "JP",
  lat: 35.76858,
  lng: 140.388714,
  tz: "Asia/Tokyo",
};

describe("AirportSchema", () => {
  it("accepts a seeded row shape (nullable icao/city/country included)", () => {
    expect(AirportSchema.parse(NRT)).toEqual(NRT);
    const sparse = { ...NRT, icao: null, city: null, country: null };
    expect(AirportSchema.parse(sparse)).toEqual(sparse);
  });

  it.each([
    ["lowercase iata", { ...NRT, iata: "nrt" }],
    ["2-char iata", { ...NRT, iata: "NR" }],
    ["4-char iata", { ...NRT, iata: "NRTA" }],
    ["malformed icao", { ...NRT, icao: "RJ" }],
    ["name over the 200 cap", { ...NRT, name: "x".repeat(201) }],
    ["city over the 200 cap", { ...NRT, city: "x".repeat(201) }],
    ["3-char country", { ...NRT, country: "JPN" }],
    ["out-of-range lat", { ...NRT, lat: 91 }],
    ["out-of-range lng", { ...NRT, lng: -181 }],
    ["empty tz", { ...NRT, tz: "" }],
    ["tz over the 64 cap", { ...NRT, tz: "Area/" + "x".repeat(60) }],
  ])("rejects %s", (_label, row) => {
    expect(AirportSchema.safeParse(row).success).toBe(false);
  });
});

describe("AirlineSchema", () => {
  it("accepts letter+digit designators", () => {
    expect(AirlineSchema.parse({ iata: "NH", name: "All Nippon Airways" })).toBeTruthy();
    expect(AirlineSchema.parse({ iata: "B6", name: "JetBlue Airways" })).toBeTruthy();
    expect(AirlineSchema.parse({ iata: "3K", name: "Jetstar Asia Airways" })).toBeTruthy();
  });

  it("rejects all-digit designators (ambiguous inside flight numbers)", () => {
    expect(AirlineSchema.safeParse({ iata: "12", name: "Numeric Air" }).success).toBe(false);
  });

  it("rejects lowercase, wrong length, and over-cap names", () => {
    expect(AirlineSchema.safeParse({ iata: "nh", name: "x" }).success).toBe(false);
    expect(AirlineSchema.safeParse({ iata: "NHX", name: "x" }).success).toBe(false);
    expect(AirlineSchema.safeParse({ iata: "NH", name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("search query schemas", () => {
  it("trims and NFC-normalizes q (decomposed input matches NFC-stored names)", () => {
    const decomposed = "Malé"; // "Malé" as e + combining acute
    const parsed = AirportSearchQuerySchema.parse({ q: `  ${decomposed}  ` });
    expect(parsed.q).toBe("Malé");
  });

  it("allows 1-char q (bounded table — no places-style text floor)", () => {
    expect(AirportSearchQuerySchema.parse({ q: "N" }).q).toBe("N");
  });

  it.each([
    ["empty q", { q: "   " }],
    ["q over the 100 cap", { q: "x".repeat(101) }],
    ["limit 0", { q: "NRT", limit: "0" }],
    ["limit over the 20 cap", { q: "NRT", limit: "21" }],
    ["non-integer limit", { q: "NRT", limit: "2.5" }],
  ])("rejects %s", (_label, query) => {
    expect(AirportSearchQuerySchema.safeParse(query).success).toBe(false);
    expect(AirlineSearchQuerySchema.safeParse(query).success).toBe(false);
  });

  it("coerces the query-string limit", () => {
    expect(AirportSearchQuerySchema.parse({ q: "NRT", limit: "20" }).limit).toBe(20);
  });
});

describe("parseFlightNumber", () => {
  it.each([
    ["NH204", "NH", "204"],
    ["nh 204", "NH", "204"],
    ["NH-204", "NH", "204"],
    ["  ba2276  ", "BA", "2276"],
    ["BA2276A", "BA", "2276"], // operational suffix dropped
    ["B61021", "B6", "1021"],
    ["3K509", "3K", "509"],
    ["UA1", "UA", "1"],
    ["NH005", "NH", "5"], // leading zeros normalized
    ["NH0", "NH", "0"],
    // Genuinely ambiguous but valid IATA shape: letter+digit designator.
    // The DATASET decides whether "N2" resolves; the parser must not guess.
    ["N204", "N2", "4"],
  ])("parses %s → %s %s", (input, airline, number) => {
    expect(parseFlightNumber(input)).toEqual({ airline_iata: airline, number });
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["12345", "all-digit prefix"],
    ["N2", "designator with no digits"],
    ["ANA204", "3-char (ICAO-style) prefix — v1 keys on IATA"],
    ["NH", "no digits"],
    ["NH20456", "5-digit number"],
    ["NH204AB", "two suffix letters"],
    ["NH!204", "junk separator"],
    ["NH 204 something long", "oversized"],
  ])("returns null for %s (%s)", (input) => {
    expect(parseFlightNumber(input)).toBeNull();
  });

  it("round-trips through the lookup response schema", () => {
    const flight = parseFlightNumber("NH204");
    const body = { flight, airline: { iata: "NH", name: "All Nippon Airways" } };
    expect(FlightAirlineLookupResponseSchema.parse(body)).toEqual(body);
    const miss = { flight: null, airline: null };
    expect(FlightAirlineLookupResponseSchema.parse(miss)).toEqual(miss);
  });
});

describe("lookup query schema", () => {
  it("caps flight_number at 12 chars", () => {
    expect(FlightAirlineLookupQuerySchema.safeParse({ flight_number: "x".repeat(13) }).success).toBe(
      false,
    );
    expect(FlightAirlineLookupQuerySchema.parse({ flight_number: " NH204 " }).flight_number).toBe(
      "NH204",
    );
  });
});

describe("endpoint descriptors", () => {
  it("declare the reference surface's paths and methods", () => {
    expect(airportEndpoints.searchAirports.path).toBe("/airports/search");
    expect(airportEndpoints.searchAirlines.path).toBe("/airlines/search");
    expect(airportEndpoints.lookupFlightAirline.path).toBe("/airlines/flight-lookup");
    for (const descriptor of Object.values(airportEndpoints)) {
      expect(descriptor.method).toBe("GET");
    }
  });
});
