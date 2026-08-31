/**
 * Hostile fixture pack — `@gogo/shared/testing` (T-S3.4, testing-overhaul
 * spec §3.4, R-test-4; ADR-006 layer 4).
 *
 * WHY THIS EXISTS: every fixture in this repo historically used ONE timezone
 * (`Z`), decimal currencies (USD), and populated states — so B-8 (the client
 * Z-stamps every wall time; date-line flights unenterable, every stored
 * instant wrong) was invisible to ~3000 tests. Each fixture here is built to
 * be DISCRIMINATING: a shape on which correct behavior and the known bug
 * class produce DIFFERENT values (`.claude/rules/mobile.md` vacuous-pin
 * taxonomy — "a fixture where two behaviors yield the same value" is the
 * anti-pattern this pack exists to kill). Every fixture documents (a) the
 * bug class it catches and (b) the naive fixture it replaces.
 *
 * Platform-agnostic (R-shared-9): pure data + string/integer arithmetic.
 * Only relative imports; the offsets are baked into the fixtures, so NO
 * IANA/ICU database is needed to check any invariant — everything verifies
 * with `Date.parse` on explicit-offset strings (the same primitive
 * `toUtcInstant` uses), which works identically under node, vitest and RN
 * Hermes.
 *
 * TEST-ONLY: exported ONLY via the `./testing` subpath. Never re-export
 * from `src/index.ts`, and never import this module from production code —
 * it ships wrong-by-construction shapes (`zStamp*`, `naiveTwoDecimalText`)
 * that exist to simulate bugs in tests.
 *
 * Self-test: `hostile.test.ts` pins every numeric invariant claimed in the
 * doc-comments below (falsification, R-test-7: edit any wall time, offset,
 * or amount here and the self-test reds on the exact invariant you broke).
 */
import type {
  BookingCreate,
  BookingDetails,
  FlightDetails,
  LodgingDetails,
} from "../domains/booking.js";
import type { ISODate, ISODateTime, ISOTime } from "../scalars.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** `±HH:MM` UTC offset as the fixtures carry it. */
export type UtcOffset = `+${string}` | `-${string}`;

/** Wall date + time + explicit offset → the CORRECT local ISO composition. */
export function localISO(date: ISODate, time: ISOTime, offset: UtcOffset): ISODateTime {
  return `${date}T${time}:00${offset}`;
}

/** Epoch ms of an explicit-offset ISO string — pure `Date.parse`, no tz db. */
export function instantMs(local: ISODateTime): number {
  return Date.parse(local);
}

/**
 * THE B-8 COMPOSITION (wrong by construction — bug simulator): re-compose a
 * local ISO string's WALL components with a `Z` offset, exactly what
 * `form-model.ts` `composeLocalDateTime` does to every entered time
 * (`` `${date}T${time}:00Z` ``, form-model.ts:205) and what its
 * `stateFromDetails` → `buildDetails` edit round-trip does to every stored
 * one. Use it to run "the current client" against a fixture in one call.
 */
export function zStamp(local: ISODateTime): ISODateTime {
  return `${local.slice(0, 10)}T${local.slice(11, 16)}:00Z`;
}

const DATETIME_DETAIL_KEYS = [
  "departs_at",
  "arrives_at",
  "check_in",
  "check_out",
  "pickup_at",
  "dropoff_at",
  "starts_at",
  "ends_at",
  "reserved_at",
] as const;
const TZ_DETAIL_KEYS = ["departs_tz", "arrives_tz"] as const;

/**
 * Bug simulator, whole-details form: apply {@link zStamp} to every datetime
 * field and DROP the `*_tz` fields — the full B-8 client transform (the
 * form never populates `departs_tz`/`arrives_tz`, and an edit round-trip
 * strips them from a correctly-zoned booking). Top-level fields only:
 * flight `segments` are not touched (the form doesn't edit segments).
 */
export function zStampDetails<T extends BookingDetails>(details: T): T {
  const out: Record<string, unknown> = { ...details };
  for (const key of DATETIME_DETAIL_KEYS) {
    const value = out[key];
    if (typeof value === "string") out[key] = zStamp(value);
  }
  for (const key of TZ_DETAIL_KEYS) delete out[key];
  return out as T;
}

/**
 * Bug simulator (money): the naive hard-coded two-decimal rendering
 * (`cents → "X.YY"`) that a currency-unaware display does to every amount.
 * String math only (Law #2 even in the bug simulator — the point is the
 * currency logic, not float noise).
 */
