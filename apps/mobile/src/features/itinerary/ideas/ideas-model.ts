/**
 * Ideas-bucket model (T-7.6 / IT-5 — itinerary spec §2.3, R-itin-10..12).
 * Pure projection: `{bookings, items}` → the grouped card rows the bucket
 * renders. Bucket membership is the API's R-ib-10 rule computed client-side
 * from data both screens already hold: a booking is UNSCHEDULED iff it has
 * zero itinerary items (the default booking list already excludes
 * `cancelled`; those arrive via the separate R-itin-12 list).
 */
import {
  BOOKING_CATEGORIES,
  bookingPrimaryTimes,
  centsToMoneyText,
  SCHEDULABLE_BOOKING_STATUSES,
  ScheduleBookingInputSchema,
  wallDate,
  wallTime,
  type Booking,
  type BookingCategory,
  type BookingStatus,
  type ISODate,
  type ISOTime,
  type ItineraryItem,
  type SchedulableBookingStatus,
  type ScheduleBookingInput,
} from "@gogo/shared";

/** Group headers, in the shared category-tuple order (stable, spec-neutral). */
export const CATEGORY_GROUP_LABELS: Readonly<Record<BookingCategory, string>> = {
  lodging: "Lodging",
  flight: "Flights",
  train: "Trains",
  car_rental: "Car rentals",
  moped_rental: "Moped rentals",
  activity: "Activities",
  restaurant: "Restaurants",
  other: "Other",
};

export interface IdeaCard {
  booking: Booking;
  /**
   * R-itin-12: a `planned`/`booked` booking that is timeless (in the bucket)
   * is flagged "needs a day" — visually distinct from `idea` cards.
   */
  needsDay: boolean;
}

export interface IdeasGroup {
  category: BookingCategory;
  cards: IdeaCard[];
}

/**
 * R-ib-10 computed client-side: exactly the bookings with zero
 * `itinerary_items` rows. `items` is the composite read's full item list —
 * every scheduled booking has at least one row there by I-2/I-3.
 */
export function unscheduledBookings(
  bookings: readonly Booking[],
  items: readonly ItineraryItem[],
): Booking[] {
  const scheduled = new Set<string>();
  for (const item of items) {
    if (item.booking_id !== null) scheduled.add(item.booking_id);
  }
  return bookings.filter((booking) => !scheduled.has(booking.id));
}

/**
 * §2.3 grouping: cards grouped by category (shared tuple order; empty
 * groups dropped), ordered `updated_at DESC` within a group (R-itin-10).
 */
export function buildIdeasGroups(unscheduled: readonly Booking[]): IdeasGroup[] {
  const byCategory = new Map<BookingCategory, IdeaCard[]>();
  for (const booking of unscheduled) {
    const card: IdeaCard = { booking, needsDay: booking.status !== "idea" };
    const bucket = byCategory.get(booking.category);
    if (bucket === undefined) byCategory.set(booking.category, [card]);
    else bucket.push(card);
  }
  const groups: IdeasGroup[] = [];
  for (const category of BOOKING_CATEGORIES) {
    const cards = byCategory.get(category);
    if (cards === undefined) continue;
    cards.sort((a, b) =>
      a.booking.updated_at === b.booking.updated_at
        ? a.booking.id < b.booking.id
          ? -1
          : 1
        : a.booking.updated_at < b.booking.updated_at
          ? 1
          : -1,
    );
    groups.push({ category, cards });
  }
  return groups;
}

/**
 * "$ if known" caption (§2.3) — Law #2: the shared ISO-4217 minor-unit
 * formatter (T-9.1 R1 swap — this was the last 2dp-blind money renderer,
 * and it float-divided). 2-decimal currencies render byte-identical to the
 * pre-swap output ("USD 1234.56", fixed digits); zero-decimal currencies
 * now render whole ("JPY 1500" — was "15.00", 100× off). Also the booking
 * detail screen's price line.
 */
export function formatIdeaPrice(priceCents: number, currency: string): string {
  return `${currency} ${centsToMoneyText(priceCents, currency)}`;
}

/** The flat row list a bin's FlatList renders (groups flattened). */
export type IdeasRow =
  | { type: "group"; key: string; label: string }
  | { type: "card"; key: string; card: IdeaCard; cancelled: boolean };

