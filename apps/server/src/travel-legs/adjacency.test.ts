/**
 * T-7.3 adjacency unit matrix (spec §3.5 step 2, R-ib-20, §3.6 Branch A):
 * chain membership (day + end_day), `(sort_order, id)` ordering, unlocated
 * transparency, located pairing, same-place detection, co-chain days. Pure —
 * no DB, no clocks.
 */
import { describe, expect, it } from "vitest";
import {
  chainForDay,
  coChainDays,
  itemChainDays,
  locatedPairs,
  type ChainItem,
} from "./adjacency.js";

const STAMP = new Date("2026-07-31T00:00:00Z");

function item(overrides: Partial<ChainItem> & { id: string }): ChainItem {
  return {
    day: "2026-09-01",
    endDay: null,
    sortOrder: 1024,
    placeId: null,
    lat: null,
    lng: null,
    changedAt: STAMP,
    ...overrides,
  };
}

const located = (id: string, placeId: string, sortOrder: number, day = "2026-09-01") =>
  item({ id, placeId, lat: 35.6, lng: 139.7, sortOrder, day });

describe("itemChainDays / coChainDays (§3.6 spanning membership)", () => {
  it("single-day item participates in exactly its day", () => {
    expect(itemChainDays({ day: "2026-09-01", endDay: null })).toEqual(["2026-09-01"]);
    // end_day === day is NOT a span (mirror of the booking service's itemDays).
    expect(itemChainDays({ day: "2026-09-01", endDay: "2026-09-01" })).toEqual(["2026-09-01"]);
  });

  it("spanning item participates in day AND end_day — not the days between", () => {
    expect(itemChainDays({ day: "2026-09-01", endDay: "2026-09-04" })).toEqual([
      "2026-09-01",
      "2026-09-04",
    ]);
  });

  it("co-chain days are the intersection of both endpoints' chain days", () => {
    const lodging = { day: "2026-09-01", endDay: "2026-09-03" };
    const dinner = { day: "2026-09-03", endDay: null };
    const breakfast = { day: "2026-09-01", endDay: null };
    const offDay = { day: "2026-09-02", endDay: null };
    expect(coChainDays(lodging, dinner)).toEqual(["2026-09-03"]);
    expect(coChainDays(lodging, breakfast)).toEqual(["2026-09-01"]);
    // A leg between items that never co-chain has NO valid day (∅).
    expect(coChainDays(lodging, offDay)).toEqual([]);
    expect(coChainDays(breakfast, dinner)).toEqual([]);
  });
});

describe("chainForDay (day order = sort_order, id tiebreak)", () => {
  it("orders by sort_order then id, and includes end_day participants", () => {
    const a = located("aaaaaaaa-0000-4000-8000-000000000001", "p1", 2048);
    const b = located("aaaaaaaa-0000-4000-8000-000000000002", "p2", 1024);
    const spanning = item({
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      day: "2026-08-30",
      endDay: "2026-09-01",
      sortOrder: 3072,
      placeId: "p3",
      lat: 35.0,
      lng: 139.0,
    });
    const otherDay = located("aaaaaaaa-0000-4000-8000-000000000004", "p4", 512, "2026-09-02");

    const chain = chainForDay([a, b, spanning, otherDay], "2026-09-01");
    expect(chain.map((i) => i.id)).toEqual([b.id, a.id, spanning.id]);
  });

  it("breaks sort_order ties by id (deterministic total order)", () => {
    const second = located("bbbbbbbb-0000-4000-8000-000000000002", "p2", 1024);
    const first = located("bbbbbbbb-0000-4000-8000-000000000001", "p1", 1024);
    const chain = chainForDay([second, first], "2026-09-01");
    expect(chain.map((i) => i.id)).toEqual([first.id, second.id]);
  });
});

describe("locatedPairs (R-ib-20)", () => {
  it("pairs consecutive located items; unlocated items are transparent", () => {
    const a = located("cccccccc-0000-4000-8000-000000000001", "p1", 1024);
    const unlocated = item({ id: "cccccccc-0000-4000-8000-000000000002", sortOrder: 2048 });
    const c = located("cccccccc-0000-4000-8000-000000000003", "p2", 3072);
    const pairs = locatedPairs([a, unlocated, c]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.from.id).toBe(a.id);
    expect(pairs[0]?.to.id).toBe(c.id);
    expect(pairs[0]?.samePlace).toBe(false);
  });

  it("zero or one located item yields no pairs", () => {
    expect(locatedPairs([])).toEqual([]);
    expect(locatedPairs([item({ id: "x" })])).toEqual([]);
    expect(locatedPairs([located("y", "p1", 1024)])).toEqual([]);
    // All-unlocated chain: still nothing.
    expect(locatedPairs([item({ id: "u1" }), item({ id: "u2", sortOrder: 2048 })])).toEqual([]);
  });

  it("flags identical resolved place_id as samePlace (§3.5 step 2 zero legs)", () => {
    const a = located("dddddddd-0000-4000-8000-000000000001", "p1", 1024);
    const b = located("dddddddd-0000-4000-8000-000000000002", "p1", 2048);
    const c = located("dddddddd-0000-4000-8000-000000000003", "p2", 3072);
    const pairs = locatedPairs([a, b, c]);
    expect(pairs.map((p) => [p.from.id, p.to.id, p.samePlace])).toEqual([
      [a.id, b.id, true],
      [b.id, c.id, false],
    ]);
  });

  it("an item missing coordinates counts as unlocated even with a place id", () => {
    // Defensive arm: the recompute un-locates items whose place row vanished.
    const broken = item({ id: "eeeeeeee-0000-4000-8000-000000000001", placeId: "p1" });
    const a = located("eeeeeeee-0000-4000-8000-000000000002", "p2", 2048);
    const b = located("eeeeeeee-0000-4000-8000-000000000003", "p3", 3072);
    expect(locatedPairs([broken, a, b]).map((p) => [p.from.id, p.to.id])).toEqual([[a.id, b.id]]);
  });
});
