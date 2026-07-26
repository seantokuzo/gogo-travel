/**
 * `[tripId]` membership guard against the REAL tree (T-6.6 / NAV-4;
 * R-nav-15/20 + the Law #3 client half). Named per acceptance line:
 *   - member → tabs render with trip context; MRV stamp on verified success
 *   - 404 → no-access, WITHOUT leaking whether the trip exists, zero trip
 *     data fetched into UI (nonexistent ≡ non-member ≡ malformed)
 *   - stale cache + fresh 404 → STILL no-access, cached name never shown,
 *     stamp untouched, dead trip scrubbed from the cache (round 1)
 *   - IN-FLIGHT re-verification → hold surface, never the cached shell
 *     (round 1: the verification-window defect)
 *   - fresh cache still fires a verification request on mount (round 1)
 *   - non-404 failure → retry surface, NOT a false no-access
 *
 * Pure-URL renders; the single interactive test (retry) is LAST (quirk 3).
 */
import { cleanup, fireEvent, screen, waitFor, within } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient, queryKeys } from "@/data";
import { clearLastViewedTrip, readLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  // clear() does NOT remove per-key defaults — reset the retry-test override.
  queryClient.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), {});
  resetTabMemory();
  clearLastViewedTrip();
});

/** The guard's verification call shape (queries forward TanStack's signal). */
const GUARD_CALL = (tripId: string) =>
  [
    expect.objectContaining({ path: "/trips/:tripId" }),
    { params: { tripId } },
    { signal: expect.any(AbortSignal) },
  ] as const;

it("R-nav-20: a member's trip mounts the tab shell with trip context and stamps recency on the verified verdict", async () => {
  const request = mockNavApi();
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  const itinerary = await screen.findByTestId("itinerary-screen");
  expect(within(itinerary).getByText(`Trip ${TEST_TRIP_ID}`)).toBeOnTheScreen();
  // The guard verified membership BEFORE rendering trip data (R-nav-20).
  expect(request).toHaveBeenCalledWith(...GUARD_CALL(TEST_TRIP_ID));
  // Verified success ⇒ viewed: the R-nav-23 stamp landed post-verdict.
  expect(readLastViewedTrip()?.tripId).toBe(TEST_TRIP_ID);
});

it("R-nav-20 (round 1): a FRESH cached verdict still fires a verification request on mount", async () => {
  // A just-written cache entry (well inside any staleTime) must NOT skip the
  // membership check — revocation can land server-side at any moment.
  queryClient.setQueryData(queryKeys.trip(TEST_TRIP_ID), makePlanningTrip(TEST_TRIP_ID));
  const request = mockNavApi();
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  await screen.findByTestId("itinerary-screen");
  expect(request).toHaveBeenCalledWith(...GUARD_CALL(TEST_TRIP_ID));
});

it("R-nav-20/Law #3 (round 1): while the mount's re-verification is IN FLIGHT, cached data renders the hold — never the shell", async () => {
  const cached = makePlanningTrip(TEST_TRIP_ID, { name: "Secret Trip Name" });
  queryClient.setQueryData(queryKeys.trip(TEST_TRIP_ID), cached, {
    updatedAt: Date.now() - 10 * 60 * 1000,
  });
  // Deterministic in-flight window: the verification request never settles.
  mockNavApi({
    overrides: { "GET /trips/:tripId": () => new Promise(() => undefined) },
  });
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  expect(screen.getByTestId("trip-loading")).toBeOnTheScreen();
  // NO cached content: no tab shell, no tab bar, no trip name, no trip id.
  expect(screen.queryByTestId("itinerary-screen")).toBeNull();
  expect(screen.queryByTestId("tab-bar-itinerary")).toBeNull();
  expect(screen.queryByText("Secret Trip Name")).toBeNull();
  expect(screen.queryByText(new RegExp(TEST_TRIP_ID))).toBeNull();
  // And an unverified window is not a view (R-nav-23).
  expect(readLastViewedTrip()).toBeNull();
});

it("R-nav-15: nonexistent/non-member trip → the ONE generic no-access state, zero trip data in UI", async () => {
  const request = mockNavApi({ trips: [] }); // the mock's universe knows no trips → 404
  await renderApp(`/${TRIP_B_ID}/itinerary`);
  expect(await screen.findByTestId("no-access-screen")).toBeOnTheScreen();
  // Zero trip data fetched into UI: the only trip call is the guard's 404'd
  // membership check — no tab ever mounted to fetch anything else.
  const tripCalls = request.mock.calls.filter(
    ([descriptor]) => (descriptor as { path: string }).path.startsWith("/trips"),
  );
  expect(tripCalls).toEqual([GUARD_CALL(TRIP_B_ID)]);
  expect(screen.queryByTestId("itinerary-screen")).toBeNull();
  // A no-access bounce is NOT a view — the R-nav-23 stamp must not move.
  expect(readLastViewedTrip()).toBeNull();
});

