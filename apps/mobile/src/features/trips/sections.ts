/**
 * Trip-list grouping/sorting + row formatting (T-6.7 / CT-1; trips spec
 * R-tripui-1, §2.1). Pure — unit-tested directly.
 *
 * Sections key on the server's EFFECTIVE `trip_status` (derived unless the
 * owner override wins, R-db-19); display labels are presentation only.
 */
import type { TripListItem, TripStatus } from "@gogo/shared";

/** §2.1 section order: active → planning → past. */
export const TRIP_SECTION_ORDER: readonly TripStatus[] = ["active", "planning", "past"];

/** §2.1 display labels — presentation only, enum values stay the keys. */
export const TRIP_SECTION_LABELS: Readonly<Record<TripStatus, string>> = {
  active: "Happening now",
  planning: "Upcoming",
  past: "Past",
};

export interface TripSection {
  status: TripStatus;
  title: string;
  data: TripListItem[];
}

/**
 * R-tripui-1: group by status in §2.1 order, sort `active`/`planning` by
 * `start_date` ascending and `past` by `end_date` descending (dates are
 * required at creation — every trip sorts by date; ISO strings compare
 * lexicographically). Empty sections are dropped, not rendered. Ties break
 * on `id` so pagination appends can never reorder equal-date rows between
 * renders (stable, data-derived — never render-index).
 */
export function groupTripsIntoSections(items: readonly TripListItem[]): TripSection[] {
  const byStatus = new Map<TripStatus, TripListItem[]>();
  for (const item of items) {
    const bucket = byStatus.get(item.status);
    if (bucket) bucket.push(item);
    else byStatus.set(item.status, [item]);
  }
  const sections: TripSection[] = [];
  for (const status of TRIP_SECTION_ORDER) {
    const data = byStatus.get(status);
    if (!data || data.length === 0) continue;
    data.sort((a, b) => {
      const cmp =
        status === "past"
          ? b.end_date.localeCompare(a.end_date)
          : a.start_date.localeCompare(b.start_date);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
    sections.push({ status, title: TRIP_SECTION_LABELS[status], data });
  }
  return sections;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `YYYY-MM-DD` → `{ y, m (1-based), d }` without any Date/tz round trip. */
function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

/**
 * Row date range (R-tripui-2) — compact, deterministic, tz-free (wire dates
 * are ISO calendar dates, never instants — rendering through `Date` would
 * shift the day west of UTC):
 *   same month  → "Mar 3–10, 2027"
 *   same year   → "Mar 28 – Apr 2, 2027"
 *   cross year  → "Dec 30, 2026 – Jan 4, 2027"
 */
export function formatDateRange(start: string, end: string): string {
  const s = parts(start);
  const e = parts(end);
  const sm = MONTHS[s.m - 1] ?? "";
  const em = MONTHS[e.m - 1] ?? "";
  if (s.y === e.y && s.m === e.m) return `${sm} ${s.d}–${e.d}, ${e.y}`;
  if (s.y === e.y) return `${sm} ${s.d} – ${em} ${e.d}, ${e.y}`;
  return `${sm} ${s.d}, ${s.y} – ${em} ${e.d}, ${e.y}`;
}

/** "1 member" / "N members" (R-tripui-2; count is always ≥ 1, R-trips-3). */
export function formatMemberCount(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}
