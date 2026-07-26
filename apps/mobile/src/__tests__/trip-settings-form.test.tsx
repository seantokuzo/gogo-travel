/**
 * Trip-settings mutation flows at component grain (T-6.9 / CT-5 — trips spec
 * §2.5/§2.6). renderRouter files carry ONE interactive flow each (harness
 * quirk 3), so the press-heavy wire/cache assertions live here with the
 * network boundary mocked by descriptor and expo-router stubbed (the
 * profile-screen convention). The load-bearing pins:
 *
 * - archive/unarchive send EXACTLY {status, expect_updated_at} — the
 *   key-presence authz landmine: an archive press must never drag other keys
 *   (and {status: null} must survive as an explicit null);
 * - a details save sends ONLY the touched key(s) — an editor renaming a trip
 *   never smuggles owner-only keys;
 * - theme change applies optimistically and ROLLS BACK on failure with an
 *   error surface (R-tripui-21);
 * - the base-currency 409 maps to the read-only locked explainer (§2.5) with
 *   the cache rolled back — no phantom currency change.
 */
import type { Trip, TripListItem } from "@gogo/shared";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import TripSettingsScreen from "@/app/[tripId]/more/settings";
import { apiClient, ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makePlanningTrip } from "@/test-utils/trip-fixtures";

jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// Synchronous TanStack notify for THIS suite: the default scheduler batches
// store notifications on setTimeout(0), and any batch firing inside a
// waitFor SLEEP window (RNTL only act-wraps the checks) lands un-acted —
// a contention-only act warning (B-2 family; ~1/8 under --maxWorkers=2).
// Sync scheduling makes every notify run inside whatever act window caused
// it. Module state is per test file, so nothing leaks across suites.
beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function seededClient(trip: TripListItem): QueryClient {
  const client = makeTestQueryClient();
  client.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryDefaults(queryKeys.trips, { gcTime: Infinity });
  client.setQueryData(queryKeys.trip(TEST_TRIP_ID), trip);
  client.setQueryData(queryKeys.trips, { items: [trip], nextCursor: null });
  return client;
}

async function renderSettings(trip: TripListItem, client: QueryClient) {
  seedAuthenticated();
  return renderWithProviders(
    <TripProvider trip={trip}>
      <TripSettingsScreen />
    </TripProvider>,
    { queryClient: client },
  );
}

function patchBodies(request: jest.Mock): Record<string, unknown>[] {
  return request.mock.calls
    .filter(([descriptor]) => (descriptor as { method: string }).method === "PATCH")
    .map(([, input]) => (input as { body: Record<string, unknown> }).body);
}

/**
 * Run TanStack's batched notify (setTimeout 0) INSIDE act. The async
 * `onMutate` (cancelQueries) defers the pending-state dispatch past the
 * press's act window, so its notify would otherwise fire un-acted in the gap
 * before the next `waitFor` (B-2 family). Call after every mutating press.
 */
async function drainNotify(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  // Drain TanStack's queued notifyManager macrotasks inside act — TWO hops,
  // the second runs batches the first one's effects queued (B-2 family;
  // profile-screen convention).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

it("archive sends EXACTLY {status:'past', expect_updated_at} and applies the override optimistically", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  let resolvePatch: (row: Trip) => void = () => undefined;
  request.mockImplementation(() => new Promise((resolve) => (resolvePatch = resolve)));
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-button-archive"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  expect(patchBodies(request)[0]).toEqual({
    status: "past",
    expect_updated_at: trip.updated_at,
  });
  // Optimistic: effective status pinned by the override before the server answers.
  const optimistic = client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID));
  expect(optimistic?.status).toBe("past");
  expect(optimistic?.status_override).toBe("past");

  await act(async () =>
    resolvePatch({
      ...trip,
      status: "past",
      status_override: "past",
      updated_at: "2026-07-21T00:00:00.000Z",
    }),
  );
  // Observe the settle INSIDE act (waitFor wraps) — the reconcile lands the
  // echoed updated_at that the next expect_updated_at must round-trip.
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.updated_at).toBe(
      "2026-07-21T00:00:00.000Z",
    ),
  );
});

