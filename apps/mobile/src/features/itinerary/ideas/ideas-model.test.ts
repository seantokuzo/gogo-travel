/**
 * Ideas-bucket model pins (T-7.6 / IT-5 — R-itin-10..12 pure halves):
 * zero-item membership (client R-ib-10), category grouping in tuple order
 * with `updated_at DESC` inside a group, the needs-a-day flag, the B-13
 * two-peer-bin row split (Ideas rows never carry cancelled; cancelled get
 * their own flat row list), and Law #2 integer-cents price text.
 */
import { ScheduleBookingInputSchema, type Booking } from "@gogo/shared";

import { ApiRequestError } from "@/auth";

import {
  buildCancelledRows,
  buildIdeasGroups,
  buildIdeasRows,
  buildStatusActionRequest,
  DAY_REQUIRED_ERROR,
  END_BEFORE_START_ERROR,
  formatIdeaPrice,
  isSameStatusAction,
  isStatusActionOffered,
  knownTimesSummary,
  offeredStatusActions,
  schedulePrefill,
  STATUS_ACTION_FAILED_BANNER,
  statusActionCopy,
  statusActionFailure,
  statusActionRoute,
  unscheduledBookings,
  validateScheduleForm,
  type ScheduleFormValues,
} from "./ideas-model";

import {
  BOOKING_FLIGHT_ID,
  BOOKING_IDEA_ID,
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  makeBooking,
} from "@/test-utils/itinerary-fixtures";

describe("unscheduledBookings (client R-ib-10)", () => {
  it("keeps exactly the zero-item bookings", () => {
    const idea = makeBooking({ id: BOOKING_IDEA_ID, status: "idea", starts_at: null });
    const bookings = [...defaultBookings(), idea];
    // Flight + lodging both have items in the default universe; the idea
    // has none.
    const result = unscheduledBookings(bookings, defaultItineraryItems());
    expect(result.map((b) => b.id)).toEqual([BOOKING_IDEA_ID]);
  });

  it("with zero items every booking is unscheduled", () => {
    const result = unscheduledBookings(defaultBookings(), []);
    expect(result.map((b) => b.id)).toEqual([BOOKING_FLIGHT_ID, BOOKING_LODGING_ID]);
  });
});

