/**
 * Zoned wall-time composition (B-9 client half — the B-8 real fix).
 *
 * The form captures a WALL date + time per endpoint (what the traveler's
 * ticket says) plus the endpoint's IANA zone (from the airport pick or the
 * zone picker). The wire wants `YYYY-MM-DDTHH:MM:SS±HH:MM` (booking.ts
 * `localTime` — ISO with an explicit offset) and the zone id beside it
 * (`departs_tz`/`arrives_tz`). This module turns (date, time, zone) into
 * that offset string with the offset THE ZONE HAD AT THAT WALL TIME —
 * DST-aware, per endpoint, never a uniform per-booking offset (the
 * `DST_FALL_BACK_STAY` corruption class in `@gogo/shared/testing`).
 *
 * NO date library: RN 0.86 / Hermes ship ECMA-402 `Intl.DateTimeFormat`
 * with `timeZone` + `formatToParts` on both platforms (Hermes
 * doc/IntlAPIs.md — DateTimeFormat is one of the three implemented
 * services; the iOS/Android option gaps are `numberingSystem` /
 * `formatMatcher` / `dayPeriod` / `fractionalSecondDigits`, none used
 * here). Hermes does NOT implement `Intl.supportedValuesOf`, which is why
 * the picker's zone list is a static tzdb catalog (`time-zone-catalog.ts`)
 * rather than a runtime enumeration.
 *
 * Offset resolution = "what wall clock does this zone show at instant X",
 * read back through the formatter and differenced against X. A wall time
 * maps to 0, 1 or 2 instants; the two DST edges resolve the way Temporal's
 * `disambiguation: "compatible"` does (the java.time / Luxon default):
 *  - AMBIGUOUS (fall-back replay, `DST_FALL_BACK_AMBIGUOUS`): the EARLIER
 *    instant — the first time the clock showed that wall time (the
 *    pre-transition, larger offset);
 *  - GAP (spring-forward skip, `DST_SPRING_FORWARD_GAP`): the LATER instant
 *    — the pre-transition offset applied to the entered wall time, so the
 *    instant equals "wall time shifted forward by the gap" while the wire
 *    string keeps the wall components the user typed (the server slices
 *    those for display, §3.3).
 * Both are recorded as PR interpretations (spec-uncovered).
 */

/** `±HH:MM` — the fixtures' offset shape (`@gogo/shared/testing` UtcOffset). */
export type UtcOffsetText = `+${string}` | `-${string}`;

export type WallResolutionKind = "unique" | "ambiguous" | "gap";

export interface WallResolution {
  /** Minutes east of UTC in force for the composed instant. */
  offsetMinutes: number;
  kind: WallResolutionKind;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const knownZoneCache = new Map<string, boolean>();

/**
 * One cached formatter per zone: `en-US` numerics, `h23` so midnight reads
 * "00" (with `hour12: false` some engines emit "24"); the `% 24` in
 * `zoneOffsetMinutesAt` guards the remaining engines anyway.
 */
function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(tz, formatter);
  return formatter;
}

/**
 * Whether the platform's ICU resolves `tz` (canonical ids AND backward
 * links — `Asia/Calcutta` resolves as well as `Asia/Kolkata`). Unknown ids
 * throw `RangeError` from the constructor; cached either way.
 */
export function isKnownTimeZone(tz: string): boolean {
  if (tz === "") return false;
  const cached = knownZoneCache.get(tz);
  if (cached !== undefined) return cached;
  let known: boolean;
  try {
    formatterFor(tz);
    known = true;
  } catch {
    known = false;
  }
  knownZoneCache.set(tz, known);
  return known;
}

/**
 * The zone's UTC offset (minutes east) at the instant `utcMs`. Throws
 * `RangeError` for an unknown zone — callers gate with `isKnownTimeZone`.
 */