/**
 * B-13: the Ideas BIN's rows — unscheduled groups only. Cancelled bookings
 * moved out to their own peer bin (`buildCancelledRows`); the pre-B-13
 * shape appended them here behind a foot toggle, which made showing
 * cancelled surface the Ideas box with zero ideas in it.
 */
export function buildIdeasRows(groups: readonly IdeasGroup[]): IdeasRow[] {
  const rows: IdeasRow[] = [];
  for (const group of groups) {
    rows.push({
      type: "group",
      key: `group-${group.category}`,
      label: CATEGORY_GROUP_LABELS[group.category],
    });
    for (const card of group.cards) {
      rows.push({ type: "card", key: card.booking.id, card, cancelled: false });
    }
  }
  return rows;
}

/**
 * B-13: the Cancelled BIN's rows — flat cancelled cards, no group label
 * (the bin's own header already says "Cancelled"). Same row vocabulary as
 * the Ideas bin: the two bins are peers of the same shape.
 */
export function buildCancelledRows(cancelled: readonly Booking[]): IdeasRow[] {
  return cancelled.map((booking) => ({
    type: "card",
    key: booking.id,
    card: { booking, needsDay: false },
    cancelled: true,
  }));
}

/** The ScheduleSheet's initial picker values — `""` = the field starts unset. */
export interface SchedulePrefill {
  day: ISODate | "";
  startTime: ISOTime | "";
  endTime: ISOTime | "";
}

/**
 * B-16 (device QA 2026-09-06): an idea that already carries date/times must
 * open the Add-to-day sheet with them as the pickers' VALUES — not just the
 * B-10b picker seeds — so the user isn't forced to re-enter what the card
 * already knows. Wall components are sliced from the details' LOCAL strings
 * (shared `wallDate`/`wallTime`, §3.3 — no tz math), the same derivation
 * I-2 uses, so the sheet shows where the card would actually land.
 *
 * Shape rules:
 *  - nothing carried ⇒ all empty (the pre-B-16 behavior, kept as-is);
 *  - the day anchors on the primary START, falling back to the end when only
 *    the end is known (each side is independent — R-ib-4 posture);
 *  - an end on a DIFFERENT wall-date is dropped: the sheet's single-day
 *    `end_time` can't carry it, and prefilling it would render an overnight
 *    span as inverted times. A same-wall-date inversion (the date-line
 *    class) prefills as carried — the form's existing inversion rule, not
 *    this projection, is what governs submittability.
 */
export function schedulePrefill(booking: Booking): SchedulePrefill {
  const { start, end } = bookingPrimaryTimes(booking.details);
  const anchor = start ?? end;
  if (anchor === null) return { day: "", startTime: "", endTime: "" };
  const day = wallDate(anchor);
  return {
    day,
    startTime: start !== null ? wallTime(start) : "",
    endTime: end !== null && wallDate(end) === day ? wallTime(end) : "",
  };
}

// ---------------------------------------------------------------------------
// T-7.15 — Planned / Booked status actions (R-itin-11/40/41; API R-ib-8)
// ---------------------------------------------------------------------------

/** R-itin-11/40: the two bucket actions — the statuses a schedule call may land. */
export type StatusActionTarget = SchedulableBookingStatus;

/** Card/sheet copy per action. */
export const STATUS_ACTION_LABELS: Readonly<Record<StatusActionTarget, string>> = {
  planned: "Planned",
  booked: "Booked",
};

/** A tapped action: the card and the status it was tapped for. */
export interface StatusAction {
  booking: Booking;
  target: StatusActionTarget;
}

const STATUS_RANK: Readonly<Record<StatusActionTarget | "idea", number>> = {
  idea: 0,
  planned: 1,
  booked: 2,
};

/**
 * Whether a bucket card in `status` offers the action `target`.
 *
 * [NEEDS CLARIFICATION: T-7.15 bucket-card demotion] R-itin-11 puts
 * Planned/Booked on EVERY bucket card and R-itin-12 puts timeless
 * `planned`/`booked` bookings in that bucket — read literally, a user could
 * tap "Planned" on a timeless BOOKED card and the server (R-ib-8: `booked →
 * planned` is a legal demotion) would silently demote a purchased booking
 * while scheduling it. Pending Sean's ruling this build is CONSERVATIVE: the
 * bucket never demotes. An action is offered only when its target is at or
 * above the card's status — `idea` ⇒ both, `planned` ⇒ both (Planned = "give
 * it a day, stay planned"; Booked advances), `booked` ⇒ Booked only (give it
 * a day, stay booked); `cancelled` is terminal (§3.2) ⇒ none.
 *
 * The ruling is a ONE-LINE flip: the `>=` comparison below is the single
 * home of the policy — `buildStatusActionRequest` consults this function
 * too, so the UI and the request builder can never disagree.
 */