describe("buildIdeasGroups (§2.3 grouping)", () => {
  it("groups by category in tuple order, updated_at DESC inside a group, and flags needs-a-day", () => {
    const oldFlight = makeBooking({
      id: "eeeeeee1-eeee-4eee-8eee-eeeeeeeeeee1",
      category: "flight",
      status: "idea",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const newFlight = makeBooking({
      id: "eeeeeee2-eeee-4eee-8eee-eeeeeeeeeee2",
      category: "flight",
      status: "idea",
      updated_at: "2026-07-02T00:00:00.000Z",
    });
    const timelessPlanned = makeBooking({
      id: "eeeeeee3-eeee-4eee-8eee-eeeeeeeeeee3",
      category: "lodging",
      status: "planned",
      starts_at: null,
    });

    const groups = buildIdeasGroups([oldFlight, newFlight, timelessPlanned]);
    // lodging precedes flight in the shared category tuple.
    expect(groups.map((g) => g.category)).toEqual(["lodging", "flight"]);
    expect(groups[1]?.cards.map((c) => c.booking.id)).toEqual([newFlight.id, oldFlight.id]);
    // R-itin-12: timeless planned/booked is flagged; ideas are not.
    expect(groups[0]?.cards[0]?.needsDay).toBe(true);
    expect(groups[1]?.cards[0]?.needsDay).toBe(false);
  });
});

describe("buildIdeasRows / buildCancelledRows (B-13 two-peer-bin split)", () => {
  it("Ideas rows are the unscheduled groups only — never a cancelled card", () => {
    const idea = makeBooking({ id: BOOKING_IDEA_ID, status: "idea" });
    const rows = buildIdeasRows(buildIdeasGroups([idea]));
    expect(rows.map((row) => row.type)).toEqual(["group", "card"]);
    expect(rows.some((row) => row.type === "card" && row.cancelled)).toBe(false);
  });

  it("Cancelled rows are flat cancelled cards — no group label (the bin header names them)", () => {
    const cancelled = makeBooking({ id: BOOKING_FLIGHT_ID, status: "cancelled" });
    const rows = buildCancelledRows([cancelled]);
    expect(rows).toEqual([
      {
        type: "card",
        key: BOOKING_FLIGHT_ID,
        card: { booking: cancelled, needsDay: false },
        cancelled: true,
      },
    ]);
  });

  it("empty inputs yield empty row lists — the bins hide on empty, they never render blanks", () => {
    expect(buildIdeasRows(buildIdeasGroups([]))).toEqual([]);
    expect(buildCancelledRows([])).toEqual([]);
  });
});

describe("schedulePrefill (B-16 — carried date/times become the sheet's initial VALUES)", () => {
  it("same-wall-date start+end prefill day and both times (wall slices of the LOCAL strings, no tz math)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: {
        category: "activity",
        starts_at: "2027-03-02T14:30:00+09:00",
        ends_at: "2027-03-02T16:00:00+09:00",
      },
      starts_at: "2027-03-02T05:30:00.000Z",
      ends_at: "2027-03-02T07:00:00.000Z",
    });
    // Wall values, NOT the UTC instants (05:30Z would be tz-broken output).
    expect(schedulePrefill(idea)).toEqual({
      day: "2027-03-02",
      startTime: "14:30",
      endTime: "16:00",
    });
  });

  it("a cross-day end is dropped — the sheet's single-day end_time can't carry it, and an overnight span would read inverted", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "lodging",
      status: "idea",
      details: {
        category: "lodging",
        check_in: "2027-03-01T15:00:00+09:00",
        check_out: "2027-03-03T11:00:00+09:00",
      },
      starts_at: "2027-03-01T06:00:00.000Z",
      ends_at: "2027-03-03T02:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({ day: "2027-03-01", startTime: "15:00", endTime: "" });
  });

  it("nothing carried ⇒ all empty (the control state — pre-B-16 behavior preserved)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: { category: "activity" },
      starts_at: null,
      ends_at: null,
    });
    expect(schedulePrefill(idea)).toEqual({ day: "", startTime: "", endTime: "" });
  });

  it("end-only carried time anchors the day from the end (each side independent — R-ib-4 posture)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: { category: "activity", ends_at: "2027-03-02T16:00:00+09:00" },
      starts_at: null,
      ends_at: "2027-03-02T07:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({ day: "2027-03-02", startTime: "", endTime: "16:00" });
  });

  it("date-line class (same wall-date, end before start) prefills as carried — the form's inversion rule governs, not this projection", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: {
        category: "activity",
        starts_at: "2027-03-02T14:30:00+13:00",
        ends_at: "2027-03-02T09:00:00-10:00",
      },
      starts_at: "2027-03-02T01:30:00.000Z",
      ends_at: "2027-03-02T19:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({
      day: "2027-03-02",
      startTime: "14:30",
      endTime: "09:00",
    });
  });
});

describe("formatIdeaPrice (Law #2 — integer cents; T-9.1 R1: shared ISO-4217 formatter)", () => {
  it("2-decimal currencies render byte-identical to the pre-swap output (control arms)", () => {
    expect(formatIdeaPrice(123456, "USD")).toBe("USD 1234.56");
    expect(formatIdeaPrice(100, "EUR")).toBe("EUR 1.00");
    expect(formatIdeaPrice(5, "USD")).toBe("USD 0.05");
  });

  it("zero-decimal currencies render whole minor units (was '15.00' for 1500 — 100× off)", () => {
    expect(formatIdeaPrice(1500, "JPY")).toBe("JPY 1500");
    expect(formatIdeaPrice(0, "JPY")).toBe("JPY 0");
    // Control arm: the same minor-unit count under a 2dp currency scales.
    expect(formatIdeaPrice(1500, "USD")).toBe("USD 15.00");
  });
});

