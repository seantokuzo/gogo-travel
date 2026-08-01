/**
 * §2.7 URL-builder pins (T-7.8 / IT-8; R-itin-21/32) — the per-partner
 * "snapshot" suite from the itinerary spec's §3 test bullets, pinned as
 * EXACT literal URLs (a stored jest snapshot could drift with a bug; a
 * spec-derived literal can't). Every partner: the exact ready URL, and the
 * missing-field verdict that drives button enablement. Date-format edges
 * (Skyscanner `yymmdd`, Turo `MM/DD/YYYY`), URL-encoding of every
 * interpolation, the Eventbrite US-slug omit rule, and the dormant
 * affiliate append are pinned here too.
 */
import {
  buildAirbnbUrl,
  buildAmtrakUrl,
  buildBookingComUrl,
  buildEventbriteUrl,
  buildExpediaUrl,
  buildExternalUrl,
  buildKayakCarsUrl,
  buildKayakFlightsUrl,
  buildOmioUrl,
  buildSkyscannerUrl,
  buildTrainlineUrl,
  buildTuroUrl,
  buildVrboUrl,
  categoryUsesAdults,
  externalUrlHost,
  mapSkyscannerCabin,
  normalizeAdults,
  partnerLabel,
  PARTNERS_BY_CATEGORY,
  toUsSlashDate,
  toYymmdd,
  withAffiliateParams,
  type DeeplinkBuild,
} from "./url-builders";

function expectReady(build: DeeplinkBuild, url: string): void {
  expect(build).toEqual({ status: "ready", url });
}

function expectMissing(build: DeeplinkBuild, missing: string[]): void {
  expect(build).toEqual({ status: "missing", missing });
}

const FLIGHT = {
  originIata: "SFO",
  destinationIata: "NRT",
  departDate: "2026-09-10",
};

const LODGING = {
  location: "Tokyo, Japan",
  checkIn: "2026-09-10",
  checkOut: "2026-09-14",
};

const CAR = {
  pickupLocation: "Los Angeles",
  pickupDate: "2026-09-10",
  dropoffDate: "2026-09-14",
};

describe("Kayak Flights (§2.7 row 1)", () => {
  it("builds the exact one-way URL", () => {
    expectReady(buildKayakFlightsUrl(FLIGHT), "https://www.kayak.com/flights/SFO-NRT/2026-09-10");
  });

  it("appends the return date for round trips and uppercases IATA", () => {
    expectReady(
      buildKayakFlightsUrl({ ...FLIGHT, originIata: "sfo", returnDate: "2026-09-24" }),
      "https://www.kayak.com/flights/SFO-NRT/2026-09-10/2026-09-24",
    );
  });

  it("adds ?fs=stops=0 only when the non-stop toggle is set", () => {
    expectReady(
      buildKayakFlightsUrl({ ...FLIGHT, nonStopOnly: true }),
      "https://www.kayak.com/flights/SFO-NRT/2026-09-10?fs=stops=0",
    );
  });

  it("reports every missing required field (R-itin-21 hint)", () => {
    expectMissing(buildKayakFlightsUrl({}), [
      "origin airport",
      "destination airport",
      "departure date",
    ]);
    expectMissing(buildKayakFlightsUrl({ ...FLIGHT, departDate: "  " }), ["departure date"]);
  });
});

describe("Skyscanner (§2.7 row 2)", () => {
  it("builds the exact one-way URL — lowercase IATA, yymmdd, documented params", () => {
    expectReady(
      buildSkyscannerUrl(FLIGHT, 4),
      "https://www.skyscanner.net/transport/flights/sfo/nrt/260910/?adultsv2=4&cabinclass=economy&preferDirects=false",
    );
  });

  it("round trip appends the second yymmdd segment; cabin + directs map from the form", () => {
    expectReady(
      buildSkyscannerUrl(
        { ...FLIGHT, returnDate: "2026-09-24", cabinClass: "Business", nonStopOnly: true },
        2,
      ),
      "https://www.skyscanner.net/transport/flights/sfo/nrt/260910/260924/?adultsv2=2&cabinclass=business&preferDirects=true",
    );
  });

  it("disables on missing IATA/date like Kayak", () => {
    expectMissing(buildSkyscannerUrl({ departDate: "2026-09-10" }, 2), [
      "origin airport",
      "destination airport",
    ]);
  });

  it("maps free-text cabin classes onto the fixed set", () => {
    expect(mapSkyscannerCabin("Premium Economy")).toBe("premiumeconomy");
    expect(mapSkyscannerCabin("premium_economy")).toBe("premiumeconomy");
    expect(mapSkyscannerCabin("First")).toBe("first");
    expect(mapSkyscannerCabin("anything else")).toBe("economy");
    expect(mapSkyscannerCabin(undefined)).toBe("economy");
  });
});

