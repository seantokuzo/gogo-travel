/**
 * Trip-settings mutation flows at component grain (T-6.9 / CT-5 — trips spec
 * §2.5/§2.6). renderRouter files carry ONE interactive flow each (harness
 * quirk 3), so the press-heavy wire/cache assertions live here with the
 * network boundary mocked by descriptor and expo-router stubbed (the
 * profile-screen convention). The load-bearing pins:
 *
 * - a details save sends ONLY the touched key(s) — an editor renaming a trip
 *   never smuggles owner-only keys;
 * - the hook-level mutation seam survives SUPERSEDED calls (round-1 blocker:
 *   two overlapping PATCHes on the shared useUpdateTrip — per-call callbacks
 *   would silently drop the first's error surface);
 * - destination edits ride the CT-2 structured search (pick required, all
 *   three destination fields travel together);
 * - date edits ride DateField; the order rule is the only reachable error;
 * - theme change applies optimistically and ROLLS BACK on failure with an
 *   error surface (R-tripui-21); a garbage stored theme key ("constructor")
 *   renders raw instead of crashing (round-1 security pin);
 * - the base-currency 409 maps to the read-only locked explainer (§2.5);
 * - leave's error branches: 404 converges to exit + list invalidation
 *   (§3.5 rule 3), owner-leave 409 maps to the shared banner copy.
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
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makePlace, makePlanningTrip } from "@/test-utils/trip-fixtures";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: mockReplace }),
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
  client.setQueryDefaults(queryKeys.tripsList, { gcTime: Infinity });
  client.setQueryData(queryKeys.trip(TEST_TRIP_ID), trip);
  client.setQueryData(queryKeys.trips, { items: [trip], nextCursor: null });
  client.setQueryData(queryKeys.tripsList, {
    pages: [{ items: [trip], nextCursor: null }],
    pageParams: [undefined],
  });
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
 * Drive a DateField (trip-new convention): press the field row to reveal the
 * platform picker, then fire the native change event. LOCAL noon keeps the
 * picked calendar day tz-stable on any runner.
 */
async function pickDate(fieldTestID: string, y: number, m: number, d: number) {
  await fireEvent.press(screen.getByTestId(fieldTestID));
  await fireEvent(screen.getByTestId(`${fieldTestID}-picker`), "onChange", {
    nativeEvent: { timestamp: new Date(y, m - 1, d, 12).getTime(), utcOffset: 0 },
  });
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
  mockReplace.mockClear();
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

it("hook-level seam: a SUPERSEDED patch's failure still surfaces the banner (round-1 blocker pin)", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  const settlers: { resolve(row: Trip): void; reject(error: Error): void }[] = [];
  request.mockImplementation(
    () => new Promise((resolve, reject) => settlers.push({ resolve, reject })),
  );
  await renderSettings(trip, client);

  // PATCH 1 (theme) in flight…
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-theme"));
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-theme-deepWaters"));
  await drainNotify();
  // …PATCH 2 (currency) supersedes it on the SHARED mutation instance.
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-currency"));
  await fireEvent.changeText(screen.getByTestId("trip-settings-input-currency"), "EUR");
  await fireEvent.press(screen.getByTestId("trip-settings-button-currency-save"));
  await drainNotify();
  expect(settlers).toHaveLength(2);

  // The SUPERSEDED first call fails — per-call callbacks are dropped by v5,
  // so only the hook-level seam can surface this (T-6.8 R1 defect class).
  await act(async () => settlers[0]?.reject(new ApiRequestError(500, "INTERNAL", "boom")));
  expect(await screen.findByTestId("trip-settings-banner")).toBeOnTheScreen();

  // Settle the second before teardown (pending mutation = open handle).
  await act(async () =>
    settlers[1]?.resolve({
      ...trip,
      base_currency: "EUR",
      updated_at: "2026-07-21T00:00:00.000Z",
    }),
  );
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.base_currency).toBe("EUR"),
  );
});

it("destination edit rides the CT-2 structured search: pick required, all three fields travel together", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const osaka = makePlace({ name: "Osaka, Japan", lat: 34.6937, lng: 135.5023 });
  const request = spyRequest();
  request.mockImplementation((descriptor: { method: string; path: string }) => {
    if (descriptor.path === "/places/search") {
      return Promise.resolve({ items: [osaka], nextCursor: null });
    }
    if (descriptor.method === "PATCH") {
      return Promise.resolve({
        ...trip,
        destination_name: osaka.name,
        destination_lat: osaka.lat,
        destination_lng: osaka.lng,
        updated_at: "2026-07-21T00:00:00.000Z",
      });
    }
    return Promise.reject(new Error(`unexpected ${descriptor.method} ${descriptor.path}`));
  });
  await renderSettings(trip, client);

  // Edited text WITHOUT a pick cannot save (no free text — §2.3 posture).
  await fireEvent.changeText(screen.getByTestId("trip-settings-input-destination"), "Osaka");
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  expect(patchBodies(request)).toHaveLength(0);
  expect(await screen.findByText(/Pick a destination from the search results/)).toBeOnTheScreen();

  // Pick from the typeahead, then save: name/lat/lng travel TOGETHER.
  await fireEvent.press(await screen.findByTestId(`trip-settings-list-item-destination-${osaka.id}`));
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  expect(patchBodies(request)[0]).toEqual({
    destination_name: osaka.name,
    destination_lat: osaka.lat,
    destination_lng: osaka.lng,
    expect_updated_at: trip.updated_at,
  });
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.destination_name).toBe(
      osaka.name,
    ),
  );
});