// ---------------------------------------------------------------------------
// T-7.15 — Planned / Booked status actions (R-itin-11/40/41)
// ---------------------------------------------------------------------------

const WITH_TIMES_ID = "fffffff4-ffff-4fff-8fff-fffffffffff4";
const EMPTY_FORM: ScheduleFormValues = { day: "", startTime: "", endTime: "" };
const FORM: ScheduleFormValues = { day: "2027-03-02", startTime: "14:30", endTime: "16:00" };

/**
 * The EXACT B-16 fixture that dead-ended on device (Sean QA 2026-09-06): an
 * `idea` carrying date/times, so its derived `starts_at` is known and
 * `POST …/schedule` rejects it (R-ib-8).
 */
function ideaWithTimes(overrides?: Partial<Booking>): Booking {
  return makeBooking({
    id: WITH_TIMES_ID,
    category: "activity",
    status: "idea",
    title: "Sumo tournament",
    details: {
      category: "activity",
      starts_at: "2027-03-02T14:30:00+09:00",
      ends_at: "2027-03-02T16:00:00+09:00",
    },
    starts_at: "2027-03-02T05:30:00.000Z",
    ends_at: "2027-03-02T07:00:00.000Z",
    ...overrides,
  });
}

function timeless(status: Booking["status"]): Booking {
  return makeBooking({
    id: BOOKING_IDEA_ID,
    category: "activity",
    status,
    details: { category: "activity" },
    starts_at: null,
    ends_at: null,
  });
}

describe("offeredStatusActions (R-itin-11/40, conservative reading)", () => {
  it("idea ⇒ both actions; planned ⇒ both (Planned = give it a day, stay planned); booked ⇒ Booked only; cancelled ⇒ none", () => {
    expect(offeredStatusActions("idea")).toEqual(["planned", "booked"]);
    expect(offeredStatusActions("planned")).toEqual(["planned", "booked"]);
    expect(offeredStatusActions("booked")).toEqual(["booked"]);
    expect(offeredStatusActions("cancelled")).toEqual([]);
  });

  // Falsify: make `isStatusActionOffered` return true for every non-cancelled
  // (the literal R-itin-11 reading) ⇒ the booked row gains "planned" ⇒ RED.
  it("[NEEDS CLARIFICATION: T-7.15 bucket-card demotion] the bucket never demotes — Planned is not offered on a booked card", () => {
    expect(isStatusActionOffered("booked", "planned")).toBe(false);
    expect(offeredStatusActions("booked")).not.toContain("planned");
    // Controls: the non-demoting taps on the same card ARE offered.
    expect(isStatusActionOffered("booked", "booked")).toBe(true);
    expect(isStatusActionOffered("planned", "booked")).toBe(true);
  });

  it("cancelled is terminal (§3.2): neither action is offered", () => {
    expect(isStatusActionOffered("cancelled", "planned")).toBe(false);
    expect(isStatusActionOffered("cancelled", "booked")).toBe(false);
  });
});

describe("isSameStatusAction / statusActionCopy (architecture r1 Adv 2 — one home for the rule)", () => {
  // Falsify: invert `isSameStatusAction` (or re-derive the rule in the sheet
  // with a different comparison) ⇒ an advancing tap reads "Add to day" and a
  // same-status tap reads "Mark as …" ⇒ RED.
  it("same-status ⇒ 'Add to day' copy; an advancing tap ⇒ 'Mark as …' copy — for every offered (status, target) pair", () => {
    const base = { ...timeless("idea"), title: "TeamLab Planets" };
    const cases = [
      ["idea", "planned", false],
      ["idea", "booked", false],
      ["planned", "planned", true],
      ["planned", "booked", false],
      ["booked", "booked", true],
    ] as const;
    for (const [status, target, same] of cases) {
      const booking = { ...base, status };
      expect(isSameStatusAction(booking, target)).toBe(same);
      const label = target === "planned" ? "Planned" : "Booked";
      expect(statusActionCopy(booking, target)).toEqual(
        same
          ? { title: 'Add "TeamLab Planets" to a day', confirmLabel: "Add to day" }
          : {
              title: `Mark "TeamLab Planets" as ${label}`,
              confirmLabel: `Mark as ${label}`,
            },
      );
    }
  });

  it("copy reads the booking it is GIVEN: the tap-time snapshot keeps its copy while the live row's optimistic status flips", () => {
    const snapshot = { ...timeless("idea"), title: "TeamLab Planets" };
    const liveMidFlight = { ...snapshot, status: "planned" as const };
    expect(statusActionCopy(snapshot, "planned").confirmLabel).toBe("Mark as Planned");
    // The hazard the sheet avoids by passing the snapshot, not the live row:
    expect(statusActionCopy(liveMidFlight, "planned").confirmLabel).toBe("Add to day");
  });
});

