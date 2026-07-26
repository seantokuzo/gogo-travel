/**
 * Deep-link registry (T-6.6 / NAV-5; navigation.spec §2.3) — the single
 * source of truth for parse → target across every transport. Consumed by
 * `app/+native-intent.tsx`, which expo-router invokes for BOTH the cold-start
 * initial URL (`initial: true`) and warm `url` events (`initial: false`) —
 * cold/warm parity (R-nav-16) is structural: one function, both paths.
 *
 * §2.3 table:
 *   /invite/[token]                  → /join/[token]                (R-nav-11)
 *   /t/[tripId]                      → /[tripId]  (default tab)     (R-nav-15 guard)
 *   /t/[tripId]/request/[requestId]  → /[tripId]/money/request/[id] (R-nav-13)
 *   anything else on OUR domain      → /(trips) + notice            (R-nav-17)
 *
 * Transports (all mirror the same paths):
 *   https://<LINK_DOMAIN>/…  — universal link. Non-family paths on the domain
 *     are FALLBACK: the domain serves only the registry table (AASA publishes
 *     exactly these path families), so anything else is a dead link.
 *   gogo://…                 — custom scheme. The scheme is ALSO the app's
 *     everyday deep-link scheme (expo-linking createURL, dev QA, future
 *     notification routing), so non-family paths PASS THROUGH to the router
 *     untouched — internal routes keep working; true unknowns fall to
 *     `+not-found`, which owns the R-nav-17 fallback.
 *   bare paths ("/invite/x") — what the router hands over once a host is
 *     already stripped (and what the test harness delivers). Family shapes
 *     are claimed; everything else passes through.
 *
 * Trip-id validity is deliberately NOT checked here: the server folds
 * malformed ids into the same indistinguishable 404 as nonexistent and
 * non-member trips (R-trips-1), and the `[tripId]` guard renders the one
 * no-access state for all of them — a client-side UUID check would just be
 * a second copy of that boundary.
 */
import { APP_SCHEME, LINK_DOMAIN } from "@gogo/shared";

export type DeepLinkResolution =
  /** Rewrite the incoming URL to this in-app path. */
  | { kind: "target"; path: string }
  /** Recognized as ours but unknown/dead — land on the trip list + notice (R-nav-17). */
  | { kind: "fallback" }
  /** Not the registry's — hand the URL to the router untouched. */
  | { kind: "passthrough" };

const TARGET = (path: string): DeepLinkResolution => ({ kind: "target", path });
const FALLBACK: DeepLinkResolution = { kind: "fallback" };
const PASSTHROUGH: DeepLinkResolution = { kind: "passthrough" };

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;

/** Path portion → segments, query/hash stripped, empties dropped. */
function toSegments(path: string): string[] {
  const clean = path.split(/[?#]/, 1)[0];
  return clean.split("/").filter((segment) => segment.length > 0);
}

/**
 * §2.3 family mapping over normalized segments. `strict` = the transport
 * proves the link is ours (universal-link domain), so non-family shapes are
 * dead links (fallback) instead of router candidates (passthrough).
 */
function resolveFamily(segments: string[], strict: boolean): DeepLinkResolution {
  const miss = strict ? FALLBACK : PASSTHROUGH;

  if (segments[0] === "invite") {
    // Invite tokens are single URL-safe segments (R-db-9); anything else is
    // a malformed invite link on EITHER transport — never a router candidate.
    return segments.length === 2 ? TARGET(`/join/${segments[1]}`) : FALLBACK;
  }

  if (segments[0] === "t") {
    // /t/[tripId] and /t/[tripId]/request/[requestId] — the `t` namespace is
    // the registry's on every transport; malformed shapes under it fall back.
    if (segments.length === 2) return TARGET(`/${segments[1]}`);
    if (segments.length === 4 && segments[2] === "request") {
      return TARGET(`/${segments[1]}/money/request/${segments[3]}`);
    }
    return FALLBACK;
  }

  return miss;
}

/** Resolve any incoming URL or path per the §2.3 registry. */
export function parseDeepLink(url: string): DeepLinkResolution {
  const match = SCHEME_RE.exec(url);

  if (match === null) {
    // Bare path — host already stripped upstream. Family shapes are claimed;
    // anything else may be a legitimate internal route, so pass through.
    return url.startsWith("/") ? resolveFamily(toSegments(url), false) : PASSTHROUGH;
  }

  const scheme = match[1].toLowerCase();
  const rest = match[2];

  if (scheme === "https" || scheme === "http") {
    const slash = rest.indexOf("/");
    const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    if (host !== LINK_DOMAIN) return PASSTHROUGH; // someone else's URL
    const path = slash === -1 ? "" : rest.slice(slash);
    return resolveFamily(toSegments(path), true);
  }

  if (scheme === APP_SCHEME) {
    // Custom scheme: the "host" is the first path segment (gogo://invite/x).
    return resolveFamily(toSegments(`/${rest}`), false);
  }

  // Foreign scheme (exp dev-client, OAuth redirects, …) — not ours.
  return PASSTHROUGH;
}
