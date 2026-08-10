/**
 * Add/edit form model (T-7.6 / IT-7 — itinerary spec §2.4, R-itin-18/19).
 * Pure: per-category field configs mirroring the `BookingDetails` shapes
 * (§3.4.1 via @gogo/shared — the wire schema stays the single source of
 * truth; this module only decides which fields the form SHOWS, per the
 * §2.4 table), the state ⇄ wire converters, Law #2 money parsing, and the
 * form-field → DeeplinkPanel input mapping.
 *
 * Datetime posture (spec-uncovered, flagged in the PR): detail times are
 * ISO-8601 with offset representing DESTINATION wall time (§3.3), but the
 * client has no destination tz database — v1 composes the entered wall
 * date+time with a `Z` offset. The server derives item day/times by
 * SLICING the wall components (shared `wallDate`/`wallTime`), so calendar
 * placement is exact; only the denormalized UTC instant is approximate
 * (trip-internal sort order, self-consistent). A field with only one half
 * set is a validation error, never a silent drop.
 */
import {
  ACTIVITY_PROVIDERS,
  LODGING_PROVIDERS,
  wallDate,
  wallTime,
  type BookingCategory,
  type BookingDetails,
  type BookingStatus,
  type ISODate,
  type ISOTime,
} from "@gogo/shared";

import type { DeeplinkSearchInput } from "@/features/deeplinks";

// ---------------------------------------------------------------------------
// Field configs (§2.4 table — exactly its fields, nothing more)
// ---------------------------------------------------------------------------

export interface DateTimeValue {
  /** `YYYY-MM-DD` or `""`. */
  date: string;
  /** `HH:MM` or `""`. */
  time: string;
}

export type FieldValue = string | DateTimeValue;
export type DetailsFormState = Record<string, FieldValue>;

export type BookingFieldConfig =
  | { key: string; label: string; kind: "text"; multiline?: boolean }
  | { key: string; label: string; kind: "int" }
  | { key: string; label: string; kind: "url" }
  | { key: string; label: string; kind: "datetime" }
  | { key: string; label: string; kind: "enum"; options: readonly string[] };

export const CATEGORY_FIELDS: Readonly<Record<BookingCategory, readonly BookingFieldConfig[]>> = {
  flight: [
    { key: "airline", label: "Airline", kind: "text" },
    { key: "flight_number", label: "Flight number", kind: "text" },
    { key: "origin_iata", label: "From (IATA)", kind: "text" },
    { key: "destination_iata", label: "To (IATA)", kind: "text" },
    { key: "departs_at", label: "Departs", kind: "datetime" },
    { key: "arrives_at", label: "Arrives", kind: "datetime" },
    { key: "cabin_class", label: "Cabin class", kind: "text" },
    { key: "seat", label: "Seat", kind: "text" },
  ],
  lodging: [
    { key: "property_name", label: "Property name", kind: "text" },
    { key: "address", label: "Address", kind: "text" },
    { key: "check_in", label: "Check-in", kind: "datetime" },
    { key: "check_out", label: "Check-out", kind: "datetime" },
    { key: "guests", label: "Guests", kind: "int" },
    { key: "room_type", label: "Room type", kind: "text" },
    { key: "provider", label: "Provider", kind: "enum", options: LODGING_PROVIDERS },
  ],
  train: [
    { key: "carrier", label: "Carrier", kind: "text" },
    { key: "train_number", label: "Train number", kind: "text" },
    { key: "origin_station", label: "From station", kind: "text" },
    { key: "destination_station", label: "To station", kind: "text" },
    { key: "departs_at", label: "Departs", kind: "datetime" },
    { key: "arrives_at", label: "Arrives", kind: "datetime" },
    { key: "coach", label: "Coach", kind: "text" },
    { key: "seat", label: "Seat", kind: "text" },
  ],
  car_rental: [
    { key: "company", label: "Company", kind: "text" },
    { key: "pickup_location", label: "Pickup location", kind: "text" },
    { key: "dropoff_location", label: "Dropoff location", kind: "text" },
    { key: "pickup_at", label: "Pickup", kind: "datetime" },
    { key: "dropoff_at", label: "Dropoff", kind: "datetime" },
    { key: "vehicle_class", label: "Vehicle class", kind: "text" },
  ],
  moped_rental: [
    { key: "company", label: "Company", kind: "text" },
    { key: "pickup_location", label: "Pickup location", kind: "text" },
    { key: "dropoff_location", label: "Dropoff location", kind: "text" },
    { key: "pickup_at", label: "Pickup", kind: "datetime" },
    { key: "dropoff_at", label: "Dropoff", kind: "datetime" },
    { key: "vehicle_description", label: "Vehicle", kind: "text" },
    { key: "helmet_count", label: "Helmets", kind: "int" },
  ],
  activity: [
    { key: "provider", label: "Provider", kind: "enum", options: ACTIVITY_PROVIDERS },
    { key: "venue_name", label: "Venue", kind: "text" },
    { key: "address", label: "Address", kind: "text" },
    { key: "starts_at", label: "Starts", kind: "datetime" },
    { key: "ends_at", label: "Ends", kind: "datetime" },
    { key: "ticket_count", label: "Tickets", kind: "int" },
    { key: "ticket_type", label: "Ticket type", kind: "text" },
    { key: "external_url", label: "Ticket / event URL", kind: "url" },
  ],
  restaurant: [
    { key: "address", label: "Address", kind: "text" },
    { key: "reserved_at", label: "Reserved at", kind: "datetime" },
    { key: "party_size", label: "Party size", kind: "int" },
    { key: "provider", label: "Booked via", kind: "text" },
  ],
  other: [
    { key: "description", label: "Description", kind: "text", multiline: true },
    { key: "starts_at", label: "Starts", kind: "datetime" },
    { key: "ends_at", label: "Ends", kind: "datetime" },
    { key: "external_url", label: "URL", kind: "url" },
  ],
};

