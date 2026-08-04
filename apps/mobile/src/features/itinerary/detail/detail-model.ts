/**
 * Booking / item detail model (T-7.9 / IT-9+IT-10 — itinerary spec
 * R-itin-24/26/27, API §3.2). Pure: everything the two detail screens need to
 * decide WHAT to show, with no React and no network, so the §3.2 status
 * machine and the per-category field grid are unit-falsifiable.
 *
 * The field inventory is NOT re-declared here — `CATEGORY_FIELDS` (the add/edit
 * form's §2.4 table) is the one home for "which detail keys does category X
 * have, and what are they called". The detail screen is the same inventory
 * rendered read-only; a field added to the form appears here for free, and the
 * two surfaces can never drift into disagreeing about a booking's own shape.
 */
import {
  wallDate,
  wallTime,
  type BookingDetails,
  type BookingSource,
  type BookingStatus,
  type ISODate,
  type ItineraryItem,
} from "@gogo/shared";

import { CATEGORY_FIELDS } from "../add-edit/form-model";
import { formatDayHeader } from "../model";

// ---------------------------------------------------------------------------
// Status machine (API §3.2) — the ACTIONS, not the segments
// ---------------------------------------------------------------------------

export const BOOKING_STATUS_LABELS: Readonly<Record<BookingStatus, string>> = {
  idea: "Idea",
  planned: "Planned",
  booked: "Booked",
  cancelled: "Cancelled",
};

/**
 * The §3.2 transitions this screen offers as BUTTONS, in table order, with two
 * deliberate exclusions:
 *
 *  - the diagonal (`X → X`) — the table's "—"; a self-transition is not a
 *    legal PATCH, so offering it would be a guaranteed 400;
 *  - `→ cancelled` — R-itin-26 routes cancellation through its own
 *    ConfirmDialog, never a plain status button.
 *
 * `booked → idea` stays absent on purpose: §3.2 marks it ✖ ("demote to planned
 * first — deliberate two-step friction"). `cancelled` is terminal, so a
 * cancelled booking offers no transitions at all.
 *
 * Distinct from `statusOptionsFor` (form-model), which answers a different
 * question — which segments a SEGMENTED CONTROL may show, current status
 * included. Same table, two readings; keeping them apart is why neither has to
 * special-case the other's UI.
 */
export function statusActionsFor(current: BookingStatus): BookingStatus[] {
  switch (current) {
    case "idea":
      return ["planned", "booked"];
    case "planned":
      return ["idea", "booked"];
    case "booked":
      return ["planned"];
    case "cancelled":
      return [];
  }
}

/** R-itin-8 tones, extended with the terminal state the day list never renders. */
export function detailStatusTone(status: BookingStatus): "accent" | "success" | "neutral" {
  if (status === "planned") return "accent";
  if (status === "booked") return "success";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Source label (R-itin-24 "source label (manual/email/share/deeplink return)")
// ---------------------------------------------------------------------------

export const BOOKING_SOURCE_LABELS: Readonly<Record<BookingSource, string>> = {
  manual: "Added manually",
  email: "From a forwarded email",
  share: "From a share",
  deeplink_return: "Added after a partner search",
};

// ---------------------------------------------------------------------------
// Per-category detail grid (R-itin-24 "the category's `details` fields as a
// labeled grid")
// ---------------------------------------------------------------------------

export interface DetailFieldRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Render a wire datetime as destination wall time — `wallDate`/`wallTime`
 * SLICE the ISO string (shared, §3.3): no `Date`, no tz shift, so a
 * `…T10:00:00+09:00` departure reads 10:00 wherever the phone is.
 */
function formatDetailInstant(iso: string): string {
  return `${formatDayHeader(wallDate(iso))} · ${wallTime(iso)}`;
}

/**
 * The category's populated detail fields, in §2.4 form order. Absent, null and
 * blank values are OMITTED rather than rendered as "—": a booking captured
 * from an email fills three fields out of eight, and eight rows of dashes is
 * noise that buries the three that matter.
 *
 * Unknown keys can't appear: the iteration is over `CATEGORY_FIELDS`, not over
 * `Object.keys(details)` — which also means a details blob whose `category`
 * disagrees with a stray key contributes nothing (the T-7.6 landmine: zod
 * strips unknown keys, so such a blob is already impossible on the wire, and
 * this is the render-side half of the same posture).
 */
export function detailFieldRows(details: BookingDetails): DetailFieldRow[] {
  const record = details as unknown as Record<string, unknown>;
  const rows: DetailFieldRow[] = [];
  for (const field of CATEGORY_FIELDS[details.category]) {
    const value = record[field.key];
    if (field.kind === "int") {
      if (typeof value !== "number") continue;
      rows.push({ key: field.key, label: field.label, value: String(value) });
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") continue;
    rows.push({
      key: field.key,
      label: field.label,
      value: field.kind === "datetime" ? formatDetailInstant(value) : value.trim(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Schedule row (R-itin-24 "scheduled day/time row → jumps to the itinerary
// position")
// ---------------------------------------------------------------------------

export interface ScheduleSummary {
  /** The day the row jumps to (the first item's own day). */
  day: ISODate;
  /** "Mon, Mar 1 · 10:00 – 12:30" — or "· 2 items on the calendar" for splits. */
  label: string;
}

/** "10:00 – 12:30" · "10:00" · "" — the item's own wall times (no tz math). */
function itemTimeLabel(item: ItineraryItem): string {
  if (item.start_time === null && item.end_time === null) return "";
  if (item.start_time !== null && item.end_time !== null) {
    return `${item.start_time} – ${item.end_time}`;
  }
  return item.start_time ?? `until ${item.end_time ?? ""}`;
}

/**
 * The booking's calendar presence, collapsed to ONE row.
 *
 * Zero items ⇒ null: an idea, a timeless bucket booking, or a cancelled one
 * (I-1/I-3/I-4) has no position to jump to, and the screen renders the
 * "not on the calendar" affordance instead.
 *
 * Plurality is real, not hypothetical — §3.3 gives `car_rental`/`moped_rental`
 * TWO auto-items (pickup + dropoff), and a spanning lodging is one item across
 * two days. The row therefore names the FIRST day (earliest `(day, sort_order)`
 * — the same order the calendar reads in, R-ib-13) and says how many pieces
 * exist, rather than pretending a booking is always one block.
 */
export function scheduleSummary(items: readonly ItineraryItem[]): ScheduleSummary | null {
  if (items.length === 0) return null;
  const ordered = [...items].sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.sort_order - b.sort_order,
  );
  const first = ordered[0];
  if (first === undefined) return null;
  const time = itemTimeLabel(first);
  const head = time === "" ? formatDayHeader(first.day) : `${formatDayHeader(first.day)} · ${time}`;
  // A spanning item (`end_day`) is ONE row on the calendar that happens to
  // cover a range; extra ROWS are the car-rental case. Both get named, and
  // neither is inferred from the other.
  const spanning = first.end_day !== null && first.end_day > first.day;
  const extras: string[] = [];
  if (spanning && first.end_day !== null) extras.push(`through ${formatDayHeader(first.end_day)}`);
  if (ordered.length > 1) extras.push(`${ordered.length} calendar entries`);
  return {
    day: first.day,
    label: extras.length === 0 ? head : `${head} · ${extras.join(" · ")}`,
  };
}
