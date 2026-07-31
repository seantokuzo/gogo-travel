/**
 * Trip-list grouping/sorting + formatting (T-6.7 / CT-1; R-tripui-1/2).
 * Pure-function tests — fixed dates, no clock dependence.
 */
import type { TripListItem } from "@gogo/shared";

import {
  TRIP_SECTION_LABELS,
  formatDateRange,
  formatFieldDate,
  formatMemberCount,
  groupTripsIntoSections,
} from "./sections";

function trip(overrides: Partial<TripListItem> & { id: string }): TripListItem {
  return {
    name: "Trip",
    destination_name: "Somewhere",
    destination_lat: 0,
    destination_lng: 0,
    start_date: "2027-05-01",
    end_date: "2027-05-08",
    status: "planning",
    status_override: null,
    base_currency: "USD",
    budget_cap_cents: null,
    theme: null,
    created_by: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    role: "owner",
    member_count: 1,
    ...overrides,
  };
}

describe("groupTripsIntoSections (R-tripui-1)", () => {
  it("groups by status in active → planning → past order with §2.1 labels", () => {
    const sections = groupTripsIntoSections([
      trip({ id: "p1", status: "past", end_date: "2026-01-10" }),
      trip({ id: "a1", status: "active" }),
      trip({ id: "u1", status: "planning" }),
    ]);
    expect(sections.map((s) => s.status)).toEqual(["active", "planning", "past"]);
    expect(sections.map((s) => s.title)).toEqual(["Happening now", "Upcoming", "Past"]);
    expect(TRIP_SECTION_LABELS.planning).toBe("Upcoming");
  });

  it("sorts active/planning by start_date ascending, past by end_date descending", () => {
    const sections = groupTripsIntoSections([
      trip({ id: "u-late", status: "planning", start_date: "2027-09-01" }),
      trip({ id: "u-soon", status: "planning", start_date: "2027-06-01" }),
      trip({ id: "a-late", status: "active", start_date: "2027-05-03" }),
      trip({ id: "a-soon", status: "active", start_date: "2027-05-01" }),
      trip({ id: "p-old", status: "past", end_date: "2026-01-01" }),
      trip({ id: "p-recent", status: "past", end_date: "2026-06-01" }),
    ]);
    expect(sections[0].data.map((t) => t.id)).toEqual(["a-soon", "a-late"]);
    expect(sections[1].data.map((t) => t.id)).toEqual(["u-soon", "u-late"]);
    expect(sections[2].data.map((t) => t.id)).toEqual(["p-recent", "p-old"]);
  });

  it("drops empty sections instead of rendering blank headers", () => {
    const sections = groupTripsIntoSections([trip({ id: "u1", status: "planning" })]);
    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe("planning");
  });

  it("breaks equal-date ties on id so pagination appends can't reorder rows", () => {
    const sections = groupTripsIntoSections([
      trip({ id: "bbb", status: "planning", start_date: "2027-06-01" }),
      trip({ id: "aaa", status: "planning", start_date: "2027-06-01" }),
    ]);
    expect(sections[0].data.map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });

  it("returns no sections for zero trips (the screen renders EmptyState)", () => {
    expect(groupTripsIntoSections([])).toEqual([]);
  });
});

describe("formatDateRange (R-tripui-2)", () => {
  it("collapses a same-month range", () => {
    expect(formatDateRange("2027-03-03", "2027-03-10")).toBe("Mar 3–10, 2027");
  });

  it("spells both months within one year", () => {
    expect(formatDateRange("2027-03-28", "2027-04-02")).toBe("Mar 28 – Apr 2, 2027");
  });

  it("spells both years across a year boundary", () => {
    expect(formatDateRange("2026-12-30", "2027-01-04")).toBe("Dec 30, 2026 – Jan 4, 2027");
  });
});

describe("formatMemberCount (R-tripui-2)", () => {
  it("pluralizes", () => {
    expect(formatMemberCount(1)).toBe("1 member");
    expect(formatMemberCount(4)).toBe("4 members");
  });
});

describe("formatFieldDate (DateField display)", () => {
  it("formats a single wire date tz-free", () => {
    expect(formatFieldDate("2027-05-01")).toBe("May 1, 2027");
    expect(formatFieldDate("2026-12-31")).toBe("Dec 31, 2026");
  });
});
