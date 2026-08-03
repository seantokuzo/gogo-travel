/**
 * Directions handoff URL (T-7.5 / IT-3 — itinerary spec R-itin-4: "a
 * 'Directions' handoff to Google/Apple Maps (never replace the nav app)").
 *
 * Lives HERE, beside `url-builders.ts`, so the app keeps ONE outbound-URL
 * home and one construction contract: a pure builder returning the same
 * `DeeplinkBuild` verdict the partner buttons use (`ready` → the exact URL,
 * `missing` → visible-but-disabled with a hint), every interpolation
 * `encodeURIComponent`-encoded. The caller opens it with `Linking.openURL`
 * exactly like `PartnerButton` does.
 *
 * INTERPRETATION — Google Maps, not Apple Maps: R-itin-4 says
 * "Google/Apple Maps" without choosing, and nothing in
 * `.specs/research/` documents a maps URL format. The Maps URLs API
 * (`?api=1`, no key required, documented `travelmode` set) is the only
 * cross-platform format with an official, versioned contract — it opens the
 * Google Maps app when installed and its web equivalent otherwise, on both
 * platforms. An `maps.apple.com?saddr/daddr/dirflg` variant for iOS would be
 * a nicer default on a stock iPhone, but §2.7's rule is "only
 * research-verified formats ship"; that variant needs a device-verify pass
 * first (same posture as the Airbnb/Turo caveats), so it is deliberately NOT
 * shipped here.
 *
 * INTERPRETATION — no return-prompt recording: R-itin-22 records a tap
 * `{partner, category, tripId, timestamp}` before opening a PARTNER URL so
 * the "Did you book it?" prompt can fire on return. A nav handoff books
 * nothing; recording it would prompt the user to log a booking they never
 * made. Directions taps are therefore not recorded.
 */
import type { TravelMode } from "@gogo/shared";

import type { DeeplinkBuild } from "./url-builders";

/** Documented Maps URLs API endpoint — `api=1` pins the parameter contract. */
export const GOOGLE_MAPS_DIRECTIONS_BASE = "https://www.google.com/maps/dir/?api=1";

/** `TravelMode` → the Maps URLs `travelmode` value (`cycling` is `bicycling`). */
export const DIRECTIONS_TRAVEL_MODE: Readonly<Record<TravelMode, string>> = {
  driving: "driving",
  walking: "walking",
  cycling: "bicycling",
  transit: "transit",
};

export interface DirectionsInput {
  /** Free-text origin ("Park Hyatt Tokyo"); null when the endpoint has no label. */
  origin: string | null;
  destination: string | null;
  mode: TravelMode;
  /**
   * Trip destination name, appended for disambiguation — a bare item title
   * ("Walk Shibuya") is a poor global query, "Walk Shibuya, Tokyo" is not.
   * The §2.7 lodging builders use `destination_name` the same way.
   */
  context?: string;
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** "Shibuya" + "Tokyo" → "Shibuya, Tokyo"; no context → the label alone. */
function withContext(label: string, context: string | undefined): string {
  const place = label.trim();
  if (!hasText(context)) return place;
  const suffix = context.trim();
  // Already qualified (the title contains the destination) — don't stutter.
  return place.toLowerCase().includes(suffix.toLowerCase()) ? place : `${place}, ${suffix}`;
}

/**
 * R-itin-4 directions handoff. Both endpoints need a usable free-text label;
 * an unnamed `place_visit` has none (the composite read carries no place
 * names — T-7.4's documented gap), so the row renders disabled with a hint
 * rather than opening a maps query for the literal string "Place visit".
 */
export function buildDirectionsUrl(input: DirectionsInput): DeeplinkBuild {
  const gaps: string[] = [];
  if (!hasText(input.origin)) gaps.push("a name or address for the start");
  if (!hasText(input.destination)) gaps.push("a name or address for the destination");
  if (gaps.length > 0) return { status: "missing", missing: gaps };

  const origin = encodeURIComponent(withContext(input.origin as string, input.context));
  const destination = encodeURIComponent(
    withContext(input.destination as string, input.context),
  );
  const travelmode = DIRECTIONS_TRAVEL_MODE[input.mode];
  return {
    status: "ready",
    url: `${GOOGLE_MAPS_DIRECTIONS_BASE}&origin=${origin}&destination=${destination}&travelmode=${travelmode}`,
  };
}
