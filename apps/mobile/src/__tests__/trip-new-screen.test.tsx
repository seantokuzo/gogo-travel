/**
 * Create-trip modal (T-6.7 / CT-2; trips spec §2.3, R-tripui-6..8).
 * Screen-level render with the router/navigator surface stubbed — the
 * beforeRemove contract is exercised by invoking the captured listener the
 * way the vendored navigator would; the real-tree walkthrough (modal
 * presentation + itinerary landing) lives in trip-create-flow.test.tsx.
 *
 * Covers the §3 test bullets: validation (required name/destination/dates +
 * date order), destination structured search (4-char text-only floor,
 * pick-fills-lat/lng), pending-disable, success replace-navigation, failure
 * preserves input, dirty dismiss confirms; base_currency defaulting
 * (R-tripui-6) both ways.
 */
import { placeEndpoints, tripEndpoints, type User } from "@gogo/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import TripNewScreen from "@/app/(trips)/new";
import { apiClient, ApiRequestError } from "@/auth";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { makePlace, makePlanningTrip } from "@/test-utils/trip-fixtures";

const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  canGoBack: jest.fn(() => true),
};

type BeforeRemoveEvent = {
  preventDefault: jest.Mock;
  data: { action: { type: string } };
};
const mockBeforeRemoveListeners: ((e: BeforeRemoveEvent) => void)[] = [];
const mockNavigation = {
  addListener: (type: string, cb: (e: BeforeRemoveEvent) => void) => {
    if (type === "beforeRemove") mockBeforeRemoveListeners.push(cb);
    return () => {
      const i = mockBeforeRemoveListeners.indexOf(cb);
      if (i >= 0) mockBeforeRemoveListeners.splice(i, 1);
    };
  },
  dispatch: jest.fn(),
};

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useNavigation: () => mockNavigation,
}));

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const KYOTO = makePlace();

/** `METHOD path` routed network mock (profile-screen convention). */
function mockApi(
  overrides: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {},
  opts?: { me?: User },
): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((descriptor: { method: string; path: string }, input?: unknown) => {
    const key = `${descriptor.method} ${descriptor.path}`;
    const override = overrides[key];
    if (override) return override((input ?? {}) as Record<string, unknown>);
    switch (key) {
      case "GET /users/me":
        return Promise.resolve(opts?.me ?? TEST_USER);
      case "GET /places/search":
        return Promise.resolve({ items: [KYOTO], nextCursor: null });
      case "POST /trips":
        return Promise.resolve(makePlanningTrip(TEST_TRIP_ID));
      default:
        return Promise.reject(new Error(`unexpected ${key}`));
    }
  });
  return request;
}

/** The §3.3 body a fully-filled form must produce (base_currency separate). */
const FILLED_BODY = {
  name: "Kyoto Spring",
  destination_name: "Kyoto",
  destination_lat: KYOTO.lat,
  destination_lng: KYOTO.lng,
  start_date: "2027-05-01",
  end_date: "2027-05-08",
};

/**
 * Drive the platform date picker (R1 — the §2.3 range picker replaced typed
 * fields): press the field row to reveal the picker, then fire the native
 * change event the iOS wrapper translates into `onValueChange(event, date)`.
 * LOCAL noon keeps the picked calendar day tz-stable on any runner.
 */
async function pickDate(fieldTestID: string, y: number, m: number, d: number) {
  await fireEvent.press(screen.getByTestId(fieldTestID));
  await fireEvent(screen.getByTestId(`${fieldTestID}-picker`), "onChange", {
    nativeEvent: { timestamp: new Date(y, m - 1, d, 12).getTime(), utcOffset: 0 },
  });
}

async function fillValidForm() {
  await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "Kyoto Spring");
  await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
  await fireEvent.press(await screen.findByTestId(`trip-new-list-item-${KYOTO.id}`));
  await pickDate("trip-new-input-dates-start", 2027, 5, 1);
  await pickDate("trip-new-input-dates-end", 2027, 5, 8);
}

/**
 * Press + settle INSIDE act (invite-join precedent, T-6.7 R1 residual):
 * under contention an async settle (mutation / prefs resolution / search
 * refetch) can land during waitFor/findBy's between-poll sleep — which is
 * NOT act-wrapped — and warn. Two hops: settle batch + follow-on.
 */
