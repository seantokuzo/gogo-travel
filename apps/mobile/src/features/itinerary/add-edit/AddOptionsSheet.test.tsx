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

function Host({ onSelect }: { onSelect: (option: AddOptionId) => void }) {
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
      />
    </>
  );
}

it("renders all 10 options with §2.9 kebab ids; selection fires once and re-arms per presentation", async () => {
  const onSelect = jest.fn();
  await renderWithTheme(<Host onSelect={onSelect} />);

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
});
