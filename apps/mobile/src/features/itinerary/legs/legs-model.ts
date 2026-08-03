/**
 * Travel-leg model (T-7.5 / IT-3 — itinerary spec §2.2, R-itin-4/5/6). Pure:
 * the composite read's `legs` (API R-ib-13) → the chip data the day list
 * renders between consecutive located entries of a day.
 *
 * Legs are keyed `(from_item_id, to_item_id)` per §2.2 and are DIRECTIONAL —
 * the server maintains them for consecutive located pairs in `sort_order`
 * (R-ib-20), so a reorder invalidates the old pairing and the client simply
 * finds nothing for the new one. Absent ⇒ no chip (R-itin-6), which is also
 * how a still-computing / provider-down / unlocated pair renders. There is
 * deliberately NO spinner, NO error, and NO retry affordance on this surface.
 *
 * ABSENT/PARTIAL IS THE NORMAL CASE: with the Mapbox token parked, the leg
 * worker returns transit-only (keyless Transitous) results and driving /
 * walking / cycling legs are simply missing. `pickDefaultMode` therefore
 * degrades past R-itin-5's walking→driving ladder instead of dead-ending on
 * it (see its doc for the interpretation).
 */
import type { ISODate, TravelLeg, TravelMode } from "@gogo/shared";

import type { IconName } from "@/components";

/** R-itin-5: walking is the displayed mode while its leg is ≤ 15 minutes. */
export const WALKING_PREFERRED_MAX_SECONDS = 15 * 60;

export const TRAVEL_MODE_ICONS: Readonly<Record<TravelMode, IconName>> = {
  driving: "car-outline",
  walking: "walk-outline",
  cycling: "bicycle-outline",
  transit: "bus-outline",
};

export const TRAVEL_MODE_LABELS: Readonly<Record<TravelMode, string>> = {
  driving: "Drive",
  walking: "Walk",
  cycling: "Cycle",
  transit: "Transit",
};

/** Mode-Sheet row order — §2.2's "walk/drive/cycle/transit" listing order. */
export const TRAVEL_MODE_ORDER: readonly TravelMode[] = [
  "walking",
  "driving",
  "cycling",
  "transit",
];

/** One computed mode for a pair — a Sheet row (R-itin-4). */
export interface LegOption {
  mode: TravelMode;
  durationSeconds: number;
  distanceMeters: number;
  /** 'mapbox' / 'transitous' — surfaced as provenance in the mode Sheet. */
  provider: string;
}

/** A rendered travel-time chip: one pair, every mode computed for it. */
export interface DayLeg {
  /**
   * The day this chip renders on. A pair can be co-chained on TWO days — the
   * server stores one row per `(from, to, mode)` however many days it is
   * adjacent on (`recompute.ts`), and a spanning lodging chains into both its
   * check-in and check-out days. So neither the React key nor the testID is
   * unique on `fromItemId` alone; both are day-scoped.
   */
  renderDay: ISODate;
  fromItemId: string;
  toItemId: string;
  fromTitle: string;
  toTitle: string;
  /** Non-empty by construction — a pair with zero legs emits no chip. */
  options: LegOption[];
  /** R-itin-5 displayed mode. */
  defaultMode: TravelMode;
  /**
   * Free-text endpoint queries for the directions handoff, or null when the
   * endpoint has no resolvable label (an unnamed `place_visit` — the
   * composite read carries no place names yet, T-7.4's documented gap).
   */
  fromQuery: string | null;
  toQuery: string | null;
}

/**
 * §2.9 chip testID, day-scoped (see `DayLeg.renderDay`). ONE home so the
 * value `LegChip` renders and the value a test queries cannot drift apart.
 *
 * Flagged for the §2.9 sync batch: the inventory says
 * `itinerary-leg-{fromItemId}`, which stopped being unique once check-out
 * rows became leg endpoints — a spanning lodging is a FROM on two days, and
 * two chips carrying one testID make `getByTestId` throw and an E2E tap
 * ambiguous between two chips that open DIFFERENT Sheets. The mode-Sheet ids
 * below it (`…-mode-{mode}`, `…-directions`) stay exactly as §2.9 writes
 * them: only one Sheet is mounted at a time, so they cannot collide.
 */
export function legChipTestID(leg: Pick<DayLeg, "renderDay" | "fromItemId">): string {
  return `itinerary-leg-${leg.renderDay}-${leg.fromItemId}`;
}

/**
 * `(from, to)` index key. The separator is U+0000, which cannot occur in a
 * UUID, so the key is unambiguous.
 *
 * It is written as the ESCAPE `\u0000`, never as a raw byte: a literal NUL
 * makes git classify the file as binary, which strips it from `gh pr diff`
 * entirely and makes BSD `grep` exit 1 in silence. This module shipped that
 * way once (PR #18 round 1) and was invisible to the whole review panel.
 * Same landmine as `.claude/rules/server.md`'s control-byte rule; the
 * `no-nul-bytes` CI guard now enforces it repo-wide.
 */
export function legPairKey(fromItemId: string, toItemId: string): string {
  return `${fromItemId}\u0000${toItemId}`;
}

