/**
 * Flight-number field (B-9) — the PR #50 rider at the component seam.
 *
 * The gate lives in `useFlightAirlineLookup` (pinned exhaustively in
 * `data/reference.test.tsx`); what this file pins is that the COMPONENT
 * routes its raw field text through that gate rather than around it, and
 * that the inference is offered rather than applied.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { apiClient } from "@/auth";
import { renderWithProviders } from "@/test-utils/render";
import { flightLookupFixture } from "@/test-utils/reference-fixtures";

import { FlightNumberField } from "./FlightNumberField";

const TEST_ID = "itinerary-item-new-input-flight-number";
const SUGGESTION = `${TEST_ID}-airline-suggestion`;

function mockLookup(): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((_descriptor, input?: { query?: Record<string, string> }) =>
    Promise.resolve(flightLookupFixture(input?.query?.["flight_number"] ?? "")),
  );
  return request;
}

async function renderField(
  overrides: Partial<React.ComponentProps<typeof FlightNumberField>> = {},
) {
  const onChangeText = jest.fn();
  const onUseAirline = jest.fn();
  await renderWithProviders(
    <FlightNumberField
      label="Flight number"
      value=""
      onChangeText={onChangeText}
      airlineText=""
      onUseAirline={onUseAirline}
      autoCapitalize="characters"
      autoCorrect={false}
      maxLength={20}
      testID={TEST_ID}
      {...overrides}
    />,
  );
  return { onChangeText, onUseAirline };
}

/** Drain a lookup left in flight, inside act (mobile.md, B-2). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
});

it("fires NO request for input the shared schema/parser rejects — the rider, at the component", async () => {
  const request = mockLookup();
  for (const rejected of ["", "N", "12345", "ANA204"]) {
    await renderField({ value: rejected });
  }
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByTestId(SUGGESTION)).toBeNull();
});

it("offers the resolved airline for a parseable number, sending the canonical key", async () => {
  const request = mockLookup();
  const { onUseAirline } = await renderField({ value: "nh 204" });
  const suggestion = await screen.findByTestId(SUGGESTION);
  expect(suggestion).toHaveTextContent(/Use All Nippon Airways/);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/airlines/flight-lookup" }),
    { query: { flight_number: "NH204" } },
    { signal: expect.any(AbortSignal) },
  );
  await fireEvent.press(suggestion);
  expect(onUseAirline).toHaveBeenCalledWith("All Nippon Airways");
});

it("stays silent when the airline field ALREADY holds that carrier (case-insensitively)", async () => {
  // No clobber, no nag: the offer exists only to fill a gap.
  const request = mockLookup();
  await renderField({ value: "NH204", airlineText: "  all nippon airways " });
  // Settle the lookup FIRST — asserting "no suggestion" while the query is
  // still pending would pass whatever the component decides afterwards
  // (and leave a floating act for a later suite).
  await waitFor(() => expect(request).toHaveBeenCalled());
  await settle();
  expect(screen.queryByTestId(SUGGESTION)).toBeNull();
});

it("still offers when the airline field holds a DIFFERENT carrier — the user decides", async () => {
  // Falsification for the pin above: a component that never offered once
  // `airlineText` was non-empty would pass that one and fail this.
  mockLookup();
  await renderField({ value: "NH204", airlineText: "United Airlines" });
  expect(await screen.findByTestId(SUGGESTION)).toBeOnTheScreen();
});

it("an UNKNOWN designator is silent, never an error surface", async () => {
  // The lookup is soft by design (200 with nulls) so a half-typed number
  // can't turn the field red mid-keystroke. Settled first — see above.
  const request = mockLookup();
  await renderField({ value: "ZZ999" });
  await waitFor(() => expect(request).toHaveBeenCalled());
  await settle();
  expect(screen.queryByTestId(SUGGESTION)).toBeNull();
  expect(screen.getByTestId(TEST_ID)).toBeOnTheScreen();
});

it("passes the B-20 designator traits straight through to the Input", async () => {
  mockLookup();
  await renderField({ value: "UA837" });
  const input = screen.getByTestId(TEST_ID);
  expect(input.props.autoCapitalize).toBe("characters");
  expect(input.props.autoCorrect).toBe(false);
  expect(input.props.maxLength).toBe(20);
  // Settle the lookup this value started — an un-drained notify lands as a
  // floating act in a LATER suite (mobile.md, B-2).
  await screen.findByTestId(SUGGESTION);
});
