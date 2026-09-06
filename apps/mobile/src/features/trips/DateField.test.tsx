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
import { Keyboard } from "react-native";

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

/**
 * B-15a — one-tap commit of the seeded date (device-confirmed FAIL,
 * 2026-09-06). The iOS inline calendar fires `onValueChange` only when the
 * VALUE CHANGES, so tapping the already-highlighted (seeded) day is a native
 * no-op — a path jest cannot reproduce (the fixture host fires whatever we
 * tell it to; the real native side stays silent — the PR #46 fixture-vs-
 * device gap). What jest CAN pin honestly: before B-15 the modal had NO
 * affordance that commits the displayed day (close/scrim dismiss without
 * selecting — pinned above), so the seeded-open → one-action → field-filled
 * path did not exist. These pins are RED on pre-B-15 main by construction.
 * Device eyes still owed: tapping the pre-highlighted day itself remains a
 * native no-op — Done is the committed one-action path.
 */
describe("DateField Done commits the displayed day (B-15a)", () => {
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

  // Kill-mutation: drop the `onSelect(...)` inside the Done handler (or the
  // Done affordance itself) → red. The existing "close button dismisses
  // WITHOUT selecting" pin above is the control arm proving commit is the
  // Done button's doing, not a side effect of any dismissal.
  it("Done commits the context-seeded day and closes (seeded-open → one action → field filled)", async () => {
    await renderField({ contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent.press(screen.getByTestId("f-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("2027-04-24");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("f-sheet")).toBeNull();
  });

  // Kill-mutation: seed Done from `contextDate` unconditionally → red (a set
  // value must beat the context — same precedence pickerSeedDate pins).
  it("Done re-commits the SET value when one exists (value beats context)", async () => {
    await renderField({ value: "2027-05-08", contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent.press(screen.getByTestId("f-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("2027-05-08");
    expect(screen.queryByTestId("f-sheet")).toBeNull();
  });

  // Control arm for the whole describe: a CHANGED day still commits one-tap
  // through `onValueChange` (the pre-B-15 path stays intact — Done is
  // additive, not a second required step).
  it("picking a different day still commits immediately without Done", async () => {
    await renderField({ contextDate: "2027-04-24" });
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent(screen.getByTestId("f-picker"), "onChange", {
      nativeEvent: { timestamp: new Date(2027, 3, 25, 12).getTime(), utcOffset: 0 },
    });
    expect(onSelect).toHaveBeenCalledWith("2027-04-25");
    expect(screen.queryByTestId("f-sheet")).toBeNull();
  });
});

/**
 * B-15c — opening the picker over an armed keyboard must dismiss it (device
 * QA 2026-09-06: typing kept landing in the previously-focused input). The
 * jest-honest pin is the `Keyboard.dismiss` contract call: RN implements it
 * as TextInputState.blurTextInput(currentlyFocusedInput), so keyboard-down
 * AND focus-blur ride the one call; RNTL cannot arm a real focused TextInput
 * (TextInputState is fed by native focus events), so the actual keyboard
 * teardown gets device eyes.
 */
describe("opening the picker dismisses the keyboard (B-15c)", () => {
  const onSelect = jest.fn();
  let dismissSpy: jest.SpyInstance;
  beforeEach(() => {
    dismissSpy = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
  });
  afterEach(() => {
    dismissSpy.mockRestore();
    onSelect.mockReset();
  });

  // Kill-mutation: drop the `if (!open) Keyboard.dismiss()` line → the first
  // assertion goes red. Control arms: no call on mere render, and no SECOND
  // call when the same press toggles the picker CLOSED (the call is tied to
  // opening, not to every row tap).
  it("row press that OPENS calls Keyboard.dismiss; the closing toggle does not", async () => {
    await renderWithTheme(
      <DateField label="Start date" value="" onSelect={onSelect} testID="f" />,
    );
    expect(dismissSpy).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("f"));
    expect(dismissSpy).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId("f"));
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * PR #49 R1 (correctness lane) — Done must commit the day that was DISPLAYED
 * at open, not a recomputation at press time. With `value=""` and no
 * context, `pickerSeedDate` falls back to `new Date()`: seeding at open but
 * recomputing inside the Done handler lets the clock cross midnight between
 * the two reads — open 23:59:50 showing today, press Done 00:00:05, commit
 * TOMORROW. The seed is now CAPTURED once in the opening press and both the
 * picker's `value` and Done read the capture.
 */
describe("Done commits the open-time captured seed (PR #49 R1)", () => {
  const onSelect = jest.fn();
  afterEach(() => {
    onSelect.mockReset();
    jest.useRealTimers();
  });

  // Kill-mutation: recompute `pickerSeedDate(...)` inside confirmDisplayed
  // (the pre-R1 code) → commits 2027-06-15 → red. Control arm inside the
  // same test: the picker's displayed `date` prop is the pre-midnight day,
  // so the assertion discriminates commit-vs-display, not clock mocking.
  it("across midnight, Done commits the displayed pre-midnight day", async () => {
    jest.useFakeTimers({ now: new Date(2027, 5, 14, 23, 59, 50) });
    await renderWithTheme(
      <DateField label="Start date" value="" onSelect={onSelect} testID="f" />,
    );
    await fireEvent.press(screen.getByTestId("f"));
    // Control arm: the card is displaying June 14.
    expect(
      new Date(screen.getByTestId("f-picker").props.date as number).toDateString(),
    ).toBe(new Date(2027, 5, 14).toDateString());

    jest.setSystemTime(new Date(2027, 5, 15, 0, 0, 5));
    await fireEvent.press(screen.getByTestId("f-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("2027-06-14");
  });

  // Each OPEN recaptures — the capture must never go stale across a
  // close/reopen (kill-mutation: capture once at mount → red).
  it("reopening recaptures: a later open on a new day seeds the new day", async () => {
    jest.useFakeTimers({ now: new Date(2027, 5, 14, 23, 59, 50) });
    await renderWithTheme(
      <DateField label="Start date" value="" onSelect={onSelect} testID="f" />,
    );
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent.press(screen.getByTestId("f-sheet-close"));

    jest.setSystemTime(new Date(2027, 5, 15, 9, 0, 0));
    await fireEvent.press(screen.getByTestId("f"));
    await fireEvent.press(screen.getByTestId("f-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("2027-06-15");
  });
});
