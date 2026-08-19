/**
 * Place detail screen (T-8.4 / MAP-3 — R-map-8/10/11/12/14, §2.3).
 * Component-level over the REAL data hooks, network mocked by descriptor
 * (the T-7.9 detail-screen harness).
 *
 * Load-bearing pins:
 *  - R-map-11 both halves: optimistic save (the button lands "Saved" while
 *    the POST is genuinely held in flight) and 409 ≡ success with NO error
 *    surface; viewers get STATE (badge), never the control — with the
 *    ungated editor CONTROL alongside.
 *  - The §2.4 dormancy truth: NO request this screen issues carries
 *    `fresh` (the flag-on render path is pinned hook+component-level in
 *    places.test.tsx / PlaceFreshBlock.test.tsx, and end-to-end in
 *    place-detail-fresh.test.tsx's flag-flip arm).
 *  - `is404` OUTRANKS retained cache (Law #3 client half) with the non-404
 *    CONTROL proving the pin reads the status.
 *  - The two-step cross-tab ORDER (tab jump BEFORE the push) for Add-to-day
 *    and linked rows, with the PER-KIND destinations (interp 17: item-kind →
 *    `item/[itemId]`, booking-kind → `booking/[bookingId]`) — the
 *    real-navigator end of the same contract lives in
 *    place-detail-cross-tab.test.tsx.
 */
import { ATTRIBUTION, type SavedPlaceWithPlace, type TripListItem } from "@gogo/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import PlaceDetailScreen from "@/app/[tripId]/map/place/[placeId]";
import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { resetMapLocationForTests, useMapLocationStore } from "@/features/map";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  defaultBookings,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  itineraryApiOverrides,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import {
  makePlace,
  makeSavedPlaceWithPlace,
  makeTrip,
  mockNavApi,
  TEST_PLACE_ID,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

/** Ordered cross-tab call log — the two-step contract is an ORDER claim. */
const callSequence: [string, unknown][] = [];
const mockPush = jest.fn((target: unknown) => callSequence.push(["push", target]));
const mockNavigate = jest.fn((target: unknown) => callSequence.push(["navigate", target]));
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockTabNavigate = jest.fn((tab: unknown) => callSequence.push(["tab", tab]));
const mockPlaceIdParam: { value: unknown } = { value: TEST_PLACE_ID };
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    navigate: mockNavigate,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ placeId: mockPlaceIdParam.value }),
  useNavigation: () => ({
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

const SAVED_ROW_ID = "55555555-5555-4555-8555-555555555551";

function tripFixture(overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    ...overrides,
  });
}

interface RenderOpts {
  placeId?: string;
  trip?: TripListItem;
  savedRows?: SavedPlaceWithPlace[];
  /** Itinerary/booking universe overrides (per-kind linked-row pins). */
  itinerary?: ItineraryApiOptions;
  getPlace?: () => Promise<unknown>;
  getSavedPlaces?: () => Promise<unknown>;
  createSavedPlace?: (input: Record<string, unknown>) => Promise<unknown>;
  deleteSavedPlace?: (input: Record<string, unknown>) => Promise<unknown>;
  updateSavedPlace?: (input: Record<string, unknown>) => Promise<unknown>;
  /** Pre-seeded client for the retained-cache pins (default: fresh + empty). */
  queryClient?: QueryClient;
}

const PLACE = makePlace({ name: "Fushimi Inari", category: "Shinto Shrine" });

async function renderDetail(opts: RenderOpts = {}) {
  seedAuthenticated();
  mockPlaceIdParam.value = opts.placeId ?? TEST_PLACE_ID;
  const trip = opts.trip ?? tripFixture();
  const savedRows = opts.savedRows ?? [];
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      ...itineraryApiOverrides(opts.itinerary),
      "GET /places/:placeId": opts.getPlace ?? (() => Promise.resolve({ place: PLACE })),
      "GET /trips/:tripId/saved-places":
        opts.getSavedPlaces ?? (() => Promise.resolve({ items: savedRows, nextCursor: null })),
      "POST /trips/:tripId/saved-places":
        opts.createSavedPlace ??
        (() => Promise.resolve(makeSavedPlaceWithPlace({ id: SAVED_ROW_ID }))),
      "DELETE /trips/:tripId/saved-places/:savedPlaceId":
        opts.deleteSavedPlace ?? (() => Promise.resolve(undefined)),
      "PATCH /trips/:tripId/saved-places/:savedPlaceId":
        opts.updateSavedPlace ??
        ((input) =>
          Promise.resolve(
            makeSavedPlaceWithPlace({
              id: SAVED_ROW_ID,
              note: (input.body as { note: string | null }).note,
            }),
          )),
    },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <PlaceDetailScreen />
    </TripProvider>,
    { queryClient: opts.queryClient ?? makeTestQueryClient() },
  );
  await settle();
  return { request, trip, view };
}

