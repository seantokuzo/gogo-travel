/**
 * Trip-list screen (T-6.7 / CT-1; trips spec §2.1) + the theme-boot probes
 * this landing surface has carried since T-4.2 (R-ds-4 first-frame
 * evidence). Covers R-tripui-1 (sections group/sort), R-tripui-2 (row
 * content + tap), R-tripui-3 (focus refetch), R-tripui-5 (empty state with
 * both CTAs), the §2.1 error/loading states, real cursor pagination, and
 * the R-nav-17 link notice.
 *
 * Screen-level render without a router host — the hook surface the screen +
 * PageHeader consume is stubbed; route-tree behavior lives in the
 * renderRouter suites (trip-create-flow, navigation-skeleton).
 */
import { DEFAULT_THEME, getTheme } from "@gogo/tokens";
import { STORAGE_KEYS, ThemeProvider, useTheme } from "@gogo/tokens/react";
import type { ThemeStorage } from "@gogo/tokens/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { useEffect } from "react";

import TripListScreen from "@/app/(trips)/index";
import { ApiRequestError } from "@/auth";
import { useLinkNoticeStore } from "@/navigation/link-notice";
import { systemAppearance, themeStorage } from "@/theme";
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
/** Latest focus effect the screen registered — re-invoke to simulate refocus. */
const mockFocusHolder: { current: (() => undefined | void | (() => void)) | null } = {
  current: null,
};

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  // Mirrors the real hook's mount-focus semantics: the effect runs when the
  // (always-focused) test screen mounts; suites re-invoke the captured
  // effect to simulate a REFOCUS.
  useFocusEffect: (effect: () => undefined | void | (() => void)) => {
    mockFocusHolder.current = effect;
    const { useEffect: reactUseEffect } = jest.requireActual<typeof import("react")>("react");
    reactUseEffect(() => effect(), [effect]);
  },
}));

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// The ThemeStorage seam is getString/set only; the underlying MMKV instance
// (mmkv's sanctioned in-memory mock under jest) also exposes remove — reach
// through for test isolation only, never in product code.
const mmkvStorage = themeStorage as ThemeStorage & { remove(key: string): void };

/** The last render's client — the afterEach drain loop reads its isFetching. */
let lastClient: QueryClient | null = null;

async function renderScreen(opts?: { theme?: "persisted"; probe?: ("light" | "dark")[] }) {
  const client = makeTestQueryClient();
  lastClient = client;
  const themed =
    opts?.theme === "persisted" ? (
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        {opts.probe ? <SchemeProbe seen={opts.probe} /> : null}
        <TripListScreen />
      </ThemeProvider>
    ) : (
      <ThemeProvider>
        <TripListScreen />
      </ThemeProvider>
    );
  const result = await render(
    <QueryClientProvider client={client}>{themed}</QueryClientProvider>,
  );
  return { client, ...result };
}

/**
 * Records the resolved scheme on every COMMIT. seen[0] is the first committed
 * frame — what R-ds-4 actually promises (a storage read demoted to an effect
 * would commit light first and only a first-frame probe catches it).
 */
function SchemeProbe({ seen }: { seen: ("light" | "dark")[] }) {
  const { scheme } = useTheme();
  useEffect(() => {
    seen.push(scheme);
  });
  return null;
}

beforeEach(() => {
  mmkvStorage.remove(STORAGE_KEYS.appearance);
  mmkvStorage.remove(STORAGE_KEYS.accentTheme);
  useLinkNoticeStore.setState({ message: null });
  mockRouter.push.mockClear();
  mockFocusHolder.current = null;
});

afterEach(async () => {
  // Drain queued notifyManager macrotasks INSIDE act before teardown
  // (profile-screen's bounded loop-until-idle — the B-2 flake family): exit
  // only after two consecutive idle hops (the hop that settles the last
  // fetch leaves its notify batch queued), bounded at 6.
  let hops = 0;
  let idleHops = 0;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    hops += 1;
    idleHops = (lastClient?.isFetching() ?? 0) > 0 ? 0 : idleHops + 1;
  } while (idleHops < 2 && hops < 6);
  // Loud exit (R1): hitting the hop bound while still fetching must FAIL
  // the suite, not silently hand a wedged query to the next test. Tests
  // that intentionally hold a fetch open unmount before ending (the
  // consumed signal cancels the fetch).
  expect(lastClient?.isFetching() ?? 0).toBe(0);
  lastClient = null;
  jest.restoreAllMocks();
});