/**
 * Kebab-case a `CATEGORY_FIELDS` key for the §2.9 testID grammar — ONE home so
 * the form inputs and the detail grid can never fork the id family
 * (`…-input-flight-number` / `booking-detail-field-flight-number`).
 */
export function kebab(key: string): string {
  return key.replaceAll("_", "-");
}

/** The category's primary-start detail key (§3.3 table) — gap-tap prefill target. */
export function primaryStartKey(category: BookingCategory): string {
  switch (category) {
    case "flight":
    case "train":
      return "departs_at";
    case "lodging":
      return "check_in";
    case "car_rental":
    case "moped_rental":
      return "pickup_at";
    case "restaurant":
      return "reserved_at";
    case "activity":
    case "other":
      return "starts_at";
  }
}

// ---------------------------------------------------------------------------
// State init / prefill
// ---------------------------------------------------------------------------

export function emptyFormState(
  category: BookingCategory,
  prefill?: { day?: ISODate; time?: ISOTime },
): DetailsFormState {
  const state: DetailsFormState = {};
  for (const field of CATEGORY_FIELDS[category]) {
    state[field.key] = field.kind === "datetime" ? { date: "", time: "" } : "";
  }
  // Grid gap-tap (R-itin-14): BOTH day and time present ⇒ the category's
  // primary start is prefilled to the tapped slot (saving auto-schedules,
  // I-2). A day WITHOUT a time (empty-day add row) is NOT written into
  // details — it stays the create→schedule fallback target (R-itin-19).
  if (prefill?.day !== undefined && prefill.time !== undefined) {
    state[primaryStartKey(category)] = { date: prefill.day, time: prefill.time };
  }
  return state;
}

