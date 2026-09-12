/**
 * The required marker FOLLOWS the shared schema (B-26 — device QA
 * 2026-09-11: "there's no indicator of what fields are required").
 *
 * `required-fields.test.ts` proves the derivation reads a schema. This file
 * proves the RENDERED form is wired to that derivation and not to a
 * hardcoded list: it swaps `BookingCreateSchema`'s optionality for one field
 * and the marker moves with it. A hand-listed form passes the "Name is
 * marked" arm and fails this one.
 *
 * The mock is `requireActual`-spread — everything except the one schema
 * under test is the real module (the T-5.7 lesson: a wholesale feature-module
 * mock hides render-time crashes in the thing you are testing).
 */
import type { BookingCategory } from "@gogo/shared";
import { act, screen } from "@testing-library/react-native";

import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

/**
 * Optionality of the ONE key this file mutates. Read inside the factory (a
 * `jest.mock` factory may not close over anything initialized later), so a
 * test can flip it before rendering.
 */
const schemaState: { confirmationRequired: boolean } = { confirmationRequired: false };

jest.mock("@gogo/shared", () => {
  const actual = jest.requireActual("@gogo/shared");
  const base = actual.BookingCreateSchema;
  return {
    ...actual,
    // A functional stand-in, not a partial clone: `safeParse` still runs the
    // REAL schema (the save path must stay honest), while `.shape` — the only
    // thing the derivation reads — reports the mutated optionality.
    BookingCreateSchema: {
      safeParse: (value: unknown) => base.safeParse(value),
      get shape() {
        return {
          ...base.shape,
          confirmation_code: schemaState.confirmationRequired
            ? { safeParse: (value: unknown) => ({ success: value !== undefined }) }
            : base.shape.confirmation_code,
        };
      },
    },
  };
});

// Imported AFTER the mock so the form resolves the patched module.
// eslint-disable-next-line import/first
import { BookingForm } from "./BookingForm";

const TRIP = makeTrip({ id: TEST_TRIP_ID });

async function renderForm(category: BookingCategory = "flight") {
  seedAuthenticated();
  mockNavApi({ trips: [TRIP] });
  await renderWithProviders(
    <BookingForm
      trip={TRIP}
      category={category}
      onDirty={jest.fn()}
      onWriteLanded={jest.fn()}
      onSaved={jest.fn()}
    />,
    { queryClient: makeTestQueryClient() },
  );
  // Drain the mount queries' notify batch inside act (RNTL v14 / B-2): the
  // DeeplinkPanel's reads settle on a notifyManager timer, and an
  // unflushed one lands during a LATER suite.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  schemaState.confirmationRequired = false;
  jest.restoreAllMocks();
});

it("marks Name required — with a legend saying what the marker means", async () => {
  await renderForm();
  expect(screen.getByTestId("itinerary-item-new-input-title-required")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-item-new-required-legend")).toHaveTextContent("* Required");
  // A screen reader hears it on the input itself, not just as a glyph.
  expect(screen.getByTestId("itinerary-item-new-input-title").props.accessibilityLabel).toBe(
    "Name, required",
  );
});

it("marks nothing the contract calls optional — the marker is not decoration", async () => {
  await renderForm();
  for (const id of [
    "itinerary-item-new-input-confirmation",
    "itinerary-item-new-input-price",
    "itinerary-item-new-input-currency",
    "itinerary-item-new-input-airline",
    "itinerary-item-new-input-origin-iata",
  ]) {
    expect(screen.queryByTestId(`${id}-required`)).toBeNull();
  }
  expect(screen.getByTestId("itinerary-item-new-input-confirmation").props.accessibilityLabel).toBe(
    "Confirmation code",
  );
});

it("MUTATION: make the SCHEMA require confirmation_code and the marker follows", async () => {
  // Nothing in `apps/mobile` is edited between the arm above and this one —
  // only the contract's answer changes. A hardcoded list cannot do this.
  schemaState.confirmationRequired = true;
  await renderForm();
  expect(screen.getByTestId("itinerary-item-new-input-confirmation-required")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-item-new-input-confirmation").props.accessibilityLabel).toBe(
    "Confirmation code, required",
  );
  // And Name is still marked — the derivation widened, it did not move.
  expect(screen.getByTestId("itinerary-item-new-input-title-required")).toBeOnTheScreen();
});
