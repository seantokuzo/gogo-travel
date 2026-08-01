/**
 * Trainline URN lookup pins (T-7.8 / IT-8; §2.7 two-step train flow) — the
 * lookup URL, the shape-tolerant URN extraction (response shape is NOT
 * research-pinned — module doc), and the round-trip's ok / non-ok /
 * no-match arms. The debounced hook is exercised through the panel suite.
 */
import { extractFirstUrn, searchTrainlineUrn, trainlineLocationSearchUrl } from "./trainline";

describe("trainlineLocationSearchUrl", () => {
  it("builds the §2.7 lookup URL with the term encoded", () => {
    expect(trainlineLocationSearchUrl("London Euston")).toBe(
      "https://www.thetrainline.com/api/locations-search/v2/search?searchTerm=London%20Euston",
    );
  });
});

describe("extractFirstUrn (shape-tolerant)", () => {
  it("finds a top-level searchLocations-style shape", () => {
    expect(
      extractFirstUrn({
        searchLocations: [
          { name: "London Euston", urn: "urn:trainline:generic:loc:182gb" },
          { name: "London Bridge", urn: "urn:trainline:generic:loc:1745gb" },
        ],
      }),
    ).toBe("urn:trainline:generic:loc:182gb");
  });

  it("finds a nested/renamed collection too (breadth-first)", () => {
    expect(
      extractFirstUrn({
        data: { results: { items: [{ location: { urn: "urn:trainline:generic:loc:9gb" } }] } },
      }),
    ).toBe("urn:trainline:generic:loc:9gb");
  });

  it("ignores non-trainline urn strings and returns null when nothing matches", () => {
    expect(extractFirstUrn({ urn: "urn:other:thing" })).toBeNull();
    expect(extractFirstUrn({ locations: [] })).toBeNull();
    expect(extractFirstUrn(null)).toBeNull();
    expect(extractFirstUrn("urn:trainline:generic:loc:182gb")).toBeNull();
  });
});

/** Minimal fetch-response stub — only the fields searchTrainlineUrn reads. */
function fakeResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe("searchTrainlineUrn", () => {
  it("resolves the first URN from an ok response", async () => {
    const fetchFn = jest.fn(async () =>
      fakeResponse(200, { searchLocations: [{ urn: "urn:trainline:generic:loc:182gb" }] }),
    ) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("London", { fetchFn })).resolves.toBe(
      "urn:trainline:generic:loc:182gb",
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.thetrainline.com/api/locations-search/v2/search?searchTerm=London",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("resolves null on a no-match payload (degrade arm, not an error)", async () => {
    const fetchFn = jest.fn(async () =>
      fakeResponse(200, { searchLocations: [] }),
    ) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("Nowhere", { fetchFn })).resolves.toBeNull();
  });

  it("throws on a non-ok response (TanStack settles the query to error → degrade)", async () => {
    const fetchFn = jest.fn(async () => fakeResponse(503, "teapot")) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("London", { fetchFn })).rejects.toThrow("503");
  });
});
