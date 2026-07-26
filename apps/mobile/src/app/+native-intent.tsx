/**
 * Native-intent hook (T-6.6 / NAV-5; navigation.spec §2.3 mechanics).
 *
 * expo-router invokes `redirectSystemPath` for EVERY incoming native URL —
 * the cold-start initial URL (`initial: true`, via `getInitialURL`) and warm
 * `url` events (`initial: false`, via the linking subscription) — so
 * cold/warm parity (R-nav-16) is one function, both paths, by construction.
 * The `initial` flag is deliberately unused.
 *
 * Contract notes (expo-router 57 `NativeIntent` type):
 * - A FALSY return CANCELS navigation (it does not "pass through") — the
 *   passthrough case must return the ORIGINAL path.
 * - Throwing here can crash the app — everything is fenced in try/catch and
 *   the failure answer is the default landing route (R-nav-17 posture).
 *
 * Registry misses that are provably ours (universal-link domain, malformed
 * families) rewrite to the trip list AND set the non-blocking notice
 * (R-nav-17); everything else passes through — internal routes keep working
 * and true unknowns fall to `+not-found`, which owns the same fallback.
 */
import { parseDeepLink } from "@/navigation/deep-links";
import { showLinkNotice } from "@/navigation/link-notice";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const resolution = parseDeepLink(path);
    if (resolution.kind === "target") return resolution.path;
    if (resolution.kind === "fallback") {
      showLinkNotice();
      return "/(trips)";
    }
    return path;
  } catch {
    // Never crash on a crafted URL — land on the default route (R-nav-17).
    return "/(trips)";
  }
}
