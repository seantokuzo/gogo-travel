/**
 * Form-model × hostile fixtures (T-S3.4, testing-overhaul spec §3.4,
 * R-test-4/R-test-8) — the CURRENT add/edit form model run against
 * `@gogo/shared/testing`, pinning reality honestly:
 *
 *  - ONE escape pin (`it.failing`): the B-8 executable repro and the client
 *    fix's acceptance harness. It reds today because `composeLocalDateTime`
 *    stamps `Z` on every wall time (form-model.ts) and never populates
 *    `departs_tz`/`arrives_tz`.
 *  - EVIDENCE pins (plain `it`, the T-S3.3 B-7 precedent from
 *    `fresh-install.db.test.ts`): today's wrong outputs pinned EXACTLY, so
 *    a 500-class or unrelated regression cannot hide inside the escape
 *    pin's "any failure passes" semantics. GREEN here means B-8 is still
 *    open.
 *
 * CO-RETIREMENT (flip instructions): the B-8 client fix — real zone/offset
 * captured per endpoint, unblocked by B-9's airport table (QUEUE B-9 row)
 * — flips the escape pin `it.failing` → `it` and RETIRES the evidence pins
 * in the SAME PR wave that reverts the temporary 12h transport grace
 * (`TZ_INVERSION_GRACE_MS`, bookings/service.ts) + migration 0001: the
 * QUEUE B-8 row's definition of done says grace and migration revert
 * together, and these pins go with them. The lodging/DST evidence pin
 * retires with the same client fix applied to lodging endpoints (B-8 DoD;
 * B-9's table covers the flight/train arms).
 *
 * Falsification (R-test-7): each evidence pin states its own; the escape
 * pin's is the fix itself. Mutation-verified at build time (see the PR):
 * with the escape pin flipped to `it`, the hostile fixture reds it while
 * `NAIVE_CONTROL_FLIGHT` in its place stays green — the discrimination
 * proof that a same-zone fixture cannot see B-8.
 */
import {
  DATE_LINE_EASTBOUND,
  DATE_LINE_EASTBOUND_EXTREME,
  DATE_LINE_WESTBOUND,
  DST_FALL_BACK_STAY,
  EMPTY_STATES,
  HOSTILE_MONEY,
  MULTI_ZONE_TRIP,
  instantMs,
  zStampDetails,
  type HostileFlight,
} from "@gogo/shared/testing";
import { BOOKING_CATEGORIES, deriveBookingInstants, wallDate, wallTime } from "@gogo/shared";

import {
  buildDetails,
  centsToMoneyText,
  composeLocalDateTime,
  emptyFormState,
  parseMoneyToCents,
  stateFromDetails,
  type DetailsFormState,
} from "./form-model";

const HOUR = 3_600_000;

/** Enter a hostile flight exactly as a user would: wall date + time per endpoint. */
function enterFlight(fixture: HostileFlight): DetailsFormState {
  const state = emptyFormState("flight");
  state["airline"] = fixture.details.airline ?? "";
  state["flight_number"] = fixture.details.flight_number ?? "";
  state["origin_iata"] = fixture.origin.iata;
  state["destination_iata"] = fixture.destination.iata;
  state["departs_at"] = { date: fixture.origin.date, time: fixture.origin.time };
  state["arrives_at"] = { date: fixture.destination.date, time: fixture.destination.time };
  return state;
}

