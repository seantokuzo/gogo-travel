/**
 * ISO ↔ picker Date conversion (T-6.7 R2 — the DST-noon contract): wire
 * dates are LOCAL calendar days, and the noon anchor is what keeps a DST
 * transition from shifting the day when the picker's Date round-trips back
 * to ISO. Runs in whatever tz the runner uses — the invariant is
 * tz-independent (that is the point of noon).
 *
 * B-10 additions:
 *  - `pickerSeedDate` contextual-seed resolution (value > context > today);
 *  - iOS presentation pins: the picker mounts inside the SCREEN-anchored
 *    modal card (`{testID}-sheet`), never inline in the field's column —
 *    seed asserted through the wrapper's public `date` translation
 *    (`dateToMilliseconds(value)`), selection closes + reports the ISO day,
 *    and both dismissal affordances close WITHOUT selecting (the selection
 *    pin is the control arm proving the spy wiring fires when a day IS
 *    picked).
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { DateField, isoToPickerDate, pickerDateToISO, pickerSeedDate } from "./DateField";

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

describe("pickerSeedDate (B-10b)", () => {
  it("a set value always wins — context never overrides what the user picked", () => {
    expect(pickerDateToISO(pickerSeedDate("2027-05-08", "2027-04-24"))).toBe("2027-05-08");
  });

  it("an empty value seeds from the context date at the noon anchor", () => {
    const seed = pickerSeedDate("", "2027-04-24");
    expect(pickerDateToISO(seed)).toBe("2027-04-24");
    expect(seed.getHours()).toBe(12);
  });

  it("no context (absent or empty) falls back to today", () => {
    const today = new Date().toDateString();
    expect(pickerSeedDate("").toDateString()).toBe(today);
    expect(pickerSeedDate("", "").toDateString()).toBe(today);
  });
});

describe("DateField iOS presentation (B-10a) + contextual seed (B-10b)", () => {
  const onSelect = jest.fn();
  afterEach(() => onSelect.mockReset());

  async function renderField(props?: { contextDate?: string; value?: string }) {
    return renderWithTheme(
      <DateField
        label="Start date"
        value={props?.value ?? ""}
        {...(props?.contextDate !== undefined ? { contextDate: props.contextDate } : {})}
        onSelect={onSelect}
        testID="f"
      />,
    );
  }

  it("pressing the row presents the screen-anchored card with the picker inside", async () => {
    await renderField();
    // Control arm: nothing presented until the row is pressed.
    expect(screen.queryByTestId("f-sheet")).toBeNull();
    expect(screen.queryByTestId("f-picker")).toBeNull();

    await fireEvent.press(screen.getByTestId("f"));
    expect(screen.getByTestId("f-sheet")).toBeOnTheScreen();
    expect(screen.getByTestId("f-picker")).toBeOnTheScreen();
  });

  it("an empty value seeds the picker from contextDate (wrapper's `date` ms translation)", async () => {
    await renderField({ contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    expect(screen.getByTestId("f-picker").props.date).toBe(
      new Date(2027, 3, 24, 12).getTime(),
    );
  });

  it("no context seeds today (the pre-B-10 anchor stays the fallback)", async () => {
    await renderField();
    await fireEvent.press(screen.getByTestId("f"));
    const seeded = new Date(screen.getByTestId("f-picker").props.date as number);
    expect(seeded.toDateString()).toBe(new Date().toDateString());
  });

  it("a set value beats the context (control arm for the seed)", async () => {
    await renderField({ value: "2027-05-08", contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    expect(screen.getByTestId("f-picker").props.date).toBe(
      new Date(2027, 4, 8, 12).getTime(),
    );
  });

  it("selecting a day reports the ISO date and closes the card", async () => {
    await renderField({ contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent(screen.getByTestId("f-picker"), "onChange", {
      nativeEvent: { timestamp: new Date(2027, 3, 25, 12).getTime(), utcOffset: 0 },
    });
    expect(onSelect).toHaveBeenCalledWith("2027-04-25");
    expect(screen.queryByTestId("f-sheet")).toBeNull();
  });

  it("the close button dismisses without selecting", async () => {
    await renderField();
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent.press(screen.getByTestId("f-sheet-close"));
    expect(screen.queryByTestId("f-sheet")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the scrim dismisses without selecting", async () => {
    await renderField();
    await fireEvent.press(screen.getByTestId("f"));
    // The card's `accessibilityViewIsModal` hides SIBLINGS from a11y — RNTL
    // models that, so the scrim needs `includeHiddenElements` (the mobile.md
    // Sheet-scrim rule; on device it is plainly tappable).
    await fireEvent.press(
      screen.getByTestId("f-sheet-scrim", { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId("f-sheet")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
