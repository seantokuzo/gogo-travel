/**
 * Airport typeahead (B-9) — the states the screen suite can't reach cheaply:
 * the search gate, the empty and error surfaces, the clear affordance, and
 * PICK-VOIDS-ON-EDIT (the invariant that keeps the committed code and the
 * visible text from disagreeing).
 */
import type { Airport } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { apiClient } from "@/auth";
import { renderWithProviders } from "@/test-utils/render";
import { DEFAULT_AIRPORTS, searchAirportFixtures } from "@/test-utils/reference-fixtures";

import { AirportPickerField, airportSubtitle, pickedAirportLabel } from "./AirportPickerField";

const TEST_ID = "itinerary-item-new-input-origin-iata";

function mockSearch(): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((_descriptor, input?: { query?: Record<string, string> }) =>
    Promise.resolve(searchAirportFixtures(input?.query?.["q"] ?? "")),
  );
  return request;
}

async function renderField(
  overrides: Partial<React.ComponentProps<typeof AirportPickerField>> = {},
) {
  const onChangeText = jest.fn();
  const onPickAirport = jest.fn();
  await renderWithProviders(
    <AirportPickerField
      label="From (IATA)"
      value=""
      onChangeText={onChangeText}
      onPickAirport={onPickAirport}
      referenceDate="2027-04-24"
      testID={TEST_ID}
      {...overrides}
    />,
  );
  return { onChangeText, onPickAirport };
}

afterEach(async () => {
  // Drain the typeahead query still in flight when a test ends: TanStack's
  // notifyManager batches through a setTimeout, so an un-drained settle
  // lands DURING A LATER SUITE as a floating act (mobile.md, B-2). The
  // determinism gate greps for exactly that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

describe("commit rules", () => {
  it("a bare 3-letter entry commits as a CODE — hand-typing works with no network", async () => {
    mockSearch();
    const { onChangeText } = await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "nrt");
    // Uppercased on the way in (device parity with autoCapitalize) AND on
    // the way out (the wire wants the code).
    expect(onChangeText).toHaveBeenLastCalledWith("NRT");
    expect(screen.getByTestId(TEST_ID).props.value).toBe("NRT");
    // Settle the search this typing started: an un-drained TanStack notify
    // lands during a LATER suite as a floating act (mobile.md, B-2).
    await screen.findByTestId(`${TEST_ID}-result-NRT`);
  });

  it("free text commits VERBATIM — the wire is still optionalString(200), so 'NARITA' must reach the save gate", async () => {
    // B-9 does NOT narrow the shared schema (Q2 stays Sean's ruling): the
    // 3-letter rule is the SAVE gate's, and it only fires on dirty values.
    mockSearch();
    const { onChangeText } = await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "Narita");
    expect(onChangeText).toHaveBeenLastCalledWith("NARITA");
    await screen.findByTestId(`${TEST_ID}-result-NRT`);
  });

  it("clear empties both the box and the committed value — and leaves no search behind", async () => {
    const request = mockSearch();
    const { onChangeText } = await renderField({ value: "NRT" });
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-clear`));
    expect(onChangeText).toHaveBeenLastCalledWith("");
    expect(screen.getByTestId(TEST_ID).props.value).toBe("");
    // Clearing un-picks the field; `useDeferredValue` lags a render, so
    // without the live-value gate this fires (and aborts) a search for the
    // text just deleted.
    expect(request).not.toHaveBeenCalled();
  });
});

describe("search gate + results", () => {
  it("an EMPTY box fires nothing and renders no result surface", async () => {
    const request = mockSearch();
    await renderField();
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`${TEST_ID}-result-NRT`)).toBeNull();
  });

  it("a PREFILLED field starts settled — opening a stored booking drops no result list", async () => {
    // "NRT" is a perfectly searchable query, so without the settled-on-mount
    // guard every flight EDIT would open with a dropdown over the form and
    // burn a reference request for a value the user never typed.
    const request = mockSearch();
    await renderField({ value: "NRT" });
    await waitFor(() => expect(screen.queryByTestId(`${TEST_ID}-result-NRT`)).toBeNull());
    expect(request).not.toHaveBeenCalled();
  });

  it("a pick commits the CODE and hands up the airport (zone and all)", async () => {
    mockSearch();
    const { onChangeText, onPickAirport } = await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "Narita");
    // Typing already committed the free text ("NARITA"); the PICK must
    // replace it through the airport handler, not through another text
    // commit — otherwise the code and the zone could arrive separately.
    onChangeText.mockClear();
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-result-NRT`));

    const picked = onPickAirport.mock.calls[0]?.[0] as Airport;
    expect(picked.iata).toBe("NRT");
    expect(picked.tz).toBe("Asia/Tokyo");
    // The visible text becomes the friendly label; the results close.
    expect(screen.getByTestId(TEST_ID).props.value).toBe("NRT · Tokyo");
    await waitFor(() => expect(screen.queryByTestId(`${TEST_ID}-result-NRT`)).toBeNull());
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it("PICK-VOIDS-ON-EDIT: typing after a pick re-opens the search and re-commits the text", async () => {
    // Without this, the committed IATA could stay "NRT" while the box read
    // something else entirely — the structured-input invariant.
    mockSearch();
    const { onChangeText } = await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "Narita");
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-result-NRT`));
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "LAX");
    expect(onChangeText).toHaveBeenLastCalledWith("LAX");
    expect(await screen.findByTestId(`${TEST_ID}-result-LAX`)).toBeOnTheScreen();
  });

  it("no matches → a hint that names the escape hatch, not an error", async () => {
    mockSearch();
    await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "ZZZZZZ");
    expect(await screen.findByTestId(`${TEST_ID}-empty`)).toBeOnTheScreen();
  });

  it("a failed search is retryable and never blocks typing a code by hand", async () => {
    const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
    request.mockRejectedValue(new Error("offline"));
    await renderField();
    await fireEvent.changeText(screen.getByTestId(TEST_ID), "Narita");
    expect(await screen.findByTestId(`${TEST_ID}-error-search`)).toBeOnTheScreen();
    expect(screen.getByTestId(TEST_ID).props.editable).not.toBe(false);
  });

  it("surfaces the field error from the save gate", async () => {
    mockSearch();
    await renderField({ value: "NR", error: "3-letter airport code, like NRT." });
    expect(screen.getByTestId(`${TEST_ID}-error`)).toBeOnTheScreen();
  });
});

describe("row copy", () => {
  it("the picked label prefers the city; the row subtitle names the zone", () => {
    const nrt = DEFAULT_AIRPORTS.find((airport) => airport.iata === "NRT");
    expect(nrt).toBeDefined();
    if (nrt === undefined) return;
    expect(pickedAirportLabel(nrt)).toBe("NRT · Tokyo");
    // The zone is visible BEFORE the pick — the user sees what will be
    // stamped rather than discovering it after saving (the B-8 lesson).
    expect(airportSubtitle(nrt, "GMT+9")).toContain("Asia/Tokyo (GMT+9)");
    expect(airportSubtitle(nrt, null)).toContain("Asia/Tokyo");
    // A city-less row degrades to the code, never to "undefined".
    expect(pickedAirportLabel({ ...nrt, city: null })).toBe("NRT");
  });
});