/** Seeded client whose entries SURVIVE unobserved gaps (retained-cache pins). */
function seededDetailClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  client.setQueryData(queryKeys.placeDetail(TEST_PLACE_ID), { place: PLACE });
  return client;
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockClear();
  mockBack.mockClear();
  mockReplace.mockClear();
  mockNavigate.mockClear();
  mockTabNavigate.mockClear();
  callSequence.length = 0;
  resetMapLocationForTests();
});

describe("§2.3 — the loaded surface", () => {
  it("renders name, category line + glyph, spine attribution, and the editor affordances", async () => {
    await renderDetail();
    expect(await screen.findByTestId("place-detail-screen")).toBeTruthy();
    expect(screen.getByText("Fushimi Inari")).toBeTruthy();
    expect(screen.getByTestId("place-detail-category")).toHaveTextContent(/Shinto Shrine/);
    // R-places-17: the spine attribution footer carries the REGISTRY string.
    expect(screen.getByTestId("place-detail-attribution")).toHaveTextContent(
      ATTRIBUTION.overture.text,
    );
    expect(screen.getByTestId("place-detail-button-save")).toBeTruthy();
    expect(screen.getByTestId("place-detail-button-add-to-day")).toBeTruthy();
    expect(screen.getByTestId("place-detail-button-navigate")).toBeTruthy();
  });

  it("a custom place renders NO attribution footer (nothing in the registry to attribute)", async () => {
    await renderDetail({
      getPlace: () =>
        Promise.resolve({
          place: makePlace({ source: "custom", source_id: null, created_by: "00000000-0000-4000-8000-000000000001" }),
        }),
    });
    await screen.findByTestId("place-detail-screen");
    expect(screen.queryByTestId("place-detail-attribution")).toBeNull();
  });

  it("NO request from this screen carries the fresh param (§2.4 dormancy — the v1 truth)", async () => {
    const { request } = await renderDetail();
    await screen.findByText("Fushimi Inari");
    const freshCalls = request.mock.calls.filter((call: unknown[]) => {
      const input = call[1] as { query?: { fresh?: unknown } } | undefined;
      return input?.query?.fresh !== undefined;
    });
    expect(freshCalls).toEqual([]);
    // CONTROL: the spine read itself DID happen (the filter above could not
    // pass vacuously against zero requests).
    expect(
      request.mock.calls.some(
        (call: unknown[]) => (call[0] as { path: string }).path === "/places/:placeId",
      ),
    ).toBe(true);
  });

  it("Navigate hands off to the external maps URL with the place's coordinates (R-map-8)", async () => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("place-detail-button-navigate"));
    expect(openUrl).toHaveBeenCalledWith(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("35.0116,135.7681")}`,
    );
  });

  it("Navigate stays ENABLED and fires OFFLINE (T-8.7 reconciliation — supersedes interp 15's disable)", async () => {
    // HONEST PIN EVOLUTION: T-8.4 shipped `disabled={offline}` here while
    // the sheet half of the same R-map-8 action had no gate (R1 A7 recorded
    // the divergence). The rider reconciled to ENABLED on both — Google
    // Maps' own offline navigation exists, and offline-inside-a-downloaded-
    // pack is the headline use case.
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    await renderDetail({
      queryClient: seededDetailClient(),
      getSavedPlaces: () => Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
    });
    // The offline signal is REAL in this render (the banner proves it)…
    await screen.findByTestId("place-detail-banner-offline");

    const navigate = screen.getByTestId("place-detail-button-navigate");
    expect(navigate).not.toBeDisabled();
    await fireEvent.press(navigate);

    // …and the handoff still fires (with the coordinate URL — the enabled
    // path is the REAL one, not a dead tap).
    expect(openUrl).toHaveBeenCalledWith(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("35.0116,135.7681")}`,
    );
  });
});

