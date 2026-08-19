/**
 * Booking detail (T-7.9 / IT-9 — R-itin-24/25/26, API §3.2).
 * Component-level over the REAL data hooks with the network mocked by
 * descriptor, so the cache reconciliation the screen depends on (including the
 * FROZEN `reconcileBookingRow` invariant) runs for real.
 *
 * Pins: per-category labeled grid + confirmation copy + price + source
 * (R-itin-24), §3.2 status ACTIONS (no self-loop, no `cancelled` button, no
 * `booked → idea`), the R-itin-26 cancel/delete ConfirmDialogs, the three seam
 * rows, viewer read-only (R-ib-24), and the pending gate.
 *
 * The cancel flow's CALENDAR half — off the default list, into the Ideas
 * bucket's "Show cancelled" — is the phase acceptance criterion and lives in
 * `booking-cancel-flow.test.tsx`, where both screens share one cache.
 */
import type { Booking, BookingWithItems, ItineraryItem, TripListItem } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Linking from "expo-linking";
import { StyleSheet } from "react-native";

import BookingDetailScreen from "@/app/[tripId]/itinerary/booking/[bookingId]";
import { ApiRequestError } from "@/auth";
import { clearDeeplinkOutRecord, readDeeplinkOutRecord } from "@/features/deeplinks";
import { usePendingMapFocusStore } from "@/features/map";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_FLIGHT_ID,
  ITEM_A_ID,
  makeBooking,
  makeItineraryItem,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { lightTheme, makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// The R-ib-24 record-suppression pins press a REAL partner button; the open
// must terminate in a mock (the panel suite's shape), not a native module.
jest.mock("expo-linking", () => ({
  openURL: jest.fn(async () => true),
}));
const openURLMock = Linking.openURL as jest.Mock;

// The seam is spied, not reimplemented — the REAL engine wiring is pinned in
// `src/theme/clipboard.test.ts` (the T-5.7 "a screen test that mocks the
// module can't see the module break" landmine, answered by a sibling suite).
const mockCopyToClipboard = jest.fn();
jest.mock("@/theme/clipboard", () => ({
  copyToClipboard: (text: string) => mockCopyToClipboard(text),
}));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockTabNavigate = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    navigate: mockNavigate,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ bookingId: mockBookingIdParam.value }),
  useNavigation: () => ({
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

/** Mutable so a single mock factory can serve the malformed-param case. */
const mockBookingIdParam: { value: unknown } = { value: BOOKING_FLIGHT_ID };

function tripFixture(overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    ...overrides,
  });
}

function flightBooking(overrides?: Partial<Booking>): BookingWithItems {
  return {
    ...makeBooking({
      id: BOOKING_FLIGHT_ID,
      title: "UA 837 SFO→NRT",
      status: "idea",
      details: {
        category: "flight",
        airline: "United",
        flight_number: "UA837",
        origin_iata: "SFO",
        destination_iata: "NRT",
        departs_at: "2027-03-01T10:00:00+09:00",
      },
      price_cents: 128900,
      currency: "USD",
      confirmation_code: "XZ4K9P",
      source: "deeplink_return",
      starts_at: null,
      ...overrides,
    }),
    items: [],
  };
}

interface RenderOpts {
  booking?: BookingWithItems;
  items?: ItineraryItem[];
  trip?: TripListItem;
  getBooking?: () => Promise<unknown>;
  patchBooking?: (input: Record<string, unknown>) => Promise<unknown>;
  deleteBooking?: (input: Record<string, unknown>) => Promise<unknown>;
}

async function renderDetail(opts: RenderOpts = {}) {
  seedAuthenticated();
  mockBookingIdParam.value = BOOKING_FLIGHT_ID;
  const trip = opts.trip ?? tripFixture();
  const detail: BookingWithItems = {
    ...(opts.booking ?? flightBooking()),
    items: opts.items ?? opts.booking?.items ?? [],
  };
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      "GET /trips/:tripId/bookings/:bookingId":
        opts.getBooking ?? (() => Promise.resolve(detail)),
      "GET /trips/:tripId/bookings": () => Promise.resolve({ items: [], nextCursor: null }),
      "PATCH /trips/:tripId/bookings/:bookingId":
        opts.patchBooking ??
        ((input) => {
          const body = input.body as { status?: Booking["status"] };
          return Promise.resolve({
            ...detail,
            ...(body.status === undefined ? {} : { status: body.status }),
            items: [],
          });
        }),
      "DELETE /trips/:tripId/bookings/:bookingId":
        opts.deleteBooking ?? (() => Promise.resolve(undefined)),
    },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <BookingDetailScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { request, trip, view, detail };
}