export function isStatusActionOffered(status: BookingStatus, target: StatusActionTarget): boolean {
  if (status === "cancelled") return false;
  return STATUS_RANK[target] >= STATUS_RANK[status];
}

/** The actions a card renders, in display order (Planned, Booked). */
export function offeredStatusActions(status: BookingStatus): StatusActionTarget[] {
  return SCHEDULABLE_BOOKING_STATUSES.filter((target) => isStatusActionOffered(status, target));
}

/**
 * R-itin-41 routing. The schedule endpoint REJECTS any booking with known
 * times (R-ib-8: `starts_at !== null` ⇒ 400 VALIDATION_FAILED — its calendar
 * presence is automatic, R-ib-5; the B-16 dead end), so those route through a
 * status-only PATCH and the booking service's I-2 auto-item supplies the
 * calendar row. The discriminator is exactly the server's: the denormalized
 * `starts_at`, NOT `schedulePrefill`'s start-or-end anchor (an end-only
 * booking is timeless to the server and schedules normally).
 */
export type StatusActionRoute = "status" | "schedule";

export function statusActionRoute(booking: Booking): StatusActionRoute {
  return booking.starts_at !== null ? "status" : "schedule";
}

/** The Sheet's editable day/time state (`""` = unset). */
export interface ScheduleFormValues {
  day: string;
  startTime: string;
  endTime: string;
}

/** Inline errors the schedule route's form can show (R-itin-41). */
export interface ScheduleFormErrors {
  day?: string;
  endTime?: string;
}

export const DAY_REQUIRED_ERROR = "Choose a day.";
export const END_BEFORE_START_ERROR = "End time can't be before the start time.";

/**
 * R-itin-41 inline validation: a day is required (times optional); an end
 * time may not precede its start. END == START IS VALID — the wire schema's
 * rule is a strict `end < start` rejection (R-ib-17), mirrored here.
 */
export function validateScheduleForm(form: ScheduleFormValues): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  if (form.day === "") errors.day = DAY_REQUIRED_ERROR;
  if (form.startTime !== "" && form.endTime !== "" && form.endTime < form.startTime) {
    errors.endTime = END_BEFORE_START_ERROR;
  }
  return errors;
}

/** What the Sheet sends on confirm — one arm per route. */
export type StatusActionRequest =
  | { route: "status"; input: { status: StatusActionTarget } }
  | { route: "schedule"; input: ScheduleBookingInput };

/**
 * The confirm decision. `null` ⇒ nothing may be sent: the action isn't one
 * the card offers (cancelled; a demotion — see `isStatusActionOffered`) or,
 * on the schedule route, the form is invalid.
 *
 *  - known times ⇒ status-only PATCH `{ status }` (the form is irrelevant:
 *    day/times are read-only, R-itin-41);
 *  - timeless ⇒ the schedule endpoint with `day`, the optional times, and the
 *    tapped `status` — OMITTED when the tap is a same-status one (a timeless
 *    `booked` card tapping "Booked"), so the server's pre-change path runs
 *    ("omitted ⇒ planned/booked unchanged", R-ib-8) instead of re-asserting
 *    a status the booking already holds.
 */
export function buildStatusActionRequest(
  booking: Booking,
  target: StatusActionTarget,
  form: ScheduleFormValues,
): StatusActionRequest | null {
  if (!isStatusActionOffered(booking.status, target)) return null;
  if (statusActionRoute(booking) === "status") {
    return { route: "status", input: { status: target } };
  }
  if (Object.keys(validateScheduleForm(form)).length > 0) return null;
  const candidate: ScheduleBookingInput = {
    day: form.day,
    ...(form.startTime === "" ? {} : { start_time: form.startTime }),
    ...(form.endTime === "" ? {} : { end_time: form.endTime }),
    ...(target === booking.status ? {} : { status: target }),
  };
  // Client mirror of the wire schema (trip-new precedent): the schema stays
  // the single source of truth for what is sendable.
  const parsed = ScheduleBookingInputSchema.safeParse(candidate);
  return parsed.success ? { route: "schedule", input: parsed.data } : null;
}