export function naiveTwoDecimalText(minorUnits: number): string {
  const padded = String(minorUnits).padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// 1. Date-line / eastbound trans-Pacific flight — THE B-8 trap
// ---------------------------------------------------------------------------

/** One flight endpoint: the wall clock a traveler sees + where it is. */
export interface HostileFlightEndpoint {
  iata: string;
  /** IANA zone — the datum B-9's airport table exists to supply. */
  tz: string;
  /** Offset in force at this fixture's instant (baked in; no tz db needed). */
  offset: UtcOffset;
  date: ISODate;
  time: ISOTime;
  /** The CORRECT local ISO composition of the wall values above. */
  local: ISODateTime;
}

export interface HostileFlight {
  origin: HostileFlightEndpoint;
  destination: HostileFlightEndpoint;
  /** True flight duration in ms (destination instant − origin instant). */
  durationMs: number;
  /**
   * Derived-interval signature under the B-8 composition, in ms
   * (zStamp(arrive) − zStamp(depart)): NEGATIVE = the interval INVERTS.
   */
  zStampedIntervalMs: number;
  /** Correct-composition details: offsets + `*_tz` populated. */
  details: FlightDetails;
  /** What the CURRENT client transmits for the same entered wall values. */
  zStamped: FlightDetails;
}

function flight(
  origin: HostileFlightEndpoint,
  destination: HostileFlightEndpoint,
  extra?: Partial<FlightDetails>,
): HostileFlight {
  const details: FlightDetails = {
    category: "flight",
    origin_iata: origin.iata,
    destination_iata: destination.iata,
    departs_at: origin.local,
    departs_tz: origin.tz,
    arrives_at: destination.local,
    arrives_tz: destination.tz,
    ...extra,
  };
  return {
    origin,
    destination,
    durationMs: instantMs(destination.local) - instantMs(origin.local),
    zStampedIntervalMs: instantMs(zStamp(destination.local)) - instantMs(zStamp(origin.local)),
    details,
    zStamped: zStampDetails(details),
  };
}

function endpoint(
  iata: string,
  tz: string,
  offset: UtcOffset,
  date: ISODate,
  time: ISOTime,
): HostileFlightEndpoint {
  return { iata, tz, offset, date, time, local: localISO(date, time, offset) };
}

/**
 * Eastbound trans-Pacific, NRT → LAX — the EXACT B-8 shape (Sean's real
 * 'Spring in Kyoto' flight, device QA 2026-08-29): depart Tokyo Apr 24
 * 17:00 JST (08:00Z), arrive LAX Apr 24 10:00 PDT (17:00Z). A legitimate
 * 9h flight whose arrival WALL clock (10:00) precedes its departure wall
 * clock (17:00) on the SAME wall date.
 *
 * Bug class caught: wall-time-as-UTC composition (B-8). Under {@link zStamp}
 * the derived interval INVERTS (end 7h before start) — not merely shifts —
 * so any assertion that instants are ordered goes RED against the current
 * client. The −7h inversion sits INSIDE the temporary 12h transport grace
 * (`TZ_INVERSION_GRACE_MS`, migration 0001), so today the server admits the
 * broken payload; both revert with B-9 (the QUEUE B-8 row's DoD).
 *
 * Replaces the naive fixture: a one-zone or Z-offset flight (e.g.
 * `departs_at: "2027-03-02T14:30:00Z"` — the repo's historical shape), on
 * which correct and Z-stamped composition agree in ordering AND wall values,
 * making every ordering assertion vacuous. See `NAIVE_CONTROL_FLIGHT`.
 */
export const DATE_LINE_EASTBOUND: HostileFlight = flight(
  endpoint("NRT", "Asia/Tokyo", "+09:00", "2027-04-24", "17:00"),
  endpoint("LAX", "America/Los_Angeles", "-07:00", "2027-04-24", "10:00"),
  { airline: "ZipAir", flight_number: "ZG 24" },
);

/**
 * Westbound date-line crossing, LAX → NRT: depart Apr 20 11:35 PDT
 * (18:35Z), arrive Apr 21 15:25 JST (06:25Z) — 11h50m real, wall date +1.
 *
 * Bug class caught: SILENT instant corruption. Z-stamping preserves the
 * interval's ordering here (which is exactly why westbound legs never
 * surfaced B-8 as an error) but stretches the derived duration to 27h50m
 * (+16h) and shifts both stored instants by hours — corrupting itinerary
 * sort order, cross-midnight derivation and leave-by math downstream while
 * every "end after start" assertion stays green. A discriminating suite
 * must therefore assert INSTANTS, not just ordering; this fixture is the
 * shape that makes such an assertion red against the current client.
 *
 * Replaces the naive fixture: same as above — a Z-offset flight, whose
 * instants Z-stamping reproduces exactly (nothing to detect).
 */
export const DATE_LINE_WESTBOUND: HostileFlight = flight(
  endpoint("LAX", "America/Los_Angeles", "-07:00", "2027-04-20", "11:35"),
  endpoint("NRT", "Asia/Tokyo", "+09:00", "2027-04-21", "15:25"),
  { airline: "ZipAir", flight_number: "ZG 25" },
);

/**
 * Extreme eastbound date-line hop, AKL → PPT (a real ~6h Air Tahiti Nui
 * route): depart Auckland Apr 24 17:10 NZST (05:10Z), arrive Papeete
 * Apr 24 01:00 (11:00Z) — 5h50m real; wall clock lands 16h10m "before"
 * departure on the same date.
 *
 * Bug class caught: grace-window false comfort. The Z-stamped inversion
 * (−16h10m) exceeds the 12h transport grace, so this REAL flight is STILL
 * unenterable today — proof that the grace is a partial unblock, not a fix.
 * Pins built on this fixture stay red-for-the-client until B-9's real fix;
 * at the server seam it discriminates "grace admits everything transport"
 * (false) from "grace admits ≤12h" (true).
 *
 * Replaces the naive fixture: the single mid-window inversion (7h) that
 * cannot tell a bounded grace from an unbounded one.
 */
export const DATE_LINE_EASTBOUND_EXTREME: HostileFlight = flight(
  endpoint("AKL", "Pacific/Auckland", "+12:00", "2027-04-24", "17:10"),
  endpoint("PPT", "Pacific/Tahiti", "-10:00", "2027-04-24", "01:00"),
  { airline: "Air Tahiti Nui", flight_number: "TN 102" },
);

/**
 * NAIVE CONTROL — deliberately NON-hostile (SFO → LAX, one zone, 1h30m).
 * This is the fixture shape the hostile ones replace, exported so suites
 * (and mutation probes) can PROVE a pin discriminates: run the B-8
 * composition over this control and ordering, wall values and same-date
 * facts all survive — any assertion that stays green here but reds on
 * `DATE_LINE_EASTBOUND` is load-bearing; one that is green on both is
 * vacuous (mobile.md taxonomy). Never use it as the ONLY fixture in a
 * date/time suite — that is precisely the historical hole.
 */
export const NAIVE_CONTROL_FLIGHT: HostileFlight = flight(
  endpoint("SFO", "America/Los_Angeles", "-07:00", "2027-04-24", "10:00"),
  endpoint("LAX", "America/Los_Angeles", "-07:00", "2027-04-24", "11:30"),
  { airline: "United", flight_number: "UA 415" },
);

// ---------------------------------------------------------------------------
// 2. Multi-zone trip (3 IANA zones, one of them offset-identical to another)
// ---------------------------------------------------------------------------

/**
 * A 5-day Pacific loop across THREE IANA zones — America/Los_Angeles,
 * Asia/Tokyo, Asia/Seoul — with the outbound westbound leg, an intra-offset
 * international hop, zero-decimal-priced stays, and the eastbound B-8 trap
 * as the return leg.
 *
 * Bug classes caught (each with the naive fixture it replaces):
 *
 *  - "One zone per trip" assumptions: every historical trip fixture kept
 *    all bookings in the device/trip zone, so deriving display times from a
 *    single zone was undetectable. Here no single offset reproduces all
 *    correct instants.
 *  - Offset ≠ zone: Tokyo and Seoul share `+09:00` but are DIFFERENT IANA
 *    zones — kills "cache/compare timezones by offset" logic that a
 *    Tokyo-only fixture can never catch (and the exact confusion B-9's
 *    airport table must not bake in).
 *  - TRAVEL-DAY ORDER SCRAMBLE (`travelDayScramble`): on Apr 24 the real
 *    chronology is Tokyo checkout (02:00Z) → NRT departure (08:00Z) → LAX
 *    arrival (17:00Z). Z-stamped, the derived instants sort arrival (10:00Z)
 *    BEFORE checkout (11:00Z) — the itinerary shows you landing in LA
 *    before leaving your Tokyo hotel. A same-zone fixture preserves
 *    cross-booking order under Z-stamping, so ordering pins on it are
 *    vacuous; this triple is the minimal shape where sort order itself
 *    breaks.
 */
export const MULTI_ZONE_TRIP = {
  name: "Pacific loop (LA → Tokyo → Seoul → Tokyo → LA)",
  /** The trip's base zone — deliberately NOT the traveler's home zone. */
  baseTz: "Asia/Tokyo",
  start: "2027-04-20" as ISODate,
  end: "2027-04-24" as ISODate,
  /** Distinct IANA zones touched; seoul/tokyo share +09:00 on purpose. */
  zones: ["America/Los_Angeles", "Asia/Tokyo", "Asia/Seoul"] as const,

  outbound: DATE_LINE_WESTBOUND,
  tokyoStayA: {
    category: "lodging",
    property_name: "Asakusa View",
    check_in: localISO("2027-04-21", "16:00", "+09:00"),
    check_out: localISO("2027-04-22", "08:00", "+09:00"),
  } satisfies LodgingDetails as LodgingDetails,
  /** Same offset (+09:00), different IANA zone — the offset≠zone probe. */
  seoulHop: flight(
    endpoint("NRT", "Asia/Tokyo", "+09:00", "2027-04-22", "09:55"),
    endpoint("GMP", "Asia/Seoul", "+09:00", "2027-04-22", "12:25"),
    { airline: "Korean Air", flight_number: "KE 2708" },
  ),
  seoulStay: {
    category: "lodging",
    property_name: "Myeongdong Loft",
    check_in: localISO("2027-04-22", "15:00", "+09:00"),
    check_out: localISO("2027-04-23", "09:00", "+09:00"),
  } satisfies LodgingDetails as LodgingDetails,
  returnHop: flight(
    endpoint("GMP", "Asia/Seoul", "+09:00", "2027-04-23", "10:30"),
    endpoint("HND", "Asia/Tokyo", "+09:00", "2027-04-23", "12:45"),
    { airline: "Korean Air", flight_number: "KE 2709" },
  ),
  tokyoStayB: {
    category: "lodging",
    property_name: "Shinjuku Granbell",
    check_in: localISO("2027-04-23", "15:00", "+09:00"),
    check_out: localISO("2027-04-24", "11:00", "+09:00"),
  } satisfies LodgingDetails as LodgingDetails,
  returnFlight: DATE_LINE_EASTBOUND,

  /**
   * The Apr-24 travel-day triple (see doc above). `real*` are the correct
   * instants; under {@link zStamp} their sort order becomes
   * [arrival, checkout, departure].
   */
  travelDayScramble: {
    checkout: localISO("2027-04-24", "11:00", "+09:00"),
    departure: DATE_LINE_EASTBOUND.origin.local,
    arrival: DATE_LINE_EASTBOUND.destination.local,
  },
} as const;

/**
 * The trip's stays as wire-true `BookingCreate` bodies, zero-decimal priced
 * (JPY/KRW — see `HOSTILE_MONEY`). Directly parseable by
 * `BookingCreateSchema` and feedable to the booking service.
 */
export const MULTI_ZONE_TRIP_CREATES: readonly BookingCreate[] = [
  {
    category: "lodging",
    title: "Shinjuku Granbell",
    details: MULTI_ZONE_TRIP.tokyoStayB,
    status: "booked",
    price_cents: 25000,
    currency: "JPY",
  },
  {
    category: "lodging",
    title: "Myeongdong Loft",
    details: MULTI_ZONE_TRIP.seoulStay,
    status: "booked",
    price_cents: 165000,
    currency: "KRW",
  },
];

// ---------------------------------------------------------------------------
// 3. DST boundary
// ---------------------------------------------------------------------------

/**
 * A hotel stay SPANNING the US fall-back transition (America/Los_Angeles,
 * 2027-11-07 02:00 PDT → 01:00 PST): check-in Nov 6 15:00 **−07:00** (PDT),
 * check-out Nov 7 11:00 **−08:00** (PST). Real duration 21h; composing both
 * endpoints with the check-in's offset (the "one offset per booking"
 * shortcut) yields 20h — off by the transition hour.
 *
 * Bug class caught: uniform-offset composition across a DST boundary (the
 * offset-lookup twin of B-8 — once B-9-style zone capture exists, resolving
 * the offset ONCE per booking instead of once per endpoint reintroduces
 * this corruption). `naiveUniformOffsetCheckOut` is the precomputed wrong
 * composition so suites can assert the two DIFFER.
 *
 * Replaces the naive fixture: any stay in a fixed-offset zone (or away from
 * the transition), where per-endpoint and per-booking offset resolution
 * agree exactly.
 */
export const DST_FALL_BACK_STAY = {
  tz: "America/Los_Angeles",
  /** The instant clocks roll back: 2027-11-07T09:00Z (02:00 PDT → 01:00 PST). */
  transitionUtc: "2027-11-07T09:00:00Z" as ISODateTime,
  details: {
    category: "lodging",
    property_name: "Santa Monica Proper",
    check_in: localISO("2027-11-06", "15:00", "-07:00"),
    check_out: localISO("2027-11-07", "11:00", "-08:00"),
  } satisfies LodgingDetails as LodgingDetails,
  realDurationMs: 21 * 3_600_000,
  /** check_out wrongly composed with check_in's −07:00 offset. */
  naiveUniformOffsetCheckOut: localISO("2027-11-07", "11:00", "-07:00"),
  naiveUniformOffsetDurationMs: 20 * 3_600_000,
} as const;

/**
 * A wall time that DOES NOT EXIST: 2027-03-14 02:30 in America/Los_Angeles
 * (spring-forward skips 02:00→03:00). Neither candidate offset composes a
 * local time a clock in LA ever showed; the two candidate instants differ
 * by exactly 1h.
 *
 * Bug class caught: date/time pickers and zone-resolution code (the B-9
 * follow-up surface) that accept any HH:MM for a date without consulting
 * the zone's transitions. Replaces the naive fixture: any wall time away
 * from a transition, for which every plausible resolution agrees.
 */
export const DST_SPRING_FORWARD_GAP = {
  tz: "America/Los_Angeles",
  date: "2027-03-14" as ISODate,
  time: "02:30" as ISOTime,
  candidates: {
    standard: localISO("2027-03-14", "02:30", "-08:00"),
    daylight: localISO("2027-03-14", "02:30", "-07:00"),
  },
} as const;

/**
 * A wall time that exists TWICE: 2027-11-07 01:30 in America/Los_Angeles
 * (fall-back replays 01:00–02:00). Both candidate offsets are genuinely
 * valid; the ambiguity is 1h of real money/minutes if resolved wrong.
 *
 * Bug class caught: single-valued wall→instant conversion (picking one
 * offset silently). Replaces: same as `DST_SPRING_FORWARD_GAP`.
 */
export const DST_FALL_BACK_AMBIGUOUS = {
  tz: "America/Los_Angeles",
  date: "2027-11-07" as ISODate,
  time: "01:30" as ISOTime,
  candidates: {
    daylight: localISO("2027-11-07", "01:30", "-07:00"),
    standard: localISO("2027-11-07", "01:30", "-08:00"),
  },
} as const;

// ---------------------------------------------------------------------------
// 4. Zero-decimal currency amounts
// ---------------------------------------------------------------------------

export interface HostileMoney {
  currency: string;
  /** ISO-4217 minor units — for JPY/KRW that IS the display amount. */
  minorUnits: number;
  /** Correct display text (shared `centsToMoneyText`, default shape). */
  text: string;
  /** What the naive hard-coded 2dp display renders — see naiveTwoDecimalText. */
  naiveText: string;
}

/**
 * Zero-decimal (JPY/KRW) amounts on which a currency-unaware money path is
 * WRONG BY 100×, plus a deliberately non-discriminating USD control.
 *
 * Bug classes caught: hard-coded `/100` display (¥25,000 renders "250.00"),
 * hard-coded `×100` parse ("25000" JPY parsed as 2,500,000 minor units),
 * and 2dp input masks rejecting valid whole-yen entry. On every JPY/KRW
 * fixture `text !== naiveText`; on `usdControl` they are IDENTICAL — the
 * vacuous-fixture proof in data form (a suite whose assertions hold on
 * `usdControl` alone proves nothing about currency awareness).
 *
 * Replaces the naive fixture: `{ amount: "89.99", currency: "USD" }` — the
 * only money shape most legacy suites ever exercised.
 */
export const HOSTILE_MONEY = {
  /** ¥25,000/night Tokyo stay (`MULTI_ZONE_TRIP_CREATES[0]`). */
  jpyStay: {
    currency: "JPY",
    minorUnits: 25000,
    text: "25000",
    naiveText: "250.00",
  } satisfies HostileMoney,
  /** ₩165,000/night Seoul stay (`MULTI_ZONE_TRIP_CREATES[1]`). */
  krwStay: {
    currency: "KRW",
    minorUnits: 165000,
    text: "165000",
    naiveText: "1650.00",
  } satisfies HostileMoney,
  /** Not divisible by 100 — a `/100 → ×100` round-trip cannot reproduce it. */
  krwOdd: {
    currency: "KRW",
    minorUnits: 33550,
    text: "33550",
    naiveText: "335.50",
  } satisfies HostileMoney,
  /** A fractional yen is unrepresentable — parse must REJECT, never scale. */
  jpyRejectedDecimalText: { currency: "JPY", text: "2500.5" },
  /**
   * NAIVE CONTROL — $25.00: correct and naive renderings coincide, so any
   * money pin that passes on this fixture alone is vacuous. For mutation
   * probes (swap a hostile fixture for this; the discriminating assertion
   * must go green — proving it was load-bearing).
   */
  usdControl: {
    currency: "USD",
    minorUnits: 2500,
    text: "25.00",
    naiveText: "25.00",
  } satisfies HostileMoney,
} as const;

// ---------------------------------------------------------------------------
// 5. Empty states
// ---------------------------------------------------------------------------

/**
 * Empty/zero shapes — the states a fresh install actually shows and legacy
 * fixtures never did (every historical suite seeded populated lists; B-7's
 * cold-start deadlock lived exactly in the unseeded gap — see
 * `fresh-install.db.test.ts` for the DB-level layer; these are the pure
 * shapes for schema/UI/unit consumers).
 *
 * Bug classes caught: `.items[0]` reads, "at least one element" reduces,
 * empty-string-vs-absent conflation, timeless-booking derivation.
 */
export const EMPTY_STATES = {
  /**
   * The minimal `{ category }` member — valid for every category (every
   * detail field is optional by design; an idea may know nothing). Derives
   * NULL instants and ZERO auto-items: the timeless-booking path.
   */
  minimalDetails(category: BookingDetails["category"]): BookingDetails {
    return { category };
  },
  /** A first page with nothing in it (`Paginated<T>` wire shape). */
  emptyPage: { items: [], nextCursor: null },
  /**
   * Schema-VALID empty strings: `optionalString` fields accept `""`, so
   * "field present but empty" reaches every consumer that only checked
   * `undefined`. Distinct from absent — a discriminating pair.
   */
  flightWithEmptyStrings: {
    category: "flight",
    airline: "",
    flight_number: "",
    origin_iata: "",
    destination_iata: "",
  } satisfies FlightDetails as FlightDetails,
  /** Whitespace-only title — trimmed to empty, `min(1)` must reject. */
  whitespaceTitle: "   ",
} as const;

// ---------------------------------------------------------------------------
// 6. Boundary-length strings
// ---------------------------------------------------------------------------

/**
 * Strings at EXACTLY the booking free-text caps (name-like 200 / notes 2000
 * / URL 2048 — `domains/booking.ts` T-6.1 tiers) and one unit over, plus
 * astral-plane shapes that split "length" from "characters".
 *
 * Bug classes caught: off-by-one cap enforcement (at-cap must PASS, cap+1
 * must FAIL — a mid-length fixture can't tell `<` from `<=`), and
 * UTF-16-code-unit vs grapheme counting: `astralOverCap` is 101 visible
 * suitcases but 202 code units, so zod's `.max(200)` REJECTS it — any
 * client-side counter that counts graphemes will disagree with the wire.
 *
 * Replaces the naive fixture: `"Some text"` — every length rule on earth
 * accepts it.
 */
export const BOUNDARY_STRINGS = {
  nameAtCap: "n".repeat(200),
  nameOverCap: "n".repeat(201),
  notesAtCap: "m".repeat(2000),
  notesOverCap: "m".repeat(2001),
  urlAtCap: `https://example.com/${"p".repeat(2028)}`,
  urlOverCap: `https://example.com/${"p".repeat(2029)}`,
  /** 100 astral chars = 200 UTF-16 code units — at cap, parses. */
  astralAtCap: "\u{1F9F3}".repeat(100),
  /** 101 astral chars = 202 code units — over cap DESPITE 101 "characters". */
  astralOverCap: "\u{1F9F3}".repeat(101),
} as const;
