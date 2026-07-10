import { describe, expect, it } from "vitest";
import { deriveWeatherLocationKey, WeatherForecastSchema } from "./weather.js";

describe("deriveWeatherLocationKey (schema spec §3.3.23)", () => {
  it("formats '{lat:.2f},{lng:.2f}'", () => {
    expect(deriveWeatherLocationKey(35.6812, 139.7671)).toBe("35.68,139.77");
  });
  it("rounds to the ~1.1 km cell", () => {
    expect(deriveWeatherLocationKey(35.684999, 139.7681)).toBe("35.68,139.77");
    // same cell → same key (cache sharing)
    expect(deriveWeatherLocationKey(35.681, 139.766)).toBe(
      deriveWeatherLocationKey(35.679, 139.774),
    );
  });
  it("handles negatives and normalizes -0.00", () => {
    expect(deriveWeatherLocationKey(-33.8688, 151.2093)).toBe("-33.87,151.21");
    expect(deriveWeatherLocationKey(-0.0001, 0.0001)).toBe("0.00,0.00");
  });
});

describe("WeatherForecast payload", () => {
  it("parses daily entries; optional fields omissible", () => {
    const parsed = WeatherForecastSchema.parse({
      provider: "open-meteo",
      days: [
        {
          date: "2026-09-01",
          temp_min_c: 21.5,
          temp_max_c: 29.1,
          precip_probability: 0.4,
          condition_code: "rain_light",
          condition_text: "Light rain",
        },
        { date: "2026-09-02", temp_min_c: 20, temp_max_c: 27, condition_code: "clear" },
      ],
    });
    expect(parsed.days).toHaveLength(2);
  });
});
