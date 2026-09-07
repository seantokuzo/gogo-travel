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
 *
 * RELEASE ARM RENDERS AN INERT MARKER, NOT `null` (S-4 PR #61 round 1 /
 * tests lane blocking finding). A bare `null` gives the Maestro E2E lane
 * (`.maestro/smoke-diagnostics-cold.yaml`, `deeplink-matrix.yaml` C6/W1)
 * nothing positive to assert on this route, so its cold-start pin could only
 * ever assert `sign-in-screen` is NOT visible — which is equally satisfied
 * by the app having crashed before this route ever mounted. The empty View
 * below carries NO dev surface, NO probes, NO leg content (R-test-2's
 * gate is untouched — `!__DEV__` still short-circuits before
 * `DiagnosticsScreen` or any of its imports run); it exists purely so a
 * cold `gogo://diagnostics` launch has a testID to assert IS visible,
 * proving the app is alive and this route actually rendered.
 */
import { View } from "react-native";
import { DiagnosticsScreen, installConsoleTap } from "@/features/dev/diagnostics";

// The __DEV__ gate lives INSIDE installConsoleTap (one canonical home,
// both arms pinned by console-tap.test.ts) — in release this line is a no-op
// and console.warn is never patched.
installConsoleTap();

export default function DiagnosticsRoute() {
  // Release: no dev surface, no legs, no probes — just an inert liveness
  // marker for the E2E lane (R-test-2 gate unchanged; DiagnosticsScreen and
  // everything it imports still never runs in this arm).
  if (!__DEV__) return <View testID="diagnostics-screen-inert" />;
  return <DiagnosticsScreen />;
}
