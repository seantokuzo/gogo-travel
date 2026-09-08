/**
 * The composition core on the runtime the app ACTUALLY SHIPS (B-9 R1 —
 * tests lane, blocking).
 *
 * `zoned-time.test.ts` and `zoned-time.hostile.test.ts` both run on Node/V8
 * with full ICU. The app ships HERMES (`ios/Podfile.properties.json` →
 * `"expo.jsEngine": "hermes"`), whose iOS `Intl` is NOT ICU: it is a
 * Foundation/`NSDateFormatter` reimplementation (`PlatformIntlApple.mm`)
 * that does not enumerate ICU fields — it formats to a string and then
 * re-derives each part's type by walking the resolved pattern's letters,
 * with `literal` as the fallback for anything it doesn't map. Three
 * divergence classes this suite guards against — confirmed against our
 * pinned Hermes commit and on-device (see `zoned-time.ts`'s
 * `isIntlFaithful` doc) to be either fixed already or never live at all:
 *
 *  1. HYPOTHETICAL, not observed: a locale-default hour cycle silently
 *     overriding the requested `hourCycle: "h23"`. `PlatformIntlApple.mm`
 *     actually honors the caller's option — Apple's `en-US` h12 default
 *     applies only when no option is given at all. Modeled anyway as a
 *     regression guard: a uniformly shifted hour would be SELF-CONSISTENT —
 *     the round-trip filter in `resolveWallTime` compares two reads that
 *     are wrong by the same 12h, agrees with itself, and hands back a
 *     well-formed string up to 12h wrong — no null, no throw. That would be
 *     B-8 one layer down.
 *  2. STILL LIVE: a part mapped to `literal` reads NaN, and the next
 *     `formatToParts(new Date(NaN))` throws `RangeError` — out of a
 *     function documented as "null, never a throw", through the save
 *     handler and (via `livePlacements`) the form's whole render
 *     (facebook/hermes#1172, open).
 *  3. FIXED, in our pinned build: zone validation used to go through
 *     `NSTimeZone.knownTimeZoneNames` alone, which rejected tzdb backward
 *     links (facebook/hermes#1607). #1611 (merged 2025-03-13) added the
 *     `NSTimeZone` constructor fallback that resolves them — modeled here
 *     as a regression guard, not a live bug.
 *
 * The stub below is that engine, not a strawman: it delegates the actual
 * date math to the real `Intl` (iOS does have a real zone database via
 * Foundation) and diverges ONLY the way Hermes-Apple has diverged, at one
 * point or another, across the three classes above — the hour cycle, the
 * part typing, and the id whitelist.
 *
 * The bar every arm holds to: on a diverging engine the module either gives
 * the SAME answer full ICU gives, or it gives `null`. Never a plausible
 * wrong offset, never a throw.
 */
import { TZ_UNKNOWN_ERROR, buildDetails, type DetailsFormState } from "./form-model";
import { resetTimeZoneCatalogForTests, timeZoneCatalog } from "./time-zone-catalog";
import {
  composeZonedDateTime,
  describeTimeZone,
  deviceTimeZone,
  isIntlFaithful,
  isKnownTimeZone,
  resetZonedTimeCachesForTests,
  resolveWallTime,
} from "./zoned-time";

const RealDateTimeFormat = Intl.DateTimeFormat;

interface HermesIntlShape {
  /**
   * The cycle the STUB resolves, independent of what's requested — models
   * the hypothetical, unobserved scenario where Apple's `en-US` h12 default
   * would override `hourCycle: "h23"`. On the real pinned engine the
   * request is honored; see `zoned-time.ts`'s `isIntlFaithful` doc.
   */
  resolvedHourCycle?: "h23" | "h12";
  /** Part types `returnTypeOfDate` fails to map — emitted as `literal`. */
  literalParts?: readonly Intl.DateTimeFormatPartTypes[];
  /**
   * `NSTimeZone.knownTimeZoneNames`: ids the PRE-#1611 constructor
   * rejected (#1607) — fixed and in our pinned build; modeled here for
   * regression coverage, not because it's still live.
   */
  rejectsZone?: (tz: string) => boolean;
  /** `resolvedOptions().timeZone` — what the device reports about itself. */
  deviceZone?: string;
  /**
   * Hour offset applied to the RENDERED hour of these zones only, with no
   * day adjustment: an engine that is coherent about UTC and incoherent
   * about a zone. Models a misread pattern that the UTC self-check cannot
   * see, so the later gates have to carry it.
   */
  hourShiftByZone?: Readonly<Record<string, number>>;
}