describe("theme boot (landing surface, R-ds-4)", () => {
  it("renders with the default goldenHour light theme tokens", async () => {
    mockNavApi();
    await renderScreen();

    expect(DEFAULT_THEME).toBe("goldenHour");
    const theme = getTheme(DEFAULT_THEME, "light");
    expect(screen.getByTestId("trip-list-screen")).toHaveStyle({
      backgroundColor: theme.color.bg.screen,
    });
    expect(within(screen.getByTestId("trip-list-header")).getByText("Trips")).toHaveStyle({
      color: theme.color.text.primary,
      fontSize: theme.type.title.fontSize,
    });
    // Consume the trips settle INSIDE the test — ending on the sync header
    // asserts leaves the notify batch on a timer that fires between test and
    // afterEach, outside act (B-2 family).
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);
  });

  it("boots dark from a persisted preference through the real adapters", async () => {
    themeStorage.set(STORAGE_KEYS.appearance, "dark");
    mockNavApi();
    await renderScreen({ theme: "persisted" });

    const dark = getTheme(DEFAULT_THEME, "dark");
    const light = getTheme(DEFAULT_THEME, "light");
    expect(dark.color.bg.screen).not.toBe(light.color.bg.screen);
    expect(screen.getByTestId("trip-list-screen")).toHaveStyle({
      backgroundColor: dark.color.bg.screen,
    });
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`); // settle (B-2)
  });

  it("commits dark on the FIRST frame from a persisted preference (R-ds-4 no-flash)", async () => {
    themeStorage.set(STORAGE_KEYS.appearance, "dark");
    mockNavApi();
    const seen: ("light" | "dark")[] = [];
    await renderScreen({ theme: "persisted", probe: seen });
    expect(seen[0]).toBe("dark");
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`); // settle (B-2)
  });
});

