/**
 * Trip settings against the REAL tree (T-6.9 / CT-5 — trips spec §2.5,
 * R-tripui-14/18/19/22):
 * - role-gated row visibility matrix (owner / editor / viewer);
 * - every §2.7 trip-settings testID present on the owner render;
 * - the stale-409 conflict walkthrough (R-tripui-19): edit → save →
 *   concurrent-change 409 → REFRESHED values surface in the form + the
 *   non-blocking notice — and the client never silently re-sends (no LWW).
 *
 * renderRouter suite — prod singleton + sanctioned reset recipe (T-6.6 R1);
 * the single interactive test is LAST (harness quirk 3).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

const SETTINGS_URL = `/${TEST_TRIP_ID}/more/settings`;

it("R-tripui-14/18: OWNER sees every row — details form, theme, currency, archive, transfer-first leave, delete", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID, { role: "owner" })] });
  await renderApp(SETTINGS_URL);
  await screen.findByTestId("trip-settings-screen");

  // §2.7 sweep — every spec-mandated testID present on the rendered screen.
  for (const id of [
    "trip-settings-list-item-details",
    "trip-settings-list-item-theme",
    "trip-settings-list-item-currency",
    "trip-settings-list-item-offline",
    "trip-settings-list-item-members",
    "trip-settings-button-leave",
    "trip-settings-button-delete",
    "trip-settings-button-save",
  ]) {
    expect(screen.getByTestId(id)).toBeOnTheScreen();
  }
  expect(screen.getByTestId("trip-settings-input-name")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-settings-button-archive")).toBeOnTheScreen();
  // Owner leave = transfer-first hint, not a leave action (R-tripui-20).
  expect(screen.getByText(/Transfer ownership first/)).toBeOnTheScreen();
});

it("R-tripui-14/18: EDITOR sees the form + theme but no owner-only rows (currency/archive/delete)", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID, { role: "editor" })] });
  await renderApp(SETTINGS_URL);
  await screen.findByTestId("trip-settings-screen");

  expect(screen.getByTestId("trip-settings-list-item-details")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-settings-list-item-theme")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-settings-button-leave")).toBeOnTheScreen();
  expect(screen.queryByTestId("trip-settings-list-item-currency")).toBeNull();
  expect(screen.queryByTestId("trip-settings-button-archive")).toBeNull();
  expect(screen.queryByTestId("trip-settings-button-delete")).toBeNull();
  expect(screen.queryByText(/Transfer ownership first/)).toBeNull();
});

it("R-tripui-14/18: VIEWER sees no edit surfaces at all — only offline, members, leave", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID, { role: "viewer" })] });
  await renderApp(SETTINGS_URL);
  await screen.findByTestId("trip-settings-screen");

  expect(screen.queryByTestId("trip-settings-list-item-details")).toBeNull();
  expect(screen.queryByTestId("trip-settings-input-name")).toBeNull();
  expect(screen.queryByTestId("trip-settings-button-save")).toBeNull();
  expect(screen.queryByTestId("trip-settings-list-item-theme")).toBeNull();
  expect(screen.queryByTestId("trip-settings-list-item-currency")).toBeNull();
  expect(screen.queryByTestId("trip-settings-button-archive")).toBeNull();
  expect(screen.queryByTestId("trip-settings-button-delete")).toBeNull();
  expect(screen.getByTestId("trip-settings-list-item-offline")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-settings-list-item-members")).toBeOnTheScreen();
  expect(screen.getByTestId("trip-settings-button-leave")).toBeOnTheScreen();
});

it("R-tripui-19: stale-409 save → rollback + refetch → fresh values surface + notice; never a silent overwrite", async () => {
  // Interactive (presses) — LAST test in the file (harness quirk 3).
  const t1 = makePlanningTrip(TEST_TRIP_ID, { role: "owner" });
  const t2 = {
    ...t1,
    name: "Renamed by Bob",
    updated_at: "2026-07-02T09:30:00.000Z",
  };
  let patched = false;
  const request = mockNavApi({
    trips: [t1],
    overrides: {
      "PATCH /trips/:tripId": () => {
        patched = true;
        return Promise.reject(
          new ApiRequestError(409, "CONFLICT", "the row changed since it was read", {
            reason: "stale_updated_at",
          }),
        );
      },
      // Bob's save is already committed: the post-conflict refetch sees it.
      "GET /trips/:tripId": () => Promise.resolve(patched ? t2 : t1),
    },
  });
  await renderApp(SETTINGS_URL);
  await screen.findByTestId("trip-settings-screen");

  await fireEvent.changeText(screen.getByTestId("trip-settings-input-name"), "My rename");
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));

  // The wire carried ONLY the touched key + the precondition, echoed verbatim
  // (key-presence authz + the date_trunc-ms round-trip landmine).
  const patchCallsNow = () =>
    request.mock.calls.filter(
      ([descriptor]) => (descriptor as { method: string }).method === "PATCH",
    );
  await waitFor(() => expect(patchCallsNow()).toHaveLength(1));
  const [, patchInput] = patchCallsNow()[0] as [unknown, { body: Record<string, unknown> }];
  expect(Object.keys(patchInput.body).sort()).toEqual(["expect_updated_at", "name"]);
  expect(patchInput.body.expect_updated_at).toBe(t1.updated_at);
  expect(patchInput.body.name).toBe("My rename");

  // Conflict UX: non-blocking notice + the form re-renders with FRESH values.
  expect(await screen.findByTestId("trip-settings-conflict-notice")).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.getByTestId("trip-settings-input-name").props.value).toBe("Renamed by Bob"),
  );
  // No silent LWW: exactly one PATCH went out — the user re-saves, the client
  // never retries over the other writer.
  expect(patchCallsNow()).toHaveLength(1);
});
