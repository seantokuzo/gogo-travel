/**
 * Route-audit completeness (T-4.4 R1) — the SCREEN_ROUTES table in
 * src/test-utils/screen-routes.ts is a hardcoded audit: deletions/renames
 * already fail loudly (the URL stops matching), but ADDITIONS would rot
 * silently — a new route file would ship with zero §2.7 rule-2 coverage.
 *
 * This suite fs-walks `src/app/**` and asserts every non-layout route file
 * is addressed by a SCREEN_ROUTES URL (static segments match exactly,
 * `[param]` segments match anything, most-specific file wins — mirroring
 * expo-router's static-over-dynamic resolution). Adding a route now fails
 * HERE until it's added to the audit (or explicitly allowlisted below).
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { SCREEN_ROUTES } from "@/test-utils/screen-routes";

const APP_DIR = join(__dirname, "..", "app");

/**
 * Route files deliberately OUTSIDE the SCREEN_ROUTES audit. Keys are paths
 * relative to src/app; every entry must still exist on disk (stale entries
 * fail the audit) and must carry its reason.
 */
const ALLOWLIST: Record<string, string> = {
  "index.tsx": "entry redirect (R-nav-5) — exercised by the entry-redirect test ('/' → trip list)",
  "(trips)/index.tsx":
    "trip-list screen — asserted by the entry-redirect test and the walkthrough, not URL-audited",
  "gallery.tsx":
    "dev-only DS gallery (DS-10) — __DEV__-gated, outside spec §2.1; covered by gallery-screen.test.tsx",
};

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry.name.endsWith(".tsx") && entry.name !== "_layout.tsx") {
      out.push(relative(APP_DIR, full).split(sep).join("/"));
    }
  }
  return out;
}

/** File path (relative to src/app) → URL pattern segments, expo-router style. */
function toPatternSegments(file: string): string[] {
  const segments = file
    .replace(/\.tsx$/, "")
    .split("/")
    // Route groups are pathless.
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
  if (segments.at(-1) === "index") segments.pop();
  return segments;
}

/**
 * Static-segment match count, or null when the URL doesn't match. Dynamic
 * `[param]` segments match any value; higher score = more specific.
 */
function matchScore(pattern: string[], url: string): number | null {
  const urlSegments = url.split("/").filter(Boolean);
  if (pattern.length !== urlSegments.length) return null;
  let score = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith("[")) continue;
    if (pattern[i] !== urlSegments[i]) return null;
    score++;
  }
  return score;
}

const routeFiles = walkRouteFiles(APP_DIR);
const audited = routeFiles.filter((file) => !(file in ALLOWLIST));

describe("route-audit completeness (SCREEN_ROUTES ↔ src/app/**)", () => {
  it("finds the route tree (fs walk is not vacuous)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(27);
  });

  it("has no stale allowlist entries", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(routeFiles).toContain(file);
    }
  });

  it("every SCREEN_ROUTES URL resolves to exactly one route file", () => {
    for (const [url] of SCREEN_ROUTES) {
      const scores = audited
        .map((file) => ({ file, score: matchScore(toPatternSegments(file), url) }))
        .filter((m): m is { file: string; score: number } => m.score !== null);
      const best = Math.max(...scores.map((m) => m.score));
      const winners = scores.filter((m) => m.score === best);
      expect({ url, winners: winners.map((m) => m.file) }).toEqual({
        url,
        winners: [expect.any(String)],
      });
    }
  });

  it("every non-layout route file is addressed by the SCREEN_ROUTES audit", () => {
    const covered = new Set<string>();
    for (const [url] of SCREEN_ROUTES) {
      let best: { file: string; score: number } | undefined;
      for (const file of audited) {
        const score = matchScore(toPatternSegments(file), url);
        if (score !== null && (best === undefined || score > best.score)) {
          best = { file, score };
        }
      }
      if (best !== undefined) covered.add(best.file);
    }
    const unaudited = audited.filter((file) => !covered.has(file)).sort();
    // A file listed here shipped without §2.7 rule-2 coverage: add a
    // SCREEN_ROUTES row (URL + root testID) or an explicit ALLOWLIST reason.
    expect(unaudited).toEqual([]);
  });
});