describe("statusActionRoute (R-itin-41 — the server's own known-times discriminator)", () => {
  it("known starts_at ⇒ status-only PATCH; timeless ⇒ schedule endpoint", () => {
    expect(statusActionRoute(ideaWithTimes())).toBe("status");
    expect(statusActionRoute(timeless("idea"))).toBe("schedule");
  });

  it("adversarial: an END-only booking is timeless to the server (starts_at null) ⇒ it still schedules, even though schedulePrefill anchors on its end", () => {
    const endOnly = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: { category: "activity", ends_at: "2027-03-02T16:00:00+09:00" },
      starts_at: null,
      ends_at: "2027-03-02T07:00:00.000Z",
    });
    expect(schedulePrefill(endOnly).day).toBe("2027-03-02");
    expect(statusActionRoute(endOnly)).toBe("schedule");
  });
});

describe("buildStatusActionRequest (R-itin-41 routing)", () => {
  // Falsify: route every booking through the schedule endpoint (revert the
  // `statusActionRoute` branch) ⇒ these become `{ route: "schedule" }` ⇒ RED.
  it("adversarial: the B-16 known-times fixture routes to a STATUS-ONLY PATCH, for both actions — never the schedule endpoint", () => {
    const sumo = ideaWithTimes();
    expect(buildStatusActionRequest(sumo, "planned", EMPTY_FORM)).toEqual({
      route: "status",
      input: { status: "planned" },
    });
    expect(buildStatusActionRequest(sumo, "booked", EMPTY_FORM)).toEqual({
      route: "status",
      input: { status: "booked" },
    });
  });

  it("known-times status PATCH ignores the (read-only) form — nothing day/time-shaped rides it", () => {
    const request = buildStatusActionRequest(ideaWithTimes(), "booked", FORM);
    expect(request).toEqual({ route: "status", input: { status: "booked" } });
  });

  // Falsify: drop `status` from the schedule candidate ⇒ body loses
  // `status: "booked"` ⇒ the server would advance `idea → planned` ⇒ RED.
  it("happy: a timeless idea + Booked schedules with status 'booked' (and the wire body parses)", () => {
    const request = buildStatusActionRequest(timeless("idea"), "booked", FORM);
    expect(request).toEqual({
      route: "schedule",
      input: { day: "2027-03-02", start_time: "14:30", end_time: "16:00", status: "booked" },
    });
    if (request?.route !== "schedule") throw new Error("expected the schedule route");
    expect(ScheduleBookingInputSchema.safeParse(request.input).success).toBe(true);
  });

  it("happy: a timeless idea + Planned schedules with status 'planned'; times stay optional", () => {
    expect(
      buildStatusActionRequest(timeless("idea"), "planned", { ...EMPTY_FORM, day: "2027-03-02" }),
    ).toEqual({ route: "schedule", input: { day: "2027-03-02", status: "planned" } });
  });

  it("a timeless PLANNED card advances with Booked (status 'booked')", () => {
    expect(buildStatusActionRequest(timeless("planned"), "booked", FORM)).toEqual({
      route: "schedule",
      input: { day: "2027-03-02", start_time: "14:30", end_time: "16:00", status: "booked" },
    });
  });

  it("same-status taps OMIT `status` so the server's pre-change path runs (planned+Planned, booked+Booked)", () => {
    for (const status of ["planned", "booked"] as const) {
      const request = buildStatusActionRequest(timeless(status), status, FORM);
      expect(request).toEqual({
        route: "schedule",
        input: { day: "2027-03-02", start_time: "14:30", end_time: "16:00" },
      });
      if (request?.route !== "schedule") throw new Error("expected the schedule route");
      expect(request.input).not.toHaveProperty("status");
    }
  });

  // Falsify: delete the `isStatusActionOffered` guard from the builder (or
  // flip the predicate to allow demotion) ⇒ a `status: "planned"` schedule
  // body is built for a booked card ⇒ RED. Both routes pinned separately.
  it("[NEEDS CLARIFICATION: T-7.15 bucket-card demotion] a booked card is never demoted — no request is built for Planned, on EITHER route", () => {
    expect(buildStatusActionRequest(timeless("booked"), "planned", FORM)).toBeNull();
    expect(
      buildStatusActionRequest(ideaWithTimes({ status: "booked" }), "planned", EMPTY_FORM),
    ).toBeNull();
  });

  it("a cancelled card builds nothing for either action", () => {
    expect(buildStatusActionRequest(timeless("cancelled"), "planned", FORM)).toBeNull();
    expect(buildStatusActionRequest(timeless("cancelled"), "booked", FORM)).toBeNull();
  });

  it("error: an invalid form builds nothing on the schedule route (empty day; inverted times)", () => {
    expect(buildStatusActionRequest(timeless("idea"), "planned", EMPTY_FORM)).toBeNull();
    expect(
      buildStatusActionRequest(timeless("idea"), "planned", {
        day: "2027-03-02",
        startTime: "16:00",
        endTime: "14:30",
      }),
    ).toBeNull();
  });

  it("boundary: end time EQUAL to start time is valid and rides the body (the wire rule is strict end < start)", () => {
    const request = buildStatusActionRequest(timeless("idea"), "planned", {
      day: "2027-03-02",
      startTime: "14:30",
      endTime: "14:30",
    });
    expect(request).toEqual({
      route: "schedule",
      input: { day: "2027-03-02", start_time: "14:30", end_time: "14:30", status: "planned" },
    });
  });
});

