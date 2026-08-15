/**
 * Config-seam pins (T-8.2 / MAP-1 — R-map-7 + the P-8 tokenless ruling).
 *
 * The token seam's graceful no-op is the load-bearing arm: builds are
 * TOKENLESS, so an absent env token must configure NOTHING (blank basemap,
 * no error) — with the with-token CONTROL proving the call path exists.
 */
import {
  configureMapboxAccessToken,
  DEFAULT_MAP_STYLE_URLS,
  mapStyleUrlForScheme,
  resetMapboxAccessTokenForTests,
} from "./map-style";

const mapboxMock = jest.requireMock("@rnmapbox/maps") as {
  __mock: { setAccessToken: jest.Mock };
};

describe("mapStyleUrlForScheme (config-swap ruling)", () => {
  it("defaults to the stock Mapbox styles by scheme", () => {
    // Jest env carries no EXPO_PUBLIC_MAPBOX_STYLE_URL_* overrides.
    expect(mapStyleUrlForScheme("light")).toBe("mapbox://styles/mapbox/light-v11");
    expect(mapStyleUrlForScheme("dark")).toBe("mapbox://styles/mapbox/dark-v11");
    expect(DEFAULT_MAP_STYLE_URLS.light).toBe("mapbox://styles/mapbox/light-v11");
    expect(DEFAULT_MAP_STYLE_URLS.dark).toBe("mapbox://styles/mapbox/dark-v11");
  });

  it("a configured override wins for its scheme only (Studio styles = config change)", () => {
    const overrides = { light: "mapbox://styles/sean/custom-light" };
    expect(mapStyleUrlForScheme("light", overrides)).toBe("mapbox://styles/sean/custom-light");
    expect(mapStyleUrlForScheme("dark", overrides)).toBe("mapbox://styles/mapbox/dark-v11");
  });
});

describe("configureMapboxAccessToken (tokenless-build seam)", () => {
  beforeEach(() => {
    resetMapboxAccessTokenForTests();
    mapboxMock.__mock.setAccessToken.mockClear();
  });

  it("NO-OPS gracefully with no token — the tokenless build path", () => {
    expect(configureMapboxAccessToken(undefined)).toBe(false);
    expect(configureMapboxAccessToken("")).toBe(false);
    expect(mapboxMock.__mock.setAccessToken).not.toHaveBeenCalled();
  });

  it("CONTROL: hands a present token to the SDK exactly once (idempotent)", () => {
    expect(configureMapboxAccessToken("pk.test-value")).toBe(true);
    expect(configureMapboxAccessToken("pk.test-value")).toBe(true);
    expect(mapboxMock.__mock.setAccessToken).toHaveBeenCalledTimes(1);
    expect(mapboxMock.__mock.setAccessToken).toHaveBeenCalledWith("pk.test-value");
  });

  it("recovers on a later call once a token appears (deferred phase-QA drop)", () => {
    expect(configureMapboxAccessToken(undefined)).toBe(false);
    expect(configureMapboxAccessToken("pk.test-value")).toBe(true);
    expect(mapboxMock.__mock.setAccessToken).toHaveBeenCalledTimes(1);
  });
});
