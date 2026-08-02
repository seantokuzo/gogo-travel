/**
 * Overlap column assignment (R-itin-15) — side-by-side split, never
 * occluded; badge flags only for DIRECT time-range sharing.
 */
import { assignOverlapColumns } from "./layout";

const span = (startMinutes: number, endMinutes: number) => ({ startMinutes, endMinutes });

describe("assignOverlapColumns", () => {
  it("leaves non-overlapping blocks full width and unbadged", () => {
    const result = assignOverlapColumns([span(9 * 60, 10 * 60), span(12 * 60, 13 * 60)]);
    for (const block of result) {
      expect(block.columns).toBe(1);
      expect(block.column).toBe(0);
      expect(block.overlapping).toBe(false);
    }
  });

  it("splits two overlapping blocks side-by-side and badges both", () => {
    const result = assignOverlapColumns([span(9 * 60, 11 * 60), span(10 * 60, 12 * 60)]);
    expect(result.map((b) => b.columns)).toEqual([2, 2]);
    expect(new Set(result.map((b) => b.column))).toEqual(new Set([0, 1]));
    expect(result.every((b) => b.overlapping)).toBe(true);
  });

  it("reuses a freed column within a cluster (chained overlap)", () => {
    // A 9–10, B 9:30–11, C 10–12: A/C never touch but chain through B.
    const [a, b, c] = assignOverlapColumns([
      span(9 * 60, 10 * 60),
      span(9 * 60 + 30, 11 * 60),
      span(10 * 60, 12 * 60),
    ]);
    expect([a?.columns, b?.columns, c?.columns]).toEqual([2, 2, 2]);
    expect(a?.column).toBe(c?.column); // C reuses A's freed column
    expect(b?.column).not.toBe(a?.column);
    // All three DIRECTLY overlap B — every badge fires here.
    expect([a?.overlapping, b?.overlapping, c?.overlapping]).toEqual([true, true, true]);
  });

  it("does not badge chained blocks that never directly overlap", () => {
    // A 9–10 and C 10:30–11:30 chain through B 9:30–11 — but D exists to
    // prove the badge is direct-only: A/C share no minutes.
    const [a, , c] = assignOverlapColumns([
      span(9 * 60, 10 * 60),
      span(9 * 60 + 30, 11 * 60),
      span(10 * 60 + 30, 11 * 60 + 30),
    ]);
    expect(a?.overlapping).toBe(true);
    expect(c?.overlapping).toBe(true);
    // Direct check between A and C alone:
    const [x, y] = assignOverlapColumns([span(9 * 60, 10 * 60), span(10 * 60 + 30, 11 * 60 + 30)]);
    expect(x?.overlapping).toBe(false);
    expect(y?.overlapping).toBe(false);
  });

  it("touching edges (end == next start) do not overlap", () => {
    const result = assignOverlapColumns([span(9 * 60, 10 * 60), span(10 * 60, 11 * 60)]);
    expect(result.every((b) => b.columns === 1 && !b.overlapping)).toBe(true);
  });

  it("closes a cluster — a later lone block returns to full width", () => {
    const result = assignOverlapColumns([
      span(9 * 60, 11 * 60),
      span(10 * 60, 12 * 60),
      span(18 * 60, 19 * 60),
    ]);
    expect(result[2]?.columns).toBe(1);
    expect(result[2]?.overlapping).toBe(false);
  });

  it("splits identical zero-length point events instead of stacking them", () => {
    const result = assignOverlapColumns([span(9 * 60, 9 * 60), span(9 * 60, 9 * 60)]);
    expect(result.map((b) => b.columns)).toEqual([2, 2]);
    expect(new Set(result.map((b) => b.column))).toEqual(new Set([0, 1]));
    expect(result.every((b) => b.overlapping)).toBe(true);
  });

  it("preserves input order in the returned array", () => {
    const tagged = [
      { ...span(10 * 60, 12 * 60), tag: "late" },
      { ...span(9 * 60, 11 * 60), tag: "early" },
    ];
    const result = assignOverlapColumns(tagged);
    expect(result.map((b) => b.tag)).toEqual(["late", "early"]);
  });
});