describe("trip list states (CT-1)", () => {
  it("holds on skeleton rows while the first page is in flight (§2.1 loading)", async () => {
    mockNavApi({ overrides: { "GET /trips": () => new Promise(() => undefined) } });
    const { unmount } = await renderScreen();
    expect(screen.getByTestId("trip-list-loading")).toBeOnTheScreen();
    expect(screen.queryByTestId("trip-list-empty")).toBeNull();
    // Cancel the held fetch (signal-consuming queryFn) so the drain loop's
    // loud idle assert stays meaningful.
    await unmount();
  });

  it("R-tripui-1/2: groups into labeled sections in active → planning → past order and renders row content", async () => {
    const active = makeActiveTrip(TEST_TRIP_ID); // Lisbon, 4-day window
    const planning = makePlanningTrip(TRIP_B_ID, { member_count: 3 }); // Kyoto
    const past = makePastTrip(TRIP_C_ID); // Oaxaca
    mockNavApi({ trips: [past, planning, active] });
    await renderScreen();

    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);
    // All three §2.1 labels render…
    for (const label of ["Happening now", "Upcoming", "Past"]) {
      expect(screen.getByText(label)).toBeOnTheScreen();
    }
    // …and the rows come out in section order (active → planning → past),
    // regardless of the shuffled server page above.
    const rowIds = screen
      .getAllByTestId(/^trip-list-list-item-/)
      .map((node) => node.props.testID as string);
    expect(rowIds).toEqual([
      `trip-list-list-item-${TEST_TRIP_ID}`,
      `trip-list-list-item-${TRIP_B_ID}`,
      `trip-list-list-item-${TRIP_C_ID}`,
    ]);

    // Row content (R-tripui-2): name, destination, member count.
    const row = within(screen.getByTestId(`trip-list-list-item-${TRIP_B_ID}`));
    expect(row.getByText("Kyoto")).toBeOnTheScreen();
    expect(row.getByText("Kyoto, Japan")).toBeOnTheScreen();
    expect(row.getByText("3 members")).toBeOnTheScreen();
  });

  it("R-tripui-2: tapping a row navigates to /[tripId] (default-tab rules are the layout's)", async () => {
    mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID)] });
    await renderScreen();
    await fireEvent.press(await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`);
  });

  it("R-tripui-5: zero trips renders the EmptyState with BOTH create and join entries", async () => {
    mockNavApi({ trips: [] });
    await renderScreen();

    expect(await screen.findByTestId("trip-list-empty")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-list-button-create")).toBeOnTheScreen();
    expect(screen.getByTestId("trip-list-button-join")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("trip-list-button-create"));
    expect(mockRouter.push).toHaveBeenCalledWith("/(trips)/new");

    // Join is guidance in v1 — invite links are the only join path (§2.1).
    await fireEvent.press(screen.getByTestId("trip-list-button-join"));
    expect(await screen.findByTestId("trip-list-sheet-join")).toBeOnTheScreen();
    // Close it so the sheet's animation work doesn't outlive the test.
    await fireEvent.press(screen.getByTestId("trip-list-sheet-join-close"));
    await waitFor(() => expect(screen.queryByTestId("trip-list-sheet-join")).toBeNull());
  });

  it("R1: a failed background REFRESH keeps the loaded rows — inline banner, never the full-screen error", async () => {
    // v5 flips status to "error" with data RETAINED when a focus-invalidate
    // refetch fails; the loaded list must survive it (guard posture parity:
    // a failed refetch is not a verdict).
    let fail = false;
    mockNavApi({
      overrides: {
        "GET /trips": () =>
          fail
            ? Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom"))
            : Promise.resolve({ items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: null }),
      },
    });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);

    fail = true;
    await act(async () => {
      mockFocusHolder.current?.(); // refocus → invalidate → failing refetch
    });

    expect(await screen.findByTestId("trip-list-banner-refresh")).toBeOnTheScreen();
    expect(screen.getByTestId(`trip-list-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId("trip-list-error")).toBeNull();

    // Banner retry recovers in place.
    fail = false;
    await fireEvent.press(screen.getByTestId("trip-list-banner-refresh-retry"));
    await waitFor(() => expect(screen.queryByTestId("trip-list-banner-refresh")).toBeNull());
    expect(screen.getByTestId(`trip-list-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
  });

  it("§2.1 error state: banner + the spec-exact trip-list-retry control, retry refetches into rows", async () => {
    let fail = true;
    mockNavApi({
      overrides: {
        "GET /trips": () =>
          fail
            ? Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom"))
            : Promise.resolve({ items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: null }),
      },
    });
    await renderScreen();

    expect(await screen.findByTestId("trip-list-error")).toBeOnTheScreen();
    fail = false;
    await fireEvent.press(screen.getByTestId("trip-list-retry"));
    expect(await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
  });

  it("the FAB opens the create modal", async () => {
    mockNavApi({ trips: [] });
    await renderScreen();
    await screen.findByTestId("trip-list-empty");
    await fireEvent.press(screen.getByTestId("trip-list-fab-create"));
    expect(mockRouter.push).toHaveBeenCalledWith("/(trips)/new");
  });

  it("retires the T-6.6 dev sample-trip door; the gallery entry stays (dev-only)", async () => {
    mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID)] });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);
    expect(screen.queryByTestId("trip-list-button-sample-trip")).toBeNull();
    expect(screen.getByTestId("trip-list-button-gallery")).toBeOnTheScreen();
  });
});

describe("pagination (CT-1 — real keyset paging)", () => {
  it("end-reached fetches the next cursor page and appends its rows", async () => {
    const page1 = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: "cur-1" };
    const page2 = {
      items: [makePlanningTrip(TRIP_B_ID, { name: "Second Page Trip" })],
      nextCursor: null,
    };
    const request = mockNavApi({
      overrides: {
        "GET /trips": (input) =>
          Promise.resolve(
            (input as { query?: { cursor?: string } }).query?.cursor === "cur-1" ? page2 : page1,
          ),
      },
    });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);

    await fireEvent(screen.getByTestId("trip-list-list"), "onEndReached");

    expect(await screen.findByTestId(`trip-list-list-item-${TRIP_B_ID}`)).toBeOnTheScreen();
    const listCalls = request.mock.calls.filter(
      ([descriptor]) => (descriptor as { path: string }).path === "/trips",
    );
    expect(listCalls.map(([, input]) => (input as { query: object }).query)).toEqual([
      {},
      { cursor: "cur-1" },
    ]);

    // R1: EXHAUSTED cursor (page 2 returned null) — further end-reached
    // events fire no request.
    await fireEvent(screen.getByTestId("trip-list-list"), "onEndReached");
    await fireEvent(screen.getByTestId("trip-list-list"), "onEndReached");
    expect(
      request.mock.calls.filter(([d]) => (d as { path: string }).path === "/trips"),
    ).toHaveLength(2);
  });

  it("R1: a failed page fetch keeps loaded rows and shows the footer surface; its retry appends", async () => {
    const page1 = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: "cur-1" };
    const page2 = {
      items: [makePlanningTrip(TRIP_B_ID, { name: "Second Page Trip" })],
      nextCursor: null,
    };
    let failPage2 = true;
    mockNavApi({
      overrides: {
        "GET /trips": (input) => {
          const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
          if (cursor === undefined) return Promise.resolve(page1);
          return failPage2
            ? Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom"))
            : Promise.resolve(page2);
        },
      },
    });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);

    await fireEvent(screen.getByTestId("trip-list-list"), "onEndReached");

    // Rows retained, footer surface up, no full-screen error, no top banner.
    expect(await screen.findByTestId("trip-list-banner-page")).toBeOnTheScreen();
    expect(screen.getByTestId(`trip-list-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId("trip-list-error")).toBeNull();
    expect(screen.queryByTestId("trip-list-banner-refresh")).toBeNull();

    failPage2 = false;
    await fireEvent.press(screen.getByTestId("trip-list-banner-page-retry"));
    expect(await screen.findByTestId(`trip-list-list-item-${TRIP_B_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId("trip-list-banner-page")).toBeNull();
  });

  it("R1: a row overlapping across pages renders ONCE (id-dedupe — the append/refetch race the code flags)", async () => {
    // Page 2 re-serves the page-1 trip (keyset drift under a concurrent
    // refetch) plus a genuinely new row.
    const dupe = makePlanningTrip(TEST_TRIP_ID);
    const page1 = { items: [dupe], nextCursor: "cur-1" };
    const page2 = { items: [dupe, makePlanningTrip(TRIP_B_ID)], nextCursor: null };
    mockNavApi({
      overrides: {
        "GET /trips": (input) =>
          Promise.resolve(
            (input as { query?: { cursor?: string } }).query?.cursor === "cur-1" ? page2 : page1,
          ),
      },
    });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);
    await fireEvent(screen.getByTestId("trip-list-list"), "onEndReached");

    await screen.findByTestId(`trip-list-list-item-${TRIP_B_ID}`);
    expect(screen.getAllByTestId(`trip-list-list-item-${TEST_TRIP_ID}`)).toHaveLength(1);
  });
});

describe("refetch-on-focus (R-tripui-3 / §2.6)", () => {
  it("skips the mount focus (one initial request), then a REFOCUS marks stale and refetches", async () => {
    const request = mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID)] });
    await renderScreen();
    await screen.findByTestId(`trip-list-list-item-${TEST_TRIP_ID}`);

    const listCalls = () =>
      request.mock.calls.filter(([d]) => (d as { path: string }).path === "/trips").length;
    // First focus consumed by the mount — the mount's own fetch is the only one.
    expect(listCalls()).toBe(1);

    await act(async () => {
      mockFocusHolder.current?.();
    });
    await waitFor(() => expect(listCalls()).toBe(2));
    // Consume the refetch settle inside the test (B-2): the count assert
    // passes at request time — flush the queued notify before ending.
    await waitFor(() => expect(lastClient?.isFetching() ?? 0).toBe(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe("link notice (R-nav-17)", () => {
  it("shows the link notice as a dismissible warning banner", async () => {
    useLinkNoticeStore.getState().show();
    mockNavApi({ trips: [] });
    await renderScreen();
    expect(screen.getByTestId("trip-list-link-notice")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("trip-list-link-notice-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("trip-list-link-notice")).toBeNull());
    expect(useLinkNoticeStore.getState().message).toBeNull();
  });

  it("renders no banner when no link notice is pending", async () => {
    useLinkNoticeStore.setState({ message: null });
    mockNavApi({ trips: [] });
    await renderScreen();
    await screen.findByTestId("trip-list-empty");
    expect(screen.queryByTestId("trip-list-link-notice")).toBeNull();
  });
});