async function pressSettled(testID: string) {
  await fireEvent.press(screen.getByTestId(testID));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fireBeforeRemove(): BeforeRemoveEvent {
  const event: BeforeRemoveEvent = {
    preventDefault: jest.fn(),
    data: { action: { type: "POP" } },
  };
  for (const cb of [...mockBeforeRemoveListeners]) cb(event);
  return event;
}

const postCalls = (request: jest.Mock) =>
  request.mock.calls.filter(([d]) => (d as { method: string; path: string }).method === "POST");

/** The last render's client — the afterEach drain loop reads its isFetching. */
let lastClient: QueryClient | null = null;

async function renderScreen() {
  const client = makeTestQueryClient();
  lastClient = client;
  const result = await renderWithProviders(<TripNewScreen />, { queryClient: client });
  // Settle the mount's me-query INSIDE act before the test interacts — its
  // notify batch otherwise lands in a between-act gap under --maxWorkers=2
  // contention (B-2 family). Two hops: batch + follow-on batch.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return result;
}

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  mockRouter.replace.mockClear();
  mockNavigation.dispatch.mockClear();
  mockBeforeRemoveListeners.length = 0;
});

afterEach(async () => {
  // Bounded drain-until-idle inside act (profile-screen recipe, B-2 family):
  // exit only after two consecutive idle hops (the hop that settles the
  // last fetch leaves its notify batch queued), bounded at 6.
  let hops = 0;
  let idleHops = 0;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    hops += 1;
    idleHops = (lastClient?.isFetching() ?? 0) > 0 ? 0 : idleHops + 1;
  } while (idleHops < 2 && hops < 6);
  // Loud exit (R1; scope corrected R2): fails on bound-exhaustion with a
  // fetch still running at drain time — unmount-cancelled held fetches
  // read idle here, so this is not a universal straggler catch.
  expect(lastClient?.isFetching() ?? 0).toBe(0);
  lastClient = null;
  jest.restoreAllMocks();
});

describe("validation (R-tripui-6, TripCreateSchema client-mirrored)", () => {
  it("submitting an empty form surfaces every required-field error and never POSTs", async () => {
    const request = mockApi();
    await renderScreen();

    // The §2.7 container id wraps the whole range control (R1 advisory pin).
    expect(screen.getByTestId("trip-new-input-dates")).toBeOnTheScreen();

    await pressSettled("trip-new-button-create");

    expect(screen.getByTestId("trip-new-input-name-error")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-new-input-destination-error")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-new-input-dates-start-error")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-new-input-dates-end-error")).toBeOnTheScreen();
    expect(postCalls(request)).toHaveLength(0);
  });

  it("mirrors the shared date-order rule: end before start is a field error, not a request", async () => {
    // Bad-FORMAT dates are unreachable through the picker control (it emits
    // ISO by construction) — the schema's format arm stays as defense but
    // only the order rule has a UI path.
    const request = mockApi();
    await renderScreen();
    await fillValidForm();

    await pickDate("trip-new-input-dates-start", 2027, 5, 9); // after the 05-08 end
    await pressSettled("trip-new-button-create");
    expect(
      await screen.findByText("End date must be on or after the start date."),
    ).toBeOnTheScreen();
    expect(postCalls(request)).toHaveLength(0);
  });

  it("boundary pins: 200-char name accepted, 201 rejected; equal start/end accepted", async () => {
    const request = mockApi();
    await renderScreen();
    await fillValidForm();
    // Equal start/end is a valid single-day range (shared rule is `>` only).
    await pickDate("trip-new-input-dates-end", 2027, 5, 1);

    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "n".repeat(201));
    await pressSettled("trip-new-button-create");
    expect(screen.getByText("Trip names run 1–200 characters.")).toBeOnTheScreen();
    expect(postCalls(request)).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "n".repeat(200));
    await pressSettled("trip-new-button-create");
    await waitFor(() => expect(postCalls(request)).toHaveLength(1));
    const body = (postCalls(request)[0][1] as { body: Record<string, unknown> }).body;
    expect(body.name).toBe("n".repeat(200));
    expect(body.start_date).toBe("2027-05-01");
    expect(body.end_date).toBe("2027-05-01");
  });

  it("§2.3 no-free-text: editing the text after a pick voids it — submit errors, ZERO POSTs", async () => {
    const request = mockApi();
    await renderScreen();
    await fillValidForm();

    // Edit AFTER the pick: the stale lat/lng must never ride under new text.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto!");
    await pressSettled("trip-new-button-create");

    expect(screen.getByTestId("trip-new-input-destination-error")).toBeOnTheScreen();
    expect(postCalls(request)).toHaveLength(0);
  });
});

