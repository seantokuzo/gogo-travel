/**
 * Device-smoke diagnostics route (T-S3.5, R-test-2; ADR-006 layer 2).
 *
 * GATING: `__DEV__`-only — a release build renders NOTHING here (spec
 * acceptance; read at render time so both arms are pinnable). File-based
 * routing can't conditionally register routes (gallery precedent), so the
 * route always exists but only dev builds mount content.
 *
 * ENTRY: deeplink only — `gogo://diagnostics` (SpringBoard prompt is
 * tappable on a physical device; the no-tap constraint is about automation),
 * or the dev-client launcher URL field. NO visible entry affordance exists:
 * the sign-in-footer link is a parked Sean question (spec §6 Q2). The path
 * passes through the deep-link registry untouched (non-family custom-scheme
 * paths are router candidates — deep-links.ts).
 *
 * REACHABILITY: sibling of sign-in in the `(auth)` group — the auth gate
 * renders unauthed (auth) routes, so the panel works exactly when sign-in is
 * broken (the B-5 condition). When a user IS signed in the gate's "resume"
 * arm bounces (auth) routes into the app; authed access rides the parked
 * entry-affordance decision.
 *
 * The console tap installs at module scope so B-6's dev surface is captured
 * from the moment the route tree loads, not first panel open.
 */
import { DiagnosticsScreen, installConsoleTap } from "@/features/dev/diagnostics";

// The __DEV__ gate lives INSIDE installConsoleTap (one canonical home,
// both arms pinned by console-tap.test.ts) — in release this line is a no-op
// and console.warn is never patched.
installConsoleTap();

export default function DiagnosticsRoute() {
  // Release: nothing mounts — no legs, no probes, no dev surface (R-test-2).
  if (!__DEV__) return null;
  return <DiagnosticsScreen />;
}
