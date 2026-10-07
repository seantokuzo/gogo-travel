/**
 * Zone-name canonicalisation (B-30 round-1 server F3). The ONE gate every
 * zone must pass before it is stored or served as a trip's `destination_tz`:
 * user/device input on write AND booking `arrives_tz`/`departs_tz` on read.
 *
 * WHY NOT just "does `Intl` accept it": V8 resolves a long tail of legacy ids
 * (`SystemV/AST4`, `Japan`, `EST`, `Zulu`, lowercase `asia/tokyo`) that iOS
 * Hermes's `NSTimeZone` fallback does NOT (no `SystemV/*`), so the server
 * would judge the trip's day in a zone the client silently degrades to UTC
 * for — the exact server/client skew B-30 exists to kill. So membership is
 * decided against an ALLOW-LIST, case-insensitively, and the stored spelling
 * is the list's own (`asia/tokyo` -> `Asia/Tokyo`):
 *
 *   TZ_LOOKUP_ZONE_NAMES  (the 436 modern ids tz-lookup can return — what a
 *                          derived zone looks like, e.g. `Asia/Kolkata`,
 *                          `Europe/Kyiv`)
 * + Intl.supportedValuesOf("timeZone")  (the engine's canonical ids, e.g.
 *                          `Asia/Calcutta` — what a flight booking's
 *                          `arrives_tz` may carry)
 * + "UTC"                (the documented last-resort zone; neither list has it)
 *
 * NOT canonicalised through `resolvedOptions().timeZone`: that REWRITES
 * `Asia/Kolkata` -> `Asia/Calcutta`, `Europe/Kyiv` -> `Europe/Kiev`,
 * `Pacific/Kanton` -> `Pacific/Enderbury` — the very aliases old Hermes
 * rejects — so a canonical-through-the-engine store would hand clients ids
 * they resolve worse than the input.
 *
 * SPELLING CAVEAT: "modern" holds only for ids tz-lookup can return (its
 * spelling wins the case-fold: `asia/kolkata` -> `Asia/Kolkata`, `europe/kyiv`
 * -> `Europe/Kyiv`). An id the allow-list has ONLY via the engine's own list is
 * stored as the running engine spells it — `europe/kiev` -> `Europe/Kiev`,
 * `asia/calcutta` -> `Asia/Calcutta` — which is the spelling a flight booking's
 * `arrives_tz` carries. An alias is never rewritten to its modern name.
 *
 * Final sanity gate: the engine must still resolve the canonical id
 * (`isValidTimeZone`), so a runtime without a zone never stores it.
 */
import { isValidTimeZone, TIME_ZONE_ID_MAX_CHARS } from "@gogo/shared/time";
import { TZ_LOOKUP_ZONE_NAMES } from "./tz-zone-names.js";

/** `UTC` is the default zone (chain step 5) and a valid explicit choice; neither source list carries it. */
const EXTRA_ZONE_NAMES: readonly string[] = ["UTC"];

function engineZoneNames(): readonly string[] {
  // `supportedValuesOf` is Node >= 18 / V8; absent on an exotic runtime → the
  // tz-lookup list alone still covers every derivable zone.
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return supported === undefined ? [] : supported.call(Intl, "timeZone");
  } catch {
    return [];
  }
}

const CANONICAL_BY_LOWER: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  // tz-lookup's spelling wins a (never-observed) case-insensitive collision:
  // it is the modern IANA name a DERIVED zone would carry.
  for (const name of [...TZ_LOOKUP_ZONE_NAMES, ...EXTRA_ZONE_NAMES, ...engineZoneNames()]) {
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, name);
  }
  return map;
})();

/** Every zone name the allow-list accepts (canonical spelling) — exported for the tests. */
export function allowedZoneNames(): readonly string[] {
  return [...new Set(CANONICAL_BY_LOWER.values())];
}

/**
 * The allow-list's canonical spelling of `input` (modern IANA for a tz-lookup
 * id; the engine's own spelling for an engine-only alias such as `Europe/Kiev`
 * — see SPELLING CAVEAT above), or `null` when it is not an allowed zone.
 * Case-insensitive; never throws; ≤ 64 chars (the column cap).
 */
export function canonicalizeZone(input: string): string | null {
  if (input.length === 0 || input.length > TIME_ZONE_ID_MAX_CHARS) return null;
  const canonical = CANONICAL_BY_LOWER.get(input.toLowerCase());
  if (canonical === undefined) return null;
  return isValidTimeZone(canonical) ? canonical : null;
}