describe("destination structured search (§2.3 — Overture spine, no free text)", () => {
  it("stays quiet under the 4-char text-only floor, then searches and fills from a picked result", async () => {
    const request = mockApi();
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyo");
    expect(screen.getByText("Keep typing — search starts at 4 characters.")).toBeOnTheScreen();
    expect(
      request.mock.calls.filter(([d]) => (d as { path: string }).path === "/places/search"),
    ).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
    await fireEvent.press(await screen.findByTestId(`trip-new-list-item-${KYOTO.id}`));

    expect(request).toHaveBeenCalledWith(
      placeEndpoints.searchPlaces,
      { query: { q: "Kyoto" } },
      { signal: expect.any(AbortSignal) },
    );
    // The pick is structural: input shows the canonical name, results close.
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Kyoto");
    expect(screen.queryByTestId(`trip-new-list-item-${KYOTO.id}`)).toBeNull();
  });

  it("renders the search error surface with retry (async path, R-ds-17)", async () => {
    let fail = true;
    mockApi({
      "GET /places/search": () =>
        fail
          ? Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom"))
          : Promise.resolve({ items: [KYOTO], nextCursor: null }),
    });
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
    expect(await screen.findByTestId("trip-new-error-search")).toBeOnTheScreen();

    fail = false;
    await pressSettled("trip-new-error-search-retry");
    expect(await screen.findByTestId(`trip-new-list-item-${KYOTO.id}`)).toBeOnTheScreen();
  });
});

describe("submit (R-tripui-7)", () => {
  it("POSTs the schema-shaped body with prefs.home_currency and replace-navigates into the trip", async () => {
    const request = mockApi({}, { me: { ...TEST_USER, prefs: { home_currency: "EUR" } } });
    await renderScreen();
    await fillValidForm();

    await pressSettled("trip-new-button-create");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, {
        body: { ...FILLED_BODY, base_currency: "EUR" },
      }),
    );
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  });

  it("R1: a submit RACING the /me read waits for it — base_currency is never silently dropped", async () => {
    // /me is held open across the submit press; the deterministic-prefs
    // contract says no POST may fire until it settles, and the settled
    // home_currency must ride the body (base_currency locks at the first
    // expense — a silent USD default has teeth).
    let resolveMe!: (value: unknown) => void;
    const request = mockApi({
      "GET /users/me": () =>
        new Promise((resolve) => {
          resolveMe = resolve;
        }),
    });
    await renderScreen();
    await fillValidForm();

    await pressSettled("trip-new-button-create");
    // Still resolving prefs: the submit is held (spinner up), nothing POSTed.
    expect(postCalls(request)).toHaveLength(0);
    expect(await screen.findByTestId("trip-new-button-create-spinner")).toBeOnTheScreen();
    // …and a second press during the prefs window is a no-op.
    await pressSettled("trip-new-button-create");

    await act(async () => {
      resolveMe({ ...TEST_USER, prefs: { home_currency: "JPY" } });
      // Two hops INSIDE one act window: the me-settle's notify batch, then
      // the submit continuation's (resolvingPrefs flip → mutate pending)
      // follow-on batch — otherwise the second lands between act windows
      // under --maxWorkers=2 contention (B-2 family).
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, {
        body: { ...FILLED_BODY, base_currency: "JPY" },
      }),
    );
    expect(postCalls(request)).toHaveLength(1);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  });

  it("omits base_currency when prefs carry no home_currency (server defaults USD, R-tripui-6)", async () => {
    const request = mockApi(); // TEST_USER.prefs = {}
    await renderScreen();
    await fillValidForm();

    await pressSettled("trip-new-button-create");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, { body: FILLED_BODY }),
    );
  });

  it("disables the submit control while pending — a double press fires ONE request", async () => {
    // Controllable deferred, NOT a never-settling promise: a mutation still
    // pending at suite end held the jest worker open (observed live, T-6.7)
    // — the window stays deterministic and then settles inside the test.
    let resolvePost!: (value: unknown) => void;
    const request = mockApi({
      "POST /trips": () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    });
    await renderScreen();
    await fillValidForm();

    await pressSettled("trip-new-button-create");
    expect(await screen.findByTestId("trip-new-button-create-spinner")).toBeOnTheScreen();
    await pressSettled("trip-new-button-create");

    expect(postCalls(request)).toHaveLength(1);

    await act(async () => {
      resolvePost(makePlanningTrip(TEST_TRIP_ID));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  });

  it("failure renders the ErrorBanner, preserves every entered value, and retry resubmits", async () => {
    let fail = true;
    const request = mockApi({
      "POST /trips": () =>
        fail
          ? Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom"))
          : Promise.resolve(makePlanningTrip(TEST_TRIP_ID)),
    });
    await renderScreen();
    await fillValidForm();

    await pressSettled("trip-new-button-create");
    expect(await screen.findByTestId("trip-new-error")).toBeOnTheScreen();

    // R-tripui-7: all entered values preserved on failure (dates render
    // their picked values on the picker field rows).
    expect(screen.getByTestId("trip-new-input-name").props.value).toBe("Kyoto Spring");
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Kyoto");
    expect(screen.getByText("May 1, 2027")).toBeOnTheScreen();
    expect(screen.getByText("May 8, 2027")).toBeOnTheScreen();

    fail = false;
    await pressSettled("trip-new-error-retry");
    await waitFor(() => expect(postCalls(request)).toHaveLength(2));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  });
});

