/**
 * usePickerFocus (B-15d) — exclusive-open across the picker field family,
 * pinned through the REAL consumers (DateField + TimeField), not a synthetic
 * harness: the invariant Sean's device QA demanded is "opening any picker
 * closes any other open picker", and that only holds if BOTH components
 * claim AND yield. RNTL note: RNTL does not model a visible Modal's touch
 * blocking, which is exactly why these pins are writable — and exactly why
 * the coordinator must exist at the state level (on device the double-open
 * paths are Android dialog dismissal races and any future inline
 * presentation, not taps through the iOS scrim).
 *
 * Kill-mutations, per arm:
 *  - remove `usePickerFocus` from DateField → "second date field" and
 *    "date closes time" arms go red (DateField never claims/yields);
 *  - remove it from TimeField → both cross-family arms go red;
 *  - drop the `current()` call in the hook → every exclusivity arm red
 *    while the control arm (a lone picker stays open) stays green.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { View } from "react-native";

import { TimeField } from "@/features/itinerary/add-edit/TimeField";
import { DateField } from "@/features/trips";
import { renderWithTheme } from "@/test-utils/render";

describe("usePickerFocus exclusive-open (B-15d)", () => {
  const onSelectDate = jest.fn();
  const onSelectTime = jest.fn();
  afterEach(() => {
    onSelectDate.mockReset();
    onSelectTime.mockReset();
  });

  async function renderFamily() {
    return renderWithTheme(
      <View>
        <DateField label="Start date" value="" onSelect={onSelectDate} testID="d1" />
        <DateField label="End date" value="" onSelect={onSelectDate} testID="d2" />
        <TimeField label="Start time" value="" onSelect={onSelectTime} testID="t1" />
      </View>,
    );
  }

  // Control arm: a lone open picker STAYS open (no self-close through its
  // own claim) — proves the exclusivity pins below fail for the right
  // reason, not because everything always closes.
  it("a lone picker stays open; reopening the same picker does not self-close", async () => {
    await renderFamily();
    await fireEvent.press(screen.getByTestId("d1"));
    expect(screen.getByTestId("d1-sheet")).toBeOnTheScreen();

    // Toggle closed, reopen — the released claim must not wedge the slot.
    await fireEvent.press(screen.getByTestId("d1"));
    expect(screen.queryByTestId("d1-sheet")).toBeNull();
    await fireEvent.press(screen.getByTestId("d1"));
    expect(screen.getByTestId("d1-sheet")).toBeOnTheScreen();
  });

  it("opening a second date field closes the first", async () => {
    await renderFamily();
    await fireEvent.press(screen.getByTestId("d1"));
    expect(screen.getByTestId("d1-sheet")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("d2"));
    expect(screen.queryByTestId("d1-sheet")).toBeNull();
    expect(screen.getByTestId("d2-sheet")).toBeOnTheScreen();
  });

  it("opening a time field closes an open date field (cross-family)", async () => {
    await renderFamily();
    await fireEvent.press(screen.getByTestId("d2"));
    expect(screen.getByTestId("d2-sheet")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("t1"));
    expect(screen.queryByTestId("d2-sheet")).toBeNull();
    expect(screen.getByTestId("t1-sheet")).toBeOnTheScreen();
  });

  it("opening a date field closes an open time field (cross-family, reversed)", async () => {
    await renderFamily();
    await fireEvent.press(screen.getByTestId("t1"));
    expect(screen.getByTestId("t1-sheet")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("d1"));
    expect(screen.queryByTestId("t1-sheet")).toBeNull();
    expect(screen.getByTestId("d1-sheet")).toBeOnTheScreen();
  });

  // A forced close is a DISMISSAL, never a selection — the loser must not
  // commit its seed on the way out.
  it("being force-closed never selects", async () => {
    await renderFamily();
    await fireEvent.press(screen.getByTestId("d1"));
    await fireEvent.press(screen.getByTestId("t1"));
    await fireEvent.press(screen.getByTestId("d2"));
    expect(onSelectDate).not.toHaveBeenCalled();
    expect(onSelectTime).not.toHaveBeenCalled();
    // The last opener holds the slot.
    expect(screen.getByTestId("d2-sheet")).toBeOnTheScreen();
    expect(screen.queryByTestId("t1-sheet")).toBeNull();
  });
});
