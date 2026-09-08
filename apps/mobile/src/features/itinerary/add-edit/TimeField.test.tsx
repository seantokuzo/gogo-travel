/**
 * TimeField seed resolution (B-10c): wall `HH:MM` ↔ picker Date conversion
 * and the contextual spinner seed — value > contextTime > noon. The flight
 * arrival ← departure wiring pin lives in the item-new screen suite (the
 * caller owns the pairing).
 *
 * B-15b presentation pins: the iOS spinner overflowed the right screen edge
 * in half-width form rows (device QA 2026-09-06) — it now presents in the
 * shared PickerCard bottom modal. The overflow itself is layout (device
 * eyes); what jest pins is the STRUCTURE that fixes it (picker inside the
 * screen-anchored `{testID}-sheet` card, never inline in the field column)
 * and the semantics riding on it: change-commits (the IdeasBucket/ItemForm
 * contract — other suites fire `onChange` and expect immediate commit) and
 * the Done seeded-commit (B-15a parity).
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { Keyboard } from "react-native";

import { renderWithTheme } from "@/test-utils/render";

import { pickerDateToTime, TimeField, timePickerSeed, timeToPickerDate } from "./TimeField";

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

describe("TimeField iOS presentation in the shared PickerCard (B-15b)", () => {
  const onSelect = jest.fn();
  afterEach(() => onSelect.mockReset());

  async function renderField(props?: { contextTime?: string; value?: string }) {
    return renderWithTheme(
      <TimeField
        label="Start time"
        value={props?.value ?? ""}
        {...(props?.contextTime !== undefined ? { contextTime: props.contextTime } : {})}
        onSelect={onSelect}
        testID="t"
      />,
    );
  }

  // Kill-mutation: revert the PickerCard wrap (render the spinner inline in
  // the field's column again — the B-15b overflow) → `t-sheet` never exists
  // → red. Control arm: nothing presented before the row is pressed.
  it("pressing the row presents the screen-anchored card with the spinner inside", async () => {
    await renderField();
    expect(screen.queryByTestId("t-sheet")).toBeNull();
    expect(screen.queryByTestId("t-picker")).toBeNull();

    await fireEvent.press(screen.getByTestId("t"));
    expect(screen.getByTestId("t-sheet")).toBeOnTheScreen();
    expect(screen.getByTestId("t-picker")).toBeOnTheScreen();
  });

  // THE consumer contract (IdeasBucket / ItemForm suites fire `onChange` and
  // expect an immediate commit): a spun change commits & closes with NO Done
  // step. Kill-mutation: route changes into a draft that only Done commits →
  // red here before it breaks the other agent's suites.
  it("a spinner change still commits immediately and closes the card", async () => {
    await renderField({ contextTime: "17:05" });
    await fireEvent.press(screen.getByTestId("t"));
    await fireEvent(screen.getByTestId("t-picker"), "onChange", {
      nativeEvent: { timestamp: new Date(2000, 0, 1, 14, 30).getTime(), utcOffset: 0 },
    });
    expect(onSelect).toHaveBeenCalledWith("14:30");
    expect(screen.queryByTestId("t-sheet")).toBeNull();
  });

  // B-15a parity: iOS fires only on CHANGE, so the context-seeded time was
  // uncommittable one-tap. Kill-mutation: drop onSelect from the Done
  // handler → red (the dismiss pins below prove closing alone never selects).
  it("Done commits the context-seeded time and closes", async () => {
    await renderField({ contextTime: "17:05" });
    await fireEvent.press(screen.getByTestId("t"));
    await fireEvent.press(screen.getByTestId("t-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("17:05");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("t-sheet")).toBeNull();
  });

  // Kill-mutation: seed Done from `contextTime` unconditionally → red (a set
  // value beats the context — the timePickerSeed precedence, through the UI).
  it("Done re-commits the SET value when one exists (value beats context)", async () => {
    await renderField({ value: "09:30", contextTime: "17:05" });
    await fireEvent.press(screen.getByTestId("t"));
    await fireEvent.press(screen.getByTestId("t-sheet-done"));
    expect(onSelect).toHaveBeenCalledWith("09:30");
  });

  it("the close button dismisses without selecting", async () => {
    await renderField({ contextTime: "17:05" });
    await fireEvent.press(screen.getByTestId("t"));
    await fireEvent.press(screen.getByTestId("t-sheet-close"));
    expect(screen.queryByTestId("t-sheet")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the scrim dismisses without selecting", async () => {
    await renderField({ contextTime: "17:05" });
    await fireEvent.press(screen.getByTestId("t"));
    // Card `accessibilityViewIsModal` hides SIBLINGS from a11y — RNTL models
    // that, so the scrim needs `includeHiddenElements` (mobile.md Sheet-scrim
    // rule; on device it is plainly tappable).
    await fireEvent.press(screen.getByTestId("t-sheet-scrim", { includeHiddenElements: true }));
    expect(screen.queryByTestId("t-sheet")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * B-15c — see the DateField suite's twin describe for the mechanism note
 * (Keyboard.dismiss == blurTextInput(currentlyFocused); real keyboard
 * teardown gets device eyes).
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

  // Kill-mutation: drop `if (!open) Keyboard.dismiss()` in TimeField's row
  // handler → red. Control arms: no call on render; no second call when the
  // same press toggles the picker closed.
  it("row press that OPENS calls Keyboard.dismiss; the closing toggle does not", async () => {
    await renderWithTheme(<TimeField label="Start time" value="" onSelect={onSelect} testID="t" />);
    expect(dismissSpy).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("t"));
    expect(dismissSpy).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId("t"));
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });
});
