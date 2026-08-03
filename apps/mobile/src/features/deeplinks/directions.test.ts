/**
 * Directions-URL pins (T-7.5 / IT-3 — R-itin-4). Exact-string assertions,
 * the same posture as the §2.7 partner-builder suite: a URL that "looks
 * right" is not a pin, so every case asserts the whole constructed string.
 */
import { buildDirectionsUrl, DIRECTIONS_TRAVEL_MODE } from "./directions";

const BASE = "https://www.google.com/maps/dir/?api=1";

describe("buildDirectionsUrl (R-itin-4)", () => {
  it("builds the exact documented Maps URLs request", () => {
    expect(
      buildDirectionsUrl({ origin: "Park Hyatt Tokyo", destination: "Senso-ji", mode: "walking" }),
    ).toEqual({
      status: "ready",
      url: `${BASE}&origin=Park%20Hyatt%20Tokyo&destination=Senso-ji&travelmode=walking`,
    });
  });

  it("maps `cycling` to the API's `bicycling` and passes the rest through", () => {
    expect(DIRECTIONS_TRAVEL_MODE).toEqual({
      driving: "driving",
      walking: "walking",
      cycling: "bicycling",
      transit: "transit",
    });
    const built = buildDirectionsUrl({ origin: "A", destination: "B", mode: "cycling" });
    expect(built.status === "ready" && built.url.endsWith("&travelmode=bicycling")).toBe(true);
  });

  it("URL-encodes both endpoints — separators can't escape the query", () => {
    const built = buildDirectionsUrl({
      origin: "Café & Bar, 1/2 Rue",
      destination: "A?b=c#d",
      mode: "driving",
    });
    expect(built).toEqual({
      status: "ready",
      url: `${BASE}&origin=Caf%C3%A9%20%26%20Bar%2C%201%2F2%20Rue&destination=A%3Fb%3Dc%23d&travelmode=driving`,
    });
  });

  it("appends the trip destination for context", () => {
    const built = buildDirectionsUrl({
      origin: "Shibuya Crossing",
      destination: "Senso-ji",
      mode: "transit",
      context: "Tokyo",
    });
    expect(built).toEqual({
      status: "ready",
      url: `${BASE}&origin=Shibuya%20Crossing%2C%20Tokyo&destination=Senso-ji%2C%20Tokyo&travelmode=transit`,
    });
  });

  it("does not stutter when the label already names the destination", () => {
    const built = buildDirectionsUrl({
      origin: "Park Hyatt Tokyo",
      destination: "Senso-ji",
      mode: "driving",
      context: "Tokyo",
    });
    expect(built).toEqual({
      status: "ready",
      url: `${BASE}&origin=Park%20Hyatt%20Tokyo&destination=Senso-ji%2C%20Tokyo&travelmode=driving`,
    });
  });

  it("a missing endpoint disables the row with a hint, rather than querying junk", () => {
    expect(buildDirectionsUrl({ origin: null, destination: "Senso-ji", mode: "walking" })).toEqual({
      status: "missing",
      missing: ["a name or address for the start"],
    });
    expect(buildDirectionsUrl({ origin: "A", destination: null, mode: "walking" })).toEqual({
      status: "missing",
      missing: ["a name or address for the destination"],
    });
    expect(buildDirectionsUrl({ origin: null, destination: null, mode: "walking" })).toEqual({
      status: "missing",
      missing: ["a name or address for the start", "a name or address for the destination"],
    });
  });

  it("whitespace-only is missing, not a query", () => {
    expect(buildDirectionsUrl({ origin: "   ", destination: "B", mode: "walking" }).status).toBe(
      "missing",
    );
    // CONTROL: one non-space character flips it to ready.
    expect(buildDirectionsUrl({ origin: " A ", destination: "B", mode: "walking" })).toEqual({
      status: "ready",
      url: `${BASE}&origin=A&destination=B&travelmode=walking`,
    });
  });

  it("an empty context is ignored rather than appending a bare comma", () => {
    expect(
      buildDirectionsUrl({ origin: "A", destination: "B", mode: "walking", context: "  " }),
    ).toEqual({
      status: "ready",
      url: `${BASE}&origin=A&destination=B&travelmode=walking`,
    });
  });
});