describe("Lodging partners (§2.7 rows 3–6)", () => {
  it("Airbnb: exact URL with the location path-encoded", () => {
    expectReady(
      buildAirbnbUrl(LODGING, 4),
      "https://www.airbnb.com/s/Tokyo%2C%20Japan/homes?checkin=2026-09-10&checkout=2026-09-14&adults=4",
    );
  });

  it("Booking.com: exact URL (ss + group_adults)", () => {
    expectReady(
      buildBookingComUrl(LODGING, 4),
      "https://www.booking.com/searchresults.html?ss=Tokyo%2C%20Japan&checkin=2026-09-10&checkout=2026-09-14&group_adults=4",
    );
  });

  it("Expedia: exact URL (destination + startDate/endDate)", () => {
    expectReady(
      buildExpediaUrl(LODGING, 4),
      "https://www.expedia.com/Hotel-Search?destination=Tokyo%2C%20Japan&startDate=2026-09-10&endDate=2026-09-14&adults=4",
    );
  });

  it("Vrbo: exact URL", () => {
    expectReady(
      buildVrboUrl(LODGING, 4),
      "https://www.vrbo.com/search?destination=Tokyo%2C%20Japan&startDate=2026-09-10&endDate=2026-09-14&adults=4",
    );
  });

  it("all four disable on the same missing lodging fields", () => {
    for (const build of [buildAirbnbUrl, buildBookingComUrl, buildExpediaUrl, buildVrboUrl]) {
      expectMissing(build({ location: "Tokyo" }, 2), ["check-in date", "check-out date"]);
    }
  });
});

describe("Train partners (§2.7 rows 7–9)", () => {
  it("Trainline results: exact URL with URNs + ISO outwardDate encoded", () => {
    expectReady(
      buildTrainlineUrl({
        originUrn: "urn:trainline:generic:loc:182gb",
        destinationUrn: "urn:trainline:generic:loc:1745gb",
        outwardDate: "2026-09-10T09:00:00",
      }),
      "https://www.thetrainline.com/book/results?origin=urn%3Atrainline%3Ageneric%3Aloc%3A182gb&destination=urn%3Atrainline%3Ageneric%3Aloc%3A1745gb&outwardDate=2026-09-10T09%3A00%3A00",
    );
  });

  it("Trainline reports missing URNs/time", () => {
    expectMissing(buildTrainlineUrl({}), [
      "origin station",
      "destination station",
      "departure time",
    ]);
  });

  it("Omio and Amtrak are plain links, always ready (no parameterized format)", () => {
    expectReady(buildOmioUrl(), "https://www.omio.com/");
    expectReady(buildAmtrakUrl(), "https://www.amtrak.com/");
  });
});

describe("Car rental partners (§2.7 rows 10–11)", () => {
  it("Kayak Cars: exact URL with encoded location + ISO dates", () => {
    expectReady(
      buildKayakCarsUrl(CAR),
      "https://www.kayak.com/cars/Los%20Angeles/2026-09-10/2026-09-14",
    );
  });

  it("Kayak Cars needs pickup location + both dates", () => {
    expectMissing(buildKayakCarsUrl({ pickupDate: "2026-09-10" }), [
      "pickup location",
      "dropoff date",
    ]);
  });

  it("Turo: exact URL — MM/DD/YYYY startDate, location+startDate ONLY (unverified extras omitted)", () => {
    expectReady(
      buildTuroUrl(CAR),
      "https://turo.com/us/en/search?location=Los%20Angeles&startDate=09%2F10%2F2026",
    );
  });

  it("Turo needs only pickup location + pickup date (no dropoff)", () => {
    expectMissing(buildTuroUrl({}), ["pickup location", "pickup date"]);
    expectReady(
      buildTuroUrl({ pickupLocation: "Los Angeles", pickupDate: "2026-09-10" }),
      "https://turo.com/us/en/search?location=Los%20Angeles&startDate=09%2F10%2F2026",
    );
  });
});