describe("[B-8] the escape pin — flips to `it` with the B-8 client fix (zone capture per endpoint, unblocked by B-9)", () => {
  // Flip instruction (B-8 client-fix PR): change `it.failing` to `it`, keep
  // every assertion, and retire the evidence pins below in the same wave as
  // the 12h-grace + migration-0001 revert (B-8 DoD). Do NOT weaken the
  // assertions to make it pass earlier: all four facts — both endpoints'
  // real offsets in the composed strings, both zones populated, ordered
  // instants — are the fix's acceptance criteria.
  it.failing("entering the real NRT→LAX eastbound flight composes correctly-zoned details with ordered instants", () => {
    const built = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND));
    expect(built.errors).toEqual({});
    expect(built.details).not.toBeNull();
    if (built.details === null || built.details.category !== "flight") return;

    // The composed strings must carry each endpoint's REAL offset…
    expect(built.details.departs_at).toBe(DATE_LINE_EASTBOUND.details.departs_at);
    expect(built.details.arrives_at).toBe(DATE_LINE_EASTBOUND.details.arrives_at);
    // …and the IANA zones the wire contract already has fields for.
    expect(built.details.departs_tz).toBe("Asia/Tokyo");
    expect(built.details.arrives_tz).toBe("America/Los_Angeles");

    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(9 * HOUR);
  });
});

describe("[B-8 evidence] current behavior pinned exactly — GREEN means B-8 is still open; retires with the fix + grace revert", () => {
  it("the form Z-stamps both endpoints and drops the zones: the real 9h flight derives a 7h INVERSION (inside the 12h transport grace)", () => {
    // Falsification: ANY change to the composition — the fix, or a partial
    // one — reds an exact-equality arm here while the escape pin above
    // tracks the fix's full acceptance. That split is the point (B-7
    // precedent): a crash or half-fix cannot masquerade as "still failing
    // as expected".
    const built = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND));
    expect(built.errors).toEqual({});
    // Byte-exact today: the fixture's PRE-COMPUTED Z-stamped shape.
    expect(built.details).toEqual(DATE_LINE_EASTBOUND.zStamped);
    if (built.details === null) return;

    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(-7 * HOUR);
    // −7h sits INSIDE the temporary 12h transport grace, so the server
    // currently ADMITS this corrupted payload (stored instants wrong) —
    // the grace + migration 0001 revert together with B-9 (B-8 DoD).
  });

  it("the extreme date-line hop (AKL→PPT, 16h10m z-inversion) is beyond the grace — this REAL flight is STILL unenterable today", () => {
    // The grace was a partial unblock, not a fix. Falsification: composing
    // with real offsets (the fix) makes the inversion vanish — this pin
    // reds and retires.
    const built = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND_EXTREME));
    expect(built.details).toEqual(DATE_LINE_EASTBOUND_EXTREME.zStamped);
    if (built.details === null) return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      -(16 * HOUR + 10 * 60_000),
    );
  });

  it("westbound LAX→NRT: no error anywhere, but the derived duration is 27h50m instead of 11h50m — the silent-corruption arm", () => {
    // Nothing inverts, nothing rejects; every stored instant is hours
    // wrong. This is why the bug class survived ~3000 tests: ordering
    // assertions stay green on every naive fixture AND on this one — only
    // the instant/duration assertion discriminates.
    const built = buildDetails("flight", enterFlight(DATE_LINE_WESTBOUND));
    expect(built.errors).toEqual({});
    if (built.details === null) return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "")).toBeGreaterThan(instantMs(derived.starts_at ?? ""));
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      27 * HOUR + 50 * 60_000,
    );
  });

  it("EDIT ROUND-TRIP corrupts a correctly-zoned booking: stateFromDetails keeps the wall clocks, buildDetails re-stamps them Z and strips the zones", () => {
    // A booking with real offsets (capture-landed today; every booking
    // post-B-9) survives DISPLAY (wall slicing is exact) but one edit-save
    // cycle silently replaces its instants and deletes its zones. Only a
    // fixture with non-Z offsets can see this — a Z-offset fixture
    // round-trips losslessly (the historical blind spot). Retires with the
    // B-8 client fix.
    const state = stateFromDetails(DATE_LINE_EASTBOUND.details);
    // Display half is faithful — the §3.3 wall model works…
    expect(state["departs_at"]).toEqual({
      date: wallDate(DATE_LINE_EASTBOUND.details.departs_at ?? ""),
      time: wallTime(DATE_LINE_EASTBOUND.details.departs_at ?? ""),
    });
    // …the save half is the corruption: byte-equal to the bug simulator.
    const rebuilt = buildDetails("flight", state);
    expect(rebuilt.details).toEqual(zStampDetails(DATE_LINE_EASTBOUND.details));
  });

  it("travel-day scramble reaches the itinerary: the form's own compositions sort the LAX arrival BEFORE the Tokyo checkout", () => {
    // The user-visible consequence on the multi-zone trip: sort by derived
    // instant (what the itinerary does) shows you landing in LA before
    // leaving your Tokyo hotel. Retires with the B-8 client fix.
    const { checkout, departure, arrival } = MULTI_ZONE_TRIP.travelDayScramble;
    const composed = [checkout, departure, arrival].map((local) =>
      composeLocalDateTime(wallDate(local), wallTime(local)),
    );
    const sorted = [...composed].sort((a, b) => instantMs(a) - instantMs(b));
    expect(sorted).toEqual([composed[2], composed[0], composed[1]]);
  });

  it("DST fall-back stay: the form composes both endpoints with one implicit offset (Z), so the 21h stay derives as 20h", () => {
    // The uniform-offset corruption class — same arithmetic B-8's fix must
    // get right per-endpoint. Retires when lodging endpoints get real zone
    // capture (the B-8 DoD wave; B-9's airport table covers flight/train).
    const state = emptyFormState("lodging");
    const ci = DST_FALL_BACK_STAY.details.check_in ?? "";
    const co = DST_FALL_BACK_STAY.details.check_out ?? "";
    state["check_in"] = { date: wallDate(ci), time: wallTime(ci) };
    state["check_out"] = { date: wallDate(co), time: wallTime(co) };
    const built = buildDetails("lodging", state);
    if (built.details === null || built.details.category !== "lodging") return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      DST_FALL_BACK_STAY.naiveUniformOffsetDurationMs,
    );
    expect(derived.starts_at).not.toBeNull();
    // One hour short of reality — the fixture's real duration.
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).not.toBe(
      DST_FALL_BACK_STAY.realDurationMs,
    );
  });
});