/** Edit-mode prefill: decompose the stored details into form state. */
export function stateFromDetails(details: BookingDetails): DetailsFormState {
  const state = emptyFormState(details.category);
  const record = details as unknown as Record<string, unknown>;
  for (const field of CATEGORY_FIELDS[details.category]) {
    const value = record[field.key];
    if (value === undefined || value === null) continue;
    if (field.kind === "datetime" && typeof value === "string") {
      state[field.key] = { date: wallDate(value), time: wallTime(value) };
    } else if (field.kind === "int" && typeof value === "number") {
      state[field.key] = String(value);
    } else if (typeof value === "string") {
      state[field.key] = value;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// State → wire details
// ---------------------------------------------------------------------------

export interface BuildDetailsResult {
  details: BookingDetails | null;
  /** Field-keyed messages; non-empty ⇒ `details` is null. */
  errors: Record<string, string>;
}

/** Wall date+time → the v1 local-ISO composition (module doc: `Z` offset). */
export function composeLocalDateTime(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

const INT_RE = /^\d{1,9}$/;

/**
 * Form state → the category's `BookingDetails` member. Empty fields are
 * OMITTED (every detail field is optional by design); int fields must be
 * whole numbers; datetime fields need BOTH halves or NEITHER.
 */
export function buildDetails(
  category: BookingCategory,
  state: DetailsFormState,
): BuildDetailsResult {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = { category };

  for (const field of CATEGORY_FIELDS[category]) {
    const value = state[field.key];
    if (field.kind === "datetime") {
      const dt = (value as DateTimeValue | undefined) ?? { date: "", time: "" };
      if (dt.date !== "" && dt.time !== "") {
        out[field.key] = composeLocalDateTime(dt.date, dt.time);
      } else if (dt.date !== "" || dt.time !== "") {
        errors[field.key] = "Set both date and time, or clear both.";
      }
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") continue;
    if (field.kind === "int") {
      if (!INT_RE.test(text)) {
        errors[field.key] = "Whole numbers only.";
        continue;
      }
      out[field.key] = Number(text);
      continue;
    }
    out[field.key] = text;
  }

  if (Object.keys(errors).length > 0) return { details: null, errors };
  return { details: out as BookingDetails, errors };
}

// ---------------------------------------------------------------------------
// Money (Law #2 — integer cents, never float, never string-parsed floats)
// ---------------------------------------------------------------------------

const MONEY_RE = /^\s*(\d{1,10})(?:[.,](\d{1,2}))?\s*$/;

export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string };

/**
 * "1234.56" → 123456 by STRING math: integer and fraction parts are parsed
 * separately as integers — no float ever holds the amount. v1 assumes
 * two-minor-digit currencies (flagged in the PR).
 */
export function parseMoneyToCents(text: string): MoneyParse {
  const match = MONEY_RE.exec(text);
  if (match === null) {
    return { ok: false, error: "Use a plain amount like 120 or 89.99." };
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return { ok: true, cents: whole * 100 + fraction };
}

/** 123456 → "1234.56"; whole amounts stay whole ("120"). Integer math only. */
export function centsToMoneyText(cents: number): string {
  const major = Math.floor(cents / 100);
  const minor = cents % 100;
  return minor === 0 ? String(major) : `${major}.${String(minor).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Status machine (§3.2) — which statuses the form may offer
// ---------------------------------------------------------------------------

export const CREATE_STATUS_OPTIONS: readonly BookingStatus[] = ["idea", "planned", "booked"];

/**
 * Edit-mode options: the current status plus its legal §3.2 targets that
 * the form can express (`cancelled` is the detail screen's ConfirmDialog —
 * R-itin-26 — never a form segment). `booked → idea` is the deliberate
 * two-step friction; `cancelled` is terminal.
 */
export function statusOptionsFor(current: BookingStatus): readonly BookingStatus[] {
  switch (current) {
    case "idea":
    case "planned":
      return ["idea", "planned", "booked"];
    case "booked":
      return ["planned", "booked"];
    case "cancelled":
      return ["cancelled"];
  }
}

// ---------------------------------------------------------------------------
// Deeplink panel input (§2.7 — form fields drive the partner buttons)
// ---------------------------------------------------------------------------

function textOf(state: DetailsFormState, key: string): string | undefined {
  const value = state[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function dateOf(state: DetailsFormState, key: string): string | undefined {
  const value = state[key];
  return typeof value === "object" && value.date !== "" ? value.date : undefined;
}

function isoOf(state: DetailsFormState, key: string): string | undefined {
  const value = state[key];
  return typeof value === "object" && value.date !== "" && value.time !== ""
    ? composeLocalDateTime(value.date, value.time)
    : undefined;
}

/** Live mapping: current form state → the DeeplinkPanel's per-category fields. */
export function deeplinkInputFor(
  category: BookingCategory,
  state: DetailsFormState,
): DeeplinkSearchInput {
  switch (category) {
    case "flight":
      return {
        category,
        fields: {
          originIata: textOf(state, "origin_iata"),
          destinationIata: textOf(state, "destination_iata"),
          departDate: dateOf(state, "departs_at"),
          cabinClass: textOf(state, "cabin_class"),
        },
      };
    case "lodging":
      return {
        category,
        fields: {
          // §2.7: location = the place/address field (panel falls back to
          // the trip's destination_name).
          location: textOf(state, "address") ?? textOf(state, "property_name"),
          checkIn: dateOf(state, "check_in"),
          checkOut: dateOf(state, "check_out"),
        },
      };
    case "train":
      return {
        category,
        fields: {
          originStation: textOf(state, "origin_station"),
          destinationStation: textOf(state, "destination_station"),
          outwardDate: isoOf(state, "departs_at"),
        },
      };
    case "car_rental":
      return {
        category,
        fields: {
          pickupLocation: textOf(state, "pickup_location"),
          pickupDate: dateOf(state, "pickup_at"),
          dropoffDate: dateOf(state, "dropoff_at"),
        },
      };
    case "activity":
    case "other":
      return { category, fields: { externalUrl: textOf(state, "external_url") } };
    case "moped_rental":
    case "restaurant":
      return { category };
  }
}

// ---------------------------------------------------------------------------
// Add-option inventory (R-itin-18: 8 categories + place visit + custom)
// ---------------------------------------------------------------------------

export type AddOptionId = BookingCategory | "place_visit" | "custom";

/** §2.9 slugs are kebab-case (`car-rental`, `place-visit`). */
export function addOptionSlug(option: AddOptionId): string {
  return option.replaceAll("_", "-");
}

export const ADD_OPTION_LABELS: Readonly<Record<AddOptionId, string>> = {
  flight: "Flight",
  lodging: "Lodging",
  train: "Train",
  car_rental: "Car rental",
  moped_rental: "Moped rental",
  activity: "Activity",
  restaurant: "Restaurant",
  other: "Other booking",
  place_visit: "Place visit",
  custom: "Custom block",
};

export const ADD_OPTION_ORDER: readonly AddOptionId[] = [
  "lodging",
  "flight",
  "train",
  "car_rental",
  "moped_rental",
  "activity",
  "restaurant",
  "other",
  "place_visit",
  "custom",
];
