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
 *
 * Round-1 review B3 (`.tmp/review-67/round-1/correctness.md`): the CREATE
 * arms above pin `create.onMutationError` (BookingForm.tsx:305) and the
 * CREATE schema-parse branch (:530-536), but the EDIT-mode twins
 * (`update.onMutationError` at :310, the UPDATE schema-parse branch at
 * :551-554) had zero coverage — reverting BOTH to the retired generic
 * banners left the whole suite green. Falsification (mutation-verify): the
 * three "EDIT mode" arms below go RED if either handler is reverted to
 * `setFormError(<generic>)`; the "CLIENT-side schema-only refusal" arm goes
 * RED if BookingUpdateSchema stops being re-checked client-side (or the
 * check is dropped) — recorded per-arm in the PR body mutation table.
 *
 * Round-1 A4: `schedule.onMutationError` (BookingForm.tsx:277-286) landed
 * the booking (create succeeded) but never called `onSaveBlocked`, so the
 * "saved to Ideas" warning — rendered at the TOP of the form, same as every
 * other banner — could land off screen exactly like the defect this PR
 * exists to kill, on the one path where something already exists server-side
 * (a retry there would duplicate it). The "A4" arm below pins the call.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import type { BookingWithItems, ISODate } from "@gogo/shared";

import { ApiRequestError } from "@/auth";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { BOOKING_IDEA_ID, makeBooking } from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import { BookingForm } from "./BookingForm";

const TRIP = makeTrip({ id: TEST_TRIP_ID });
const CREATE = "POST /trips/:tripId/bookings";
const UPDATE = "PATCH /trips/:tripId/bookings/:bookingId";
const SCHEDULE = "POST /trips/:tripId/bookings/:bookingId/schedule";
const BANNER = "itinerary-item-new-error";
const SAVE = "itinerary-item-new-button-save";
const TITLE = "itinerary-item-new-input-title";
const SAVED_TO_IDEAS = "itinerary-item-new-saved-to-ideas";

/** The sentence the OLD code showed for every one of these failures. */
const RETIRED_GENERIC = "The booking details don't validate";

/** The EDIT-mode arms open this — details bare on purpose: every flight
 *  detail field is `.optional()` (module doc), so a near-empty row is a
 *  valid `BookingUpdate` candidate and Save reaches the wire without any
 *  other field needing to change first. */
const EXISTING_BOOKING: BookingWithItems = {
  ...makeBooking({
    id: BOOKING_IDEA_ID,
    category: "flight",
    status: "idea",
    starts_at: null,
    title: "SFO to Tokyo",
    details: { category: "flight" },
  }),
  items: [],
};

async function renderForm(opts?: {
  booking?: BookingWithItems;
  prefillDay?: ISODate;
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}) {
  seedAuthenticated();
  const onSaveBlocked = jest.fn();
  const onWriteLanded = jest.fn();
  mockNavApi({ trips: [TRIP], overrides: opts?.overrides });
  await renderWithProviders(
    <BookingForm
      trip={TRIP}
      category="flight"
      booking={opts?.booking}
      prefillDay={opts?.prefillDay}
      onDirty={jest.fn()}
      onWriteLanded={onWriteLanded}
      onSaved={jest.fn()}
      onSaveBlocked={onSaveBlocked}
    />,
    { queryClient: makeTestQueryClient() },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onSaveBlocked, onWriteLanded };
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

// ---------------------------------------------------------------------------
// B-26 R1 (round-1 review B3) — the EDIT-mode twin of the arms above.
// `update.onMutationError` (BookingForm.tsx:310) is a SEPARATE closure from
// `create.onMutationError` (:305) — both call the same `saveFailureFor`, but
// nothing stops a future edit ONLY reverting the update handler back to the
// retired generic banner, and the CREATE arms above cannot catch that: they
// never mount `booking`, so `editing` is always false and :310/:551 never
// run. Mutation-verified: reverting :310 (or :553) alone turns exactly the
// matching arm below RED while the CREATE arms stay green.
// ---------------------------------------------------------------------------

it("EDIT mode: the SERVER's specific reason reaches the banner, verbatim (BookingForm.tsx:310)", async () => {
  const reason = "the category's primary end time precedes its start time";
  const { onSaveBlocked } = await renderForm({
    booking: EXISTING_BOOKING,
    overrides: {
      [UPDATE]: () => Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", reason)),
    },
  });

  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() =>
    expect(screen.getByTestId(BANNER)).toHaveTextContent(
      /primary end time precedes its start time/,
    ),
  );
  expect(screen.queryByText(new RegExp(RETIRED_GENERIC))).toBeNull();
  expect(onSaveBlocked).toHaveBeenCalled();
});