/** Pair index plus the set of item ids any leg starts from (see `fromIds`). */
export interface LegIndex {
  byPair: ReadonlyMap<string, LegOption[]>;
  /**
   * Every `from_item_id` present in the leg set. Lets a caller answer "can
   * anything start here?" in O(1) before walking a day — which matters
   * because the WORST case for that walk is the SHIPPED configuration: with
   * the Mapbox token parked most pairs have no legs, so a per-entry forward
   * scan probes to the end of its day every time. Built here because this
   * function already walks every leg exactly once.
   */
  fromIds: ReadonlySet<string>;
}

/**
 * Legs → `pairKey → options`, each pair's options in `TRAVEL_MODE_ORDER`.
 * Duplicate `(from, to, mode)` rows can't exist server-side (R-ib-22); a
 * duplicate arriving anyway keeps the FIRST occurrence (deterministic).
 */
export function indexLegsByPair(legs: readonly TravelLeg[]): LegIndex {
  const byPair = new Map<string, Map<TravelMode, LegOption>>();
  const fromIds = new Set<string>();
  for (const leg of legs) {
    fromIds.add(leg.from_item_id);
    const key = legPairKey(leg.from_item_id, leg.to_item_id);
    let modes = byPair.get(key);
    if (modes === undefined) {
      modes = new Map<TravelMode, LegOption>();
      byPair.set(key, modes);
    }
    if (modes.has(leg.mode)) continue;
    modes.set(leg.mode, {
      mode: leg.mode,
      durationSeconds: leg.duration_seconds,
      distanceMeters: leg.distance_meters,
      provider: leg.provider,
    });
  }

  const out = new Map<string, LegOption[]>();
  for (const [key, modes] of byPair) {
    const options = TRAVEL_MODE_ORDER.flatMap((mode) => {
      const option = modes.get(mode);
      return option === undefined ? [] : [option];
    });
    if (options.length > 0) out.set(key, options);
  }
  return { byPair: out, fromIds };
}

/**
 * R-itin-5 displayed mode: walking when the walking leg is ≤ 15 minutes,
 * else driving.
 *
 * INTERPRETATION (spec-uncovered): R-itin-5's ladder presumes the Mapbox
 * modes exist. They routinely do not — the token is parked, so a pair can
 * arrive transit-only. Dead-ending on "else driving" would hide a real,
 * computed leg behind an absent one, which R-itin-6 does not ask for (that
 * rule covers pairs with NO legs). The ladder therefore continues
 * transit → cycling → walking-over-15-min, in that order: transit is the
 * mode that actually ships today, cycling beats a 40-minute walk as a
 * headline, and a long walk is still better than no chip. When the full mode
 * set is present the first two rungs always win, so R-itin-5 is unchanged
 * for the case it specifies.
 */
export function pickDefaultMode(options: readonly LegOption[]): TravelMode | null {
  const byMode = new Map(options.map((option) => [option.mode, option]));
  const walking = byMode.get("walking");
  if (walking !== undefined && walking.durationSeconds <= WALKING_PREFERRED_MAX_SECONDS) {
    return "walking";
  }
  if (byMode.has("driving")) return "driving";
  for (const mode of ["transit", "cycling", "walking"] as const) {
    if (byMode.has(mode)) return mode;
  }
  return null;
}

/**
 * True when a pair has no travel at all: every computed mode is zero seconds
 * AND zero metres.
 *
 * The server writes exactly this on purpose — two consecutive located items
 * resolving to the SAME `place_id` are marked `samePlace` and upserted for
 * every mode with `duration 0, distance 0, provider "same_place"`, no
 * provider call. `duration_seconds` is `z.int().nonnegative()`, so 0 is a
 * first-class wire value, not a defensive hypothetical.
 *
 * INTERPRETATION (spec-uncovered): such a pair renders NO CHIP. R-itin-6's
 * "no chip" arm is about a pair with nothing to say, and "these two items are
 * at the same address" is that case — there is no travel to time. The
 * alternative renders "Walk 1 min" (or "0 min") between two items at one
 * address, over a Sheet whose four rows each read "0 m · same_place": a chip
 * that contradicts itself.
 */
export function isNoTravelLeg(options: readonly LegOption[]): boolean {
  return (
    options.length > 0 &&
    options.every((option) => option.durationSeconds === 0 && option.distanceMeters === 0)
  );
}

/**
 * Chip/Sheet duration copy: "18 min", "1 h 5 min", "2 h".
 *
 * INTERPRETATION (spec-uncovered): §2.2 shows only the `"18 min"` shape.
 * Seconds round to the nearest minute; a sub-minute-but-nonzero leg floors to
 * "1 min" because a leg that took SOME time should not read as none. An
 * exactly-zero leg reads "0 min" — it is the server's deliberate same-place
 * value, and reporting it as a minute of walking is a lie about the data.
 * (In practice `isNoTravelLeg` suppresses that chip before it renders; the
 * honest value is here for the Sheet and for a mixed pair.) Hours split off
 * above 60 minutes so a cross-city drive doesn't read as "95 min".
 */
export function formatLegDuration(seconds: number): string {
  if (seconds === 0) return "0 min";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Mode-Sheet distance copy: "450 m" / "1.2 km".
 *
 * INTERPRETATION (spec-uncovered): the spec never shows distance. It rides
 * the Sheet rows only (never the chip, which §2.2 fixes as duration + mode
 * icon) because "12 min · 3.4 km" is how a rider tells a plausible transit
 * leg from a nonsense one. Metric-only — the app has no locale/units
 * preference yet; when one lands this is its one call site.
 */
export function formatLegDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
