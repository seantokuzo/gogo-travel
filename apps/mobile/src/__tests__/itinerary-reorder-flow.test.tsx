/**
 * Drag-reorder flow (T-7.4 / IT-2 — R-itin-2/3, api R-ib-15/16/18) — the
 * screen-level round trip. Jest can't synthesize pan gestures, so THIS suite
 * (alone) mocks react-native-reorderable-list with a passthrough FlatList
 * whose `onReorder`/`dragEnabled` props are captured into a harness — tests
 * drive the release exactly where the library would. The library's REAL
 * render path is covered by itinerary-screen.test.tsx, which does not mock
 * it (crash-masked-by-mocks landmine).
 *
 * Pins (§3 minimum bullets):
 * - drag persists order: PUT carries the day's FULL id list; the UI order
 *   changes and RECONCILES to the server's post-state (R-ib-18);
 * - failure rolls back VISIBLY: row order reverts AND the ErrorBanner shows;
 * - timed-booking cross-day drop refused with the exact R-itin-3 hint and NO
 *   network call; haptics fire per §2.8 (dragDrop vs warning);
 * - pending gate: dragEnabled false while the PUT is in flight; viewers
 *   never get drag.
 */
import type { TripWithRole } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { ApiRequestError } from "@/auth";
import { triggerHaptic } from "@/theme/haptics";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_LODGING_ID,
  itineraryApiOverrides,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

/**
 * `VirtualizedList` batches its cell-render updates behind
 * `updateCellsBatchingPeriod` (50 ms by default) — a `setTimeout(0)` drain
 * cannot reach it, so the drain window has to outlast the period.
 */
const VIRTUALIZED_LIST_BATCH_MS = 60;

/**
 * Drain every pending batch inside ONE act window (T-7.5): TanStack's notify
 * batches and the real `VirtualizedList`'s own cell-render timer schedule
 * independently, so a single cycle can leave the other pending. It then lands
 * at the next `await` in a test body — an un-acted update that only shows up
 * in whole-suite runs under worker contention (the B-2 class). Successive
 * cycles INSIDE one act window absorb whatever each previous cycle scheduled.
 */
const SETTLE_DELAYS = [0, 0, VIRTUALIZED_LIST_BATCH_MS, 0] as const;

async function settle(): Promise<void> {
  await act(async () => {
    for (const delay of SETTLE_DELAYS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  });
}

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

/** Captured list props — the harness the tests drive releases through. */
const mockListHarness: {
  onReorder: ((event: { from: number; to: number }) => void) | null;
  dragEnabled: boolean | undefined;
} = { onReorder: null, dragEnabled: undefined };

jest.mock("react-native-reorderable-list", () => {
  // jest.mock factories are hoisted above ES imports — require() is the only
  // way to reach modules from inside one (same shape as jest.setup.js).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FlatList } = require("react-native");
  return {
    __esModule: true,
    default: ({
      onReorder,
      dragEnabled,
      ...props
    }: {
      onReorder: (event: { from: number; to: number }) => void;
      dragEnabled?: boolean;
    }) => {
      mockListHarness.onReorder = onReorder;
      mockListHarness.dragEnabled = dragEnabled;
      return React.createElement(FlatList, props);
    },
    useReorderableDrag: () => () => undefined,
  };
});

const mockedHaptic = triggerHaptic as jest.Mock;

async function releaseDrag(from: number, to: number) {
  await act(async () => {
    mockListHarness.onReorder?.({ from, to });
  });
  // The release fires the optimistic write, whose notify batch is scheduled
  // for a LATER tick — drain it here rather than leaving it to land at some
  // `await` further down (T-7.5: it surfaced as a cross-suite act warning).
  await settle();
}

/** Card ids in current tree order — the VISIBLE order under pin. */
function visibleCardOrder(): string[] {
  return screen
    .getAllByTestId(/^itinerary-list-item-/)
    .map((node) => (node.props as { testID: string }).testID);
}

async function renderItinerary(opts?: {
  role?: TripWithRole["role"];
  api?: ItineraryApiOptions;
}) {
  seedAuthenticated();
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    role: opts?.role ?? "owner",
  });
  const request = mockNavApi({ trips: [trip], overrides: itineraryApiOverrides(opts?.api) });
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  // Settle both queries' notify batches inside act (B-2 posture — see
  // itinerary-screen.test.tsx renderItinerary).
  await settle();
  await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
  return { request, trip };
}

function putCalls(request: jest.Mock): unknown[][] {
  return request.mock.calls.filter(
    (call) => (call[0] as { method?: string }).method === "PUT",
  );
}

// Flat row indices (model.test pins this shape):
// 0 day:Mar1 · 1 flight(A) · 2 custom(B) · 3 check-in · 4 day:Mar2 ·
// 5 empty:Mar2 · 6 day:Mar3 · 7 check-out · 8 place(C)
const DAY1_DEFAULT_ORDER = [
  `itinerary-list-item-${ITEM_A_ID}`,
  `itinerary-list-item-${ITEM_B_ID}`,
  `itinerary-list-item-${ITEM_LODGING_ID}-check-in`,
];

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockedHaptic.mockReset();
  mockListHarness.onReorder = null;
  mockListHarness.dragEnabled = undefined;
});

