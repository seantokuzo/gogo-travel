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
  NAIVE_CONTROL_FLIGHT,
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
  TZ_MISSING_ERROR,
  TZ_UNKNOWN_ERROR,
  type DetailsFormState,
} from "./form-model";

const HOUR = 3_600_000;

/**
 * Enter a hostile flight exactly as a user would POST-B-9: pick each
 * endpoint's airport (which commits its IATA code AND adopts its IANA zone
 * — `AirportPickerField` → `BookingForm.pickAirport` → the datetime field's
 * `tz`), then type the wall date + time from the ticket.
 *
 * The zone arrives from the PICK, not from the typing — that hop is the
 * whole of B-9's client half, and modelling it here is what lets the escape
 * pin below assert the fix's real acceptance criteria unchanged.
 */
function enterFlight(fixture: HostileFlight): DetailsFormState {
  const state = emptyFormState("flight");
  state["airline"] = fixture.details.airline ?? "";
  state["flight_number"] = fixture.details.flight_number ?? "";
  state["origin_iata"] = fixture.origin.iata;
  state["destination_iata"] = fixture.destination.iata;
  state["departs_at"] = {
    date: fixture.origin.date,
    time: fixture.origin.time,
    tz: fixture.origin.tz,
  };
  state["arrives_at"] = {
    date: fixture.destination.date,
    time: fixture.destination.time,
    tz: fixture.destination.tz,
  };
  return state;
}

/**
 * The PRE-B-9 entry shape: the same wall values with NO zone — what a user
 * got when the form had no airport table to ask. Kept as the discrimination
 * control: `buildDetails` must now REFUSE it rather than Z-stamp it, which
 * is the property that makes B-8 unreachable by regression.
 */
function enterFlightWithoutZones(fixture: HostileFlight): DetailsFormState {
  const state = enterFlight(fixture);
  state["departs_at"] = { date: fixture.origin.date, time: fixture.origin.time, tz: "" };
  state["arrives_at"] = {
    date: fixture.destination.date,
    time: fixture.destination.time,
    tz: "",
  };
  return state;
}

