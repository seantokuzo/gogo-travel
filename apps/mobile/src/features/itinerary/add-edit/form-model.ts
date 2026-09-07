/**
 * Add/edit form model (T-7.6 / IT-7 — itinerary spec §2.4, R-itin-18/19).
 * Pure: per-category field configs mirroring the `BookingDetails` shapes
 * (§3.4.1 via @gogo/shared — the wire schema stays the single source of
 * truth; this module only decides which fields the form SHOWS, per the
 * §2.4 table), the state ⇄ wire converters, Law #2 money parsing, and the
 * form-field → DeeplinkPanel input mapping.
 *
 * Datetime posture (B-9 client half — THE B-8 fix): detail times are
 * ISO-8601 with an offset representing DESTINATION wall time (§3.3). A
 * datetime field whose category carries an IANA `*_tz` sibling on the wire
 * (flight/train `departs_tz`/`arrives_tz` — the `tzKey` below) composes the
 * entered wall date+time IN THAT ZONE via `composeZonedDateTime`
 * (DST-aware, resolved per endpoint — never one uniform per-booking
 * offset), and writes the zone id beside it. The zone arrives from the
 * endpoint's airport pick (`tzFrom`) or from the always-visible zone
 * picker.
 *
 * Categories WITHOUT `*_tz` on the wire (lodging, car/moped rental,
 * activity, restaurant, other) stay on the legacy `composeLocalDateTime`
 * `Z` path — deliberately OUT OF SCOPE for B-9 (proposed shape in the PR
 * body). Their instants stay approximate; wall slicing (shared
 * `wallDate`/`wallTime`) keeps calendar placement exact either way.
 *
 * `raw` (edit mode): the stored wire string a form value was decomposed
 * from. An UNTOUCHED datetime re-emits it byte-for-byte, so a title-only
 * edit can never re-stamp, re-round or re-zone a time the user never
 * opened (the B-20 R1 dirty-gate principle applied to times). Every
 * date/time/zone edit drops `raw`, so a touched field always recomposes.
 *
 * A field with only one half set is a validation error, never a silent drop.
 */
