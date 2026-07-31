/**
 * ISO ↔ picker Date conversion (T-6.7 R2 — the DST-noon contract): wire
 * dates are LOCAL calendar days, and the noon anchor is what keeps a DST
 * transition from shifting the day when the picker's Date round-trips back
 * to ISO. Runs in whatever tz the runner uses — the invariant is
 * tz-independent (that is the point of noon).
 */
import { isoToPickerDate, pickerDateToISO } from "./DateField";

const BOUNDARY_DATES = [
  "2027-03-14", // US DST spring-forward day
  "2027-11-07", // US DST fall-back day
  "2027-03-28", // EU DST spring-forward day
  "2027-10-31", // EU DST fall-back day
  "2026-12-31", // year boundary
  "2027-01-01",
  "2028-02-29", // leap day
];

describe("isoToPickerDate / pickerDateToISO", () => {
  it.each(BOUNDARY_DATES)("round-trips %s across DST/year/leap boundaries", (iso) => {
    expect(pickerDateToISO(isoToPickerDate(iso))).toBe(iso);
  });

  it("anchors the picker Date at local noon (the DST-safe day identity)", () => {
    const date = isoToPickerDate("2027-03-14");
    expect(date.getHours()).toBe(12);
    expect(date.getFullYear()).toBe(2027);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(14);
  });

  it("an unset field yields today (the picker needs a valid anchor)", () => {
    const now = new Date();
    const anchor = isoToPickerDate("");
    expect(anchor.getFullYear()).toBe(now.getFullYear());
  });

  it("pads single-digit months/days to the wire's YYYY-MM-DD", () => {
    expect(pickerDateToISO(new Date(2027, 0, 5, 12))).toBe("2027-01-05");
  });
});
