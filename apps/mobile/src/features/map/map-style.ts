/**
 * Map style + access-token config seams (T-8.2 / MAP-1 — R-map-7, §2.2;
 * P-8 prep ruling: config-swap defaults).
 *
 * STYLE SEAM: default Mapbox styles selected by theme scheme, each
 * env-overridable — Sean's future Studio styles (§2.2 "style URLs are
 * config") land as an env change, zero code. `EXPO_PUBLIC_*` reads are
 * static member expressions (Metro inlines those and ONLY those).
 *
 * TOKEN SEAM: builds are TOKENLESS (P-8 prep: SDK download auth is dead; the
 * runtime `pk.` token is a phase-QA Sean item). `configureMapboxAccessToken`
 * reads the env-driven value and NO-OPS GRACEFULLY when absent — a blank
 * basemap on sim until phase QA is EXPECTED; pins, camera, chips, and the
 * seams all function without tiles. No token string exists anywhere in code
 * or config (Law #1 posture).
 */
import Mapbox from "@rnmapbox/maps";
import type { ColorSchemeName } from "@gogo/tokens";

/** §2.2 defaults behind the config swap (P-8 prep ruling). */
export const DEFAULT_MAP_STYLE_URLS: Readonly<Record<ColorSchemeName, string>> = {
  light: "mapbox://styles/mapbox/light-v11",
  dark: "mapbox://styles/mapbox/dark-v11",
};

/**
 * Style URL for the active theme scheme (R-map-7). `overrides` is the
 * testable seam; production callers pass nothing and get env-or-default.
 */
export function mapStyleUrlForScheme(
  scheme: ColorSchemeName,
  overrides?: { light?: string | undefined; dark?: string | undefined },
): string {
  if (scheme === "dark") {
    return (
      overrides?.dark ??
      process.env.EXPO_PUBLIC_MAPBOX_STYLE_URL_DARK ??
      DEFAULT_MAP_STYLE_URLS.dark
    );
  }
  return (
    overrides?.light ??
    process.env.EXPO_PUBLIC_MAPBOX_STYLE_URL_LIGHT ??
    DEFAULT_MAP_STYLE_URLS.light
  );
}

let tokenConfigured = false;

/**
 * Idempotent runtime token hand-off (module doc). Returns whether the SDK
 * has a token — `false` is the tokenless-build path, deliberately silent
 * (no error surface: the map shell is fully functional, only tiles are
 * blank until phase QA).
 */
export function configureMapboxAccessToken(
  token: string | undefined = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN,
): boolean {
  if (tokenConfigured) return true;
  if (token === undefined || token === "") return false;
  void Mapbox.setAccessToken(token);
  tokenConfigured = true;
  return true;
}

/** Test-only: reset the idempotency latch between cases. */
export function resetMapboxAccessTokenForTests(): void {
  tokenConfigured = false;
}

let telemetryDisabled = false;

/**
 * TELEMETRY SEAM (T-8.7 rider): the Mapbox SDK collects telemetry by
 * default; `setTelemetryEnabled(false)` is the documented v10 programmatic
 * opt-out (rnmapbox GettingStarted "Disabling telemetry"; verified against
 * the installed 10.3.5 — `src/RNMBXModule.ts` exports it and the package's
 * `types` entry carries it). Called once at screen module scope beside the
 * token hand-off, idempotent-latched like it.
 *
 * The `typeof` guard: under jest the package is WHOLESALE-mocked
 * (`jest.setup.js` — a T-8.5-owned file this task must not edit; the mock
 * addition is ESCALATED in the PR) and the mock's default export omits this
 * method, so absence degrades to `false` instead of a TypeError in every
 * suite that imports the screen. In a real build the method always exists
 * (native module contract); the guard's false arm is test-env-only.
 *
 * DEVICE-VERIFIABLE REMAINDER: the SDK persists the setting per device —
 * confirming the events endpoint goes quiet needs a live-token build
 * (phase-QA item, recorded in the PR body).
 */
export function disableMapboxTelemetry(): boolean {
  if (telemetryDisabled) return true;
  if (typeof Mapbox.setTelemetryEnabled !== "function") return false;
  Mapbox.setTelemetryEnabled(false);
  telemetryDisabled = true;
  return true;
}

/** Test-only: reset the telemetry latch between cases. */
export function resetMapboxTelemetryForTests(): void {
  telemetryDisabled = false;
}