describe("validateScheduleForm (R-itin-41 inline errors)", () => {
  it("empty day ⇒ day error; times optional (no other error)", () => {
    expect(validateScheduleForm(EMPTY_FORM)).toEqual({ day: DAY_REQUIRED_ERROR });
  });

  it("end before start ⇒ end-time error; a valid day alone is clean", () => {
    expect(
      validateScheduleForm({ day: "2027-03-02", startTime: "16:00", endTime: "14:30" }),
    ).toEqual({
      endTime: END_BEFORE_START_ERROR,
    });
    expect(validateScheduleForm({ day: "2027-03-02", startTime: "", endTime: "" })).toEqual({});
  });

  it("boundary: end == start is NOT an error; a lone end (no start) is NOT an error", () => {
    expect(
      validateScheduleForm({ day: "2027-03-02", startTime: "14:30", endTime: "14:30" }),
    ).toEqual({});
    expect(validateScheduleForm({ day: "2027-03-02", startTime: "", endTime: "09:00" })).toEqual(
      {},
    );
  });
});

describe("knownTimesSummary (R-itin-41 read-only lines — wall components, no tz math)", () => {
  it("single-day activity: Starts + Ends from the LOCAL strings (not the UTC instants)", () => {
    expect(knownTimesSummary(ideaWithTimes())).toEqual([
      { label: "Starts", day: "2027-03-02", time: "14:30" },
      { label: "Ends", day: "2027-03-02", time: "16:00" },
    ]);
  });

  it("lodging shows check-out on ITS OWN day (schedulePrefill's single-day shape would drop it)", () => {
    const lodging = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "lodging",
      status: "idea",
      details: {
        category: "lodging",
        check_in: "2027-03-01T15:00:00+09:00",
        check_out: "2027-03-03T11:00:00+09:00",
      },
      starts_at: "2027-03-01T06:00:00.000Z",
    });
    expect(knownTimesSummary(lodging)).toEqual([
      { label: "Starts", day: "2027-03-01", time: "15:00" },
      { label: "Ends", day: "2027-03-03", time: "11:00" },
    ]);
  });

  it("start-only (restaurant reservation) ⇒ a single Starts line; nothing carried ⇒ empty", () => {
    const dinner = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "restaurant",
      status: "idea",
      details: { category: "restaurant", reserved_at: "2027-03-02T19:00:00+09:00" },
      starts_at: "2027-03-02T10:00:00.000Z",
    });
    expect(knownTimesSummary(dinner)).toEqual([
      { label: "Starts", day: "2027-03-02", time: "19:00" },
    ]);
    expect(knownTimesSummary(timeless("idea"))).toEqual([]);
  });
});

