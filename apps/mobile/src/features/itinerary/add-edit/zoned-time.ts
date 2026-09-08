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
 *
 * B-9 R1 — WRONG IS NOT AN OPTION HERE. jest runs Node/V8 with full ICU;
 * the app runs Hermes, whose iOS `Intl` is a Foundation reimplementation
 * (see `isIntlFaithful`). So every answer this module gives is gated three
 * ways, and each gate turns a divergence into `null` (→ `TZ_UNKNOWN_ERROR`)
 * rather than a believable instant: an engine self-check against known
 * truth, a tzdb-range check on every candidate offset, and a signature test
 * that tells a real spring-forward gap from an engine contradicting itself.
 * `zoned-time.hermes.test.ts` runs the whole module against a
 * Hermes-Apple-shaped `Intl` to keep those gates honest.
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

/**
 * tzdb's whole range: `Etc/GMT+12` (−12:00) to `Pacific/Kiritimati` (+14:00).
 * B-9 R1: an offset outside it isn't a zone, it is arithmetic on a misread
 * clock — "-19:00" and "+21:00" are both well-formed enough to reach the
 * wire, so the range is a gate, not a comment.
 */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

function isPlausibleOffset(offsetMinutes: number): boolean {
  return (
    Number.isFinite(offsetMinutes) &&
    offsetMinutes >= MIN_OFFSET_MINUTES &&
    offsetMinutes <= MAX_OFFSET_MINUTES
  );
}

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

