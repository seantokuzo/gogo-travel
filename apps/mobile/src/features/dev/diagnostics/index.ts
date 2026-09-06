/**
 * Device-smoke diagnostics (T-S3.5, R-test-2) — `__DEV__`-only panel behind
 * `gogo://diagnostics`. The route file owns the release gate; everything in
 * this directory assumes it only ever runs in dev.
 */
export { DiagnosticsScreen } from "./DiagnosticsScreen";
export type { DiagnosticsDeps } from "./DiagnosticsScreen";
export { installConsoleTap, readConsoleTap } from "./console-tap";
export type { ConsoleTapSnapshot } from "./console-tap";
