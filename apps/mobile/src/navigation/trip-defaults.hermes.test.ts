/**
 * The trip-day clock on the runtime the app ACTUALLY SHIPS (B-30 — testing.md
 * §4, "Hermes ≠ Node"; sibling of `zoned-time.hermes.test.ts`).
 *
 * `trip-defaults.test.ts` runs on Node/V8 with full ICU. The app ships
 * HERMES, whose iOS `Intl` is a Foundation/`NSDateFormatter` reimplementation
 * (`PlatformIntlApple.mm`) that formats to a string and re-derives each part's
 * type from the resolved pattern's letters, mapping anything it doesn't know
 * to `literal` (facebook/hermes#1172). `todayInZone` reads ONLY the `year`,
 * `month` and `day` parts — no hour cycle, no `NumberFormat` — so the classes
 * that matter are: (a) the faithful engine, (b) a part typed `literal` /
 * a throwing `formatToParts`, (c) tzdb backward links rejected pre-#1611, (d)
 * an engine that answers a believable-but-impossible day. The bar on every
 * arm: the SAME answer full ICU gives, or the documented UTC-day degrade —
 * never a plausible wrong day, never a throw.
 *
 * Each case loads `trip-defaults` (and with it `@gogo/shared`'s per-zone
 * formatter cache) into a FRESH module registry AFTER the stub is installed,
 * because the cache is per-engine: a formatter built on real ICU must not
 * answer for the engine under test.
 */
import type * as TripDefaults from "./trip-defaults";

const RealDateTimeFormat = Intl.DateTimeFormat;

interface HermesIntlShape {
  /** Part types the engine fails to map — emitted as `literal`. */
  literalParts?: readonly Intl.DateTimeFormatPartTypes[];
  /** `NSTimeZone.knownTimeZoneNames` gap: ids the PRE-#1611 constructor rejected (#1607). */
  rejectsZone?: (tz: string) => boolean;
  /** `formatToParts` itself throws (a NaN cascade on device). */
  formatToPartsThrows?: boolean;
  /** Days added to the rendered `day` part — an engine that is confidently wrong. */
  dayShift?: number;
  /** Records every constructor call's options (the landmine guard reads these). */
  onConstruct?: (options: Intl.DateTimeFormatOptions | undefined) => void;
}

function installHermesIntl(shape: HermesIntlShape): () => void {
  const literalParts = new Set<string>(shape.literalParts ?? []);
  const rejectsZone = shape.rejectsZone ?? (() => false);

  class HermesDateTimeFormat {
    private readonly inner: Intl.DateTimeFormat;

    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      shape.onConstruct?.(options);
      const tz = options?.timeZone;
      if (tz !== undefined && rejectsZone(tz)) {
        throw new RangeError(`Invalid time zone specified: ${tz}`);
      }
      this.inner = new RealDateTimeFormat(locales, options);
    }

    formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
      if (shape.formatToPartsThrows) throw new RangeError("Invalid time value");
      return this.inner.formatToParts(date).map((part) => {
        if (literalParts.has(part.type)) return { type: "literal", value: part.value };
        if (part.type === "day" && shape.dayShift !== undefined) {
          return {
            type: "day",
            value: String(Number(part.value) + shape.dayShift).padStart(2, "0"),
          };
        }
        return part;
      });
    }

    format(date?: Date | number): string {
      return this.inner.format(date);
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
      return this.inner.resolvedOptions();
    }
  }

  const intlGlobal = Intl as { DateTimeFormat: unknown };
  intlGlobal.DateTimeFormat = HermesDateTimeFormat;
  return () => {
    intlGlobal.DateTimeFormat = RealDateTimeFormat;
  };
}

/** `trip-defaults` evaluated against whatever `Intl` is installed RIGHT NOW (fresh caches). */
function loadTripDefaults(): typeof TripDefaults {
  let loaded: typeof TripDefaults | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof TripDefaults>("./trip-defaults");
  });
  if (loaded === undefined) throw new Error("trip-defaults failed to load");
  return loaded;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  jest.restoreAllMocks();
});

const ROWS: readonly {
  label: string;
  tz: string;
  now: string;
  day: string; // the destination calendar day at `now`, per full ICU
}[] = [
  { label: "Tokyo east", tz: "Asia/Tokyo", now: "2026-08-01T20:00:00Z", day: "2026-08-02" },
  {
    label: "Los Angeles west",
    tz: "America/Los_Angeles",
    now: "2026-08-02T03:00:00Z",
    day: "2026-08-01",
  },
  {
    label: "Kiritimati UTC+14",
    tz: "Pacific/Kiritimati",
    now: "2026-08-01T10:00:00Z",
    day: "2026-08-02",
  },
  { label: "Etc/GMT+12 UTC-12", tz: "Etc/GMT+12", now: "2026-08-02T11:59:59Z", day: "2026-08-01" },
  {
    label: "New York DST spring-forward day",
    tz: "America/New_York",
    now: "2026-03-09T03:59:59Z",
    day: "2026-03-08",
  },
];