describe("§2.3 distance-when-puck-active (T-8.7 rider — PR #25 A6)", () => {
  it("no position ⇒ no distance row (the label is absent, not zeroed)", async () => {
    await renderDetail();
    await screen.findByText("Fushimi Inari");
    expect(screen.queryByTestId("place-detail-distance")).toBeNull();
  });

  it("a live position renders the on-device distance line", async () => {
    // `position` non-null ⟹ granted (the location store's re-sync
    // invariant) — this IS "puck active".
    useMapLocationStore.setState({
      permission: "granted",
      position: { lat: 34.9858, lng: 135.7588 },
    });
    await renderDetail();

    const distance = await screen.findByTestId("place-detail-distance");
    expect(distance.props.children).toMatch(/away$/);
  });
});

describe("R-map-11 — save / unsave", () => {
  it("save is OPTIMISTIC: the button reads Saved while the POST is genuinely held in flight", async () => {
    const releases: ((value: unknown) => void)[] = [];
    const create = jest.fn(
      (_input: Record<string, unknown>) =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    await renderDetail({ createSavedPlace: create });
    await fireEvent.press(await screen.findByTestId("place-detail-button-save"));
    await settle();
    try {
      // In flight: optimistic row present ⇒ the toggle reads "Saved".
      expect(screen.getByTestId("place-detail-button-save")).toHaveTextContent(/Saved/);
      expect(create).toHaveBeenCalledTimes(1);
      expect((create.mock.calls[0]?.[0] as { body?: unknown }).body).toEqual({
        place_id: TEST_PLACE_ID,
      });
    } finally {
      // ALWAYS release held requests (resolvers ARRAY, release in finally —
      // mobile.md: a wedged mutation hangs the whole file).
      await act(async () => {
        for (const release of releases) release(makeSavedPlaceWithPlace({ id: SAVED_ROW_ID }));
      });
    }
    await settle();
    expect(screen.getByTestId("place-detail-button-save")).toHaveTextContent(/Saved/);
    expect(screen.queryByTestId("place-detail-banner-action")).toBeNull();
  });

  it("save onto an already-saved place (409) LANDS SAVED with no error UI (R-places-16 client half)", async () => {
    // The 409 scenario is a STALE list: the client cache says unsaved, the
    // server says saved. Wire-faithful responder: the list is empty until
    // the 409-path invalidation refetch, which returns the server's truth —
    // the row that has existed all along.
    let listCalls = 0;
    await renderDetail({
      createSavedPlace: () =>
        Promise.reject(new ApiRequestError(409, "CONFLICT", "already saved")),
      getSavedPlaces: () => {
        listCalls += 1;
        return Promise.resolve({
          items: listCalls === 1 ? [] : [makeSavedPlaceWithPlace({ id: SAVED_ROW_ID })],
          nextCursor: null,
        });
      },
    });
    await fireEvent.press(await screen.findByTestId("place-detail-button-save"));
    await settle();
    expect(screen.getByTestId("place-detail-button-save")).toHaveTextContent(/Saved/);
    expect(screen.queryByTestId("place-detail-banner-action")).toBeNull();
    // The invalidation refetch actually ran (this arm is what re-syncs the
    // placeholder id to the real row).
    expect(listCalls).toBeGreaterThan(1);
  });

  it("a NON-409 save failure rolls back to unsaved and surfaces the action banner (CONTROL for the 409 arm)", async () => {
    await renderDetail({
      createSavedPlace: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    await fireEvent.press(await screen.findByTestId("place-detail-button-save"));
    await waitFor(() => expect(screen.queryByTestId("place-detail-banner-action")).toBeTruthy());
    await settle();
    expect(screen.getByTestId("place-detail-button-save")).toHaveTextContent(/Save place/);
  });

  it("unsave DELETEs by the saved row id and returns the toggle to Save place", async () => {
    const del = jest.fn((_input: Record<string, unknown>) => Promise.resolve(undefined));
    await renderDetail({
      savedRows: [makeSavedPlaceWithPlace({ id: SAVED_ROW_ID })],
      deleteSavedPlace: del,
    });
    const button = await screen.findByTestId("place-detail-button-save");
    expect(button).toHaveTextContent(/Saved/);
    await fireEvent.press(button);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await settle();
    expect(del.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, savedPlaceId: SAVED_ROW_ID },
      }),
    );
    expect(screen.getByTestId("place-detail-button-save")).toHaveTextContent(/Save place/);
  });
});

