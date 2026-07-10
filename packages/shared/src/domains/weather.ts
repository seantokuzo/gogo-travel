/**
 * Weather domain (contracts spec §3.4; schema spec §3.3.23/§3.4.5).
 * Provider-agnostic; Celsius canonical — unit conversion is presentation.
 */
import { z } from "zod";
import { ISODateSchema } from "../scalars.js";

export const WeatherDaySchema = z.object({
  date: ISODateSchema,
  temp_min_c: z.number(),
  temp_max_c: z.number(),
  /** 0–1 when the provider supplies it. */
  precip_probability: z.number().optional(),
  /** Provider-agnostic condition code, normalized server-side at ingest. */
  condition_code: z.string(),
  condition_text: z.string().optional(),
});
export type WeatherDay = z.infer<typeof WeatherDaySchema>;

/** `weather_cache.payload` — daily entries covering the provider's horizon. */
export const WeatherForecastSchema = z.object({
  provider: z.string(),
  days: z.array(WeatherDaySchema),
});
export type WeatherForecast = z.infer<typeof WeatherForecastSchema>;

/**
 * `weather_cache.location_key` derivation (schema spec §3.3.23):
 * `"{lat:.2f},{lng:.2f}"` — both rounded to 2 decimal places (~1.1 km cell).
 * Negative zero normalizes to `"0.00"` so equivalent cells share a key.
 */
export function deriveWeatherLocationKey(lat: number, lng: number): string {
  const fmt = (value: number): string => {
    const fixed = value.toFixed(2);
    return fixed === "-0.00" ? "0.00" : fixed;
  };
  return `${fmt(lat)},${fmt(lng)}`;
}