describe("reorder round trip (R-itin-2, R-ib-15/18)", () => {
  it("drag persists the order: full-day PUT, visible order flips, server post-state wins", async () => {
    const { request } = await renderItinerary();
    expect(visibleCardOrder().slice(0, 3)).toEqual(DAY1_DEFAULT_ORDER);

    // Drag custom(B) above flight(A).
    await releaseDrag(2, 1);

    await waitFor(() => expect(putCalls(request)).toHaveLength(1));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", path: "/trips/:tripId/itinerary/days/:day/order" }),
      {
        params: { tripId: TEST_TRIP_ID, day: TRIP_START },
        body: { item_ids: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID] },
      },
    );
    // Reconciled UI: B before A (the fixture PUT returns the server's
    // post-state for exactly that order — R-ib-18 reconcile).
    await waitFor(() =>
      expect(visibleCardOrder().slice(0, 3)).toEqual([
        `itinerary-list-item-${ITEM_B_ID}`,
        `itinerary-list-item-${ITEM_A_ID}`,
        `itinerary-list-item-${ITEM_LODGING_ID}-check-in`,
      ]),
    );
    expect(mockedHaptic).toHaveBeenCalledWith("dragDrop");
  });

  it("cross-day drag of an unlocked item lands it under the target day", async () => {
    const { request } = await renderItinerary();
    // Drag custom(B) onto empty Mar 2.
    await releaseDrag(2, 5);
    await waitFor(() => expect(putCalls(request)).toHaveLength(1));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      {
        params: { tripId: TEST_TRIP_ID, day: TRIP_DAY_2 },
        body: { item_ids: [ITEM_B_ID] },
      },
    );
    // B now renders after the Mar 2 header; Mar 2's empty-add row is gone.
    await waitFor(() => expect(screen.queryByTestId(`itinerary-day-add-${TRIP_DAY_2}`)).toBeNull());
  });

  it("failure rolls back VISIBLY: order reverts and the ErrorBanner shows", async () => {
    const { request } = await renderItinerary({
      api: {
        putDayOrder: () =>
          Promise.reject(new ApiRequestError(500, "INTERNAL", "boom")),
      },
    });
    await releaseDrag(2, 1);
    // The banner lands via the HOOK-level seam…
    await screen.findByTestId("itinerary-reorder-error");
    // …and the visible order is back to the pre-drag state (rollback).
    await waitFor(() => expect(visibleCardOrder().slice(0, 3)).toEqual(DAY1_DEFAULT_ORDER));
    expect(putCalls(request)).toHaveLength(1);
    // Dismiss clears the banner.
    await fireEvent.press(screen.getByTestId("itinerary-reorder-error-dismiss"));
    expect(screen.queryByTestId("itinerary-reorder-error")).toBeNull();
  });
});

describe("booking day lock (R-itin-3)", () => {
  it("cross-day drop of a timed-booking item is refused with the hint — no PUT, warning haptic", async () => {
    const { request } = await renderItinerary();
    // Drag flight(A) — parent booking has fixed times — onto Mar 2.
    await releaseDrag(1, 5);

    const hint = await screen.findByTestId("itinerary-reorder-hint");
    expect(hint).toBeTruthy();
    expect(
      screen.getByText("Times come from the booking — edit the booking to move it"),
    ).toBeTruthy();
    expect(putCalls(request)).toHaveLength(0);
    // Order unchanged.
    expect(visibleCardOrder().slice(0, 3)).toEqual(DAY1_DEFAULT_ORDER);
    expect(mockedHaptic).toHaveBeenCalledWith("warning");
    expect(mockedHaptic).not.toHaveBeenCalledWith("dragDrop");
  });

  it("the same item still reorders WITHIN its day (lock is cross-day only)", async () => {
    const { request } = await renderItinerary();
    await releaseDrag(1, 2);
    await waitFor(() => expect(putCalls(request)).toHaveLength(1));
    expect(screen.queryByTestId("itinerary-reorder-hint")).toBeNull();
  });
});

describe("gates", () => {
  it("drag is pending-gated while the PUT is in flight", async () => {
    let resolvePut: ((value: unknown) => void) | undefined;
    await renderItinerary({
      api: {
        putDayOrder: () =>
          new Promise((resolve) => {
            resolvePut = resolve;
          }),
      },
    });
    expect(mockListHarness.dragEnabled).toBe(true);
    await releaseDrag(2, 1);
    await waitFor(() => expect(mockListHarness.dragEnabled).toBe(false));
    await act(async () => {
      resolvePut?.({ items: [] });
    });
    await settle();
    await waitFor(() => expect(mockListHarness.dragEnabled).toBe(true));
  });

  it("viewers never get drag (R-ib-24 courtesy gate)", async () => {
    await renderItinerary({ role: "viewer" });
    expect(mockListHarness.dragEnabled).toBe(false);
  });
});
