/**
 * Airline typeahead (B-9). The wire field stores a NAME, so — unlike the
 * airport picker — there is no code to normalize and no save gate to
 * satisfy: a carrier the seeded table doesn't know must stay typeable, and
 * a pick is just a faster way to type the same string.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useState } from "react";

import { apiClient } from "@/auth";
import { renderWithProviders } from "@/test-utils/render";
import { searchAirlineFixtures } from "@/test-utils/reference-fixtures";

import { AirlinePickerField } from "./AirlinePickerField";

const TEST_ID = "itinerary-item-new-input-airline";

/**
 * The field is fully controlled (the wire value IS the query), so a typing
 * test needs the parent's state — an uncontrolled harness would leave the
 * query frozen at "" and every search pin would pass vacuously.
 */
function Harness({ initial, onCommit }: { initial: string; onCommit: jest.Mock }) {
  const [value, setValue] = useState(initial);
  return (
    <AirlinePickerField
      label="Airline"
      value={value}
      onChangeText={(next) => {
        onCommit(next);
        setValue(next);
      }}
      maxLength={200}
      testID={TEST_ID}
    />
  );
}

async function renderHarness(initial = "") {
  const onCommit = jest.fn();
  await renderWithProviders(<Harness initial={initial} onCommit={onCommit} />);
  return { onCommit };
}

function mockSearch(): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((_descriptor, input?: { query?: Record<string, string> }) =>
    Promise.resolve(searchAirlineFixtures(input?.query?.["q"] ?? "")),
  );
  return request;
}

async function renderField(
  overrides: Partial<React.ComponentProps<typeof AirlinePickerField>> = {},
) {
  const onChangeText = jest.fn();
  await renderWithProviders(
    <AirlinePickerField
      label="Airline"
      value=""
      onChangeText={onChangeText}
      maxLength={200}
      testID={TEST_ID}
      {...overrides}
    />,
  );
  return { onChangeText };
}

afterEach(async () => {
  // Drain a typeahead query still in flight — an un-drained settle lands as
  // a floating act during a LATER suite (mobile.md, B-2).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

it("an empty field fires nothing", async () => {
  const request = mockSearch();
  await renderField();
  expect(request).not.toHaveBeenCalled();
});

it("a PREFILLED field starts settled — opening a stored booking drops no result list", async () => {
  // Edit mode: `value` is the stored carrier name, which is also a perfectly
  // searchable query. Without the settled-on-mount guard the form would open
  // with a dropdown over it and burn a request per edit.
  const request = mockSearch();
  await renderHarness("All Nippon Airways");
  await waitFor(() => expect(screen.queryByTestId(`${TEST_ID}-result-NH`)).toBeNull());
  expect(request).not.toHaveBeenCalled();
});

it("a pick commits the airline NAME and closes the results", async () => {
  mockSearch();
  const { onCommit } = await renderHarness();
  await fireEvent.changeText(screen.getByTestId(TEST_ID), "NH");
  await fireEvent.press(await screen.findByTestId(`${TEST_ID}-result-NH`));
  expect(onCommit).toHaveBeenLastCalledWith("All Nippon Airways");
  await waitFor(() => expect(screen.queryByTestId(`${TEST_ID}-result-NH`)).toBeNull());
});

it("free text commits verbatim — an unlisted carrier is still enterable", async () => {
  // The whole point of not gating this field: the seeded table is ~900 rows
  // and the world has more airlines than that.
  const request = mockSearch();
  const { onCommit } = await renderHarness();
  await fireEvent.changeText(screen.getByTestId(TEST_ID), "Some Regional Air");
  expect(onCommit).toHaveBeenLastCalledWith("Some Regional Air");
  expect(screen.getByTestId(TEST_ID).props.value).toBe("Some Regional Air");
  // Settle the search this typing started (it matches nothing, so there is
  // no row to await): an un-drained notify lands as a floating act in a
  // LATER suite (mobile.md, B-2).
  await waitFor(() => expect(request).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

it("clear empties the committed value and leaves no search behind", async () => {
  // Through the CONTROLLED harness on purpose: clearing must drop the query
  // too. An uncontrolled render would keep the old text as a live query and
  // fire a search for the value the user just deleted.
  const request = mockSearch();
  const { onCommit } = await renderHarness("United Airlines");
  await fireEvent.press(screen.getByTestId(`${TEST_ID}-clear`));
  expect(onCommit).toHaveBeenLastCalledWith("");
  expect(screen.getByTestId(TEST_ID).props.value).toBe("");
  expect(request).not.toHaveBeenCalled();
});

it("mirrors the wire cap and surfaces a field error", async () => {
  mockSearch();
  await renderField({ value: "NH", error: "Something" });
  expect(screen.getByTestId(TEST_ID).props.maxLength).toBe(200);
  expect(screen.getByTestId(`${TEST_ID}-error`)).toBeOnTheScreen();
});

it("a failed search never blocks typing", async () => {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockRejectedValue(new Error("offline"));
  await renderHarness();
  await fireEvent.changeText(screen.getByTestId(TEST_ID), "All Nippon");
  expect(await screen.findByTestId(`${TEST_ID}-error-search`)).toBeOnTheScreen();
  expect(screen.getByTestId(TEST_ID).props.editable).not.toBe(false);
});
