/**
 * Dirty-dismiss guard against the REAL tree (T-6.7 R1 blocking; R-tripui-8,
 * nav §2.6 form-modal rule). `new.tsx` is the repo's FIRST `beforeRemove`
 * consumer on the vendored expo-router fork — the screen-level suite drives
 * a hand-rolled mock navigator, which proves the listener's logic but not
 * that the fork actually emits the event or honors `preventDefault`. This
 * walkthrough proves both, end to end:
 *
 *   dirty form → cancel press → router.back() → vendored navigator emits
 *   beforeRemove → preventDefault HOLDS the modal (still mounted, dialog
 *   up) → keep-editing closes the dialog in place → cancel again → confirm
 *   discard → the stashed action is dispatched → back on the trip list.
 *
 * ONE interactive test only (renderRouter quirk 3) in its own file — the
 * create walkthrough owns trip-create-flow.test.tsx's single slot.
 * renderRouter suite ⇒ prod-singleton reset recipe (mobile.md).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { renderApp } from "@/test-utils/render-app";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-tripui-8: the vendored navigator emits beforeRemove — a dirty modal is HELD, keep-editing stays, discard dismisses", async () => {
  mockNavApi({
    overrides: { "GET /users/me": () => Promise.resolve(TEST_USER) },
  });
  // Enter the modal the way users do — list → FAB — so the stack has the
  // list beneath and cancel's back() is a REAL pop (a cold "/new" URL
  // mounts no list underneath; that path takes the replace fallback).
  const result = await renderApp("/");
  await screen.findByTestId("trip-list-screen");
  await fireEvent.press(screen.getByTestId("trip-list-fab-create"));
  expect(await screen.findByTestId("trip-new-screen")).toBeOnTheScreen();

  // Dirty the form, then ask the navigator to go back.
  await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "Kyoto Spring");
  await fireEvent.press(screen.getByTestId("trip-new-button-cancel"));

  // preventDefault held the route: modal still mounted, discard dialog up.
  expect(await screen.findByTestId("trip-new-button-cancel-confirm")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-new-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe("/new");

  // Keep editing: dialog closes, form intact, still on the modal.
  await fireEvent.press(screen.getByTestId("trip-new-button-cancel-cancel"));
  await waitFor(() =>
    expect(screen.queryByTestId("trip-new-button-cancel-confirm")).toBeNull(),
  );
  expect(screen.getByTestId("trip-new-input-name").props.value).toBe("Kyoto Spring");
  expect(result.getPathname()).toBe("/new");

  // Discard: the stashed navigation action resumes — modal gone, trip list.
  await fireEvent.press(screen.getByTestId("trip-new-button-cancel"));
  await fireEvent.press(await screen.findByTestId("trip-new-button-cancel-confirm"));
  await waitFor(() => expect(screen.queryByTestId("trip-new-screen")).toBeNull());
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
});
