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
/** The in-flight native hand-off (see `whenMapboxTokenSet`); undefined until a token is handed over. */
let tokenHandoff: Promise<unknown> | undefined;

/**
 * Idempotent runtime token hand-off (module doc). Returns whether the SDK
 * has a token — `false` is the tokenless-build path, deliberately silent
 * (no error surface: the map shell is fully functional, only tiles are
 * blank until phase QA).
 *
 * CALL SITES (PR #98 round 2): the map route's module scope AND the
 * offline-pack controller's SDK door (`offline-pack-controller.ts`). The
 * route's module scope alone is NOT a guarantee for SDK work started from
 * other tabs: expo-router evaluates a LEAF route module (layout modules load
 * eagerly) only when its screen first renders (dev builds additionally load
 * EVERY route up front — `getRoutesCore.js` `validateRouteTreeExports`), so in
 * a release build the token is unset until the map tab has opened once.
 */
export function configureMapboxAccessToken(
  token: string | undefined = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN,
): boolean {
  if (tokenConfigured) return true;
  if (token === undefined || token === "") return false;
  // Kept (not `void`ed) for `whenMapboxTokenSet()` — the await it enables is
  // REQUIRED on Android and redundant-but-harmless on iOS (PR #98 round 2; do
  // not delete it as "dead" on the strength of iOS alone):
  //  - Android: rnmapbox `RNMBXModule.kt` `setAccessToken` sets AND resolves on
  //    the UI thread (`runOnUiQueueThread`) while `RNMBXOfflineModule.createPack`
  //    runs inline on the native-modules thread — a fire-and-forget set can
  //    lose that race and `createPack` would start tokenless.
  //  - iOS: RN 0.86 puts methodQueue-less TurboModules on ONE shared serial
  //    queue (`RCTTurboModuleManager.mm` `_sharedModuleQueue`), so JS call order
  //    is native order and the set has landed before `createPack` runs.
  // A rejection is swallowed (the SDK call it would have gated fails loudly on
  // its own).
  tokenHandoff = Promise.resolve(Mapbox.setAccessToken(token)).catch(() => undefined);
  tokenConfigured = true;
  return true;
}

/**
 * Resolves once the native token hand-off has landed (immediately on a
 * tokenless build, or when nothing has been handed over yet). Await it
 * between `configureMapboxAccessToken()` and any SDK call that needs the
 * token — today only `offlineManager.createPack`.
 */
export function whenMapboxTokenSet(): Promise<unknown> {
  return tokenHandoff ?? Promise.resolve();
}

/** Test-only: reset the idempotency latch between cases. */
export function resetMapboxAccessTokenForTests(): void {
  tokenConfigured = false;
  tokenHandoff = undefined;
}

let telemetryDisabled = false;

/**
 * TELEMETRY SEAM (T-8.7 rider): the Mapbox SDK collects telemetry by
 * default; `setTelemetryEnabled(false)` is the documented v10 programmatic
 * opt-out (rnmapbox GettingStarted "Disabling telemetry"; verified against
 * the installed 10.3.5 — `src/RNMBXModule.ts` exports it and the package's
 * `types` entry carries it). Called once at screen module scope beside the
 * token hand-off, idempotent-latched like it — AND from the offline-pack
 * controller's SDK door (PR #98 round 2): the map route's module scope does
 * not run before SDK work triggered from other tabs (see the token seam's
 * CALL SITES note), so the offline path calls it first itself.
 *
 * ORDERING IS NECESSARY, NOT SUFFICIENT. On iOS `setTelemetryEnabled(false)`
 * only writes the `MGLMapboxMetricsEnabled` UserDefaults key
 * (`RNMBXModule.swift` `setTelemetryEnabled`); per the PR #98 round-2 review
 * lane's reading of MapboxMaps, only `EventsManager.init` forwards that key to
 * the native SDK, and that runs only when a MapView/Snapshotter is created — so
 * in a Today-only session (no map view ever built) offline/TileStore work is
 * NOT yet opted out, whatever the call order. rnmapbox exposes no earlier
 * switch (follow-up: QUEUE row / escalation). On Android the call builds a
 * hidden `MapView(mReactContext)` on the UI thread that is never destroyed
 * (`RNMBXModule.kt` `setTelemetryEnabled`) — and now runs on ANY trip open
 * (Android pass: crash check on tokenless + token builds, billing check).
 *
 * The `typeof` guard: under jest the package is WHOLESALE-mocked, and the
 * global mock (jest.setup.js — the T-8.5-delivered coordination line this
 * rider escalated for) now PROVIDES `setTelemetryEnabled`, so screen suites
 * exercise the real call path. Absence still degrades to `false` instead of
 * a TypeError — map-style.test.ts arranges that arm by deleting the method
 * on its own registry. In a real build the method always exists (native
 * module contract); the guard's false arm is test-env-only.
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