describe("R-map-14 — note editor + linked content", () => {
  it("editor: the note input is prefilled; editing reveals Save note, which PATCHes the trimmed note", async () => {
    const patch = jest.fn((input: Record<string, unknown>) =>
      Promise.resolve(
        makeSavedPlaceWithPlace({
          id: SAVED_ROW_ID,
          note: (input.body as { note: string | null }).note,
        }),
      ),
    );
    await renderDetail({
      savedRows: [makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, note: "Old note" })],
      updateSavedPlace: patch,
    });
    const input = await screen.findByTestId("place-detail-input-note");
    expect(input).toHaveDisplayValue("Old note");
    // Untouched: no Save note affordance (nothing to save).
    expect(screen.queryByTestId("place-detail-button-save-note")).toBeNull();

    await fireEvent.changeText(input, "  Go at dawn  ");
    await settle();
    await fireEvent.press(screen.getByTestId("place-detail-button-save-note"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await settle();
    expect(patch.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, savedPlaceId: SAVED_ROW_ID },
        body: { note: "Go at dawn" },
      }),
    );
    // Saved: the affordance retires until the next edit.
    expect(screen.queryByTestId("place-detail-button-save-note")).toBeNull();
  });

  it("clearing the note PATCHes null (the PL-4 clear contract)", async () => {
    const patch = jest.fn((input: Record<string, unknown>) =>
      Promise.resolve(
        makeSavedPlaceWithPlace({
          id: SAVED_ROW_ID,
          note: (input.body as { note: string | null }).note,
        }),
      ),
    );
    await renderDetail({
      savedRows: [makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, note: "Old note" })],
      updateSavedPlace: patch,
    });
    await fireEvent.changeText(await screen.findByTestId("place-detail-input-note"), "   ");
    await settle();
    await fireEvent.press(screen.getByTestId("place-detail-button-save-note"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await settle();
    expect((patch.mock.calls[0]?.[0] as { body?: unknown }).body).toEqual({ note: null });
  });

  it("an ITEM-kind linked row jumps tab-first then pushes item/[itemId] (R-map-14 'to them' / §2.7 — interp 17)", async () => {
    await renderDetail();
    // ITEM_C is the fixture place_visit at TEST_PLACE_ID (day 3).
    const row = await screen.findByTestId(`place-detail-list-item-${ITEM_C_ID}`);
    await fireEvent.press(row);
    await settle();
    // ORDER: the tab jump must land BEFORE the same-stack push — the
    // reverse order is the exact landmine class (a push at another tab's
    // URL silently no-ops). DESTINATION: the item's own detail, per the
    // MAP-6 "lands on item detail" bullet — never the day list.
    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/item/[itemId]",
          params: { tripId: TEST_TRIP_ID, itemId: ITEM_C_ID },
        },
      ],
    ]);
  });

  it("a BOOKING-kind linked row pushes booking/[bookingId] DIRECTLY (interp 17 — the day-list/grid precedent)", async () => {
    // Give the lodging booking this place: its booking-kind item
    // (ITEM_LODGING) then resolves the place through the parent booking —
    // exactly the pin-builder resolution the linked list shares.
    await renderDetail({
      itinerary: {
        bookings: defaultBookings().map((booking) =>
          booking.id === BOOKING_LODGING_ID ? { ...booking, place_id: TEST_PLACE_ID } : booking,
        ),
      },
    });
    const row = await screen.findByTestId(`place-detail-list-item-${ITEM_LODGING_ID}`);
    await fireEvent.press(row);
    await settle();
    // Straight to the booking detail: routing through item/[itemId] would
    // only R-itin-27-replace itself there, leaving a bounce in the stack.
    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/booking/[bookingId]",
          params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_LODGING_ID },
        },
      ],
    ]);
  });

  it("CONTROL: items at other places (or unplaced) render NO linked row", async () => {
    await renderDetail();
    await screen.findByTestId("place-detail-screen");
    const rows = screen.getAllByTestId(/^place-detail-list-item-/);
    expect(rows.map((node) => (node.props as { testID: string }).testID)).toEqual([
      `place-detail-list-item-${ITEM_C_ID}`,
    ]);
  });

  it("Add to day jumps tab-first then pushes the prefilled item/new modal (R-map-12)", async () => {
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("place-detail-button-add-to-day"));
    await settle();
    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/item/new",
          params: {
            tripId: TEST_TRIP_ID,
            category: "place_visit",
            placeId: TEST_PLACE_ID,
            placeName: "Fushimi Inari",
          },
        },
      ],
    ]);
  });
});