afterEach(async () => {
  // Absorb any tail-of-test TanStack notify batch into an act scope before the
  // next test starts (B-2 floating-update class) — the itinerary-screen suite's
  // convention.
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  mockNavigate.mockReset();
  mockReplace.mockReset();
  mockTabNavigate.mockReset();
  mockCopyToClipboard.mockReset();
  openURLMock.mockClear();
  // The record store is MMKV-backed module state — a leaked record would make
  // the next suppression pin pass or fail on the wrong test's write.
  clearDeeplinkOutRecord();
  // Same class: the pending-focus store is module state the sender pin arms.
  usePendingMapFocusStore.setState({ pending: null });
});

describe("R-itin-24 — the detail surface", () => {
  it("renders the labeled per-category grid, status, price, source and confirmation code", async () => {
    await renderDetail();

    expect(await screen.findByTestId("booking-detail-screen")).toBeTruthy();
    // Per-category grid, by the FORM's labels (one inventory, two surfaces).
    expect(screen.getByText("Airline")).toBeTruthy();
    expect(screen.getByText("United")).toBeTruthy();
    expect(screen.getByText("From (IATA)")).toBeTruthy();
    // Destination WALL time: +09:00 is sliced, not applied (a Date render
    // would show 01:00 here).
    expect(screen.getByText("Mon, Mar 1 · 10:00")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-status").props.children).toBeTruthy();
    // Law #2: integer cents formatted by integer math.
    expect(screen.getByTestId("booking-detail-price")).toHaveTextContent("USD 1289.00");
    expect(screen.getByTestId("booking-detail-source")).toHaveTextContent(
      "Added after a partner search",
    );
    expect(screen.getByTestId("booking-detail-confirmation")).toHaveTextContent("XZ4K9P");
    // §2.9 grammar (R1 B1): field testIDs kebab the schema key — the same id
    // family the form's inputs emit, never the raw snake_case key.
    expect(screen.getByTestId("booking-detail-field-flight-number")).toBeTruthy();
    expect(screen.queryByTestId("booking-detail-field-flight_number")).toBeNull();
  });

  it("renders the confirmation code with the `mono` type role (R-itin-24)", async () => {
    await renderDetail();
    await screen.findByTestId("booking-detail-screen");
    // AppText CONSUMES `role` (it never forwards it to RN Text), so the role
    // is observable only through the type style it resolved to.
    const code = StyleSheet.flatten(
      screen.getByTestId("booking-detail-confirmation").props.style,
    ) as { fontSize?: number; fontWeight?: string };
    expect(code.fontSize).toBe(lightTheme.type.mono.fontSize);
    expect(code.fontWeight).toBe(lightTheme.type.mono.fontWeight);
    // CONTROL: a sibling on the SAME screen with a different role resolves to
    // a different weight — so the assertion above is reading the role, not a
    // constant every AppText happens to share.
    const caption = StyleSheet.flatten(
      screen.getByTestId("booking-detail-source").props.style,
    ) as { fontWeight?: string };
    expect(caption.fontWeight).not.toBe(lightTheme.type.mono.fontWeight);
  });

  it("copies the confirmation code through the clipboard seam", async () => {
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("booking-detail-button-copy-confirmation"));
    await settle();
    expect(mockCopyToClipboard).toHaveBeenCalledWith("XZ4K9P");
    // Affordance confirms visibly (the copy is otherwise invisible).
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("puts the affordance back to 'Copy' when the confirmation code CHANGES under it", async () => {
    // R1 A3: "Copied" is a claim about the code on screen. Land a NEW code
    // through the same cache path an edit uses (the PATCH response) — the
    // clipboard still holds the old value, so the label must not say Copied.
    // The fake server tracks POST-state (P1c posture): the invalidation
    // refetch must return the new code too, not quietly restore the fixture.
    let serverState: BookingWithItems = { ...flightBooking(), items: [] };
    const patch = jest.fn((_input: Record<string, unknown>) => {
      serverState = {
        ...flightBooking({ status: "planned", confirmation_code: "NEW42X" }),
        items: [],
      };
      return Promise.resolve(serverState);
    });
    await renderDetail({
      getBooking: () => Promise.resolve(serverState),
      patchBooking: patch,
    });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-copy-confirmation"));
    await settle();
    expect(screen.getByText("Copied")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("booking-detail-button-status-planned"));
    await waitFor(() =>
      expect(screen.getByTestId("booking-detail-confirmation")).toHaveTextContent("NEW42X"),
    );
    await settle();
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("omits the confirmation block entirely when there is no code", async () => {
    await renderDetail({ booking: flightBooking({ confirmation_code: null }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.queryByTestId("booking-detail-confirmation")).toBeNull();
    expect(screen.queryByTestId("booking-detail-button-copy-confirmation")).toBeNull();
  });

  it("omits the price when the booking carries no money", async () => {
    await renderDetail({ booking: flightBooking({ price_cents: null, currency: null }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.queryByTestId("booking-detail-price")).toBeNull();
  });
});

describe("R-itin-24 — seam rows", () => {
  it("shows the place row only when the booking HAS a place, arms the pending focus, then jumps to the map tab (R-map-24 sender)", async () => {
    // ORDER pin (T-8.4): the focus must already be armed WHEN the tab
    // navigate fires — the map screen drains the store in its focus effect,
    // so arm-after-jump loses the race by design.
    const pendingAtJump: unknown[] = [];
    mockTabNavigate.mockImplementation(() => {
      pendingAtJump.push(usePendingMapFocusStore.getState().pending);
    });
    await renderDetail({
      booking: flightBooking({ place_id: "44444444-4444-4444-8444-444444444444" }),
    });
    await fireEvent.press(await screen.findByTestId("booking-detail-row-place"));
    await settle();
    // Cross-tab jumps go through the TAB navigator (an imperative URL push
    // silently no-ops) — the router must NOT have been used for this.
    expect(mockTabNavigate).toHaveBeenCalledWith("map");
    expect(mockPush).not.toHaveBeenCalled();
    expect(pendingAtJump).toEqual([
      { tripId: TEST_TRIP_ID, placeId: "44444444-4444-4444-8444-444444444444" },
    ]);
  });

  it("hides the place row when the booking has none (CONTROL for the row above)", async () => {
    await renderDetail({ booking: flightBooking({ place_id: null }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.queryByTestId("booking-detail-row-place")).toBeNull();
  });

  it("routes the expenses seam row to the money tab", async () => {
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("booking-detail-row-expenses"));
    await settle();
    expect(mockTabNavigate).toHaveBeenCalledWith("money");
  });

  it("names the scheduled day/time and jumps back to that itinerary position", async () => {
    await renderDetail({
      items: [
        makeItineraryItem({
          id: ITEM_A_ID,
          kind: "booking",
          booking_id: BOOKING_FLIGHT_ID,
          title: null,
          day: TRIP_START,
          start_time: "10:00",
          end_time: "12:30",
        }),
      ],
    });
    const row = await screen.findByTestId("booking-detail-row-schedule");
    expect(row).toHaveTextContent(/Mon, Mar 1 · 10:00 – 12:30/);
    await fireEvent.press(row);
    await settle();
    expect(mockNavigate).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary",
      params: { tripId: TEST_TRIP_ID, day: TRIP_START },
    });
  });

  it("says a zero-item booking is NOT on the calendar and offers no jump", async () => {
    await renderDetail({ items: [] });
    const row = await screen.findByTestId("booking-detail-row-schedule");
    expect(row).toHaveTextContent(/Not on the calendar/);
    await fireEvent.press(row);
    await settle();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("§3.2 status actions", () => {
  it("offers exactly the legal non-cancel transitions for an idea", async () => {
    await renderDetail({ booking: flightBooking({ status: "idea" }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.getByTestId("booking-detail-button-status-planned")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-button-status-booked")).toBeTruthy();
    // Self-loop and the cancel column are never plain buttons.
    expect(screen.queryByTestId("booking-detail-button-status-idea")).toBeNull();
    expect(screen.queryByTestId("booking-detail-button-status-cancelled")).toBeNull();
  });

  it("keeps booked → idea closed and offers only `planned` (two-step friction)", async () => {
    await renderDetail({ booking: flightBooking({ status: "booked" }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.getByTestId("booking-detail-button-status-planned")).toBeTruthy();
    expect(screen.queryByTestId("booking-detail-button-status-idea")).toBeNull();
  });

  it("PATCHes the chosen status", async () => {
    const patch = jest.fn((_input: Record<string, unknown>) =>
      Promise.resolve({ ...flightBooking({ status: "planned" }) }),
    );
    await renderDetail({ patchBooking: patch });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-status-planned"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await settle();
    expect(patch.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_FLIGHT_ID },
        body: { status: "planned" },
      }),
    );
  });

  it("offers NO transitions on a cancelled booking, and no Cancel button either", async () => {
    await renderDetail({ booking: flightBooking({ status: "cancelled" }) });
    await screen.findByTestId("booking-detail-screen");
    for (const status of ["idea", "planned", "booked", "cancelled"]) {
      expect(screen.queryByTestId(`booking-detail-button-status-${status}`)).toBeNull();
    }
    expect(screen.queryByTestId("booking-detail-button-cancel")).toBeNull();
    // Delete stays: a cancelled booking is still deletable (§3.4 DELETE).
    expect(screen.getByTestId("booking-detail-button-delete")).toBeTruthy();
  });
});

describe("R-itin-26 — cancel / delete confirmations", () => {
  it("requires the ConfirmDialog before cancelling", async () => {
    const patch = jest.fn((_input: Record<string, unknown>) =>
      Promise.resolve({ ...flightBooking({ status: "cancelled" }) }),
    );
    await renderDetail({ patchBooking: patch });

    await fireEvent.press(await screen.findByTestId("booking-detail-button-cancel"));
    await settle();
    // The tap alone must not write — this is the R-ds-18 contract.
    expect(patch).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("booking-detail-button-cancel-confirm"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await settle();
    expect(patch.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ body: { status: "cancelled" } }),
    );
  });

  it("cancelling the dialog writes nothing (the guard is the dialog, not the button)", async () => {
    const patch = jest.fn((_input: Record<string, unknown>) =>
      Promise.resolve({ ...flightBooking({ status: "cancelled" }) }),
    );
    await renderDetail({ patchBooking: patch });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-cancel"));
    await settle();
    await fireEvent.press(screen.getByTestId("booking-detail-button-cancel-cancel"));
    await settle();
    expect(patch).not.toHaveBeenCalled();
    // CONTROL: the confirm path on the SAME render does write, so "nothing
    // happened" above is the dismiss, not an unreachable dialog.
    await fireEvent.press(screen.getByTestId("booking-detail-button-cancel"));
    await settle();
    await fireEvent.press(screen.getByTestId("booking-detail-button-cancel-confirm"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await settle();
  });

  it("delete confirms, calls DELETE, and leaves the screen", async () => {
    const del = jest.fn((_input: Record<string, unknown>) => Promise.resolve(undefined));
    await renderDetail({ deleteBooking: del });

    await fireEvent.press(await screen.findByTestId("booking-detail-button-delete"));
    await settle();
    expect(del).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("booking-detail-button-delete-confirm"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await settle();
    // Never leave the user on a booking that no longer exists.
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("a second Delete CONFIRM while the DELETE is held in flight fires exactly ONE request", async () => {
    // R1 A8: ConfirmDialog confirms are not `disabled`-gated, so this route is
    // guarded in the HANDLER — and the request must be held genuinely in
    // flight (deferred, released in `finally`) or the second press races a
    // settled mutation and the pin proves nothing (T-7.6 landmine).
    // Resolvers COLLECT (not a single slot): in the mutated world this pin
    // exists to kill, the second press fires a second request — a lone
    // `release` var would strand the first promise and wedge the file
    // instead of failing (this probe hung before the array).
    const releases: ((value: unknown) => void)[] = [];
    const del = jest.fn(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    await renderDetail({ deleteBooking: del });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-delete"));
    await settle();
    await fireEvent.press(screen.getByTestId("booking-detail-button-delete-confirm"));
    await settle();
    try {
      await fireEvent.press(screen.getByTestId("booking-detail-button-delete-confirm"));
      await settle();
      expect(del).toHaveBeenCalledTimes(1);
    } finally {
      // ALWAYS settle every held request — a mutation left in flight wedges
      // the whole file (found by this very pin's mutation probe).
      await act(async () => {
        for (const release of releases) release(undefined);
      });
    }
    await settle();
  });

  it("says linked expenses are KEPT in the delete copy (R-itin-26, schema §3.6)", async () => {
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("booking-detail-button-delete"));
    await settle();
    expect(screen.getByText(/Linked expenses are KEPT/)).toBeTruthy();
  });

  it("surfaces a failed cancel and stays put", async () => {
    const patch = jest.fn(() => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")));
    await renderDetail({ patchBooking: patch });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-cancel"));
    await settle();
    await fireEvent.press(screen.getByTestId("booking-detail-button-cancel-confirm"));
    await waitFor(() => expect(screen.queryByTestId("booking-detail-banner-action")).toBeTruthy());
    await settle();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe("R-ib-24 — viewer read-only", () => {
  it("renders the read surface with zero write affordances for a viewer", async () => {
    await renderDetail({ trip: tripFixture({ role: "viewer" }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.queryByTestId("booking-detail-button-edit")).toBeNull();
    expect(screen.queryByTestId("booking-detail-button-cancel")).toBeNull();
    expect(screen.queryByTestId("booking-detail-button-delete")).toBeNull();
    expect(screen.queryByTestId("booking-detail-button-status-planned")).toBeNull();
    // The READ surface is intact — this is read-only, not access-denied.
    expect(screen.getByTestId("booking-detail-confirmation")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-row-expenses")).toBeTruthy();
  });

  it("CONTROL: the identical fixture as EDITOR renders every write affordance", async () => {
    await renderDetail({ trip: tripFixture({ role: "editor" }) });
    await screen.findByTestId("booking-detail-screen");
    expect(screen.getByTestId("booking-detail-button-edit")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-button-cancel")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-button-delete")).toBeTruthy();
    expect(screen.getByTestId("booking-detail-button-status-planned")).toBeTruthy();
  });

  it("a VIEWER's partner tap opens the URL but writes NO deeplink-out record (R1 A5)", async () => {
    // No record ⇒ no return prompt ⇒ no "Add it manually" dead-ending on the
    // form's "You're a viewer on this trip" wall — the R-ib-24 posture one
    // hop removed. The search itself stays: it is a read any role may do.
    await renderDetail({ trip: tripFixture({ role: "viewer" }) });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-deeplink-kayak"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(readDeeplinkOutRecord()).toBeNull();
  });

  it("CONTROL: an EDITOR's identical tap writes the record — the suppression reads the role", async () => {
    await renderDetail({ trip: tripFixture({ role: "editor" }) });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-deeplink-kayak"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(readDeeplinkOutRecord()).toEqual(
      expect.objectContaining({ partner: "kayak", category: "flight", tripId: TEST_TRIP_ID }),
    );
  });
});

describe("states", () => {
  it("routes Edit to the form modal prefilled with this booking", async () => {
    await renderDetail();
    await fireEvent.press(await screen.findByTestId("booking-detail-button-edit"));
    await settle();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/item/new",
      params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_FLIGHT_ID },
    });
  });

  it("renders the not-found state on a 404 (deleted / wrong trip — indistinguishable)", async () => {
    await renderDetail({
      getBooking: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found")),
    });
    expect(await screen.findByTestId("booking-detail-missing")).toBeTruthy();
    expect(screen.queryByTestId("booking-detail-error")).toBeNull();
  });

  it("renders the retry surface on a non-404 failure (CONTROL for the 404 branch)", async () => {
    await renderDetail({
      getBooking: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    expect(await screen.findByTestId("booking-detail-error")).toBeTruthy();
    expect(screen.queryByTestId("booking-detail-missing")).toBeNull();
  });

  it("gates every action while a write is genuinely in flight", async () => {
    // A deferred promise held OPEN across the assertion — the T-7.6 landmine:
    // a pin that settles the request before asserting never observes the
    // in-flight state at all.
    let release: (value: unknown) => void = () => undefined;
    const patch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await renderDetail({ patchBooking: patch });
    await fireEvent.press(await screen.findByTestId("booking-detail-button-status-planned"));
    await settle();

    try {
      expect(patch).toHaveBeenCalledTimes(1);
      for (const id of [
        "booking-detail-button-status-booked",
        "booking-detail-button-edit",
        "booking-detail-button-cancel",
        "booking-detail-button-delete",
      ]) {
        expect(screen.getByTestId(id).props.accessibilityState?.disabled).toBe(true);
      }
    } finally {
      // ALWAYS settle the held request, even when an assertion above throws:
      // a mutation left in flight wedges the whole file (found by the
      // mutation probe for this very pin, which hung instead of failing).
      await act(async () => {
        release({ ...flightBooking({ status: "planned" }), items: [] });
      });
    }
    await settle();
    // CONTROL: once settled the gate LIFTS — so "disabled" above tracked the
    // in-flight write, not a permanently dead button.
    await waitFor(() =>
      expect(
        screen.getByTestId("booking-detail-button-delete").props.accessibilityState?.disabled,
      ).toBe(false),
    );
  });

  it("degrades a malformed (repeated) bookingId param to not-found instead of throwing", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    mockNavApi({ trips: [trip] });
    mockBookingIdParam.value = [BOOKING_FLIGHT_ID, BOOKING_FLIGHT_ID];
    await renderWithProviders(
      <TripProvider trip={trip}>
        <BookingDetailScreen />
      </TripProvider>,
      { queryClient: makeTestQueryClient() },
    );
    await settle();
    expect(screen.getByTestId("booking-detail-missing")).toBeTruthy();
  });
});