it("date edit saves ONLY the changed date; picking end before start blocks with the order error", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const client = seededClient(trip);
  const request = spyRequest();
  let resolvePatch: (row: Trip) => void = () => undefined;
  request.mockImplementation(() => new Promise((resolve) => (resolvePatch = resolve)));
  await renderSettings(trip, client);

  // Order violation first: end before the (future) start → error, no wire.
  await pickDate("trip-settings-input-dates-end", 2020, 1, 1);
  expect(screen.getByTestId("trip-settings-input-dates-end-error")).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  expect(patchBodies(request)).toHaveLength(0);

  // A valid far-future end date: exactly {end_date, expect_updated_at} goes
  // out, and the optimistic row keeps its derived status (dates-moved branch).
  await pickDate("trip-settings-input-dates-end", 2030, 1, 2);
  await fireEvent.press(screen.getByTestId("trip-settings-button-save"));
  await drainNotify();

  await waitFor(() => expect(patchBodies(request)).toHaveLength(1));
  expect(patchBodies(request)[0]).toEqual({
    end_date: "2030-01-02",
    expect_updated_at: trip.updated_at,
  });
  const optimistic = client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID));
  expect(optimistic?.end_date).toBe("2030-01-02");
  // Start stays ~30 days out (fixture) → still planning under derivation.
  expect(optimistic?.status).toBe("planning");

  await act(async () =>
    resolvePatch({ ...trip, end_date: "2030-01-02", updated_at: "2026-07-21T00:00:00.000Z" }),
  );
  await waitFor(() =>
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.updated_at).toBe(
      "2026-07-21T00:00:00.000Z",
    ),
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
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-theme-deepWaters"));
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
  expect(await screen.findByTestId("trip-settings-banner")).toBeOnTheScreen();
});

it("a member-stored garbage theme key ('constructor') renders raw — never a prototype-chain hit", async () => {
  // ThemeKeySchema is max-64 free text, so any editor can store a prototype
  // key; the label lookup must be an OWN-property check (round-1 security).
  const trip = makePlanningTrip(TEST_TRIP_ID, { theme: "constructor" });
  const client = seededClient(trip);
  spyRequest();
  await renderSettings(trip, client);

  expect(screen.getByTestId("trip-settings-screen")).toBeOnTheScreen();
  expect(screen.getByText("constructor")).toBeOnTheScreen();
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
  expect(screen.queryByTestId("trip-settings-banner-conflict")).toBeNull();
  expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))?.isInvalidated).toBe(false);
});

it("leave 404 converges to EXIT with the lists invalidated (§3.5 rule 3 — delete parity)", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { role: "editor", member_count: 2 });
  const client = seededClient(trip);
  const request = spyRequest();
  request.mockRejectedValue(new ApiRequestError(404, "NOT_FOUND", "not found"));
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-button-leave"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-leave-confirm"));
  await drainNotify();

  // The wire targeted the caller's own row…
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/trips/:tripId/members/:userId" }),
      { params: { tripId: TEST_TRIP_ID, userId: TEST_USER.id } },
    ),
  );
  // …the 404 IS the desired end state: exit + both list keys stale (the
  // delete flow's onSuccess parity — round-1 advisory pin).
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
  expect(client.getQueryState(queryKeys.trips)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripsList)?.isInvalidated).toBe(true);
  expect(screen.queryByTestId("trip-settings-banner")).toBeNull();
});

it("owner-leave race 409 maps to the shared banner copy and does NOT exit", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { role: "editor", member_count: 2 });
  const client = seededClient(trip);
  const request = spyRequest();
  request.mockRejectedValue(
    new ApiRequestError(409, "CONFLICT", "transfer ownership first", {
      reason: "owner_transfer_required",
    }),
  );
  await renderSettings(trip, client);

  await fireEvent.press(screen.getByTestId("trip-settings-button-leave"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-leave-confirm"));
  await drainNotify();

  expect(
    await screen.findByText(/transfer ownership to someone else before leaving/),
  ).toBeOnTheScreen();
  expect(mockReplace).not.toHaveBeenCalled();
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