describe("dirty dismissal (R-tripui-8, nav §2.6 form-modal rule)", () => {
  it("a CLEAN form dismisses freely — beforeRemove is not prevented", async () => {
    mockApi();
    await renderScreen();

    await fireEvent.press(screen.getByTestId("trip-new-button-cancel"));
    expect(mockRouter.back).toHaveBeenCalled();

    const event = fireBeforeRemove();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByTestId("trip-new-button-cancel-confirm")).toBeNull();
  });

  it("a DIRTY removal is intercepted with the discard Confirm; confirm dispatches the stashed action", async () => {
    mockApi();
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "K");

    // Any removal — swipe-down, back, the cancel button's router.back() —
    // funnels through beforeRemove.
    let event!: BeforeRemoveEvent;
    await waitFor(() => {
      event = fireBeforeRemove();
      expect(event.preventDefault).toHaveBeenCalled();
    });

    await fireEvent.press(await screen.findByTestId("trip-new-button-cancel-confirm"));
    expect(mockNavigation.dispatch).toHaveBeenCalledWith(event.data.action);
  });

  it("R2 pin: a COLD modal-only stack (no list beneath) cancels via replace('/(trips)'), not an unhandled back", async () => {
    mockApi();
    mockRouter.canGoBack.mockReturnValueOnce(false); // gogo://new cold entry
    await renderScreen();

    await fireEvent.press(screen.getByTestId("trip-new-button-cancel"));

    expect(mockRouter.replace).toHaveBeenCalledWith("/(trips)");
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it("keep-editing cancels the dialog and stays put", async () => {
    mockApi();
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "K");

    await waitFor(() => {
      const event = fireBeforeRemove();
      expect(event.preventDefault).toHaveBeenCalled();
    });
    await fireEvent.press(await screen.findByTestId("trip-new-button-cancel-cancel"));

    await waitFor(() => expect(screen.queryByTestId("trip-new-button-cancel-confirm")).toBeNull());
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("trip-new-input-name").props.value).toBe("K");
  });
});

/**
 * PR #40 R1 (tests lane): the trip-new sibling seed chains (`contextDate=
 * {startDate}` / `{endDate}` in new.tsx) were unpinned — severing them left
 * the suite green while an empty range side reverted to opening on today
 * (the exact B-10 complaint). Seeds asserted through the picker wrapper's
 * public `date` ms translation; the picked 2027 dates are not today, so
 * each pin goes red when its seed prop is dropped.
 */
describe("range sibling picker seeds (B-10 seed-chain pins)", () => {
  it("the empty END side opens on the entered start date, not today", async () => {
    await renderScreen();
    // Control arm: nothing entered yet — the end picker opens on today.
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-end"));
    const unseeded = new Date(
      screen.getByTestId("trip-new-input-dates-end-picker").props.date as number,
    );
    expect(unseeded.toDateString()).toBe(new Date().toDateString());
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-end-sheet-close"));

    await pickDate("trip-new-input-dates-start", 2027, 5, 1);
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-end"));
    expect(screen.getByTestId("trip-new-input-dates-end-picker").props.date).toBe(
      new Date(2027, 4, 1, 12).getTime(),
    );
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-end-sheet-close"));
  });

  it("the empty START side opens on the entered end date (the mirror chain)", async () => {
    await renderScreen();
    await pickDate("trip-new-input-dates-end", 2027, 5, 8);
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-start"));
    expect(screen.getByTestId("trip-new-input-dates-start-picker").props.date).toBe(
      new Date(2027, 4, 8, 12).getTime(),
    );
    await fireEvent.press(screen.getByTestId("trip-new-input-dates-start-sheet-close"));
  });
});