describe("[B-8] the escape pin — FLIPPED by the B-9 client half (zone capture per endpoint)", () => {
  // FLIPPED 2026-09-07 (B-9 client half). Every assertion is the one the
  // pin shipped with — none weakened. What changed is the HARNESS: a user
  // now picks each endpoint's airport, and the pick carries the zone (see
  // `enterFlight`). The evidence pins that described the broken behavior
  // are retired below; the ones describing the categories B-9 did NOT
  // cover survive, retargeted and still green.
  it("entering the real NRT→LAX eastbound flight composes correctly-zoned details with ordered instants", () => {
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

/**
 * RETIRED 2026-09-07 (B-9 client half): four flight-arm evidence pins used
 * to assert the Z-stamped outputs byte-exactly under the banner "GREEN
 * means B-8 is still open". B-8 is closed for flights and trains, so their
 * contract is discharged — each is replaced below by the assertion that its
 * corruption is GONE, over the SAME hostile fixture. The retirement is a
 * flip, not a deletion: every fixture that made the bug visible still runs.
 */
describe("[B-9] the flight arm, fixed — the retired B-8 evidence pins' corruptions, asserted absent", () => {
  it("eastbound NRT→LAX: the 7h inversion is gone — the real 9h duration survives the form (was: 'derives a 7h INVERSION')", () => {
    // Falsification: drop the zone hop (tz: "") and buildDetails REFUSES —
    // it can no longer produce the −7h payload the 12h grace existed to
    // admit. Pinned as its own arm below.
    const built = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND));
    expect(built.errors).toEqual({});
    expect(built.details).toEqual(DATE_LINE_EASTBOUND.details);
    expect(built.details).not.toEqual(DATE_LINE_EASTBOUND.zStamped);
    if (built.details === null) return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      DATE_LINE_EASTBOUND.durationMs,
    );
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).toBe(-7 * HOUR);
  });

  it("the extreme AKL→PPT hop (16h10m z-inversion, BEYOND the 12h grace) is now enterable and derives its real 5h50m", () => {
    // This REAL flight was unenterable even WITH the grace — the proof the
    // grace was a partial unblock. It composes cleanly now.
    const built = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND_EXTREME));
    expect(built.errors).toEqual({});
    expect(built.details).toEqual(DATE_LINE_EASTBOUND_EXTREME.details);
    if (built.details === null) return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      DATE_LINE_EASTBOUND_EXTREME.durationMs,
    );
    expect(DATE_LINE_EASTBOUND_EXTREME.zStampedIntervalMs).toBe(-(16 * HOUR + 10 * 60_000));
  });

  it("westbound LAX→NRT: the SILENT 27h50m stretch is gone — instants are exact, not merely ordered", () => {
    // The arm that mattered most: ordering assertions were green before AND
    // after, so only an INSTANT assertion discriminates. 11h50m real,
    // 27h50m Z-stamped.
    const built = buildDetails("flight", enterFlight(DATE_LINE_WESTBOUND));
    expect(built.errors).toEqual({});
    expect(built.details).toEqual(DATE_LINE_WESTBOUND.details);
    if (built.details === null) return;
    const derived = deriveBookingInstants(built.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      DATE_LINE_WESTBOUND.durationMs,
    );
    expect(DATE_LINE_WESTBOUND.zStampedIntervalMs).toBe(27 * HOUR + 50 * 60_000);
  });

  it("EDIT ROUND-TRIP is lossless: an untouched correctly-zoned booking re-emits BYTE-FOR-BYTE, zones intact", () => {
    // Was: one edit-save cycle silently replaced the instants and deleted
    // the zones. Now `stateFromDetails` records the stored string as `raw`
    // and an untouched field re-emits it verbatim — a title-only edit
    // cannot touch a time the user never opened.
    const state = stateFromDetails(DATE_LINE_EASTBOUND.details);
    expect(state["departs_at"]).toEqual({
      date: wallDate(DATE_LINE_EASTBOUND.details.departs_at ?? ""),
      time: wallTime(DATE_LINE_EASTBOUND.details.departs_at ?? ""),
      tz: "Asia/Tokyo",
      raw: DATE_LINE_EASTBOUND.details.departs_at,
    });
    const rebuilt = buildDetails("flight", state, state);
    expect(rebuilt.errors).toEqual({});
    expect(rebuilt.details).toEqual(DATE_LINE_EASTBOUND.details);
    expect(rebuilt.details).not.toEqual(zStampDetails(DATE_LINE_EASTBOUND.details));
  });

  it("a TOUCHED time recomposes in the stored zone — the passthrough is not a freeze", () => {
    // Falsification for the pin above: if `raw` were re-emitted regardless
    // of edits, this would still read 17:00. Retiming the departure to
    // 18:00 must produce 18:00 JST — same zone, new instant.
    const state = stateFromDetails(DATE_LINE_EASTBOUND.details);
    const departs = state["departs_at"] as { date: string; time: string; tz?: string };
    const edited: DetailsFormState = {
      ...state,
      // The form drops `raw` on every date/time/zone edit (BookingForm
      // `setDateTimePart`) — modelled here by omitting it.
      departs_at: { date: departs.date, time: "18:00", tz: departs.tz ?? "" },
    };
    const built = buildDetails("flight", edited, state);
    expect(built.errors).toEqual({});
    if (built.details === null || built.details.category !== "flight") return;
    expect(built.details.departs_at).toBe("2027-04-24T18:00:00+09:00");
    expect(built.details.departs_tz).toBe("Asia/Tokyo");
  });

  it("B-8 HAS NO ROUTE BACK: the pre-B-9 entry shape (wall values, no zone) is REFUSED, never Z-stamped", () => {
    // The regression guard. Before B-9 these exact inputs produced
    // `zStamped` silently; a future refactor that loses the zone hop now
    // reds every zoned field instead of shipping corrupt instants.
    for (const fixture of [DATE_LINE_EASTBOUND, DATE_LINE_WESTBOUND, NAIVE_CONTROL_FLIGHT]) {
      const built = buildDetails("flight", enterFlightWithoutZones(fixture));
      expect(built.details).toBeNull();
      expect(built.errors["departs_at"]).toBe(TZ_MISSING_ERROR);
      expect(built.errors["arrives_at"]).toBe(TZ_MISSING_ERROR);
    }
  });

  it("a zone the DEVICE can't resolve is TZ_UNKNOWN_ERROR, not a fallback composition", () => {
    // B-9 R1 (tests lane): `TZ_UNKNOWN_ERROR` had zero test references on
    // this branch — a user-facing string that exists for exactly one thing
    // (a zone id this engine cannot resolve) and was never exercised, while
    // its sibling `TZ_MISSING_ERROR` was pinned twice. On Node the branch is
    // hard to reach because every zone the picker offers resolves; a STORED
    // row can carry one that does not — a newer tzdb id, or (on Hermes/iOS)
    // a backward link the platform's own id table rejects. The two failures
    // must stay distinguishable: "you didn't pick one" is a different fix
    // from "this device doesn't have that one".
    const built = buildDetails("flight", {
      origin_iata: "NRT",
      departs_at: { date: "2027-04-24", time: "17:00", tz: "Mars/Olympus_Mons" },
    });
    expect(built.details).toBeNull();
    expect(built.errors["departs_at"]).toBe(TZ_UNKNOWN_ERROR);
    expect(built.errors["departs_at"]).not.toBe(TZ_MISSING_ERROR);
    // …and an EMPTY zone still says the other thing.
    const missing = buildDetails("flight", {
      origin_iata: "NRT",
      departs_at: { date: "2027-04-24", time: "17:00", tz: "" },
    });
    expect(missing.errors["departs_at"]).toBe(TZ_MISSING_ERROR);
  });

  it("DISCRIMINATION: the same-zone control is byte-identical under Z-stamping — which is why naive fixtures never saw B-8", () => {
    // mobile.md's vacuous-pin taxonomy, made explicit. SFO→LAX composes
    // correctly AND Z-stamps to the same duration, so every assertion in
    // this file that is green on the control and red on the date-line
    // fixtures is load-bearing; one green on both would be vacuous.
    const control = buildDetails("flight", enterFlight(NAIVE_CONTROL_FLIGHT));
    expect(control.errors).toEqual({});
    expect(control.details).toEqual(NAIVE_CONTROL_FLIGHT.details);
    expect(NAIVE_CONTROL_FLIGHT.zStampedIntervalMs).toBe(NAIVE_CONTROL_FLIGHT.durationMs);
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).not.toBe(DATE_LINE_EASTBOUND.durationMs);
  });

  it("trains get the same treatment with NO station table — the zone comes from the picker alone", () => {
    // B-9 scope: `train.departs_tz`/`arrives_tz` exist on the wire exactly
    // as they do for flights, but there is no station reference table, so
    // the zone arrives from the explicit picker. Same composition, same
    // acceptance.
    const state = emptyFormState("train", { tz: "Europe/Athens" });
    state["origin_station"] = "Athens";
    state["destination_station"] = "Thessaloniki";
    state["departs_at"] = { date: "2027-07-04", time: "08:20", tz: "Europe/Athens" };
    state["arrives_at"] = { date: "2027-07-04", time: "12:15", tz: "Europe/Athens" };
    const built = buildDetails("train", state);
    expect(built.errors).toEqual({});
    if (built.details === null || built.details.category !== "train") return;
    // Athens is +03:00 in July (EEST) — a summer-DST zone, so a fixed
    // +02:00 offset table would be an hour wrong here.
    expect(built.details.departs_at).toBe("2027-07-04T08:20:00+03:00");
    expect(built.details.arrives_at).toBe("2027-07-04T12:15:00+03:00");
    expect(built.details.departs_tz).toBe("Europe/Athens");
    expect(built.details.arrives_tz).toBe("Europe/Athens");
  });
});