/** Install a Hermes-Apple-shaped `Intl.DateTimeFormat`; returns the undo. */
function installHermesIntl(shape: HermesIntlShape): () => void {
  const literalParts = new Set<string>(shape.literalParts ?? []);
  const rejectsZone = shape.rejectsZone ?? (() => false);
  const shifts = shape.hourShiftByZone ?? {};

  class HermesDateTimeFormat {
    private readonly inner: Intl.DateTimeFormat;
    private readonly tz: string;

    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      const tz = options?.timeZone;
      if (tz !== undefined && rejectsZone(tz)) {
        // Same shape ICU uses, same shape the module's `isKnownTimeZone`
        // catches — the divergence is WHICH ids reach it.
        throw new RangeError(`Invalid time zone specified: ${tz}`);
      }
      this.tz = tz ?? "UTC";
      this.inner = new RealDateTimeFormat(locales, {
        ...options,
        ...(options?.hour !== undefined && shape.resolvedHourCycle !== undefined
          ? { hourCycle: shape.resolvedHourCycle, hour12: shape.resolvedHourCycle === "h12" }
          : {}),
      });
    }

    formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
      // `new Date(NaN)` throws out of the REAL formatter — the exact
      // `RangeError` a NaN part cascade reaches on device.
      const parts = this.inner.formatToParts(date);
      const shift = shifts[this.tz];
      return parts.map((part) => {
        if (literalParts.has(part.type)) return { type: "literal", value: part.value };
        if (shift !== undefined && part.type === "hour") {
          const shifted = (((Number(part.value) + shift) % 24) + 24) % 24;
          return { type: "hour", value: String(shifted).padStart(2, "0") };
        }
        return part;
      });
    }

    format(date?: Date | number): string {
      return this.inner.format(date);
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
      const resolved = this.inner.resolvedOptions();
      return shape.deviceZone !== undefined
        ? { ...resolved, timeZone: shape.deviceZone }
        : resolved;
    }
  }

  // Swapping a global constructor: the module under test reads
  // `Intl.DateTimeFormat` at call time, which is exactly how the engine
  // reaches it on device.
  const intlGlobal = Intl as { DateTimeFormat: unknown };
  const realIntl = intlGlobal.DateTimeFormat;
  intlGlobal.DateTimeFormat = HermesDateTimeFormat;
  // Both memos are per-ENGINE (a cached formatter and a cached verdict), so
  // swapping the engine without dropping them would test the old one.
  resetZonedTimeCachesForTests();
  resetTimeZoneCatalogForTests();
  return () => {
    intlGlobal.DateTimeFormat = realIntl;
    resetZonedTimeCachesForTests();
    resetTimeZoneCatalogForTests();
  };
}

/** Every wall hour of a day, in zones with and without DST and sub-hour offsets. */
const WALL_MATRIX: readonly { tz: string; date: string }[] = [
  { tz: "Asia/Tokyo", date: "2027-04-24" },
  { tz: "America/Los_Angeles", date: "2027-04-24" },
  { tz: "America/Los_Angeles", date: "2027-01-24" },
  { tz: "Asia/Kathmandu", date: "2027-04-24" },
  { tz: "UTC", date: "2027-04-24" },
];
const WALL_HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);