describe("statusActionFailure (server refusal → field vs banner)", () => {
  it("happy-path control: a VALIDATION_FAILED whose `fieldErrors.status` is set lands ON the status field — no banner", () => {
    const error = new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
      formErrors: [],
      fieldErrors: { status: ["Invalid option: expected one of planned|booked"] },
    });
    expect(statusActionFailure(error)).toEqual({
      fieldErrors: { status: "Invalid option: expected one of planned|booked" },
      banner: null,
    });
  });

  it("maps day / start_time / end_time to their fields too; first message per field wins", () => {
    const error = new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
      formErrors: [],
      fieldErrors: {
        day: ["Invalid ISO date", "second"],
        start_time: ["bad time"],
        end_time: ["end_time must be on or after start_time"],
      },
    });
    expect(statusActionFailure(error)).toEqual({
      fieldErrors: {
        day: "Invalid ISO date",
        startTime: "bad time",
        endTime: "end_time must be on or after start_time",
      },
      banner: null,
    });
  });

  it("a mapped field PLUS an unmapped reason (after_item_id) keeps the banner for the leftover", () => {
    const error = new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
      formErrors: [],
      fieldErrors: { status: ["nope"], after_item_id: ["not a uuid"] },
    });
    expect(statusActionFailure(error)).toEqual({
      fieldErrors: { status: "nope" },
      banner: STATUS_ACTION_FAILED_BANNER,
    });
  });

  it("the service-level illegal-transition shape (flat `details.status`) lands on the status field with the server's sentence", () => {
    const error = new ApiRequestError(
      400,
      "VALIDATION_FAILED",
      "illegal status transition 'booked' → 'planned'",
      { status: "illegal transition" },
    );
    expect(statusActionFailure(error)).toEqual({
      fieldErrors: { status: "illegal status transition 'booked' → 'planned'" },
      banner: null,
    });
  });

  it("adversarial: the stale-premise 'known times' 400 maps to no field ⇒ generic banner", () => {
    const error = new ApiRequestError(
      400,
      "VALIDATION_FAILED",
      "booking has known times — its calendar presence is automatic",
      { starts_at: "known" },
    );
    expect(statusActionFailure(error)).toEqual({
      fieldErrors: {},
      banner: STATUS_ACTION_FAILED_BANNER,
    });
  });

  it("non-validation failures (409, transport) and non-errors are the generic banner", () => {
    expect(statusActionFailure(new ApiRequestError(409, "CONFLICT", "already scheduled"))).toEqual({
      fieldErrors: {},
      banner: STATUS_ACTION_FAILED_BANNER,
    });
    expect(statusActionFailure(new ApiRequestError(0, "NETWORK", "offline"))).toEqual({
      fieldErrors: {},
      banner: STATUS_ACTION_FAILED_BANNER,
    });
    expect(statusActionFailure(undefined)).toEqual({
      fieldErrors: {},
      banner: STATUS_ACTION_FAILED_BANNER,
    });
    // VALIDATION_FAILED with nothing structured ⇒ generic, not a crash.
    expect(statusActionFailure(new ApiRequestError(400, "VALIDATION_FAILED", "bad"))).toEqual({
      fieldErrors: {},
      banner: STATUS_ACTION_FAILED_BANNER,
    });
  });
});