import {
  ACTIVITY_PROVIDERS,
  centsToMoneyText as sharedCentsToMoneyText,
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

import { composeZonedDateTime } from "./zoned-time";

// ---------------------------------------------------------------------------
// Field configs (§2.4 table — exactly its fields, nothing more)
// ---------------------------------------------------------------------------

export interface DateTimeValue {
  /** `YYYY-MM-DD` or `""`. */
  date: string;
  /** `HH:MM` or `""`. */
  time: string;
  /**
   * B-9: the IANA zone these wall values are read in. Only meaningful for a
   * field whose config declares a `tzKey`. `""` = NOT KNOWN — a stored row
   * that predates zone capture; the picker says so rather than inventing a
   * zone, and the value is only demanded once the user edits the time.
   */
  tz?: string;
  /**
   * B-9 edit provenance: the stored wire string this value was decomposed
   * from. Present ⇒ the field is UNTOUCHED ⇒ `buildDetails` re-emits it
   * verbatim. Every user edit of date/time/zone drops it (module doc).
   */
  raw?: string;
}

export type FieldValue = string | DateTimeValue;
export type DetailsFormState = Record<string, FieldValue>;

export type BookingFieldConfig =
  | {
      key: string;
      label: string;
      kind: "text";
      multiline?: boolean;
      /**
       * B-20: short uppercase code-like values (flight/train numbers, seats,
       * coaches — "ua837" is always meant as "UA837"). Auto-uppercased
       * as-you-type, autocorrect off. Presentation only — buildDetails does
       * NOT validate these (formats vary by carrier).
       */
      designator?: boolean;
      /**
       * B-9: this designator is a FLIGHT number — the form offers the
       * airline the shared parser + `/airlines/flight-lookup` resolve from
       * it. Presentation only; the stored value is untouched.
       */
      inferAirline?: boolean;
    }
  | { key: string; label: string; kind: "int" }
  | { key: string; label: string; kind: "url" }
  /**
   * B-20: IATA airport code — exactly 3 letters, auto-uppercased. Save-time
   * validation lives in buildDetails (client-side ONLY: the SHARED schema
   * stays max(200) — B-9 does NOT narrow it, Q2 is still Sean's ruling —
   * because the details schemas serve both directions and narrowing would
   * brick READS of already-stored non-code text).
   *
   * B-9: rendered as the AIRPORT TYPEAHEAD. A pick commits the code AND
   * hands its IANA zone to the datetime field that names this key in
   * `tzFrom`, which is what makes a correct instant composable at all.
   */
  | { key: string; label: string; kind: "iata" }
  /**
   * B-9: `tzKey` names the wire's IANA sibling for this time
   * (`departs_at` → `departs_tz`). Its presence is what switches the field
   * onto the zoned composition and gives it a visible zone picker.
   * `tzFrom` names the IATA field whose airport pick supplies that zone
   * automatically (flights); a field without one (trains — no station
   * reference table exists) relies on the picker alone.
   */
  | { key: string; label: string; kind: "datetime"; tzKey?: string; tzFrom?: string }
  /** B-9: airline typeahead (`/airlines/search`) — stores the airline NAME. */
  | { key: string; label: string; kind: "airline" }
  | { key: string; label: string; kind: "enum"; options: readonly string[] };

export const CATEGORY_FIELDS: Readonly<Record<BookingCategory, readonly BookingFieldConfig[]>> = {
  flight: [
    { key: "airline", label: "Airline", kind: "airline" },
    {
      key: "flight_number",
      label: "Flight number",
      kind: "text",
      designator: true,
      inferAirline: true,
    },
    { key: "origin_iata", label: "From (IATA)", kind: "iata" },
    { key: "destination_iata", label: "To (IATA)", kind: "iata" },
    {
      key: "departs_at",
      label: "Departs",
      kind: "datetime",
      tzKey: "departs_tz",
      tzFrom: "origin_iata",
    },
    {
      key: "arrives_at",
      label: "Arrives",
      kind: "datetime",
      tzKey: "arrives_tz",
      tzFrom: "destination_iata",
    },
    { key: "cabin_class", label: "Cabin class", kind: "text" },
    { key: "seat", label: "Seat", kind: "text", designator: true },
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
    { key: "train_number", label: "Train number", kind: "text", designator: true },
    { key: "origin_station", label: "From station", kind: "text" },
    { key: "destination_station", label: "To station", kind: "text" },
    // No station reference table exists (B-9 scope) — trains carry the same
    // wire `*_tz` fields as flights but reach them through the zone picker
    // alone, with no `tzFrom` airport rung.
    { key: "departs_at", label: "Departs", kind: "datetime", tzKey: "departs_tz" },
    { key: "arrives_at", label: "Arrives", kind: "datetime", tzKey: "arrives_tz" },
    { key: "coach", label: "Coach", kind: "text", designator: true },
    { key: "seat", label: "Seat", kind: "text", designator: true },
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

// ---------------------------------------------------------------------------
// Per-field input traits (B-20 — input UX + validation sweep)
// ---------------------------------------------------------------------------

/**
 * RN TextInput behavior for a `CATEGORY_FIELDS` entry, derived in ONE place
 * so every rendered field gets the same treatment. Length caps mirror the
 * SHARED wire caps (booking.ts: `optionalString` 200 / `optionalNotes` 2000 /
 * `optionalUrl` 2048; `INT_RE` allows 9 digits) — a cap here prevents typing
 * past a limit the save would reject with an opaque generic error, and is
 * never tighter than the wire.
 */
export interface FieldInputTraits {
  keyboardType: "default" | "number-pad" | "url";
  autoCapitalize?: "none" | "characters";
  autoCorrect?: boolean;
  maxLength: number;
  /** As-you-type normalization — uppercase for code-like fields, else identity. */
  transform(text: string): string;
}

const identity = (text: string): string => text;
const upper = (text: string): string => text.toUpperCase();

export function fieldInputTraits(field: BookingFieldConfig): FieldInputTraits {
  switch (field.kind) {
    // B-9 R1: `maxLength` is the WIRE cap (optionalString 200), not 3. The
    // 3-letter rule is a SAVE gate (`IATA_RE` in buildDetails), never a
    // typing cap — capping input at 3 is what made "Narita International"
    // untypeable pre-B-9. `AirportPickerField` is the real renderer and
    // hardcodes the same 200; these traits stay the one derivation for any
    // future consumer that routes an `iata` field through a plain `Input`.
    case "iata":
      return {
        keyboardType: "default",
        autoCapitalize: "characters",
        autoCorrect: false,
        maxLength: 200,
        transform: upper,
      };
    case "int":
      return { keyboardType: "number-pad", maxLength: 9, transform: identity };
    case "url":
      // iOS applies sentence-casing regardless of the URL keyboard — a
      // capitalized/auto-"corrected" URL is a broken URL.
      return {
        keyboardType: "url",
        autoCapitalize: "none",
        autoCorrect: false,
        maxLength: 2048,
        transform: identity,
      };
    case "text":
      if (field.designator === true) {
        return {
          keyboardType: "default",
          autoCapitalize: "characters",
          autoCorrect: false,
          // UX bound only (designators are short); the wire cap stays 200.
          maxLength: 20,
          transform: upper,
        };
      }
      return {
        keyboardType: "default",
        maxLength: field.multiline === true ? 2000 : 200,
        transform: identity,
      };
    // B-9: the airline typeahead's own query input. Wire cap 200 (the
    // stored value is the airline NAME); autocorrect fights carrier names
    // ("Finnair" → "Fin air") exactly as it fights place names.
    case "airline":
      return {
        keyboardType: "default",
        autoCorrect: false,
        maxLength: 200,
        transform: identity,
      };
    // Not rendered through Input — traits exist so the switch is total.
    case "datetime":
    case "enum":
      return { keyboardType: "default", maxLength: 200, transform: identity };
  }
}

/**
 * B-9: the datetime fields of a category that carry an IANA zone on the
 * wire. ONE derivation so the form, the model and the tests can never
 * disagree about which times are zoned.
 */
export function zonedDateTimeFields(
  category: BookingCategory,
): readonly { key: string; label: string; tzKey: string; tzFrom?: string }[] {
  const out: { key: string; label: string; tzKey: string; tzFrom?: string }[] = [];
  for (const field of CATEGORY_FIELDS[category]) {
    if (field.kind !== "datetime" || field.tzKey === undefined) continue;
    out.push({
      key: field.key,
      label: field.label,
      tzKey: field.tzKey,
      ...(field.tzFrom !== undefined ? { tzFrom: field.tzFrom } : {}),
    });
  }
  return out;
}

/**
 * B-9 R1: the comparable form of an IATA field's text. The picker already
 * uppercases as you type, but a stored prefill can be lowercase and a paste
 * can carry whitespace — provenance must compare the VALUE, not the typing.
 */
export function iataKeyText(value: FieldValue | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * B-9 R1 (correctness lane, blocking): which IATA text each zoned datetime's
 * CURRENT zone is attributable to.
 *
 * An airport pick is the only thing that pushes a real IANA zone into a
 * paired datetime, but nothing used to invalidate that zone when the same
 * IATA field was later retyped or cleared — so "pick NRT, clear it, type
 * LAX" wired `+09:00` under a Los Angeles origin, and an EDIT that retyped
 * the code re-emitted the stored Tokyo instant verbatim. Both are B-8
 * through the front door.
 *
 * So each zoned field remembers the code its zone came with, seeded here:
 * on a NEW form that is `""` (the ladder zone belongs to no airport), and on
 * an EDIT it is the stored code the stored `*_tz` was saved beside. The form
 * clears the zone the moment the field's text walks away from it, and save
 * then fails loud with `TZ_MISSING_ERROR` rather than stamping a zone the
 * endpoint no longer justifies.
 */
export function zoneSourceFromState(
  category: BookingCategory,
  state: DetailsFormState,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zoned of zonedDateTimeFields(category)) {
    if (zoned.tzFrom === undefined) continue;
    out[zoned.key] = iataKeyText(state[zoned.tzFrom]);
  }
  return out;
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
  prefill?: {
    day?: ISODate;
    time?: ISOTime;
    /**
     * B-9: the zone a NEW zoned time is stamped in until the user picks an
     * airport or another zone — the ladder's default rung (last zone this
     * trip's forms submitted, else the device zone). Absent ⇒ `""`, which
     * `buildDetails` rejects rather than silently Z-stamping.
     */
    tz?: string;
  },
): DetailsFormState {
  const state: DetailsFormState = {};
  for (const field of CATEGORY_FIELDS[category]) {
    if (field.kind !== "datetime") {
      state[field.key] = "";
      continue;
    }
    state[field.key] =
      field.tzKey !== undefined
        ? { date: "", time: "", tz: prefill?.tz ?? "" }
        : { date: "", time: "" };
  }
  // Grid gap-tap (R-itin-14): BOTH day and time present ⇒ the category's
  // primary start is prefilled to the tapped slot (saving auto-schedules,
  // I-2). A day WITHOUT a time (empty-day add row) is NOT written into
  // details — it stays the create→schedule fallback target (R-itin-19).
  if (prefill?.day !== undefined && prefill.time !== undefined) {
    const key = primaryStartKey(category);
    const seeded = state[key];
    state[key] = {
      ...(typeof seeded === "object" ? seeded : {}),
      date: prefill.day,
      time: prefill.time,
    };
  }
  return state;
}

/**
 * Edit-mode prefill: decompose the stored details into form state.
 *
 * B-9: a datetime keeps the stored string as `raw` (untouched ⇒ re-emitted
 * verbatim, never re-composed) and, for a zoned field, the stored `*_tz` —
 * or `""` when the row predates zone capture. Wall slicing is exact (§3.3),
 * so display never re-offsets whatever the offset was.
 */
export function stateFromDetails(details: BookingDetails): DetailsFormState {
  const state = emptyFormState(details.category);
  const record = details as unknown as Record<string, unknown>;
  for (const field of CATEGORY_FIELDS[details.category]) {
    const value = record[field.key];
    if (field.kind === "datetime" && typeof value === "string") {
      const stored = field.tzKey !== undefined ? record[field.tzKey] : undefined;
      state[field.key] = {
        date: wallDate(value),
        time: wallTime(value),
        raw: value,
        ...(field.tzKey !== undefined
          ? { tz: typeof stored === "string" ? stored : "" }
          : {}),
      };
      continue;
    }
    if (value === undefined || value === null) continue;
    if (field.kind === "int" && typeof value === "number") {
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

/**
 * Wall date+time → the ZONELESS local-ISO composition (`Z` offset). Still
 * the path for the categories the wire gives no `*_tz` field (module doc);
 * a zoned field NEVER lands here — `buildDetails` errors instead, so there
 * is no route back to B-8's silent Z-stamping.
 */
export function composeLocalDateTime(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

/** Field-level messages for the zoned composition (one home — form + tests). */
export const TZ_MISSING_ERROR = "Pick the time zone for this time.";
export const TZ_UNKNOWN_ERROR = "That time zone isn't available on this device.";

const INT_RE = /^\d{1,9}$/;
const IATA_RE = /^[A-Z]{3}$/;

/**
 * Form state → the category's `BookingDetails` member. Empty fields are
 * OMITTED (every detail field is optional by design); int fields must be
 * whole numbers; IATA fields must be exactly 3 letters (normalized
 * uppercase, so an edit-mode prefill of stored lowercase self-heals rather
 * than erroring — B-20); datetime fields need BOTH halves or NEITHER.
 *
 * `prefill` (edit mode: the initial state decomposed from the stored row)
 * scopes the IATA gate to DIRTY values only — see the iata branch.
 */
export function buildDetails(
  category: BookingCategory,
  state: DetailsFormState,
  prefill?: DetailsFormState,
): BuildDetailsResult {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = { category };

  for (const field of CATEGORY_FIELDS[category]) {
    const value = state[field.key];
    if (field.kind === "datetime") {
      const dt = (value as DateTimeValue | undefined) ?? { date: "", time: "" };
      if (dt.date === "" && dt.time === "") continue;
      if (dt.date === "" || dt.time === "") {
        errors[field.key] = "Set both date and time, or clear both.";
        continue;
      }
      // B-9: an UNTOUCHED stored value re-emits byte-for-byte — offset,
      // seconds and zone exactly as they were saved. A title-only edit
      // cannot re-stamp a time the user never opened.
      if (dt.raw !== undefined) {
        out[field.key] = dt.raw;
        if (field.tzKey !== undefined && dt.tz !== undefined && dt.tz !== "") {
          out[field.tzKey] = dt.tz;
        }
        continue;
      }
      if (field.tzKey === undefined) {
        // No `*_tz` on the wire for this category — the legacy path.
        out[field.key] = composeLocalDateTime(dt.date, dt.time);
        continue;
      }
      const tz = dt.tz ?? "";
      if (tz === "") {
        errors[field.key] = TZ_MISSING_ERROR;
        continue;
      }
      const composed = composeZonedDateTime(dt.date, dt.time, tz);
      if (composed === null) {
        errors[field.key] = TZ_UNKNOWN_ERROR;
        continue;
      }
      out[field.key] = composed;
      out[field.tzKey] = tz;
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
    if (field.kind === "iata") {
      const code = text.toUpperCase();
      if (IATA_RE.test(code)) {
        // Real 3-letter codes always normalize — a stored lowercase "nrt"
        // self-heals to "NRT" on its next save (B-20).
        out[field.key] = code;
        continue;
      }
      // B-20 R1 (correctness lane): the gate guards what the USER typed,
      // not what the row already stored. Values like "Narita" are
      // wire-legal (optionalString 200, deliberately un-narrowed — Q2) and
      // reachable pre-B-20 or via AI capture — an UNTOUCHED prefill passes
      // through VERBATIM (no case mutation of text the user never typed)
      // so a title-only edit can't strand the booking. Only dirty values
      // (normalized ≠ normalized prefill) hit the error.
      const prefillValue = prefill?.[field.key];
      const prefillText = typeof prefillValue === "string" ? prefillValue.trim() : "";
      if (prefillText !== "" && prefillText.toUpperCase() === code) {
        out[field.key] = text;
        continue;
      }
      errors[field.key] = "3-letter airport code, like NRT.";
      continue;
    }
    out[field.key] = text;
  }

  if (Object.keys(errors).length > 0) return { details: null, errors };
  return { details: out as BookingDetails, errors };
}

// ---------------------------------------------------------------------------
// Money (Law #2 — integer cents, never float). T-9.1 rider: the shared
// ISO-4217 minor-unit helpers replace the old local 2dp-only parser — the
// currency the user picked now decides the accepted decimal shape
// (R-cmoney-8; JPY "1500" → 1500 minor units, USD "89.99" → 8999).
// ---------------------------------------------------------------------------

export { parseMoneyToCents, type MoneyParse } from "@gogo/shared";

/**
 * Form prefill text: the shared formatter with an all-zero minor part
 * omitted ("120", never "120.00") — the pre-rider display behavior for
 * 2-decimal currencies, pinned by tests; zero-decimal currencies render
 * whole ("1500"). Rail links (CMON-5) use the shared default (fixed minor
 * digits) instead — do not reuse this for §2.5 URL amounts.
 */
export function centsToMoneyText(cents: number, currency: string): string {
  return sharedCentsToMoneyText(cents, currency, { omitZeroMinor: true });
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

/**
 * A datetime as a partner-URL parameter. B-9: prefers the stored string,
 * then the zoned composition, and only falls back to the `Z` shape when no
 * zone is known — a deeplink URL is ephemeral, so an approximate offset
 * here is a worse search result, never corrupted stored data.
 */
function isoOf(state: DetailsFormState, key: string): string | undefined {
  const value = state[key];
  if (typeof value !== "object" || value.date === "" || value.time === "") return undefined;
  if (value.raw !== undefined) return value.raw;
  if (value.tz !== undefined && value.tz !== "") {
    const composed = composeZonedDateTime(value.date, value.time, value.tz);
    if (composed !== null) return composed;
  }
  return composeLocalDateTime(value.date, value.time);
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