export function zoneOffsetMinutesAt(tz: string, utcMs: number): number {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const wallAsUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  // The formatter reads at second precision; drop the instant's sub-second
  // part before differencing so a 999 ms residue can't round the wrong way.
  const wholeSeconds = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return Math.round((wallAsUtc - wholeSeconds) / MINUTE_MS);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Wall date + time → the pseudo-instant `Date.UTC(wall components)`, or null when malformed. */
function wallAsUtcMs(date: string, time: string): number | null {
  const dateMatch = DATE_RE.exec(date);
  const timeMatch = TIME_RE.exec(time);
  if (dateMatch === null || timeMatch === null) return null;
  const ms = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolve the offset a wall (date, time) carries in `tz`. Candidate offsets
 * are the zone's offsets one day either side of the pseudo-instant (any
 * transition touching the wall time lies inside ±24h — offsets span
 * −12..+14h); a candidate is VALID when applying it round-trips to the same
 * wall clock. 1 valid → unique; 2 → ambiguous (earlier instant = larger
 * offset); 0 → gap (later instant = the smaller, pre-transition offset).
 * `null` for an unknown zone or malformed wall values.
 */
export function resolveWallTime(tz: string, date: string, time: string): WallResolution | null {
  if (!isKnownTimeZone(tz)) return null;
  const wall = wallAsUtcMs(date, time);
  if (wall === null) return null;

  const candidates = [
    ...new Set([
      zoneOffsetMinutesAt(tz, wall - DAY_MS),
      zoneOffsetMinutesAt(tz, wall),
      zoneOffsetMinutesAt(tz, wall + DAY_MS),
    ]),
  ];
  const valid = candidates.filter(
    (offset) => zoneOffsetMinutesAt(tz, wall - offset * MINUTE_MS) === offset,
  );
  if (valid.length === 1) return { offsetMinutes: valid[0] as number, kind: "unique" };
  if (valid.length > 1) return { offsetMinutes: Math.max(...valid), kind: "ambiguous" };
  return { offsetMinutes: Math.min(...candidates), kind: "gap" };
}

/** Minutes east of UTC → `±HH:MM` (`+09:00`, `-07:00`, `+05:45`, `+00:00`). */
export function formatUtcOffset(offsetMinutes: number): UtcOffsetText {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

/**
 * THE composition: wall date + time in `tz` → `YYYY-MM-DDTHH:MM:00±HH:MM`
 * (the exact shape the hostile fixtures' `localISO` pins). `null` when the
 * zone is unknown or the wall values are malformed — callers turn that into
 * a field error, never a throw.
 */
export function composeZonedDateTime(date: string, time: string, tz: string): string | null {
  const resolved = resolveWallTime(tz, date, time);
  if (resolved === null) return null;
  return `${date}T${time}:00${formatUtcOffset(resolved.offsetMinutes)}`;
}

/**
 * The device's zone per ICU (`resolvedOptions().timeZone`), or "UTC" when
 * the runtime can't say — the last rung of the picker's default ladder.
 */
export function deviceTimeZone(): string {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && isKnownTimeZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Display — city-labeled, never a bare offset (Sean's stated preference)
// ---------------------------------------------------------------------------

/** `America/Argentina/Buenos_Aires` → "Buenos Aires"; `UTC` → "UTC". */
export function zoneCityLabel(tz: string): string {
  const last = tz.slice(tz.lastIndexOf("/") + 1);
  return last.replaceAll("_", " ");
}

/** `America/Argentina/Buenos_Aires` → "America"; `UTC` → "". */
export function zoneRegionLabel(tz: string): string {
  const slash = tz.indexOf("/");
  return slash === -1 ? "" : tz.slice(0, slash);
}

/** Offset text for humans: "GMT+9", "GMT-7", "GMT+5:45", "GMT" at zero. */
export function gmtLabelOf(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "GMT";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${hours}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}

/**
 * Noon UTC on a wall date — the reference instant for a zone's DISPLAY
 * offset when a field carries a date but the exact instant isn't composed
 * yet ("GMT-7" in April, "GMT-8" in January). Falls back to `now`.
 */
export function referenceInstantFor(date: string | undefined, now: () => number = Date.now): number {
  if (date === undefined) return now();
  const ms = wallAsUtcMs(date, "12:00");
  return ms ?? now();
}

export interface TimeZoneDescription {
  id: string;
  /** "Tokyo" — the id's last segment, underscores spaced. */
  city: string;
  /** "Asia" — the id's first segment ("" for `UTC`). */
  region: string;
  /** "GMT+9" — at `atUtcMs`. */
  gmt: string;
}

/**
 * One row of picker/field copy. `null` for an unknown zone so callers can
 * render a stored-but-unresolvable id honestly instead of throwing.
 */
export function describeTimeZone(tz: string, atUtcMs: number): TimeZoneDescription | null {
  if (!isKnownTimeZone(tz)) return null;
  return {
    id: tz,
    city: zoneCityLabel(tz),
    region: zoneRegionLabel(tz),
    gmt: gmtLabelOf(zoneOffsetMinutesAt(tz, atUtcMs)),
  };
}