/** One read-only line of a known-times booking's carried date/time (R-itin-41). */
export interface KnownTimesLine {
  label: "Starts" | "Ends";
  day: ISODate;
  time: ISOTime;
}

/**
 * The known-times Sheet renders the booking's own primary times read-only —
 * wall components of the details' LOCAL strings (§3.3, no tz math), start and
 * end each on their own wall-date (a lodging check-out is days after its
 * check-in, which `schedulePrefill`'s single-day shape cannot show).
 */
export function knownTimesSummary(booking: Booking): KnownTimesLine[] {
  const { start, end } = bookingPrimaryTimes(booking.details);
  const lines: KnownTimesLine[] = [];
  if (start !== null) lines.push({ label: "Starts", day: wallDate(start), time: wallTime(start) });
  if (end !== null) lines.push({ label: "Ends", day: wallDate(end), time: wallTime(end) });
  return lines;
}

/** Sheet-level failure copy when the server's refusal maps to no field. */
export const STATUS_ACTION_FAILED_BANNER = "Couldn't update it — the bucket is unchanged.";

/** A refused status action, split into per-field reasons + a residual banner. */
export interface StatusActionFailure {
  fieldErrors: { day?: string; startTime?: string; endTime?: string; status?: string };
  /** `null` ⇒ every reason landed on a field (the fields carry the text). */
  banner: string | null;
}

const WIRE_FIELD_TO_FORM_FIELD: Readonly<
  Record<string, keyof StatusActionFailure["fieldErrors"] | undefined>
> = {
  day: "day",
  start_time: "startTime",
  end_time: "endTime",
  status: "status",
};

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
    }
  }
  return null;
}

/**
 * Map a rejected status action onto the Sheet. `VALIDATION_FAILED` carries
 * `details` in one of two real shapes (apps/server): the wire-schema failure
 * `z.flattenError` — `{ formErrors, fieldErrors: { status: ["…"] } }` — and
 * the service-level rules' flat `{ status: "illegal transition" }`
 * (`assertStatusTransition`, R-ib-8). A reason on a field the Sheet renders
 * (`day`/`start_time`/`end_time`/`status`) lands on THAT field; anything else
 * (and every non-validation failure — transport, 409, 403) is the generic
 * banner. Structural on purpose: the model stays platform-free, so no
 * `ApiRequestError` import.
 */
export function statusActionFailure(error: unknown): StatusActionFailure {
  const generic: StatusActionFailure = { fieldErrors: {}, banner: STATUS_ACTION_FAILED_BANNER };
  if (typeof error !== "object" || error === null) return generic;
  const { code, details, message } = error as {
    code?: unknown;
    details?: unknown;
    message?: unknown;
  };
  if (code !== "VALIDATION_FAILED") return generic;
  if (typeof details !== "object" || details === null) return generic;

  const fieldErrors: StatusActionFailure["fieldErrors"] = {};
  let unmapped = false;
  const record = (wireKey: string, text: string | null): void => {
    if (text === null) return;
    const slot = WIRE_FIELD_TO_FORM_FIELD[wireKey];
    if (slot === undefined) {
      unmapped = true;
      return;
    }
    if (fieldErrors[slot] === undefined) fieldErrors[slot] = text;
  };

  const flattened = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof flattened === "object" && flattened !== null) {
    for (const [key, value] of Object.entries(flattened)) record(key, firstString(value));
    if (firstString((details as { formErrors?: unknown }).formErrors) !== null) unmapped = true;
  } else {
    // Service-level shape: `{ <wire key>: "<reason>" }`. For the status rule
    // the readable sentence is the envelope `message` ("illegal status
    // transition 'booked' → 'planned'"), not the terse `details` tag.
    for (const [key, value] of Object.entries(details)) {
      const reason = firstString(value);
      record(key, key === "status" && reason !== null ? (firstString(message) ?? reason) : reason);
    }
  }

  if (Object.keys(fieldErrors).length === 0) return generic;
  return { fieldErrors, banner: unmapped ? STATUS_ACTION_FAILED_BANNER : null };
}
