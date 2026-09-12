/**
 * A refused save has to say WHY, and land on the field that is wrong (B-26 —
 * closes the B-8 SECONDARY: "surfaces the server's specific reason as the
 * generic 'The booking details don't validate — check the fields'").
 *
 * `save-errors.test.ts` pins the mapping. This file pins that the FORM is
 * wired to it: the banner carries the server's sentence, the field carries
 * its own, and the host is told the save was blocked so it can bring the
 * banner (pinned to the top of a form whose Save button is at the bottom)
 * back on screen.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { ApiRequestError } from "@/auth";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import { BookingForm } from "./BookingForm";

const TRIP = makeTrip({ id: TEST_TRIP_ID });
const CREATE = "POST /trips/:tripId/bookings";
const BANNER = "itinerary-item-new-error";
const SAVE = "itinerary-item-new-button-save";
const TITLE = "itinerary-item-new-input-title";

/** The sentence the OLD code showed for every one of these failures. */
const RETIRED_GENERIC = "The booking details don't validate";

async function renderForm(opts?: {
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}) {
  seedAuthenticated();
  const onSaveBlocked = jest.fn();
  mockNavApi({ trips: [TRIP], overrides: opts?.overrides });
  await renderWithProviders(
    <BookingForm
      trip={TRIP}
      category="flight"
      onDirty={jest.fn()}
      onWriteLanded={jest.fn()}
      onSaved={jest.fn()}
      onSaveBlocked={onSaveBlocked}
    />,
    { queryClient: makeTestQueryClient() },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onSaveBlocked };
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

it("the SERVER's specific reason reaches the banner, verbatim", async () => {
  // The exact B-8 shape: the booking service answers VALIDATION_FAILED with
  // a sentence and no structured details. That sentence is the only place
  // the rule is ever stated, and the old handler replaced it with
  // "Couldn't save the booking. Try again."
  const reason = "the category's primary end time precedes its start time";
  const { onSaveBlocked } = await renderForm({
    overrides: {
      [CREATE]: () => Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", reason)),
    },
  });

  await fireEvent.changeText(screen.getByTestId(TITLE), "SFO to Tokyo");
  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() =>
    expect(screen.getByTestId(BANNER)).toHaveTextContent(
      /primary end time precedes its start time/,
    ),
  );
  expect(screen.queryByText(new RegExp(RETIRED_GENERIC))).toBeNull();
  // The banner is at the top of the form and Save is at the bottom — the
  // host has to be told, or the refusal happens off screen.
  expect(onSaveBlocked).toHaveBeenCalled();
});

it("a server reason that names a FIELD lands on that field, not only in a banner", async () => {
  const { onSaveBlocked } = await renderForm({
    overrides: {
      [CREATE]: () =>
        Promise.reject(
          new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
            formErrors: [],
            fieldErrors: { confirmation_code: ["Too big: expected <=100 characters"] },
          }),
        ),
    },
  });

  await fireEvent.changeText(screen.getByTestId(TITLE), "SFO to Tokyo");
  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-item-new-input-confirmation-error")).toHaveTextContent(
      "Too big: expected <=100 characters",
    ),
  );
  expect(screen.getByTestId(BANNER)).toHaveTextContent(/Confirmation code/);
  expect(onSaveBlocked).toHaveBeenCalled();
});

it("a transport failure reads as offline, not as a validation reason", async () => {
  // `status: 0` means the request never reached the server, so its message
  // ("network request failed") is not an explanation of anything the user
  // typed.
  await renderForm({
    overrides: {
      [CREATE]: () => Promise.reject(new ApiRequestError(0, "NETWORK", "network request failed")),
    },
  });

  await fireEvent.changeText(screen.getByTestId(TITLE), "SFO to Tokyo");
  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() => expect(screen.getByTestId(BANNER)).toHaveTextContent(/offline/i));
  expect(screen.queryByText(/network request failed/)).toBeNull();
});

it("a CLIENT-side field refusal names the field in the banner and blocks the write", async () => {
  const attempts: unknown[] = [];
  const { onSaveBlocked } = await renderForm({
    overrides: {
      [CREATE]: (input) => {
        attempts.push(input);
        return Promise.resolve({});
      },
    },
  });

  // Empty name: `buildDetails`/`save` compute the field error themselves, so
  // the banner's job is to say WHICH field — the part that is off screen.
  await fireEvent.press(screen.getByTestId(SAVE));

  expect(screen.getByTestId(`${TITLE}-error`)).toHaveTextContent(/Give it a name/);
  expect(screen.getByTestId(BANNER)).toHaveTextContent(/Name needs attention/);
  expect(screen.queryByText(new RegExp(RETIRED_GENERIC))).toBeNull();
  expect(onSaveBlocked).toHaveBeenCalled();
  expect(attempts).toEqual([]);
});
