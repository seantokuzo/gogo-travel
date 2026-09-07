/**
 * Add-sheet pins (T-7.6 / IT-7 — R-itin-18): all 10 §2.9 options render
 * (`itinerary-add-option-{slug}`, kebab slugs), a selection fires ONCE per
 * presentation (the DS Sheet stays hit-testable through its ~200ms exit —
 * SHEET TAX gate), and the gate re-arms on the next presentation.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useState } from "react";
import { Button } from "react-native";

import { AddOptionsSheet, type AddOptionId } from "@/features/itinerary";
import { renderWithTheme } from "@/test-utils/render";

const EXPECTED_SLUGS = [
  "lodging",
  "flight",
  "train",
  "car-rental",
  "moped-rental",
  "activity",
  "restaurant",
  "other",
  "place-visit",
  "custom",
];

function Host({
  onSelect,
  onExited,
}: {
  onSelect: (option: AddOptionId) => void;
  onExited?: () => void;
}) {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <Button title="reopen" onPress={() => setVisible(true)} testID="reopen" />
      <AddOptionsSheet
        visible={visible}
        onDismiss={() => setVisible(false)}
        onSelect={(option) => {
          setVisible(false);
          onSelect(option);
        }}
        {...(onExited === undefined ? {} : { onExited })}
      />
    </>
  );
}

it("renders all 10 options with §2.9 kebab ids; selection fires once and re-arms per presentation", async () => {
  const onSelect = jest.fn();
  // B-19: this is the only two-presentation harness in the file, so it is
  // also where `onExited`'s PER-PRESENTATION re-arm gets pinned. Collapse the
  // Sheet's per-tick latch to a once-ever boolean and the second cycle goes
  // silent — every Sheet→modal-route flow in the app becomes a dead tap from
  // the second use onward, with the whole suite still green.
  const onExited = jest.fn();
  await renderWithTheme(<Host onSelect={onSelect} onExited={onExited} />);

  for (const slug of EXPECTED_SLUGS) {
    expect(screen.getByTestId(`itinerary-add-option-${slug}`)).toBeOnTheScreen();
  }

  const option = screen.getByTestId("itinerary-add-option-car-rental");
  await fireEvent.press(option);
  // The sheet is exiting but still hit-testable (DS landmine) — a late
  // second tap must not double-fire.
  await fireEvent.press(option);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith("car_rental");

  // Drain the exit inside act (SHEET TAX).
  await waitFor(() => expect(screen.queryByTestId("itinerary-add-sheet")).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(onExited).toHaveBeenCalledTimes(1);

  // Re-presented: the one-action gate is re-armed.
  await fireEvent.press(screen.getByTestId("reopen"));
  await screen.findByTestId("itinerary-add-option-custom");
  await fireEvent.press(screen.getByTestId("itinerary-add-option-custom"));
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith("custom");

  await waitFor(() => expect(screen.queryByTestId("itinerary-add-sheet")).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // …and so is the exit signal: the second presentation reports its own.
  expect(onExited).toHaveBeenCalledTimes(2);
});

/**
 * B-19: this sheet is the FAB's picker, and its host pushes `item/new` — a
 * `presentation: "modal"` route — from `onExited`. The forwarding is two
 * lines and therefore exactly the kind of wiring a refactor drops silently;
 * without it the host's push never fires and the add flow is a dead tap.
 */
it("forwards onExited: it lands after the sheet is gone, never on the selection itself", async () => {
  const onExited = jest.fn(() => {
    expect(screen.queryByTestId("itinerary-add-sheet")).toBeNull();
  });
  await renderWithTheme(<Host onSelect={jest.fn()} onExited={onExited} />);

  await fireEvent.press(screen.getByTestId("itinerary-add-option-flight"));
  // Still presented — the wedge window (see the Sheet's `onExited` doc).
  expect(screen.getByTestId("itinerary-add-sheet")).toBeOnTheScreen();
  expect(onExited).not.toHaveBeenCalled();

  await waitFor(() => expect(screen.queryByTestId("itinerary-add-sheet")).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(onExited).toHaveBeenCalledTimes(1);
});
