/**
 * Travel-leg computed-mode set (itinerary-bookings spec R-ib-21: "The mode
 * set is shared config, not code"). The leg-computation job computes exactly
 * these modes per located pair, and the client's travel chips render exactly
 * these — one list, two consumers.
 *
 * This list is also THE quota lever (spec §3.5 step 6): under Mapbox
 * free-tier pressure, shrinking it is a config PR, not a code change.
 * Removing a mode stops new computation of it; existing rows age out via the
 * recompute cleanup (rows for pruned modes are deleted when their day is
 * next recomputed — desired-set diffing covers mode-set shrink for free).
 */
import { TRAVEL_MODES, type TravelMode } from "../enums.js";

/**
 * Modes the leg job computes per adjacent located pair (R-ib-21):
 * `driving`/`walking`/`cycling` via Mapbox Directions, `transit` via
 * Transitous. Must stay a subset of `TRAVEL_MODES` (the wire enum).
 */
export const COMPUTED_TRAVEL_MODES: readonly TravelMode[] = TRAVEL_MODES;