describe("[hermes] a faithful Apple-shaped engine answers exactly what full ICU answers", () => {
  it.each(ROWS)("$label", ({ tz, now, day }) => {
    restore = installHermesIntl({});
    const { tripTodayISO } = loadTripDefaults();
    expect(tripTodayISO({ destination_tz: tz }, new Date(now))).toBe(day);
  });

  it("the window verdict follows: active at the destination day, not before", () => {
    restore = installHermesIntl({});
    const { isTripActive } = loadTripDefaults();
    const tokyo = {
      status: "active",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      destination_tz: "Asia/Tokyo",
    } as const;
    expect(isTripActive(tokyo, new Date("2026-08-01T20:00:00Z"))).toBe(true);
    expect(isTripActive(tokyo, new Date("2026-08-01T14:59:59.999Z"))).toBe(false);
  });
});

describe("[hermes] landmines: a date-only read never reaches the unsafe Intl surface", () => {
  it("never passes hour12 or hourCycle (hour12 silently discards hourCycle on Hermes) — checked on EVERY formatter construction", () => {
    const seen: (Intl.DateTimeFormatOptions | undefined)[] = [];
    restore = installHermesIntl({ onConstruct: (options) => seen.push(options) });
    const { tripTodayISO } = loadTripDefaults();
    for (const { tz, now } of ROWS) tripTodayISO({ destination_tz: tz }, new Date(now));
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options).not.toHaveProperty("hour12");
      expect(options).not.toHaveProperty("hourCycle");
      expect(options).toMatchObject({ year: "numeric", month: "2-digit", day: "2-digit" });
    }
    // Falsification: add `hourCycle: "h23"` (or hour12) to the formatter options in time.ts → red.
  });

  it("never calls Intl.NumberFormat.prototype.formatToParts — a hard PROCESS ABORT on iOS Hermes, not a catchable throw", () => {
    const spy = jest.spyOn(Intl.NumberFormat.prototype, "formatToParts").mockImplementation(() => {
      throw new Error("llvm_unreachable: formatToParts is unimplemented on Apple platforms");
    });
    restore = installHermesIntl({});
    const { isTripActive, tripTodayISO } = loadTripDefaults();
    for (const { tz, now } of ROWS) {
      tripTodayISO({ destination_tz: tz }, new Date(now));
      isTripActive(
        { status: "active", start_date: "2026-08-01", end_date: "2026-08-03", destination_tz: tz },
        new Date(now),
      );
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("[hermes] a diverging engine degrades to the UTC day — never a plausible wrong day, never a throw", () => {
  const instant = new Date("2026-08-01T20:00:00Z"); // UTC Aug 1 · Tokyo Aug 2

  it("a part typed `literal` (hermes#1172) → UTC day", () => {
    restore = installHermesIntl({ literalParts: ["day"] });
    const { tripTodayISO } = loadTripDefaults();
    expect(() => tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).not.toThrow();
    expect(tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).toBe("2026-08-01");
  });

  it("every part `literal` → UTC day", () => {
    restore = installHermesIntl({ literalParts: ["year", "month", "day"] });
    const { tripTodayISO } = loadTripDefaults();
    expect(tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).toBe("2026-08-01");
  });

  it("formatToParts throwing RangeError → UTC day", () => {
    restore = installHermesIntl({ formatToPartsThrows: true });
    const { tripTodayISO } = loadTripDefaults();
    expect(() => tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).not.toThrow();
    expect(tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).toBe("2026-08-01");
  });

  it("an engine answering a day 5 away from UTC's (impossible for any real zone) → UTC day, not Aug 7", () => {
    restore = installHermesIntl({ dayShift: 5 });
    const { tripTodayISO } = loadTripDefaults();
    expect(tripTodayISO({ destination_tz: "Asia/Tokyo" }, instant)).toBe("2026-08-01");
    // Falsification: remove the ±1-day plausibility gate in time.ts → "2026-08-07".
  });

  it("tzdb backward links the pre-#1611 constructor rejected (Asia/Calcutta) → UTC day, no throw (modeled regression, not a live bug)", () => {
    restore = installHermesIntl({ rejectsZone: (tz) => tz === "Asia/Calcutta" });
    const { tripTodayISO } = loadTripDefaults();
    const at = new Date("2026-08-01T18:30:00Z"); // Calcutta Aug 2 00:00 · UTC Aug 1
    expect(tripTodayISO({ destination_tz: "Asia/Calcutta" }, at)).toBe("2026-08-01");
    // The canonical id still resolves on the same engine:
    expect(tripTodayISO({ destination_tz: "Asia/Kolkata" }, at)).toBe("2026-08-02");
  });

  it("isTripActive stays a boolean (never a throw) on every diverging engine", () => {
    for (const shape of [
      { literalParts: ["day"] as const },
      { formatToPartsThrows: true },
      { dayShift: 5 },
    ]) {
      restore = installHermesIntl(shape);
      const { isTripActive } = loadTripDefaults();
      expect(
        typeof isTripActive(
          {
            status: "active",
            start_date: "2026-08-01",
            end_date: "2026-08-01",
            destination_tz: "Asia/Tokyo",
          },
          instant,
        ),
      ).toBe("boolean");
      restore();
      restore = null;
    }
  });
});