/** The full-ICU answers, captured BEFORE any stub is installed. */
const ICU_ANSWERS = WALL_MATRIX.flatMap(({ tz, date }) =>
  WALL_HOURS.map((time) => ({ tz, date, time, composed: composeZonedDateTime(date, time, tz) })),
);

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe("[hermes] h12 hour cycle — the silent 12h-wrong composition", () => {
  it("the engine self-check refuses the engine outright", () => {
    // Real ICU answers `hourCycle: "h23"`; this modeled (not observed) stub
    // answers h12 regardless, and the module has no way to make it stop, so
    // it stops composing instead.
    expect(isIntlFaithful()).toBe(true);
    restore = installHermesIntl({ resolvedHourCycle: "h12" });
    expect(isIntlFaithful()).toBe(false);
  });

  it("EVERY wall hour is either the ICU answer or null — never a plausible wrong offset", () => {
    restore = installHermesIntl({ resolvedHourCycle: "h12" });
    const wrong: string[] = [];
    for (const { tz, date, time, composed } of ICU_ANSWERS) {
      const onHermes = composeZonedDateTime(date, time, tz);
      if (onHermes !== null && onHermes !== composed) {
        wrong.push(`${tz} ${date} ${time}: ${onHermes} (ICU: ${composed ?? "null"})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the exact strings the pre-R1 algorithm composed here — all well-formed, all wrong", () => {
    // Not a hypothetical: MEASURED by reverting the three gates and running
    // the arm above. 60 of those 120 wall hours composed a well-formed wrong
    // offset — no null, no throw. A sample of what reached the wire:
    //
    //   Asia/Tokyo          08:00  →  -03:00   (ICU +09:00)
    //   Asia/Tokyo          15:00  →  +21:00   (ICU +09:00)
    //   America/Los_Angeles 07:00  →  +05:00   (ICU -07:00)
    //   America/Los_Angeles 22:00  →  -19:00   (ICU -07:00)
    //   Asia/Kathmandu      08:00  →  -06:15   (ICU +05:45)
    //
    // Note LA 07:00 → "+05:00": inside tzdb's legal range, indistinguishable
    // from a real offset by inspection, 12h wrong — but it's the
    // GAP-SIGNATURE gate that catches this one, not the engine self-check
    // (its round-trip fails and the failure doesn't match a real
    // spring-forward's signature). The self-check is what's load-bearing
    // for the other 12 wall hours nothing else catches — e.g. Tokyo
    // 08:00 → -03:00 and Kathmandu 08:00 → -06:15 above, where the shifted
    // read is still self-consistent and round-trips clean, so only knowing
    // the UTC answer in advance catches it.
    //
    // The h12 override this stub models is itself now known NOT to occur on
    // our shipped engine (`isIntlFaithful()` is verified `true` on-device,
    // see `zoned-time.ts`) — this arm is a regression guard, not a
    // live-bug reproduction.
    restore = installHermesIntl({ resolvedHourCycle: "h12" });
    expect(composeZonedDateTime("2027-04-24", "08:00", "Asia/Tokyo")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "15:00", "Asia/Tokyo")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "07:00", "America/Los_Angeles")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "22:00", "America/Los_Angeles")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "08:00", "Asia/Kathmandu")).toBeNull();
    expect(resolveWallTime("Asia/Tokyo", "2027-04-24", "08:00")).toBeNull();
  });

  it("the form turns that into TZ_UNKNOWN_ERROR, not a silent save", () => {
    restore = installHermesIntl({ resolvedHourCycle: "h12" });
    const state: DetailsFormState = {
      origin_iata: "NRT",
      departs_at: { date: "2027-04-24", time: "17:00", tz: "Asia/Tokyo" },
    };
    const built = buildDetails("flight", state);
    expect(built.details).toBeNull();
    expect(built.errors["departs_at"]).toBe(TZ_UNKNOWN_ERROR);
  });

  it("labels degrade to the raw id instead of showing a wrong GMT offset", () => {
    restore = installHermesIntl({ resolvedHourCycle: "h12" });
    expect(describeTimeZone("Asia/Tokyo", Date.UTC(2027, 3, 24, 12, 0, 0))).toBeNull();
  });
});

describe("[hermes] a FAITHFUL Hermes-shaped engine still composes — the discriminator", () => {
  it("h23 + full part typing reproduces every ICU answer exactly", () => {
    // Falsification for the arms above: they must fail on a diverging
    // engine BECAUSE it diverges, not because any stubbed `Intl` is
    // refused. Same fake class, same delegation, no divergence.
    restore = installHermesIntl({ resolvedHourCycle: "h23" });
    expect(isIntlFaithful()).toBe(true);
    for (const { tz, date, time, composed } of ICU_ANSWERS) {
      expect(composeZonedDateTime(date, time, tz)).toBe(composed);
    }
  });

  it("…including the DST edges — the gap and the overlap survive the stub", () => {
    restore = installHermesIntl({ resolvedHourCycle: "h23" });
    // Spring-forward gap: 02:30 never happens, pre-transition offset wins.
    expect(resolveWallTime("America/Los_Angeles", "2027-03-14", "02:30")).toEqual({
      offsetMinutes: -480,
      kind: "gap",
    });
    expect(composeZonedDateTime("2027-03-14", "02:30", "America/Los_Angeles")).toBe(
      "2027-03-14T02:30:00-08:00",
    );
    // Fall-back overlap: 01:30 happens twice, the EARLIER instant wins.
    expect(resolveWallTime("America/Los_Angeles", "2027-11-07", "01:30")).toEqual({
      offsetMinutes: -420,
      kind: "ambiguous",
    });
  });
});

describe("[hermes] `literal` part fallback — null, never a throw", () => {
  // `returnTypeOfDate`'s fallback for an unmapped pattern letter. The part
  // is still THERE, just typed `literal`, so `read()` finds nothing.
  for (const missing of ["hour", "minute", "second", "day", "month", "year"] as const) {
    it(`a '${missing}' part typed literal composes null and throws nothing`, () => {
      restore = installHermesIntl({ resolvedHourCycle: "h23", literalParts: [missing] });
      expect(() => composeZonedDateTime("2027-04-24", "17:00", "Asia/Tokyo")).not.toThrow();
      expect(composeZonedDateTime("2027-04-24", "17:00", "Asia/Tokyo")).toBeNull();
      expect(() => resolveWallTime("Asia/Tokyo", "2027-04-24", "17:00")).not.toThrow();
      expect(resolveWallTime("Asia/Tokyo", "2027-04-24", "17:00")).toBeNull();
    });
  }

  it("the render-path helper degrades too — a booking form, not a white screen", () => {
    // `describeTimeZone` runs inside `render` for every picker row and every
    // zone field. A `RangeError` here is the whole form.
    restore = installHermesIntl({ resolvedHourCycle: "h23", literalParts: ["hour"] });
    expect(() => describeTimeZone("Asia/Tokyo", Date.UTC(2027, 3, 24, 12, 0, 0))).not.toThrow();
    expect(describeTimeZone("Asia/Tokyo", Date.UTC(2027, 3, 24, 12, 0, 0))).toBeNull();
  });

  it("the form's error is the device-divergence one, and the save is blocked", () => {
    restore = installHermesIntl({ resolvedHourCycle: "h23", literalParts: ["hour"] });
    const built = buildDetails("flight", {
      departs_at: { date: "2027-04-24", time: "17:00", tz: "Asia/Tokyo" },
    });
    expect(built.details).toBeNull();
    expect(built.errors["departs_at"]).toBe(TZ_UNKNOWN_ERROR);
  });
});

describe("[hermes] an engine coherent about UTC and incoherent about a zone", () => {
  it("an off-by-N zone read fails loud rather than composing an impossible offset", () => {
    // The self-check passes (UTC is fine), the round-trip filter passes (the
    // shift is uniform, so it agrees with itself) — and the answer is
    // "+21:00", an offset no zone on earth has. Only the tzdb-range gate
    // catches this one, which is why all three gates exist.
    restore = installHermesIntl({
      resolvedHourCycle: "h23",
      hourShiftByZone: { "Asia/Tokyo": -12 },
    });
    expect(isIntlFaithful()).toBe(true);
    expect(composeZonedDateTime("2027-04-24", "17:00", "Asia/Tokyo")).toBeNull();
    // …and an untouched zone on the same engine still composes correctly,
    // so the gate is discriminating, not a blanket refusal.
    expect(composeZonedDateTime("2027-04-24", "10:00", "America/Los_Angeles")).toBe(
      "2027-04-24T10:00:00-07:00",
    );
  });
});

describe("[hermes] backward links rejected by NSTimeZone.knownTimeZoneNames (#1607)", () => {
  const LINKS = new Set(["Asia/Calcutta", "US/Eastern", "Asia/Saigon"]);
  const rejectsZone = (tz: string): boolean => LINKS.has(tz);

  it("a link id reads as unknown — and the composition fails loud instead of guessing", () => {
    expect(isKnownTimeZone("Asia/Calcutta")).toBe(true); // full ICU
    restore = installHermesIntl({ resolvedHourCycle: "h23", rejectsZone });
    expect(isKnownTimeZone("Asia/Calcutta")).toBe(false);
    // The canonical spelling of the SAME zone still works, so this is the
    // engine's id table, not a broken module.
    expect(isKnownTimeZone("Asia/Kolkata")).toBe(true);
    expect(composeZonedDateTime("2027-04-24", "17:00", "Asia/Calcutta")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "17:00", "Asia/Kolkata")).toBe(
      "2027-04-24T17:00:00+05:30",
    );
  });

  it("a device reporting a link zone degrades to UTC — never a throw, never a bogus id", () => {
    restore = installHermesIntl({
      resolvedHourCycle: "h23",
      rejectsZone,
      deviceZone: "US/Eastern",
    });
    expect(deviceTimeZone()).toBe("UTC");
  });

  it("the picker catalog survives it — canonical ids are what the catalog holds", () => {
    // The regression this guards: an engine that rejects most ids collapses
    // the catalog to a stub and the zone picker becomes unusable. `zone.tab`
    // is canonical-only, so link rejection must cost the catalog NOTHING.
    const icuSize = timeZoneCatalog().length;
    restore = installHermesIntl({ resolvedHourCycle: "h23", rejectsZone });
    const hermesSize = timeZoneCatalog().length;
    expect(hermesSize).toBe(icuSize);
    expect(timeZoneCatalog().some((entry) => entry.id === "Asia/Kolkata")).toBe(true);
  });

  it("an engine that rejects EVERYTHING collapses the catalog — the arm above has teeth", () => {
    restore = installHermesIntl({
      resolvedHourCycle: "h23",
      rejectsZone: (tz) => tz !== "UTC",
    });
    expect(timeZoneCatalog().map((entry) => entry.id)).toEqual(["UTC"]);
  });
});