it("EDIT mode: a server reason that names a FIELD lands on that field (BookingForm.tsx:310)", async () => {
  const { onSaveBlocked } = await renderForm({
    booking: EXISTING_BOOKING,
    overrides: {
      [UPDATE]: () =>
        Promise.reject(
          new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
            formErrors: [],
            fieldErrors: { confirmation_code: ["Too big: expected <=100 characters"] },
          }),
        ),
    },
  });

  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-item-new-input-confirmation-error")).toHaveTextContent(
      "Too big: expected <=100 characters",
    ),
  );
  expect(screen.getByTestId(BANNER)).toHaveTextContent(/Confirmation code/);
  expect(onSaveBlocked).toHaveBeenCalled();
});

it("EDIT mode: a CLIENT-side schema-only refusal blocks the write before any network call (BookingForm.tsx:551-554)", async () => {
  // `Input`'s `maxLength={100}` is a soft UI cap RNTL's `fireEvent` does not
  // enforce (unlike a real OS keyboard) — deliberately exploited here so the
  // ACTUAL safety net (BookingUpdateSchema.safeParse re-checking client-side,
  // never trusting the control) is what is under test, not the input's own
  // truncation. `errors` in `save()` has no manual confirmation-length
  // check, so this reaches Zod, not the earlier :496 exit.
  const patched: unknown[] = [];
  const { onSaveBlocked } = await renderForm({
    booking: EXISTING_BOOKING,
    overrides: {
      [UPDATE]: (input) => {
        patched.push(input);
        return Promise.resolve(EXISTING_BOOKING);
      },
    },
  });

  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-confirmation"),
    "A".repeat(150),
  );
  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-item-new-input-confirmation-error")).toHaveTextContent(
      /100 character/,
    ),
  );
  expect(screen.getByTestId(BANNER)).toHaveTextContent(/Confirmation code/);
  expect(onSaveBlocked).toHaveBeenCalled();
  // The schema rejected the candidate before `update.mutate` ever ran.
  expect(patched).toEqual([]);
});

// ---------------------------------------------------------------------------
// A4 — the create-then-schedule partial failure (BookingForm.tsx:277-286).
// ---------------------------------------------------------------------------

it("A4: a day-only create that lands but fails to schedule still blocks the save", async () => {
  // §2.4 routing: a day-picked TIMELESS create (no time typed) chains to the
  // schedule endpoint. The booking already EXISTS when that step 400s — the
  // "saved to Ideas" warning renders at the top of the form same as every
  // other banner, and a refusal that never calls `onSaveBlocked` is the
  // identical off-screen symptom B-26 exists to kill, on the one path where
  // a retry would duplicate a booking that is already there.
  const { onSaveBlocked, onWriteLanded } = await renderForm({
    prefillDay: "2027-03-01" as ISODate,
    overrides: {
      [CREATE]: () =>
        Promise.resolve(
          makeBooking({ id: BOOKING_IDEA_ID, category: "flight", status: "idea", starts_at: null }),
        ),
      [SCHEDULE]: () =>
        Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", "day is outside the trip")),
    },
  });

  await fireEvent.changeText(screen.getByTestId(TITLE), "SFO to Tokyo");
  await fireEvent.press(screen.getByTestId(SAVE));

  await waitFor(() => expect(screen.getByTestId(SAVED_TO_IDEAS)).toBeOnTheScreen());
  expect(onWriteLanded).toHaveBeenCalled();
  expect(onSaveBlocked).toHaveBeenCalled();
});