interface WallParts {
  year: number;
  month: number;
  day: number;
  /** Already `% 24` — an h24 engine's "24" is midnight, not hour 24. */
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock `tz` shows at `utcMs`, read back out of the formatter. */
function wallPartsAt(tz: string, utcMs: number): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

// ---------------------------------------------------------------------------
// Engine self-check — B-9 R1 (tests lane, blocking)
// ---------------------------------------------------------------------------

/**
 * 17:05:09 UTC on a fixed date: a PM hour (an h12 engine reads 5), a
 * two-digit minute, a non-zero second. Every component is known truth.
 */
const PROBE_PM_MS = Date.UTC(2027, 3, 24, 17, 5, 9);
/** Midnight — what the `% 24` guard exists for; an h12 engine reads 12. */
const PROBE_MIDNIGHT_MS = Date.UTC(2027, 3, 24, 0, 0, 0);

let intlFaithful: boolean | null = null;

/**
 * Does THIS engine's `formatToParts` answer the question we actually asked?
 *
 * This module is the repo's only ECMA-402 dependency and the app ships
 * HERMES, whose iOS `Intl` is a Foundation/`NSDateFormatter`
 * reimplementation rather than ICU: `PlatformIntlApple.mm` re-derives part
 * types by walking the resolved pattern's letters (falling back to
 * `literal` for anything unmapped), and `en-US`'s Apple-default hour cycle
 * is h12 — `hourCycle: "h23"` above is a REQUEST, not a guarantee.
 *
 * A uniformly shifted hour is INVISIBLE to `resolveWallTime`'s round-trip
 * filter whenever the sampled instant and the resolved instant land in the
 * same 12h half: both reads are wrong by the same 12h, the filter agrees
 * with itself, and the composition hands back a well-formed string up to
 * 12h wrong — no null, no throw. That is B-8 one layer down, and it cannot
 * be caught per-call because the wrong answer is self-consistent.
 *
 * So ask the engine two questions whose answers we already know, in `UTC`
 * (no zone database involved), and refuse to compose ANYTHING if either
 * comes back wrong. Computed once; callers turn the resulting `null` into
 * `TZ_UNKNOWN_ERROR` — loud, never plausible.
 */
export function isIntlFaithful(): boolean {
  if (intlFaithful !== null) return intlFaithful;
  let faithful: boolean;
  try {
    const pm = wallPartsAt("UTC", PROBE_PM_MS);
    const midnight = wallPartsAt("UTC", PROBE_MIDNIGHT_MS);
    faithful =
      pm.year === 2027 &&
      pm.month === 4 &&
      pm.day === 24 &&
      pm.hour === 17 &&
      pm.minute === 5 &&
      pm.second === 9 &&
      midnight.day === 24 &&
      midnight.hour === 0 &&
      midnight.minute === 0;
  } catch {
    // A reduced part set reads NaN and `formatToParts(new Date(NaN))`
    // throws `RangeError`; an engine that lands here composes nothing.
    faithful = false;
  }
  intlFaithful = faithful;
  return faithful;
}

/**
 * Test seam: drop the per-engine memos so a suite that swaps `Intl` sees
 * its own engine (paired with `resetTimeZoneCatalogForTests`).
 */
export function resetZonedTimeCachesForTests(): void {
  formatterCache.clear();
  knownZoneCache.clear();
  intlFaithful = null;
}

/**
 * The zone's UTC offset (minutes east) at the instant `utcMs`. Throws
 * `RangeError` for an unknown zone — callers gate with `isKnownTimeZone`.
 * Returns `NaN` when the engine omits a part it was asked for; callers
 * treat a non-finite offset as "this engine cannot answer".
 */
export function zoneOffsetMinutesAt(tz: string, utcMs: number): number {
  const wall = wallPartsAt(tz, utcMs);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
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
  // B-9 R1: a shifted-hour engine composes a SELF-CONSISTENT wrong instant,
  // so this gate is up front and absolute rather than per-candidate.
  if (!isIntlFaithful()) return null;
  if (!isKnownTimeZone(tz)) return null;
  const wall = wallAsUtcMs(date, time);
  if (wall === null) return null;

  try {
    const candidates = [
      ...new Set([
        zoneOffsetMinutesAt(tz, wall - DAY_MS),
        zoneOffsetMinutesAt(tz, wall),
        zoneOffsetMinutesAt(tz, wall + DAY_MS),
      ]),
      // A missing part reads NaN the whole way through, and a misread clock
      // produces arithmetic no zone has ever had. Neither is a candidate.
    ].filter(isPlausibleOffset);
    if (candidates.length === 0) return null;

    const valid = candidates.filter(
      (offset) => zoneOffsetMinutesAt(tz, wall - offset * MINUTE_MS) === offset,
    );
    if (valid.length === 1) return { offsetMinutes: valid[0] as number, kind: "unique" };
    if (valid.length > 1) return { offsetMinutes: Math.max(...valid), kind: "ambiguous" };

    // Nothing round-tripped. That is EITHER a real spring-forward gap or an
    // engine contradicting itself, and the two must not share an outcome:
    // `Math.min(...candidates)` is right for the first and a believable
    // wrong instant for the second (B-9 R1, tests lane cross-lane).
    //
    // A real gap has an exact signature — applying the pre-transition offset
    // lands AFTER the transition, so it reads back as the other sampled
    // offset, which is larger (clocks sprang forward) and which itself maps
    // back to the pre-transition offset. The two point at each other.
    // Anything else means the zone's own answers are incoherent: fail loud.
    const pre = Math.min(...candidates);
    const post = zoneOffsetMinutesAt(tz, wall - pre * MINUTE_MS);
    const isGap =
      candidates.includes(post) &&
      post > pre &&
      zoneOffsetMinutesAt(tz, wall - post * MINUTE_MS) === pre;
    return isGap ? { offsetMinutes: pre, kind: "gap" } : null;
  } catch {
    // `formatToParts(new Date(NaN))` throws `RangeError`, which a degraded
    // engine reaches through a NaN candidate. The documented contract is
    // "null, never a throw" — honor it rather than taking out the save
    // handler and, through `livePlacements`, the form's whole render.
    return null;
  }
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
export function referenceInstantFor(
  date: string | undefined,
  now: () => number = Date.now,
): number {
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
  // B-9 R1: this runs during RENDER (every picker row, every zone field). An
  // engine that can't read its own parts throws `RangeError` out of
  // `zoneOffsetMinutesAt` — a white screen on the booking form. `null` is
  // the documented answer, so callers fall back to the raw id honestly.
  if (!isIntlFaithful()) return null;
  if (!isKnownTimeZone(tz)) return null;
  let offsetMinutes: number;
  try {
    offsetMinutes = zoneOffsetMinutesAt(tz, atUtcMs);
  } catch {
    return null;
  }
  if (!isPlausibleOffset(offsetMinutes)) return null;
  return {
    id: tz,
    city: zoneCityLabel(tz),
    region: zoneRegionLabel(tz),
    gmt: gmtLabelOf(offsetMinutes),
  };
}
