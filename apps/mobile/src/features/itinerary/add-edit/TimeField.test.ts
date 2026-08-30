/**
 * TimeField seed resolution (B-10c): wall `HH:MM` ↔ picker Date conversion
 * and the contextual spinner seed — value > contextTime > noon. Pure-unit:
 * the component-level presentation pins live with DateField (same pattern)
 * and the flight arrival ← departure wiring pin lives in the item-new
 * screen suite (the caller owns the pairing).
 */
import { pickerDateToTime, timePickerSeed, timeToPickerDate } from "./TimeField";

describe("timeToPickerDate / pickerDateToTime", () => {
  it("round-trips a wall time through the picker Date", () => {
    expect(pickerDateToTime(timeToPickerDate("17:05"))).toBe("17:05");
    expect(pickerDateToTime(timeToPickerDate("00:00"))).toBe("00:00");
  });

  it("an unset field anchors at noon", () => {
    expect(pickerDateToTime(timeToPickerDate(""))).toBe("12:00");
  });
});

describe("timePickerSeed (B-10c)", () => {
  it("a set value always wins over the context", () => {
    expect(pickerDateToTime(timePickerSeed("09:30", "17:05"))).toBe("09:30");
  });

  it("an empty value seeds from the context time", () => {
    expect(pickerDateToTime(timePickerSeed("", "17:05"))).toBe("17:05");
  });

  it("no context (absent or empty) falls back to noon", () => {
    expect(pickerDateToTime(timePickerSeed(""))).toBe("12:00");
    expect(pickerDateToTime(timePickerSeed("", ""))).toBe("12:00");
  });
});
