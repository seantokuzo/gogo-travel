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

  // The ENV channel is the seam's advertised purpose (Sean's Studio styles
  // land as an env change, zero code) — pinned per scheme so a fallback-chain
  // "simplification" can't kill it silently (R1 review, tests A8 / probe N5).
  describe("env override channel", () => {
    const LIGHT_KEY = "EXPO_PUBLIC_MAPBOX_STYLE_URL_LIGHT";
    const DARK_KEY = "EXPO_PUBLIC_MAPBOX_STYLE_URL_DARK";

    /** Set env keys for one assertion block; restore (or delete) in finally. */
    function withEnv(env: Record<string, string>, run: () => void): void {
      const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      try {
        run();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    it("env LIGHT wins over the default — for the light scheme only", () => {
      withEnv({ [LIGHT_KEY]: "mapbox://styles/sean/env-light" }, () => {
        expect(mapStyleUrlForScheme("light")).toBe("mapbox://styles/sean/env-light");
        expect(mapStyleUrlForScheme("dark")).toBe(DEFAULT_MAP_STYLE_URLS.dark);
      });
    });

    it("env DARK wins over the default — for the dark scheme only", () => {
      withEnv({ [DARK_KEY]: "mapbox://styles/sean/env-dark" }, () => {
        expect(mapStyleUrlForScheme("dark")).toBe("mapbox://styles/sean/env-dark");
        expect(mapStyleUrlForScheme("light")).toBe(DEFAULT_MAP_STYLE_URLS.light);
      });
    });

    it("explicit overrides beat env (the test seam stays strongest)", () => {
      withEnv(
        {
          [LIGHT_KEY]: "mapbox://styles/sean/env-light",
          [DARK_KEY]: "mapbox://styles/sean/env-dark",
        },
        () => {
          expect(
            mapStyleUrlForScheme("light", { light: "mapbox://styles/sean/override-light" }),
          ).toBe("mapbox://styles/sean/override-light");
          expect(mapStyleUrlForScheme("dark", { dark: "mapbox://styles/sean/override-dark" })).toBe(
            "mapbox://styles/sean/override-dark",
          );
        },
      );
    });
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