describe("Eventbrite (§2.7 row 12) — US state--city slug or OMIT", () => {
  it("maps 'City, ST' destinations to the exact browse URL", () => {
    expectReady(
      buildEventbriteUrl("Austin, TX"),
      "https://www.eventbrite.com/d/tx--austin/events/",
    );
  });

  it("maps full state names and trailing US country segments", () => {
    expectReady(
      buildEventbriteUrl("San Francisco, California, United States"),
      "https://www.eventbrite.com/d/ca--san-francisco/events/",
    );
  });

  it("OMITS (not disables) for non-US or unmappable destinations", () => {
    expect(buildEventbriteUrl("Tokyo, Japan")).toEqual({ status: "omit" });
    expect(buildEventbriteUrl("Paris")).toEqual({ status: "omit" });
    expect(buildEventbriteUrl(undefined)).toEqual({ status: "omit" });
  });
});

describe("External URL (§2.7 row 13)", () => {
  it("passes an http(s) URL through verbatim and derives the host label", () => {
    expectReady(
      buildExternalUrl("https://www.getyourguide.com/tokyo-l193/some-tour"),
      "https://www.getyourguide.com/tokyo-l193/some-tour",
    );
    expect(externalUrlHost("https://www.getyourguide.com/tokyo-l193/x")).toBe("getyourguide.com");
    expect(externalUrlHost("http://example.org/a")).toBe("example.org");
  });

  it("missing or non-http(s) values disable the button (never handed to openURL)", () => {
    expectMissing(buildExternalUrl(undefined), ["link URL"]);
    expectMissing(buildExternalUrl("   "), ["link URL"]);
    expectMissing(buildExternalUrl("javascript:alert(1)"), ["valid link URL"]);
    expect(externalUrlHost("javascript:alert(1)")).toBeNull();
  });
});

describe("shared plumbing", () => {
  it("date-format helpers match the per-partner formats", () => {
    expect(toYymmdd("2026-09-10")).toBe("260910");
    expect(toUsSlashDate("2026-09-10")).toBe("09/10/2026");
  });

  it("normalizeAdults clamps to a positive integer (R-itin-32 URL guard)", () => {
    expect(normalizeAdults(4)).toBe(4);
    expect(normalizeAdults(0)).toBe(1);
    expect(normalizeAdults(-3)).toBe(1);
    expect(normalizeAdults(2.9)).toBe(2);
    expect(normalizeAdults(Number.NaN)).toBe(1);
  });

  it("affiliate params append dormantly (?/& as needed) and stay absent by default", () => {
    expect(withAffiliateParams("https://x.example/a")).toBe("https://x.example/a");
    expect(withAffiliateParams("https://x.example/a", { pid: "P001", medium: "link" })).toBe(
      "https://x.example/a?pid=P001&medium=link",
    );
    expect(withAffiliateParams("https://x.example/a?b=1", { pid: "P001" })).toBe(
      "https://x.example/a?b=1&pid=P001",
    );
    // Builders thread it through — one pin per family suffices.
    expect(buildKayakFlightsUrl(FLIGHT, { pid: "P001" })).toEqual({
      status: "ready",
      url: "https://www.kayak.com/flights/SFO-NRT/2026-09-10?pid=P001",
    });
  });

  it("partner registry: §2.4 coverage — no v1 partners for moped_rental/restaurant", () => {
    expect(PARTNERS_BY_CATEGORY.moped_rental).toEqual([]);
    expect(PARTNERS_BY_CATEGORY.restaurant).toEqual([]);
    expect(PARTNERS_BY_CATEGORY.flight.map((p) => p.id)).toEqual(["kayak", "skyscanner"]);
    expect(PARTNERS_BY_CATEGORY.lodging.map((p) => p.id)).toEqual([
      "airbnb",
      "booking",
      "expedia",
      "vrbo",
    ]);
    expect(PARTNERS_BY_CATEGORY.train.map((p) => p.id)).toEqual(["trainline", "omio", "amtrak"]);
    expect(PARTNERS_BY_CATEGORY.car_rental.map((p) => p.id)).toEqual(["kayak-cars", "turo"]);
    expect(categoryUsesAdults("lodging")).toBe(true);
    expect(categoryUsesAdults("car_rental")).toBe(false);
    expect(partnerLabel("booking")).toBe("Booking.com");
  });
});