describe("zero-decimal money through the form surface (T-9.1 landed — these pins are green and stay)", () => {
  it("JPY/KRW amounts parse whole and render whole — no ×100/÷100 corruption", () => {
    // Falsification: reverting the T-9.1 currency-aware helpers (or
    // dropping JPY/KRW from the zero-decimal list) reds the exact values.
    for (const fixture of [HOSTILE_MONEY.jpyStay, HOSTILE_MONEY.krwStay, HOSTILE_MONEY.krwOdd]) {
      expect(parseMoneyToCents(fixture.text, fixture.currency)).toEqual({
        ok: true,
        cents: fixture.minorUnits,
      });
      // Zero-decimal render is identical under both formatter postures, so
      // the form wrapper (omitZeroMinor) must also produce the fixture text.
      expect(centsToMoneyText(fixture.minorUnits, fixture.currency)).toBe(fixture.text);
    }
  });

  it("a fractional yen is rejected, never scaled; the USD control renders '25' under the form's omit-zero-minor posture", () => {
    const rejected = parseMoneyToCents(
      HOSTILE_MONEY.jpyRejectedDecimalText.text,
      HOSTILE_MONEY.jpyRejectedDecimalText.currency,
    );
    expect(rejected.ok).toBe(false);
    // The control documents the FORM-specific display shape (omitZeroMinor
    // drops the all-zero minor part — pre-rider pinned behavior).
    expect(centsToMoneyText(HOSTILE_MONEY.usdControl.minorUnits, "USD")).toBe("25");
  });
});

describe("empty states through the form", () => {
  it("an untouched form builds the minimal {category} member for every category — the timeless-booking path", () => {
    for (const category of BOOKING_CATEGORIES) {
      const built = buildDetails(category, emptyFormState(category));
      expect(built.errors).toEqual({});
      expect(built.details).toEqual(EMPTY_STATES.minimalDetails(category));
    }
  });
});