it("unarchive sends the EXPLICIT null override ({status: null}) and derives the status back optimistically", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { status: "past", status_override: "past" });
  const client = seededClient(trip);
  const request = spyRequest();
  let resolvePatch: (row: Trip) => void = () => undefined;
  request.mockImplementation(() => new Promise((resolve) => (resolvePatch = resolve)));
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-button-archive"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  // The falsy-value pin: null must SURVIVE onto the wire (clears the override).
  expect(patchBodies(request)[0]).toEqual({
    status: null,
    expect_updated_at: trip.updated_at,
  });
  const optimistic = client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID));
  expect(optimistic?.status_override).toBeNull();
  // Dates are 30 days out (fixture) → derivation resumes to planning.
  expect(optimistic?.status).toBe("planning");

  // Settle before teardown — a mutation left PENDING at suite end is an open
  // handle under real timers (jest never exits; caught live in T-6.9).
  await act(async () =>
    resolvePatch({
      ...trip,
      status: "planning",
      status_override: null,
      updated_at: "2026-07-21T00:00:00.000Z",
    }),
  );
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.updated_at).toBe(
      "2026-07-21T00:00:00.000Z",
    ),
  );
});

it("an editor's rename sends ONLY {name, expect_updated_at} — owner-only keys never ride along", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { role: "editor" });
  const client = seededClient(trip);
  const request = spyRequest();
  request.mockResolvedValue({ ...trip, name: "Kyoto II", updated_at: "2026-07-21T00:00:00.000Z" });
  await renderSettings(trip, client);

  await fireEvent.changeText(screen.getByTestId("trip-settings-input-name"), "Kyoto II");
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  expect(Object.keys(patchBodies(request)[0] ?? {}).sort()).toEqual([
    "expect_updated_at",
    "name",
  ]);
  // Wait out the success settle inside act (reconcile writes the new row).
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.name).toBe("Kyoto II"),
  );
});

it("theme change applies optimistically and rolls back with an error banner on failure (R-tripui-21)", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  let rejectPatch: (error: Error) => void = () => undefined;
  request.mockImplementation(() => new Promise((_, reject) => (rejectPatch = reject)));
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-list-item-theme"));
  await fireEvent.press(screen.getByTestId("trip-settings-theme-option-deepWaters"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  expect(patchBodies(request)[0]).toEqual({
    theme: "deepWaters",
    expect_updated_at: trip.updated_at,
  });
  // Optimistic apply on BOTH caches…
  expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.theme).toBe("deepWaters");

  // …rolled back wholesale on failure, with a user-visible surface.
  await act(async () => rejectPatch(new ApiRequestError(500, "INTERNAL", "boom")));
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.theme).toBeNull(),
  );
  const page = client.getQueryData<{ items: Trip[] }>(queryKeys.trips);
  expect(page?.items[0]?.theme).toBeNull();
  expect(await screen.findByTestId("trip-settings-error")).toBeOnTheScreen();
});

it("base-currency 409 → the §2.5 locked explainer, row read-only, cache rolled back", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  request.mockRejectedValue(
    new ApiRequestError(409, "CONFLICT", "base currency is locked once the first expense exists", {
      reason: "base_currency_locked",
    }),
  );
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-list-item-currency"));
  await fireEvent.changeText(screen.getByTestId("trip-settings-input-currency"), "eur");
  await fireEvent.press(screen.getByTestId("trip-settings-button-currency-save"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  // Input uppercases; only the currency key + precondition go out.
  expect(patchBodies(request)[0]).toEqual({
    base_currency: "EUR",
    expect_updated_at: trip.updated_at,
  });

  // The locked explainer replaces the picker affordance (read-only row)…
  expect(await screen.findByText(/Locked — the trip already has expenses/)).toBeOnTheScreen();
  // …the cache rolled back (no phantom EUR anywhere)…
  expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.base_currency).toBe("USD");
  // …and it is NOT the stale-conflict flow: no refetch notice, no invalidation.
  expect(screen.queryByTestId("trip-settings-conflict-notice")).toBeNull();
  expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))?.isInvalidated).toBe(false);
});

it("a pristine form's save is a no-op: nothing changed ⇒ no request at all", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  await renderSettings(trip, client);

  // Save is disabled while pristine — but even a forced press must not fire:
  // buildTripPatch returns null and the screen skips the mutation.
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  expect(patchBodies(request)).toHaveLength(0);
});