describe("R-ib-24 client half — viewer posture", () => {
  it("viewer: NO write affordances; saved STATE shows as a badge; the note is read-only text", async () => {
    await renderDetail({
      trip: tripFixture({ role: "viewer" }),
      savedRows: [makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, note: "Go at dawn" })],
    });
    await screen.findByTestId("place-detail-screen");
    expect(screen.queryByTestId("place-detail-button-save")).toBeNull();
    expect(screen.queryByTestId("place-detail-button-add-to-day")).toBeNull();
    expect(screen.queryByTestId("place-detail-input-note")).toBeNull();
    expect(screen.queryByTestId("place-detail-button-save-note")).toBeNull();
    // State, not the control (R-map-11) — and the note still reads.
    expect(screen.getByTestId("place-detail-badge-saved")).toBeTruthy();
    expect(screen.getByTestId("place-detail-note")).toHaveTextContent(/Go at dawn/);
    // The read-only surface keeps Navigate (not a write).
    expect(screen.getByTestId("place-detail-button-navigate")).toBeTruthy();
  });

  it("viewer + unsaved: no badge either (the badge reflects STATE, not a fixed ornament)", async () => {
    await renderDetail({ trip: tripFixture({ role: "viewer" }) });
    await screen.findByTestId("place-detail-screen");
    expect(screen.queryByTestId("place-detail-badge-saved")).toBeNull();
  });
});

describe("states (T-7.9 posture)", () => {
  it("renders the retry surface when the spine read fails with nothing cached", async () => {
    await renderDetail({
      getPlace: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    expect(await screen.findByTestId("place-detail-error")).toBeTruthy();
    expect(screen.queryByTestId("place-detail-missing")).toBeNull();
  });

  it("a fresh 404 OUTRANKS retained cache — missing, not yesterday's place (Law #3 client half)", async () => {
    await renderDetail({
      queryClient: seededDetailClient(),
      getPlace: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found")),
    });
    expect(await screen.findByTestId("place-detail-missing")).toBeTruthy();
    expect(screen.queryByTestId("place-detail-button-save")).toBeNull();
    expect(screen.queryByTestId("place-detail-banner-refresh")).toBeNull();
  });

  it("CONTROL: a non-404 failure over the SAME cache keeps the retained render + refresh banner", async () => {
    await renderDetail({
      queryClient: seededDetailClient(),
      getPlace: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    expect(await screen.findByText("Fushimi Inari")).toBeTruthy();
    expect(await screen.findByTestId("place-detail-banner-refresh")).toBeTruthy();
    expect(screen.queryByTestId("place-detail-missing")).toBeNull();
  });

  it("offline (derived signal) shows the warning banner over retained data, not the refresh banner", async () => {
    // The trip-subtree saved-places read failing at the TRANSPORT layer
    // (status 0) is exactly what flips useTripOffline — the spine read
    // itself still renders from its cache.
    await renderDetail({
      queryClient: seededDetailClient(),
      getSavedPlaces: () => Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
    });
    expect(await screen.findByTestId("place-detail-banner-offline")).toBeTruthy();
    expect(screen.getByText("Fushimi Inari")).toBeTruthy();
  });

  it("degrades a malformed (repeated) placeId param to missing instead of throwing", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    mockNavApi({
      trips: [trip],
      overrides: {
        ...itineraryApiOverrides(),
        "GET /trips/:tripId/saved-places": () => Promise.resolve({ items: [], nextCursor: null }),
      },
    });
    mockPlaceIdParam.value = [TEST_PLACE_ID, TEST_PLACE_ID];
    await renderWithProviders(
      <TripProvider trip={trip}>
        <PlaceDetailScreen />
      </TripProvider>,
      { queryClient: makeTestQueryClient() },
    );
    await settle();
    expect(screen.getByTestId("place-detail-missing")).toBeTruthy();
  });
});