describe("[B-8 residual] the categories B-9 did NOT cover — GREEN means the lodging/rental/activity arm is still open", () => {
  it("the travel-day scramble PERSISTS through the LODGING leg: the Tokyo checkout still sorts after the flight it precedes", () => {
    // Retargeted (was: "the form's own compositions sort the LAX arrival
    // BEFORE the Tokyo checkout"). The flight legs are fixed, so the
    // arrival no longer leads — but `check_out` has no `*_tz` on the wire,
    // stays Z-stamped, and now sorts AFTER the departure it really
    // precedes. Retires when lodging endpoints get zone capture (B-8 DoD).
    const { checkout } = MULTI_ZONE_TRIP.travelDayScramble;
    const flight = buildDetails("flight", enterFlight(DATE_LINE_EASTBOUND));
    if (flight.details === null || flight.details.category !== "flight") return;

    const lodging = emptyFormState("lodging");
    lodging["check_out"] = { date: wallDate(checkout), time: wallTime(checkout) };
    const stay = buildDetails("lodging", lodging);
    expect(stay.errors).toEqual({});
    if (stay.details === null || stay.details.category !== "lodging") return;
    // Z-stamped, exactly as before B-9 — the out-of-scope arm.
    expect(stay.details.check_out).toBe(composeLocalDateTime(wallDate(checkout), wallTime(checkout)));

    const composed = [
      stay.details.check_out ?? "",
      flight.details.departs_at ?? "",
      flight.details.arrives_at ?? "",
    ];
    const sorted = [...composed].sort((a, b) => instantMs(a) - instantMs(b));
    // Truth is [checkout, departure, arrival]; the lodging gap alone moves
    // the checkout behind the departure it really precedes.
    expect(sorted).toEqual([composed[1], composed[0], composed[2]]);
    // The correctly-zoned checkout would lead — the one-line proof that the
    // residual is the lodging composition, not the flight one.
    const zoned = [checkout, composed[1], composed[2]];
    expect([...zoned].sort((a, b) => instantMs(a) - instantMs(b))).toEqual(zoned);
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
    // Asserted BEFORE the type guard (R1 fix): without this, a buildDetails
    // regression that rejects lodging datetimes would early-return with zero
    // assertions executed — green with nothing pinned, breaking this pin's
    // "GREEN means B-8 still open" contract for the lodging arm.
    expect(built.errors).toEqual({});
    expect(built.details).not.toBeNull();
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