it("R-nav-15: malformed trip id → the SAME no-access state (server folds it into 404)", async () => {
  mockNavApi({ trips: [] });
  await renderApp("/not-a-uuid/itinerary");
  expect(await screen.findByTestId("no-access-screen")).toBeOnTheScreen();
  expect(screen.queryByTestId("itinerary-screen")).toBeNull();
});

it("Law #3 client half: a stale cached trip + fresh 404 renders no-access, never the cached name — and scrubs the dead trip", async () => {
  const cached = makePlanningTrip(TEST_TRIP_ID, { name: "Secret Trip Name" });
  queryClient.setQueryData(queryKeys.trip(TEST_TRIP_ID), cached, {
    updatedAt: Date.now() - 10 * 60 * 1000,
  });
  // A trips-list entry exists too (e.g. warmed by the entry redirect) — the
  // 404 must mark it stale so the switcher/entry active set drops the trip.
  queryClient.setQueryData(queryKeys.trips, { items: [cached], nextCursor: null });
  const request = mockNavApi({ trips: [] }); // membership since revoked → fresh 404
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  expect(await screen.findByTestId("no-access-screen")).toBeOnTheScreen();
  expect(screen.queryByText("Secret Trip Name")).toBeNull();
  expect(screen.queryByText(new RegExp(TEST_TRIP_ID))).toBeNull();
  // Not a view (R-nav-23).
  expect(readLastViewedTrip()).toBeNull();
  // Scrub half 1: the trips list is invalidated immediately.
  expect(queryClient.getQueryState(queryKeys.trips)?.isInvalidated).toBe(true);
  // LOCAL exact:true pin (T-6.6 R2): ["trips"] is a PREFIX of the guard's own
  // ["trips", id] detail key — a non-exact scrub would match the actively-
  // observed detail query and refetch-loop the 404 (caught live: 121 requests
  // before the timeout). EXACTLY ONE guard call proves the scrub stayed
  // exact. (The detail entry's isInvalidated flag is NOT a usable pin here:
  // v5's error reducer marks any data-bearing query invalidated on a
  // background error by design — query.ts "flag existing data as
  // invalidated if we get a background error".)
  expect(
    request.mock.calls.filter(
      ([descriptor]) => (descriptor as { path: string }).path === "/trips/:tripId",
    ),
  ).toHaveLength(1);
  // Scrub half 2: leaving the 404 branch removes the dead trip's cache entry
  // (deferred to teardown — removing an observed query would refetch-loop).
  await cleanup();
  expect(queryClient.getQueryData(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
});

it("T-6.6 R2: a RETAINED error from a prior mount holds — never flashes the retry surface — while the remount's verification is in flight", async () => {
  // Mount 1: a non-404 failure settles into the retry surface and leaves an
  // error state in the prod cache (retry collapsed to 1ms as below).
  queryClient.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { retryDelay: 1 });
  mockNavApi({
    overrides: {
      "GET /trips/:tripId": () => Promise.reject(new ApiRequestError(503, "UNKNOWN", "down")),
    },
  });
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  expect(await screen.findByTestId("trip-error-screen")).toBeOnTheScreen();

  // Mount 2: the cached error is NOT this mount's verdict. While the fresh
  // verification never settles, the guard must hold — the pre-fix code
  // rendered the error branch off the retained state for the whole RTT.
  mockNavApi({
    overrides: { "GET /trips/:tripId": () => new Promise(() => undefined) },
  });
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  expect(screen.getByTestId("trip-loading")).toBeOnTheScreen();
  expect(screen.queryByTestId("trip-error-screen")).toBeNull();
});

it("a non-404 failure is NOT a membership verdict → retry surface, then success mounts the shell", async () => {
  // Interactive (presses) — LAST test in the file (harness quirk 3).
  // 5xx retries twice before settling (shouldRetry); collapse the backoff to
  // 1ms so the settle is immediate — retry COUNT semantics live in the
  // shouldRetry unit tests, this flow tests the error→retry→success surfaces.
  queryClient.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { retryDelay: 1 });
  let fail = true;
  mockNavApi({
    overrides: {
      "GET /trips/:tripId": () =>
        fail
          ? Promise.reject(new ApiRequestError(503, "UNKNOWN", "unavailable"))
          : Promise.resolve(makePlanningTrip(TEST_TRIP_ID)),
    },
  });
  await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  expect(await screen.findByTestId("trip-error-screen")).toBeOnTheScreen();
  expect(screen.queryByTestId("no-access-screen")).toBeNull();

  fail = false;
  await fireEvent.press(screen.getByTestId("trip-error-banner-retry"));
  await waitFor(() => expect(screen.queryByTestId("trip-error-screen")).toBeNull());
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
});
