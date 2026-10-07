/**
 * Calendar-day-in-a-zone helper (B-30; trips spec §3.4 timezone note).
 *
 * A trip's "today" is the calendar day AT THE TRIP'S DESTINATION (Sean's
 * ruling, 2026-09-19) — not the server's UTC day, not the device's local
 * day. Server (`trips/status.ts`) and client (`navigation/trip-defaults.ts`)
 * both call THIS function with the trip's effective `destination_tz`, so the
 * boundary day cannot drift between surfaces (the same single-seam pattern
 * as `deriveTripStatus`).
 *
 * PLATFORM NOTES (this package runs on Node AND Hermes — R-shared-9):
 *  - Uses only `Intl.DateTimeFormat` + `formatToParts` with `year` / `month` /
 *    `day` — NOT `en-CA` `.format()` (locale-dependent output shape), NOT
 *    `hour12` / `hourCycle` (a date-only read has no hour-cycle exposure —
 *    see the Hermes `hour12`-discards-`hourCycle` landmine in
 *    `.claude/rules/mobile.md`), NEVER `Intl.NumberFormat.formatToParts`
 *    (a hard process abort on iOS Hermes).
 *  - No dependency on the process/device zone: the answer is a pure function
 *    of the instant and the zone id.
 *
 * NEVER THROWS. A null/empty/unknown/over-long/non-IANA-shaped zone resolves to the UTC date
 * (the documented last-resort zone of the destination-zone chain). A
 * formatter that answers implausibly (any real zone is within −12h…+14h of
 * UTC, so its calendar day is within ±1 of the UTC day) is treated as an
 * unknown zone too — wrong-by-a-day from a misbehaving engine must degrade
 * to UTC, never to a believable wrong day.
 */
import type { ISODate } from "./scalars.js";

/** `trips.destination_tz` cap (migration 0007 CHECK; wire schema max). */
export const TIME_ZONE_ID_MAX_CHARS = 64;

/**
 * IANA-shaped id: letters/digits/`_`/`+`/`-` segments joined by `/` (covers
 * `UTC`, `Etc/GMT+12`, `America/Argentina/Buenos_Aires`, `EST5EDT`). Enforced
 * BEFORE the engine so every runtime answers the same: a modern V8 accepts
 * offset zones like `+05:00` as a `timeZone`, Hermes does not — letting that
 * through would make server and client disagree about a trip's day.
 */
export const IANA_TIME_ZONE_ID_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Most distinct zones a process ever sees is ~600 tzdb ids; cap the cache anyway. */
const FORMATTER_CACHE_MAX = 512;

const DAY_MS = 86_400_000;

/** Returned for an invalid `Date` (no calendar day exists) — deterministic, never matches a real trip. */
const INVALID_INSTANT_SENTINEL: ISODate = "1970-01-01";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * One cached formatter per zone (the `zoned-time.ts` `formatterFor` precedent).
 * Returns `null` for an id the engine rejects. Failures are NOT cached, so a
 * hostile stream of distinct bad ids cannot grow the map.
 */
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(tz);
  if (cached !== undefined) return cached;
  if (tz.length > TIME_ZONE_ID_MAX_CHARS || !IANA_TIME_ZONE_ID_RE.test(tz)) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return null;
  }
  if (formatterCache.size >= FORMATTER_CACHE_MAX) formatterCache.clear();
  formatterCache.set(tz, formatter);
  return formatter;
}

/**
 * Whether the platform's `Intl` resolves `tz` (canonical ids AND backward
 * links — `Asia/Calcutta` as well as `Asia/Kolkata`), the id is IANA-shaped
 * and fits the `destination_tz` cap. The server's explicit-zone and
 * booking-zone gate.
 */
export function isValidTimeZone(tz: string): boolean {
  return formatterFor(tz) !== null;
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

function utcDateOf(now: Date): ISODate {
  return `${pad(now.getUTCFullYear(), 4)}-${pad(now.getUTCMonth() + 1, 2)}-${pad(now.getUTCDate(), 2)}`;
}

/**
 * The calendar date (`YYYY-MM-DD`) at instant `now` in IANA zone `tz`.
 * `tz` null/undefined/unknown → the UTC date. An invalid `now` (NaN time)
 * has no calendar day: returns the fixed sentinel `1970-01-01` (never
 * throws; callers pass a clock reading, so this is a defensive floor).
 */
export function todayInZone(now: Date, tz: string | null | undefined): ISODate {
  const instantMs = now.getTime();
  if (Number.isNaN(instantMs)) return INVALID_INSTANT_SENTINEL;

  const utc = utcDateOf(now);
  if (tz === null || tz === undefined) return utc;
  const formatter = formatterFor(tz);
  if (formatter === null) return utc;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(now);
  } catch {
    return utc;
  }
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < 100 ||
    year > 9999
  ) {
    return utc;
  }

  // Plausibility gate: the zone's calendar day is within one day of the UTC
  // day for every real zone (UTC−12 … UTC+14). Years below 100 are excluded
  // above because `Date.UTC` maps them to 1900+ (and the engine answer for a
  // modern instant would be implausible anyway).
  const zoneDayMs = Date.UTC(year, month - 1, day);
  const utcDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (Math.abs(zoneDayMs - utcDayMs) > DAY_MS) return utc;

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
