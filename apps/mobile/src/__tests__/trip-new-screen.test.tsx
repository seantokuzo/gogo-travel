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

describe("custom-destination fallback (B-7, R-tripui-23 — Sean ruling 2026-09-13)", () => {
  const CUSTOM_PLACE = makePlace({
    id: "77777777-7777-4777-8777-777777777777",
    source: "custom",
    source_id: null,
    name: "Nowhereville",
    // The placeholder coordinates the create mutation actually sends
    // (`useCreateCustomDestination` doc) — a realistic mock echoes them
    // back, not the fixture's default Kyoto lat/lng.
    lat: 0,
    lng: 0,
    category: null,
    coarse_category: "other",
    wiki_ref: null,
    created_by: TEST_USER.id,
  });

  it("is absent while the search request is still loading", async () => {
    let resolveSearch!: (value: unknown) => void;
    mockApi({
      "GET /places/search": () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    });
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    expect(screen.queryByTestId("trip-new-list-item-custom")).toBeNull();

    await act(async () => {
      resolveSearch({ items: [], nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByTestId("trip-new-list-item-custom")).toBeOnTheScreen();
  });

  it("is absent while real results render, and disappears again once the query is cleared", async () => {
    mockApi();
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
    await screen.findByTestId(`trip-new-list-item-${KYOTO.id}`);
    expect(screen.queryByTestId("trip-new-list-item-custom")).toBeNull();

    // Blank/whitespace query: the whole results region (including the
    // fallback row) closes — `searchActive` drops below the 4-char floor.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "   ");
    await waitFor(() => expect(screen.queryByTestId("trip-new-list-item-custom")).toBeNull());
  });

  it("appears once search settles empty, and one tap creates + selects the trimmed text (save unblocks)", async () => {
    const request = mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () => Promise.resolve(CUSTOM_PLACE),
    });
    await renderScreen();

    await fireEvent.changeText(
      screen.getByTestId("trip-new-input-destination"),
      "  Nowhereville  ",
    );
    const row = await screen.findByTestId("trip-new-list-item-custom");
    expect(row).toHaveTextContent('Use "Nowhereville" as a custom destination');

    await pressSettled("trip-new-list-item-custom");

    const createCalls = request.mock.calls.filter(
      ([d]) => (d as { path: string }).path === "/places",
    );
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0][1] as { body: unknown }).body).toEqual({
      name: "Nowhereville",
      lat: 0,
      lng: 0,
    });

    // Selected exactly like an existing-result pick: canonical name fills
    // the input, the results region (row included) closes.
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Nowhereville");
    expect(screen.queryByTestId("trip-new-list-item-custom")).toBeNull();

    // Save gate: the rest of the form + submit now succeeds with the
    // custom place's placeholder coordinates riding the trip body.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "Somewhere Trip");
    await pickDate("trip-new-input-dates-start", 2027, 5, 1);
    await pickDate("trip-new-input-dates-end", 2027, 5, 8);
    await pressSettled("trip-new-button-create");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, {
        body: {
          name: "Somewhere Trip",
          destination_name: "Nowhereville",
          destination_lat: 0,
          destination_lng: 0,
          start_date: "2027-05-01",
          end_date: "2027-05-08",
        },
      }),
    );
  });

  it("a genuinely held create shows the busy row (no double-submit — one tap has nothing left to press)", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    let posts = 0;
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () => {
        posts += 1;
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    const row = await screen.findByTestId("trip-new-list-item-custom");

    try {
      await fireEvent.press(row);
      expect(await screen.findByTestId("trip-new-list-item-custom-spinner")).toBeOnTheScreen();
      expect(posts).toBe(1);

      // The busy row replaces the pressable one (structural, not a
      // `disabled` prop) — a second physical tap has no onPress to invoke.
      const busyRow = screen.getByTestId("trip-new-list-item-custom");
      await fireEvent.press(busyRow);
      expect(posts).toBe(1);
    } finally {
      // Release + its follow-on notify batch INSIDE one act window (T-7.9
      // rule) — releasing bare and letting a later findBy/waitFor poll catch
      // the settle is the B-2 floating-act class (mobile.md).
      await act(async () => {
        for (const release of resolvers) release(CUSTOM_PLACE);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    await waitFor(() =>
      expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Nowhereville"),
    );
    expect(posts).toBe(1);
  });

  it("a 409 surfaces inline, keeps the typed text, and retry re-creates", async () => {
    let fail = true;
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () =>
        fail
          ? Promise.reject(new ApiRequestError(409, "CONFLICT", "boom"))
          : Promise.resolve(CUSTOM_PLACE),
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");

    expect(await screen.findByTestId("trip-new-error-create-destination")).toBeOnTheScreen();
    expect(
      screen.getByText("That change conflicted with another update — try again."),
    ).toBeOnTheScreen();
    // Preserved, not cleared — a retry needs the same typed text.
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Nowhereville");
    expect(screen.queryByTestId("trip-new-list-item-custom")).toBeNull();

    fail = false;
    await pressSettled("trip-new-error-create-destination-retry");
    await waitFor(() =>
      expect(screen.queryByTestId("trip-new-error-create-destination")).toBeNull(),
    );
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Nowhereville");
  });

  it("a transport failure (status 0, offline) surfaces the offline message and keeps the typed text", async () => {
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () => Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");

    expect(await screen.findByTestId("trip-new-error-create-destination")).toBeOnTheScreen();
    expect(screen.getByText("No connection — check your network and retry.")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Nowhereville");
  });

  it("a 400 surfaces the validation message (4xx branch distinct from 409/0)", async () => {
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () => Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", "bad")),
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");

    expect(await screen.findByTestId("trip-new-error-create-destination")).toBeOnTheScreen();
    expect(
      screen.getByText("That destination name isn't valid — try editing it."),
    ).toBeOnTheScreen();
  });

  it("R1 B1 (blocking): a slow create must not clobber a destination picked while it was in flight", async () => {
    let resolveCreate!: (value: unknown) => void;
    const request = mockApi({
      "GET /places/search": (input) => {
        const q = (input as { query?: { q?: string } }).query?.q;
        return Promise.resolve(
          q === "Kyoto" ? { items: [KYOTO], nextCursor: null } : { items: [], nextCursor: null },
        );
      },
      "POST /places": () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    });
    await renderScreen();

    // Fire the custom create for "Nowhereville" and hold it open.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Nowhereville");
    const row = await screen.findByTestId("trip-new-list-item-custom");
    await fireEvent.press(row);
    await screen.findByTestId("trip-new-list-item-custom-spinner");

    // The user changes their mind WHILE the create is still in flight and
    // picks a real spine result instead.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
    await fireEvent.press(await screen.findByTestId(`trip-new-list-item-${KYOTO.id}`));
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Kyoto");

    // NOW the superseded create resolves — it must be a no-op.
    await act(async () => {
      resolveCreate(CUSTOM_PLACE);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe("Kyoto");
    const createDestinationCalls = request.mock.calls.filter(
      ([d]) => (d as { path: string }).path === "/places",
    );
    expect(createDestinationCalls).toHaveLength(1); // the POST genuinely fired — this IS the race

    await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "Kyoto Spring");
    await pickDate("trip-new-input-dates-start", 2027, 5, 1);
    await pickDate("trip-new-input-dates-end", 2027, 5, 8);
    await pressSettled("trip-new-button-create");

    // The trip must POST Kyoto — never the abandoned custom Null Island row.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, { body: FILLED_BODY }),
    );
  });

  it("R1 A2 (advisory): a failed create does not permanently hide the row for a later query", async () => {
    let shouldFail = true;
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": () =>
        shouldFail
          ? Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", "bad"))
          : Promise.resolve(CUSTOM_PLACE),
    });
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Bad Name");
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");
    expect(await screen.findByTestId("trip-new-error-create-destination")).toBeOnTheScreen();

    // The user abandons that text for a new query — this is a FRESH
    // zero-result state, not a retry of the old failure, so the OLD error
    // (and its stale retry target) must not survive the query change.
    shouldFail = false;
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Grandma Cabin");
    await waitFor(() =>
      expect(screen.queryByTestId("trip-new-error-create-destination")).toBeNull(),
    );
    expect(await screen.findByTestId("trip-new-list-item-custom")).toHaveTextContent(
      'Use "Grandma Cabin" as a custom destination',
    );
  });

  it("R1 A2/A4 boundary: the destination input caps at 200 chars, mirroring the name field + PlaceNameSchema", async () => {
    mockApi();
    await renderScreen();
    expect(screen.getByTestId("trip-new-input-destination").props.maxLength).toBe(200);
  });

  it("R1 A4 boundary: a 200-char custom destination creates cleanly; 201 chars hits the server's validation branch", async () => {
    const name200 = "n".repeat(200);
    const name201 = "n".repeat(201);
    const receivedNames: string[] = [];
    mockApi({
      "GET /places/search": () => Promise.resolve({ items: [], nextCursor: null }),
      "POST /places": (input) => {
        const body = (input as { body?: { name?: string } }).body;
        const sentName = body?.name ?? "";
        receivedNames.push(sentName);
        if (sentName.length > 200) {
          return Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", "too long"));
        }
        return Promise.resolve({ ...CUSTOM_PLACE, name: sentName });
      },
    });
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), name200);
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");
    expect(screen.getByTestId("trip-new-input-destination").props.value).toBe(name200);
    expect(screen.queryByTestId("trip-new-error-create-destination")).toBeNull();

    // 201 chars exceeds the visual cap but is still reachable through
    // `fireEvent.changeText` (it calls the handler directly, bypassing
    // native `maxLength` enforcement) — a real device blocks this at the
    // keyboard; this pin covers the server-validation branch defensively.
    await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), name201);
    await screen.findByTestId("trip-new-list-item-custom");
    await pressSettled("trip-new-list-item-custom");
    expect(await screen.findByTestId("trip-new-error-create-destination")).toBeOnTheScreen();
    expect(receivedNames).toEqual([name200, name201]);
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
